// Small seeded RNG so games are reproducible when desired. The internal
// state is exposed via `getState()` / `setState()` so callers can snapshot
// + restore the RNG cursor — this is what the App's undo stack uses to
// make undo+retry deterministic instead of randomized.
export interface Rng {
  next(): number; // [0, 1)
  int(maxExclusive: number): number;
  pick<T>(arr: T[]): T;
  shuffle<T>(arr: T[]): T[];
  getState(): number;
  setState(s: number): void;
}

export function makeRng(seed: number = Date.now()): Rng {
  let state = seed >>> 0;
  const next = () => {
    // mulberry32
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (maxExclusive: number) => Math.floor(next() * maxExclusive);
  return {
    next,
    int,
    pick: <T>(arr: T[]) => arr[int(arr.length)],
    shuffle: <T>(arr: T[]) => {
      const out = arr.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(i + 1);
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
    getState: () => state,
    setState: (s: number) => {
      state = s >>> 0;
    },
  };
}
