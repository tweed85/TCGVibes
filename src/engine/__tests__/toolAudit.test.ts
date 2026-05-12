// Tool inventory guard.
//
// Every Standard-pool Pokémon Tool must be classified into one of three
// tiers so newly added Tools can't slip in without an explicit coverage
// decision:
//
//   - covered                 full passive/trigger fidelity
//   - approximate             implemented but with a documented
//                             approximation (auto-pick where text says
//                             "choose")
//   - intentionally-passive   Tool is recognized but only contributes
//                             passive math (HP/retreat/damage modifiers);
//                             no triggered logic needed
//   - unsupported             intentionally not yet implemented
//
// If the dataset adds a new Tool name, this test fails until the author
// classifies it. If a name in this table goes missing from the dataset,
// the test also fails — keeps the table from rotting.

import { describe, expect, it } from "vitest";
import { allCards } from "../../data/cards";

type Tier = "covered" | "approximate" | "intentionally-passive" | "unsupported";

const TOOL_CLASSIFICATION: Record<string, Tier> = {
  // Passive HP modifiers — handled in effectiveMaxHp().
  "Ancient Booster Energy Capsule": "intentionally-passive",
  "Cynthia's Power Weight": "intentionally-passive",
  "Hero's Cape": "intentionally-passive",

  // Passive retreat modifiers.
  "Air Balloon": "intentionally-passive",
  "Future Booster Energy Capsule": "intentionally-passive",
  "Gravity Gemstone": "intentionally-passive",
  "Rescue Board": "intentionally-passive",

  // Passive attack-cost / damage modifiers.
  "Binding Mochi": "intentionally-passive",
  "Brave Bangle": "intentionally-passive",
  "Counter Gain": "intentionally-passive",
  "Hop's Choice Band": "intentionally-passive",
  "Light Ball": "intentionally-passive",
  "Maximum Belt": "intentionally-passive",
  "Sparkling Crystal": "intentionally-passive",

  // Passive damage reductions / berries.
  "Babiri Berry": "intentionally-passive",
  "Colbur Berry": "intentionally-passive",
  "Haban Berry": "intentionally-passive",
  "Occa Berry": "intentionally-passive",
  "Passho Berry": "intentionally-passive",
  "Payapa Berry": "intentionally-passive",
  "Sacred Charm": "intentionally-passive",
  "Thick Scale": "intentionally-passive",

  // Triggered tools with full fidelity.
  "Amulet of Hope": "covered", // post-promote deck-search picker (human)
  "Core Memory": "covered", // grants Geobuster
  "Deluxe Bomb": "covered", // single-shot counter on damage
  "Handheld Fan": "covered", // defender-prompt lane (human)
  "Heavy Baton": "covered", // post-promote bench picker (human)
  "Lillie's Pearl": "covered", // KO-trigger prize reduction
  "Lucky Helmet": "covered", // on-damage draw (defender, no choice)
  "Powerglass": "covered", // optional end-turn picker (human)
  "Punk Helmet": "covered", // on-damage counter (no choice)
  "Survival Brace": "covered", // damage cap to 10 HP
  "Team Rocket's Hypnotizer": "covered", // on-damage Asleep
  "Technical Machine: Fluorite": "covered", // grants attack + end-turn discard
};

function standardToolNames(): string[] {
  const names = new Set<string>();
  for (const c of allCards) {
    if (c.supertype !== "Trainer") continue;
    if (!(c.subtypes ?? []).includes("Pokémon Tool")) continue;
    names.add(c.name);
  }
  return [...names].sort();
}

describe("Tool audit guard", () => {
  it("classifies every Standard Pokémon Tool", () => {
    const dataset = standardToolNames();
    const classified = Object.keys(TOOL_CLASSIFICATION).sort();
    expect(
      dataset,
      "Standard Pokémon Tool dataset diverged from the classification table — add new Tools to TOOL_CLASSIFICATION (and update docs/TOOL_AUDIT.md) before merging.",
    ).toEqual(classified);
  });

  it("uses only legal tier values", () => {
    for (const [name, tier] of Object.entries(TOOL_CLASSIFICATION)) {
      expect(
        ["covered", "approximate", "intentionally-passive", "unsupported"],
        `tier for ${name}`,
      ).toContain(tier);
    }
  });
});
