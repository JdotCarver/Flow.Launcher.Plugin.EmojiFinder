# Paste at the cursor, with a resident helper

Status: implemented and working on the maintainer's machine (2026-10-23).
Supersedes the spawn-per-paste design in `docs/PASTE_AT_CURSOR.md` §1–§7.

Two things cost the most time in getting here, and both are recorded below because they will
look like "the fix did nothing" to the next person who hits them:

- **Windows PowerShell 5.1 reads files as ANSI unless told otherwise.** The request file is
  UTF-8, so every emoji arrived as its own four bytes (measured: `240,376,167,170` for 🧪) and
  could never match the clipboard. Every paste ended in `decision paste=False` while the
  clipboard held exactly the right emoji.
- **A resident process keeps its script in memory.** Rebuilding the plugin does not change
  what the running agent executes, so the installer stops and restarts it, and `doctor`
  reports whether the script on disk is the current one.

## What we learned, in one paragraph

Every attempt to start a helper from inside the plugin failed on the real machine, and the
trace says why: the helper is a child of a process that Flow Launcher destroys the moment an
action returns. The plugin logs `paste:spawn started=true pid=… ready=true` - PowerShell
really did start and print its first line - and then the helper writes nothing at all,
because it is killed before its second statement. `detached`, `unref`, waiting for a ready
line, `cmd /c start`: none of it helps, because the whole tree goes.

WhisperWriter and Espanso do not have this problem, and not because they are cleverer about
spawning: they are **resident**. A process that is already running when the user presses
Enter cannot be killed by the launcher that is exiting.

So the helper stops being a child and becomes a resident agent.

## What runs on the machine

