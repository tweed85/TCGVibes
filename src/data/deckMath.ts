// Hypergeometric helpers used by Deck Doctor's probability findings.
//
// All functions are pure and deterministic. Numeric stability matters at
// the deck sizes we operate on (60 cards, draws ≤ 13) — straight binomial
// coefficient arithmetic stays inside Number.MAX_SAFE_INTEGER, so a simple
// integer-fraction approach works without bignum.

// ---- Binomial coefficient (n choose k) -------------------------------------
// Multiplicative formula: avoids factorials, avoids large intermediate sums.
function binom(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  // Use the smaller k to minimize iterations and keep intermediates small.
  const kk = Math.min(k, n - k);
  let result = 1;
  for (let i = 1; i <= kk; i++) {
    // Multiply first, then divide — guarantees integer at each step.
    result = (result * (n - kk + i)) / i;
  }
  return result;
}

// ---- Hypergeometric (single bucket) ---------------------------------------
// P(exactly `want` successes in `draws` draws from a `deckSize`-card deck
// containing `successes` success cards).
export function hypergeometric(args: {
  deckSize: number;
  successes: number;
  draws: number;
  want: number;
}): number {
  const { deckSize, successes, draws, want } = args;
  if (deckSize <= 0 || draws < 0 || draws > deckSize) return 0;
  if (want < 0 || want > draws || want > successes) return 0;
  if (draws - want > deckSize - successes) return 0;
  const num = binom(successes, want) * binom(deckSize - successes, draws - want);
  const denom = binom(deckSize, draws);
  return denom === 0 ? 0 : num / denom;
}

// P(at least `atLeast` successes in `draws` draws). Sums the upper tail.
export function oddsAtLeast(
  deckSize: number,
  successes: number,
  draws: number,
  atLeast = 1,
): number {
  if (atLeast <= 0) return 1;
  let p = 0;
  const cap = Math.min(draws, successes);
  for (let k = atLeast; k <= cap; k++) {
    p += hypergeometric({ deckSize, successes, draws, want: k });
  }
  return p;
}

// ---- Multivariate hypergeometric over disjoint buckets --------------------
// `cardRefs` are stable indices into the resolved deck (0..deckSize-1).
// Successes per bucket = cardRefs.length. The "rest of the deck" (cards not
// in any bucket) is treated as one implicit complement bucket with no
// minimum.
//
// Buckets MUST be disjoint. With `assertDisjoint: true` (used in dev/tests),
// the helper builds a Set across all cardRefs and throws if any index appears
// in more than one bucket. Production callers may omit the flag — the caller
// is responsible for passing disjoint buckets; if they overlap, the math
// will be wrong (the helper just won't yell about it).
export function oddsAtLeastOf(
  deckSize: number,
  buckets: ReadonlyArray<{ cardRefs: number[]; atLeast: number }>,
  draws: number,
  opts: { assertDisjoint?: boolean } = {},
): number {
  if (opts.assertDisjoint) {
    const seen = new Set<number>();
    for (const b of buckets) {
      for (const ref of b.cardRefs) {
        if (seen.has(ref)) {
          throw new Error(
            `oddsAtLeastOf: bucket cardRefs are not disjoint (duplicate index ${ref})`,
          );
        }
        seen.add(ref);
      }
    }
  }
  if (draws < 0 || draws > deckSize) return 0;

  const sizes = buckets.map((b) => b.cardRefs.length);
  const minimums = buckets.map((b) => b.atLeast);
  // Each bucket's count must be ≥ atLeast, ≤ size, and ≤ remaining draws.
  // Iterate over all valid count tuples and sum the multivariate hypergeo
  // probability for each.
  const k = buckets.length;
  const restSize =
    deckSize -
    sizes.reduce((acc, s) => acc + s, 0);

  const denom = binom(deckSize, draws);
  if (denom === 0) return 0;

  let total = 0;

  function recurse(i: number, used: number, multiplier: number): void {
    if (i === k) {
      const restNeeded = draws - used;
      if (restNeeded < 0 || restNeeded > restSize) return;
      total += multiplier * binom(restSize, restNeeded);
      return;
    }
    const max = Math.min(sizes[i], draws - used);
    for (let count = minimums[i]; count <= max; count++) {
      recurse(i + 1, used + count, multiplier * binom(sizes[i], count));
    }
  }

  recurse(0, 0, 1);
  return total / denom;
}
