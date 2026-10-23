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
- Benchmarks live in `tools/bench.mjs`; methodology and results in `docs/PERF_ANALYSIS.md`.

## Java/TS conventions in this repo

- neostandard lint (2-space, semicolons, single quotes); `.editorconfig` matches.
- Every file starts with a comment naming the file.
- Prefer readability over cleverness; this is a plugin people read to learn from.
