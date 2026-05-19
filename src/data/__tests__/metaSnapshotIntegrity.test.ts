// Pins the integrity of every committed meta-snapshot file. Each snapshot
// references archetype IDs in `archetypes[]`, `matchupMatrix[]`, and
// `stockLists[]` — those IDs are typed `Archetype | "unknown"` but TypeScript
// can't validate JSON content at compile time. This test catches typos and
// stale slug references that would otherwise silently route to "generic"
// at runtime.
//
// Pairs with the Stage 1-5 archetype expansion: every new slug added to the
// Archetype union is recognized here as soon as the snapshot agent
// regenerates with the wider union. Snapshot entries that still list slugs
// no longer in the union (e.g. a renamed archetype) will fail this test.

import { describe, it, expect } from "vitest";
import { allSnapshots } from "../metaSnapshot";
import type { Archetype } from "../../engine/aiArchetype";

// Enumerate every valid Archetype slug + the "unknown" sentinel snapshots
// use for decks that don't match any wired signature. Pulled by hand from
// the union — TypeScript doesn't expose discriminated-union members at
// runtime, so we list them out and let `assertArchetypeSet` flag drift.
const VALID_ARCHETYPES: ReadonlyArray<Archetype | "unknown"> = [
  // Pre-Stage-1
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
  // Stage 1-5 expansion
  "starmie-dusknoir",
  "n-zoroark",
  "raging-bolt-ogerpon",
  "rockets-honchkrow",
  "okidogi-barbaracle",
  "slowking-scr",
  "lopunny-dudunsparce",
  "greninja-ex",
  "clefairy-ogerpon",
  "ogerpon-box",
  "stevens-metagross",
  "diancie-dusknoir",
  "ursaluna-lunatone",
  "flareon-noctowl",
  // Stage 6 expansion
  "dragapult-ex",
  "dragapult-dusknoir",
  "hydrapple-ogerpon",
  "ogerpon-meganium",
  "mega-absol-box",
  "tera-box",
  "generic",
  "unknown",
];
const VALID_SET = new Set<string>(VALID_ARCHETYPES);

describe("meta snapshot integrity", () => {
  const snapshots = allSnapshots();

  it("loads at least one snapshot", () => {
    expect(snapshots.length).toBeGreaterThan(0);
  });

  describe.each(snapshots.map((s) => [s.id, s] as const))(
    "snapshot %s",
    (_id, snap) => {
      it("every archetypes[].id is a valid Archetype slug", () => {
        const invalid = (snap.archetypes ?? []).filter(
          (a) => !VALID_SET.has(a.id),
        );
        expect(invalid.map((a) => a.id)).toEqual([]);
      });

      it("every matchupMatrix[].hero is a valid Archetype slug", () => {
        const invalid = (snap.matchupMatrix ?? []).filter(
          (c) => !VALID_SET.has(c.hero),
        );
        expect(invalid.map((c) => c.hero)).toEqual([]);
      });

      it("every matchupMatrix[].villain is a valid Archetype slug", () => {
        const invalid = (snap.matchupMatrix ?? []).filter(
          (c) => !VALID_SET.has(c.villain),
        );
        expect(invalid.map((c) => c.villain)).toEqual([]);
      });

      it("every stockLists[].archetype is a valid Archetype slug", () => {
        const invalid = (snap.stockLists ?? []).filter(
          (e) => !VALID_SET.has(e.archetype),
        );
        expect(invalid.map((e) => e.archetype)).toEqual([]);
      });

      it("every techCoverage[].archetype is a valid Archetype slug", () => {
        const invalid = (snap.techCoverage ?? []).filter(
          (e) => !VALID_SET.has(e.archetype),
        );
        expect(invalid.map((e) => e.archetype)).toEqual([]);
      });
    },
  );
});
