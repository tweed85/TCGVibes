// Integrity guards for the committed meta snapshot. The snapshot is
// produced by the META_SNAPSHOT_AGENT (run periodically) and consumed
// by DeckDoctor's Field tab + matchup grading. These tests catch
// hand-edit typos and schema drift that the TypeScript compiler can't
// see through the JSON-import boundary.

import { describe, it, expect } from "vitest";
import snapshot from "../metaSnapshots/2026-05.json";
import type { Archetype } from "../../engine/aiArchetype";

// The valid `Archetype | "unknown"` value set, kept in lockstep with
// src/engine/aiArchetype.ts. The exhaustiveness of this list is
// enforced indirectly: a typo in any snapshot field that should hold
// an Archetype slug will fail the includes() check below.
const VALID_ARCHETYPE_IDS: readonly (Archetype | "unknown")[] = [
  "festival-leads",
  "arboliva",
  "alakazam",
  "lucario-ex",
  "rocket-mewtwo",
  "dragapult-blaziken",
  "dragapult-dudunsparce",
  "crustle",
  "cynthia-garchomp",
  "grimmsnarl-froslass",
  "mega-starmie-froslass",
  "hops-trevenant",
  "generic",
  "unknown",
] as const;

const validIds = new Set<string>(VALID_ARCHETYPE_IDS);

describe("metaSnapshot integrity (2026-05)", () => {
  it("every archetype id in archetypes[] is a valid Archetype slug", () => {
    for (const a of snapshot.archetypes) {
      expect(validIds.has(a.id), `archetypes[].id "${a.id}" not in Archetype union`).toBe(true);
    }
  });

  it("every matchupMatrix hero/villain is a valid Archetype slug", () => {
    for (const cell of snapshot.matchupMatrix) {
      expect(
        validIds.has(cell.hero),
        `matchupMatrix.hero "${cell.hero}" not in Archetype union`,
      ).toBe(true);
      expect(
        validIds.has(cell.villain),
        `matchupMatrix.villain "${cell.villain}" not in Archetype union`,
      ).toBe(true);
    }
  });

  it("every stockLists[].archetype is a valid Archetype slug", () => {
    for (const list of snapshot.stockLists) {
      expect(
        validIds.has(list.archetype),
        `stockLists[].archetype "${list.archetype}" not in Archetype union`,
      ).toBe(true);
    }
  });

  it("every tournaments[].topFinishes[].archetype is a valid Archetype slug or 'unknown'", () => {
    for (const t of snapshot.tournaments) {
      if (!t.topFinishes) continue;
      for (const f of t.topFinishes) {
        expect(
          validIds.has(f.archetype),
          `tournaments[${t.id}].topFinishes "${f.player}" archetype "${f.archetype}" invalid`,
        ).toBe(true);
        expect(typeof f.finish, "topFinishes.finish must be a number").toBe("number");
        expect(f.finish, "topFinishes.finish must be ≥ 1").toBeGreaterThanOrEqual(1);
        expect(f.player, "topFinishes.player must be non-empty").toBeTruthy();
      }
    }
  });

  it("unknownArchetypeShare is a probability in [0, 1]", () => {
    expect(snapshot.unknownArchetypeShare).toBeGreaterThanOrEqual(0);
    expect(snapshot.unknownArchetypeShare).toBeLessThanOrEqual(1);
  });

  it("tournaments[].date strings parse as valid ISO dates", () => {
    for (const t of snapshot.tournaments) {
      const parsed = Date.parse(t.date);
      expect(Number.isFinite(parsed), `tournaments[${t.id}].date "${t.date}" failed Date.parse`).toBe(true);
    }
  });
});
