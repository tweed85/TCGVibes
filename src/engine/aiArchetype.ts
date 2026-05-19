// Archetype awareness for the v2 AI. Each curated deck has a distinctive
// game plan that a tournament-level player executes specifically rather
// than the generic "build then attack" greedy. This module:
//   1. Detects the archetype of a player's deck from signature cards.
//   2. Exposes per-archetype score adjustments that the main AI loop
//      applies when `aiVersion === "v2"`.
//
// Signature cards are sourced from CLAUDE.md + the deck specs in
// src/data/decks.ts. Detection runs once per turn and is memoized in
// `state._archetypeCache` (a non-serialized convenience field). For v1
// callers, the entry points are inert (return Generic / 0).

import type { Card, EnergyType, GameState, PlayerId, PokemonInPlay, TrainerCard } from "./types";

// Shared confidence union — Deck Doctor reads this so we don't end up with
// two parallel definitions or an engine→data type-import boundary cross.
export type Confidence = "high" | "medium" | "low";

export type Archetype =
  | "festival-leads"
  | "arboliva"
  | "alakazam"
  | "lucario-ex"
  | "rocket-mewtwo"
  | "dragapult-blaziken"
  | "dragapult-dudunsparce"
  | "crustle"
  | "cynthia-garchomp"
  | "grimmsnarl-froslass"
  | "mega-starmie-froslass"
  | "hops-trevenant"
  // ---- Stage 1-5 expansion (May 2026 meta) — wired from labs/snapshot
  // unknown-archetype detail. Coverage notes flagged each of these as a
  // meaningful share of the Standard field; wiring them moves detection
  // off `generic` and unlocks archetype-aware AI bonuses.
  | "starmie-dusknoir"
  | "n-zoroark"
  | "raging-bolt-ogerpon"
  | "rockets-honchkrow"
  | "okidogi-barbaracle"
  | "slowking-scr"
  | "lopunny-dudunsparce"
  | "greninja-ex"
  | "clefairy-ogerpon"
  | "ogerpon-box"
  | "stevens-metagross"
  | "diancie-dusknoir"
  | "ursaluna-lunatone"
  | "flareon-noctowl"
  // ---- Stage 6 expansion — the 2 Dragapult variants + 4 box decks the
  // labs data flagged as the remaining big unknown buckets. Wire ordering:
  // dragapult-ex / dragapult-dusknoir are placed AFTER the existing
  // dragapult-blaziken / dragapult-dudunsparce so partner decks win on
  // tie-broken Dragapult ex + Drakloak overlaps.
  | "dragapult-ex"
  | "dragapult-dusknoir"
  | "hydrapple-ogerpon"
  | "ogerpon-meganium"
  | "mega-absol-box"
  | "tera-box"
  | "generic";

// Distinctive cards that flag a deck as an archetype. The first match wins;
// signatures are ordered by how unambiguous each is.
const SIGNATURES: Record<Exclude<Archetype, "generic">, string[]> = {
  // Dipplin's "Festival Lead" ability + Festival Grounds is the deck's
  // entire plan; either card alone is a strong tell.
  "festival-leads": ["Festival Grounds", "Dipplin", "Thwackey"],
  // Arboliva ex is the unique attacker; Forest of Vitality + Teal Mask
  // Ogerpon ex are the ramp engine.
  "arboliva": ["Arboliva ex", "Teal Mask Ogerpon ex", "Forest of Vitality"],
  // Alakazam's Powerful Hand attack is unique to this archetype; Battle
  // Cage + Dudunsparce form the bench shield + draw engine.
  "alakazam": ["Alakazam ex", "Alakazam", "Battle Cage", "Dudunsparce"],
  // Mega Lucario ex Aura Jab → Mega Brave under Premium Power Pro.
  "lucario-ex": ["Mega Lucario ex", "Premium Power Pro", "Riolu"],
  // Team Rocket's Mewtwo / Spidops — TR-Pokemon scaling deck. Sourced from
  // Prague Regional 2026 R9 replay. Signature is the TR Mewtwo ex finisher
  // + the Tarountula→Spidops energy-discard ramp.
  "rocket-mewtwo": [
    "Team Rocket's Mewtwo ex",
    "Team Rocket's Spidops",
    "Team Rocket's Tarountula",
    "Team Rocket's Energy",
  ],
  // Dragapult ex / Blaziken ex / Munkidori — stall + Stage 2 setup deck.
  // Slow archetype: leads with Budew Itchy Pollen item-lock while the
  // Drakloak line evolves. Signature is the unique Dragapult ex Phantom
  // Dive finisher + the Blaziken ex energy-acceleration line.
  "dragapult-blaziken": [
    "Dragapult ex",
    "Drakloak",
    "Blaziken ex",
    "Munkidori",
  ],
  // Mateusz Łaszkiewicz's Prague Regional 2026 CHAMPION list. Dragapult ex
  // primary attacker with Dudunsparce ex as the anti-Crustle Destructive
  // Drill bypass (3-energy, 150 dmg, ignores all opp effects). Hero's Cape
  // ACE SPEC on the 1-prize Dudunsparce — forces opp into 2-attack KOs.
  // Dudunsparce ex is signature[0] (unique attacker) so detection prefers
  // this over plain dragapult-blaziken when both Dragapult ex + Dudunsparce
  // ex are present.
  "dragapult-dudunsparce": [
    "Dudunsparce ex",
    "Dragapult ex",
    "Drakloak",
    "Hero's Cape",
  ],
  // Elmar Tresp's Prague Regional 2026 finalist deck. Mysterious Rocking
  // Inability walls all EX attackers; Crustle stacks Growing Grass / Spiky
  // Energy + heals via Pokémon Center Lady / Colress's Tenacity. Mega
  // Kangaskhan ex is the rapid-fire backup attacker. Plan inverted from
  // typical aggro: WALL until opp is at 1-2 prizes, then attack.
  "crustle": [
    "Crustle",
    "Dwebble",
    "Cornerstone Mask Ogerpon ex",
    "Mega Kangaskhan ex",
  ],
  // Neddy Kosek's "Cynthia's Garchomp ex" — Top 4 Prague 2026. Cynthia's-
  // prefix engine: Cynthia's Gabite tutors more line members, Cynthia's
  // Roserade accelerates energy. Garchomp ex Corkscrew Dive (attack + draw)
  // enables aggressive Boss's Orders pre-commitment.
  "cynthia-garchomp": [
    "Cynthia's Garchomp ex",
    "Cynthia's Gabite",
    "Cynthia's Gible",
    "Cynthia's Roserade",
  ],
  // Nicklas Rosu's "Marnie's Grimmsnarl ex" — Top 16 Prague 2026. Marnie's-
  // prefix engine + Spikemuth Gym (item-lock-immune stadium-search).
  // Froslass Freezing Shroud passive bench damage. Punk Up energy accel
  // on evolution.
  "grimmsnarl-froslass": [
    "Marnie's Grimmsnarl ex",
    "Marnie's Morgrem",
    "Marnie's Impidimp",
    "Spikemuth Gym",
  ],
  // Lorenzo Zanchi's "Mega Starmie ex / Mega Froslass ex" — 32nd Prague
  // 2026. Risky Ruins stadium passive 2-counter spread per turn + Jetting
  // Blow 50-dmg bench snipe = compound damage threat. Mega Froslass ex
  // scales by opp hand size (devastates post-Iono).
  "mega-starmie-froslass": [
    "Mega Starmie ex",
    "Risky Ruins",
    "Mega Froslass ex",
    "Staryu",
  ],
  // "Hop's Trevenant" — Prague Regional 2026 community list. Hop's
  // Trevenant's Horrifying Revenge
  // (30+, +100 if any of your Hop's Pokémon were KO'd last turn) is the
  // unique attacker — turns lost prizes into 130-dmg counter-attacks.
  // Postwick stadium + Hop's Choice Band tool layer +30/+30 onto every
  // Hop's attack; Hop's Snorlax's Extra Helpings ability adds another +30.
  // Telepathic Psychic Energy is a Buddy-Buddy-Poffin-on-an-energy combo
  // (attach + search 2 Basic Psychic to bench).
  "hops-trevenant": [
    "Hop's Trevenant",
    "Hop's Phantump",
    "Postwick",
    "Hop's Choice Band",
  ],
  // Pires's Mega Starmie ex / Dusknoir variant — Prague Top 8. Dusknoir's
  // Cursed Blast is the EX-immunity bypass that distinguishes this from
  // Zanchi's Mega Starmie / Mega Froslass build. Dusknoir line as signature[0]
  // ensures detection prefers this when both Mega Starmie ex + Dusknoir
  // are present (otherwise mega-starmie-froslass would steal the match).
  "starmie-dusknoir": ["Dusknoir", "Dusclops", "Duskull", "Mega Starmie ex"],
  // N's-prefix engine + Zoroark ex Trade ability. The N's-prefix
  // family (N's Zorua / Zoroark ex / Reshiram / Zekrom / PP Up) gates
  // detection unambiguously — no other archetype runs these.
  "n-zoroark": ["N's Zoroark ex", "N's Zorua", "N's Reshiram", "N's PP Up"],
  // Raging Bolt ex + Teal Mask Ogerpon ex Wellspring-style energy ramp.
  // Raging Bolt ex is the unique attacker; Teal Mask Ogerpon ex is shared
  // with Arboliva so it's signature[2] not signature[0]. Sparkling Crystal
  // tool layer + Squawkabilly ex draw fills the rest.
  "raging-bolt-ogerpon": [
    "Raging Bolt ex",
    "Sparkling Crystal",
    "Teal Mask Ogerpon ex",
    "Professor Sada's Vitality",
  ],
  // Team Rocket's-prefix engine pivoting on Honchkrow's bench snipe.
  // Distinct from rocket-mewtwo which runs the Spidops ramp + Mewtwo ex
  // finisher — Honchkrow is the alternative TR-Psychic build.
  "rockets-honchkrow": [
    "Team Rocket's Honchkrow",
    "Team Rocket's Murkrow",
    "Team Rocket's Energy",
    "Team Rocket's Proton",
  ],
  // Okidogi Settle the Score + Barbaracle Reef Bypass / Surfing Beatdown.
  // Okidogi is the toxic-status setup; Barbaracle is the Stage 1 attacker.
  // Both are 1-prize attackers under Hero's Cape tool stacking.
  "okidogi-barbaracle": ["Okidogi", "Barbaracle", "Binacle", "Hero's Cape"],
  // Slowking-SCR Calming Aroma engine — single-prize control deck. No ex
  // Pokémon; wins via Iono'd-hand-shaped status disruption. Slowking is
  // signature[0] (unique attacker) since plain Slowking is rare outside
  // this archetype.
  "slowking-scr": ["Slowking", "Slowpoke", "Iono", "Pokémon Center Lady"],
  // Mega Lopunny ex's Mega Punch + Dudunsparce ex Destructive Drill EX
  // bypass. Lopunny + Mega Lopunny ex evolve line + 1-prize Dudunsparce ex
  // give a 2-attacker plan that mirrors dragapult-dudunsparce in playstyle
  // but uses the Lopunny mega base instead of Dragapult ex.
  "lopunny-dudunsparce": [
    "Mega Lopunny ex",
    "Lopunny",
    "Buneary",
    "Dudunsparce ex",
  ],
  // Mega Greninja ex's Ninja Spinner / Mortal Shuriken setup. Frogadier
  // and Froakie are the bench seed; Greninja ex is the Stage 1 backup.
  // Distinct from any other deck — only this archetype runs the Froakie
  // family.
  "greninja-ex": ["Mega Greninja ex", "Greninja ex", "Frogadier", "Froakie"],
  // Lillie's Clefairy ex + Teal Mask Ogerpon ex Wellspring energy ramp.
  // The Clefairy-line ex is signature[0] — Teal Mask Ogerpon ex is shared
  // with Arboliva and Raging Bolt, so it's signature[2] for tie-breaking.
  "clefairy-ogerpon": [
    "Lillie's Clefairy ex",
    "Clefairy",
    "Teal Mask Ogerpon ex",
    "Buddy-Buddy Poffin",
  ],
  // All-Ogerpon multi-mask toolbox. Distinct from Arboliva (which is
  // Teal-Mask-only) and Raging Bolt / Clefairy variants (which have a
  // partner ex). The tell is multiple mask Ogerpons in one deck.
  "ogerpon-box": [
    "Hearthflame Mask Ogerpon ex",
    "Wellspring Mask Ogerpon ex",
    "Teal Mask Ogerpon ex",
    "Cornerstone Mask Ogerpon ex",
  ],
  // Steven's-prefix Metagross ex line. Steven's Beldum → Steven's Metang
  // → Steven's Metagross ex with Steven's Carbink / Skarmory utility.
  // No other archetype runs the Steven's-prefix engine.
  "stevens-metagross": [
    "Steven's Metagross ex",
    "Steven's Metang",
    "Steven's Beldum",
    "Steven's Carbink",
  ],
  // Mega Diancie ex + Dusknoir Cursed Blast. Diancie is signature[0]
  // (unique attacker) so detection differentiates from starmie-dusknoir.
  // Both share the Dusknoir line; Diancie's Mega line is the
  // distinguishing card.
  "diancie-dusknoir": ["Mega Diancie ex", "Diancie", "Dusknoir", "Dusclops"],
  // Bloodmoon Ursaluna ex Blood Moon + Lunatone draw ability. Solrock
  // and Lunatone are paired bench utilities; Bloodmoon Ursaluna ex is the
  // unique attacker (no other archetype builds around it).
  "ursaluna-lunatone": [
    "Bloodmoon Ursaluna ex",
    "Lunatone",
    "Solrock",
    "Maximum Belt",
  ],
  // Flareon ex Bright Flame + Noctowl draw engine. Eevee branches into
  // Flareon ex; Hoothoot evolves into Noctowl for the in-play draw
  // ability. Flareon ex is signature[0].
  "flareon-noctowl": ["Flareon ex", "Noctowl", "Eevee", "Hoothoot"],
  // ---- Stage 6 expansion -------------------------------------------------
  // Solo Dragapult ex — no partner attacker. Munkidori is the bench-draw
  // workhorse most solo lists run. Comes AFTER dragapult-blaziken /
  // dragapult-dudunsparce so partner-attacker decks win on tied
  // Dragapult ex + Drakloak overlaps.
  "dragapult-ex": ["Dragapult ex", "Drakloak", "Dreepy", "Munkidori"],
  // Dragapult ex + Dusknoir line — Cursed Blast partner for the EX
  // bypass plan. Signature[0] is Dragapult ex (not Dusknoir) so this
  // wins against starmie-dusknoir when Mega Starmie is absent and beats
  // dragapult-ex when Dusknoir is present.
  "dragapult-dusknoir": ["Dragapult ex", "Dusknoir", "Drakloak", "Dusclops"],
  // Hydrapple ex Stage 2 + Teal Mask Ogerpon ex ramp. Hydrapple ex is
  // unique; Applin is shared with festival-leads but only as a non-sig
  // card there. Signature[0] is Hydrapple ex.
  "hydrapple-ogerpon": [
    "Hydrapple ex",
    "Hydrapple",
    "Applin",
    "Teal Mask Ogerpon ex",
  ],
  // Mega Meganium ex Stage 2 + Teal Mask Ogerpon ex. Distinct from
  // arboliva (which runs Arboliva ex as signature[0]); the tell here is
  // Mega Meganium ex as the unique attacker.
  "ogerpon-meganium": [
    "Mega Meganium ex",
    "Meganium",
    "Bayleef",
    "Chikorita",
  ],
  // Mega Absol ex single-attacker box. Sparkling Crystal is shared with
  // raging-bolt-ogerpon (which has Raging Bolt ex as signature[0]) so no
  // collision there.
  "mega-absol-box": [
    "Mega Absol ex",
    "Absol",
    "Sparkling Crystal",
    "Maximum Belt",
  ],
  // Tera Pokémon toolbox — multiple Mega-prefix Tera attackers piloted
  // off Tera Orb. Detection is best-effort: Tera Orb is broadly used by
  // many decks, so this archetype is more reliable when paired with
  // multiple Mega-ex bodies in the same list. Placed LAST so more
  // specific Mega box archetypes (mega-absol-box, ogerpon-box) win ties.
  "tera-box": [
    "Tera Orb",
    "Mega Charizard X ex",
    "Mega Charizard Y ex",
    "Mega Absol ex",
  ],
};

