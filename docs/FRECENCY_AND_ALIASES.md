# Frecency and aliases: proposed shape

Status: **implemented.** Two features the maintainer asked for after paste-at-cursor shipped:
ranking that learns from what is actually picked, and user-defined aliases.

- `src/utils/pluginData.ts` - where the files live, and their rules (15 tests).
- `src/actions/aliases.ts` - the typed command and the right-arrow menu (18 tests).
- `src/utils/find.ts` - aliases as extra names, and the empty-query list (11 tests).
- `tools/check-ranking.mjs` - the measured cost and the end-to-end checks, on Windows.

The parts that changed the design are all in "What Flow Launcher already does" below: the
selection count it keeps for us, the `Score`/`RecordKey` it needs from us, and the context menu
it asks us for. Everything else here is what we add around those three facts.

Both touch `find()`, the hot path that runs once per keystroke, and both need state that
survives a restart. That is the whole reason this document exists: where the state lives is an
architecture decision, not a detail.

## What Flow Launcher already does (read from its source, not assumed)

Three facts changed this design after the first draft:

1. **Flow counts selections for us.** `Result.AddSelectedCount` defaults to true, and
   `MainViewModel` adds `_userSelectedRecord.GetSelectedCount(result)` to every result's
   `Score` before sorting. That store is persisted (`FlowLauncherJsonStorage<UserSelectedRecord>`),
   so it survives restarts. This is the "the more I use it, the higher it goes" behaviour that
   already existed - it is Flow's, not ours, and it needs nothing from the plugin except:
2. **A score and a record key.** We were sending neither. Every result had `Score: 0`, so our own
   relevance order was invisible to Flow, and Flow keyed the counts on a hash of Title+SubTitle.
   Results now carry `Score` (our match score) and `RecordKey` (the emoji itself), so the counts
   attach to something stable and our ordering survives the round trip.
3. **JS plugins can add context menu items.** `JsonRPCPluginBase` implements `IContextMenu` by
   calling our script with method `context_menu` and `parameters: [selectedResult.ContextData]`.
   So the right-arrow menu the maintainer described is available to us: each result can carry its
   emoji as `ContextData`, and we answer with menu entries such as "Add an alias".

What Flow does **not** have is a text-input dialog: `IPublicAPI` offers `ShowMsg`,
`ShowMsgWithButton`, `ChangeQuery` and `FocusQueryTextBox`, and nothing that prompts for a string.
So the alias flow cannot be "right arrow, type a name in a popup". It can be: right arrow, choose
"Add an alias", and we pre-fill the query box (`e addalias <emoji> `) with the caret where the
name goes; or type `e addalias swole 💪` outright. Both end in the same save call.

## What already exists

- `find()` (`src/utils/find.ts`) scans emojilib's keyword table, scores each emoji, sorts, and
  returns the first `maxResults`. Measured: 0.13-1.57 ms after the rewrite, 48-55 ms total
  end-to-end with an empty or single-letter query.
- Settings arrive with every query (`src/utils/settings.ts`), declared in `SettingsTemplate.yaml`
  as a checkbox, a dropdown and another dropdown. Values are strings or booleans.
- The paste agent already owns a small, proven file protocol (atomic write, per-user folder,
  capped log). Reusing its conventions costs nothing new.
- Picking a result is free today in the fastest configuration: Flow copies in-process and never
  starts our plugin. **Recording a pick costs a plugin process (~23 ms of Node boot).** That is
  the one place frecency touches something we optimised away.

## Where the state lives

The maintainer's answer: **Flow Launcher's plugin settings folder.** For an installed Flow that
is `%APPDATA%\FlowLauncher\Settings\Plugins\<plugin ID>\`; for a portable Flow it is
`<Flow folder>\UserData\Settings\Plugins\<plugin ID>\`.

Neither path can be assumed, but both are reachable the same way: the plugin knows its own
folder (it is running from `<...>\Plugins\<folder name>\dist\main.js`), and
`Settings\Plugins\<ID>` is always a sibling of that `Plugins` folder. So:

```
walk up from the plugin folder until the folder is named "Plugins"
  -> <root>\Plugins\<folder>          (us)
  -> <root>\Settings\Plugins\<ID>\    (our data)
