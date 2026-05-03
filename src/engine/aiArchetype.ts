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
  | "dragapult-dudunsparce"
  | "crustle"
  | "cynthia-garchomp"
  | "grimmsnarl-froslass"
  | "mega-starmie-froslass"
  | "hops-trevenant"
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
  // Tord Reklev's "Hop's Trevenant" — derived from a livestream of Reklev
  // playing the Prague top-64 list. Hop's Trevenant's Horrifying Revenge
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
      if (name === "Dwebble") return 20;
      // Cornerstone Mask Ogerpon ex — Free-Heal pivot + ability-damage immunity.
      if (name === "Cornerstone Mask Ogerpon ex") return 12;
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
      // Free-Heal (Cornerstone Mask Ogerpon ex) — heal on switch-out.
      if (abilityName === "Free-Heal") return 12;
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
  // Sourced from prague-2026-top16/top4/finals replays. Mateusz
  // Łaszkiewicz's championship line. T1 is item-only (T1 supporter ban) —
  // Poffin double-tutors Dreepy + Munkidori. T2 is Lillie's draw + Drakloak
  // evolve. T3 is Phantom Dive (Rare Candy → Dragapult ex). Hero's Cape on
  // 1-prize Dudunsparce is the matchup-defining ACE SPEC choice — verify
  // it's strongly preferred from T2 onward.
  "dragapult-dudunsparce": {
    cardBonus: {
      1: {
        "Buddy-Buddy Poffin": 40,
        "Poké Pad": 25,
        "Ultra Ball": 18,
      },
      2: {
        "Lillie's Determination": 50,
        "Rare Candy": 40,
        "Buddy-Buddy Poffin": 25,
        "Hero's Cape": 35,
      },
      3: {
        "Boss's Orders": 35,
        "Rare Candy": 30,
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
        "Pokégear 3.0": 35,
        "Buddy-Buddy Poffin": 30,
        "Lillie's Determination": 25,
      },
      2: {
        "Hero's Cape": 50,
        "Lillie's Determination": 30,
        "Pokémon Center Lady": 25,
      },
      3: {
        "Pokémon Center Lady": 35,
        "Colress's Tenacity": 30,
        "Boss's Orders": 22,
      },
    },
    abilityBonus: { 1: {}, 2: {}, 3: {} },
  },
  // Sourced from prague-2026-r13/top4 replays. Neddy Kosek's "Cynthia's
  // Garchomp" line. T1 often double-Poffin — wide bench of 4-5 basics
  // (Cynthia's Gible x2-3 + Cynthia's Roselia x1-2). T2 evolves Roselia
  // → Roserade (energy ramp) and Gible → Gabite (line tutor). T3
  // Garchomp Corkscrew Dive (attack + draw) lands the first prize.
  "cynthia-garchomp": {
    cardBonus: {
      1: {
        "Buddy-Buddy Poffin": 50,
        "Ultra Ball": 18,
      },
      2: {
        "Cynthia": 50,
        "Rare Candy": 30,
        "Cynthia's Power Weight": 20,
      },
      3: {
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
        "Spikemuth Gym": 55,
        "Buddy-Buddy Poffin": 35,
        "Poké Pad": 22,
      },
      2: {
        "Lillie's Determination": 45,
        "Buddy-Buddy Poffin": 25,
      },
      3: {
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
        "Risky Ruins": 55,
        "Buddy-Buddy Poffin": 30,
      },
      2: {
        "Crispin": 50,
        "Lillie's Determination": 30,
      },
      3: {
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
  // Sourced from a Tord Reklev livestream of the Prague top-64 Hop's
  // Trevenant list. T1 — item-only (T1 supporter ban). Telepathic Psychic
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
        "Hop's Bag": 40,
        "Postwick": 30,
        "Poké Pad": 18,
      },
      2: {
        "Lillie's Determination": 50,
        "Hop's Choice Band": 35,
        "Postwick": 25,
      },
      3: {
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
