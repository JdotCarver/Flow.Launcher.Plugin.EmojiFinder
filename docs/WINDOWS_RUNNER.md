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

## Two Windows quirks that cost real time here

- **`shell: bash` does not mean Git Bash on Windows.** It resolves to
  `C:\Windows\system32\bash.exe`, which is the WSL launcher. Without a WSL distribution it
  exits instantly with no output, so the step fails with nothing in the log. Use `shell: pwsh`
  for anything on Windows.
- **The runner's PowerShell wrapper sets `$ErrorActionPreference = 'stop'`.** Native commands
  write progress to stderr, and PowerShell turns that into a terminating
  `NativeCommandError` - so `git push` can appear to fail while it actually succeeded. Capture
  output with `2>&1 | Out-String` and lower the preference while calling native tools.

## What the agent does with it

```bash
gh workflow run windows-dogfood.yml          # start it
gh run list --workflow windows-dogfood.yml   # find the run
gh run watch <id>                            # live progress
gh run view <id>                             # per-step status and annotations
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
step**, and the agent reads its result through `gh`.

## How the agent reads a run

- **Job and step status**: `gh run view <id> --json jobs`, or
  `gh api repos/{owner}/{repo}/actions/jobs/<job-id>`. Always available.
- **The log itself**: *not* available to an agent sandbox. GitHub serves logs from
  `results-receiver.actions.githubusercontent.com` and artifacts from Azure blob storage,
  and both are blocked there. `gh run view --log` and `gh run download` fail with `EOF`.
- **So the job ships its own report**: the `windows` job copy-commits `dogfood/` to the
  `dogfood-reports` branch, which is plain git and therefore reachable:

  ```bash
  git fetch origin refs/heads/dogfood-reports:refs/remotes/origin/dogfood-reports
  git show origin/dogfood-reports:doctor.json
  ```

- **Annotations** are a second, lighter channel: any `::notice title=…::…` or
  `::error title=…::…` printed by a tool shows up in
  `gh api repos/{owner}/{repo}/check-runs/<job-id>/annotations`. That is how the paste-agent
  check reports each assertion per PowerShell host, and how the publisher explains its own
  failure.
- **Shell gotcha 1**: `shell: bash` on Windows resolves `bash` from `PATH`, and the first
  thing on `PATH` is `C:\Windows\system32\bash.exe` - the **WSL** launcher, which fails
  instantly with no output when no distribution is installed. Git Bash (which
  `actions/checkout` uses) lives elsewhere. A step that fails with zero output is usually
  this: the shell never started.
- **Shell gotcha 2**: `shell: powershell` steps run with `$ErrorActionPreference = 'stop'`.
  Any native command that writes to *stderr* - `git push` progress included - then becomes
  a terminating error even though the command succeeded. Set it to `Continue` explicitly.
- **PowerShell 7 (`pwsh`) is not guaranteed** on a self-hosted Windows runner.
  `shell: powershell` (5.1) always is, and everything here works in it.