```

That works for installed and portable without asking the user which one they have, and it never
looks at where Flow Launcher is installed - the same rule the paste agent already follows.

Files, both written atomically (temporary file + rename, like `request.json`):

| file | contents |
|---|---|
| `usage.json` | `{ "🙈": { "count": 3, "lastUsedAt": 1792757171938 }, ... }`, capped |
| `aliases.json` | `{ "shipit": "🚀", "shrug": "🤷" }` |

Corrupt or unreadable files mean "no history" and "no aliases", never a broken query: the same
rule `settings.ts` already follows for bad settings.

## Aliases as shipped

```
e addalias 💪 swole        save "swole" for 💪
e aliases                  list them, plus "open my aliases file" and "open the emoji database"
e removealias swole        remove one
```

**The emoji comes first, and nothing is guessed.** `e addalias` with no emoji in front shows one
line - "Type the emoji first, then the name" - and never a list:

- a list invites Enter, and Enter on a list row could only guess which part of the command was
  meant;
- a bare word would otherwise be both the name to save and the search term for the emoji, so the
  same keystrokes could mean different things depending on what was already aliased. That is
  exactly what made the first version confusing.

One word, one meaning: Enter either saves the alias that is named on the row, or does nothing at
all. The emoji is typed or pasted - search for it with `e`, Enter copies it, paste it after
`e addalias`. The search step that would avoid that is rejected below, with the rule it breaks.

Right arrow on an emoji gives, in order: **Copy only** — the same emoji on the clipboard without
the Ctrl+V, for paste-mode users who want just a copy — **Add an alias for this emoji** (copies the
ready-made command), the **Remove alias “…”** entries for that emoji, and **Open my aliases file**.
Flow appends two entries of its own after those; see below.

**Icons, not glyphs.** An emoji written into a Title renders as a monochrome outline glyph in
Flow's list, and showing it in the title *and* the subtitle looks like a rendering bug. Every
alias entry uses the emoji's own coloured PNG as its icon and keeps the title text to the name.

**Queries never write.** Flow Launcher runs the plugin once per keystroke, so saving during a
query would leave `s`, `sw`, `swo`, ... behind as aliases. Everything that changes a file is an
action, which only runs on Enter.

An alias is an extra name, not a separate search space: `scoreEmoji` takes the better of the
keyword score and the alias score, so an alias can never make an emoji *harder* to find, and the
result's subtitle shows the alias so a hit under a name that is not in its keywords does not look
like a bug.

### Rejected: a search step, because Enter must commit

The obvious repair for "you must know the emoji" is a search step: `e addalias muscle` would list
`💪 Flexed Biceps`, Enter on it would pre-fill `e addalias 💪 `, and the name would be typed into a
query that already holds the emoji. Nothing is written until the last Enter, so no data can go
wrong. It was still rejected, and the reason is the rule it breaks.

**In a launcher, Enter commits. Every row is a promise that Enter does the thing the row says.**
A row whose Enter instead re-aims the query turns Enter into "next", which is navigation, and
navigation is what Tab and the arrow keys are for. Once one row means "advance", the user can no
longer tell a commitment from a step without reading each row's subtitle - the exact tax the
strict grammar removes. It also has no end: if `addalias` may take two steps, why not three, and
which Enter was the one that wrote the file?

That made the two flows differ in exactly one screen, and that screen was the problem:

```
e addalias muscle
  SHIPPED   Type the emoji first, then the name
            e addalias 💪 swole - the emoji is never guessed from the name

  REJECTED  [1f4aa.png] Flexed Biceps
            Enter: name this emoji - Arm, Flex, Hand     <- Enter advances, it does not commit
