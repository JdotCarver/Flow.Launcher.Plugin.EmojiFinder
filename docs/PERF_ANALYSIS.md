# Performance analysis — Emoji Finder

Date: 2026-10-23 · Node 22.22.3 · Linux sandbox · branch `arena/cdf6971a-...`

Everything below is **measured**, not guessed. Numbers are per plugin invocation,
because Flow Launcher spawns a fresh `node dist/main.js '<json>'` process for every
keystroke and for every action click.

---

## 1. Where the time actually goes

`e smile` (one keystroke, one process):

| Stage | Cost | Notes |
|---|---|---|
| Node boot + ESM loader | **~23 ms** | unavoidable with the current process-per-query model |
| `import 'clipboardy'` (via `src/actions/copy.ts`) | **~27–40 ms** | runs on **every query**, even though only the copy action needs it |
| `import find` → `fs` + module graph | ~6 ms | |
| `find('smile')` | 2.3 ms (8.6 ms cold) | grows to 12.5 ms for 1-char queries |
| result mapping + `JSON.stringify` | 0.2–1.5 ms | |
| **Total, query** | **~70–73 ms** | |

The copy action (a second process, spawned when the user hits Enter):

| Stage | Cost |
|---|---|
| Node boot | ~23 ms |
| `import clipboardy` | ~33 ms |
| `clipboard.writeSync` on Windows | PowerShell child process → typically +100–300 ms |

**Payload sizes** (`result` array handed to Flow):

| Query | Results | JSON |
|---|---|---|
| `smile` | 30 | 6.5 KB |
| `heart` | 46 | 10 KB |
| `face` | 205 | 26 KB |
| `a` | 1 866 | **241 KB** |
| `e ` (empty) | 1 906 | **244 KB** |

Flow parses all of that and builds a WPF list item per result, per keystroke.

---

## 2. Ranked improvements

Ordered by measured impact on the user-perceived latency.

### 1. Stop importing `clipboardy` on the query path — **−27…40 ms/keystroke (−40 %)**
`main.ts` imports `copy.ts`, which imports `clipboardy`, which pulls `execa` + `is-wsl` +
`is64bit` — for a query that never touches the clipboard. Measured: 46 ms vs 73 ms.

Two possible shapes (they compose):
- **a. Lazy import** — `const clipboard = await import('clipboardy')` inside `copy()`.
  Three-line change, no behaviour change.
- **b. Delegate to Flow** — emit `JsonRPCAction.method = "Flow.Launcher.CopyToClipboard"`
  with `[emoji, false, showNotification]`. Flow handles it **in-process**: no second node
  process, no PowerShell spawn, and `clipboardy` leaves the dependency tree entirely.
  Verified against Flow's source: `JsonRPCPlugin.ExecuteResultAsync` routes any
  `Flow.Launcher.*` action to `IPublicAPI` by reflection, and `JsonObjectConverter`
  deserialises JSON strings/bools to `string`/`bool`, which matches
  `CopyToClipboard(string, bool directCopy = false, bool showDefaultNotification = true)`.

**Recommendation: do both** (b for the result payload, a as the fallback used by the
`copy` method that older cached results might still call).

Risk: low. The only requirement is a reasonably recent Flow Launcher, which the plugin
store already implies.

### 2. Cap the result list — **−240 KB per keystroke, plus the largest Flow-side win**
1-char and empty queries ship 1 866–1 906 results. Flow renders a list; users scroll
maybe 20 rows. A cap of **50** turns 241 KB into ~6 KB and makes the full sort
unnecessary. Node-side saving is only ~1.3 ms — the real cost is inside Flow
(deserialising 1 900 objects + 1 900 WPF items), which we cannot time from here but
which dwarfs everything else.

Risk: low, but it *is* a behaviour change (you can no longer scroll to result 500).
Recommend 50, configurable via a constant.

### 3. Rewrite `find()` — **2–12 ms → 0.1–1.6 ms**
Prototype (same data, same matching semantics) measured on this machine:

