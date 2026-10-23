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
npm run check:paste-agent          # start it, request a paste, verify it refuses
```

When paste at cursor is the suspect, there is a cheaper experiment first that has nothing
to do with Flow Launcher:

```bash
npm run paste:selftest                # then click into Notepad during the countdown
```

It copies an emoji, counts down, sends Ctrl+V, and writes `dogfood/selftest.log`. If the
emoji does not appear in Notepad, the injection mechanism does not work on that machine
and no amount of plugin timing work will help: the answer is a different injector (see
docs/PASTE_AT_CURSOR.md §2).

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
| `npm run paste:selftest` | Does this machine paste an emoji into Notepad at all, with Flow Launcher out of the picture? |
| tracing (`--trace`) | What did the plugin actually do, in order: which method Flow called, whether the helper spawned, every state transition while waiting, which condition stayed false, whether `SendKeys` was called, and any exception. |
| `npm run dogfood:check` | Both of the above, turned into findings and a verdict, in the order the paste path can fail. |

`npm run diagnose` flashes a small window with a text box. That is the `SendKeys`
self-test typing `abc` into it, which needs a real window to type into.

## What gets written, and where

| File | Written by | Committed? |
|---|---|---|
| `dogfood/diagnose.json` | `npm run diagnose` (on your machine) | yes |
| `dogfood/runtime.log` | the plugin, only when `trace.on` exists next to `plugin.json` | yes |
| `dogfood/selftest.log` | `npm run paste:selftest` | yes |
| `dogfood/diagnose-linux.json` | `npm run diagnose` in the sandbox | no (gitignored) |
| `dogfood/windows-probe.json` | the PowerShell probe's raw report | no (gitignored) |

`npm run diagnose` only ever writes `diagnose.json` on Windows. In the Linux sandbox it
writes `diagnose-linux.json` instead, so a sandbox run cannot destroy the committed
Windows evidence. (That happened once, on 2026-10-23.)

Inside the *installed* plugin folder, `npm run package -- --trace` puts `trace.on` beside
`plugin.json`. Copy the resulting `dogfood/runtime.log` back into the repository's
`dogfood/` folder before committing (they are different folders).

Tracing is off in every normal install. It costs one file append per action, never on the
query path.

## Reading a trace yourself

`dogfood/runtime.log` is JSON Lines for plugin lines and plain text for helper lines:

```
{"at":"...","event":"method","method":"paste","parameters":["🙈"]}
{"at":"...","event":"paste:spawn","emoji":"🙈","started":true,"pid":12345}
2026-10-23T... | helper | start pid=4567 ps=5.1 apartment=STA policy=Restricted user=you
2026-10-23T... | helper | poll flowProcesses=1 flowVisible=True flowHasFocus=True focusedProcess=1234 clipboardMatches=True ...
2026-10-23T... | helper | decision paste=false elapsedMs=2500
2026-10-23T... | helper | exit
```

That example says: Flow kept the focus and a visible window for 2.5 s, so the helper
refused to type. That is a real failure mode, and exactly the kind of thing that used to
be invisible.

## Interpreting the five ways paste can fail

1. **`paste:skipped`** — Flow sent an empty emoji. Look at the query payload.
2. **no `paste:spawn` line** — Flow is still calling `copy`: the installed plugin is not
   the one you packaged, or the setting is not on paste.
3. **`started:false`** — the helper could not be spawned (platform guard, or a message
   naming the reason).
4. **`started:true` then no `| helper |` line** — PowerShell died before its first
   statement: execution policy, antivirus, or something in the command line.
5. **a `decision paste=false`** — read the last `poll` line: it names which of
   `flowVisible`, `flowHasFocus`, `clipboardMatches` blocked the paste.

`npm run dogfood:check` does this reading for you and prints the matching explanation.
