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
import { fileURLToPath } from 'node:url';
import type { AliasRecord, UsageRecord } from './pluginData.js';

export type FindResult = {
  title: string
  subtitle: string
  emoji: string
  score: number
  /** The user's own name for this emoji, when they gave it one. */
  alias?: string
};

/** `emojilib`'s data file, resolved next to the module so the cwd does not matter. */
const EMOJI_DATA_URL = new URL('../../node_modules/emojilib/dist/emoji-en-US.json', import.meta.url);

/** Where that data file is, as a path: the settings page and the alias list point at it. */
export function emojiDatabasePath (): string {
  return fileURLToPath(EMOJI_DATA_URL);
}

type EmojiEntry = [emoji: string, keywords: string[]];

type EmojiMatch = {
  emoji: string
  keywords: string[]
  score: number
};

/**
 * What the user has taught the plugin: their own aliases, and what they actually pick.
 *
 * Both are optional. A query with neither behaves exactly like it always did, which is what
 * makes this safe to add to the hot path.
 */
export type FindOptions = {
  aliases?: AliasRecord
  usage?: UsageRecord
};

/**
 * How much a used emoji is worth for an empty query.
 *
 * An empty query has no relevance to speak of, so it is ranked by the user's own history
 * instead: every entry gets a score that only has to be higher than the untouched ones.
 */
const RECENT_EMOJI_SCORE = 1000;

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
function matchesEveryInput (keywords: readonly string[], inputs: string[]): boolean {
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
export function computeMatchingScore (inputs: string[], keywords: readonly string[]): number {
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

function toFindResult ({ emoji, keywords, score }: EmojiMatch, aliases: readonly string[] = []): FindResult {
  const [name = '', ...otherKeywords] = keywords;
  const subtitleParts = otherKeywords.map(humaniseKeyword);

  // Shown, because a result found under a name that is not in its keywords would otherwise
  // look like a mistake.
  if (aliases.length > 0) {
    subtitleParts.unshift(`Your alias: ${aliases.join(', ')}`);
  }

  return {
    emoji,
    title: humaniseKeyword(name),
    subtitle: subtitleParts.join(', '),
    score,
    ...(aliases.length > 0 ? { alias: aliases[0] } : {})
  };
}

/**
 * Groups the user's aliases by the emoji they point at.
 *
 * Built per call rather than kept in a module-level cache: Flow Launcher starts a new process
 * for every keystroke, so there is nothing to keep anything between, and the maps are tiny.
 */
function groupAliasesByEmoji (aliases: AliasRecord | undefined): Map<string, string[]> {
  const grouped = new Map<string, string[]>();

  for (const [alias, emoji] of Object.entries(aliases ?? {})) {
    const existing = grouped.get(emoji);

    if (existing === undefined) {
      grouped.set(emoji, [alias]);
    } else {
      existing.push(alias);
    }
  }

  return grouped;
}

/**
 * Ranks one emoji against what the user typed, taking the user's aliases into account.
 *
 * An alias is an extra name for the emoji, so it is scored as if it were the emoji's own name:
 * the best of the two scores wins, and the ordinary keyword match is never made worse by
 * having an alias. That is what makes `swole` find 💪 without touching how `muscle` does.
 *
 * @returns The score, or 0 when the emoji matches neither its keywords nor its aliases.
 */
function scoreEmoji (inputs: string[], keywords: string[], aliases: readonly string[]): number {
  const keywordScore = matchesEveryInput(keywords, inputs) ? computeMatchingScore(inputs, keywords) : 0;

  if (aliases.length === 0) {
    return keywordScore;
  }

  const aliasScore = matchesEveryInput(aliases, inputs) ? computeMatchingScore(inputs, aliases) : 0;

  return Math.max(keywordScore, aliasScore);
}

/**
 * The order an empty query shows: what the user actually picks, most used first.
 *
 * Flow Launcher only ever sees the results we return, so its own selection counts - which do
 * reorder results - can never bring an emoji we did not send into the list. The empty query
 * therefore has to be answered from our own history, or a used emoji that is not among the
 * first handful of the data file can never appear.
 */
function orderByUsage (usage: UsageRecord): string[] {
  return Object.entries(usage)
    .sort((first, second) =>
      second[1].count - first[1].count ||
      second[1].lastUsedAt - first[1].lastUsedAt
    )
    .map(([emoji]) => emoji);
}

/**
 * Finds emoji matching the user input, best match first.
 *
 * @param input What the user typed after the action keyword.
 * @param limit Maximum number of results to build. Flow Launcher renders every result
 *              it receives, so this is the difference between a snappy list and a
 *              visible pause. Defaults to no limit for tests and tooling.
 * @param options The user's aliases and history, or neither.
 */
export function find (
  input: string,
  limit: number = Number.POSITIVE_INFINITY,
  options: FindOptions = {}
): FindResult[] {
  const inputs = splitInput(input);
  const aliasesByEmoji = groupAliasesByEmoji(options.aliases);
  const entries = loadEmojiEntries();

  if (inputs.length === 0) {
    return findMostUsed(entries, limit, options.usage ?? {}, aliasesByEmoji);
  }

  const matches: EmojiMatch[] = [];

  for (const [emoji, keywords] of entries) {
    const score = scoreEmoji(inputs, keywords, aliasesByEmoji.get(emoji) ?? []);

    if (score > 0) {
      matches.push({ emoji, keywords, score });
    }
  }

  // Array#sort is stable, so equally good matches keep the data file's order instead
  // of shuffling between keystrokes.
  matches.sort((first, second) => second.score - first.score);

  return matches
    .slice(0, limit)
    .map(match => toFindResult(match, aliasesByEmoji.get(match.emoji) ?? []));
}

/**
 * The empty-query answer: the user's own emoji, and nothing else.
 *
 * Used emoji are sorted by count and then by how recently they were used, which is the part
 * Flow Launcher cannot do for us (its counts are numbers, not timestamps). With no history at
 * all the data file's order is returned unchanged, so the list is never empty.
 */
function findMostUsed (
  entries: EmojiEntry[],
  limit: number,
  usage: UsageRecord,
  aliasesByEmoji: Map<string, string[]>
): FindResult[] {
  const keywordsByEmoji = new Map(entries);
  const used = orderByUsage(usage);
  const results: FindResult[] = [];

  for (const emoji of used) {
    const keywords = keywordsByEmoji.get(emoji);

    // A history entry for an emoji this version of the data file no longer has is skipped,
    // not an error: the emoji table comes from a dependency and can change under us.
    if (keywords === undefined) {
      continue;
    }

    results.push(toFindResult({ emoji, keywords, score: RECENT_EMOJI_SCORE }, aliasesByEmoji.get(emoji) ?? []));

    if (results.length >= limit) {
      return results;
    }
  }

  // The history is the answer, not a prefix of the whole table: mixing "grinning face" and
  // friends into a list of the user's own emoji makes a personal list look like a random one.
  // A user with no history still gets the data file's order, as every earlier version did.
  if (results.length > 0) {
    return results;
  }

  return entries
    .slice(0, limit)
    .map(([emoji, keywords]: EmojiEntry) => toFindResult({ emoji, keywords, score: 0 }, aliasesByEmoji.get(emoji) ?? []));
}
