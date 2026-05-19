// Pins archetype detection for every wired Archetype slug. One it() per
// archetype — each gives detectArchetypeFromCardNames a synthetic name set
// representing a competent build of that deck and asserts the right slug
// + a meaningful (medium+) confidence comes back.
//
// Catches two classes of regression:
//   1. SIGNATURES entries that no longer uniquely identify their archetype
//      (e.g. a new archetype shares signature[0] with an older one).
//   2. ARCHETYPE_PROFILES exhaustiveness gaps — adding to the Archetype
//      union without a SIGNATURES row would silently route the deck to
//      "generic", which the medium+ confidence assertion catches.

import { describe, it, expect } from "vitest";
import {
  detectArchetypeFromCardNames,
  type Archetype,
  type Confidence,
} from "../aiArchetype";

// Helper: synthesize a name set from a few core cards. The detection
// algorithm only cares about NAMES in any zone — it doesn't read counts
// or in-play state. A handful of signature names is enough.
function nameSet(...names: string[]): Set<string> {
  return new Set(names);
}

interface Case {
  archetype: Archetype;
  cards: string[];
  // Some archetypes (raging-bolt-ogerpon, slowking-scr) have only 2-3
  // distinctive cards — they max out at "medium" confidence by the
  // sample-based score. Mark them so the test isn't over-strict.
  expectedConfidenceFloor: Exclude<Confidence, never>;
}

const CASES: Case[] = [
  // Stage 1
  {
    archetype: "starmie-dusknoir",
    cards: ["Dusknoir", "Dusclops", "Duskull", "Mega Starmie ex", "Staryu", "Munkidori"],
    expectedConfidenceFloor: "high",
  },
  // Stage 2
  {
    archetype: "n-zoroark",
    cards: ["N's Zoroark ex", "N's Zorua", "N's Reshiram", "N's PP Up", "N's Zekrom"],
    expectedConfidenceFloor: "high",
  },
  {
    archetype: "raging-bolt-ogerpon",
    cards: ["Raging Bolt ex", "Sparkling Crystal", "Teal Mask Ogerpon ex", "Professor Sada's Vitality"],
    expectedConfidenceFloor: "high",
  },
  {
    archetype: "rockets-honchkrow",
    cards: [
      "Team Rocket's Honchkrow",
      "Team Rocket's Murkrow",
      "Team Rocket's Energy",
      "Team Rocket's Proton",
    ],
    expectedConfidenceFloor: "high",
  },
  // Stage 3
  {
    archetype: "okidogi-barbaracle",
    cards: ["Okidogi", "Barbaracle", "Binacle", "Hero's Cape"],
    expectedConfidenceFloor: "high",
  },
  {
    archetype: "slowking-scr",
    cards: ["Slowking", "Slowpoke", "Iono", "Pokémon Center Lady"],
    expectedConfidenceFloor: "high",
  },
  {
    archetype: "lopunny-dudunsparce",
    cards: ["Mega Lopunny ex", "Lopunny", "Buneary", "Dudunsparce ex"],
    expectedConfidenceFloor: "high",
  },
  // Stage 4
  {
    archetype: "greninja-ex",
    cards: ["Mega Greninja ex", "Greninja ex", "Frogadier", "Froakie"],
    expectedConfidenceFloor: "high",
  },
  {
    archetype: "clefairy-ogerpon",
    cards: ["Lillie's Clefairy ex", "Clefairy", "Teal Mask Ogerpon ex", "Buddy-Buddy Poffin"],
    expectedConfidenceFloor: "high",
  },
  {
    archetype: "ogerpon-box",
    cards: [
      "Hearthflame Mask Ogerpon ex",
      "Wellspring Mask Ogerpon ex",
      "Teal Mask Ogerpon ex",
      "Cornerstone Mask Ogerpon ex",
    ],
    expectedConfidenceFloor: "high",
  },
  // Stage 5
  {
    archetype: "stevens-metagross",
    cards: [
      "Steven's Metagross ex",
      "Steven's Metang",
      "Steven's Beldum",
      "Steven's Carbink",
    ],
    expectedConfidenceFloor: "high",
  },
  {
    archetype: "diancie-dusknoir",
    cards: ["Mega Diancie ex", "Diancie", "Dusknoir", "Dusclops"],
    expectedConfidenceFloor: "high",
  },
  {
    archetype: "ursaluna-lunatone",
    cards: ["Bloodmoon Ursaluna ex", "Lunatone", "Solrock", "Maximum Belt"],
    expectedConfidenceFloor: "high",
  },
  {
    archetype: "flareon-noctowl",
    cards: ["Flareon ex", "Noctowl", "Eevee", "Hoothoot"],
    expectedConfidenceFloor: "high",
  },
  // Stage 6
  {
    archetype: "dragapult-ex",
    cards: ["Dragapult ex", "Drakloak", "Dreepy", "Munkidori"],
    expectedConfidenceFloor: "high",
  },
  {
    archetype: "dragapult-dusknoir",
    cards: ["Dragapult ex", "Dusknoir", "Drakloak", "Dusclops", "Duskull"],
    expectedConfidenceFloor: "high",
  },
  {
    archetype: "hydrapple-ogerpon",
    cards: ["Hydrapple ex", "Hydrapple", "Applin", "Teal Mask Ogerpon ex"],
    expectedConfidenceFloor: "high",
  },
  {
    archetype: "ogerpon-meganium",
    cards: ["Mega Meganium ex", "Meganium", "Bayleef", "Chikorita"],
    expectedConfidenceFloor: "high",
  },
  {
    archetype: "mega-absol-box",
    cards: ["Mega Absol ex", "Absol", "Sparkling Crystal", "Maximum Belt"],
    expectedConfidenceFloor: "high",
  },
  {
    archetype: "tera-box",
    cards: [
      "Tera Orb",
      "Mega Charizard X ex",
      "Mega Charizard Y ex",
      "Mega Absol ex",
    ],
    expectedConfidenceFloor: "high",
  },
];

