// tools/package-paths.mjs
//
// Turns the output of `npm ls --omit=dev --all --parseable` into the relative paths of
// the packages a packaged plugin must carry.
//
// Why this is its own module: the parsing has one genuinely nasty input. `npm ls
// --parseable` prints paths in whatever form the platform produced, and on Windows that is
// a mix - backslashes from Node, forward slashes from npm's own normalisation - so a
// naive `line.includes(path.sep + 'node_modules' + path.sep)` matches nothing on Windows
// and silently packages a plugin with no dependencies at all. Keeping the parsing pure and
// platform-free means the Windows case can be tested from a Linux sandbox.
//
// Used by tools/package.mjs and covered by tests/tools/packagePaths.test.ts.

/** The directory npm puts dependencies in, in its normalised form. */
const NODE_MODULES_MARKER = '/node_modules/';

/**
 * Returns the path of a package relative to `node_modules`, or null when the line is not
 * a package inside `node_modules`.
 *
 * The *first* occurrence is used on purpose: a nested dependency lives at
 * `node_modules/a/node_modules/b` and must be copied to `a/node_modules/b`, not to `b`,
 * or Node's resolver will not find it from inside `a`.
 *
 * @param {string} listingLine One line of `npm ls --parseable` output.
 * @returns {string | null} For example `emojilib`, `@napi-rs/keyring`, or
 *   `clipboardy/node_modules/foo`.
 */
export function dependencyRelativePath (listingLine) {
  const normalized = listingLine.trim().replaceAll('\\', '/');
  const markerIndex = normalized.indexOf(NODE_MODULES_MARKER);

  if (markerIndex === -1) {
    return null;
  }

  const relativePath = normalized.slice(markerIndex + NODE_MODULES_MARKER.length);

  // A trailing marker (`.../node_modules/`) is not a package.
  return relativePath === '' ? null : relativePath;
}

/**
 * Filters a whole `npm ls --parseable` listing down to dependency paths.
 *
 * @param {string} listing Raw command output.
 * @returns {string[]} Relative paths, duplicates removed, in the order npm printed them.
 */
export function dependencyRelativePaths (listing) {
  const seen = new Set();

  for (const line of listing.split('\n')) {
    const relativePath = dependencyRelativePath(line);

    if (relativePath !== null) {
      seen.add(relativePath);
    }
  }

  return [...seen];
}
