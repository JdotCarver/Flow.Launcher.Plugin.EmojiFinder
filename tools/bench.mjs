// tools/bench.mjs
//
// End-to-end benchmark for the Emoji Finder plugin.
//
// Flow Launcher spawns a fresh `node dist/main.js '<json>'` process per keystroke, so
// the only honest measurement is a full process spawn. This script does exactly that,
// the way Flow does it: same working directory (the plugin root), same argument shape.
//
// Usage
//   node tools/bench.mjs                       # measure, print a table
//   node tools/bench.mjs --save baseline.json  # measure and store the numbers
//   node tools/bench.mjs --compare baseline.json   # measure and diff against a file
//   node tools/bench.mjs --runs 30             # more samples (default 15)
//   node tools/bench.mjs --query "smile"       # single query instead of the full set
//
// The numbers are wall-clock per invocation, which is what the user feels: nothing in
// this plugin outlives a single keystroke.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY_POINT = path.join(PLUGIN_ROOT, 'dist', 'main.js');

// Queries chosen to cover the whole cost range: empty, one letter (matches almost
// everything), multi-word, rare word, and a no-match control.
const DEFAULT_QUERIES = [
  { label: 'empty', input: '' },
  { label: '1 letter', input: 'a' },
  { label: '2 letters', input: 'he' },
  { label: 'common', input: 'smile' },
  { label: 'multi-word', input: 'red heart' },
  { label: 'medium', input: 'face' },
  { label: 'no match', input: 'zzzzzz' }
];

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArguments (argv) {
  const options = { runs: 15, save: null, compare: null, queries: DEFAULT_QUERIES };

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];

    switch (argument) {
      case '--runs':
        options.runs = Number(argv[++index]);
        break;
      case '--save':
        options.save = argv[++index];
        break;
      case '--compare':
        options.compare = argv[++index];
        break;
      case '--query':
        options.queries = [{ label: argv[++index], input: argv[index] }];
        break;
      default:
        console.error(`Unknown argument: ${argument}`);
        process.exit(1);
    }
  }

  return options;
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/**
 * Builds the exact argv payload Flow Launcher sends to a JSON-RPC (V1) plugin.
 */
function buildQueryArgument (input, settings = { enableNotification: true, maxResults: '25' }) {
  return JSON.stringify({ method: 'query', parameters: [input], settings });
}

/**
 * Runs the plugin once and returns the elapsed milliseconds plus the payload it wrote.
 */
function runOnce (argument) {
  const startedAt = process.hrtime.bigint();

  const result = spawnSync(process.execPath, [ENTRY_POINT, argument], {
    cwd: PLUGIN_ROOT, // Flow sets the working directory to the plugin folder.
    encoding: 'utf8'
  });

  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  if (result.status !== 0) {
    throw new Error(`Plugin exited with ${result.status}:\n${result.stderr}`);
  }

  return { elapsedMs, output: result.stdout };
}

function percentile (sortedValues, fraction) {
  const index = Math.min(sortedValues.length - 1, Math.floor(sortedValues.length * fraction));
  return sortedValues[index];
}

function measureQuery (query, runs) {
  const argument = buildQueryArgument(query.input);
  const samples = [];
  let output = '';

  for (let run = 0; run < runs; run++) {
    const { elapsedMs, output: captured } = runOnce(argument);
    samples.push(elapsedMs);
    output = captured;
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const resultCount = countResults(output);

  return {
    label: query.label,
    input: query.input,
    meanMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    minMs: sorted[0],
    resultCount,
    payloadBytes: Buffer.byteLength(output, 'utf8')
  };
}

/**
 * The plugin prints one JSON document per query; count the results in it.
 */
function countResults (output) {
  const trimmed = output.trim();
  if (trimmed === '') return 0;

  try {
    return JSON.parse(trimmed).result?.length ?? 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function formatTable (rows, baseline) {
  const header = baseline === null
    ? ['query', 'results', 'payload', 'mean', 'median', 'p95']
    : ['query', 'results', 'payload', 'mean', 'median', 'p95', 'Δ median'];

  const body = rows.map((row) => {
    const cells = [
      row.label,
      String(row.resultCount),
      formatBytes(row.payloadBytes),
      `${row.meanMs.toFixed(1)} ms`,
      `${row.medianMs.toFixed(1)} ms`,
      `${row.p95Ms.toFixed(1)} ms`
    ];

    if (baseline !== null) {
      const reference = baseline.find(candidate => candidate.label === row.label);
      cells.push(reference ? formatDelta(row.medianMs - reference.medianMs, reference.medianMs) : 'n/a');
    }

    return cells;
  });

  const widths = header.map((title, column) =>
    Math.max(title.length, ...body.map(cells => cells[column].length))
  );

  const renderRow = cells => cells.map((cell, column) => cell.padEnd(widths[column])).join('  ');

  return [
    renderRow(header),
    renderRow(widths.map(width => '-'.repeat(width))),
    ...body.map(renderRow)
  ].join('\n');
}

function formatBytes (bytes) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function formatDelta (deltaMs, referenceMs) {
  const sign = deltaMs > 0 ? '+' : '';
  const percentage = referenceMs === 0 ? 0 : (deltaMs / referenceMs) * 100;
  return `${sign}${deltaMs.toFixed(1)} ms (${sign}${percentage.toFixed(0)}%)`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const options = parseArguments(process.argv.slice(2));

if (!fs.existsSync(ENTRY_POINT)) {
  console.error(`No build found at ${ENTRY_POINT}. Run: npm run build`);
  process.exit(1);
}

const sourceTimestamp = Math.max(
  ...fs.readdirSync(path.join(PLUGIN_ROOT, 'src'), { recursive: true })
    .map(file => path.join(PLUGIN_ROOT, 'src', String(file)))
    .filter(file => fs.statSync(file).isFile())
    .map(file => fs.statSync(file).mtimeMs)
);

if (sourceTimestamp > fs.statSync(ENTRY_POINT).mtimeMs) {
  console.warn('!! dist/ is older than src/ — run `npm run build` first\n');
}

const baseline = options.compare === null
  ? null
  : JSON.parse(fs.readFileSync(options.compare, 'utf8'));

console.log(`bench: ${options.runs} runs per query, end-to-end process spawn\n`);

const rows = [];
for (const query of options.queries) {
  rows.push(measureQuery(query, options.runs));
}

console.log(formatTable(rows, baseline));

if (options.save !== null) {
  fs.writeFileSync(options.save, JSON.stringify(rows, null, 2));
  console.log(`\nsaved to ${options.save}`);
}

// Exit non-zero when a comparison shows something got slower, so this can gate a step.
if (baseline !== null) {
  const regressions = rows.filter((row) => {
    const reference = baseline.find(candidate => candidate.label === row.label);
    return reference !== undefined && row.medianMs > reference.medianMs * 1.1;
  });

  if (regressions.length > 0) {
    console.log(`\n!! slower than baseline: ${regressions.map(row => row.label).join(', ')}`);
    process.exit(2);
  }
}
