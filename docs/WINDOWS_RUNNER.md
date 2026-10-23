# Running this project's checks on your own Windows machine

A GitHub **self-hosted runner** lets an agent start a job on your PC from the sandbox,
then read the result through GitHub. It closes the gap that has been slowing us down:
the agent can build, lint and unit-test anywhere, but only your machine has PowerShell,
the Windows clipboard, SendKeys, window focus, and Flow Launcher itself.

GitHub's own instructions (Settings → Actions → Runners → New self-hosted runner →
Windows) are correct. Follow them; this document only adds what they leave out, and what
the agent needs.

## Setup, in order

1. **Create the folder under the drive root**, as GitHub says:

   ```powershell
   mkdir C:\actions-runner; cd C:\actions-runner
   ```

   Deep paths under `Documents` cause long-path and permission problems later.

2. **Download, verify and extract** exactly as GitHub's page shows.

3. **Configure, adding one label**:

   ```powershell
   .\config.cmd --url https://github.com/JdotCarver/Flow.Launcher.Plugin.EmojiFinder --token <TOKEN> --labels flowlauncher
   ```

   `flowlauncher` is what the workflow asks for (`runs-on: [self-hosted, Windows, X64,
   flowlauncher]`). `self-hosted`, `Windows` and `X64` are added automatically.
   Accept the default work folder when asked.

   > The token is a **registration token**: it is single-use, expires within an hour, and
   > anyone holding it can register a runner on your repository. Never paste it into a
   > chat, an issue or a commit. If it leaks, delete the runner in Settings and re-add it.
   > Nothing in this repository ever needs it.

4. **Start it interactively**:

   ```powershell
   .\run.cmd
   ```

   Leave that window open. **Do not install it as a Windows service.** A service runs in
   session 0 with no desktop, where the clipboard and SendKeys behave differently or fail
   outright — you would get false failures that look like real bugs.

5. In the repository: **Actions → windows-dogfood → Run workflow**.

## What the agent does with it

```bash
gh workflow run windows-dogfood.yml          # start it
gh run list --workflow windows-dogfood.yml   # find the run
gh run watch <id>                            # live progress
gh run view <id> --log                       # full log
gh run download <id> -n dogfood              # the reports
```

That is the whole loop: no copy-paste from you, and the log is readable from the sandbox.

## What the job runs

| Step | Purpose |
|---|---|
| `npm ci`, lint, test, build | the checks that already run on Linux, on your machine |
| `npm run doctor` | installation health: is the plugin loadable, is the installed copy current, what does Flow's log say |
| `npm run diagnose` | PowerShell, WinForms, clipboard round-trip, SendKeys self-test, Flow's windows and focus |
| upload `dogfood/` | the reports, downloadable as one artifact |

Every step after the build is `continue-on-error`, and the reports are uploaded even when
a step fails, so a run always produces evidence.

## Limitations worth knowing

- **Interactive desktop required.** The SendKeys self-test needs a logged-in session. If
  you lock the screen, the job still runs, but GUI probes may report no focused window.
- **Never add `pull_request` to this workflow.** On a public repository a self-hosted
  runner would execute a stranger's pull-request code on your machine. `workflow_dispatch`
  only, which means a human or an authenticated `gh` call starts it.
- **The runner has your user's privileges.** Treat it like a terminal you left open.

## Reusing this for the Unreal work

Same mechanism, different workflow: an Unreal job needs the engine installed for the
runner's user, `runs-on: [self-hosted, Windows, X64, unreal]`, and `RunUAT.bat` or
`UnrealBuildTool.exe` invoked from the repository's build script. UnrealBuildTool itself
does not need a desktop, so those jobs can run unattended (and, unlike the GUI probes
here, survive a locked screen). Keep one runner with several labels rather than several
runners: `--labels flowlauncher,unreal`.

The pattern to remember: **anything that only exists on your machine becomes a workflow
step plus an artifact**, and the agent reads both through `gh`.
