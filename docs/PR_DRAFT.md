<!--
Suggested PR title:
  Paste to Cursor, Custom emoji Aliases, and a much cheaper query

Paste the body below into the PR description. Everything in <angle brackets> or in a
"Showcase placeholder" block is for you to replace or delete.
-->

# Paste to Cursor, Custom emoji Aliases, Frecency and a much cheaper query

I am happy to announce that this PR adds three things Emoji Finder could not do before while also cutting the cost of a keystroke down. 
We have :
- The ability to insert the emoji directly at the cursor's position
- The ability to set custom words for the emojis to match with
- A highly relevant "most used" page upon opening the extension
- The payload is **now 98 % smaller** and a query is now more than **60% faster.**
Everything below is measured, on both a VM and my own dev machine, with the measurement scripts shipped in the repository.


---

## Paste at the cursor

> Addresses [#7 — *Feature request: Insert emoji directly instead of copying to clipboard*](https://github.com/kalvn/Flow.Launcher.Plugin.EmojiFinder/issues/7).

Pasting needs one thing Flow Launcher cannot give a plugin: something that presses
<kbd>Ctrl</kbd>+<kbd>V</kbd> *after* Flow has closed. Windows already has a scripting host that can
do it, so the design is a **resident agent** — one hidden PowerShell process that waits for
requests and types the keystroke. No native binaries, no per-paste PowerShell start, nothing to
compile.

Flow Launcher destroys a plugin's process the moment an action returns, so the agent has to be a
process of its own rather than a child of the plugin — which is exactly what makes it cheap: the
PowerShell cold start (99 ms) is paid once, at login, instead of on every paste.

How it works, in one paragraph: the plugin copies the emoji through Flow
(`Flow.Launcher.CopyToClipboard`, in-process, unicode-safe), writes a small request file, and
returns. The agent wakes on that file, confirms the clipboard really holds the requested emoji,
sends <kbd>Ctrl</kbd>+<kbd>V</kbd>, and writes a heartbeat. If no agent is running, one is started
through a window-less `wscript` launcher and picks the pending request up — a paste that arrives a
second late instead of a paste that silently does nothing. The agent's script is rewritten from the
installed build on every request, so an upgrade always runs the current code.

Measured: **25–85 ms** from request to keys sent, agent already running.

**Cost, stated plainly:** one background process of roughly 40–60 MB, and only if Paste Mode is
selected. Copy Mode, the default, starts nothing at all.

> [!IMPORTANT]
> Paste cannot reach a window running as administrator, because Windows blocks input from
> non-elevated processes.

> 🎬 **Showcase placeholder — paste at the cursor**
> Record: Enter Mode set to *Paste Mode*, cursor in a text editor, `e thumbs up`, Enter, emoji
> appears at the cursor without a keystroke.
> Replace this block with `![Paste at the cursor](docs/media/paste-at-cursor.gif)` or a video link.

## Aliases

> Addresses [#3 — *Feature Suggestion/Enquiry: Customizable Keywords for Emoji Matching*](https://github.com/kalvn/Flow.Launcher.Plugin.EmojiFinder/issues/3),
> which asked for `e addterm 💪 muscle` and for a way to make "muscle" find 💪.

#### The situation
The emoji database is `emojilib`'s file inside `node_modules`. Editing it looks like the obvious
answer and is a trap: the plugin folder is replaced on every update, so **anything written there
disappears**, and the plugin cannot tell a hand-edited keyword from an upstream one.

#### The solution
So now, aliases live in their own file, in the plugin's own settings folder, and the database is
left alone.

```
-- You Type --             -- It Does --
e addalias 💪 swole       Assigns the term "swole" for the emoji 💪
e removealias swole       Removes the alias "swole"
e aliases                 Display a list of your aliases. And a easy way to remove them.
```

An alias is simply another name under which the emoji can be found. So scoring takes the better of
the keyword score and the alias score, so an alias can never make an emoji harder to find!

**The emoji comes first, then the name.** `e addalias 💪 swole` saves the alias; `e addalias 💪`
asks for the name; `e addalias` asks for the emoji, and the next keystroke starts the command for
you. One word always means one thing: a name is a name, and an emoji is never guessed from it.

**Queries never write.** Flow runs the plugin once per keystroke, so saving during a query would
leave every prefix behind as an alias. Every write is an action, which only runs on Enter.

The right-arrow menu carries the flow too — **Add an alias for this emoji** copies the finished
command, and **Remove alias "…"** entries handle removal:

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

An empty query now answers with your history: the emoji you pick, most recent first — no filler, no
"popular" list. Picks are recorded by every action (copy, paste, alias save), capped at 300 entries,
and the file is small enough that reading it on every keystroke stays free.

> 🎬 **Showcase placeholder — empty query**
> Record: press `e` with nothing typed, showing a short personal list, then enough usage that the
> order visibly changes.
> Replace this block with `![Your own emoji first](docs/media/frecency.gif)`.

## 🧰 Benchmarks

Flow starts a fresh `node` process for every keystroke, so everything is measured per process.

| Measurement | Before | After | Faster by |
|---|---|---|---|
| Payload, widest queries | 373 KB | **5.3 KB** | **70×** |
| Empty query, end to end | 111.7 ms | **49.6 ms** | **2.25×** |
| `a` (1 letter), end to end | 103.5 ms | **55.4 ms** | **1.87×** |
| `he` (2 letters), end to end | 84.8 ms | **53.4 ms** | **1.59×** |
| `face`, end to end | 84.2 ms | **53.4 ms** | **1.58×** |
| `red heart`, end to end | 77.8 ms | **48.6 ms** | **1.60×** |
| `smile`, end to end | 75.6 ms | **49.7 ms** | **1.52×** |
| No match, end to end | 75.6 ms | **49.9 ms** | **1.52×** |
| `find()` — empty query | 12.47 ms | **1.57 ms** | **7.9×** |
| `find()` — `a` | 10.54 ms | **1.40 ms** | **7.5×** |
| `find()` — `red heart` | 2.17 ms | **0.13 ms** | **16.7×** |
| Copy action | a second node process plus a PowerShell spawn | **~0 ms**, done by Flow in-process | **instant** |

What produced it:

- **Results are capped.** A dropdown (10 / 25 / 50 / 100 / 250, default 25) replaces shipping the
  whole match set. Flow deserialises every result and builds a WPF row for each; that was the part
  people actually felt.
- **`find()` makes one pass** over the data with no per-emoji allocation, and builds the
  human-readable strings only for the slice it returns. Picks and ties are now ordered
  deterministically, and repeated whitespace no longer produces a term that matches everything.
- **Copy is delegated to Flow.** `clipboardy` left the query path entirely — it cost 27–40 ms per
  keystroke for a module a query never uses.
- **Aliases and history are nearly free:** +0.03–0.08 ms per keystroke with 40 aliases loaded, and
  0.015–0.02 ms to read the aliases file.

The full log is in [`docs/PERF_ANALYSIS.md`](docs/PERF_ANALYSIS.md); the numbers are reproduced on
demand by `npm run benchmark` and `npm run check:ranking`.

## Copy only, for people who mostly paste

Paste Mode changes what Enter does, which is wrong for the occasional emoji you want on the
clipboard only. The context menu now has **Copy only**: the same emoji, without the
<kbd>Ctrl</kbd>+<kbd>V</kbd>, still recorded as a pick.


---

## Tests

> [!NOTE]
> I ran tests on my Windows 10 machine, with Flow Launcher 2.1.4 in Installed mode

| Check | Result |
|---|---|
| `npm run test` (vitest) | **191 tests, 12 files**, all passing |
| `npm run lint` / `npm run build` | clean |
| `npm audit` (production and development) | **0 vulnerabilities** |
| `npm run check:paste-agent` | `powershell.exe` **10/10**, `pwsh` **10/10**, launcher **5/5** |
| `npm run check:ranking` | **22/22** — aliases, the empty-query list, the context menu, the keyword, per-keystroke cost |
| `npm run doctor` | manifest, entry point and installed copy all match the build |
| CI | new `.github/workflows/ci.yml`: audit, lint, test, build on every push and PR |

The agent check runs in its own temporary folder, so exercising paste never disturbs the agent
someone is relying on.

The tests are behavioural: the query path never writes and actions always do, `find()` keeps its
ordering properties across the whole emoji corpus, stdout is ASCII-only, every printed command uses
the installation's own keyword, and the context menu's entries are asserted as an ordered list.


*Thank you for your consideration.*

### 🙏
