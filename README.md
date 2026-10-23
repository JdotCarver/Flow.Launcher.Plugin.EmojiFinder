# Emoji finder

Enhance [Flow Launcher](https://www.flowlauncher.com/) with this minimal and efficient emoji finder.

Press <kbd>E</kbd>, type what you are looking for, and get it copied to the clipboard.

![Introduction animation](img/introduction.gif)

## Installation

1. Open Flow Launcher
2. Type `Settings`
3. Open the *Plugin Store*
4. Search for `Emoji Finder`
5. Install

## Usage

1. Open Flow Launcher
2. Type <kbd>E</kbd> + <kbd>Space</kbd> and describe the emoji you are looking for
3. Select it and press <kbd>Enter</kbd>
4. It is now copied in your clipboard. Paste it wherever you need it.

## Configuration
You can change the action keyword in the plugins settings menu.

You can also enable or disable system notifications from the same menu, and choose how
many emoji a query returns. Matching is fuzzy, so a broad query ("e *a*") can match
almost the whole emoji table; every extra result is work for Flow Launcher before the
list can appear. The default, 25, is about two screens and keeps the list instant.

## Building from source

```bash
npm ci
npm run package -- --install
```

This compiles the plugin and copies a ready-to-run folder into your Flow Launcher
plugins folder. Note that Flow Launcher runs `dist/main.js`, which does not exist in a
fresh checkout: copying the repository into the plugins folder is not enough, and a
plugin whose manifest points at a missing file is silently ignored. See
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for paths, portable installs, and how to
read the launcher's log.

## Resources

Emoji icons are taken from https://github.com/iamcal/emoji-data
