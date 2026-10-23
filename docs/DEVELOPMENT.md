# Building and running your own copy

## Why the plugin disappears from Flow Launcher

Flow Launcher does not run this repository. It runs `dist/main.js` inside a plugin
folder, and it **skips any folder whose `plugin.json` points at a file that does not
exist** — no error in the UI, the plugin is simply not registered:

```
PluginConfig.GetPluginMetadata()
  if (!File.Exists(metadata.ExecuteFilePath)) { log error; return null; }
```

A fresh checkout has no `dist/` (it is gitignored) and no production `node_modules`
(the emoji data is read from `node_modules/emojilib/` at runtime). Copying the source
files into the plugins folder therefore always makes the plugin vanish.

Check the log if you want to see it happen:
`%APPDATA%\FlowLauncher\Logs\` (or `<Flow folder>\UserData\Logs\` in portable mode)
— it contains `Execute file path didn't exist ... for config ...`.

## The one command you actually need

```bash
npm ci                 # once, and again after package.json changes
npm run package        # builds dist/ and assembles artifacts/Flow.Launcher.Plugin.EmojiFinder/
```

Then either:

- copy `artifacts/Flow.Launcher.Plugin.EmojiFinder/` into your plugins folder, or
- run `npm run package -- --install`, which does the copy for you on Windows.

Restart Flow Launcher afterwards: quit it from the tray icon (a reload does not always
pick up a changed manifest).

The packaged folder contains exactly what Flow needs, and nothing else:

| Path | Why |
|---|---|
| `plugin.json` | the manifest Flow reads to find the plugin |
| `package.json` | declares `"type": "module"`, without it Node refuses the ESM output |
| `dist/` | compiled JavaScript, what `ExecuteFileName` points at |
| `node_modules/` | production dependencies only (`emojilib`, `clipboardy`, …) |
| `icons/`, `img/` | result icons and the plugin icon |
| `SettingsTemplate.yaml` | the settings page |

## Where the plugins folder is

| Install type | Path |
|---|---|
| Normal | `%APPDATA%\FlowLauncher\Plugins\` |
| Portable | `<Flow Launcher folder>\UserData\Plugins\` |

Flow scans **direct subfolders only** (`Directory.EnumerateDirectories`), one level
deep: `Plugins\YourFolder\plugin.json`. If you end up with
`Plugins\repo-name\Flow.Launcher.Plugin.EmojiFinder\plugin.json`, Flow sees nothing.

## Delete the store version first

The plugin store copy has the same plugin ID as this one. Two folders with the same ID
confuse Flow's plugin manager (one wins, the other keeps its settings but never loads).
Remove the store-installed folder before installing your build, or install *over* it.

## Runtime: Flow Launcher ships its own Node

Flow runs JavaScript plugins with the Node it downloads itself — currently
**Node 16.18.0** in `%APPDATA%\FlowLauncher\Environments\Node.js\`. Your system Node
version is irrelevant. If you use newer syntax, check it against 16:

```bash
npx -y node@16 dist/main.js '{"method":"query","parameters":["smile"],"settings":{"maxResults":"5"}}'
```

That command is also the fastest way to test a change without touching Flow Launcher:
it prints the exact JSON Flow would receive.

## Trying paste at cursor

Set **What pressing Enter does** to `paste` in the plugin settings, then put the cursor in
an editor (Notepad is the honest test), open Flow with `e`, type a query and press Enter.
The emoji should appear where the cursor was, roughly 300–500 ms later.

If nothing happens:

1. **Is the target window running as administrator?** Windows silently blocks synthetic
   input from non-elevated processes to elevated ones. Notepad started normally is fine;
   an admin PowerShell is not.
2. **Did Flow hide?** The helper only types once Flow has no visible window. If Flow stays
   open (a pinned preview, a dialog), it gives up after 2 seconds instead of pasting into
   your query.
3. **Try copy mode first** with notifications off; if that works, the action is reaching
   Flow and the problem is only in the paste helper.

The helper cannot be run from this repository's tests (no Windows, no PowerShell), so the
script itself is reviewed in `src/utils/pasteHelper.ts` and its generated output is
asserted in `tests/utils/pasteHelper.test.ts`.

## Everyday loop

```bash
npm test               # vitest, runs against src/
npm run lint
npm run benchmark      # end-to-end timing, see docs/PERF_ANALYSIS.md
npm run package -- --install
```

`npm test` does not need a build. `npm run package` compiles first, and the packaging
script itself refuses to package a `dist/` older than `src/`, so a stale build cannot
reach Flow Launcher by accident.
