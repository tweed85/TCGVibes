// Item inventory guard.
//
// Every Standard-pool Item card must be classified into one of three tiers
// so newly added Items can't slip in without an explicit coverage decision:
//
//   - covered           full picker / behavior fidelity
//   - approximate       implemented but with documented approximation
//                       (e.g. auto-pick where the card text says "choose")
//   - unsupported       intentionally not yet implemented
//
// If the dataset adds a new Item name, this test fails until the author
// classifies it. If a name in the table goes missing from the dataset,
// the test also fails — keeps the table from rotting.

import { describe, expect, it } from "vitest";
import { allCards } from "../../data/cards";

type Tier = "covered" | "approximate" | "unsupported";

// Source of truth: every Standard Item name must appear here.
//
// "approximate" entries should have a follow-up tracked in
// docs/ITEM_AUDIT.md. Move to "covered" after the picker / fidelity gap
// is closed and the corresponding pin test lands.
const ITEM_CLASSIFICATION: Record<string, Tier> = {
  // Fossils — Basic Pokémon shells; fully covered.
  "Antique Cover Fossil": "covered",
  "Antique Jaw Fossil": "covered",
  "Antique Plume Fossil": "covered",
  "Antique Root Fossil": "covered",
  "Antique Sail Fossil": "covered",

  // Healing
  "Arven's Sandwich": "covered",
  "Dragon Elixir": "covered",
  "Jumbo Ice Cream": "covered",
  "Lumiose Galette": "covered",
  "Poké Vital A": "covered",
  "Potion": "covered",
  "Super Potion": "covered",

  // Search to hand
  "Energy Search": "covered",
  "Fighting Gong": "covered",
  "Hyper Aroma": "covered",
  "Master Ball": "covered",
  "Mega Signal": "covered",
  "Poké Ball": "covered",
  "Poké Pad": "covered",
  "Pokégear 3.0": "covered",
  "Tera Orb": "covered",
  "TM Machine": "covered",
  "Treasure Tracker": "covered",
  "Team Rocket's Great Ball": "covered",
  "Team Rocket's Transceiver": "covered",
  "Ultra Ball": "covered",

  // Search to bench
  "Buddy-Buddy Poffin": "covered",
  "Hop's Bag": "covered",
  "Precious Trolley": "covered",

  // Top/bottom peek
  "Bug Catching Set": "covered",
  "Dusk Ball": "covered",

  // Discard recovery
  "Energy Retrieval": "covered",
  "Max Rod": "covered",
  "Miracle Headset": "covered",
  "Night Stretcher": "covered",

  // ACE SPEC
  "Brilliant Blender": "covered",
  "Prime Catcher": "covered",
  "Secret Box": "covered",
  "Special Red Card": "covered",
  "Unfair Stamp": "covered",

  // Switch / gust
  "Pokémon Catcher": "covered",
  "Repel": "covered",
  "Scoop Up Cyclone": "covered",
  "Switch": "covered",
  "Energy Switch": "covered",

  // Energy denial
  "Crushing Hammer": "covered",
  "Enhanced Hammer": "covered",
  "Megaton Blower": "covered",
  "Tool Scrapper": "covered",

  // Other implemented
  "Awakening Drum": "covered",
  "Boxed Order": "covered",
  "Call Bell": "covered",
  "Dangerous Laser": "covered",
  "Energy Coin": "covered",
  "Energy Search Pro": "covered",
  "Hand Trimmer": "covered",
  "Hole-Digging Shovel": "covered",
  "Iron Defender": "covered",
  "Love Ball": "covered",
  "Meddling Memo": "covered",
  "Ogre's Mask": "covered",
  "Premium Power Pro": "covered",
  "Rare Candy": "covered",
  "Redeemable Ticket": "covered",
  "Roto-Stick": "covered",
  "Team Rocket's Venture Bomb": "covered",
  "Wondrous Patch": "covered",

  // Approximate — implemented but missing a meaningful choice. Each must
  // have a follow-up tracked in docs/ITEM_AUDIT.md.
  "Accompanying Flute": "approximate", // auto-benches every eligible Basic
  "Big Catching Net": "approximate", // auto-recycles Pokémon first
  "Blowtorch": "approximate", // auto-picks discard target
  "Chill Teaser Toy": "approximate", // auto-targets the Energy
  "Deduction Kit": "approximate", // doesn't reorder, only logs
  "Energy Recycler": "approximate", // auto-pulls
  "Energy Swatter": "approximate", // auto-picks Energy to bottom
  "Glass Trumpet": "covered", // discard picker → pendingAttachQueue → per-bench picker
  "N's PP Up": "approximate", // auto-picks Bench N's
  "Reboot Pod": "approximate", // auto-assigns Energy to Future
  "Sacred Ash": "approximate", // auto-picks 5
  "Scramble Switch": "approximate", // switch-target picker exists; Energy transfer is always-move-all (granular choice deferred)
  "Strange Timepiece": "approximate", // auto-picks evolved Psychic
  "Tomes of Transformation": "approximate", // auto-picks Basics
  "Team Rocket's Bother-Bot": "approximate", // cosmetic — doesn't track face-up Prize state
};

function standardItemNames(): string[] {
  const names = new Set<string>();
  for (const c of allCards) {
    if (c.supertype !== "Trainer") continue;
    const subs = c.subtypes ?? [];
    if (!subs.includes("Item")) continue;
    if (subs.includes("Pokémon Tool") || subs.includes("Tool")) continue;
    names.add(c.name);
  }
  return [...names].sort();
}

describe("Item audit guard", () => {
  it("classifies every Standard Item", () => {
    const dataset = standardItemNames();
    const classified = Object.keys(ITEM_CLASSIFICATION).sort();
    expect(
      dataset,
      "Standard Item dataset diverged from the classification table — add new Items to ITEM_CLASSIFICATION (and update docs/ITEM_AUDIT.md) before merging.",
    ).toEqual(classified);
  });

  it("uses only legal tier values", () => {
    for (const [name, tier] of Object.entries(ITEM_CLASSIFICATION)) {
      expect(["covered", "approximate", "unsupported"], `tier for ${name}`).toContain(tier);
    }
  });
});
