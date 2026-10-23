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
  cursor synthesises Ctrl+V from a detached PowerShell helper; design + limits in
  `docs/PASTE_AT_CURSOR.md`.
- Paste helper: `powershell.exe -EncodedCommand` (base64 UTF-16LE) avoids quoting hell.
  Foreground detection uses `Get-Process -Name 'Flow.Launcher*'` + `MainWindowHandle`,
  **not** `Add-Type` P/Invoke: compiling C# at run time costs several hundred ms, which is
  more than the feature saves. Windows PowerShell 5.1 (what `powershell.exe` is) runs STA,
  which `Clipboard::GetText()` requires.
- Dependency policy and audit reasoning: `docs/DEPENDENCIES.md`.
- Paste injection cannot be tested here (no Windows/PowerShell). Do not claim it works:
  ask for a dogfood run (`docs/DOGFOODING.md`) and read `npm run dogfood:check`.
  `dogfood/diagnose.json` + `dogfood/runtime.log` are the maintainer's committed evidence.
- Tracing: `src/utils/trace.ts` writes JSONL only when `trace.on` sits next to
  plugin.json (`npm run package -- --trace`, gitignored). Never on the query path.
- The paste helper accepts **either** "no visible Flow window" **or** "focus is not in a
  Flow process" (UI Automation). The second exists because a minimised Flow keeps
  `MainWindowHandle` non-zero forever.

## Code conventions in this repo

- neostandard lint (2-space, semicolons, single quotes); `.editorconfig` matches.
- Every file starts with a comment naming the file.
- Prefer readability over cleverness; this is a plugin people read to learn from.