```

The dead end it was meant to fix has a shorter route that keeps Enter honest: **find the emoji the
way you always do, press Enter (that is the copy), then `e addalias` and paste.** Two keystrokes,
no new grammar, and the hint says so.

### Getting the emoji into the command: the clipboard

Every route by which Flow Launcher could type the command for the user was measured, and every one
of them fails for a reason of its own:

- **`ChangeQuery` from a menu item** sets the query text but does not leave the menu: `Query()` sees
  a context menu selected and re-filters the menu instead of querying
  (`else if (ContextMenuSelected()) QueryContextMenu();`). Measured: the command appeared in the
  box, the list went empty, Enter did nothing.
- **Leaving the menu** is a second call, `BackToQueryResults()`, and one action gets exactly one
  `Flow.Launcher.*` method (`JsonRPCPlugin.ExecuteResultAsync`). Flow's own code needs both, in
  that order - `MainViewModel.GetHistoryItems` does `BackToQueryResults(); ChangeQuery(h.Query);`.
- **Even that order is the only order that works**, because returning from the menu restores the
  pre-menu query text (`SelectedResults` setter: `_queryText = _queryTextBeforeLeaveResults`), so
  anything written inside the menu is thrown away on the way out.
- **`Result.AutoCompleteText`** is honest but awkward: autocomplete is **Ctrl+Tab**, not Tab
  (`Settings.AutoCompleteHotkey` vs `SelectNextItemHotkey = "Tab"`, which is why Tab did nothing),
  and its documented fallback is the row's Title - so a second Ctrl+Tab types "Now type the name".

So the menu hands the command over on the clipboard: **Add an alias for this emoji** copies
`e addalias 💪 ` (trailing space included), and the user goes back, pastes, and types the name.
One API call, no hidden keystrokes, and what gets pasted is exactly what they could have typed.

The context menu's two trailing entries are Flow's and cannot be removed by a plugin:

```csharp
// MainViewModel.QueryContextMenu()
results = PluginManager.GetContextMenusForPlugin(selected);
results.Add(ContextMenuTopMost(selected));      // "Set as topmost in this query"
results.Add(ContextMenuPluginInfo(selected));   // "<plugin name>"
```

"Topmost" is Flow's per-query pinning of one result; an alias is a permanent second name for an
emoji. They overlap in intent, not in effect.

**The keyword comes from plugin.json.** Flow strips the action keyword before handing us the search
text, so the plugin cannot see the word the user typed; `readActionKeyword` reads its own manifest
(`e`). A user who rebinds the keyword in Flow's settings keeps the old value here, and the copied
command would miss. The typed form always works, and the entries show the command.

## Frecency## Frecency

**Ranking**, inside `find()`, after the existing match score:

```
finalScore = matchScore + frecencyBoost(emoji)
frecencyBoost = 6 × decay(lastUsedAt) × frequency(count)
  decay     = 2^(-ageInDays / 14)          // half-life of two weeks
  frequency = log2(1 + count) / log2(1 + 20)