// ---- Archetype profiles --------------------------------------------------
//
// Per-archetype context for Deck Doctor. The AI's score adjustments live
// further down this file (archetypeTrainerBonus / playbookCardBonus / etc.)
// and operate independently from these profiles — profiles are about deck
// CONSTRUCTION (what cards a structurally-healthy deck of this archetype
// should run), not in-game decisions.
//
// Profiles intentionally lean small: each lists the cards whose absence
// would be a real "this isn't that deck" signal (`core`), the pillars a
// healthy build is expected to ship (`support`), common techs that don't
// hurt to flag-as-missing-but-not-required (`tech`), and variant-specific
// optional cards we never flag (`optional`). `mainAttackers` overrides the
// damage-≥-100 heuristic so control / wall plans aren't misread.

export interface ArchetypeProfile {
  id: Archetype;
  core: string[];
  support: string[];
  tech: string[];
  optional: string[];
  mainAttackers: string[];
  preferredAttacks?: Record<string, string[]>;
  energyPlan?: {
    attackers: string[];
    requiredTypes: EnergyType[];
    acceleration: string[];
    manualEnergyIsThinOk?: boolean;
  };
  notes?: string[];
  expectedExceptions?: Array<{ id: string; reason: string }>;
}

// v1 profiles deliberately leave `core` / `support` / `tech` / `optional`
// empty: archetype-specific "must-have" lists are valuable but high-curation
// against a moving card pool. The load-bearing fields for v1 are
// `mainAttackers` (overrides damage-≥-100 heuristic for control / wall
// plans), `energyPlan` (drives suppression of energy.attacker-cant-be-paid
// and energy.thin-supply when the deck is meant to accelerate), and
// `notes` (context surfaced in the report's composition card). Future work
// can populate the lists once the dataset settles.
const NO_CARDS: string[] = [];