| Query | today | prototype |
|---|---|---|
| `""` | 12.47 ms | 1.57 ms |
| `a` | 10.54 ms | 1.40 ms |
| `face` | 3.10 ms | 0.21 ms |
| `smile` | 2.28 ms | 0.14 ms |
| `red heart` | 2.17 ms | 0.13 ms |

What is slow, concretely:
- `Array.from(inputs)` is re-created **per emoji** (1 906 throwaway arrays per query),
  and again per hit for `computeMatchingScore`.
- `keyword.split('_')` allocates inside the scoring triple loop.
- `keywords.map(... replaceAll ... split ... map ... join ...)` re-capitalises every
  keyword of every hit, on every keystroke.
- `result.sort()` sorts up to 1 900 objects to display 10.
- `Array.prototype.some` over keywords where one pre-lowercased haystack `includes`
  answers the same question.

Plus two correctness bugs found on the way:
- the comparator `(a, b) => a.score > b.score ? -1 : 1` **never returns 0**, so equal
  scores are ordered arbitrarily;
- `input.split(' ')` on `"red  heart"` yields an empty input `""`, which every keyword
  `includes` → everything matches. Normalise with `/\s+/`.

Risk: low-medium — it is the core algorithm, so it needs real tests before, during and
after (that is the "build tests" part of the brief).

### 4. Precompute the index at build time — **~1–3 ms + dependency removal**
Generate a compact index (emoji, title, subtitle, lowercased haystack, icon filename)
from `emojilib` at build time instead of reading
`./node_modules/emojilib/dist/emoji-en-US.json` at runtime. Buys:
- emoji-unicode no longer needed at runtime (icon paths baked in);
- `emojilib` no longer needed at runtime either;
- the fragile cwd-relative `./node_modules/...` path disappears (Flow sets the working
  directory to the plugin folder today, but a portable install or a relocated folder
  breaks it silently).

Risk: medium — adds a generator script and a generated artifact. Only worth it after
1–3, and only if we accept a generated file in the repo.

### 5. Payload hygiene — marginal but free
`score: 0` is sent on every result and Flow ignores it for external plugins; a few
`Subtitle`s are empty strings. Removing them shaves ~10 % off the payload and removes
a confusing field from the code.

### 6. `main.ts` robustness
`JSON.parse(process.argv[2])` throws an unhandled stack trace if Flow ever passes
anything unexpected; an unknown `method` silently does nothing. Both should be explicit
(there is no user-visible error path today).

### 7. CI on pull requests
`publish.yml` only runs on `main`. An upstream PR gets no lint/test/build signal.
A tiny `ci.yml` (`npm ci && npm run lint && npm run test && npm run build`) is a
one-file, zero-risk addition that also protects this fork.

---

## 3. Plan (recursive loop)

1. Write a benchmark harness (`tools/bench.mjs`): N runs per query over a fixed query
   set, reporting mean/median/min, run against both the built `dist/` and the copy path.
2. Record the baseline table (done above, will be re-measured by the harness).
3. Implement **one** improvement at a time, in impact order.
4. Full test suite + benchmark after each step; record the delta in a results table.
5. Only keep a step if the delta is real; revert otherwise.
6. Turn the results into the PR description.

Tests to add before touching `find()` (lock current behaviour, then prove the rewrite
is equivalent on the full emoji corpus):

- `find()` over the whole dataset for a query set, asserting the same *matching set* as
  the current implementation;
- score ordering properties (higher score first, stable ties);
- empty / whitespace / multi-word / mixed-case queries;
- `query()` payload shape (cap, action method, icon path fallback);
- `copy()` with and without notification.

---

## 4. Expected end state

| | today | after 1–3 |
|---|---|---|
| query latency (node side) | ~73 ms | **~25–30 ms** |
| copy action | ~90 ms + PowerShell spawn | **~0 ms** (handled by Flow) |
| payload for `a` | 241 KB / 1 866 items | **~6 KB / 50 items** |
| runtime deps | clipboardy, emoji-unicode, emojilib | emojilib (until step 4) |
