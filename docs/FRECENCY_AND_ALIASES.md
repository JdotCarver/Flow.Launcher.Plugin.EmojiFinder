# Frecency and aliases: proposed shape

Status: **draft for discussion.** Nothing here is implemented. Two features the maintainer asked
for after paste-at-cursor shipped: ranking that learns from what is actually picked, and
user-defined aliases that feed the same ranking.

Both touch `find()`, the hot path that runs once per keystroke, and both need state that
survives a restart. That is the whole reason this document exists: where the state lives is an
architecture decision, not a detail.

## What already exists

- `find()` (`src/utils/find.ts`) scans emojilib's keyword table, scores each emoji, sorts, and
  returns the first `maxResults`. Measured: 0.13-1.57 ms after the rewrite, 48-55 ms total
  end-to-end with an empty or single-letter query.
- Settings arrive with every query (`src/utils/settings.ts`), declared in `SettingsTemplate.yaml`
  as a checkbox, a dropdown and another dropdown. Values are strings or booleans.
- The paste agent already owns a small, proven file protocol (atomic write, per-user folder,
  capped log). Reusing its conventions costs nothing new.
- Picking a result is free today in the fastest configuration: Flow copies in-process and never
  starts our plugin. **Recording a pick costs a plugin process (~23 ms of Node boot).** That is
  the one place frecency touches something we optimised away.

## Where the state lives

The maintainer's answer: **Flow Launcher's plugin settings folder.** For an installed Flow that
is `%APPDATA%\FlowLauncher\Settings\Plugins\<plugin ID>\`; for a portable Flow it is
`<Flow folder>\UserData\Settings\Plugins\<plugin ID>\`.

Neither path can be assumed, but both are reachable the same way: the plugin knows its own
folder (it is running from `<...>\Plugins\<folder name>\dist\main.js`), and
`Settings\Plugins\<ID>` is always a sibling of that `Plugins` folder. So:

```
walk up from the plugin folder until the folder is named "Plugins"
  -> <root>\Plugins\<folder>          (us)
  -> <root>\Settings\Plugins\<ID>\    (our data)
```

That works for installed and portable without asking the user which one they have, and it never
looks at where Flow Launcher is installed - the same rule the paste agent already follows.

Files, both written atomically (temporary file + rename, like `request.json`):

| file | contents |
|---|---|
| `usage.json` | `{ "🙈": { "count": 3, "lastUsedAt": 1792757171938 }, ... }`, capped |
| `aliases.json` | `{ "shipit": "🚀", "shrug": "🤷" }` |

Corrupt or unreadable files mean "no history" and "no aliases", never a broken query: the same
rule `settings.ts` already follows for bad settings.

## Frecency

**Ranking**, inside `find()`, after the existing match score:

```
finalScore = matchScore + frecencyBoost(emoji)
frecencyBoost = 6 × decay(lastUsedAt) × frequency(count)
  decay     = 2^(-ageInDays / 14)          // half-life of two weeks
  frequency = log2(1 + count) / log2(1 + 20)
```

The ceiling of 6 is deliberate: the existing scoring gives +5 for a keyword part that is exactly
what the user typed, and doubles the name's contribution. So a favourite can climb past a loose
partial match, and can never outrank an exact hit on what the user actually typed. Frecency
should feel like memory, not like a second search engine.

**Empty query.** Today an empty query matches everything and returns the head of the table. With
frecency it returns the most-used-and-recent emoji first, then the usual order for anything not
in the history. Nothing is removed, so the list is never empty on a fresh install.

**Recording a pick.** Only our own action can record it, so when frecency is enabled every pick
runs through the plugin instead of the in-process `Flow.Launcher.CopyToClipboard` shortcut. Cost:
one Node process per Enter, ~23 ms, plus one small file write. Not on the keystroke path.

## Aliases

**Matching.** An alias becomes an extra keyword for its emoji, ranked as if the user had typed
the emoji's own name. Typing `shipit` finds 🚀 - no prefix, no separate keyword, nothing to learn.

**Creating them.** This is the part I want an answer on, because it decides how much UI the
feature needs:

1. *File only.* `aliases.json` in the settings folder, documented in the README. Cheapest, and
   fine for the person who asked for it; hostile to everyone else.
2. *Two-step in Flow.* Type `e alias shipit`, get the emoji list, pick one: the alias is saved.
   No new UI, no new files to learn, and it uses the list the user already knows how to use.
3. *Both.* The file stays the storage format; the command is how it is normally written.

## Order of work

1. Settings folder resolution + a tiny JSON store (read, atomic write, cap) with tests.
2. Aliases matching in `find()` (no UI yet), with tests.
3. Frecency ranking + empty-query behaviour, with tests.
4. Recording, and the action routing that makes it possible.
5. Whatever alias UI we agree on.
6. Measure again: `find()` cost per keystroke, and the cost of a pick.

## Open questions

1. **Alias creation**: file only, two-step command, or both?
2. **Frecency default**: on (better ranking, one process per pick) or off (fastest copy, opt-in)?
3. **Should picking a *direct* Flow copy still count?** It cannot, without the process. So either
   frecency implies our action, or counts only paste/notification picks and is inconsistent.