export const ARCHETYPE_PROFILES: Record<Exclude<Archetype, "generic">, ArchetypeProfile> = {
  "festival-leads": {
    id: "festival-leads",
    core: NO_CARDS, support: NO_CARDS, tech: NO_CARDS, optional: NO_CARDS,
    mainAttackers: ["Dipplin", "Thwackey"],
    energyPlan: {
      attackers: ["Dipplin", "Thwackey"],
      requiredTypes: ["Grass"],
      acceleration: [],
      manualEnergyIsThinOk: true,
    },
    notes: [
      "Twin-hit Festival Lead engine — minimal energy is intentional; attacks are mostly Colorless or 1-Grass.",
    ],
  },
  "arboliva": {
    id: "arboliva",
    core: NO_CARDS, support: NO_CARDS, tech: NO_CARDS, optional: NO_CARDS,
    mainAttackers: ["Arboliva ex", "Teal Mask Ogerpon ex"],
    energyPlan: {
      attackers: ["Arboliva ex", "Teal Mask Ogerpon ex"],
      requiredTypes: ["Grass"],
      acceleration: ["Teal Mask Ogerpon ex", "Forest of Vitality"],
    },
    notes: ["Teal Mask Ogerpon ex's Energy Reserves accelerates the Grass plan."],
  },
  "alakazam": {
    id: "alakazam",
    core: NO_CARDS, support: NO_CARDS, tech: NO_CARDS, optional: NO_CARDS,
    mainAttackers: ["Alakazam ex", "Alakazam"],
    energyPlan: {
      attackers: ["Alakazam ex"],
      requiredTypes: ["Psychic"],
      acceleration: [],
    },
  },
  "lucario-ex": {
    id: "lucario-ex",
    core: NO_CARDS, support: NO_CARDS, tech: NO_CARDS, optional: NO_CARDS,
    mainAttackers: ["Mega Lucario ex"],
    energyPlan: {
      attackers: ["Mega Lucario ex"],
      requiredTypes: ["Fighting"],
      acceleration: ["Fighting Gong"],
    },
    notes: ["Mega Brave attack scales with Premium Power Pro tool layer."],
  },
  "rocket-mewtwo": {
    id: "rocket-mewtwo",
    core: NO_CARDS, support: NO_CARDS, tech: NO_CARDS, optional: NO_CARDS,
    mainAttackers: ["Team Rocket's Mewtwo ex"],
    energyPlan: {
      attackers: ["Team Rocket's Mewtwo ex"],
      requiredTypes: ["Psychic"],
      acceleration: ["Team Rocket's Spidops"],
    },
    notes: ["Tarountula→Spidops energy-discard ramp powers Mewtwo's Psydrive."],
  },
  "dragapult-blaziken": {
    id: "dragapult-blaziken",
    core: NO_CARDS, support: NO_CARDS, tech: NO_CARDS, optional: NO_CARDS,
    mainAttackers: ["Dragapult ex"],
    energyPlan: {
      attackers: ["Dragapult ex"],
      requiredTypes: ["Fire", "Psychic"],
      acceleration: ["Blaziken ex", "Crispin"],
    },
    notes: ["Blaziken ex Charging Up + Crispin tutor is the energy-acceleration line."],
  },
  "dragapult-dudunsparce": {
    id: "dragapult-dudunsparce",
    core: NO_CARDS, support: NO_CARDS, tech: NO_CARDS, optional: NO_CARDS,
    mainAttackers: ["Dragapult ex", "Dudunsparce ex"],
    energyPlan: {
      attackers: ["Dragapult ex", "Dudunsparce ex"],
      requiredTypes: ["Fire", "Psychic"],
      acceleration: [],
    },
    notes: [
      "Hero's Cape ACE SPEC on the 1-prize Dudunsparce — forces opp into 2-attack KOs.",
    ],
  },
  "crustle": {
    id: "crustle",
    core: NO_CARDS, support: NO_CARDS, tech: NO_CARDS, optional: NO_CARDS,
    mainAttackers: ["Crustle", "Cornerstone Mask Ogerpon ex", "Mega Kangaskhan ex"],
    energyPlan: {
      attackers: ["Crustle", "Cornerstone Mask Ogerpon ex", "Mega Kangaskhan ex"],
      requiredTypes: ["Fighting", "Colorless"],
      acceleration: [],
      manualEnergyIsThinOk: true,
    },
    notes: [
      "Wall-first plan: Mysterious Rocking Inability blocks EX attackers; the deck wins on prize math, not raw damage.",
    ],
    expectedExceptions: [
      {
        id: "energy.attacker-cant-be-paid",
        reason:
          "Crustle is a wall plan; its main attackers' costs are paid via stalling rather than a normal energy curve.",
      },
      {
        id: "prob.mulligan-rate",
        reason:
          "Crustle's wall plan accepts a high mulligan rate — the deck wins via setup over time, not opening speed.",
      },
    ],
  },
  "cynthia-garchomp": {
    id: "cynthia-garchomp",
    core: NO_CARDS, support: NO_CARDS, tech: NO_CARDS, optional: NO_CARDS,
    mainAttackers: ["Cynthia's Garchomp ex"],
    energyPlan: {
      attackers: ["Cynthia's Garchomp ex"],
      requiredTypes: ["Fighting", "Grass"],
      acceleration: ["Cynthia's Roserade"],
    },
    notes: ["Cynthia's Roserade accelerates energy onto the Garchomp line."],
  },
  "grimmsnarl-froslass": {
    id: "grimmsnarl-froslass",
    core: NO_CARDS, support: NO_CARDS, tech: NO_CARDS, optional: NO_CARDS,
    mainAttackers: ["Marnie's Grimmsnarl ex"],
    energyPlan: {
      attackers: ["Marnie's Grimmsnarl ex"],
      requiredTypes: ["Darkness"],
      acceleration: ["Punk Up"],
    },
    notes: [
      "Punk Up energy acceleration on evolution; Spikemuth Gym is item-lock-immune stadium search.",
    ],
  },
  "mega-starmie-froslass": {
    id: "mega-starmie-froslass",
    core: NO_CARDS, support: NO_CARDS, tech: NO_CARDS, optional: NO_CARDS,
    mainAttackers: ["Mega Starmie ex", "Mega Froslass ex"],
    energyPlan: {
      attackers: ["Mega Starmie ex", "Mega Froslass ex"],
      requiredTypes: ["Water", "Psychic"],
      acceleration: [],
    },
    notes: [
      "Risky Ruins passive 2-counter spread + Jetting Blow snipe stack into compound damage.",
    ],
  },
  "hops-trevenant": {
    id: "hops-trevenant",
    core: NO_CARDS, support: NO_CARDS, tech: NO_CARDS, optional: NO_CARDS,
    mainAttackers: ["Hop's Trevenant"],
    preferredAttacks: {
      "Hop's Trevenant": ["Horrifying Revenge"],
    },
    energyPlan: {
      attackers: ["Hop's Trevenant"],
      requiredTypes: ["Psychic"],
      acceleration: ["Telepathic Psychic Energy"],
    },
    notes: [
      "Single-prize attackers; Telepathic Psychic Energy is Buddy-Buddy-Poffin-on-an-energy.",
    ],
  },
  // ---- Stage 1-5 expansion ------------------------------------------------
  // Profiles are intentionally lean per CLAUDE.md guidance — core / support /
  // tech / optional left empty until the dataset settles. The load-bearing
  // fields are `mainAttackers` + `energyPlan.requiredTypes`, which the deck
  // doctor uses to suppress false-positive energy / attacker warnings.
  "starmie-dusknoir": {
    id: "starmie-dusknoir",
    core: NO_CARDS, support: NO_CARDS, tech: NO_CARDS, optional: NO_CARDS,
    mainAttackers: ["Mega Starmie ex", "Dusknoir"],
    energyPlan: {
      attackers: ["Mega Starmie ex", "Dusknoir"],
      requiredTypes: ["Water", "Psychic"],
      acceleration: [],
    },
    notes: [
      "Dusknoir Cursed Blast bypasses EX-immunity (Crustle); Mega Starmie ex Jetting Blow is primary.",
    ],
    expectedExceptions: [
      {
        id: "energy.attacker-cant-be-paid",
        reason:
          "Dusknoir's Psychic cost is paid via Ignition / Legacy Energy (any-type providers), which the energy-supply check doesn't model. The Pires Top-8 build runs no basic Psychic and relies on this workaround.",
      },
    ],
  },
  "n-zoroark": {
    id: "n-zoroark",
    core: NO_CARDS, support: NO_CARDS, tech: NO_CARDS, optional: NO_CARDS,
    mainAttackers: ["N's Zoroark ex", "N's Reshiram", "N's Zekrom"],
    energyPlan: {
      attackers: ["N's Reshiram", "N's Zekrom", "N's Zoroark ex"],
      requiredTypes: ["Fire", "Lightning"],
      acceleration: ["N's PP Up"],
    },
    notes: [
      "N's Zoroark ex Trade ability + N's-prefix attackers; N's PP Up is the energy ramp.",
    ],
  },
  "raging-bolt-ogerpon": {
    id: "raging-bolt-ogerpon",
    core: NO_CARDS, support: NO_CARDS, tech: NO_CARDS, optional: NO_CARDS,
    mainAttackers: ["Raging Bolt ex"],
    energyPlan: {
      attackers: ["Raging Bolt ex"],
      requiredTypes: ["Lightning", "Grass"],
      acceleration: ["Teal Mask Ogerpon ex", "Professor Sada's Vitality"],
    },
    notes: [
      "Sada's Vitality + Teal Mask Ogerpon ex acceleration into Raging Bolt ex's Bellowing Thunder.",
    ],
  },
  "rockets-honchkrow": {
    id: "rockets-honchkrow",
    core: NO_CARDS, support: NO_CARDS, tech: NO_CARDS, optional: NO_CARDS,
    mainAttackers: ["Team Rocket's Honchkrow"],
    energyPlan: {
      attackers: ["Team Rocket's Honchkrow"],
      requiredTypes: ["Darkness"],
      acceleration: [],
    },
    notes: [
      "TR engine + Honchkrow bench snipe. Proton is the T1 enabler (T1-supporter exception).",
    ],
  },
  "okidogi-barbaracle": {
    id: "okidogi-barbaracle",
    core: NO_CARDS, support: NO_CARDS, tech: NO_CARDS, optional: NO_CARDS,
    mainAttackers: ["Okidogi", "Barbaracle"],
    energyPlan: {
      attackers: ["Okidogi", "Barbaracle"],
      requiredTypes: ["Darkness", "Fighting"],
      acceleration: [],
    },
    notes: [
      "1-prize attacker pair; Hero's Cape ACE SPEC stacks HP on Barbaracle for 2-attack-KO denial.",
    ],
  },
  "slowking-scr": {
    id: "slowking-scr",
    core: NO_CARDS, support: NO_CARDS, tech: NO_CARDS, optional: NO_CARDS,
    mainAttackers: ["Slowking"],
    energyPlan: {
      attackers: ["Slowking"],
      requiredTypes: ["Psychic"],
      acceleration: [],
      manualEnergyIsThinOk: true,
    },
    notes: [
      "Single-prize control plan; Calming Aroma ability heals each turn. Wins on prize math, not raw damage.",
    ],
    expectedExceptions: [
      {
        id: "energy.attacker-cant-be-paid",
        reason:
          "Slowking control is a stall plan — attack costs are paid via setup turns, not via energy curve.",
      },
    ],
  },
  "lopunny-dudunsparce": {
    id: "lopunny-dudunsparce",
    core: NO_CARDS, support: NO_CARDS, tech: NO_CARDS, optional: NO_CARDS,
    mainAttackers: ["Mega Lopunny ex", "Dudunsparce ex"],
    energyPlan: {
      attackers: ["Mega Lopunny ex", "Dudunsparce ex"],
      requiredTypes: ["Colorless"],
      acceleration: [],
    },
    notes: [
      "Lopunny ex evolve line + 1-prize Dudunsparce ex Destructive Drill EX bypass.",
    ],
  },
  "greninja-ex": {
    id: "greninja-ex",
    core: NO_CARDS, support: NO_CARDS, tech: NO_CARDS, optional: NO_CARDS,
    mainAttackers: ["Mega Greninja ex", "Greninja ex"],
    energyPlan: {
      attackers: ["Mega Greninja ex", "Greninja ex"],
      requiredTypes: ["Water"],
      acceleration: [],
    },
    notes: [
      "Mega Greninja ex Mortal Shuriken; Greninja ex Stage 1 backup. Frogadier/Froakie seed.",
    ],
  },
  "clefairy-ogerpon": {
    id: "clefairy-ogerpon",
    core: NO_CARDS, support: NO_CARDS, tech: NO_CARDS, optional: NO_CARDS,
    mainAttackers: ["Lillie's Clefairy ex", "Teal Mask Ogerpon ex"],
    energyPlan: {
      attackers: ["Lillie's Clefairy ex", "Teal Mask Ogerpon ex"],
      requiredTypes: ["Psychic", "Grass"],
      acceleration: ["Teal Mask Ogerpon ex"],
    },
    notes: [
      "Lillie's Clefairy ex + Teal Mask Ogerpon ex ramp. Two-type attacker spread.",
    ],
  },
  "ogerpon-box": {
    id: "ogerpon-box",
    core: NO_CARDS, support: NO_CARDS, tech: NO_CARDS, optional: NO_CARDS,
    mainAttackers: [
      "Hearthflame Mask Ogerpon ex",
      "Wellspring Mask Ogerpon ex",
      "Teal Mask Ogerpon ex",
      "Cornerstone Mask Ogerpon ex",
    ],
    energyPlan: {
      attackers: [
        "Hearthflame Mask Ogerpon ex",
        "Wellspring Mask Ogerpon ex",
        "Teal Mask Ogerpon ex",
        "Cornerstone Mask Ogerpon ex",
      ],
      requiredTypes: ["Fire", "Water", "Grass", "Fighting"],
      acceleration: ["Teal Mask Ogerpon ex"],
    },
    notes: [
      "Multi-mask toolbox — pick the right Ogerpon for the matchup.",
    ],
  },
  "stevens-metagross": {
    id: "stevens-metagross",
    core: NO_CARDS, support: NO_CARDS, tech: NO_CARDS, optional: NO_CARDS,
    mainAttackers: ["Steven's Metagross ex"],
    energyPlan: {
      attackers: ["Steven's Metagross ex"],
      requiredTypes: ["Metal"],
      acceleration: [],
    },
    notes: [
      "Steven's-prefix Stage 2 evolution engine. Beldum → Metang → Metagross ex.",
    ],
  },
  "diancie-dusknoir": {
    id: "diancie-dusknoir",
    core: NO_CARDS, support: NO_CARDS, tech: NO_CARDS, optional: NO_CARDS,
    mainAttackers: ["Mega Diancie ex", "Dusknoir"],
    energyPlan: {
      attackers: ["Mega Diancie ex", "Dusknoir"],
      requiredTypes: ["Psychic"],
      acceleration: [],
    },
    notes: [
      "Mega Diancie ex + Dusknoir Cursed Blast EX-immunity bypass.",
    ],
  },
  "ursaluna-lunatone": {
    id: "ursaluna-lunatone",
    core: NO_CARDS, support: NO_CARDS, tech: NO_CARDS, optional: NO_CARDS,
    mainAttackers: ["Bloodmoon Ursaluna ex"],
    energyPlan: {
      attackers: ["Bloodmoon Ursaluna ex"],
      requiredTypes: ["Fighting"],
      acceleration: [],
    },
    notes: [
      "Bloodmoon Ursaluna ex Blood Moon; Lunatone/Solrock draw + setup engine.",
    ],
  },
  "flareon-noctowl": {
    id: "flareon-noctowl",
    core: NO_CARDS, support: NO_CARDS, tech: NO_CARDS, optional: NO_CARDS,
    mainAttackers: ["Flareon ex"],
    energyPlan: {
      attackers: ["Flareon ex"],
      requiredTypes: ["Fire"],
      acceleration: [],
    },
    notes: [
      "Flareon ex Bright Flame; Noctowl in-play draw engine.",
    ],
  },
  // ---- Stage 6 expansion --------------------------------------------------
  "dragapult-ex": {
    id: "dragapult-ex",
    core: NO_CARDS, support: NO_CARDS, tech: NO_CARDS, optional: NO_CARDS,
    mainAttackers: ["Dragapult ex"],
    energyPlan: {
      attackers: ["Dragapult ex"],
      requiredTypes: ["Fire", "Psychic"],
      acceleration: [],
    },
    notes: [
      "Solo Dragapult ex variant — no partner attacker; relies on Munkidori bench draw.",
    ],
  },
  "dragapult-dusknoir": {
    id: "dragapult-dusknoir",
    core: NO_CARDS, support: NO_CARDS, tech: NO_CARDS, optional: NO_CARDS,
    mainAttackers: ["Dragapult ex", "Dusknoir"],
    energyPlan: {
      attackers: ["Dragapult ex", "Dusknoir"],
      requiredTypes: ["Fire", "Psychic"],
      acceleration: [],
    },
    notes: [
      "Dragapult ex Phantom Dive + Dusknoir Cursed Blast EX-immunity bypass.",
    ],
    expectedExceptions: [
      {
        id: "energy.attacker-cant-be-paid",
        reason:
          "Dusknoir's Psychic cost is paid via Ignition / Legacy Energy (any-type providers), which the energy-supply check doesn't model.",
      },
    ],
  },
  "hydrapple-ogerpon": {
    id: "hydrapple-ogerpon",
    core: NO_CARDS, support: NO_CARDS, tech: NO_CARDS, optional: NO_CARDS,
    mainAttackers: ["Hydrapple ex"],
    energyPlan: {
      attackers: ["Hydrapple ex"],
      requiredTypes: ["Grass"],
      acceleration: ["Teal Mask Ogerpon ex"],
    },
    notes: [
      "Hydrapple ex Stage 2 attacker + Teal Mask Ogerpon ex energy ramp.",
    ],
  },
  "ogerpon-meganium": {
    id: "ogerpon-meganium",
    core: NO_CARDS, support: NO_CARDS, tech: NO_CARDS, optional: NO_CARDS,
    mainAttackers: ["Mega Meganium ex"],
    energyPlan: {
      attackers: ["Mega Meganium ex", "Teal Mask Ogerpon ex"],
      requiredTypes: ["Grass"],
      acceleration: ["Teal Mask Ogerpon ex"],
    },
    notes: [
      "Mega Meganium ex Stage 2 attacker + Teal Mask Ogerpon ex acceleration.",
    ],
  },
  "mega-absol-box": {
    id: "mega-absol-box",
    core: NO_CARDS, support: NO_CARDS, tech: NO_CARDS, optional: NO_CARDS,
    mainAttackers: ["Mega Absol ex"],
    energyPlan: {
      attackers: ["Mega Absol ex"],
      requiredTypes: ["Darkness"],
      acceleration: [],
    },
    notes: [
      "Mega Absol ex single-attacker box with Sparkling Crystal cost reduction.",
    ],
  },
  "tera-box": {
    id: "tera-box",
    core: NO_CARDS, support: NO_CARDS, tech: NO_CARDS, optional: NO_CARDS,
    mainAttackers: ["Mega Charizard X ex", "Mega Charizard Y ex", "Mega Absol ex"],
    energyPlan: {
      // Tera box is multi-type by design; the deck doctor's
      // requiredTypes check is meant to flag "you don't have energy for
      // your attacker" — a box deck genuinely runs all the types its
      // attackers need, so leaving this empty plus manualEnergyIsThinOk
      // suppresses the false positive.
      attackers: ["Mega Charizard X ex", "Mega Charizard Y ex", "Mega Absol ex"],
      requiredTypes: [],
      acceleration: [],
      manualEnergyIsThinOk: true,
    },
    notes: [
      "Tera Pokémon toolbox — Tera Orb tutors any of multiple Mega-ex attackers.",
    ],
  },
};

// Pure name-set detection. Used by both the AI (which gathers names from a
// live GameState) and Deck Doctor (which gathers names from a `Card[]`).
// Returns the archetype id and a confidence band derived from the score:
//   ≥ 5  → high   (unique-attacker signature[0] hit, plus at least one more)
//   ≥ 3  → medium
//   ≥ 2  → low    (the bare commit threshold; could be a coincidence)
//   < 2  → generic / low
export function detectArchetypeFromCardNames(
  names: Set<string>,
): { id: Archetype; confidence: Confidence } {
  let bestArch: Archetype = "generic";
  let bestScore = 0;
  for (const [arch, sigs] of Object.entries(SIGNATURES) as [Exclude<Archetype, "generic">, string[]][]) {
    let score = 0;
    sigs.forEach((sig, i) => {
      if (names.has(sig)) score += i === 0 ? 5 : 2;
    });
    if (score > bestScore) {
      bestScore = score;
      bestArch = arch;
    }
  }
  if (bestScore < 2) return { id: "generic", confidence: "low" };
  const confidence: Confidence =
    bestScore >= 5 ? "high" : bestScore >= 3 ? "medium" : "low";
  return { id: bestArch, confidence };
}

// Archetype detection. Scans every zone (deck, hand, discard, prizes,
// in-play) for signature card NAMES. Returns the archetype with the most
// signature matches, weighted toward unique attackers (signature[0]).
//
// Wraps `detectArchetypeFromCardNames` so the AI's name-set construction
// path stays unchanged while sharing the scoring with Deck Doctor.
export function detectArchetype(state: GameState, player: PlayerId): Archetype {
  const pl = state.players[player];
  const all: Card[] = [
    ...pl.deck,
    ...pl.hand,
    ...pl.discard,
    ...pl.prizes,
  ];
  if (pl.active) all.push(pl.active.card);
  for (const p of pl.bench) all.push(p.card);
  const names = new Set(all.map((c) => c.name));
  return detectArchetypeFromCardNames(names).id;
}

// Cached archetype lookup. Stored on a non-serialized field so it survives
// re-renders but doesn't bloat snapshots / clones.
interface ArchetypeCache {
  byPlayer: Record<PlayerId, { turn: number; arch: Archetype } | undefined>;
}
function cache(state: GameState): ArchetypeCache {
  const s = state as GameState & { _archetypeCache?: ArchetypeCache };
  if (!s._archetypeCache) {
    s._archetypeCache = { byPlayer: { p1: undefined, p2: undefined } };
  }
  return s._archetypeCache;
}

export function archetypeOf(state: GameState, player: PlayerId): Archetype {
  const c = cache(state);
  const cached = c.byPlayer[player];
  if (cached && cached.turn === state.turn) return cached.arch;
  const arch = detectArchetype(state, player);
  c.byPlayer[player] = { turn: state.turn, arch };
  return arch;
}

// Should v2 logic apply? Gate central enough that future toggles route
// through this single check.
export function v2Active(state: GameState, player: PlayerId): boolean {
  return state.players[player].aiVersion === "v2";
}

// ---- Score adjustments ---------------------------------------------------

