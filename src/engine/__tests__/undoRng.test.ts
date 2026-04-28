// Regression tests for the undo + RNG-cursor restore pattern. The
// user-reported bug: undo produced randomized results each time because
// only the board state was being restored — the RNG cursor kept advancing.
// These tests prove that after a snapshot/restore round-trip, an action
// that consumes entropy (shuffle, coin flip, random pick) produces the
// SAME outcome as the first execution.

import { describe, it, expect } from "vitest";
import { makeRng } from "../rng";

describe("Rng getState / setState — entropy round-trip", () => {
  it("setState rewinds the cursor so subsequent next() calls reproduce earlier values", () => {
    const rng = makeRng(12345);
    const sequence1 = [rng.next(), rng.next(), rng.next(), rng.next()];

    // Snapshot the state BEFORE the next read.
    const cursor = rng.getState();
    const further = [rng.next(), rng.next(), rng.next()];

    // Rewind and replay — should produce the same `further` sequence.
    rng.setState(cursor);
    const replay = [rng.next(), rng.next(), rng.next()];
    expect(replay).toEqual(further);

    // The original first 4 values must NOT be replayed by setState — that
    // cursor is a different point in the stream. (Sanity: replay doesn't
    // accidentally rewind to t=0.)
    expect(sequence1).not.toEqual(replay);
  });

  it("shuffle is deterministic when the cursor is restored", () => {
    const rng = makeRng(42);
    const arr1 = [1, 2, 3, 4, 5, 6, 7, 8];
    const cursor = rng.getState();
    const shuffled1 = rng.shuffle(arr1);

    // Reset cursor; shuffle the same array → identical permutation.
    rng.setState(cursor);
    const shuffled2 = rng.shuffle(arr1);
    expect(shuffled2).toEqual(shuffled1);
  });

  it("without setState restore, a re-shuffle differs (this is the bug undo had)", () => {
    const rng = makeRng(42);
    const arr = [1, 2, 3, 4, 5, 6, 7, 8];
    const shuffled1 = rng.shuffle(arr);
    // No setState — the cursor advanced. A second shuffle uses different
    // entropy, so the result differs (the original undo bug).
    const shuffled2 = rng.shuffle(arr);
    expect(shuffled2).not.toEqual(shuffled1);
  });

  it("multiple snapshots can be replayed independently", () => {
    const rng = makeRng(7);
    const snap1 = rng.getState();
    const a = rng.shuffle([1, 2, 3, 4, 5]);
    const snap2 = rng.getState();
    const b = rng.shuffle([10, 20, 30, 40, 50]);

    // Replay from snap2 → should produce `b` again.
    rng.setState(snap2);
    expect(rng.shuffle([10, 20, 30, 40, 50])).toEqual(b);

    // Replay from snap1 → produces `a` again, then `b` again on the next.
    rng.setState(snap1);
    expect(rng.shuffle([1, 2, 3, 4, 5])).toEqual(a);
    expect(rng.shuffle([10, 20, 30, 40, 50])).toEqual(b);
  });

  it("getState returns a stable identifier between calls (no hidden mutation)", () => {
    const rng = makeRng(1);
    const a = rng.getState();
    const b = rng.getState();
    expect(a).toBe(b); // reading the cursor must not advance it
  });
});
