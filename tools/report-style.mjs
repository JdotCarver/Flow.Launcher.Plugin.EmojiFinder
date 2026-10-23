// tools/report-style.mjs
//
// Colour for the report commands (doctor, dogfood:check). Written by hand rather than
// pulled from a package: six escape codes are not worth a dependency, and this project
// keeps its dependency surface small on purpose (see docs/DEPENDENCIES.md).
//
// Colour is only used when it helps:
//   * stdout must be a terminal (piped output stays plain, so logs and CI are readable);
//   * NO_COLOR (https://no-color.org) always wins;
//   * TERM=dumb opts out.
// Windows: modern consoles (Windows Terminal, PowerShell 7, VS Code) support ANSI. The
// legacy console does not, so it is detected and left plain unless WT_SESSION is set.

const ANSI = {
  reset: '\u001B[0m',
  bold: '\u001B[1m',
  dim: '\u001B[2m',
  red: '\u001B[31m',
  green: '\u001B[32m',
  yellow: '\u001B[33m',
  blue: '\u001B[34m',
  magenta: '\u001B[35m',
  cyan: '\u001B[36m'
};

/**
 * Whether the current output stream can show colour.
 */
export function supportsColour (stream = process.stdout) {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') {
    return false;
  }

  if (process.env.TERM === 'dumb') {
    return false;
  }

  if (stream.isTTY !== true) {
    return false;
  }

  // Windows Terminal / VS Code terminal / PowerShell 7 announce themselves; the legacy
  // conhost does not render ANSI without being asked to.
  if (process.platform === 'win32') {
    return process.env.WT_SESSION !== undefined || process.env.TERM !== undefined;
  }

  return true;
}

/**
 * Builds the small set of formatting helpers used by the report commands.
 */
export function createStyle (stream = process.stdout) {
  const enabled = supportsColour(stream);

  const paint = code => text => enabled ? `${code}${text}${ANSI.reset}` : String(text);

  return {
    enabled,
    bold: paint(ANSI.bold),
    dim: paint(ANSI.dim),
    red: paint(ANSI.red),
    green: paint(ANSI.green),
    yellow: paint(ANSI.yellow),
    blue: paint(ANSI.blue),
    cyan: paint(ANSI.cyan),
    /**
     * One finding line: a coloured, padded label and the message.
     * The label widths are fixed so the messages line up in a column.
     */
    finding: (kind, message) => {
      const labels = {
        pass: { text: 'OK  ', paint: paint(ANSI.green) },
        fail: { text: 'FAIL', paint: paint(ANSI.red) },
        warn: { text: 'WARN', paint: paint(ANSI.yellow) },
        info: { text: 'info', paint: paint(ANSI.blue) },
        skip: { text: 'skip', paint: paint(ANSI.dim) }
      };

      const label = labels[kind] ?? labels.info;

      return `${label.paint(label.text)}  ${message}`;
    }
  };
}