// Trainer bonus: nudges the AI toward archetype-defining Trainers but
// keeps the magnitudes modest so generic scoring still dominates when
// the situation calls for a non-archetype play (e.g., emergency heal).
// Tuned down from the initial +60s after the first benchmark run showed
// over-aggressive bonuses pulling the AI off-plan in mid-game.
export function archetypeTrainerBonus(
  arch: Archetype,
  card: TrainerCard,
): number {
  switch (arch) {
    case "festival-leads":
      if (card.name === "Festival Grounds") return 30;
      if (card.name === "Buddy-Buddy Poffin") return 12;
      if (card.name === "Lillie's Determination") return 8;
      return 0;
    case "arboliva":
      if (card.name === "Forest of Vitality") return 30;
      if (card.name === "Rare Candy") return 15;
      if (card.name === "Buddy-Buddy Poffin") return 12;
      return 0;
    case "alakazam":
      if (card.name === "Battle Cage") return 30;
      if (card.name === "Rare Candy") return 18;
      return 0;
    case "lucario-ex":
      if (card.name === "Premium Power Pro") return 30;
      if (card.name === "Maximum Belt") return 12;
      if (card.name === "Fighting Gong") return 10;
      return 0;
    case "rocket-mewtwo":
      // Proton is the T1 enabler (T1-supporter exception, searches 3 TR
      // Basics to hand — preserves Ariana scaling next turn).
      if (card.name === "Team Rocket's Proton") return 28;
      // Ariana is the T2 draw engine (8 cards if all in-play are TR).
      if (card.name === "Team Rocket's Ariana") return 24;
      // Transceiver tutors a TR supporter — typically Ariana for T2.
      if (card.name === "Team Rocket's Transceiver") return 18;
      // Giovanni gust + draw 2 is the T3 board-control supporter.
      if (card.name === "Team Rocket's Giovanni") return 16;
      // Maximum Belt is the ACE SPEC finisher tutoring damage onto Psydrive.
      if (card.name === "Maximum Belt") return 14;
      if (card.name === "Team Rocket's Archer") return 10;
      if (card.name === "Team Rocket's Factory") return 8;
      return 0;
    case "dragapult-blaziken":
      // Crispin tutors Fire-and-Psychic-energy pair — the deck's primary
      // energy-acceleration trainer.
      if (card.name === "Crispin") return 22;
      // Lillie's Determination + Poffin power the slow setup turns.
      if (card.name === "Lillie's Determination") return 18;
      if (card.name === "Buddy-Buddy Poffin") return 16;
      // Rare Candy skips the Drakloak step — critical for T2/T3 Phantom Dive.
      if (card.name === "Rare Candy") return 16;
      if (card.name === "Boss's Orders") return 14;
      if (card.name === "Counter Catcher") return 12;
      return 0;
    case "dragapult-dudunsparce":
      // Lillie's Determination is the T2 draw refill (post-Buddy-Buddy).
      if (card.name === "Lillie's Determination") return 22;
      // Buddy-Buddy Poffin tutors the Dreepy + Munkidori T1 bench.
      if (card.name === "Buddy-Buddy Poffin") return 20;
      // Rare Candy bypasses Drakloak — crucial for T3 Phantom Dive.
      if (card.name === "Rare Candy") return 18;
      // Boss's Orders gusts opp setup Pokémon (Roselia / Dwebble / Munkidori).
      if (card.name === "Boss's Orders") return 16;
      // Pokégear 3.0 chains into supporters when no draw in hand.
      if (card.name === "Pokégear 3.0") return 12;
      // Brock's Scouting can grab Dreepy + Dudunsparce together (Evolution branch).
      if (card.name === "Brock's Scouting") return 12;
      // Erratic Machinations — Mateusz famously discarded 16 cards in finals
      // G2 to refresh hand. Situationally massive when hand stalls.
      if (card.name === "Erratic Machinations") return 10;
      // Night Stretcher retrieves a KO'd Dudunsparce + an energy.
      if (card.name === "Night Stretcher") return 10;
      // Hero's Cape ACE SPEC — preferred over Unfair Stamp (1-prize buffer).
      if (card.name === "Hero's Cape") return 22;
      return 0;
    case "crustle":
      // Pokégear 3.0 chains into the deck's toolbox supporters.
      if (card.name === "Pokégear 3.0") return 22;
      // Lillie's Determination — primary T1 draw refill.
      if (card.name === "Lillie's Determination") return 20;
      // Buddy-Buddy Poffin tutors the wide Dwebble bench.
      if (card.name === "Buddy-Buddy Poffin") return 18;
      // Hilda — toolbox supporter, situational draw / search.
      if (card.name === "Hilda") return 14;
      // Brock's Scouting hits Evolution branch when Dwebble→Crustle is teed up.
      if (card.name === "Brock's Scouting") return 14;
      // Pokémon Center Lady is the wall-phase healer.
      if (card.name === "Pokémon Center Lady") return 16;
      // Healing and defensive Tools preserve the wall phase.
      if (card.name === "Jumbo Ice Cream") return 14;
      if (card.name === "Super Potion") return 12;
      if (card.name === "Powerglass") return 14;
      if (card.name.endsWith("Berry")) return 10;
      if (card.name === "Sparkling Crystal") return 12;
      // Colress's Tenacity chains stadium → energy (refills lost stadium).
      if (card.name === "Colress's Tenacity") return 14;
      // Boss's Orders sniped opp setup pieces in the wall phase.
      if (card.name === "Boss's Orders") return 12;
      // Hero's Cape on Crustle = 250 HP wall.
      if (card.name === "Hero's Cape") return 24;
      return 0;
    case "cynthia-garchomp":
      // Cynthia is the deck's signature engine supporter (energy refill / draw).
      if (card.name === "Cynthia") return 26;
      // Buddy-Buddy Poffin double-played T1 sets up the Gible + Roselia bench.
      if (card.name === "Buddy-Buddy Poffin") return 22;
      // Boss's Orders converts Garchomp's Corkscrew Dive into prize trades.
      if (card.name === "Boss's Orders") return 16;
      // Rare Candy can skip Gabite step on a T3 Garchomp swing.
      if (card.name === "Rare Candy") return 14;
      // Cynthia's Power Weight — HP buffer on the Garchomp line.
      if (card.name === "Cynthia's Power Weight") return 12;
      // Unfair Stamp — Netti's variant-defining ACE SPEC.
      if (card.name === "Unfair Stamp") return 18;
      return 0;
    case "grimmsnarl-froslass":
      // Spikemuth Gym — item-lock-immune stadium-search; deck's signature
      // recovery tool against Budew lines.
      if (card.name === "Spikemuth Gym") return 28;
      // Lillie's Determination — primary T2 draw refill.
      if (card.name === "Lillie's Determination") return 22;
      // Buddy-Buddy Poffin tutors the Marnie's Impidimp + Munkidori bench.
      if (card.name === "Buddy-Buddy Poffin") return 20;
      // Petrel — Order Up tutor target. Toolbox supporter access.
      if (card.name === "Petrel") return 16;
      // Boss's Orders converts Shadow Bullet's spread into prize trades.
      if (card.name === "Boss's Orders") return 14;
      // Poké Pad tutors non-rule-box (Munkidori) — keeps options open.
      if (card.name === "Poké Pad") return 12;
      return 0;
    case "mega-starmie-froslass":
      // Risky Ruins — deck's signature accelerator. Compounds Jetting Blow
      // bench snipe into KO range against evolving basics.
      if (card.name === "Risky Ruins") return 30;
      // Crispin attaches 2 different basic energies — primary acceleration.
      if (card.name === "Crispin") return 22;
      // Lillie's Determination — T2 draw refill.
      if (card.name === "Lillie's Determination") return 20;
      // Buddy-Buddy Poffin tutors the Staryu + Snorunt + Munkidori bench.
      if (card.name === "Buddy-Buddy Poffin") return 18;
      // Boss's Orders converts spread damage into KOs.
      if (card.name === "Boss's Orders") return 16;
      return 0;
    case "hops-trevenant":
      // Postwick — signature stadium, +30 to Hop's Pokémon attacks. Always
      // worth dropping early; even if opp bumps, you have 4 copies.
      if (card.name === "Postwick") return 28;
      // Hop's Choice Band — signature tool. Cost reduction (-1C) PLUS +30
      // to active. Routine T2 attach.
      if (card.name === "Hop's Choice Band") return 24;
      // Lillie's Determination — primary draw engine. Deck has no Pidgeot/
      // Bibarel-style draw, so Lillie's is the only "draw 8" hand reset.
      if (card.name === "Lillie's Determination") return 22;
      // Hop's Bag — deck-fill item: search 2 Basic Hop's Pokémon to bench.
      // Critical for setting up redundant Phantump lines.
      if (card.name === "Hop's Bag") return 20;
      // Boss's Orders — finisher gust; Trevenant's Horrifying Revenge KO
      // ranges depend on hitting the right target.
      if (card.name === "Boss's Orders") return 18;
      // Team Rocket's Petrel — Order Up tutor for any supporter (acts as a
      // 5th Lillie's / extra Hassel).
      if (card.name === "Team Rocket's Petrel") return 14;
      // Poké Pad — non-rule-box tutor. Hits Phantump / Cramorant / Trevenant.
      if (card.name === "Poké Pad") return 12;
      // Hassel — conditional draw refill (only after losing a KO). Modest
      // bonus because it's situational.
      if (card.name === "Hassel") return 12;
      // Pokégear 3.0 — fallback supporter search.
      if (card.name === "Pokégear 3.0") return 10;
      // Secret Box ACE SPEC — search any 2 items.
      if (card.name === "Secret Box") return 18;
      return 0;
    case "starmie-dusknoir":
      // Risky Ruins — signature stadium, same role as in mega-starmie-froslass.
      if (card.name === "Risky Ruins") return 28;
      if (card.name === "Lillie's Determination") return 20;
      if (card.name === "Buddy-Buddy Poffin") return 18;
      if (card.name === "Boss's Orders") return 16;
      // Hero's Cape ACE SPEC — preferred over Unfair Stamp on Dusknoir.
      if (card.name === "Hero's Cape") return 18;
      return 0;
    case "n-zoroark":
      // N's PP Up — signature trainer / tool (energy ramp on N's Pokémon).
      if (card.name === "N's PP Up") return 28;
      if (card.name === "Lillie's Determination") return 20;
      if (card.name === "Buddy-Buddy Poffin") return 18;
      if (card.name === "Boss's Orders") return 14;
      return 0;
    case "raging-bolt-ogerpon":
      // Sada's Vitality — the signature accelerator (attach 2 Basic energy
      // to Ancient Pokémon, then your turn ends). Routine T2 play.
      if (card.name === "Professor Sada's Vitality") return 28;
      if (card.name === "Sparkling Crystal") return 22;
      if (card.name === "Lillie's Determination") return 18;
      if (card.name === "Buddy-Buddy Poffin") return 16;
      if (card.name === "Boss's Orders") return 14;
      return 0;
    case "rockets-honchkrow":
      // TR engine bonuses mirror rocket-mewtwo (same family) — Proton is the
      // T1 enabler, Ariana draws, Transceiver tutors a TR supporter.
      if (card.name === "Team Rocket's Proton") return 28;
      if (card.name === "Team Rocket's Ariana") return 24;
      if (card.name === "Team Rocket's Transceiver") return 18;
      if (card.name === "Team Rocket's Giovanni") return 16;
      if (card.name === "Boss's Orders") return 12;
      return 0;
    case "okidogi-barbaracle":
      // Hero's Cape stacks HP on the 1-prize Barbaracle — primary ACE SPEC.
      if (card.name === "Hero's Cape") return 26;
      if (card.name === "Lillie's Determination") return 20;
      if (card.name === "Buddy-Buddy Poffin") return 18;
      if (card.name === "Boss's Orders") return 14;
      return 0;
    case "slowking-scr":
      // Iono is the deck's primary disruptor (hand-shape control).
      if (card.name === "Iono") return 28;
      // Pokémon Center Lady stacks with Calming Aroma for double-heal.
      if (card.name === "Pokémon Center Lady") return 22;
      if (card.name === "Lillie's Determination") return 18;
      if (card.name === "Pokégear 3.0") return 14;
      return 0;
    case "lopunny-dudunsparce":
      // Mirror dragapult-dudunsparce — Hero's Cape on the 1-prize Dudunsparce
      // ex forces opp into 2-attack KOs.
      if (card.name === "Hero's Cape") return 24;
      if (card.name === "Lillie's Determination") return 20;
      if (card.name === "Buddy-Buddy Poffin") return 18;
      if (card.name === "Rare Candy") return 16;
      if (card.name === "Boss's Orders") return 14;
      return 0;
    case "greninja-ex":
      if (card.name === "Lillie's Determination") return 20;
      if (card.name === "Buddy-Buddy Poffin") return 18;
      if (card.name === "Rare Candy") return 18;
      if (card.name === "Boss's Orders") return 14;
      return 0;
    case "clefairy-ogerpon":
      if (card.name === "Lillie's Determination") return 20;
      if (card.name === "Buddy-Buddy Poffin") return 22;
      if (card.name === "Boss's Orders") return 14;
      return 0;
    case "ogerpon-box":
      if (card.name === "Lillie's Determination") return 20;
      if (card.name === "Buddy-Buddy Poffin") return 22;
      if (card.name === "Boss's Orders") return 14;
      // Energy Switch is critical for the multi-type Ogerpon toolbox plan.
      if (card.name === "Energy Switch") return 18;
      return 0;
    case "stevens-metagross":
      // Steven's Resolve = Stage 2 tutor for the Beldum→Metang→Metagross line.
      if (card.name === "Steven's Resolve") return 28;
      if (card.name === "Lillie's Determination") return 20;
      if (card.name === "Buddy-Buddy Poffin") return 18;
      if (card.name === "Rare Candy") return 22;
      return 0;
    case "diancie-dusknoir":
      if (card.name === "Lillie's Determination") return 20;
      if (card.name === "Buddy-Buddy Poffin") return 18;
      if (card.name === "Boss's Orders") return 14;
      if (card.name === "Hero's Cape") return 16;
      return 0;
    case "ursaluna-lunatone":
      // Maximum Belt ACE SPEC — pushes Bloodmoon Ursaluna ex's damage into
      // OHKO range on weakness-hit Active.
      if (card.name === "Maximum Belt") return 24;
      if (card.name === "Lillie's Determination") return 20;
      if (card.name === "Buddy-Buddy Poffin") return 16;
      if (card.name === "Boss's Orders") return 14;
      return 0;
    case "flareon-noctowl":
      if (card.name === "Lillie's Determination") return 20;
      if (card.name === "Buddy-Buddy Poffin") return 18;
      if (card.name === "Boss's Orders") return 14;
      return 0;
    case "dragapult-ex":
      // Same trainer suite as dragapult-blaziken minus the Blaziken-specific
      // Crispin bonus (solo doesn't run the Fire acceleration line).
      if (card.name === "Lillie's Determination") return 22;
      if (card.name === "Buddy-Buddy Poffin") return 20;
      if (card.name === "Rare Candy") return 18;
      if (card.name === "Boss's Orders") return 16;
      if (card.name === "Counter Catcher") return 12;
      return 0;
    case "dragapult-dusknoir":
      if (card.name === "Lillie's Determination") return 22;
      if (card.name === "Buddy-Buddy Poffin") return 20;
      if (card.name === "Rare Candy") return 22;
      if (card.name === "Boss's Orders") return 18;
      if (card.name === "Hero's Cape") return 16;
      return 0;
    case "hydrapple-ogerpon":
      if (card.name === "Lillie's Determination") return 20;
      if (card.name === "Buddy-Buddy Poffin") return 22;
      if (card.name === "Rare Candy") return 18;
      if (card.name === "Boss's Orders") return 14;
      return 0;
    case "ogerpon-meganium":
      if (card.name === "Lillie's Determination") return 20;
      if (card.name === "Buddy-Buddy Poffin") return 22;
      if (card.name === "Rare Candy") return 18;
      if (card.name === "Boss's Orders") return 14;
      return 0;
    case "mega-absol-box":
      // Sparkling Crystal is the deck's signature attack-cost reducer.
      if (card.name === "Sparkling Crystal") return 26;
      if (card.name === "Maximum Belt") return 20;
      if (card.name === "Lillie's Determination") return 18;
      if (card.name === "Buddy-Buddy Poffin") return 16;
      if (card.name === "Boss's Orders") return 14;
      return 0;
    case "tera-box":
      // Tera Orb is the deck's primary tutor — any Tera Pokémon to hand.
      if (card.name === "Tera Orb") return 26;
      if (card.name === "Lillie's Determination") return 18;
      if (card.name === "Buddy-Buddy Poffin") return 14;
      if (card.name === "Boss's Orders") return 14;
      return 0;
    default:
      return 0;
  }
}

