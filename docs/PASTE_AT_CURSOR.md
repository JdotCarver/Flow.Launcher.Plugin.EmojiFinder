# Paste at the cursor: the decision log

This document is the *history* of one feature: how "press Enter, get the emoji where your
cursor is" was made to work, including the approaches that failed and the measurements that
ruled them out. The current design lives in `docs/PASTE_AGENT.md`; read that first if you only
want to know how it works today.

Keeping this record matters because every failed approach here looked *plausible*. Without the
measurements, the next person will try at least two of them again.

## 1. The copy half (shipped, unchanged)

Pressing Enter used to start a second node process just to put text on the clipboard. Flow
Launcher has a faster path: print a `Flow.Launcher.CopyToClipboard` request on stdout and Flow
performs the copy in-process, in an STA thread, with retries. No process start, no clipboard
race, unicode-safe.

All three arguments are required - `CopyToClipboard(string text, bool directCopy, bool
showDefaultNotification)`. Flow resolves `Flow.Launcher.*` methods by exact parameter types, and
C# optional parameters are invisible to that lookup.

That is why copy feels instant and why paste starts from a correctly filled clipboard.

## 2. Why paste is genuinely hard

Three facts, each verified in Flow's source or on the machine:

1. **Flow hides its window *after* the result action returns.** Anything our process types
   during the action lands in Flow's own search box.
2. **`IPublicAPI` has no key-injection or paste method.** Whatever we do, we synthesise Ctrl+V
   ourselves.
3. **Flow destroys the plugin process when the action returns.** This is the one that took a
   day to prove, and it is why five plausible designs failed in a row.

## 3. What was tried, and what the measurements said

| # | attempt | result |
|---|---|---|
| 1 | Start a PowerShell helper per paste, `detached: true` | plugin logged `paste:spawn started=true pid=…`, then the helper wrote **nothing** - not even its first line |
| 2 | Same, but capture the helper's stderr | proved the failure was silent: an empty `helper-stderr.log`, no PowerShell error |
| 3 | Same, `detached: false` (a probe compared one flag at a time) | the helper ran when its parent stayed alive: **6 trace lines vs 0** |
| 4 | Add a readiness handshake: the helper prints one line, the plugin waits for it | plugin logged `ready=true` - PowerShell really did start - and the helper was still killed with our process microseconds later |
| 5 | `cmd /c start`, Explorer-launched shortcut, direct spawn | all die with the job that started them |
| 6 | **Resident agent** (what shipped) | `decision paste=True elapsedMs=25`, `sendkeys sent` |

The two lessons worth keeping:

- **`detached: true` is not "survives the parent" on Windows.** libuv turns it into
  `DETACHED_PROCESS`; PowerShell gets no console, starts, exits with code 0 and executes none of
  the script. It is worse than useless for this purpose.
- **A launcher that owns a job object takes its children down.** A CI job, an installer, a
  terminal - anything that starts a process and exits can take the helper with it. The only
  process that reliably outlives that is one that is already running (a resident agent), or one
  started by something that never exits (Task Scheduler, Explorer, the Startup folder).

## 4. Why a PowerShell agent, and what it costs

A compiled helper or a `cscript` shim would start faster, but neither removes the fundamental
problem: the injector must be *resident*, and a resident process is a resident process whatever
language it is written in. PowerShell costs one hidden process of roughly 40-60 MB and no build
step, no installer, and no unsigned binary for antivirus to flag.

The injector's limits are unchanged and worth stating plainly:

- **Elevated windows.** A non-elevated process cannot send input to an elevated one. UIPI blocks
  it; this is a Windows security boundary, not a bug.
- **Fullscreen exclusive apps** (some games) ignore synthetic input.
- **Applications that paste with Ctrl+Shift+V** (some terminals) will paste whatever plain
  Ctrl+V means for them, not necessarily what the user expected.
- **Remote sessions** may or may not forward synthetic input, depending on the client.

## 5. The encoding trap (the last bug, and the sneakiest)

With the agent running, every request arrived, was logged, and ended in `decision paste=False`
while the clipboard held exactly the right emoji. The agent logged the code points it had read:

```
request sequence=… emoji=[🧪] targetCodes=[240,376,167,170]
```

240, 376, 167, 170 are the **UTF-8 bytes** of 🧪 read as Windows-1252. Windows PowerShell 5.1
reads files with the ANSI code page unless told otherwise, so the emoji was destroyed on the way
in and could never match the clipboard. The fix is explicit `.NET` reads and writes with
`[System.Text.Encoding]::UTF8`, and never `Get-Content`/`Add-Content`/`Set-Content`, whose
defaults differ between PowerShell 5.1 and PowerShell 7.

Two tests now hold that line: one asserts the script uses explicit encodings, and
`npm run check:paste-agent` round-trips a real emoji through the request file under **both**
PowerShell hosts and compares code points.

## 6. Where the code is

- `src/utils/pasteAgent.ts` - the agent script, the request/heartbeat protocol, liveness.
- `src/actions/paste.ts` - asks Flow to copy, then publishes a request. Starts nothing.
- `tools/paste-agent.mjs` - start/stop/status and the Startup entry.
- `tools/check-paste-agent.mjs` - the Windows experiment, per PowerShell host.
- `docs/PASTE_AGENT.md` - what running the agent means for the user.
