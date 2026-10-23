// src/utils/find.ts
//
// The emoji search: match what the user typed against emojilib's keyword list and
// rank the matches.
//
// Flow Launcher starts a new process for every keystroke, so this runs on the critical
// path of every character the user types. It is written to do exactly one pass over
// the data, allocate nothing per emoji, and only build the human-readable strings for
// the handful of entries that are actually returned.

import fs from 'node:fs';

export type FindResult = {
  title: string
  subtitle: string
  emoji: string
  score: number
};

/** `emojilib`'s data file, resolved next to the module so the cwd does not matter. */
const EMOJI_DATA_URL = new URL('../../node_modules/emojilib/dist/emoji-en-US.json', import.meta.url);

type EmojiEntry = [emoji: string, keywords: string[]];

type EmojiMatch = {
  emoji: string
  keywords: string[]
  score: number
};

let emojiEntries: EmojiEntry[] | undefined;

/**
 * Loads the emoji keyword table once per process.
 * Flow runs one query per process, so this is really here for tests and for callers
 * that query in a loop.
 */
function loadEmojiEntries (): EmojiEntry[] {
  emojiEntries ??= Object.entries(
    JSON.parse(fs.readFileSync(EMOJI_DATA_URL, 'utf8')) as Record<string, string[]>
  );

  return emojiEntries;
}

/**
 * Splits what the user typed into lowercase words.
 *
 * Runs of whitespace collapse, so "red  heart" is the same query as "red heart".
 * Without that, the empty word between the two spaces would match every keyword and
 * the query would return the whole emoji table.
 */
function splitInput (input: string): string[] {
  return [...new Set(input.toLowerCase().split(/\s+/).filter(Boolean))];
}

/**
 * The matching rule: an emoji matches when every word the user typed appears somewhere
 * in at least one of its keywords. Partial words count ("fac" matches "face").
 */
function matchesEveryInput (keywords: string[], inputs: string[]): boolean {
  for (const input of inputs) {
    let found = false;

    for (const keyword of keywords) {
      if (keyword.includes(input)) {
        found = true;
        break;
      }
    }

    if (!found) {
      return false;
    }
  }

  return true;
}

/**
 * Computes a matching score between user input and a list of keywords.
 *
 * The scoring is deliberately simple, and kept exactly as it always was so results do
 * not move around between versions:
 *   +1 when a keyword part contains the input,
 *   +5 more when the keyword part is exactly the input,
 *   +1 more when the keyword part starts with the input,
 * and the whole score for the first keyword is doubled (the first keyword is the
 * emoji's name, so it matters most).
 *
 * @param inputs List of words typed by the user, already lowercased.
 * @param keywords List of keywords to compare to user input.
 * @returns A score based on how likely the user expect to see the entry described by passed keywords.
 */
export function computeMatchingScore (inputs: string[], keywords: string[]): number {
  let score = 0;

  for (let keywordIndex = 0; keywordIndex < keywords.length; keywordIndex++) {
    const keyword = keywords[keywordIndex] ?? '';
    let keywordScore = 0;
    let partStart = 0;

    // Walk the keyword's underscore-separated parts without allocating an array.
    while (partStart <= keyword.length) {
      const separatorIndex = keyword.indexOf('_', partStart);
      const partEnd = separatorIndex === -1 ? keyword.length : separatorIndex;
      const part = keyword.slice(partStart, partEnd);

      for (const input of inputs) {
        if (part.includes(input)) {
          keywordScore += 1;

          if (part === input) {
            keywordScore += 5;
          }
        }

        if (part.startsWith(input)) {
          keywordScore += 1;
        }
      }

      if (separatorIndex === -1) {
        break;
      }

      partStart = separatorIndex + 1;
    }

    // The first keyword is the emoji's own name: weight it above the rest.
    score += keywordIndex === 0 ? keywordScore * 2 : keywordScore;
  }

  return score;
}

/**
 * Turns `grinning_face_with_smiling_eyes` into `Grinning Face With Smiling Eyes`.
 * Only called for results that are actually returned, never for the whole table.
 *
 * Keywords are underscore-separated but a few of them already contain a space
 * ("sewing needle"), hence the two-step split.
 */
function humaniseKeyword (keyword: string): string {
  return keyword
    .replaceAll('_', ' ')
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function toFindResult ({ emoji, keywords, score }: EmojiMatch): FindResult {
  const [name = '', ...otherKeywords] = keywords;

  return {
    emoji,
    title: humaniseKeyword(name),
    subtitle: otherKeywords.map(humaniseKeyword).join(', '),
    score
  };
}

/**
 * Finds emoji matching the user input, best match first.
 *
 * @param input What the user typed after the action keyword.
 * @param limit Maximum number of results to build. Flow Launcher renders every result
 *              it receives, so this is the difference between a snappy list and a
 *              visible pause. Defaults to no limit for tests and tooling.
 */
export function find (input: string, limit: number = Number.POSITIVE_INFINITY): FindResult[] {
  const inputs = splitInput(input);
  const matches: EmojiMatch[] = [];

  for (const [emoji, keywords] of loadEmojiEntries()) {
    if (matchesEveryInput(keywords, inputs)) {
      matches.push({ emoji, keywords, score: computeMatchingScore(inputs, keywords) });
    }
  }

  // Array#sort is stable, so equally good matches keep the data file's order instead
  // of shuffling between keystrokes.
  matches.sort((first, second) => second.score - first.score);

  return matches.slice(0, limit).map(toFindResult);
}