```

The ceiling of 6 is deliberate: the existing scoring gives +5 for a keyword part that is exactly
what the user typed, and doubles the name's contribution. So a favourite can climb past a loose
partial match, and can never outrank an exact hit on what the user actually typed. Frecency
should feel like memory, not like a second search engine.

**Empty query.** Today an empty query matches everything and returns the head of the table. With
frecency it returns the most-used-and-recent emoji first, then the usual order for anything not
in the history. Nothing is removed, so the list is never empty on a fresh install.

**Recording a pick.** Only our own action can record it, so when frecency is enabled every pick
runs through the plugin instead of the in-process `Flow.Launcher.CopyToClipboard` shortcut. Cost:
one Node process per Enter, ~23 ms, plus one small file write. Not on the keystroke path.

## Aliases

**Matching.** An alias becomes an extra keyword for its emoji, ranked as if the user had typed
the emoji's own name. Typing `shipit` finds 🚀 - no prefix, no separate keyword, nothing to learn.

**Creating them.** This is the part I want an answer on, because it decides how much UI the
feature needs:

1. *File only.* `aliases.json` in the settings folder, documented in the README. Cheapest, and
   fine for the person who asked for it; hostile to everyone else.
2. *Two-step in Flow.* Type `e alias shipit`, get the emoji list, pick one: the alias is saved.
   No new UI, no new files to learn, and it uses the list the user already knows how to use.
3. *Both.* The file stays the storage format; the command is how it is normally written.

## Order of work

1. Settings folder resolution + a tiny JSON store (read, atomic write, cap) with tests.
2. Aliases matching in `find()` (no UI yet), with tests.
3. Frecency ranking + empty-query behaviour, with tests.
4. Recording, and the action routing that makes it possible.
5. Whatever alias UI we agree on.
6. Measure again: `find()` cost per keystroke, and the cost of a pick.

## Two traps found on the machine (both fixed)

- **Flow decodes our stdout with the console code page.** `RedirectStandardOutput` is set without
  `StandardOutputEncoding`, so an emoji written literally arrives as mojibake - the context menu
  said "Add an alias for this emoji" only after the emoji was removed. Everything printed is now
  ASCII JSON (`\ud83d\udcaa`), which any code page carries and JSON restores.
- **A dropdown's stored value is its label.** Renaming the options to "Copy Mode"/"Paste Mode"
  left every existing install showing an empty box, because Flow renders a dropdown by matching
  the stored string (`copy`) against the options. `migrateEnterModeSetting` rewrites the legacy
  value in Flow's `Settings.json`; `parseDefaultAction` accepts both.

## The settings page cannot have the button (evidence)

The maintainer asked for a settings button that opens the aliases file, and one for the database.
`JsonRPCPluginSettings` (Flow Launcher's settings renderer for JS plugins) knows exactly these
item types:

```
textBlock, input, inputWithFileBtn, inputWithFolderBtn, textarea, passwordBox,
dropdown, checkbox, hyperlink, separator
```

There is no `button`. The two closest are:

- `hyperlink`, which calls `API.OpenUrl(attributes.url)` - a **static** URL written in the YAML, so
  it cannot contain a path that differs per machine (installed vs portable, different user name);
- `inputWithFileBtn` / `inputWithFolderBtn`, a text field with a "Select" button that opens a
  *file picker*, not an editor.

So the clickable "open it" lives one keystroke into Flow instead, where the path is known:

```
e aliases      ->  "Open your aliases file"    (Flow.Launcher.ShellRun('', <path>))
                   "Open the emoji database"   (same, the emojilib JSON)
                   one row per alias, Enter removes it
```

and the same "Open your aliases file" item is in the right-arrow menu of every emoji.

What the settings page *can* have is a `textBlock` that says where the files are and how to open
them. The wording is the maintainer's to write; the shape is:

```yaml
  - type: textBlock
    attributes:
      name: aliasHelp
      description: "<the maintainer's words: what aliases are, the command, where the file is>"
```

Note that `description` is the text a `textBlock` renders, and `name` is not shown.

## Measured cost (this is why there is no cache)

`npm run check:ranking`, on the maintainer's machine:

| what | cost |
|---|---|
| `find()` with 40 aliases loaded, per keystroke | **+0.03 to +0.08 ms** |
| reading `aliases.json` | 0.02 ms |
| reading `usage.json` | 0.006 ms |
| whole process, one query | 52.6 ms (unchanged: Node boot dominates) |

The maintainer asked whether the aliases should be pre-computed or cached "on extension start".
There is no extension start: Flow Launcher runs a fresh Node process for every keystroke, so a
cache would be rebuilt per keystroke anyway, and reading the file is already twenty times
cheaper than building one. Merging aliases into a pre-built index would be YAGNI until a user
has thousands of aliases - and the file is capped at 300 history entries with aliases set by hand.

## Decisions

1. **Alias creation**: the context menu is the intended path, the command is the power path, and
   the JSON file stays the storage format. Maintainer's words: avoid making the user learn a
   command, but let the people who want one have it.
2. **Frecency**: on by default, and it is Flow's counting that does the ranking work - we only add
   the empty-query list, which Flow cannot give us.
3. **Copy vs count**: Flow records a selection whatever action runs, so a direct in-process copy is
   still counted. That is the whole reason to prefer Flow's counter over our own: no extra
   process on the pick path, and the fastest copy stays the fastest copy.

The remaining cost is only for the empty-query list: to show "the emoji you actually use" for an
empty query we must know the order, and Flow's store is an internal hash-keyed file we are not
going to parse. So our own small `usage.json` is written by our actions, which costs one plugin
process per pick (paste already pays it; copy with notifications off would start paying it only
if the list proves worth it - measure before deciding).
