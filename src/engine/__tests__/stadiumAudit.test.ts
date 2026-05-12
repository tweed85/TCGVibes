// Stadium inventory guard.
//
// Every Standard-pool Stadium card must be classified into one of four
// tiers so newly added Stadiums can't slip in without an explicit
// coverage decision:
//
//   - passive       no activated effect — only continuous modifiers
//   - activated     activated effect with a faithful picker / behavior
//   - approximate   activated effect implemented but with a documented
//                   approximation (e.g. auto-pick where text says
//                   "choose")
//   - unsupported   intentionally not yet implemented
//
// Activated entries additionally must have a matching key in
// STADIUM_EFFECTS (tested separately by reading the source). If a name
// in this table goes missing from the dataset, the test fails — keeps
// the table from rotting.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allCards } from "../../data/cards";

type Tier = "passive" | "activated" | "approximate" | "unsupported";

const STADIUM_CLASSIFICATION: Record<string, Tier> = {
  // Passive HP/retreat/damage/etc. modifiers.
  "Ange Floette": "passive",
  "Area Zero Underdepths": "passive",
  "Battle Cage": "passive",
  "Dizzying Valley": "passive",
  "Festival Grounds": "passive",
  "Forest of Vitality": "passive",
  "Full Metal Lab": "passive",
  "Granite Cave": "passive",
  "Gravity Mountain": "passive",
  "Jamming Tower": "passive",
  "Lively Stadium": "passive",
  "N's Castle": "passive",
  "Neutralization Zone": "passive",
  "Nighttime Mine": "passive",
  "Paradise Resort": "passive",
  "Perilous Jungle": "passive",
  "Postwick": "passive",
  "Risky Ruins": "passive",
  "Team Rocket's Watchtower": "passive",

  // Activated with full picker fidelity.
  "Academy at Night": "activated",
  "Community Center": "activated",
  "Levincia": "activated",
  "Lumiose City": "activated",
  "Mystery Garden": "activated",
  "Prism Tower": "activated",
  "Spikemuth Gym": "activated",
  "Team Rocket's Factory": "activated",

  // Activated but with documented approximations — see
  // docs/STADIUM_AUDIT.md.
  "Grand Tree": "approximate", // AI chain scoring is heuristic; human path has full picker + per-player T1 gate
  "Surfing Beach": "approximate", // AI ranks Water bench by energy/damage; human path has picker
};

function standardStadiumNames(): string[] {
  const names = new Set<string>();
  for (const c of allCards) {
    if (c.supertype !== "Trainer") continue;
    if (!(c.subtypes ?? []).includes("Stadium")) continue;
    names.add(c.name);
  }
  return [...names].sort();
}

describe("Stadium audit guard", () => {
  it("classifies every Standard Stadium", () => {
    const dataset = standardStadiumNames();
    const classified = Object.keys(STADIUM_CLASSIFICATION).sort();
    expect(
      dataset,
      "Standard Stadium dataset diverged from the classification table — add new Stadiums to STADIUM_CLASSIFICATION (and update docs/STADIUM_AUDIT.md) before merging.",
    ).toEqual(classified);
  });

  it("uses only legal tier values", () => {
    for (const [name, tier] of Object.entries(STADIUM_CLASSIFICATION)) {
      expect(["passive", "activated", "approximate", "unsupported"], `tier for ${name}`).toContain(tier);
    }
  });

  it("every activated/approximate Stadium has a STADIUM_EFFECTS entry", () => {
    // Read the source rather than importing private state, so the test
    // doesn't depend on STADIUM_EFFECTS being exported.
    const src = readFileSync("src/engine/stadiumActivated.ts", "utf8");
    for (const [name, tier] of Object.entries(STADIUM_CLASSIFICATION)) {
      if (tier !== "activated" && tier !== "approximate") continue;
      expect(
        src.includes(`"${name}"`),
        `${name} is classified ${tier} but is not present in stadiumActivated.ts.`,
      ).toBe(true);
    }
  });
});
