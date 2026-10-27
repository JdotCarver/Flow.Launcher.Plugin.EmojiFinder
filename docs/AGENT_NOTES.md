# Agent notes

Working notes for the Arena agent. Keep this short and useful; delete anything stale.

## Environment

- Session branch: `arena/cdf6971a-flow-launcher-plugin-emojifind`
  (never switch branches; the harness tracks this one).
- Turn start: `bash tools/arena-turn-start.sh` — waits out snapshot restores, syncs with
  the remote, verifies the tree. Self-test: `bash tools/test-turn-start.sh` (11 scenarios,
  ~70 s, run it after editing the script).
- `node_modules` is not tracked. A harness re-clone loses it → `npm ci` (~80 s).
- `npm run build` = `tsc` → `dist/` (gitignored). Tests run against `src/` via vitest,
  so `npm test` works without a build.

## Facts worth not rediscovering

- Flow Launcher spawns **one node process per keystroke**, cwd = plugin directory
  (`NodePlugin.InitAsync` sets `WorkingDirectory` to `PluginDirectory`). Every module
  imported by `main.ts` is paid for on every query — that is why an eager
  `import 'clipboardy'` costs ~30 ms per keystroke.
- Plugin uses the **V1** JSON-RPC protocol (argv in, JSON on stdout). Any result action
  whose method starts with `Flow.Launcher.` is executed **in-process by Flow**
  (`JsonRPCPlugin.ExecuteResultAsync` → `ExecuteFlowLauncherAPI`), by reflection over
  `IPublicAPI` with exact parameter types. `JsonObjectConverter` maps JSON strings/bools
  to `string`/`bool`, so `CopyToClipboard(string, bool, bool)` and `ShowMsg(string, string, string)`
  both resolve. This is the cheap path for actions; spawning a second node process is not.
- Data source: `node_modules/emojilib/dist/emoji-en-US.json` (1 906 emoji, ~8 keywords
  each, 257 KB).
- Flow **skips any plugin folder whose `ExecuteFileName` does not exist**
  (`PluginConfig.GetPluginMetadata` returns null, only a log line). That is why an
  unbuilt checkout "disappears" from the launcher. `npm run package` produces a folder
  Flow will accept; see docs/DEVELOPMENT.md.
- Flow runs JavaScript plugins with **its own Node 16.18.0**, not the system Node
  (`%APPDATA%\FlowLauncher\Environments\Node.js`). `npx -y node@16 dist/main.js '<json>'`
  is the compatibility check.
