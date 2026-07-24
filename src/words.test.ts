import { describe, it, expect, vi } from 'vitest';
import { mintSessionId, WORD_LIST_SIZES } from './words.ts';

// The slug shape `mintSessionId` promises: `adjective-animal`, one hyphen, two
// non-empty lowercase-letter halves. Neither list contains a hyphen, so splitting
// on the single hyphen cleanly recovers each half.
const SLUG_PATTERN = /^[a-z]+-[a-z]+$/;

describe('mintSessionId', () => {
  it('returns an adjective-animal slug: one hyphen, two non-empty halves', () => {
    const id = mintSessionId();
    expect(id).toMatch(SLUG_PATTERN);

    const parts = id.split('-');
    expect(parts).toHaveLength(2);
    const [adjective, animal] = parts;
    expect(adjective).toBeTruthy();
    expect(animal).toBeTruthy();
  });

  it('always mints a well-formed slug of stable lowercase words over many mints', () => {
    // The lists aren't exported individually, so we assert structural membership
    // via the shape: every half is a non-empty run of lowercase letters, each id
    // matches the pattern, and each round-trips through split cleanly. Sampling
    // heavily exercises both `pick` calls across the full range of both lists.
    for (let index = 0; index < 5_000; index += 1) {
      const id = mintSessionId();
      expect(id).toMatch(SLUG_PATTERN);

      const parts = id.split('-');
      expect(parts).toHaveLength(2);
      for (const half of parts) {
        expect(half).toMatch(/^[a-z]+$/);
        expect(half).toBe(half.toLowerCase());
      }
    }
  });

  it('never runs off either end of the word lists (boundary picks stay in-vocab)', () => {
    // Deterministically drive `pick` to each list boundary. `pick` indexes with
    // `Math.floor(random * length)`, so random 0 selects the first element and a
    // value just below 1 selects the last. This is the test the `<=` bound below
    // can't be: an off-by-one that indexed `list[length]` would splice the string
    // `"undefined"` into the slug — which still matches SLUG_PATTERN, so only an
    // explicit "no undefined half" check catches it.
    const spy = vi.spyOn(Math, 'random');
    try {
      spy.mockReturnValue(0); // lowest draw -> first element of each list
      const first = mintSessionId();
      expect(first).toMatch(SLUG_PATTERN);
      expect(first).not.toContain('undefined');

      spy.mockReturnValue(0.999999); // highest draw -> last element of each list
      const last = mintSessionId();
      expect(last).toMatch(SLUG_PATTERN);
      expect(last).not.toContain('undefined');
    } finally {
      spy.mockRestore();
    }
  });

  it('never draws more distinct words than each list holds', () => {
    // A weaker, complementary guard to the boundary test above: over heavy
    // sampling the distinct adjectives/animals seen can't exceed the reported
    // sizes. This catches a `pick` that somehow widened the range; it does NOT
    // catch an off-by-end (that adds the single value `"undefined"`, still within
    // the bound) — the boundary test owns that case.
    const adjectives = new Set<string>();
    const animals = new Set<string>();
    for (let index = 0; index < 20_000; index += 1) {
      const [adjective, animal] = mintSessionId().split('-');
      adjectives.add(adjective!);
      animals.add(animal!);
    }
    expect(adjectives.size).toBeLessThanOrEqual(WORD_LIST_SIZES.adjectives);
    expect(animals.size).toBeLessThanOrEqual(WORD_LIST_SIZES.animals);
  });

  it('produces more than one distinct id across a large sample (pick is not stuck)', () => {
    const ids = new Set<string>();
    for (let index = 0; index < 2_000; index += 1) {
      ids.add(mintSessionId());
    }
    expect(ids.size).toBeGreaterThan(1);
  });
});

describe('WORD_LIST_SIZES', () => {
  // The no-collision-check argument in words.ts rests on the combination count
  // staying large. These bounds document that invariant: shrink either list past
  // them and this test — not a surprise collision in production — catches it.
  it('reports two list lengths, each large enough on its own', () => {
    expect(WORD_LIST_SIZES.adjectives).toBeGreaterThan(150);
    expect(WORD_LIST_SIZES.animals).toBeGreaterThan(150);
  });

  it('backs the no-collision-check argument with a large combination count', () => {
    const combinations = WORD_LIST_SIZES.adjectives * WORD_LIST_SIZES.animals;
    expect(combinations).toBeGreaterThan(40_000);
  });
});