// Energy-attach bias toward the archetype's planned attacker. Modest
// magnitudes — the base scoreEnergyTarget already strongly prefers
// targets that unlock attacks; archetype bonus only breaks ties.
export function archetypeAttachBonus(
  arch: Archetype,
  target: PokemonInPlay,
): number {
  const name = target.card.name;
  switch (arch) {
    case "festival-leads":
      if (name === "Dipplin") return 20;
      if (name === "Thwackey") return 12;
      if (name === "Applin") return 8;
      return 0;
    case "arboliva":
      if (name === "Arboliva ex") return 25;
      if (name === "Teal Mask Ogerpon ex") return 18;
      if (name === "Meganium") return 10;
      return 0;
    case "alakazam":
      if (name === "Alakazam ex" || name === "Alakazam") return 20;
      if (name === "Fezandipiti ex") return 10;
      return 0;
    case "lucario-ex":
      if (name === "Mega Lucario ex") return 25;
      if (name === "Lucario ex") return 15;
      if (name === "Hariyama") return 10;
      return 0;
    case "rocket-mewtwo":
      // Mewtwo ex is the Psydrive finisher — primary attach target once
      // a Spidops is ramping.
      if (name === "Team Rocket's Mewtwo ex") return 25;
      // Spidops needs an energy to attack while Mewtwo charges.
      if (name === "Team Rocket's Spidops") return 18;
      if (name === "Team Rocket's Articuno") return 12;
      return 0;
    case "dragapult-blaziken":
      // Dragapult ex (the Phantom Dive finisher) is the planned attacker.
      if (name === "Dragapult ex") return 25;
      // Blaziken ex's Charging Up accelerates Fire energy from discard.
      if (name === "Blaziken ex") return 18;
      // Drakloak still needs energy in case Rare Candy doesn't show up.
      if (name === "Drakloak") return 10;
      return 0;
    case "dragapult-dudunsparce":
      // Dragapult ex is the primary 200-dmg Phantom Dive attacker.
      if (name === "Dragapult ex") return 25;
      // Dudunsparce ex Destructive Drill bypasses Crustle / EX-immunity.
      if (name === "Dudunsparce ex") return 22;
      // Drakloak holds energy when Rare Candy isn't available.
      if (name === "Drakloak") return 12;
      // Dreepy is the seed for the Dragapult line.
      if (name === "Dreepy") return 8;
      return 0;
    case "crustle":
      // Crustle is the wall — energy buffers Growing Grass HP and Spiky Energy.
      if (name === "Crustle") return 22;
      // Mega Kangaskhan ex rapid-fire — backup attacker against EX-immune walls.
      if (name === "Mega Kangaskhan ex") return 18;
      // Cornerstone Mask Ogerpon ex — ability-immune front-line tank.
      if (name === "Cornerstone Mask Ogerpon ex") return 12;
      // Dwebble holds energy until Crustle evolution.
      if (name === "Dwebble") return 10;
      return 0;
    case "cynthia-garchomp":
      // Cynthia's Garchomp ex is the only attacker — Corkscrew Dive / Dragon Slice.
      if (name === "Cynthia's Garchomp ex") return 25;
      // Cynthia's Roserade powers Garchomp via attach-from-deck ability;
      // attaching to Roserade itself is wasted — DON'T boost Roserade.
      if (name === "Cynthia's Gabite") return 14;
      if (name === "Cynthia's Gible") return 8;
      return 0;
    case "grimmsnarl-froslass":
      // Marnie's Grimmsnarl ex — Shadow Bullet 180 + 30 spread is the plan.
      if (name === "Marnie's Grimmsnarl ex") return 25;
      // Munkidori needs 1 energy for Adrena-Brain damage shifts.
      if (name === "Munkidori") return 16;
      // Marnie's Morgrem evolves into Grimmsnarl with Punk Up energy accel.
      if (name === "Marnie's Morgrem") return 12;
      return 0;
    case "mega-starmie-froslass":
      // Mega Starmie ex Jetting Blow (120 active + 50 bench) is the engine.
      if (name === "Mega Starmie ex") return 25;
      // Mega Froslass ex — late-game hand-size punisher (50× opp hand cards).
      if (name === "Mega Froslass ex") return 18;
      // Munkidori shifts damage onto opp's bench for KO range.
      if (name === "Munkidori") return 12;
      // Staryu — feeds the Mega Starmie line.
      if (name === "Staryu") return 8;
      return 0;
    case "hops-trevenant":
      // Hop's Trevenant — primary 1-energy attacker; Horrifying Revenge
      // peaks at 130 + Postwick + Choice Band = 190.
      if (name === "Hop's Trevenant") return 25;
      // Hop's Snorlax — backup big-attacker. Dynamic Press 140 + ability
      // stacking. Energy is already attached for Trevenant in most cases.
      if (name === "Hop's Snorlax") return 18;
      // Hop's Zacian ex — Insta-Strike 30 + 30 bench snipe (1 colorless,
      // free with Hop's Choice Band cost reduction). Brave Slash unreachable
      // without metal energy in this list — only the cheap snipe matters.
      if (name === "Hop's Zacian ex") return 14;
      // Hop's Phantump — 1-energy Splashing Dodge stall while building.
      if (name === "Hop's Phantump") return 8;
      return 0;
    case "starmie-dusknoir":
      if (name === "Mega Starmie ex") return 25;
      if (name === "Dusknoir") return 22;
      if (name === "Dusclops") return 12;
      if (name === "Staryu") return 8;
      return 0;
    case "n-zoroark":
      if (name === "N's Zoroark ex") return 22;
      if (name === "N's Reshiram") return 20;
      if (name === "N's Zekrom") return 18;
      return 0;
    case "raging-bolt-ogerpon":
      if (name === "Raging Bolt ex") return 28;
      if (name === "Teal Mask Ogerpon ex") return 18;
      return 0;
    case "rockets-honchkrow":
      if (name === "Team Rocket's Honchkrow") return 25;
      if (name === "Team Rocket's Murkrow") return 12;
      return 0;
    case "okidogi-barbaracle":
      if (name === "Barbaracle") return 22;
      if (name === "Okidogi") return 20;
      if (name === "Binacle") return 10;
      return 0;
    case "slowking-scr":
      if (name === "Slowking") return 20;
      if (name === "Slowpoke") return 12;
      return 0;
    case "lopunny-dudunsparce":
      if (name === "Mega Lopunny ex") return 25;
      if (name === "Dudunsparce ex") return 22;
      if (name === "Lopunny") return 12;
      if (name === "Buneary") return 8;
      return 0;
    case "greninja-ex":
      if (name === "Mega Greninja ex") return 25;
      if (name === "Greninja ex") return 20;
      if (name === "Frogadier") return 10;
      if (name === "Froakie") return 8;
      return 0;
    case "clefairy-ogerpon":
      if (name === "Lillie's Clefairy ex") return 22;
      if (name === "Teal Mask Ogerpon ex") return 18;
      return 0;
    case "ogerpon-box":
      // Each mask gets equal weight — the right one depends on matchup.
      if (
        name === "Hearthflame Mask Ogerpon ex" ||
        name === "Wellspring Mask Ogerpon ex" ||
        name === "Teal Mask Ogerpon ex" ||
        name === "Cornerstone Mask Ogerpon ex"
      ) {
        return 22;
      }
      return 0;
    case "stevens-metagross":
      if (name === "Steven's Metagross ex") return 25;
      if (name === "Steven's Metang") return 14;
      if (name === "Steven's Beldum") return 8;
      return 0;
    case "diancie-dusknoir":
      if (name === "Mega Diancie ex") return 25;
      if (name === "Dusknoir") return 22;
      if (name === "Dusclops") return 12;
      if (name === "Diancie") return 14;
      return 0;
    case "ursaluna-lunatone":
      if (name === "Bloodmoon Ursaluna ex") return 28;
      if (name === "Lunatone" || name === "Solrock") return 10;
      return 0;
    case "flareon-noctowl":
      if (name === "Flareon ex") return 25;
      if (name === "Eevee") return 10;
      if (name === "Noctowl") return 14;
      return 0;
    case "dragapult-ex":
      if (name === "Dragapult ex") return 28;
      if (name === "Drakloak") return 12;
      if (name === "Dreepy") return 8;
      return 0;
    case "dragapult-dusknoir":
      if (name === "Dragapult ex") return 25;
      if (name === "Dusknoir") return 22;
      if (name === "Drakloak") return 12;
      if (name === "Dusclops") return 10;
      return 0;
    case "hydrapple-ogerpon":
      if (name === "Hydrapple ex") return 28;
      if (name === "Hydrapple") return 15;
      if (name === "Teal Mask Ogerpon ex") return 18;
      if (name === "Applin") return 8;
      return 0;
    case "ogerpon-meganium":
      if (name === "Mega Meganium ex") return 28;
      if (name === "Meganium") return 18;
      if (name === "Teal Mask Ogerpon ex") return 16;
      if (name === "Bayleef") return 10;
      return 0;
    case "mega-absol-box":
      if (name === "Mega Absol ex") return 28;
      if (name === "Absol") return 12;
      return 0;
    case "tera-box":
      // Spread attach across the deck's possible Mega bodies.
      if (
        name === "Mega Charizard X ex" ||
        name === "Mega Charizard Y ex" ||
        name === "Mega Absol ex"
      ) {
        return 22;
      }
      return 0;
    default:
      return 0;
  }
}

