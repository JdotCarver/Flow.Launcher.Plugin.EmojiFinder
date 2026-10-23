# Dependencies and audits

## The short version

`npm install` printing **25 vulnerabilities (3 moderate, 20 high, 2 critical)** was real,
but it measured the wrong thing: every single one was in **development tooling**
(vitest → vite → rollup/postcss/picomatch/tinypool, plus the eslint → minimatch chain).
None of it ships to a user.

```
npm audit --omit=dev   ->  found 0 vulnerabilities
```

What a user installs is `dist/` plus the production `node_modules`, and that set was
already clean. The real risk was to the *developer's* machine — the two criticals were
tinypool/vitest advisories about prototype pollution leading to RCE in worker options,
which is an attack surface of a test runner, not of an emoji picker.

Still worth fixing, because "run npm install and get 25 scary lines" is how people learn
to ignore audit output.

## What was done

| Change | Effect |
|---|---|
| `npm audit fix` | 25 → 4, all within existing semver ranges except vitest |
| `vitest` 3.2.4 → 5.0.5 | clears the tinypool + `@vitest/mocker` criticals/moderates |
| `brace-expansion` (eslint → minimatch chain) | resolved by the same lockfile refresh |
| CI: `npm audit --omit=dev --audit-level=moderate` | **blocks** the build if a shipped dependency has an advisory |
| CI: `npm audit --audit-level=high` | reports dev-only advisories, does not block (`continue-on-error`) |
| Dependabot (weekly, grouped) | updates arrive as one reviewable PR per group |

Result: `npm audit` → **0 vulnerabilities**, 62 tests, lint and build still green.

## Why two audit steps

- **Production audit must fail the build.** A vulnerable dependency that runs on a
  user's machine is a release blocker.
- **Development audit must not.** A test-runner advisory cannot reach a user, and
  blocking every release on a fresh transitive advisory in the linter's glob library
  would train everyone to bypass CI. It is reported, so it can be scheduled.

## Keep the dependency surface small

Every production dependency is code that runs on a user's machine and a prebuilt binary
in the release zip. The copy redesign (see `docs/PASTE_AT_CURSOR.md`) removes
`clipboardy` from `dependencies`, which also removes `execa`, `is-wsl`, `is64bit`,
`is-inside-container`, `cross-spawn` and friends — **17 packages and two unsigned
native `.exe` files** (`clipboard_x86_64.exe`, `clipboard_i686.exe`) that currently ship
inside the plugin. Fewer dependencies is the only audit that never needs a patch.

Check before adding one: `npm view <package> dependencies` and ask whether the platform
already does it (Flow Launcher's `IPublicAPI` covers clipboard, notifications, shell).

## Local commands

```bash
npm audit                 # everything, dev included
npm audit --omit=dev      # what users actually run
npm outdated              # what is behind
```
