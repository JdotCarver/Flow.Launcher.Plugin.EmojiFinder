# Dogfooding on Windows

Why this document exists: this plugin is developed in a Linux sandbox. Three things it
depends on **cannot be exercised there at all**:

- PowerShell (does it start? which policy? does `-EncodedCommand` survive?),
- the Windows clipboard (`Clipboard.GetText()` on an emoji),
- synthetic input (`SendKeys`) and window focus.

Unit tests can only prove the *script we generate* is what we meant. Whether Windows
honours it is a fact only your machine has. So the plugin writes that fact down.

## The loop

```bash
npm run package -- --install --trace  # 1. install WITH tracing
# 2. restart Flow Launcher, reproduce the problem (try to paste an emoji)
npm run diagnose                      # 3. collects the trace AND probes the environment
npm run dogfood:check                 # 4. read the verdict
git add dogfood && git commit -m "dogfood: <what happened>"
```

Paste at the cursor is served by a resident agent instead of a per-paste process (see
`docs/PASTE_AGENT.md`). Its controls:

```bash
npm run agent -- --status          # is it running?
npm run agent -- --start           # start it (the installer does this too)
npm run agent -- --stop
npm run agent -- --install-startup # come back at login
npm run check:paste-agent          # per PowerShell host: request an emoji, verify it survives
```

When paste at cursor is the suspect, there is a cheaper experiment first that has nothing
to do with Flow Launcher:

```bash
npm run paste:selftest                # then click into Notepad during the countdown
```

It puts an emoji on the clipboard through the same request file the plugin uses, waits for
the agent to read it, and writes `dogfood/selftest.json`. If the emoji does not appear in
Notepad the agent is not doing its job on that machine, and no amount of plugin timing work
will help. If the report says the agent was not running, start it first
(`npm run agent -- --start`).

`npm run diagnose` also copies the installed plugin's trace back into the repository's
`dogfood/` folder, so step 3 is the only step you need to remember beyond the packaging.

Commit `dogfood/`. The next session reads it and stops guessing.

## When someone else runs the checks for you

The maintainer's Windows machine is also a self-hosted GitHub Actions runner
(`docs/WINDOWS_RUNNER.md`). Put `[windows]` anywhere in the commit message and that commit
runs the same checks on real Windows: lint, tests, build, `check:paste-agent` (starts
the agent and exercises the request protocol), `doctor` and `diagnose`.

Reading the results back is the awkward part. Actions logs and artifacts are served from
`results-receiver.actions.githubusercontent.com` and Azure blob storage, which an agent
sandbox cannot reach. Two channels work instead:

1. **A report branch.** The job copies `dogfood/` to the `dogfood-reports` branch
   (`git fetch origin refs/heads/dogfood-reports:refs/remotes/origin/dogfood-reports`), so
   every run's evidence is one `git show` away.
2. **Annotations.** Tool output can emit `::notice title=…::…` lines; those are served by
   `api.github.com` (`repos/{owner}/{repo}/check-runs/{job_id}/annotations`), so a run that
   cannot publish still explains itself.

Add `[install]` to a commit message as well and the job installs the freshly built plugin
into Flow Launcher with tracing on - useful when a fix has to be *tried* on the real
machine, not just built.

## What each piece gives you

| Piece | Answers |
|---|---|
| `npm run diagnose` | Does PowerShell start, and how fast? Does `System.Windows.Forms` load? Does the clipboard give back the emoji exactly? Does `SendKeys` deliver a keystroke at all? What are Flow's processes called and do they have a visible window? What is focused right now? Is the installed plugin the build we just packaged, and is tracing on in it? |
| `npm run paste:selftest` | Does the agent paste into the window you focus, with Flow Launcher out of the picture? |
| tracing (`--trace`) | What the plugin actually did: which method Flow called, whether it saw a running agent, and for which emoji. The agent's own log covers the rest. |
| `npm run dogfood:check` | Both of the above, turned into findings and a verdict, in the order the paste path can fail. |

`npm run diagnose` flashes a small window with a text box. That is the `SendKeys`
self-test typing `abc` into it, which needs a real window to type into.

## What gets written, and where

| File | Written by | Committed? |
|---|---|---|
| `dogfood/diagnose.json` | `npm run diagnose` (on your machine) | yes |
| `dogfood/runtime.log` | the plugin, only when `trace.on` exists next to `plugin.json` | yes |
| `dogfood/agent.log` | the paste agent, *always* (copied back by `npm run diagnose`) | yes |
| `dogfood/selftest.json` | `npm run paste:selftest` | yes |
| `dogfood/diagnose-linux.json` | `npm run diagnose` in the sandbox | no (gitignored) |
| `dogfood/paste-agent-check.json` | `npm run check:paste-agent` | no (gitignored) |

`npm run diagnose` only ever writes `diagnose.json` on Windows. In the Linux sandbox it
writes `diagnose-linux.json` instead, so a sandbox run cannot destroy the committed
Windows evidence. (That happened once, on 2026-10-23.)

Inside the *installed* plugin folder, `npm run package -- --trace` puts `trace.on` beside
`plugin.json`. Copy the resulting `dogfood/runtime.log` back into the repository's
`dogfood/` folder before committing (they are different folders).

Tracing is off in every normal install. It costs one file append per action, never on the
query path.

## Reading a trace yourself

There are two processes, so there are two logs.

`dogfood/runtime.log` is the plugin's own trace, JSON Lines:

```
{"at":"...","event":"method","method":"paste","parameters":["🙈"]}
{"at":"...","event":"paste:request","emoji":"🙈","sequence":1792755460200,"agentRunning":true}
```

`dogfood/agent.log` is the resident agent's log, plain text:

```
2026-10-23T... | agent | start pid=38876 host=powershell ps=5.1.19041.6456 edition=Desktop
2026-10-23T... | agent | request sequence=1792755460200 emoji=[🙈] targetCodes=[55357,56935]
2026-10-23T... | agent | poll flowProcesses=1 flowVisible=False flowHasFocus=False clipboardMatches=True ...
2026-10-23T... | agent | decision paste=True elapsedMs=25
2026-10-23T... | agent | sendkeys sent
```

That pair says: the plugin published a request while an agent was alive, the agent read the
emoji with the right code points, everything matched, and Ctrl+V was sent 25 ms later.

## Interpreting the ways paste can fail

1. **`paste:skipped`** — Flow sent an empty emoji. Look at the query payload.
2. **no `paste:request` line** — Flow is still calling `copy`: the installed plugin is not the
   one you packaged, or the setting is not on paste.
3. **`agentRunning:false`** — the plugin asked, but no agent was running. Start it with
   `npm run agent -- --start`; the Startup shortcut brings it back at login.
4. **`targetCodes` that look like several small numbers** — the emoji was read with the wrong
   encoding (its UTF-8 bytes). See §5 of `docs/PASTE_AT_CURSOR.md`.
5. **`decision paste=false`** — read the last `poll` line: it names which of `flowVisible`,
   `flowHasFocus`, `clipboardMatches` blocked the paste.
6. **`sendkeys sent` and still nothing** — the keystroke went somewhere else: an elevated
   window, a fullscreen app, or focus that did not return to your editor.

`npm run dogfood:check` does this reading for you and prints the matching explanation.