- Plugins folder: `%APPDATA%\FlowLauncher\Plugins\` (or `<Flow>\UserData\Plugins\` when
  portable). Scanned one level deep only. The store copy shares this plugin's ID, so
  only one of the two may exist.
- Benchmarks live in `tools/bench.mjs`; methodology and results in `docs/PERF_ANALYSIS.md`.
- Results whose action method starts with `Flow.Launcher.` are executed **in-process by
  Flow**, without spawning the plugin at all. Flow resolves those by exact parameter
  *types* (`IPublicAPI.GetMethod`), so optional C# parameters do not exist for us: send
  every argument. `CopyToClipboard(string, bool directCopy, bool showDefaultNotification)`.
- `IPublicAPI` has no key-injection/paste API (checked the whole interface). Paste at the
  cursor synthesises Ctrl+V from a **resident** PowerShell agent, because anything the plugin
  starts is killed when the plugin process ends. Design in `docs/PASTE_AGENT.md`, history and
  the discarded approaches in `docs/PASTE_AT_CURSOR.md`.
- Paste agent: foreground detection uses `Get-Process -Name 'Flow.Launcher*'` +
  `MainWindowHandle`, **not** `Add-Type` P/Invoke: compiling C# at run time costs several
  hundred ms, which is
  more than the feature saves. Windows PowerShell 5.1 (what `powershell.exe` is) runs STA,
  which `Clipboard::GetText()` requires.
- Dependency policy and audit reasoning: `docs/DEPENDENCIES.md`.
- "Plugin not in the list" = Flow skipped the folder at registration. The silent causes,
  in order: nested folder (Flow scans one level), unparsable plugin.json, ExecuteFileName
  missing, duplicate plugin ID (only the first loads, log says "already loaded"), or the
  Node runtime path Flow points at being gone (then ALL JS plugins vanish). `npm run
  doctor` checks all five and reads Flow's logs.
- A `trace.on` install writes into the *installed* folder, not the repo; `npm run diagnose`
  copies it back into dogfood/.
- Self-hosted Windows runner: `docs/WINDOWS_RUNNER.md`. Drive it with `gh workflow run`,
  `gh run view --log`, `gh run download`. Runner must run interactively (`run.cmd`), never
  as a service: session 0 has no desktop and the GUI probes fail there.
- Never accept, echo or store a runner registration token. If one appears in chat, tell
  the maintainer to delete the runner and re-add it.
- Paste injection cannot be tested here (no Windows/PowerShell). Do not claim it works:
  ask for a dogfood run (`docs/DOGFOODING.md`) and read `npm run dogfood:check`.
  `dogfood/diagnose.json` + `dogfood/runtime.log` are the maintainer's committed evidence.
- PowerShell: any .NET call can emit output (`Control.Focus()` returns a bool). Never let
  a probe print its payload to stdout: the first diagnostic wrote `True` in front of its
  JSON and Node could not parse it. Write reports to a file instead.
- Tracing: `src/utils/trace.ts` writes JSONL only when `trace.on` sits next to
  plugin.json (`npm run package -- --trace`, gitignored). Never on the query path.
- **`MainWindowHandle` is not a signal for Flow Launcher.** It is 0 even while Flow's window
  is on screen (measured: 672 polls out of 672), so any rule of the form "no visible Flow
  window OR …" is unconditionally true and its other half never runs. The paste agent now
  gates on focus alone: the clipboard holds the emoji AND the focused window is not Flow's.
  Removing a dead half of a condition is worth more than adding a third signal to it.
- **Flow hides, it does not close.** A keystroke sent while Flow still has focus lands in its
  query box and reappears the next time the launcher is opened - which looks exactly like
  "the paste never happened, then happened into Flow". If a future action types anything,
  it must wait for focus to leave Flow first.
- **Logs are plain text in the user's profile: identify windows by pid and handle, never by
  title.** A title is the user's own text (a document name, a message subject).
- Never use `Get-Content`/`Add-Content`/`Set-Content` for data the plugin and the agent
  exchange: their default encoding differs between Windows PowerShell 5.1 and PowerShell 7,
  and that difference silently destroyed every emoji for a whole afternoon. Use
  `[System.IO.File]` with `[System.Text.Encoding]::UTF8`.

- **A dropdown's value is a string the user sees, and it is also the setting's value.** Renaming
  an option renames the stored value. Parse it leniently (match the word inside), or a wording
  change silently disables a setting.
- **Flow Launcher reads a plugin's stdout with the console code page, not UTF-8.** Never print
  non-ASCII: escape it into JSON (`\uXXXX`) so the JSON parser on Flow's side restores it.
- **Right-arrow context menus keep filtering themselves.** While the menu is open the query box
  filters the menu's entries, and only Escape leaves it, so nothing that needs typed input can
  start there.
- **A shallow checkout breaks history-based decisions.** `actions/checkout` fetches one commit by
  default, so `git diff HEAD~1 HEAD` fails silently in a workflow. Ask for `fetch-depth: 2`, or
  decide from something other than history.

## Code conventions in this repo

- neostandard lint (2-space, semicolons, single quotes); `.editorconfig` matches.
- Every file starts with a comment naming the file.
- Prefer readability over cleverness; this is a plugin people read to learn from.