// Bench-priority bonus when picking a Basic to drop.
export function archetypeBenchBonus(
  arch: Archetype,
  card: Card,
): number {
  const name = card.name;
  switch (arch) {
    case "festival-leads":
      if (name === "Applin" || name === "Grookey") return 15;
      return 0;
    case "arboliva":
      if (name === "Smoliv" || name === "Teal Mask Ogerpon ex") return 15;
      if (name === "Chikorita") return 10;
      return 0;
    case "alakazam":
      if (name === "Abra" || name === "Dunsparce") return 15;
      if (name === "Fan Rotom") return 12;
      return 0;
    case "lucario-ex":
      if (name === "Riolu" || name === "Makuhita") return 15;
      if (name === "Solrock" || name === "Lunatone") return 10;
      return 0;
    case "rocket-mewtwo":
      // Tarountula is the bench priority — the ramp engine evolves into
      // Spidops. Mimikyu / Articuno / Lillie's Clefairy ex are the techs.
      if (name === "Team Rocket's Tarountula") return 18;
      if (name === "Team Rocket's Mewtwo ex") return 12;
      if (name === "Team Rocket's Mimikyu") return 10;
      if (name === "Team Rocket's Articuno") return 10;
      if (name === "Lillie's Clefairy ex") return 8;
      return 0;
    case "dragapult-blaziken":
      // Multiple Dreepy on bench = redundant Drakloak lines = gust insurance.
      // Torchic / Munkidori / Budew are key techs; Budew is the lead-active
      // candidate (Itchy Pollen item-lock buys the slow setup).
      if (name === "Dreepy") return 18;
      if (name === "Torchic") return 14;
      if (name === "Munkidori") return 12;
      if (name === "Budew") return 10;
      return 0;
    case "dragapult-dudunsparce":
      // Dreepy redundancy = gust insurance for the Stage 2 line.
      if (name === "Dreepy") return 18;
      // Dunsparce evolves into Dudunsparce ex (anti-Crustle attacker).
      if (name === "Dunsparce") return 14;
      // Munkidori for Adrena-Brain damage shifts.
      if (name === "Munkidori") return 12;
      return 0;
    case "crustle":
      // Wide Dwebble bench is the wall foundation — multiple lines so
      // 1 KO doesn't sink the plan.
      if (name === "Dwebble") return 26;
      // Cornerstone Mask Ogerpon ex — defensive anchor, but below Dwebble so
      // the rule-box body doesn't crowd out the single-prize wall.
      if (name === "Cornerstone Mask Ogerpon ex") return 18;
      // Mega Kangaskhan ex — rapid-fire backup against EX-immune opponents.
      if (name === "Kangaskhan") return 10;
      return 0;
    case "cynthia-garchomp":
      // Wide Gible bench (3+) so Boss's Orders can't pick off the line.
      if (name === "Cynthia's Gible") return 18;
      // Cynthia's Roselia is the energy ramp — non-negotiable bench drop.
      if (name === "Cynthia's Roselia") return 16;
      return 0;
    case "grimmsnarl-froslass":
      // Marnie's Impidimp redundancy = the Grimmsnarl line.
      if (name === "Marnie's Impidimp") return 18;
      // Munkidori for Adrena-Brain.
      if (name === "Munkidori") return 14;
      // Snorunt for Frostlass evolution (Freezing Shroud passive).
      if (name === "Snorunt") return 12;
      // Tatsugiri — Order Up tutors a supporter from top 6.
      if (name === "Tatsugiri") return 10;
      return 0;
    case "mega-starmie-froslass":
      // Multiple Staryu = redundant Mega Starmie ex lines.
      if (name === "Staryu") return 18;
      // Snorunt for Mega Froslass ex evolution (hand-size scaling).
      if (name === "Snorunt") return 14;
      // Munkidori for Adrena-Brain.
      if (name === "Munkidori") return 12;
      return 0;
    case "hops-trevenant":
      // Hop's Phantump bench redundancy = the Trevenant evolve line. 4-of
      // in the list; multiple bench copies insure against Boss's Orders.
      if (name === "Hop's Phantump") return 18;
      // Hop's Snorlax — Extra Helpings ability is +30 to all Hop's attacks
      // just by being in play. Even unattacking, having it on bench helps.
      if (name === "Hop's Snorlax") return 14;
      // Genesect — non-Hop's lead for matchups where you don't want to give
      // opp a free Hop's KO to fuel their own Trevenant Revenge (mirror).
      if (name === "Genesect") return 12;
      // Latias ex — escape artist (free retreat). Pivot tool.
      if (name === "Latias ex") return 8;
      // Fezandipiti ex — draw engine basic.
      if (name === "Fezandipiti ex") return 8;
      return 0;
    case "starmie-dusknoir":
      if (name === "Staryu") return 18;
      if (name === "Duskull") return 16;
      return 0;
    case "n-zoroark":
      if (name === "N's Zorua") return 18;
      if (name === "N's Reshiram") return 14;
      if (name === "N's Zekrom") return 12;
      return 0;
    case "raging-bolt-ogerpon":
      if (name === "Raging Bolt ex") return 18;
      if (name === "Teal Mask Ogerpon ex") return 14;
      return 0;
    case "rockets-honchkrow":
      if (name === "Team Rocket's Murkrow") return 18;
      if (name === "Team Rocket's Honchkrow") return 12;
      return 0;
    case "okidogi-barbaracle":
      if (name === "Binacle") return 18;
      if (name === "Okidogi") return 14;
      return 0;
    case "slowking-scr":
      if (name === "Slowpoke") return 18;
      return 0;
    case "lopunny-dudunsparce":
      if (name === "Buneary") return 18;
      if (name === "Dudunsparce ex") return 14;
      return 0;
    case "greninja-ex":
      if (name === "Froakie") return 18;
      if (name === "Greninja ex") return 12;
      return 0;
    case "clefairy-ogerpon":
      if (name === "Clefairy") return 18;
      if (name === "Lillie's Clefairy ex") return 16;
      if (name === "Teal Mask Ogerpon ex") return 12;
      return 0;
    case "ogerpon-box":
      if (
        name === "Hearthflame Mask Ogerpon ex" ||
        name === "Wellspring Mask Ogerpon ex" ||
        name === "Teal Mask Ogerpon ex" ||
        name === "Cornerstone Mask Ogerpon ex"
      ) {
        return 16;
      }
      return 0;
    case "stevens-metagross":
      if (name === "Steven's Beldum") return 18;
      if (name === "Steven's Carbink") return 12;
      return 0;
    case "diancie-dusknoir":
      if (name === "Diancie") return 18;
      if (name === "Duskull") return 14;
      return 0;
    case "ursaluna-lunatone":
      if (name === "Bloodmoon Ursaluna ex") return 18;
      if (name === "Lunatone" || name === "Solrock") return 14;
      return 0;
    case "flareon-noctowl":
      if (name === "Eevee") return 18;
      if (name === "Hoothoot") return 12;
      return 0;
    case "dragapult-ex":
      if (name === "Dreepy") return 18;
      if (name === "Munkidori") return 12;
      return 0;
    case "dragapult-dusknoir":
      if (name === "Dreepy") return 18;
      if (name === "Duskull") return 16;
      return 0;
    case "hydrapple-ogerpon":
      if (name === "Applin") return 18;
      if (name === "Teal Mask Ogerpon ex") return 14;
      return 0;
    case "ogerpon-meganium":
      if (name === "Chikorita") return 18;
      if (name === "Teal Mask Ogerpon ex") return 14;
      return 0;
    case "mega-absol-box":
      if (name === "Absol") return 18;
      return 0;
    case "tera-box":
      // Each Mega-line Basic is bench-worthy in a multi-mask plan.
      if (name === "Charmander" || name === "Absol") return 14;
      return 0;
    default:
      return 0;
  }
}

// Ability-priority bonus for archetype's signature abilities.
export function archetypeAbilityBonus(
  arch: Archetype,
  abilityName: string,
): number {
  switch (arch) {
    case "festival-leads":
      return 0;
    case "arboliva":
      if (abilityName === "Teal Dance") return 15;
      return 0;
    case "alakazam":
      if (abilityName === "Psychic Draw") return 15;
      if (abilityName === "Last-Ditch Catch") return 12;
      return 0;
    case "lucario-ex":
      if (abilityName === "Heave-Ho Catcher") return 18;
      return 0;
    case "rocket-mewtwo":
      // Charging Up: Spidops attaches a basic energy from discard each turn.
      if (abilityName === "Charging Up") return 20;
      return 0;
    case "dragapult-blaziken":
      // Adrena-Brain (Munkidori) moves damage to the active for setup turns.
      if (abilityName === "Adrena-Brain") return 18;
      return 0;
    case "dragapult-dudunsparce":
      // Recon Directive (Drakloak) — top-2 filter for Phantom Dive pieces.
      if (abilityName === "Recon Directive") return 20;
      // Adrena-Brain (Munkidori) — damage redistribution.
      if (abilityName === "Adrena-Brain") return 16;
      // Run Away Draw (Dudunsparce nonex) — 1-card draw + retreat utility.
      if (abilityName === "Run Away Draw") return 12;
      return 0;
    case "crustle":
      // Mysterious Rock Inn — passive EX-damage immunity (real card name,
      // not "Mysterious Rocking Inability" as broadcast caster called it).
      // Triggered by Crustle being in play; not an activated ability but
      // worth flagging so the AI keeps Crustle promoted in EX-heavy matchups.
      if (abilityName === "Mysterious Rock Inn") return 25;
      // Cornerstone Stance — defensive anchor against attackers with abilities.
      if (abilityName === "Cornerstone Stance") return 22;
      return 0;
    case "cynthia-garchomp":
      // Champion's Call (Cynthia's Gabite) — tutors a Cynthia's Pokémon
      // from deck. Deck's only line-search ability.
      if (abilityName === "Champion's Call") return 22;
      // Cheer On to Glory (Cynthia's Roserade) — passive +30 to all your
      // Cynthia's Pokémon attacks vs Active. (Earlier wiring incorrectly
      // tagged this as energy-ramp; the deck has no on-card energy ramp.)
      if (abilityName === "Cheer On to Glory") return 18;
      return 0;
    case "grimmsnarl-froslass":
      // Punk Up (Grimmsnarl ex) — search a Dark energy from deck on evolve.
      if (abilityName === "Punk Up") return 22;
      // Freezing Shroud (Froslass) — passive 10 dmg per turn to ability Pokémon.
      if (abilityName === "Freezing Shroud") return 16;
      // Attract Customers (Tatsugiri, real name; broadcast caller said "Order
      // Up") — top 6 reveal then take 1 Supporter to hand.
      if (abilityName === "Attract Customers") return 14;
      // Adrena-Brain (Munkidori) — damage shift.
      if (abilityName === "Adrena-Brain") return 12;
      return 0;
    case "mega-starmie-froslass":
      // Adrena-Brain (Munkidori) — sets up Jetting Blow exact-KO math.
      if (abilityName === "Adrena-Brain") return 18;
      return 0;
    case "hops-trevenant":
      // Extra Helpings (Hop's Snorlax) — passive +30 to ALL your Hop's
      // attacks while Snorlax is in play. Highest-value ability in the deck.
      if (abilityName === "Extra Helpings") return 22;
      return 0;
    case "starmie-dusknoir":
      // Adrena-Brain (Munkidori) — damage redistribution for Cursed Blast KO math.
      if (abilityName === "Adrena-Brain") return 18;
      return 0;
    case "n-zoroark":
      // Trade (Zoroark line) — typical deck-thin draw engine; high priority.
      if (abilityName === "Trade") return 20;
      return 0;
    case "raging-bolt-ogerpon":
      return 0;
    case "rockets-honchkrow":
      // Charging Up (TR Spidops) — if included as a backup ramp engine.
      if (abilityName === "Charging Up") return 16;
      return 0;
    case "okidogi-barbaracle":
      return 0;
    case "slowking-scr":
      // Calming Aroma (Slowking) — passive heal each turn between Pokémon
      // Center Lady plays. Core to the control plan.
      if (abilityName === "Calming Aroma") return 22;
      return 0;
    case "lopunny-dudunsparce":
      // Run Away Draw (Dudunsparce non-ex) — 1-card draw + retreat utility.
      if (abilityName === "Run Away Draw") return 14;
      return 0;
    case "greninja-ex":
      return 0;
    case "clefairy-ogerpon":
      return 0;
    case "ogerpon-box":
      return 0;
    case "stevens-metagross":
      return 0;
    case "diancie-dusknoir":
      return 0;
    case "ursaluna-lunatone":
      // Lunatone/Solrock typically have draw-related abilities — flag them.
      if (abilityName === "Moonlight Reverse" || abilityName === "Sun Selecting") {
        return 18;
      }
      return 0;
    case "flareon-noctowl":
      // Noctowl's draw ability is the engine of this deck — Pidgeot equivalent.
      if (abilityName === "Wisdom of Suspicion") return 22;
      return 0;
    case "dragapult-ex":
      // Recon Directive (Drakloak) — top-2 filter for Phantom Dive pieces.
      if (abilityName === "Recon Directive") return 20;
      // Adrena-Brain (Munkidori) — damage redistribution.
      if (abilityName === "Adrena-Brain") return 16;
      return 0;
    case "dragapult-dusknoir":
      if (abilityName === "Recon Directive") return 20;
      if (abilityName === "Adrena-Brain") return 16;
      return 0;
    case "hydrapple-ogerpon":
      return 0;
    case "ogerpon-meganium":
      return 0;
    case "mega-absol-box":
      return 0;
    case "tera-box":
      return 0;
    default:
      return 0;
  }
}

// ---- Turn-specific playbook bonuses (Phase 4) ----------------------------

// Playbook: turn-specific score bonuses on top of the static archetype
// bonuses. Encodes "champions follow this opening sequence for the first
// 3 turns" — e.g., Arboliva T1 always Teal Dance + bench Smoliv before
// anything else; Mega Lucario T2 always wants to evolve Riolu.
//
// Returns a multiplier (1.0 = neutral, >1 = boost, <1 = dampen) over the
// base score. Applied at score sites that take card-name as input.

interface PlaybookEntry {
  // Turns 1-3 of the player's perspective (their first turn = 1, etc.).
  // Stages beyond turn 3 fall back to static archetype bonuses.
  cardBonus: Record<number, Record<string, number>>;
  abilityBonus: Record<number, Record<string, number>>;
}

