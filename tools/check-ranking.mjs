// tools/check-ranking.mjs
//
// Measures what aliases and the empty-query history cost on the machine that actually runs the
// plugin, and checks the two new surfaces end to end.
//
// Why on Windows, and why here: every claim about latency in this project is measured, not
// asserted (docs/PERF_ANALYSIS.md). The sandbox has no Flow Launcher and a different CPU, so
// the numbers that matter - "is a keystroke still fast", "does an alias make search slower",
// "what does it cost to read the alias file" - can only come from the maintainer's machine.
//
// What it measures
//   1. find() for typical queries, with and without the user's aliases and history;
//   2. reading the alias file and the usage file;
//   3. the whole process, the way Flow Launcher runs it: `node dist/main.js '<json>'`;
//   4. an empty query with a history, which is the one behaviour Flow cannot provide.
//
// What it checks
//   - an alias finds its emoji through the same code path a keystroke takes;
//   - results carry Score, RecordKey and ContextData (Flow needs all three);
//   - the context menu answers with a method Flow can resolve;
//   - an alias command saves, and `aliases` lists what was saved.
//
// Usage
//   npm run check:ranking            (Windows or any machine; writes dogfood/ranking-check.json)

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { parseAliasCommand } from '../dist/actions/aliases.js';
import { find } from '../dist/utils/find.js';
import { readAliases, readUsage, recordUsage, saveAlias } from '../dist/utils/pluginData.js';
import { createStyle } from './report-style.mjs';

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..');
const DOGFOOD_DIRECTORY = path.join(PLUGIN_ROOT, 'dogfood');
const REPORT_FILE = path.join(DOGFOOD_DIRECTORY, 'ranking-check.json');

/** Enough runs for a median to mean something, few enough to stay quick. */
const TIMED_RUNS = 15;

const style = createStyle();
const findings = [];
const measurements = {};

/** Queries a person actually types, plus the two extremes. */
const QUERIES = ['', 'a', 'smile', 'red heart', 'thumbs up', 'woman technologist'];

/** A believable set of aliases: forty names, some of them for the same emoji. */
const ALIASES = {
  swole: '💪',
  gym: '💪',
  shipit: '🚀',
  launch: '🚀',
  shrug: '🤷',
  yay: '🎉',
  party: '🎉',
  nope: '🙅',
  yes: '✅',
  no: '❌',
  love: '❤️',
  fire: '🔥',
  eyes: '👀',
  think: '🤔',
  cry: '😢',
  lol: '😂',
  wink: '😉',
  wave: '👋',
  clap: '👏',
  pray: '🙏',
  tada: '🎉',
  sparkle: '✨',
  star: '⭐',
  sun: '☀️',
  moon: '🌙',
  rain: '🌧️',
  snow: '❄️',
  bug: '🐛',
  cat: '🐱',
  dog: '🐶',
  coffee: '☕',
  tea: '🍵',
  pizza: '🍕',
  cake: '🍰',
  beer: '🍺',
  book: '📚',
  code: '💻',
  lock: '🔒',
  key: '🔑',
  check: '✔️'
};

function finding (kind, label, detail = '') {
  findings.push({ kind, label, detail });
}

/** Median of several runs: one slow sample must not become the reported number. */
function median (values) {
  const sorted = [...values].sort((first, second) => first - second);

  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function timeRuns (operation) {
  const samples = [];

  for (let run = 0; run < TIMED_RUNS; run++) {
    const startedAt = performance.now();

    operation();
    samples.push(performance.now() - startedAt);
  }

  return Number(median(samples).toFixed(3));
}

/** Runs the plugin the way Flow Launcher does, and parses what it printed. */
function runPlugin (payload) {
  const result = spawnSync(process.execPath, [path.join('dist', 'main.js'), JSON.stringify(payload)], {
    cwd: PLUGIN_ROOT,
    encoding: 'utf8',
    timeout: 30000
  });

  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', payload: safeJson(result.stdout) };
}

function safeJson (text) {
  try {
    return JSON.parse(text ?? '');
  } catch {
    return null;
  }
}

/** A throwaway settings folder, so measuring never touches the user's real aliases. */
function createTemporarySettings () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ranking-check-'));
}

function measureSearchCost () {
  const settings = createTemporarySettings();

  for (const [alias, emoji] of Object.entries(ALIASES)) {
    saveAlias(settings, alias, emoji);
  }

  recordUsage(settings, '🚀', 1000);
  recordUsage(settings, '🚀', 2000);
  recordUsage(settings, '🙈', 3000);

  const aliases = readAliases(settings);
  const usage = readUsage(settings);

  measurements.aliasesLoaded = Object.keys(aliases).length;
  measurements.usageLoaded = Object.keys(usage).length;

  measurements.milliseconds = {};

  for (const query of QUERIES) {
    const bare = timeRuns(() => {
      find(query, 25);
    });
    const withUserData = timeRuns(() => {
      find(query, 25, { aliases, usage });
    });

    measurements.milliseconds[query === '' ? '(empty query)' : query] = {
      withoutAliases: bare,
      withAliases: withUserData,
      difference: Number((withUserData - bare).toFixed(3))
    };
  }

  measurements.milliseconds['read aliases file (40 entries)'] = timeRuns(() => {
    readAliases(settings);
  });
  measurements.milliseconds['read usage file (2 entries)'] = timeRuns(() => {
    readUsage(settings);
  });

  fs.rmSync(settings, { recursive: true, force: true });

  // A tenfold slowdown on the hottest path would be a regression worth failing for. Anything
  // under a millisecond per keystroke is noise next to Node's ~23 ms boot.
  const worst = Math.max(...Object.values(measurements.milliseconds).map((entry) => entry.withAliases ?? 0));

  finding(worst < 5 ? 'pass' : 'fail', `search with aliases and history stays under 5 ms (worst: ${worst} ms)`);
}