| | |
|---|---|
| Process | `powershell.exe` (or `pwsh.exe`) `-NoProfile -File paste-agent.ps1`, started through `paste-agent-launcher.vbs` |
| Window | none: `wscript.exe` starts the host with window style 0, so nothing is ever drawn |
| Owner | the logged-in user, same desktop session as Flow Launcher |
| When | from login until logout, started by a shortcut in the user's Startup folder |
| Memory | roughly 40–60 MB (that is the PowerShell host's floor, not our code) |
| Idle CPU | one file-timestamp check every 50 ms, well under 1 % of one core |
| Visible | nothing: no window, no tray icon, no notification |
| Network | none, ever |
| Files | a request file and a heartbeat file, both in `%LOCALAPPDATA%` |

This is the cost that has to be stated plainly: **using the paste setting means a background
PowerShell process is always running.** For someone who does not want that, the copy setting
stays the default and starts nothing.

## The protocol

There is no socket, no named pipe, no port. Two files in
`%LOCALAPPDATA%\Flow.Launcher.Plugin.EmojiFinder\`:

- `request.json` - written by the plugin, `{ "emoji": "👍", "sequence": 17 }`. The `sequence`
  number is what the agent watches: the same emoji twice in a row is still two pastes.
- `heartbeat.txt` - written by the agent roughly once a second. The plugin reads it to know
  whether the agent is alive, and traces a clear message when it is not.

Per paste:

```
user presses Enter on a result
  plugin  -> asks Flow to copy the emoji (in-process, unicode-safe, unchanged from today)
          -> writes request.json with the next sequence number
          -> exits. Nothing is started, nothing can be killed.
agent   -> notices the new sequence within 50 ms
          -> waits until Flow is out of the way (same two signals as today: no visible Flow
             window, or focus belongs to a non-Flow process)
          -> checks the clipboard really holds the emoji (ignoring FE0E/FE0F/200D)
          -> sends Ctrl+V, then goes back to waiting
```

Because the agent is already running, the per-paste cost is one poll interval plus Ctrl+V,
not the 300–450 ms that starting PowerShell costs. Paste should feel instant, and it is
faster than the design we were trying to rescue.

## Why a file and not a pipe

A request file survives either side restarting, cannot deadlock, needs no port, needs no
firewall exception, and is readable in a trace when something goes wrong. The sequence
number makes it idempotent: the agent remembers the last number it handled, so a restart
never replays an old paste.

## How it is started (and what the user sees)

The agent is started by a two-line VBScript launcher (`paste-agent-launcher.vbs`, written next
to the agent script). `wscript.exe` has no console of its own, and `WshShell.Run(..., 0, False)`
asks Windows for no window at all, so **no window is ever shown** - not at login, not on the
first paste, not on a manual start. Starting PowerShell directly instead allocates a console and
hides it a moment later, which is visible as a black flash; that is why every start path goes
through the launcher.

Three things start the agent, all through that launcher:

1. **The installer** (`npm run package -- --install`), so paste works immediately.
2. **The Startup shortcut**, at login.
3. **The plugin itself**, when it notices no agent is running. It publishes the request first -
   it is destroyed the moment it returns - and the agent adopts a request younger than 15
   seconds when it starts, so the first paste after a reboot lands about a second later instead
   of silently doing nothing.

Starting it counts as one process and a file check every 50 ms; there is no window to notice.

## Why Task Scheduler starts it

A process started from the installer's shell is a child of that shell, and in a CI job (or
any launcher that owns a job object) it is killed when the job ends - which is exactly what
happened: the installer started the agent, the run finished, and every later paste found
`agentRunning: false`. `npm run agent -- --start` and the installer therefore ask **Task
Scheduler** to run the launcher for the current user (no password, no elevation, interactive
session), and delete the one-shot task immediately afterwards. Launching the Startup shortcut
through Explorer was tried first and worked intermittently, so it is gone.

## Which PowerShell it runs on

Every Windows 10 and 11 machine has Windows PowerShell 5.1 (`powershell.exe`). PowerShell 7
(`pwsh.exe`) is a separate, optional install on either OS. Both are supported; the agent does
not care which one hosts it.

- **Discovery order**: `pwsh.exe` if it is on `PATH`, otherwise `powershell.exe`, which is
  present everywhere. `npm run agent -- --status` prints the host and version it found.
- **Override**: `--host pwsh` / `--host powershell`, or the `EMOJI_PASTE_AGENT_HOST`
  environment variable. The Startup shortcut, the scheduled task and a direct start all use
  the same resolved host, and `--status` reports it.
- **Why the agent is host-neutral by construction**: file I/O never goes through
  `Get-Content`/`Set-Content`, whose default encoding differs between the two hosts (5.1 uses
  the ANSI code page, 7 uses UTF-8). Every read and write is `[System.IO.File]` with an
  explicit `UTF8Encoding($false)`, so the code points survive under either host.
- **Isolated from the user**: `npm run check:paste-agent` runs everything in a temporary folder
  of its own (`EMOJI_PASTE_AGENT_DIRECTORY`), so a Windows run never stops the agent the user is
  relying on. It used to, and that read exactly like an intermittent paste bug.
- **Proof, not assumption**: `npm run check:paste-agent` runs the whole experiment once per
  host - `powershell.exe` always, `pwsh.exe` only when it is installed - and asserts that the
  emoji's code points survive the request file, that the agent decides to paste, that it stays
  alive, and that it stops when killed. CI runs it on the Windows runner.

## Installing, starting, stopping

- `npm run package -- --install` creates the Startup shortcut and starts the agent
  immediately, so paste works without waiting for a logout.
- `npm run agent -- --stop` (and `--status`) stop or inspect it; the agent also exits on
  logout, like any normal process.
- Uninstalling the plugin means deleting the plugin folder and the agent's data folder
  (`%LOCALAPPDATA%\Flow.Launcher.Plugin.EmojiFinder`, which holds the script, the launcher and
  the logs) and the Startup shortcut (named `Flow Launcher Emoji Finder paste agent.lnk`). This is listed in
  the plugin's settings page and in the PR description, because a leftover Startup entry
  would be a real annoyance.
- The agent refuses to run twice: it takes a lock file with its own pid and exits if another
  live agent owns it.

## What can still go wrong, and what the user sees

| failure | what happens | what the user sees |
|---|---|---|
| agent not running (e.g. installed before this change) | plugin writes the request anyway and traces `paste:agent-missing` | settings hint: "Restart Flow Launcher once so the paste agent can start", nothing is typed |
| clipboard did not actually receive the emoji | agent waits out its timeout and does nothing (never pastes the wrong thing) | the emoji is on the clipboard; nothing typed. Traced with the clipboard's code points |
| target app refuses Ctrl+V | nothing | nothing. Traced; Ctrl+Shift+V apps are documented as unsupported |
| user logs out | agent stops; next login restarts it from Startup | nothing until next login |

The rule from today stays: **when in doubt, do nothing**. A wrong paste is worse than no
paste.

## What this changes in the code

- `src/utils/pasteAgent.ts` builds the agent script, writes it to `%LOCALAPPDATA%`, and owns
  the request/heartbeat paths. The PowerShell decision logic (two focus signals, clipboard
  comparison, timeouts) came across almost unchanged from the old per-paste helper.
- `src/actions/paste.ts` writes the request. No process is started, so the action returns in
  about the time it takes to write a small file.
- `tools/package.mjs` gains the Startup shortcut and starts the agent; `tools/agent.mjs`
  provides `--status` / `--stop` / `--start` for humans and for CI.
- `tools/check-paste-agent.mjs` starts (or reuses) the agent, writes a request, and checks
  that it (a) publishes a heartbeat, (b) sees the request, (c) refuses to paste while the
  clipboard does not match, (d) survives the request, (e) can be stopped. That much is
  testable on the Windows runner without a human in front of the screen.
- Tests: script generation, request file format, sequence handling, heartbeat freshness, and
  the "agent missing" path - all pure functions, runnable on Linux.

## What we deliberately do not do

- No service, no scheduled task, no admin rights. A Startup shortcut is enough and can be
  removed by hand.
- No network, no telemetry, no auto-update.
- No `ep` keyword, no new setting beyond the existing paste/copy choice.
- No global keyboard hook: the agent never watches what the user types.
