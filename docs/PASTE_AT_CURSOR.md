# Design: instant copy, and paste at the cursor

Status: **implemented.** Decisions taken with the maintainer: PowerShell injector to
start with, a single setting for copy vs paste (no second keyword — the maintainer would
use paste all the time, so a per-use switch buys nothing), copy landed first.

Implementation notes and the parts that differ from the plan are at the bottom (§5). Numbers below are measured in this repository or
read from Flow Launcher's source; the Windows-specific latency is the one thing I cannot
measure from here, so it is called out where it matters.

---

## 1. Why Enter feels slow today

Pressing Enter runs `method: "copy"` in a *second* node process:

| Step | Cost | Where |
|---|---|---|
| Flow spawns `node dist/main.js` | ~40–80 ms (cold, Windows) | Flow |
| `import clipboardy` → `execa`, `is-wsl`, `is64bit`, `is-inside-container` | ~30–40 ms | measured |
| `execaSync(clipboard_x86_64.exe --copy)` | ~20–40 ms | native exe, unicode-safe |
| exit + Flow parses stdout | ~5 ms | Flow |

So roughly **100–150 ms** of dead time between Enter and the launcher closing, which is
exactly what you are feeling.

### The fix: let Flow do the copying

Flow intercepts any result action whose method starts with `Flow.Launcher.` and executes
it **in-process** — it never starts our plugin at all:

```csharp
// Flow.Launcher.Core/Plugin/JsonRPCPlugin.cs
if (result.JsonRPCAction.Method.StartsWith("Flow.Launcher."))
    ExecuteFlowLauncherAPI(result.JsonRPCAction.Method["Flow.Launcher.".Length..],
                           result.JsonRPCAction.Parameters);
```

`PublicAPIInstance.CopyToClipboard(string, bool directCopy, bool showDefaultNotification)`
is Unicode-safe (`Clipboard.SetText` on an STA thread, with 6 retries for a locked
clipboard), and can show Flow's own localized notification.

So the result becomes:

```json
{
  "Title": "Red Heart",
  "JsonRPCAction": {
    "method": "Flow.Launcher.CopyToClipboard",
    "parameters": ["❤️", false, true]
  }
}
```

**One catch, verified in Flow's source:** `ExecuteFlowLauncherAPI` resolves the method by
exact parameter types (`typeof(IPublicAPI).GetMethod(name, parameterTypes)`), and C#
optional parameters do not participate in that lookup. All three arguments must be sent
explicitly, or the call is silently dropped.

Consequences:

- Enter cost drops from ~100–150 ms to **0 extra work** (Flow's own code path);
- `clipboardy` leaves `dependencies` → 17 fewer packages and **two fewer unsigned native
  `.exe` files** in the release zip (`clipboard_x86_64.exe`, `clipboard_i686.exe`);
- `src/actions/copy.ts` and the whole `copy` method disappear;
- the notification becomes Flow's localized one ("Copy Text / Completed successfully")
  instead of our "❤️ — Copied to clipboard!". That is the only visible regression, and it
  is avoidable by keeping our own process — at the price of the 100 ms we just removed.
  **Decision needed.**

---

## 2. Paste at the cursor

### What Flow offers

Nothing. `IPublicAPI` (checked in full) has `CopyToClipboard`, `HideMainWindow`,
`ShowMainWindow`, `ShellRun`, `ChangeQuery`, settings and logging calls — no key
injection, no clipboard-paste-into-focused-app. So the plugin has to synthesise Ctrl+V
itself.

### The timing problem

Flow hides its window **after** the result action completes (`ExecuteResultAsync` returns
a "hide" flag, the caller hides afterwards). Anything we inject during the action lands in
Flow's own search box. So the injection must happen *after* our process has exited and
Flow has hidden — which means a detached helper that waits.

### The shape I propose

```
Enter (paste mode)
  └─ our process, method "paste"
       ├─ prints {"method":"Flow.Launcher.CopyToClipboard","parameters":[emoji,false,false]}
       │     → Flow sets the clipboard in-process, unicode-safe, no second process
       └─ spawns ONE detached helper, then exits (so Flow can hide)

helper (detached)
  ├─ wait until: foreground window is not Flow Launcher
  ├─ wait until: clipboard text === emoji   (both polls, 15 ms, 1.5 s timeout)
  ├─ send Ctrl+V
  └─ exit
```

Why poll instead of a fixed `sleep 250`: the two things we must wait for (window hidden,
clipboard written) take different, machine-dependent times. Polling typically pastes in
~80–150 ms after Enter; a fixed delay is either slow or flaky.

No notification in paste mode — it would steal focus and defeat the point.

### Choosing the injector (the real trade-off)

All three sit behind one function, `injectPaste()`, in `src/utils/paste.ts`, so swapping
later is a 10-line change. What differs is startup cost and dependency footprint:

| Option | Extra cost before the key lands | New files in release | Risk |
|---|---|---|---|
| **A. PowerShell one-shot** `powershell -NoProfile -WindowStyle Hidden -Command "…[System.Windows.Forms.SendKeys]::SendWait('^v')"` | ~250–450 ms (PS 5.1 cold start + assembly load) | none | Slowest; some locked-down machines restrict `powershell -Command` |
| **B. cscript + VBScript shim** (`WScript.Shell.SendKeys "^v"`) | ~40–90 ms | one 5-line `paste.vbs` | cscript can be blocked by policy; AV heuristics on scripted key injection |
| **C. Compiled native helper** (C# `SendInput`, ~10 KB exe) | ~5–15 ms | one binary | Needs a Windows build step; a binary in a JS plugin repo is a supply-chain wart; unsigned |

**Recommendation: start with A**, because it adds no files and no binaries, then measure
it on your machine (`node tools/measure-paste.mjs` — I would add it in the same step).
If ~300 ms feels bad, B is a small, contained upgrade behind the same interface; C only
if B is blocked by policy.

### Known limits (document honestly, not "bugs")

- Cannot inject into **elevated** windows when Flow runs unelevated (Windows UIPI
  blocks it, silently). Reversing that requires running Flow as admin, which we should
  not recommend.
- `SendKeys` uses the SendInput path, so it works in most apps including Electron ones,
  but some fullscreen/game windows ignore synthetic input.
- Clipboard is overwritten by the paste (that is also what makes re-pasting work).

### Alternative worth considering later

Instead of clipboard + Ctrl+V, inject the emoji as **Unicode key events**
(`KEYEVENTF_UNICODE`) so the user's existing clipboard is untouched. Faster and cleaner
UX, but fewer applications accept it. Keep clipboard+Ctrl+V as the default; this is a
possible setting, not a first step.

---

## 3. How the user picks copy vs paste

Flow Launcher supports **multiple action keywords** per plugin (`ActionKeywords` in
`plugin.json`; the first one is the default). Three options:

| Option | UX | Cost |
|---|---|---|
| a. Setting: "Default action: Copy / Paste at cursor" | one setting, one keystroke to change behaviour | one more setting; switching requires the settings window |
| b. Second keyword `ep` = paste, `e` = copy | paste on demand, no settings trip | one more keyword to document; `e`/`ep` prefix collision is Flow's to resolve |
| c. Both: setting picks what `e` does, `ep` always pastes | best of both | slightly more code and docs |

**Recommendation: c, implemented as a first step** (setting + keyword), because both
mechanisms are cheap and the setting alone forces a detour for a one-off paste.

---

## 4. Plan once approved

1. `query()` emits `Flow.Launcher.CopyToClipboard` results; delete `copy.ts`, the `copy`
   method, and `clipboardy`. Tests for payload shape and parameters (all three, always).
2. Settings: `defaultAction` (`copy` | `paste`) dropdown; `paste` keyword if we go with c.
3. `src/utils/paste.ts` with `injectPaste()`, option A; `tools/measure-paste.mjs` to time
   it on Windows and record the number in this document.
4. `docs/DEVELOPMENT.md`: paste limits (elevation, fullscreen), and how to switch.
5. Re-run the benchmark: Enter latency should show up as "no extra process", so
   `tools/bench.mjs` gets an action-mode row.

---

## 5. What was actually built

```
setting "What pressing Enter does": copy (default) | paste
```

| Mode | Result action | Processes started on Enter |
|---|---|---|
| copy, notifications off | `Flow.Launcher.CopyToClipboard` | none |
| copy, notifications on | `copy` (our own) | one, short-lived |
| paste | `paste` (our own) | one, short-lived + one detached PowerShell helper |

`paste` prints a `Flow.Launcher.CopyToClipboard` request first, so Flow fills the clipboard
in-process, then starts the helper and exits immediately (which is what lets Flow hide).

The helper (`src/utils/pasteHelper.ts`) is a PowerShell script run through
`-EncodedCommand` (base64 UTF-16LE), which sidesteps every quoting and code-page problem
that `-Command` has with emoji and apostrophes. It waits for both conditions below, then
sends Ctrl+V. If they never hold within 2 s it does **nothing** — pressing Ctrl+V into
Flow's search box would paste the emoji back into the query, which is worse than a missed
paste.

1. no visible Flow Launcher main window (`Get-Process -Name 'Flow.Launcher*'` and
   `MainWindowHandle -eq 0`);
2. the clipboard actually holds the emoji (`Clipboard::GetText()`), because Flow's
   in-process copy can finish a few milliseconds *after* the window hides.

### Deviation from the plan, and why

The plan used `GetForegroundWindow` through a C# snippet (`Add-Type`). That compiles at
run time, which costs several hundred milliseconds — more than the feature saves. The
`MainWindowHandle` check needs no compilation and answers the same question for our
purposes ("has Flow gone?"), so it won. If it ever proves unreliable, the P/Invoke
version behind `spawnPasteHelper` is a contained swap.

### Known limits

- **Elevated windows**: Windows blocks synthetic input from non-elevated processes to
  elevated ones, silently. Paste does nothing there; copy still works.
- **Fullscreen/game windows** sometimes ignore synthetic input.
- **Clipboard is left holding the emoji** (same as copy mode), which is what makes a
  second Ctrl+V work.
- Around **300–500 ms** between Enter and the emoji appearing, most of it PowerShell's
  own start-up. Moving to a cscript shim (~40–90 ms) or a compiled helper (~10 ms) is
  described in §2 and is one function's worth of change.

### Still open, deliberately

- A "paste without touching the clipboard" mode (Unicode key events) — see §2.
- Measuring the real Windows number: needs a run on the maintainer's machine.
