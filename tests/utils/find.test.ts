// tests/utils/find.test.ts
//
// The interesting test here is the oracle: a verbatim copy of the v1.2.0 search lives
// at the bottom of this file and the new implementation is checked against it over a
// corpus of queries. Rewriting the hot path is only allowed to make it faster, not to
// change who matches and who ranks first.

import fs from 'node:fs';
import { describe, expect, test } from 'vitest';
import { computeMatchingScore, find } from '../../src/utils/find.js';

const EMOJI_DATA_URL = new URL('../../node_modules/emojilib/dist/emoji-en-US.json', import.meta.url);
const emojiData: Record<string, string[]> = JSON.parse(fs.readFileSync(EMOJI_DATA_URL, 'utf8'));

/** Queries chosen to exercise every branch of the matcher. */
const CORPUS = [
  'smile',
  'face',
  'red heart',
  'heart',
  'happy',
  'cry',
  'thumbs up',
  'yellow',
  'cir',
  ':D',
  'flag',
  'cat',
  'dog',
  'woman technologist',
  'SMILE',
  'zzzzzz',
  'a',
  'e',
  'he'
];

describe('find', () => {
  describe('matching rules', () => {
    test('matches partial words', () => {
      const partial = new Set(find('fac', 1000).map(result => result.emoji));

      // "fac" is a prefix of "face", so it can only ever add matches, never lose one.
      expect(partial.size).toBeGreaterThan(find('face', 1000).length);
      for (const result of find('face', 1000)) {
        expect(partial).toContain(result.emoji);
      }
    });

    test('requires every typed word to match', () => {
      const both = find('red heart', 1000);
      const onlyRed = find('red', 1000);

      expect(both.length).toBeGreaterThan(0);
      expect(both.length).toBeLessThan(onlyRed.length);
    });

    test('is case insensitive', () => {
      expect(find('SMILE', 1000)).toEqual(find('smile', 1000));
    });

    test('collapses repeated whitespace instead of matching everything', () => {
      expect(find('red  heart', 1000)).toEqual(find('red heart', 1000));
    });

    test('handles queries with no letters', () => {
      // Known limitation, unchanged by this rewrite: input is lowercased but a few
      // keywords in the data file are not (":D"), so an uppercase symbol can never
      // be typed back. Searchable symbols still work.
      expect(find('$XD', 1000)).toEqual([]);
      expect(find(':D', 1000)).toEqual([]);
      expect(find('heart', 1000).length).toBeGreaterThan(0);
    });

    test('returns nothing for input that matches nothing', () => {
      expect(find('zzzzzz', 1000)).toEqual([]);
    });

    test('an empty query lists the whole table', () => {
      expect(find('')).toHaveLength(Object.keys(emojiData).length);
    });
  });

  describe('ranking', () => {
    test('sorts by descending score', () => {
      const scores = find('car', 1000).map(result => result.score);

      expect(scores.length).toBeGreaterThan(1);
      expect(scores).toEqual([...scores].sort((first, second) => second - first));
    });

    test('keeps the best matches when limited', () => {
      const unlimited = find('face', 1000);
      const limited = find('face', 10);

      expect(limited).toHaveLength(10);
      expect(limited).toEqual(unlimited.slice(0, 10));
    });

    test('a limit above the number of matches returns everything', () => {
      expect(find('smile', 10_000)).toHaveLength(find('smile').length);
    });

    test('a limit of zero returns nothing', () => {
      expect(find('smile', 0)).toEqual([]);
    });

    test('matches on the emoji name outrank matches on a synonym', () => {
      // "grinning_face" is the name of 😀, so "face" scores on the doubled first
      // keyword; a face that merely lists "face" among its synonyms ranks lower.
      expect(find('happy face', 3).map(result => result.emoji)).toContain('😀');
    });
  });

  describe('shape', () => {
    test('the first keyword becomes the title and the rest the subtitle', () => {
      const smilingFace = find('grinning face', 1000)
        .find(result => result.emoji === '😀');

      expect(smilingFace).toEqual({
        emoji: '😀',
        title: 'Grinning Face',
        subtitle: 'Face, Smile, Happy, Joy, :D, Grin, Smiley',
        score: expect.any(Number)
      });
    });

    test('works without an explicit limit', () => {
      expect(find('smile').length).toBe(find('smile', Number.POSITIVE_INFINITY).length);
    });
  });

  describe('the user\'s own aliases', () => {
    test('an alias finds its emoji as if it were one of its names', () => {
      const found = find('swole', 10, { aliases: { swole: '💪' } });

      expect(found[0]?.emoji).toBe('💪');
    });

    test('the alias is shown, so an unexpected result does not look like a mistake', () => {
      const [first] = find('swole', 1, { aliases: { swole: '💪' } });

      expect(first?.alias).toBe('swole');
      expect(first?.subtitle).toContain('swole');
    });

    test('an alias does not make the emoji harder to find by its own name', () => {
      const withAlias = find('thumbs up', 5, { aliases: { swole: '💪' } });
      const withoutAlias = find('thumbs up', 5);

      expect(withAlias.map((entry) => entry.emoji)).toEqual(withoutAlias.map((entry) => entry.emoji));
    });

    test('no aliases behaves exactly as before', () => {
      expect(find('smile', 5, {})).toEqual(find('smile', 5));
    });

    test('an alias for an emoji that is not in the data file is simply never matched', () => {
      expect(find('swole', 10, { aliases: { swole: '🫠🫠' } })).toEqual([]);
    });
  });

  describe('an empty query', () => {
    test('shows what the user actually picks, most used first', () => {
      const found = find('', 5, {
        usage: {
          '🚀': { count: 9, lastUsedAt: 100 },
          '🙈': { count: 2, lastUsedAt: 900 }
        }
      });

      expect(found.slice(0, 2).map((entry) => entry.emoji)).toEqual(['🚀', '🙈']);
      // And the list is not short: the rest of the table fills it up as it always did.
      expect(found).toHaveLength(5);
    });

    test('breaks ties on how recently it was used', () => {
      const found = find('', 2, {
        usage: {
          '🚀': { count: 3, lastUsedAt: 100 },
          '🙈': { count: 3, lastUsedAt: 900 }
        }
      });

      expect(found.map((entry) => entry.emoji)).toEqual(['🙈', '🚀']);
    });

    test('the used emoji are scored above the rest, so Flow keeps them on top', () => {
      const found = find('', 3, { usage: { '🚀': { count: 1, lastUsedAt: 1 } } });

      expect(found[0]?.emoji).toBe('🚀');
      expect(found[0]?.score).toBeGreaterThan(found[1]?.score ?? 0);
    });

    test('with no history it is the data file order, unchanged', () => {
      const [first] = Object.entries(emojiData);

      expect(find('', 5, {}).map((entry) => entry.emoji)).toEqual(find('', 5).map((entry) => entry.emoji));
      expect(find('', 5)[0]?.emoji).toBe(first?.[0]);
    });

    test('an entry the data file no longer has is skipped, not a crash', () => {
      const found = find('', 2, { usage: { '🫠🫠': { count: 99, lastUsedAt: 1 } } });

      expect(found).toHaveLength(2);
      expect(found.every((entry) => entry.emoji !== '🫠🫠')).toBe(true);
    });
  });

  describe('against the v1.2.0 implementation', () => {
    test.each(CORPUS)('same results, same order, for %j', (input) => {
      const expected = legacyFind(input)
        .map(result => ({
          emoji: result.emoji,
          title: result.title,
          subtitle: result.keywords.join(', '),
          score: result.score
        }))
        // The old comparator never returned 0 for equal scores, so its tie order is
        // arbitrary. Compare both lists sorted the correct way instead.
        .sort((first, second) => second.score - first.score);

      expect(find(input)).toEqual(expected);
    });

    test('an empty query lists the same emoji, in the data file order', () => {
      // The old code scored the empty string against every keyword part, so entries
      // with more keywords sorted first. Ranking by nothing is meaningless, so the new
      // implementation keeps the data order. The set is unchanged.
      expect(new Set(find('').map(result => result.emoji)))
        .toEqual(new Set(legacyFind('').map(result => result.emoji)));
      expect(find('').map(result => result.emoji)).toEqual(Object.keys(emojiData));
    });
  });
});