function checkAliasSearch () {
  const found = find('swole', 5, { aliases: ALIASES });

  finding(found[0]?.emoji === '💪' ? 'pass' : 'fail', 'an alias finds its emoji', `first result: ${found[0]?.emoji ?? 'none'}`);

  const unfiltered = find('thumbs up', 5);
  const filtered = find('thumbs up', 5, { aliases: ALIASES });

  finding(
    JSON.stringify(unfiltered.map((entry) => entry.emoji)) === JSON.stringify(filtered.map((entry) => entry.emoji))
      ? 'pass'
      : 'fail',
    'having aliases does not change an ordinary search'
  );
}

function checkEmptyQuery () {
  const history = { '🚀': { count: 5, lastUsedAt: 900 }, '🙈': { count: 1, lastUsedAt: 100 } };
  const found = find('', 10, { usage: history });

  finding(found[0]?.emoji === '🚀' ? 'pass' : 'fail', 'an empty query shows the most used emoji first', `first: ${found[0]?.emoji ?? 'none'}`);
  finding(found[1]?.emoji === '🙈' ? 'pass' : 'fail', 'then the next one, by recency');
  finding(found.length === 10 ? 'pass' : 'fail', 'and the list is still full', `${found.length} results`);
}

function checkResultsCarryWhatFlowNeeds () {
  const { payload } = runPlugin({
    method: 'query',
    parameters: ['smile'],
    settings: { enableNotification: true, maxResults: '5' }
  });
  const [first] = payload?.result ?? [];

  finding(payload?.result?.length > 0 ? 'pass' : 'fail', 'a query returns results through the real entry point');
  finding(typeof first?.Score === 'number' && first.Score > 0 ? 'pass' : 'fail', 'results carry a Score', String(first?.Score));
  finding(typeof first?.RecordKey === 'string' ? 'pass' : 'fail', 'results carry a RecordKey', String(first?.RecordKey));
  finding(first?.ContextData === first?.RecordKey ? 'pass' : 'fail', 'results carry the ContextData the context menu needs');
}

function checkContextMenu () {
  const { payload } = runPlugin({ method: 'context_menu', parameters: ['💪'], settings: {} });
  const menu = payload?.result ?? [];
  const addItem = menu.find((item) => item.Title?.includes('Add an alias'));

  finding(menu.length > 0 ? 'pass' : 'fail', 'the context menu answers', `${menu.length} item(s)`);
  finding(
    addItem?.JsonRPCAction?.method === 'Flow.Launcher.ChangeQuery' &&
      addItem?.JsonRPCAction?.parameters?.[0] === 'addalias 💪 ' &&
      addItem?.JsonRPCAction?.parameters?.[1] === true,
    'it offers to add an alias and pre-fills the query box',
    JSON.stringify(addItem?.JsonRPCAction ?? null)
  );
}

function checkAliasCommands () {
  const add = parseAliasCommand('addalias swole 💪');
  const prefill = parseAliasCommand('addalias 💪 swole');

  finding(
    add.kind === 'add' && add.emoji === '💪' && add.alias === 'swole' && prefill.kind === 'add' && prefill.alias === 'swole',
    'both word orders for addalias parse the same way'
  );

  const settings = createTemporarySettings();

  saveAlias(settings, 'swole', '💪');
  const saved = readAliases(settings);

  fs.rmSync(settings, { recursive: true, force: true });

  finding(saved.swole === '💪' ? 'pass' : 'fail', 'saving an alias writes it where the query will read it');
}

function checkProcessCost () {
  const samples = [];

  for (let run = 0; run < 5; run++) {
    const startedAt = performance.now();

    runPlugin({ method: 'query', parameters: ['smile'], settings: { maxResults: '25' } });
    samples.push(performance.now() - startedAt);
  }

  measurements.milliseconds['whole process, query "smile"'] = Number(median(samples).toFixed(1));
  finding(measurements.milliseconds['whole process, query "smile"'] < 500 ? 'pass' : 'fail', 'a keystroke is still answered in well under half a second');
}

function report () {
  for (const entry of findings) {
    const detail = entry.detail === '' ? '' : style.dim(`  (${entry.detail})`);

    console.log(style.finding(entry.kind, entry.label) + detail);
  }

  console.log(style.finding('info', 'timings (median of ' + TIMED_RUNS + ' runs, milliseconds)'));
  console.log(JSON.stringify(measurements.milliseconds, null, 2));

  const failures = findings.filter((entry) => entry.kind === 'fail').length;

  console.log(style.finding(failures === 0 ? 'ok' : 'fail', `${findings.length - failures}/${findings.length} checks passed`));

  return failures;
}

function annotate () {
  if (process.env.GITHUB_ACTIONS !== 'true') {
    return;
  }

  for (const entry of findings) {
    console.log(`::${entry.kind === 'fail' ? 'error' : 'notice'} title=ranking::${entry.label}${entry.detail === '' ? '' : ` (${entry.detail})`}`);
  }
}

fs.mkdirSync(DOGFOOD_DIRECTORY, { recursive: true });

measureSearchCost();
checkAliasSearch();
checkEmptyQuery();
checkResultsCarryWhatFlowNeeds();
checkContextMenu();
checkAliasCommands();
checkProcessCost();

const failures = report();

fs.writeFileSync(REPORT_FILE, JSON.stringify({
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  node: process.version,
  findings,
  measurements
}, null, 2) + '\n');

annotate();
console.log(style.finding('info', `wrote ${path.relative(PLUGIN_ROOT, REPORT_FILE)}`));

if (failures > 0) {
  process.exitCode = 1;
}