// Playbook bonuses are tuned conservatively — they nudge T1-T3 priority
// without overwhelming the underlying scoring. The first benchmark run
// showed +100 magnitudes pulling the AI off-plan in mid-game; values
// here are halved to preserve the boost without dominating eval.
const PLAYBOOKS: Partial<Record<Archetype, PlaybookEntry>> = {
  "festival-leads": {
    cardBonus: {
      1: {
        "Applin": 35,
        "Dipplin": 30,
        "Grookey": 28,
        "Thwackey": 22,
        "Festival Grounds": 50,
        "Lillie's Determination": 25,
        "Buddy-Buddy Poffin": 20,
      },
      2: {
        "Applin": 25,
        "Dipplin": 40,
        "Grookey": 20,
        "Thwackey": 35,
        "Buddy-Buddy Poffin": 30,
        "Festival Grounds": 50,
      },
      3: {
        "Dipplin": 35,
        "Thwackey": 30,
        "Festival Grounds": 35,
        "Maximum Belt": 15,
      },
    },
    abilityBonus: { 1: {}, 2: {}, 3: {} },
  },
  "arboliva": {
    cardBonus: {
      1: {
        "Smoliv": 35,
        "Teal Mask Ogerpon ex": 30,
        "Chikorita": 18,
        "Forest of Vitality": 50,
        "Ultra Ball": 18,
        "Buddy-Buddy Poffin": 15,
      },
      2: {
        "Smoliv": 24,
        "Arboliva ex": 45,
        "Teal Mask Ogerpon ex": 30,
        "Forest of Vitality": 35,
        "Rare Candy": 40,
        "Buddy-Buddy Poffin": 15,
      },
      3: {
        "Arboliva ex": 35,
        "Teal Mask Ogerpon ex": 25,
        "Forest of Vitality": 30,
        "Maximum Belt": 12,
      },
    },
    abilityBonus: {
      1: { "Teal Dance": 30 },
      2: { "Teal Dance": 25 },
      3: { "Teal Dance": 15 },
    },
  },
  "alakazam": {
    cardBonus: {
      1: {
        "Abra": 35,
        "Dunsparce": 24,
        "Battle Cage": 50,
        "Lillie's Determination": 25,
      },
      2: {
        "Kadabra": 30,
        "Alakazam ex": 45,
        "Alakazam": 35,
        "Dudunsparce": 25,
        "Rare Candy": 40,
        "Battle Cage": 50,
      },
      3: {
        "Alakazam ex": 40,
        "Alakazam": 35,
        "Battle Cage": 35,
        "Lana's Aid": 12,
      },
    },
    abilityBonus: {
      1: { "Psychic Draw": 30 },
      2: { "Psychic Draw": 30 },
      3: { "Psychic Draw": 25 },
    },
  },
  "lucario-ex": {
    cardBonus: {
      1: {
        "Riolu": 35,
        "Makuhita": 22,
        "Premium Power Pro": 50,
        "Fighting Gong": 25,
      },
      2: {
        "Riolu": 25,
        "Mega Lucario ex": 45,
        "Lucario ex": 30,
        "Fighting Gong": 30,
        "Rare Candy": 35,
        "Premium Power Pro": 50,
      },
      3: {
        "Mega Lucario ex": 40,
        "Premium Power Pro": 35,
        "Fighting Gong": 25,
        "Maximum Belt": 20,
      },
    },
    abilityBonus: { 1: {}, 2: {}, 3: { "Heave-Ho Catcher": 30 } },
  },
  // Sourced from prague-2026-r9 replay opening-book entry. T1 must search
  // TR Basics to HAND not bench (preserves Ariana scaling). T2 banks the
  // 8-card draw; T3 transitions to Giovanni gust + Mewtwo Psydrive.
  "rocket-mewtwo": {
    cardBonus: {
      1: {
        "Team Rocket's Tarountula": 38,
        "Team Rocket's Mewtwo ex": 28,
        "Team Rocket's Energy": 24,
        "Team Rocket's Proton": 60,
        "Team Rocket's Transceiver": 30,
        "Ultra Ball": 18,
      },
      2: {
        "Team Rocket's Spidops": 45,
        "Team Rocket's Mewtwo ex": 35,
        "Team Rocket's Energy": 25,
        "Team Rocket's Ariana": 55,
        "Team Rocket's Transceiver": 22,
      },
      3: {
        "Team Rocket's Mewtwo ex": 45,
        "Team Rocket's Spidops": 30,
        "Team Rocket's Energy": 22,
        "Team Rocket's Giovanni": 40,
        "Team Rocket's Archer": 25,
        "Maximum Belt": 25,
      },
    },
    abilityBonus: {
      1: {},
      2: { "Charging Up": 30 },
      3: { "Charging Up": 25 },
    },
  },
  // Slow archetype: setup over T1-T3 with Lillie + Poffin while Budew
  // item-locks. First real attack is T4 Phantom Dive (or T3 with Rare
  // Candy). Stage-2 setup playbook diverges from existing archetypes.
  "dragapult-blaziken": {
    cardBonus: {
      1: {
        "Dreepy": 35,
        "Drakloak": 20,
        "Buddy-Buddy Poffin": 35,
        "Lillie's Determination": 30,
        "Ultra Ball": 18,
      },
      2: {
        "Dreepy": 30,
        "Drakloak": 35,
        "Dragapult ex": 35,
        "Crispin": 45,
        "Rare Candy": 50,
        "Buddy-Buddy Poffin": 22,
      },
      3: {
        "Dreepy": 30,
        "Dragapult ex": 30,
        "Rare Candy": 40,
        "Drakloak": 25,
        "Boss's Orders": 25,
        "Counter Catcher": 30,
        "Crispin": 28,
      },
    },
    abilityBonus: {
      1: {},
      2: { "Adrena-Brain": 18 },
      3: { "Adrena-Brain": 22 },
    },
  },
  // Sourced from prague-2026-top16/top4/finals replays. Mateusz
  // Łaszkiewicz's championship line. T1 is item-only (T1 supporter ban) —
  // Poffin double-tutors Dreepy + Munkidori. T2 is Lillie's draw + Drakloak
  // evolve. T3 is Phantom Dive (Rare Candy → Dragapult ex). Hero's Cape on
  // 1-prize Dudunsparce is the matchup-defining ACE SPEC choice — verify
  // it's strongly preferred from T2 onward.
  "dragapult-dudunsparce": {
    cardBonus: {
      1: {
        "Dreepy": 35,
        "Drakloak": 20,
        "Buddy-Buddy Poffin": 40,
        "Poké Pad": 25,
        "Ultra Ball": 18,
      },
      2: {
        "Dreepy": 30,
        "Drakloak": 35,
        "Dragapult ex": 35,
        "Lillie's Determination": 50,
        "Rare Candy": 55,
        "Buddy-Buddy Poffin": 25,
        "Hero's Cape": 35,
      },
      3: {
        "Dreepy": 30,
        "Dragapult ex": 30,
        "Boss's Orders": 35,
        "Rare Candy": 45,
        "Counter Catcher": 30,
        "Pokégear 3.0": 18,
      },
    },
    abilityBonus: {
      1: {},
      2: { "Recon Directive": 25 },
      3: { "Recon Directive": 22, "Adrena-Brain": 18 },
    },
  },
  // Sourced from prague-2026-top8/top4/finals replays. Elmar Tresp's
  // finalist deck. Plan INVERTED from typical aggro: wall first, attack
  // last. T1 PASS on Ascension when energy attach matters more — observed
  // across all 3 source matches. T3+ wall phase: stack Growing Grass /
  // Spiky Energy + Pokémon Center Lady heals; only attack when opp ≤2
  // prizes. Ascension's playbook bonus is intentionally LOW (the AI's
  // greedy step-loop already finds zero-cost attacks; we want to dampen
  // it on this archetype, not boost it).
  "crustle": {
    cardBonus: {
      1: {
        "Dwebble": 45,
        "Crustle": 30,
        "Cornerstone Mask Ogerpon ex": 28,
        "Pokégear 3.0": 35,
        "Buddy-Buddy Poffin": 30,
        "Lillie's Determination": 25,
        "Powerglass": 24,
        "Jumbo Ice Cream": 22,
        "Super Potion": 18,
        "Sparkling Crystal": 18,
      },
      2: {
        "Dwebble": 35,
        "Crustle": 45,
        "Cornerstone Mask Ogerpon ex": 25,
        "Hero's Cape": 50,
        "Powerglass": 35,
        "Jumbo Ice Cream": 30,
        "Super Potion": 22,
        "Sparkling Crystal": 24,
        "Lillie's Determination": 30,
        "Pokémon Center Lady": 25,
      },
      3: {
        "Dwebble": 30,
        "Crustle": 35,
        "Cornerstone Mask Ogerpon ex": 22,
        "Hero's Cape": 35,
        "Powerglass": 30,
        "Jumbo Ice Cream": 35,
        "Super Potion": 25,
        "Sparkling Crystal": 22,
        "Pokémon Center Lady": 35,
        "Colress's Tenacity": 30,
        "Boss's Orders": 22,
      },
    },
    abilityBonus: {
      1: { "Mysterious Rock Inn": 25, "Cornerstone Stance": 35 },
      2: { "Mysterious Rock Inn": 30, "Cornerstone Stance": 30 },
      3: { "Mysterious Rock Inn": 25, "Cornerstone Stance": 22 },
    },
  },
  // Sourced from prague-2026-r13/top4 replays. Neddy Kosek's "Cynthia's
  // Garchomp" line. T1 often double-Poffin — wide bench of 4-5 basics
  // (Cynthia's Gible x2-3 + Cynthia's Roselia x1-2). T2 evolves Roselia
  // → Roserade (energy ramp) and Gible → Gabite (line tutor). T3
  // Garchomp Corkscrew Dive (attack + draw) lands the first prize.
  "cynthia-garchomp": {
    cardBonus: {
      1: {
        "Cynthia's Gible": 40,
        "Cynthia's Roselia": 35,
        "Buddy-Buddy Poffin": 50,
        "Ultra Ball": 18,
      },
      2: {
        "Cynthia's Gabite": 40,
        "Cynthia's Garchomp ex": 35,
        "Cynthia's Roserade": 35,
        "Cynthia": 50,
        "Rare Candy": 30,
        "Cynthia's Power Weight": 20,
      },
      3: {
        "Cynthia's Garchomp ex": 45,
        "Cynthia's Roserade": 30,
        "Boss's Orders": 35,
        "Cynthia": 30,
        "Unfair Stamp": 25,
      },
    },
    abilityBonus: {
      1: {},
      2: { "Cheer On to Glory": 30 },
      3: { "Cheer On to Glory": 25, "Champion's Call": 22 },
    },
  },
  // Sourced from prague-2026-top16 replay. Nicklas Rosu's "Marnie's
  // Grimmsnarl ex" line. T1 — Spikemuth Gym (item-lock-immune stadium)
  // is the deck's archetype-defining play. T2 evolve Snorunt → Froslass
  // (Freezing Shroud passive) + Marnie's Impidimp → Morgrem. T3 evolve
  // Morgrem → Grimmsnarl ex; Punk Up ability searches Dark energy from
  // deck on evolve = energy acceleration to fuel Shadow Bullet.
  "grimmsnarl-froslass": {
    cardBonus: {
      1: {
        "Marnie's Impidimp": 40,
        "Snorunt": 28,
        "Munkidori": 25,
        "Spikemuth Gym": 55,
        "Buddy-Buddy Poffin": 35,
        "Poké Pad": 22,
      },
      2: {
        "Marnie's Morgrem": 40,
        "Froslass": 35,
        "Marnie's Impidimp": 25,
        "Lillie's Determination": 45,
        "Buddy-Buddy Poffin": 25,
      },
      3: {
        "Marnie's Grimmsnarl ex": 45,
        "Froslass": 30,
        "Boss's Orders": 25,
        "Petrel": 20,
      },
    },
    abilityBonus: {
      1: { "Attract Customers": 20 },
      2: { "Freezing Shroud": 25 },
      3: { "Punk Up": 30, "Adrena-Brain": 18 },
    },
  },
  // Sourced from prague-2026-r13 replay. João Pires's variant — Risky
  // Ruins is the deck's signature accelerator (passive 2-counter spread
  // per turn on opp ability Pokémon). T1 prioritizes Risky Ruins over
  // any other stadium. T2 evolve Staryu → Mega Starmie ex with Crispin
  // attach. T3 Jetting Blow + Boss's Orders to convert spread into KOs.
  "mega-starmie-froslass": {
    cardBonus: {
      1: {
        "Staryu": 40,
        "Snorunt": 30,
        "Munkidori": 24,
        "Risky Ruins": 55,
        "Buddy-Buddy Poffin": 30,
      },
      2: {
        "Mega Starmie ex": 45,
        "Mega Froslass ex": 35,
        "Froslass": 25,
        "Crispin": 50,
        "Lillie's Determination": 30,
      },
      3: {
        "Mega Starmie ex": 45,
        "Mega Froslass ex": 38,
        "Risky Ruins": 35,
        "Boss's Orders": 30,
        "Crispin": 25,
      },
    },
    abilityBonus: {
      1: {},
      2: { "Adrena-Brain": 18 },
      3: { "Adrena-Brain": 22 },
    },
  },
  // Prague Regional 2026 community Hop's Trevenant list.
  // T1 — item-only (T1 supporter ban). Telepathic Psychic
  // Energy is the buddy-buddy-poffin-on-an-energy: attaching it from hand
  // to a Psychic Pokémon (Phantump) searches 2 Basic Psychic to bench.
  // Hop's Bag fills the rest of the bench. Postwick stadium goes down
  // when opp threatens stadium (otherwise hold). T2 — Lillie's draw +
  // evolve Phantump to Trevenant + Hop's Choice Band tool. T3 — Boss's
  // Orders into Horrifying Revenge (130 dmg if you lost a KO, +30/+30 from
  // Postwick + Choice Band = 190 OHKO range).
  "hops-trevenant": {
    cardBonus: {
      1: {
        "Hop's Phantump": 40,
        "Hop's Snorlax": 30,
        "Telepathic Psychic Energy": 28,
        "Hop's Bag": 40,
        "Postwick": 30,
        "Poké Pad": 18,
      },
      2: {
        "Hop's Trevenant": 45,
        "Hop's Snorlax": 28,
        "Telepathic Psychic Energy": 25,
        "Lillie's Determination": 50,
        "Hop's Choice Band": 35,
        "Postwick": 25,
      },
      3: {
        "Hop's Trevenant": 45,
        "Hop's Snorlax": 25,
        "Postwick": 30,
        "Boss's Orders": 35,
        "Hop's Choice Band": 25,
        "Hassel": 18,
      },
    },
    abilityBonus: {
      1: {},
      2: { "Extra Helpings": 18 },
      3: { "Extra Helpings": 22 },
    },
  },
  // ---- Stage 1-5 expansion playbooks --------------------------------------
  // Minimal T1/T2/T3 entries — focused on signature lines + standard support
  // cards. The base scorer already prefers Buddy-Buddy Poffin / Lillie's /
  // Ultra Ball / Boss's Orders, so playbook bonuses are reserved for the
  // archetype-specific cards (signature stadium, ACE SPEC, evolve line).
  "starmie-dusknoir": {
    cardBonus: {
      1: {
        "Staryu": 40,
        "Duskull": 35,
        "Munkidori": 22,
        "Risky Ruins": 50,
        "Buddy-Buddy Poffin": 30,
      },
      2: {
        "Dusclops": 35,
        "Mega Starmie ex": 40,
        "Lillie's Determination": 45,
        "Rare Candy": 35,
        "Buddy-Buddy Poffin": 22,
      },
      3: {
        "Dusknoir": 45,
        "Mega Starmie ex": 35,
        "Boss's Orders": 30,
        "Hero's Cape": 22,
      },
    },
    abilityBonus: { 1: {}, 2: { "Adrena-Brain": 18 }, 3: { "Adrena-Brain": 22 } },
  },
  "n-zoroark": {
    cardBonus: {
      1: {
        "N's Zorua": 40,
        "N's Reshiram": 30,
        "N's Zekrom": 25,
        "Buddy-Buddy Poffin": 35,
        "N's PP Up": 40,
      },
      2: {
        "N's Zoroark ex": 45,
        "N's Reshiram": 30,
        "Lillie's Determination": 40,
        "Rare Candy": 30,
      },
      3: {
        "N's Zoroark ex": 35,
        "N's Reshiram": 35,
        "Boss's Orders": 30,
        "N's PP Up": 30,
      },
    },
    abilityBonus: { 1: {}, 2: { "Trade": 25 }, 3: { "Trade": 22 } },
  },
  "raging-bolt-ogerpon": {
    cardBonus: {
      1: {
        "Raging Bolt ex": 45,
        "Teal Mask Ogerpon ex": 30,
        "Buddy-Buddy Poffin": 30,
        "Sparkling Crystal": 35,
      },
      2: {
        "Raging Bolt ex": 40,
        "Teal Mask Ogerpon ex": 25,
        "Professor Sada's Vitality": 50,
        "Lillie's Determination": 35,
      },
      3: {
        "Raging Bolt ex": 35,
        "Professor Sada's Vitality": 40,
        "Boss's Orders": 30,
      },
    },
    abilityBonus: { 1: {}, 2: {}, 3: {} },
  },
  "rockets-honchkrow": {
    cardBonus: {
      1: {
        "Team Rocket's Murkrow": 40,
        "Team Rocket's Honchkrow": 22,
        "Team Rocket's Energy": 24,
        "Team Rocket's Proton": 55,
      },
      2: {
        "Team Rocket's Honchkrow": 45,
        "Team Rocket's Energy": 25,
        "Team Rocket's Ariana": 50,
        "Team Rocket's Transceiver": 22,
      },
      3: {
        "Team Rocket's Honchkrow": 40,
        "Team Rocket's Energy": 22,
        "Team Rocket's Giovanni": 40,
        "Boss's Orders": 25,
      },
    },
    abilityBonus: { 1: {}, 2: {}, 3: {} },
  },
  "okidogi-barbaracle": {
    cardBonus: {
      1: {
        "Binacle": 40,
        "Okidogi": 35,
        "Buddy-Buddy Poffin": 35,
      },
      2: {
        "Barbaracle": 45,
        "Okidogi": 25,
        "Lillie's Determination": 40,
        "Hero's Cape": 40,
      },
      3: {
        "Barbaracle": 40,
        "Okidogi": 30,
        "Boss's Orders": 30,
        "Hero's Cape": 28,
      },
    },
    abilityBonus: { 1: {}, 2: {}, 3: {} },
  },
  "slowking-scr": {
    cardBonus: {
      1: {
        "Slowpoke": 45,
        "Buddy-Buddy Poffin": 30,
        "Lillie's Determination": 28,
      },
      2: {
        "Slowking": 50,
        "Iono": 35,
        "Pokémon Center Lady": 30,
        "Rare Candy": 25,
      },
      3: {
        "Slowking": 40,
        "Iono": 40,
        "Pokémon Center Lady": 35,
      },
    },
    abilityBonus: {
      1: {},
      2: { "Calming Aroma": 25 },
      3: { "Calming Aroma": 25 },
    },
  },
  "lopunny-dudunsparce": {
    cardBonus: {
      1: {
        "Buneary": 40,
        "Dunsparce": 30,
        "Buddy-Buddy Poffin": 35,
        "Lillie's Determination": 28,
      },
      2: {
        "Lopunny": 35,
        "Mega Lopunny ex": 45,
        "Dudunsparce ex": 35,
        "Rare Candy": 35,
        "Hero's Cape": 35,
      },
      3: {
        "Mega Lopunny ex": 40,
        "Dudunsparce ex": 35,
        "Boss's Orders": 30,
      },
    },
    abilityBonus: { 1: {}, 2: {}, 3: { "Run Away Draw": 14 } },
  },
  "greninja-ex": {
    cardBonus: {
      1: {
        "Froakie": 40,
        "Buddy-Buddy Poffin": 35,
        "Lillie's Determination": 28,
      },
      2: {
        "Frogadier": 35,
        "Greninja ex": 35,
        "Mega Greninja ex": 45,
        "Rare Candy": 40,
        "Lillie's Determination": 40,
      },
      3: {
        "Mega Greninja ex": 40,
        "Greninja ex": 30,
        "Boss's Orders": 30,
      },
    },
    abilityBonus: { 1: {}, 2: {}, 3: {} },
  },
  "clefairy-ogerpon": {
    cardBonus: {
      1: {
        "Clefairy": 40,
        "Teal Mask Ogerpon ex": 30,
        "Buddy-Buddy Poffin": 40,
        "Lillie's Determination": 28,
      },
      2: {
        "Lillie's Clefairy ex": 45,
        "Teal Mask Ogerpon ex": 25,
        "Lillie's Determination": 40,
      },
      3: {
        "Lillie's Clefairy ex": 40,
        "Teal Mask Ogerpon ex": 25,
        "Boss's Orders": 30,
      },
    },
    abilityBonus: { 1: {}, 2: {}, 3: {} },
  },
  "ogerpon-box": {
    cardBonus: {
      1: {
        "Teal Mask Ogerpon ex": 35,
        "Hearthflame Mask Ogerpon ex": 25,
        "Wellspring Mask Ogerpon ex": 25,
        "Cornerstone Mask Ogerpon ex": 25,
        "Buddy-Buddy Poffin": 30,
        "Energy Switch": 30,
      },
      2: {
        "Hearthflame Mask Ogerpon ex": 35,
        "Wellspring Mask Ogerpon ex": 35,
        "Teal Mask Ogerpon ex": 30,
        "Cornerstone Mask Ogerpon ex": 30,
        "Lillie's Determination": 35,
      },
      3: {
        "Hearthflame Mask Ogerpon ex": 30,
        "Wellspring Mask Ogerpon ex": 30,
        "Teal Mask Ogerpon ex": 25,
        "Cornerstone Mask Ogerpon ex": 25,
        "Boss's Orders": 25,
      },
    },
    abilityBonus: { 1: {}, 2: {}, 3: {} },
  },
  "stevens-metagross": {
    cardBonus: {
      1: {
        "Steven's Beldum": 40,
        "Buddy-Buddy Poffin": 35,
        "Lillie's Determination": 28,
      },
      2: {
        "Steven's Metang": 30,
        "Steven's Metagross ex": 45,
        "Steven's Resolve": 35,
        "Rare Candy": 40,
      },
      3: {
        "Steven's Metagross ex": 40,
        "Steven's Resolve": 30,
        "Boss's Orders": 25,
      },
    },
    abilityBonus: { 1: {}, 2: {}, 3: {} },
  },
  "diancie-dusknoir": {
    cardBonus: {
      1: {
        "Duskull": 40,
        "Diancie": 30,
        "Buddy-Buddy Poffin": 30,
      },
      2: {
        "Dusclops": 35,
        "Mega Diancie ex": 45,
        "Lillie's Determination": 40,
        "Rare Candy": 35,
      },
      3: {
        "Dusknoir": 45,
        "Mega Diancie ex": 35,
        "Boss's Orders": 30,
      },
    },
    abilityBonus: { 1: {}, 2: {}, 3: {} },
  },
  "ursaluna-lunatone": {
    cardBonus: {
      1: {
        "Bloodmoon Ursaluna ex": 35,
        "Lunatone": 25,
        "Solrock": 25,
        "Buddy-Buddy Poffin": 30,
      },
      2: {
        "Bloodmoon Ursaluna ex": 40,
        "Lillie's Determination": 35,
        "Maximum Belt": 30,
      },
      3: {
        "Bloodmoon Ursaluna ex": 40,
        "Maximum Belt": 25,
        "Boss's Orders": 30,
      },
    },
    abilityBonus: { 1: {}, 2: {}, 3: {} },
  },
  "flareon-noctowl": {
    cardBonus: {
      1: {
        "Eevee": 40,
        "Hoothoot": 28,
        "Buddy-Buddy Poffin": 30,
      },
      2: {
        "Flareon ex": 45,
        "Noctowl": 30,
        "Lillie's Determination": 35,
      },
      3: {
        "Flareon ex": 40,
        "Noctowl": 25,
        "Boss's Orders": 30,
      },
    },
    abilityBonus: {
      1: {},
      2: { "Wisdom of Suspicion": 20 },
      3: { "Wisdom of Suspicion": 22 },
    },
  },
  // ---- Stage 6 expansion playbooks ----------------------------------------
  "dragapult-ex": {
    cardBonus: {
      1: {
        "Dreepy": 35,
        "Drakloak": 20,
        "Buddy-Buddy Poffin": 35,
        "Lillie's Determination": 30,
      },
      2: {
        "Drakloak": 35,
        "Dragapult ex": 35,
        "Rare Candy": 45,
        "Lillie's Determination": 40,
      },
      3: {
        "Dragapult ex": 35,
        "Boss's Orders": 30,
        "Rare Candy": 35,
      },
    },
    abilityBonus: { 1: {}, 2: { "Recon Directive": 22 }, 3: { "Recon Directive": 20 } },
  },
  "dragapult-dusknoir": {
    cardBonus: {
      1: {
        "Dreepy": 35,
        "Duskull": 30,
        "Buddy-Buddy Poffin": 35,
        "Lillie's Determination": 30,
      },
      2: {
        "Drakloak": 30,
        "Dusclops": 30,
        "Dragapult ex": 35,
        "Rare Candy": 45,
        "Lillie's Determination": 40,
      },
      3: {
        "Dragapult ex": 35,
        "Dusknoir": 40,
        "Boss's Orders": 30,
      },
    },
    abilityBonus: { 1: {}, 2: { "Recon Directive": 22 }, 3: { "Recon Directive": 20 } },
  },
  "hydrapple-ogerpon": {
    cardBonus: {
      1: {
        "Applin": 35,
        "Teal Mask Ogerpon ex": 30,
        "Buddy-Buddy Poffin": 35,
      },
      2: {
        "Hydrapple": 25,
        "Hydrapple ex": 45,
        "Rare Candy": 40,
        "Lillie's Determination": 35,
      },
      3: {
        "Hydrapple ex": 40,
        "Boss's Orders": 30,
      },
    },
    abilityBonus: { 1: {}, 2: {}, 3: {} },
  },
  "ogerpon-meganium": {
    cardBonus: {
      1: {
        "Chikorita": 35,
        "Teal Mask Ogerpon ex": 30,
        "Buddy-Buddy Poffin": 35,
      },
      2: {
        "Bayleef": 25,
        "Meganium": 30,
        "Mega Meganium ex": 45,
        "Rare Candy": 40,
        "Lillie's Determination": 35,
      },
      3: {
        "Mega Meganium ex": 40,
        "Boss's Orders": 30,
      },
    },
    abilityBonus: { 1: {}, 2: {}, 3: {} },
  },
  "mega-absol-box": {
    cardBonus: {
      1: {
        "Absol": 35,
        "Sparkling Crystal": 40,
        "Buddy-Buddy Poffin": 30,
      },
      2: {
        "Mega Absol ex": 50,
        "Sparkling Crystal": 30,
        "Lillie's Determination": 35,
      },
      3: {
        "Mega Absol ex": 40,
        "Boss's Orders": 30,
        "Maximum Belt": 25,
      },
    },
    abilityBonus: { 1: {}, 2: {}, 3: {} },
  },
  "tera-box": {
    cardBonus: {
      1: {
        "Tera Orb": 45,
        "Buddy-Buddy Poffin": 25,
        "Lillie's Determination": 25,
      },
      2: {
        "Tera Orb": 35,
        "Mega Charizard X ex": 35,
        "Mega Charizard Y ex": 35,
        "Mega Absol ex": 35,
      },
      3: {
        "Mega Charizard X ex": 30,
        "Mega Charizard Y ex": 30,
        "Mega Absol ex": 30,
        "Boss's Orders": 25,
      },
    },
    abilityBonus: { 1: {}, 2: {}, 3: {} },
  },
};