const FLOOR_ORDER: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

describe("detectArchetypeFromCardNames — Stage 1-5 expansion", () => {
  for (const c of CASES) {
    it(`detects ${c.archetype} from its signature cards`, () => {
      const result = detectArchetypeFromCardNames(nameSet(...c.cards));
      expect(result.id).toBe(c.archetype);
      // Confidence floor — pinned so a future SIGNATURES edit that downgrades
      // scoring is caught immediately.
      expect(FLOOR_ORDER[result.confidence]).toBeGreaterThanOrEqual(
        FLOOR_ORDER[c.expectedConfidenceFloor],
      );
    });
  }

  it("does not confuse starmie-dusknoir with mega-starmie-froslass", () => {
    // Pires's deck has Mega Starmie ex AND Risky Ruins AND Staryu (which
    // would match mega-starmie-froslass) — but Dusknoir's signature[0]
    // bonus must push starmie-dusknoir to the top.
    const result = detectArchetypeFromCardNames(
      nameSet(
        "Dusknoir",
        "Dusclops",
        "Duskull",
        "Mega Starmie ex",
        "Staryu",
        "Risky Ruins",
      ),
    );
    expect(result.id).toBe("starmie-dusknoir");
  });

  it("does not confuse diancie-dusknoir with starmie-dusknoir", () => {
    // Both share the Dusknoir line. The Mega Diancie ex anchor is the
    // signature[0] for diancie-dusknoir; starmie-dusknoir's signature[0]
    // is Dusknoir itself. The test pins the deck-with-Mega-Diancie-ex
    // detects correctly.
    const result = detectArchetypeFromCardNames(
      nameSet("Mega Diancie ex", "Diancie", "Dusknoir", "Dusclops", "Duskull"),
    );
    // The Dusknoir signature[0] (starmie-dusknoir) + Dusclops + Duskull
    // would give starmie-dusknoir 5+2+2 = 9; diancie-dusknoir's
    // signature[0] Mega Diancie ex + signature[1] Diancie + signature[2]
    // Dusknoir + signature[3] Dusclops = 5+2+2+2 = 11. Diancie wins.
    expect(result.id).toBe("diancie-dusknoir");
  });

  it("does not confuse dragapult-ex (solo) with dragapult-blaziken", () => {
    // Solo Dragapult ex has no Blaziken ex / Crispin engine. Need
    // dragapult-ex to win when the partner card is absent.
    const result = detectArchetypeFromCardNames(
      nameSet("Dragapult ex", "Drakloak", "Dreepy", "Munkidori"),
    );
    expect(result.id).toBe("dragapult-ex");
  });

  it("does not confuse dragapult-blaziken with dragapult-ex (partner present)", () => {
    // When Blaziken ex IS present, the original blaziken archetype must
    // still win — protected by insertion order (blaziken is in the
    // original 12, dragapult-ex is stage 6, so blaziken comes first in
    // SIGNATURES and wins the tie on Dragapult-line overlaps).
    const result = detectArchetypeFromCardNames(
      nameSet("Dragapult ex", "Drakloak", "Dreepy", "Blaziken ex", "Munkidori"),
    );
    expect(result.id).toBe("dragapult-blaziken");
  });

  it("does not confuse dragapult-dusknoir with starmie-dusknoir (Pires deck)", () => {
    // Pires deck has Mega Starmie ex + Dusknoir but no Dragapult ex —
    // starmie-dusknoir must still win.
    const result = detectArchetypeFromCardNames(
      nameSet(
        "Dusknoir",
        "Dusclops",
        "Duskull",
        "Mega Starmie ex",
        "Staryu",
        "Risky Ruins",
      ),
    );
    expect(result.id).toBe("starmie-dusknoir");
  });

  it("does not confuse dragapult-dusknoir with starmie-dusknoir (Dragapult+Dusknoir deck)", () => {
    // Dragapult-with-Dusknoir-partner deck — Dragapult ex distinguishes
    // it from the Mega Starmie variant.
    const result = detectArchetypeFromCardNames(
      nameSet("Dragapult ex", "Drakloak", "Dreepy", "Dusknoir", "Dusclops", "Duskull"),
    );
    expect(result.id).toBe("dragapult-dusknoir");
  });

  it("does not confuse ogerpon-meganium with arboliva (no Arboliva ex)", () => {
    // Pure ogerpon-meganium deck shouldn't be misdetected as arboliva
    // even though both share Meganium + Teal Mask Ogerpon ex.
    const result = detectArchetypeFromCardNames(
      nameSet("Mega Meganium ex", "Meganium", "Bayleef", "Chikorita", "Teal Mask Ogerpon ex"),
    );
    expect(result.id).toBe("ogerpon-meganium");
  });

  it("does not confuse raging-bolt-ogerpon with arboliva", () => {
    // Both share Teal Mask Ogerpon ex. Raging Bolt ex signature[0] should
    // win when present.
    const result = detectArchetypeFromCardNames(
      nameSet("Raging Bolt ex", "Teal Mask Ogerpon ex", "Sparkling Crystal"),
    );
    expect(result.id).toBe("raging-bolt-ogerpon");
  });

  it("falls back to generic on an empty card set", () => {
    expect(detectArchetypeFromCardNames(new Set()).id).toBe("generic");
  });
});
