<!--
Suggested PR title:
  Paste at the cursor, aliases for your own words, and a query path that costs a third of what it did

Paste the body below into the PR description. Everything in <angle brackets> or in a
"Showcase placeholder" block is for you to replace or delete.
-->

# Paste to Cursor, Custom emoji Aliases, and a much cheaper query

This PR keeps everything the plugin already does — type `e`, search, press Enter, emoji on the
clipboard — and adds the three things it could not do before:

- **paste the emoji where your cursor is**, instead of leaving you to press <kbd>Ctrl</kbd>+<kbd>V</kbd>;
- **aliases**, so an emoji answers to the words *you* use for it;
- **your own emoji first** on an empty query, because a picker you use daily should remember what
  you pick.

It also cuts the cost of a keystroke hard: the result payload is **98 % smaller** and a query
now costs a third less. Everything below is measured, and the measurements are in the repository.

> [!NOTE]
> **What this PR does not do.** No native binaries, no network access, no sockets or named pipes,
> no elevation, no telemetry. Paste talks to a background process through two small files in
> `%LOCALAPPDATA%`. Portable Flow Launcher installs keep working, because nothing here looks at
> where Flow Launcher lives.

---

## Paste at the cursor

> Addresses [#7 — *Feature request: Insert emoji directly instead of copying to clipboard*](https://github.com/kalvn/Flow.Launcher.Plugin.EmojiFinder/issues/7).
> The request was to remove the manual paste step; the reply was that injecting a character needs
> something Node cannot do natively, and that pre-compiled C++ binaries would be a heavy price for
> one feature.

That price does not have to be paid. The paste half only needs someone to press
<kbd>Ctrl</kbd>+<kbd>V</kbd> after Flow closes, and Windows already has a scripting host that can
do it: PowerShell. So the design is a **resident agent** — one hidden PowerShell process, started
once, waiting for requests.

Why it has to be resident rather than a helper started per paste: **Flow Launcher destroys the
plugin process the moment the action returns.** A helper started from inside the plugin dies with
it, often before its first line runs. Five plausible variants were tried and are documented in
[`docs/PASTE_AT_CURSOR.md`](docs/PASTE_AT_CURSOR.md), including the trap that ate a day —
`detached: true` on Windows gives you a console-less `powershell.exe` that exits 0 without
executing any of the script.

How it works, in one paragraph: the plugin copies the emoji through Flow
(`Flow.Launcher.CopyToClipboard`, in-process, unicode-safe), writes a small request file, and
never waits. The agent wakes on that file, checks that the clipboard really holds the requested
emoji, sends <kbd>Ctrl</kbd>+<kbd>V</kbd>, and writes a heartbeat. If no agent is running, one is
started through a window-less `wscript` launcher and the pending request is adopted — **a paste
that arrives a second late beats a paste that silently does nothing**. The agent's script is
rewritten from the installed build on every request, so a fix can never be shadowed by an old
agent in memory.

Measured: **25–85 ms** from request to keys sent, with the agent already running. The PowerShell
cold start (99 ms) is paid once, not per paste.

**Cost, stated plainly:** one background process of roughly 40–60 MB, and only if paste is used
as the Enter Mode. Copy Mode, the default, starts nothing at all.

> 🎬 **Showcase placeholder — paste at the cursor**
> Record: Enter Mode set to *Paste Mode*, cursor in a text editor, `e thumbs up`, Enter, emoji
> appears at the cursor without a keystroke.
> Replace this block with `![Paste at the cursor](docs/media/paste-at-cursor.gif)` or a video link.

**Known limits**, because a feature that quietly fails is worse than one that explains itself:

| Situation | What happens |
|---|---|
| A window running as administrator | Windows blocks input from non-elevated processes. Not fixable, by design. |
| Fullscreen-exclusive games | Synthetic input is ignored. |
| Terminals that paste with <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd> | They receive what plain <kbd>Ctrl</kbd>+<kbd>V</kbd> means for them. |
| Remote sessions | Depends on the client's forwarding. |

## Aliases

> Addresses [#3 — *Feature Suggestion/Enquiry: Customizable Keywords for Emoji Matching*](https://github.com/kalvn/Flow.Launcher.Plugin.EmojiFinder/issues/3),
> which asked for `e addterm 💪 muscle` and for a way to make "muscle" find 💪 without editing a
> dependency's JSON.

#### The situation
The emoji database is `emojilib`'s file inside `node_modules`. Editing it looks like the obvious
answer and is a trap: the plugin folder is replaced on every update, so **anything written there and the plugin cannot tell a hand-edited keyword from an upstream one. 
disappears**
#### The solution
So now, aliases live in their own file, in the plugin's own settings folder, and the database is left alone.

```
-- You Type --             -- It Does --
e addalias 💪 swole       Assigns the term "swole" for the emoji 💪
e removealias swole       Removes the alias "swole"
e aliases                 Display a list of your aliases. And a easy way to remove them.
```

An alias is simply another name under which the emoji can be found. So scoring takes the better of the keyword score and the alias score, so an alias can never make an emoji harder to find!

**The grammar is deliberately strict: the emoji comes first, and nothing is guessed.** An earlier
revision accepted either order and searched for the emoji when it could not find one, which made a
single word mean two things at once — in `e addalias muscle`, "muscle" was both the name to save
and the search term for the emoji — and the same keystrokes could mean something different
depending on what was already aliased. Now `e addalias muscle` says *type the emoji first, then the
name*, and no row in that state can be pressed with Enter. **Tab is not used**, because in Flow
<kbd>Tab</kbd> moves to the next result (`SelectNextItemHotkey`); autocomplete is
<kbd>Ctrl</kbd>+<kbd>Tab</kbd>, and it falls back to the row's title on the second press.

**Queries never write.** Flow runs the plugin once per keystroke, so saving during a query left
`s`, `sw`, `swo` behind as aliases the one time it was tried. Every write is an action, which only
runs on Enter.

The right-arrow menu carries the flow too — **Add an alias for this emoji** puts the finished
command on the clipboard, and **Remove alias “…”** entries handle removal:

> 🎬 **Showcase placeholder — aliases**
> Record: `e muscle` → right arrow → *Add an alias for this emoji* → go back, paste, type `swole`,
> Enter → `e swole` now returns 💪.
> Replace this block with `![Aliases](docs/media/aliases.gif)`.

The file explains itself, which matters for anyone who would rather edit it by hand:

```json
{
  "_HowToUse": "You may manually edit this file to add aliases. Entries starting with _ such as these, are ignored. They're only because JSON doesn't support comments.",
  "_Note": "This file lives in the settings folder, so it survives plugin updates. Don't edit the emoji database directly as your changes would get lost on update!",
  "_examplealias": "💪"
}
```

## Your own emoji first

An empty `e` used to be an arbitrary slice of 1 900 results. Now it is your history: the emoji you
pick, most recent first, and nothing else — no filler, no "popular" list. Picks are recorded by
every action (copy, paste, alias save), capped at 300 entries, and the file is small enough that
reading it on every keystroke stays free.

> 🎬 **Showcase placeholder — empty query**
> Record: press `e` with nothing typed, showing a short personal list, then enough usage that the
> order visibly changes.
> Replace this block with `![Your own emoji first](docs/media/frecency.gif)`.

## The query path costs a third of what it did

Flow starts a fresh `node` process for every keystroke, so everything here is measured per process,
not per session.

| | before | after |
|---|---|---|
| payload, widest queries | 373 KB | **5.3 KB** (−98 %) |
| empty query, end to end | 111.7 ms | **49.6 ms** (−56 %) |
| `smile`, end to end | 75.6 ms | **49.7 ms** (−34 %) |
| `find()` itself | 2–12 ms | **0.1–1.6 ms** |
| copy action | second node process + PowerShell spawn | **~0 ms**, done by Flow in-process |

What produced it:

- **Results are capped.** A dropdown (10 / 25 / 50 / 100 / 250, default 25) replaces shipping the
  whole match set. Flow deserialises every result and builds a WPF row for each; that was the part
  people actually felt.
- **`find()` was rewritten** to make one pass with no per-emoji allocation, and to build the
  human-readable strings only for the slice it returns. Two correctness bugs went with it: a
  comparator that never returned 0 (so ties were arbitrary) and `split(' ')` on a double space,
  which produced an empty term that matched everything.
- **Copy is delegated to Flow.** `clipboardy` is no longer imported on the query path — it cost
  27–40 ms per keystroke for a module a query never uses.
- **Aliases and history are cheap:** +0.03–0.08 ms per keystroke with 40 aliases loaded, and
  0.015–0.02 ms to read the aliases file.

The full measurement log is in [`docs/PERF_ANALYSIS.md`](docs/PERF_ANALYSIS.md); the numbers above
are reproduced on demand by `npm run benchmark` and `npm run check:ranking`.

## Copy only, for people who mostly paste

Paste Mode changes what Enter does, which is wrong for the occasional emoji you want on the
clipboard only. The context menu now has **Copy only**: the same emoji, without the
<kbd>Ctrl</kbd>+<kbd>V</kbd>, still recorded as a pick.

---

## Things we fixed along the way

- **Mojibake in the context menu.** Flow reads a plugin's stdout through
  `RedirectStandardOutput` without `StandardOutputEncoding`, so .NET decodes it with the console
  code page, not UTF-8, and a literal emoji arrived as garbage. Everything printed is now ASCII
  JSON (`\ud83d\udcaa`), which any code page carries and JSON restores.
- **The context menu could not type for you.** `ChangeQuery` from a menu item sets the text but
  does not leave the menu — Flow re-filters the menu instead of querying — and leaving it takes a
  second API call that one action does not get. Returning from the menu also restores the
  pre-menu text. The entry now hands the finished command over on the clipboard instead of
  pretending otherwise. This is written up in
  [`docs/FRECENCY_AND_ALIASES.md`](docs/FRECENCY_AND_ALIASES.md) with the source references.
- **“Open my aliases file” did nothing.** `ShellRun(cmd, filename)` starts `filename` *as the
  program*, so `ShellRun('', 'user-aliases.json')` asked Windows to execute a JSON file. It now
  creates the file if needed and opens it with `OpenAppUri`, which ends in
  `Process.Start(…, UseShellExecute = true)`.
- **Writes landed in a folder Flow never reads.** Flow names a non-.NET plugin's settings folder
  after the plugin (`PluginManager.UpdatePluginDirectory`), not after its ID. This plugin used its
  ID, so its settings sat in a GUID-named folder next to Flow's tidy `Emoji Finder` one. The name
  now comes from `plugin.json`.
- **The file names say whose data they are:** `user-aliases.json` and `user-frecency.json`.
- **A dropdown's stored value is its label.** Reworded options ("Copy Mode"/"Paste Mode") leave a
  box blank if the stored string matches none of them; the parser accepts both spellings, so a
  stray old value still behaves correctly.
- **An empty query mixed the whole emoji table into the history**, which made a personal list look
  random. It is the history only now.

---

## Testing

> [!NOTE]
> **Where this was tested.** On a real Windows 11 machine (not a container), with the plugin
> installed into Flow Launcher 2.1.4 and driven by hand, plus a self-hosted GitHub Actions runner
> on the same machine so the Windows-only paths could be exercised on every push. PowerShell
> matters here, so the matrix is pinned: the paste agent was proven under **both**
> `powershell.exe` 5.1 and `pwsh` 7, and the `wscript` launcher separately.

| Check | Result |
|---|---|
| `npm run test` (vitest) | **188 tests, 12 files**, all passing |
| `npm run lint` / `npm run build` | clean |
| `npm audit` (production and development) | **0 vulnerabilities** |
| `npm run check:paste-agent` | `powershell.exe` **10/10**, `pwsh` **10/10**, launcher **5/5** |
| `npm run check:ranking` | **21/21** — aliases, the empty-query list, the context menu, per-keystroke cost |
| `npm run doctor` | manifest, entry point and installed copy all match the build |
| CI | new `.github/workflows/ci.yml`: audit, lint, test, build on every push and PR |

The agent check runs in its own temporary folder, so proving paste works never stops the agent
someone is relying on — which is exactly the kind of self-inflicted bug that took an hour to
recognise as ours.

The new tests are behavioural where it matters: the query path never writes, actions always do,
`find()` keeps its ordering properties across the whole emoji corpus, the ASCII-only stdout
invariant holds, and the context menu's entries are asserted as a list, in order.

---

## What is deliberately not here

- **Localisation** ([#8](https://github.com/kalvn/Flow.Launcher.Plugin.EmojiFinder/issues/8)).
  Worth doing, but it touches every string in the plugin and would bury the features above.
- **Native code or a compiled helper.** It would buy a faster cold start for paste, at the cost of
  a binary per architecture, antivirus false positives, and a build step. The resident agent
  avoids all three.
- **Editing the emoji database as a way to add keywords.** It is an upstream dependency; updates
  replace it. Aliases are the answer that survives an update.

## Reviewing this

The core of the change is small: `src/utils/find.ts` (search), `src/utils/pluginData.ts` (the two
files), `src/actions/` (query, copy, paste, aliases), `src/utils/pasteAgent.ts` (the agent script
is generated from a template string, so it can be reviewed as text). The rest is tooling under
`tools/` and the documents under `docs/` that record what was measured and what was rejected.

Happy to split this into smaller PRs — paste, aliases/frecency, and performance — if that is
easier to review.

*Thank you for your consideration.*

### 🙏
