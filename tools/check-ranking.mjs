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
import {
  PLUGIN_ID,
  ensureAliasesFile,
  readActionKeyword,
  readAliases,
  readUsage,
  recordUsage,
  saveAlias
} from '../dist/utils/pluginData.js';
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

/**
 * Records one check.
 *
 * @param kind 'pass' or 'fail' - or the boolean itself, which reads better when the check is a
 *   single condition. A raw boolean here used to reach the report as `true`, where nothing
 *   treats it as a pass: the check existed and could never be counted.
 */
function finding (kind, label, detail = '') {
  const resolved = kind === true ? 'pass' : kind === false ? 'fail' : kind;

  findings.push({ kind: resolved, label, detail });
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
  finding(found.length === 2 ? 'pass' : 'fail', 'and nothing else is mixed in', `${found.length} results`);
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
  const { payload, stdout } = runPlugin({ method: 'context_menu', parameters: ['💪'], settings: {} });
  const menu = payload?.result ?? [];
  const order = menu.map((item) => item.Title);

  finding(menu.length > 0 ? 'pass' : 'fail', 'the context menu answers', `${menu.length} item(s)`);
  // The file entry needs a Flow settings folder, which a bare check run does not have; when it
  // is there it has to be last, after the removals.
  const fileEntryIsLast = !order.includes('Open my aliases file') || order.at(-1) === 'Open my aliases file';

  finding(
    order[0] === 'Copy only' && order[1] === 'Add an alias for this emoji' && fileEntryIsLast,
    'the menu leads with copy-only and add alias, and puts the file last',
    order.join(' | ')
  );

  const add = menu.find((item) => item.Title === 'Add an alias for this emoji');

  // The keyword is whatever this installation answers to, never a literal `e`.
  const keyword = readActionKeyword();

  finding(
    add?.JsonRPCAction?.method === 'Flow.Launcher.CopyToClipboard' &&
      add?.JsonRPCAction?.parameters?.[0] === `${keyword} addalias 💪 `,
    "the add entry copies the finished command, with the installation's keyword",
    JSON.stringify(add?.JsonRPCAction ?? null)
  );

  const copyOnly = menu.find((item) => item.Title === 'Copy only');

  finding(
    copyOnly?.JsonRPCAction?.method === 'copy' && copyOnly?.JsonRPCAction?.parameters?.[0] === '💪',
    'the menu offers a copy-only action for paste-mode users',
    JSON.stringify(copyOnly?.JsonRPCAction ?? null)
  );
  // Flow decodes our stdout with the console code page, so the emoji must not be written literally.
  const printableAscii = [...stdout].every((character) => {
    const code = character.charCodeAt(0);

    return code === 10 || code === 13 || (code >= 32 && code < 127);
  });

  finding(
    stdout !== '' && printableAscii,
    'nothing but ASCII is written to stdout (Flow reads it with the console code page)',
    stdout === '' ? 'no output at all' : printableAscii ? '' : [...stdout].filter((character) => character.charCodeAt(0) > 127).slice(0, 8).join('')
  );
}

function checkAliasCommands () {
  const add = parseAliasCommand('addalias 💪 swole');

  finding(add.kind === 'add' && add.emoji === '💪' && add.alias === 'swole', 'addalias reads emoji first, then the name');
  finding(
    parseAliasCommand('addalias 💪 swole').kind === 'add' && parseAliasCommand('addalias swole').kind === 'emoji-missing',
    'the emoji comes first, and a bare word is never also a search'
  );

  // A rebinding must reach every string and every generated command. The choice lives in Flow's
  // own Settings.json, so build one: Settings/Plugins/Emoji Finder is where the plugin thinks it
  // lives, and Settings/Settings.json is two levels up.
  const layout = createTemporarySettings();
  const rebindSettings = path.join(layout, 'Settings', 'Plugins', 'Emoji Finder');

  fs.mkdirSync(rebindSettings, { recursive: true });
  fs.writeFileSync(path.join(layout, 'Settings', 'Settings.json'), JSON.stringify({
    PluginSettings: { Plugins: { [PLUGIN_ID]: { ID: PLUGIN_ID, ActionKeywords: ['emoji'] } } }
  }));
  finding(
    readActionKeyword(rebindSettings) === 'emoji',
    'the keyword the user chose in Flow wins over the manifest',
    readActionKeyword(rebindSettings)
  );
  fs.rmSync(layout, { recursive: true, force: true });

  const settings = createTemporarySettings();

  saveAlias(settings, 'swole', '💪');
  const saved = readAliases(settings);

  // The template that "open my aliases file" leaves for a hand-editor: a fresh folder, because
  // the file above already exists and must never be overwritten.
  const fresh = createTemporarySettings();
  const template = JSON.parse(fs.readFileSync(ensureAliasesFile(fresh), 'utf8'));

  fs.rmSync(settings, { recursive: true, force: true });
  fs.rmSync(fresh, { recursive: true, force: true });

  finding(saved.swole === '💪' ? 'pass' : 'fail', 'saving an alias writes it where the query will read it');
  finding(
    typeof template._HowToUse === 'string' &&
      typeof template._Note === 'string' &&
      template._Note.includes('emoji database') &&
      typeof template._examplealias === 'string',
    'a fresh aliases file explains itself, warns off the database, and shows an example',
    Object.keys(template).join(' | ')
  );

  // Opening the file is our own action: ShellRun would start a JSON file as a program, which is
  // why nothing happened. Outside a Flow layout there is no settings folder, and the plugin has
  // to say so rather than do nothing.
  const opened = runPlugin({ method: 'openaliases', parameters: [], settings: {} });

  finding(
    opened.payload?.method === 'Flow.Launcher.ShowMsg' ||
      opened.payload?.method === 'Flow.Launcher.OpenAppUri',
    'opening the aliases file asks Flow for something it can do',
    String(opened.payload?.method ?? opened.stdout.trim().slice(0, 60))
  );
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
