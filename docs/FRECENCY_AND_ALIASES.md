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
e addalias swole 💪        add (both word orders work; a name may contain spaces)
e addalias 💪 swole        the same command
e aliases                  list them, plus "open the aliases file" and "open the emoji database"
e removealias swole        remove one
```

Right arrow on any emoji → **Add an alias for 💪** → the query box is pre-filled with
`addalias 💪 ` and the caret at the end → type the name → Enter. That is the whole flow the
maintainer asked for, minus the popup text box Flow does not have.

An alias is an extra name, not a separate search space: `scoreEmoji` takes the better of the
keyword score and the alias score, so an alias can never make an emoji *harder* to find, and the
result's subtitle shows the alias so a hit under a name that is not in its keywords does not look
like a bug.

## Frecency

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

## Measured cost (this is why there is no cache)

`npm run check:ranking`, on the maintainer's machine:

| what | cost |
|---|---|
| `find()` with 40 aliases loaded, per keystroke | **+0.03 to +0.06 ms** |
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