export function playbookCardBonus(
  arch: Archetype,
  turn: number,
  cardName: string,
): number {
  const pb = PLAYBOOKS[arch];
  if (!pb) return 0;
  return pb.cardBonus[turn]?.[cardName] ?? 0;
}

export function playbookAbilityBonus(
  arch: Archetype,
  turn: number,
  abilityName: string,
): number {
  const pb = PLAYBOOKS[arch];
  if (!pb) return 0;
  return pb.abilityBonus[turn]?.[abilityName] ?? 0;
}

// Convenience wrapper that pulls the turn from state.
export function playbookCardBonusFromState(
  state: import("./types").GameState,
  player: import("./types").PlayerId,
  cardName: string,
): number {
  const arch = archetypeOf(state, player);
  // Player's perspective turn: subtract the offset between firstPlayer and
  // current activePlayer if needed. For simplicity, use the engine `turn`
  // directly — both players' first turn is turn 1 / turn 2 respectively.
  const playerTurn = Math.min(3, Math.max(1, state.turn));
  return playbookCardBonus(arch, playerTurn, cardName);
}

export function playbookAbilityBonusFromState(
  state: import("./types").GameState,
  player: import("./types").PlayerId,
  abilityName: string,
): number {
  const arch = archetypeOf(state, player);
  const playerTurn = Math.min(3, Math.max(1, state.turn));
  return playbookAbilityBonus(arch, playerTurn, abilityName);
}
