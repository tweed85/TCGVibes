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

import type { Card, GameState, PlayerId, PokemonInPlay, TrainerCard } from "./types";

export type Archetype =
  | "festival-leads"
  | "arboliva"
  | "alakazam"
  | "lucario-ex"
  | "rocket-mewtwo"
  | "dragapult-blaziken"
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
};

// Archetype detection. Scans every zone (deck, hand, discard, prizes,
// in-play) for signature card NAMES. Returns the archetype with the most
// signature matches, weighted toward unique attackers (signature[0]).
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
  // Need at least one signature hit to commit to an archetype; otherwise
  // default to generic so the AI plays unbiased.
  return bestScore >= 2 ? bestArch : "generic";
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
        "Festival Grounds": 50,
        "Lillie's Determination": 25,
        "Buddy-Buddy Poffin": 20,
      },
      2: {
        "Buddy-Buddy Poffin": 30,
        "Festival Grounds": 50,
      },
      3: { "Maximum Belt": 15 },
    },
    abilityBonus: { 1: {}, 2: {}, 3: {} },
  },
  "arboliva": {
    cardBonus: {
      1: {
        "Forest of Vitality": 50,
        "Ultra Ball": 18,
        "Buddy-Buddy Poffin": 15,
      },
      2: {
        "Rare Candy": 40,
        "Buddy-Buddy Poffin": 15,
      },
      3: { "Maximum Belt": 12 },
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
        "Battle Cage": 50,
        "Lillie's Determination": 25,
      },
      2: {
        "Rare Candy": 40,
        "Battle Cage": 50,
      },
      3: { "Lana's Aid": 12 },
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
        "Premium Power Pro": 50,
        "Fighting Gong": 25,
      },
      2: {
        "Rare Candy": 35,
        "Premium Power Pro": 50,
      },
      3: { "Maximum Belt": 20 },
    },
    abilityBonus: { 1: {}, 2: {}, 3: { "Heave-Ho Catcher": 30 } },
  },
  // Sourced from prague-2026-r9 replay opening-book entry. T1 must search
  // TR Basics to HAND not bench (preserves Ariana scaling). T2 banks the
  // 8-card draw; T3 transitions to Giovanni gust + Mewtwo Psydrive.
  "rocket-mewtwo": {
    cardBonus: {
      1: {
        "Team Rocket's Proton": 60,
        "Team Rocket's Transceiver": 30,
        "Ultra Ball": 18,
      },
      2: {
        "Team Rocket's Ariana": 55,
        "Team Rocket's Transceiver": 22,
      },
      3: {
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
        "Buddy-Buddy Poffin": 35,
        "Lillie's Determination": 30,
        "Ultra Ball": 18,
      },
      2: {
        "Crispin": 45,
        "Rare Candy": 35,
        "Buddy-Buddy Poffin": 22,
      },
      3: {
        "Boss's Orders": 25,
        "Counter Catcher": 20,
        "Crispin": 28,
      },
    },
    abilityBonus: {
      1: {},
      2: { "Adrena-Brain": 18 },
      3: { "Adrena-Brain": 22 },
    },
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