describe('computeMatchingScore', () => {
  test('input similar to keywords returns a higher score than input with less similarities', () => {
    const inputs = ['car'];
    const highScore = computeMatchingScore(inputs, ['police_car', 'vehicle', 'cars', 'transportation', 'law']);
    const lowScore = computeMatchingScore(inputs, ['fearful_face', 'face', 'scared', 'terrified']);

    expect(highScore).toBeGreaterThan(lowScore);
  });

  test('an exact keyword part scores higher than a partial one', () => {
    expect(computeMatchingScore(['face'], ['face'])).toBeGreaterThan(
      computeMatchingScore(['face'], ['surface'])
    );
  });

  test('scores the first keyword twice as much as the others', () => {
    expect(computeMatchingScore(['face'], ['face', 'other']))
      .toBeGreaterThan(computeMatchingScore(['face'], ['other', 'face']));
  });

  test('no match scores zero', () => {
    expect(computeMatchingScore(['zzzzzz'], ['face', 'smile'])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Reference implementation: src/utils/find.ts as of v1.2.0, unchanged.
// Do not optimise this. It is the thing being compared against.
// ---------------------------------------------------------------------------

function legacyMatchesKeyword (inputs: string[], keywords: string[]): boolean {
  return inputs.every(input =>
    keywords.some(keyword =>
      keyword.includes(input)
    )
  );
}

function legacyComputeMatchingScore (inputs: string[], keywords: string[]): number {
  let score = 0;
  let keywordIndex = 0;

  for (const keyword of keywords) {
    for (const keywordPart of keyword.split('_')) {
      for (const input of inputs) {
        if (keywordPart.includes(input)) {
          score++;

          if (keywordPart === input) {
            score += 5;
          }
        }

        if (keywordPart.startsWith(input)) {
          score++;
        }
      }
    }

    if (keywordIndex === 0) {
      score *= 2;
    }

    keywordIndex++;
  }

  return score;
}

function legacyFind (input: string): Array<{ title: string, keywords: string[], emoji: string, score: number }> {
  const result: Array<{ title: string, keywords: string[], emoji: string, score: number }> = [];
  const normalizedInput = input.toLowerCase();
  const inputs = new Set(normalizedInput.split(' '));

  for (const [emoji, keywords] of Object.entries(emojiData)) {
    if (legacyMatchesKeyword(Array.from(inputs), keywords)) {
      const enhancedKeywords = keywords.map(keyword => keyword.replaceAll('_', ' ').split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' '));
      const title = enhancedKeywords[0];

      result.push({
        title: title ?? '',
        keywords: enhancedKeywords.slice(1),
        emoji,
        score: legacyComputeMatchingScore(Array.from(inputs), keywords)
      });
    }
  }

  return result.sort((a, b) => a.score > b.score ? -1 : 1);
}
