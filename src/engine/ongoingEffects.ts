// Passive / ongoing modifiers contributed by Stadium and Pokémon Tool cards
// in play. Unlike activated effects, these are recalculated on read (damage
// comparisons, retreat-cost checks, UI rendering) — no mutation anywhere.
//
// We detect effects by card name. The legal pool is small enough (≈27
// Stadiums, ≈33 Tools) that pattern-matching on rules text isn't worth the
// complexity.

import type {
  EnergyType,
  GameState,
  PlayerId,
  PokemonCard,
  PokemonInPlay,
  TrainerCard,
} from "./types";
import { getAttackEffects } from "../data/effectPatterns";
import { effectiveEnergyProvides } from "./rules";

const hasSubtype = (c: PokemonCard, s: string) => (c.subtypes ?? []).includes(s);
const hasType = (c: PokemonCard, t: EnergyType) => c.types.includes(t);
const isNamed = (c: PokemonCard, prefix: string) => c.name.startsWith(prefix);

const RULE_BOX_MARKERS = ["ex", "EX", "V", "VMAX", "VSTAR", "V-UNION", "GX", "Radiant"];

// Hoisted out of hot loops (passive damage-reduction scan, called per-attack).
const EX_SUBTYPE_RE = /^(?:ex|EX)$/;
function hasRuleBox(card: PokemonCard): boolean {
  return (card.subtypes ?? []).some((s) => RULE_BOX_MARKERS.includes(s));
}

// --- Stadium-gated utilities ----------------------------------------------

// "Pokémon Tools attached to each Pokémon (both yours and your opponent's)
// have no effect." — Jamming Tower
export function toolsActive(state: GameState): boolean {
  return state.stadium?.card.name !== "Jamming Tower";
}

// "Colorless Pokémon in play (both yours and your opponent's) have no
// Abilities." — Team Rocket's Watchtower
export function abilitiesActiveOn(state: GameState, card: PokemonCard): boolean {
  if (state.stadium?.card.name === "Team Rocket's Watchtower") {
    // Colorless Pokémon lose their Abilities under this Stadium.
    if (hasType(card, "Colorless")) return false;
  }
  return true;
}

// In-place version: also scans the board for opponent-side ability-disabling
// auras (Initialization, Midnight Fluttering, Sticky Bind) which need to know
// where `p` sits (Active vs Bench) and which player owns it.
//
// Designed to avoid recursion: when checking whether a CANDIDATE disabling
// ability is itself active, callers should use the simple card-only
// abilitiesActiveOn() — we only invoke this richer check from passive scans.
export function abilitiesActiveOnInstance(state: GameState, p: PokemonInPlay): boolean {
  if (!abilitiesActiveOn(state, p.card)) return false;
  // Locate p's owner and the opponent.
  const owner = Object.values(state.players).find(
    (pl) => pl.active === p || pl.bench.includes(p),
  );
  if (!owner) return true;
  const opp = Object.values(state.players).find((pl) => pl !== owner);
  if (!opp) return true;

  const isOnBench = owner.bench.includes(p);
  const isActive = owner.active === p;
  const hasRuleBox = (p.card.subtypes ?? []).some((s) =>
    /^(?:ex|EX|V|VMAX|VSTAR|V-UNION|GX|Radiant)$/.test(s),
  );
  const isFuture = (p.card.subtypes ?? []).includes("Future");
  const isStage2 = (p.card.subtypes ?? []).includes("Stage 2");

  // Sticky Bind (Klefki) — Bench-only. Benched Stage 2 Pokémon (both sides)
  // have no Abilities. Walk both players' allies for the holder.
  if (isOnBench && isStage2) {
    for (const pl of Object.values(state.players)) {
      const allies = [pl.active, ...pl.bench].filter((q): q is PokemonInPlay => !!q);
      for (const holder of allies) {
        if (holder === p) continue; // exclude self to avoid recursion
        if (!pl.bench.includes(holder)) continue;
        if (!abilitiesActiveOn(state, holder.card)) continue;
        if ((holder.card.abilities ?? []).some((a) => a.name === "Sticky Bind")) {
          return false;
        }
      }
    }
  }

  // Initialization (Genesect) — Active spot on opp; Pokémon with a Rule Box
  // (both sides, except Future) have no Abilities. So if p has a Rule Box and
  // isn't a Future, AND any Active on either side has Initialization, disable.
  if (hasRuleBox && !isFuture) {
    for (const pl of Object.values(state.players)) {
      const a = pl.active;
      if (!a || a === p) continue;
      if (!abilitiesActiveOn(state, a.card)) continue;
      if ((a.card.abilities ?? []).some((ab) => ab.name === "Initialization")) {
        return false;
      }
    }
  }

  // Midnight Fluttering (Acerola's Drifblim?) — when this is in opp's Active
  // spot, OUR Active loses abilities (except Midnight Fluttering itself).
  if (isActive) {
    const oppActive = opp.active;
    if (oppActive && abilitiesActiveOn(state, oppActive.card)) {
      const oppHasMF = (oppActive.card.abilities ?? []).some((a) => a.name === "Midnight Fluttering");
      if (oppHasMF) {
        const selfIsMF = (p.card.abilities ?? []).some((a) => a.name === "Midnight Fluttering");
        if (!selfIsMF) return false;
      }
    }
  }

  return true;
}

// --- Type rewriting helpers (partial implementations) -------------------
//
// Several abilities rewrite a Pokémon's type / weakness / energy-provides at
// runtime:
//
//   "Double Type"   — this Pokémon is Fighting AND Psychic in play.
//   "Dual Core"     — this Pokémon is Fighting AND Metal if Future Booster
//                      Energy Capsule is attached.
//   "Wild Growth"   — each Basic Grass Energy attached to all of your
//                      Pokémon provides 2 Grass Energy. (Doesn't stack.)
//   "Fairy Zone"    — opponent's Dragon Pokémon's Weakness becomes Psychic.
//
// Fully implementing them requires routing every type/weakness/energy-cost
// check through helpers that consult these abilities. The helpers below
// return a corrected value when the input matches a relevant ability;
// callers that don't yet route through them get the unmodified base value.
// Existing tests don't exercise these abilities so this is non-regressive.

export function effectiveTypes(card: PokemonCard, p?: PokemonInPlay): EnergyType[] {
  const base = card.types.slice();
  for (const ab of card.abilities ?? []) {
    if (ab.name === "Double Type") {
      if (!base.includes("Fighting")) base.push("Fighting");
      if (!base.includes("Psychic")) base.push("Psychic");
    } else if (ab.name === "Dual Core" && p) {
      // Conditional on Future Booster Energy Capsule attached.
      const hasFutureBooster = p.tools?.some((t) => t.name === "Future Booster Energy Capsule");
      if (hasFutureBooster) {
        if (!base.includes("Fighting")) base.push("Fighting");
        if (!base.includes("Metal")) base.push("Metal");
      }
    }
  }
  return base;
}

export function effectiveWeaknesses(
  defender: PokemonInPlay,
  state: GameState,
): import("./types").WeaknessResistance[] {
  const base = defender.card.weaknesses?.slice() ?? [];
  // Fairy Zone: opp's Dragon Pokémon weakness becomes Psychic. The "opp" of
  // the holder is the defender; locate the holder.
  const isDragon = defender.card.types.includes("Dragon");
  if (isDragon) {
    for (const pl of Object.values(state.players)) {
      const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
      // Fairy Zone is the holder's; its opp is whoever's playing the dragon.
      // I.e. we want to check whether the OPPONENT of `defender` has Fairy
      // Zone in play.
      const defenderOwner = Object.values(state.players).find((p) => p.active === defender || p.bench.includes(defender));
      if (!defenderOwner) continue;
      if (pl === defenderOwner) continue;
      const fairyZoneInPlay = allies.some(
        (a) => (a.card.abilities ?? []).some((ab) => ab.name === "Fairy Zone") &&
               abilitiesActiveOnInstance(state, a),
      );
      if (fairyZoneInPlay) {
        // Override the Weakness type to Psychic, ×2.
        return [{ type: "Psychic", value: "×2" }];
      }
    }
  }
  return base;
}

// Returns the effective energy pool for cost-checking: base provides plus
// Wild Growth's extra Grass per Basic Grass attached. Use this anywhere
// the engine checks "can this attack/retreat be paid?" so abilities like
// Meganium's Wild Growth properly double Grass output.
export function energyPoolForCost(p: PokemonInPlay, state: GameState): string[] {
  // Inlined to avoid the rules ↔ ongoingEffects circular import.
  const base = p.attachedEnergy.flatMap((e) =>
    effectiveEnergyProvides(e, p.card, p.attachedEnergy),
  );
  return [...base, ...wildGrowthBonusGrass(p, state)];
}

// Wild Growth (Sceptile, etc.): each Basic Grass Energy attached provides
// 2 Grass instead of 1. Returns the additional Grass entries to add to the
// pool (the original 1 Grass per energy stays). Caller is responsible for
// merging — energyProvidedBy doesn't yet route through state, so this is
// provided for callers that have it and want to honor the ability.
export function wildGrowthBonusGrass(p: PokemonInPlay, state: GameState): string[] {
  const owner = Object.values(state.players).find(
    (pl) => pl.active === p || pl.bench.includes(p),
  );
  if (!owner) return [];
  const allies = [owner.active, ...owner.bench].filter((q): q is PokemonInPlay => !!q);
  const hasWildGrowth = allies.some(
    (a) =>
      (a.card.abilities ?? []).some((ab) => ab.name === "Wild Growth") &&
      abilitiesActiveOnInstance(state, a),
  );
  if (!hasWildGrowth) return [];
  const extras: string[] = [];
  for (const e of p.attachedEnergy) {
    if (e.name === "Basic Grass Energy") extras.push("Grass");
  }
  return extras;
}

// Festival Grounds: Pokémon with any Energy attached can't be affected by
// Special Conditions. Return true if the holder is currently status-immune
// to ALL conditions.
export function isStatusImmune(p: PokemonInPlay, state: GameState): boolean {
  if (state.stadium?.card.name !== "Festival Grounds") return false;
  return p.attachedEnergy.length > 0;
}

// Per-status ability immunity (e.g. Insomnia → can't be Asleep). Falls back
// to global Festival Grounds immunity if applicable. Antique Fossils get
// blanket immunity per their card text.
export function canBeAfflictedBy(
  p: PokemonInPlay,
  status: import("./types").StatusCondition,
  state: GameState,
): boolean {
  if (isStatusImmune(p, state)) return false;
  // Fossils — "This card can't be affected by any Special Conditions."
  if ((p.card.subtypes ?? []).includes("Fossil")) return false;
  // Ancient Booster Energy Capsule: the Ancient Pokémon it's attached to
  // can't be affected by Special Conditions.
  if (
    toolsActive(state) &&
    hasSubtype(p.card, "Ancient") &&
    p.tools.some((t) => t.name === "Ancient Booster Energy Capsule")
  ) {
    return false;
  }
  if (!abilitiesActiveOn(state, p.card)) return true;
  const abilities = p.card.abilities ?? [];
  for (const ab of abilities) {
    if (ab.name === "Insomnia" && status === "asleep") return false;
  }
  return true;
}

// Bench cap: normally 5; Area Zero Underdepths allows 8 if the owner has a
// Tera Pokémon in play.
export function maxBenchSize(state: GameState, owner: PokemonInPlay[] | null, active: PokemonInPlay | null): number {
  if (state.stadium?.card.name !== "Area Zero Underdepths") return 5;
  const inPlay = [...(owner ?? [])];
  if (active) inPlay.push(active);
  const hasTera = inPlay.some((p) => hasSubtype(p.card, "Tera"));
  return hasTera ? 8 : 5;
}

// Area Zero Underdepths card text:
// "If a player no longer has any Tera Pokémon in play, that player discards
//  Pokémon from their Bench until they have 5."
// Called wherever a Pokémon may leave play (KO, retreat, scoop-up, etc.).
// Sweeps both sides — if a player has > maxBench effective cap, discard
// excess from the end of bench.
export function enforceAreaZeroBench(state: GameState): void {
  if (state.stadium?.card.name !== "Area Zero Underdepths") return;
  for (const pid of ["p1", "p2"] as PlayerId[]) {
    const side = state.players[pid];
    const cap = maxBenchSize(state, side.bench, side.active);
    while (side.bench.length > cap) {
      const [discarded] = side.bench.splice(side.bench.length - 1, 1);
      side.discard.push(
        discarded.card,
        ...discarded.evolvedFrom,
        ...discarded.attachedEnergy,
        ...(discarded.tools ?? []),
      );
    }
  }
}

// Battle Cage: prevent bench damage from opp's attacks/abilities.
export function benchDamageBlocked(state: GameState): boolean {
  return state.stadium?.card.name === "Battle Cage";
}

// Return the effective attack list for a Pokémon, including any attacks
// granted by attached Tools (Core Memory: Geobuster attack on Mega Zygarde ex).
// The tool's rule text gates which Pokémon card names can use the attack.
export function effectiveAttacks(p: PokemonInPlay): import("./types").Attack[] {
  const base = p.card.attacks ?? [];
  const toolAttacks: import("./types").Attack[] = [];
  for (const tool of p.tools) {
    if (tool.name === "Core Memory") {
      if (p.card.name === "Mega Zygarde ex") {
        toolAttacks.push({
          name: "Geobuster",
          cost: ["Fighting", "Fighting", "Fighting", "Fighting"],
          damage: 350,
          text: "Discard all Energy from this Pokémon.",
          effects: [{ kind: "discardOwnEnergy", count: 99 }],
        });
      }
    }
    if (tool.name === "Technical Machine: Fluorite") {
      // Fluorite: any Pokémon holding the TM can use this attack. Discards
      // all Energy from self + heals all damage from each of your Tera
      // Pokémon. The Tool itself discards at end of turn (handled in endTurn).
      toolAttacks.push({
        name: "Fluorite",
        cost: ["Grass", "Water", "Psychic"],
        damage: 0,
        text: "Discard all Energy from this Pokémon, and heal all damage from each of your Tera Pokémon.",
        effects: [
          { kind: "discardOwnEnergy", count: 99 },
          { kind: "healEachOwnSubtype", amount: 999, subtype: "Tera" },
        ],
      });
    }
  }
  // Memory Dive (Aurorus, et al.): each of your evolved Pokémon can use any
  // attack from its previous Evolutions. Surface those attacks alongside the
  // current card's attacks. The ability needs to live on this Pokémon's own
  // evolved card to grant the effect to itself; it's a self-aura.
  const hasMemoryDive = (p.card.abilities ?? []).some((a) => a.name === "Memory Dive");
  let priorAttacks: import("./types").Attack[] = [];
  if (hasMemoryDive && p.evolvedFrom.length > 0) {
    for (const prevCard of p.evolvedFrom) {
      for (const atk of prevCard.attacks ?? []) {
        // Skip if the same attack name already exists on the current card —
        // upgraded Pokémon usually keep the basic's name with stronger stats,
        // and we want the current version to win.
        if (base.some((b) => b.name === atk.name)) continue;
        priorAttacks.push(atk);
      }
    }
  }
  if (toolAttacks.length === 0 && priorAttacks.length === 0) return base;
  return [...base, ...toolAttacks, ...priorAttacks];
}

// Shaymin "Flower Curtain": "Prevent all damage done to your Benched Pokémon
// that don't have a Rule Box by attacks from your opponent's Pokémon." Returns
// true when the given bench Pokémon is immune to incoming opponent-attack
// damage thanks to a Shaymin with Flower Curtain on the same side.
export function benchDamageBlockedByFlowerCurtain(
  state: GameState,
  ownerId: PlayerId,
  benched: PokemonInPlay,
): boolean {
  if (hasRuleBox(benched.card)) return false;
  const side = state.players[ownerId];
  const allies = [side.active, ...side.bench].filter((p): p is PokemonInPlay => !!p);
  return allies.some(
    (p) =>
      abilitiesActiveOn(state, p.card) &&
      (p.card.abilities ?? []).some((a) => a.name === "Flower Curtain"),
  );
}

// Tera Pokémon rule: "As long as this Pokémon is on your Bench, prevent all
// damage done to this Pokémon by attacks (both yours and your opponent's)."
// Cornerstone Mask Ogerpon ex / Bloodmoon Ursaluna ex / 30+ other Tera ex
// inherit this. Bench-snipe / spread / counter-placement attacks must skip
// targets that are Tera AND on the bench. (Active Tera Pokémon take normal
// damage.) `_state` reserved for future ability-suppressor checks.
export function teraBenchImmunity(
  _state: GameState,
  benched: PokemonInPlay,
): boolean {
  const subtypes = benched.card.subtypes ?? [];
  return subtypes.includes("Tera");
}

// Dizzying Valley: Confused doesn't clear on evolve/devolve.
export function confusedPersistsOnEvolve(state: GameState): boolean {
  return state.stadium?.card.name === "Dizzying Valley";
}

// Forest of Vitality — "Each player's Grass Pokémon can evolve during the
// turn that player played them from their hand."
//
// This only overrides the "can't evolve a Pokémon played this turn" rule for
// a Basic Grass Pokémon being evolved for the FIRST time that turn. It does
// NOT override "can't evolve the same Pokémon more than once per turn" —
// that guard stays in place via target.evolvedThisTurn.
//
// Forest of Vitality says: "Each player's Grass Pokémon can evolve into
// Grass Pokémon during the turn they play those Pokémon." We treat this
// as enabling two distinct cases:
//   (a) "Played this turn" — a Grass Basic (or already-evolved Grass Stage)
//       placed on the bench this turn can evolve into a Grass evolution.
//   (b) "Just evolved this turn" — a Grass Pokémon that already evolved
//       this turn can chain into another Grass evolution (Chikorita →
//       Bayleef → Meganium on a single FoV turn).
// Both require the EVOLUTION card to be Grass too, since the rule is
// Grass→Grass. `newCard` is the card being played from hand (the evolution).
export function canEvolveOnPlayTurn(
  state: GameState,
  target: PokemonInPlay,
  newCard?: PokemonCard,
): boolean {
  if (state.stadium?.card.name !== "Forest of Vitality") return false;
  if (state.turn === 1) return false;
  // Source must be Grass (the Pokémon currently in play).
  if (!target.card.types.includes("Grass")) return false;
  // Target evolution must also be Grass — Grass→Grass only.
  if (newCard && !newCard.types.includes("Grass")) return false;
  return true;
}

// Risky Ruins: when a Basic non-Darkness is placed on the bench, it takes
// 2 damage counters.
export function benchPlacementDamage(state: GameState, card: PokemonCard): number {
  if (state.stadium?.card.name !== "Risky Ruins") return 0;
  if (!card.subtypes.includes("Basic")) return 0;
  if (card.types.includes("Darkness")) return 0;
  return 20;
}

// Perilous Jungle: Poison on non-Darkness Pokémon puts +2 extra counters at
// Pokémon Checkup (so 30 instead of 10). Toxic Subjugation: opponent's
// Active with this ability adds +5 counters per opp Poisoned Pokémon at
// Checkup (text: "put 5 more damage counters on your opponent's Poisoned
// Pokémon during Pokémon Checkup"). The "opponent" in that wording is the
// poisoned Pokémon's owner, since this ability fires on its holder's side
// against the holder's opponent's Poisoned Pokémon.
export function poisonExtraCounters(state: GameState, p: PokemonInPlay): number {
  let extra = 0;
  if (state.stadium?.card.name === "Perilous Jungle" && !p.card.types.includes("Darkness")) {
    extra += 20;
  }
  // Find the OWNER of p (whose Active has Poison), then check if the OPPONENT
  // of that owner has an Active with Toxic Subjugation or Magma Surge.
  const owner = Object.values(state.players).find((pl) => pl.active === p);
  if (owner) {
    const opp = Object.values(state.players).find((pl) => pl !== owner);
    if (opp?.active) {
      for (const ab of opp.active.card.abilities ?? []) {
        if (ab.name === "Toxic Subjugation") extra += 50;
      }
    }
  }
  return extra;
}

// --- HP modifiers ---------------------------------------------------------

function stadiumHpDelta(stadium: TrainerCard, card: PokemonCard): number {
  switch (stadium.name) {
    case "Lively Stadium":
      return hasSubtype(card, "Basic") ? 30 : 0;
    case "Gravity Mountain":
      return hasSubtype(card, "Stage 2") ? -30 : 0;
    default:
      return 0;
  }
}

function toolHpDelta(tool: TrainerCard, card: PokemonCard): number {
  switch (tool.name) {
    case "Hero's Cape":
      return 100;
    case "Cynthia's Power Weight":
      return isNamed(card, "Cynthia's ") ? 70 : 0;
    case "Ancient Booster Energy Capsule":
      return hasSubtype(card, "Ancient") ? 60 : 0;
    default:
      return 0;
  }
}

export function effectiveMaxHp(p: PokemonInPlay, state: GameState): number {
  let hp = p.card.hp;
  if (state.stadium) hp += stadiumHpDelta(state.stadium.card, p.card);
  if (toolsActive(state)) {
    for (const tool of p.tools) hp += toolHpDelta(tool, p.card);
  }
  // Growing Grass Energy: +20 HP on the Grass Pokémon it's attached to.
  if (hasType(p.card, "Grass")) {
    for (const e of p.attachedEnergy) {
      if (e.name === "Growing Grass Energy") hp += 20;
    }
  }
  // Passive ability HP bonuses (Adrena-Power, Tyrannically Gutsy, etc.).
  if (abilitiesActiveOn(state, p.card)) {
    for (const ability of p.card.abilities ?? []) {
      const rule = PASSIVE_HP_BONUSES[ability.name];
      if (rule && rule.appliesTo(p, state)) hp += rule.amount;
      const v = VARIABLE_HP_BONUSES[ability.name];
      if (v && v.appliesTo(p, state)) hp += v.amount(p, state);
    }
  }
  // Aura HP bonuses (Vibrant Dance: +40 HP to all your Pokémon if a holder
  // is in play on your side). Scan owner's in-play allies for aura abilities.
  const owner = Object.values(state.players).find(
    (pl) => pl.active === p || pl.bench.includes(p),
  );
  if (owner) {
    const allies = [owner.active, ...owner.bench].filter((x): x is PokemonInPlay => !!x);
    const auraNames = new Set<string>();
    for (const a of allies) {
      if (!abilitiesActiveOn(state, a.card)) continue;
      for (const ab of a.card.abilities ?? []) {
        if (ab.name === "Vibrant Dance") auraNames.add(ab.name);
      }
    }
    if (auraNames.has("Vibrant Dance")) hp += 40;
  }
  return Math.max(10, hp);
}

interface PassiveHpBonus {
  appliesTo: (holder: PokemonInPlay, state: GameState) => boolean;
  amount: number;
}

const PASSIVE_HP_BONUSES: Record<string, PassiveHpBonus> = {
  // Okidogi Adrena-Power — if any Darkness Energy attached, +100 HP.
  "Adrena-Power": {
    appliesTo: (h) => h.attachedEnergy.some((e) => e.provides.includes("Darkness")),
    amount: 100,
  },
  // Tyrantrum — if any Special Energy attached, +150 HP.
  "Tyrannically Gutsy": {
    appliesTo: (h) => h.attachedEnergy.some((e) => e.subtypes.includes("Special")),
    amount: 150,
  },
  // Brambleghast — if any Darkness Energy attached, +110 HP.
  "Cursed Sleep": {
    appliesTo: (h) => h.attachedEnergy.some((e) => e.provides.includes("Darkness")),
    amount: 110,
  },
};

// Variable HP bonuses (depend on prize / energy counts) computed per call.
// Registered separately because they can't be expressed with a fixed amount.
interface VariableHpBonus {
  appliesTo: (holder: PokemonInPlay, state: GameState) => boolean;
  amount: (holder: PokemonInPlay, state: GameState) => number;
}
const VARIABLE_HP_BONUSES: Record<string, VariableHpBonus> = {
  "Craftsmanship": {
    // Iron Hands etc. — +40 HP per Fighting Energy attached.
    appliesTo: () => true,
    amount: (h) => {
      let n = 0;
      for (const e of h.attachedEnergy) {
        if (e.provides.includes("Fighting")) n++;
      }
      return n * 40;
    },
  },
  "Resilient Soul": {
    // Slaking — +50 HP per Prize the opponent has taken.
    appliesTo: () => true,
    amount: (h, state) => {
      // The defender's owner is the holder's owner.
      const owner = Object.values(state.players).find(
        (p) => p.active === h || p.bench.includes(h),
      );
      if (!owner) return 0;
      const opp = Object.values(state.players).find((p) => p !== owner);
      if (!opp) return 0;
      const taken = 6 - opp.prizes.length;
      return taken * 50;
    },
  },
};

// --- Passive KO-survival abilities (Focus Sash / Sturdy) -----------------
//
// Triggered when a damage hit would push the holder's damage past their HP.
// Some require full HP at the time of the hit (Pikachu ex Resolute Heart);
// others flip a coin (Mega Hawlucha ex Tenacious Body).
interface PassiveKoSurvival {
  // Predicate: gates the survival check (e.g., requires full HP).
  appliesTo: (holder: PokemonInPlay, state: GameState) => boolean;
  // Returns true if the survival fires (may flip a coin).
  triggers: (holder: PokemonInPlay, state: GameState) => boolean;
}

const PASSIVE_KO_SURVIVAL: Record<string, PassiveKoSurvival> = {
  "Resolute Heart": {
    // Pikachu ex — only when at full HP.
    appliesTo: (h) => h.damage === 0,
    triggers: () => true,
  },
  "Tenacious Body": {
    // Mega Hawlucha ex — flip a coin; heads → survive at 10 HP.
    appliesTo: () => true,
    triggers: (_h, s) => s.rng.next() < 0.5,
  },
  "Sturdy": {
    // Aron / Lairon / Aggron — survive at 10 HP if at full HP.
    appliesTo: (h) => h.damage === 0,
    triggers: () => true,
  },
};

// Cap the hit if any survival ability fires, leaving the holder at 10 HP.
// Returns the new (possibly capped) damage value.
export function applyAbilityKoSurvival(
  state: GameState,
  defender: PokemonInPlay,
  damage: number,
): number {
  if (!abilitiesActiveOn(state, defender.card)) return damage;
  const maxHp = effectiveMaxHp(defender, state);
  // Will this hit KO?
  if (defender.damage + damage < maxHp) return damage;
  for (const ability of defender.card.abilities ?? []) {
    const rule = PASSIVE_KO_SURVIVAL[ability.name];
    if (!rule) continue;
    if (!rule.appliesTo(defender, state)) continue;
    if (!rule.triggers(defender, state)) continue;
    // Cap so defender ends with 10 HP remaining.
    const cap = Math.max(0, maxHp - defender.damage - 10);
    if (cap < damage) {
      return cap;
    }
  }
  return damage;
}

// --- Retreat cost ---------------------------------------------------------

function toolRetreatReduction(tool: TrainerCard, holder: PokemonInPlay): number {
  switch (tool.name) {
    case "Air Balloon": return 2;
    case "Rescue Board": {
      // "If that Pokémon's remaining HP is 30 or less, it has no Retreat Cost."
      const remainingHp = holder.card.hp - holder.damage;
      return remainingHp <= 30 ? 99 : 1;
    }
    case "Future Booster Energy Capsule": return 99;
    default: return 0;
  }
}

function toolRetreatGate(tool: TrainerCard, card: PokemonCard): boolean {
  if (tool.name === "Future Booster Energy Capsule")
    return hasSubtype(card, "Future");
  return true;
}

function stadiumRetreatReduction(stadium: TrainerCard, card: PokemonCard): number {
  switch (stadium.name) {
    case "N's Castle":
      return isNamed(card, "N's ") ? 99 : 0; // no retreat cost
    case "Paradise Resort":
      return card.name === "Psyduck" ? 1 : 0;
    default:
      return 0;
  }
}

function stadiumRetreatSurcharge(_stadium: TrainerCard, _card: PokemonCard): number {
  // Placeholder: no Stadium in the current pool raises retreat cost. Nighttime
  // Mine (raises attack cost for Tera) is handled separately when wired.
  return 0;
}

// Gravity Gemstone Tool — when attached to a Pokémon in the Active Spot,
// BOTH Active Pokémon have +1 Colorless retreat cost. We surface this as a
// game-state-aware retreat surcharge: when retreating, walk both Actives.
function gravityGemstoneSurcharge(
  state: GameState | undefined,
  card: PokemonCard,
): number {
  if (!state) return 0;
  void card;
  // Either side's Active wearing Gravity Gemstone adds +1 to BOTH Actives.
  for (const pid of ["p1", "p2"] as PlayerId[]) {
    const active = state.players[pid].active;
    if (!active) continue;
    if (active.tools.some((t) => t.name === "Gravity Gemstone")) return 1;
  }
  return 0;
}

export function effectiveRetreatCost(p: PokemonInPlay, state?: GameState): EnergyType[] {
  const cost = p.card.retreatCost ?? [];
  let reduce = 0;
  let surcharge = 0;
  if (state?.stadium) {
    reduce += stadiumRetreatReduction(state.stadium.card, p.card);
    surcharge += stadiumRetreatSurcharge(state.stadium.card, p.card);
  }
  surcharge += gravityGemstoneSurcharge(state, p.card);
  if (!state || toolsActive(state)) {
    for (const tool of p.tools) {
      if (toolRetreatGate(tool, p.card)) reduce += toolRetreatReduction(tool, p);
    }
  }
  // Self-on-card free-retreat ability: "If this Pokémon has no Energy
  // attached, no Retreat Cost." (Agile / Melt Away).
  if (state && abilitiesActiveOn(state, p.card)) {
    for (const ability of p.card.abilities ?? []) {
      if (
        (ability.name === "Agile" || ability.name === "Melt Away") &&
        p.attachedEnergy.length === 0
      ) {
        reduce += 99;
      }
    }
  }
  // Bench-wide free-retreat abilities ("All of your Pokémon with Metal Energy
  // have no Retreat Cost"). Walk the holder's allies to find a matching ability.
  if (state) {
    const owner = Object.values(state.players).find(
      (pl) => pl.active === p || pl.bench.includes(p),
    );
    if (owner) {
      const allies = [owner.active, ...owner.bench].filter((a): a is PokemonInPlay => !!a);
      for (const holder of allies) {
        if (!abilitiesActiveOn(state, holder.card)) continue;
        for (const ability of holder.card.abilities ?? []) {
          if (ability.name === "Metal Bridge") {
            if (p.attachedEnergy.some((e) => e.provides.includes("Metal"))) reduce += 99;
          } else if (ability.name === "Skyliner") {
            if ((p.card.subtypes ?? []).includes("Basic")) reduce += 99;
          } else if (ability.name === "Secret Forest Path") {
            // Bench-only: only the owner's Active gets the -CC discount.
            if (p === owner.active && holder !== p) reduce += 2;
          }
        }
      }
    }
  }
  // Big Net (opponent-side Stage 1+ surcharge): if any of the OPPONENT's
  // in-play Pokémon has Big Net, this Pokémon's retreat cost gains +C when
  // it's an Evolution. Only applies to opp's Active per text.
  if (state) {
    const owner = Object.values(state.players).find(
      (pl) => pl.active === p || pl.bench.includes(p),
    );
    if (owner) {
      const opp = Object.values(state.players).find((pl) => pl !== owner);
      if (opp && p === owner.active) {
        const isEvolution = !!p.card.evolvesFrom;
        if (isEvolution) {
          const oppAllies = [opp.active, ...opp.bench].filter((a): a is PokemonInPlay => !!a);
          for (const holder of oppAllies) {
            if (!abilitiesActiveOn(state, holder.card)) continue;
            for (const ability of holder.card.abilities ?? []) {
              if (ability.name === "Big Net") surcharge += 1;
            }
          }
        }
      }
    }
  }
  let out = cost.slice();
  while (reduce > 0 && out.length > 0) {
    const i = out.lastIndexOf("Colorless");
    if (i >= 0) out.splice(i, 1);
    else out.pop();
    reduce--;
  }
  for (let i = 0; i < surcharge; i++) out.push("Colorless");
  return out;
}

// Item-block / Stadium-block / supporter-block via opponent's Active ability.
// Returns true if `kind` cannot be played by `player` because the opp has an
// Active Pokémon whose ability blocks it. (Tyranitar Daunting Gaze blocks
// Items; Jellicent Oceanic Curse blocks Items + Tools; Copperajah Massive
// Body blocks Stadiums.)
export function actionBlockedByOppActive(
  state: GameState,
  player: PlayerId,
  kind: "Item" | "Pokémon Tool" | "Stadium",
): boolean {
  const oppPl = Object.values(state.players).find((p) => p.id !== player);
  if (!oppPl || !oppPl.active) return false;
  if (!abilitiesActiveOn(state, oppPl.active.card)) return false;
  for (const ability of oppPl.active.card.abilities ?? []) {
    switch (ability.name) {
      case "Daunting Gaze":
        if (kind === "Item") return true;
        break;
      case "Oceanic Curse":
        if (kind === "Item" || kind === "Pokémon Tool") return true;
        break;
      case "Massive Body":
        if (kind === "Stadium") return true;
        break;
    }
  }
  return false;
}

// --- Turn-scoped modifiers ------------------------------------------------

// Sum of attack bonuses queued on the attacker's side this turn.
export function turnAttackBonus(
  state: GameState,
  attackerOwner: PlayerId,
  attacker: PokemonInPlay,
  defender: PokemonInPlay | null,
): number {
  const pl = state.players[attackerOwner];
  let total = 0;
  const defEx = defender ? (hasSubtype(defender.card, "ex") || hasSubtype(defender.card, "EX")) : false;
  const defV = defender
    ? (hasSubtype(defender.card, "V") ||
       hasSubtype(defender.card, "VMAX") ||
       hasSubtype(defender.card, "VSTAR") ||
       hasSubtype(defender.card, "V-UNION"))
    : false;
  const atkType = attacker.card.types[0];
  for (const b of pl.thisTurnAttackBonuses) {
    // Defender-shape gates OR together: an entry with both againstEx and
    // againstV (Kieran) fires when the defender matches either.
    if (b.againstEx || b.againstV) {
      const exOk = b.againstEx ? defEx : false;
      const vOk = b.againstV ? defV : false;
      if (!exOk && !vOk) continue;
    }
    if (b.attackerType && b.attackerType !== atkType) continue;
    total += b.amount;
  }
  return total;
}

// Damage reduction queued by the defender's side for the current (attacker's)
// turn — e.g. Jasmine's Gaze, Iron Defender.
export function turnDamageReduction(
  state: GameState,
  defenderOwner: PlayerId,
  defender: PokemonInPlay,
): number {
  const pl = state.players[defenderOwner];
  const defCard = defender.card;
  let total = 0;
  for (const r of pl.nextOpponentTurnDamageReductions) {
    if (r.defenderType && !hasType(defCard, r.defenderType)) continue;
    total += r.amount;
  }
  return total;
}

// --- Passive attack-bonus abilities --------------------------------------
//
// Bench-wide buffs expressed as Pokémon abilities ("Attacks used by your
// Fighting Pokémon do 30 more damage…"). We scan all of the attacker's
// in-play Pokémon for these abilities and sum the bonus that applies to the
// current (attacker, defender) pair. Each entry encodes the gate as a
// predicate + a bonus computation.

interface PassiveAttackBonus {
  appliesTo: (
    attacker: PokemonInPlay,
    holder: PokemonInPlay,
    defender: PokemonInPlay | null,
    state: GameState,
  ) => boolean;
  bonus: (
    attacker: PokemonInPlay,
    holder: PokemonInPlay,
    defender: PokemonInPlay | null,
    state: GameState,
  ) => number;
}

const PASSIVE_ATTACK_BONUSES: Record<string, PassiveAttackBonus> = {
  "Powerful a-Salt": {
    // Garganacl — your Fighting Pokémon attacks do +30 to Active.
    appliesTo: (a) => hasType(a.card, "Fighting"),
    bonus: () => 30,
  },
  "Excited Power": {
    // Seviper — if you have any Darkness Mega Evolution ex in play, this
    // Pokémon's attacks do +120. Applies only to the holder.
    appliesTo: (a, h, _d, s) => {
      if (a.instanceId !== h.instanceId) return false;
      const pl = Object.values(s.players).find((p) => p.active === h || p.bench.includes(h));
      if (!pl) return false;
      const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
      return allies.some(
        (p) =>
          p.card.types.includes("Darkness") &&
          p.card.subtypes.some((s) => /^Mega/i.test(s)) &&
          p.card.subtypes.includes("ex"),
      );
    },
    bonus: () => 120,
  },
  "Supreme Overlord": {
    // Kingambit — attacks by this Pokémon do +30 per Prize the opponent has taken.
    appliesTo: (a, h) => a.instanceId === h.instanceId,
    bonus: (_a, _h, _d, s) => {
      const attackerPl = Object.values(s.players).find(
        (p) => p.active && p.active.instanceId === _a.instanceId,
      );
      if (!attackerPl) return 0;
      const oppPl = Object.values(s.players).find((p) => p !== attackerPl);
      if (!oppPl) return 0;
      const taken = 6 - oppPl.prizes.length;
      return 30 * taken;
    },
  },
  "Cheer On to Glory": {
    // Cynthia's Roserade — your Cynthia's Pokémon attacks do +30.
    appliesTo: (a) => isNamed(a.card, "Cynthia's "),
    bonus: () => 30,
  },
  "Lose Cool": {
    // Annihilape — if this Pokémon has ≥2 damage counters, +120 to its attacks.
    appliesTo: (a, h) => a.instanceId === h.instanceId && Math.floor(h.damage / 10) >= 2,
    bonus: () => 120,
  },
  "Cobalt Command": {
    // Iron Crown ex — your Future Pokémon (except Iron Crown ex) do +20.
    appliesTo: (a) =>
      a.card.subtypes.includes("Future") && a.card.name !== "Iron Crown ex",
    bonus: () => 20,
  },
  "Compound Eyes": {
    // Galvantula — this Pokémon's attacks do +50 vs Active with any Ability.
    appliesTo: (a, h, d) =>
      a.instanceId === h.instanceId &&
      !!d &&
      (d.card.abilities?.length ?? 0) > 0,
    bonus: () => 50,
  },
  "Primal Knowledge": {
    // Carracosta — your Pokémon do +30 vs Active Evolution Pokémon.
    appliesTo: (_a, _h, d) => !!d && !!d.card.evolvesFrom,
    bonus: () => 30,
  },
  "Victory Cheer": {
    // Victini — your Evolution Fire Pokémon attacks do +10.
    appliesTo: (a) => hasType(a.card, "Fire") && !!a.card.evolvesFrom,
    bonus: () => 10,
  },
  "Sunny Day": {
    // Lilligant — your Grass and Fire Pokémon attacks do +20.
    appliesTo: (a) => hasType(a.card, "Grass") || hasType(a.card, "Fire"),
    bonus: () => 20,
  },
  "Extra Helpings": {
    // Hop's Snorlax — your Hop's Pokémon attacks do +30 (doesn't stack).
    appliesTo: (a) => isNamed(a.card, "Hop's "),
    bonus: () => 30,
  },
  "Regal Cheer": {
    // Serperior ex — your Pokémon attacks do +20.
    appliesTo: () => true,
    bonus: () => 20,
  },
  "Adrena-Power": {
    // Okidogi — if this Pokémon has any Darkness Energy attached, its attacks
    // do +100 damage to opp's Active.
    appliesTo: (a, h) =>
      a.instanceId === h.instanceId &&
      h.attachedEnergy.some((e) => e.provides.includes("Darkness")),
    bonus: () => 100,
  },
};

// --- Passive damage-reduction abilities ----------------------------------
//
// Wide-coverage parallel to PASSIVE_ATTACK_BONUSES: defender-side abilities
// that reduce incoming attack damage. Predicates have access to defender,
// holder of the ability, attacker, and game state. The reduction does NOT
// stack with itself (multiple copies of the same ability in play don't
// double the effect — each entry returns a single number per unique name).
interface PassiveDamageReduction {
  appliesTo: (
    defender: PokemonInPlay,
    holder: PokemonInPlay,
    attacker: PokemonInPlay,
    state: GameState,
  ) => boolean;
  amount: (
    defender: PokemonInPlay,
    holder: PokemonInPlay,
    attacker: PokemonInPlay,
    state: GameState,
  ) => number;
}

const PASSIVE_DAMAGE_REDUCTIONS: Record<string, PassiveDamageReduction> = {
  "Diamond Coat": {
    // Mega Diancie ex etc. — this Pokémon takes 30 less damage.
    appliesTo: (d, h) => d.instanceId === h.instanceId,
    amount: () => 30,
  },
  "Solid Shell": {
    // Turtwig — this Pokémon takes 20 less damage.
    appliesTo: (d, h) => d.instanceId === h.instanceId,
    amount: () => 20,
  },
  "Fur Coat": {
    // Furfrou — this Pokémon takes 20 less damage.
    appliesTo: (d, h) => d.instanceId === h.instanceId,
    amount: () => 20,
  },
  "Thick Fat": {
    // Dewgong — 30 less from Fire/Water attackers.
    appliesTo: (d, h, a) =>
      d.instanceId === h.instanceId &&
      (hasType(a.card, "Fire") || hasType(a.card, "Water")),
    amount: () => 30,
  },
  "Tundra Wall": {
    // Aurorus — your Pokémon with any Water Energy take 50 less.
    appliesTo: (d, _h, _a) => d.attachedEnergy.some((e) => e.provides.includes("Water")),
    amount: () => 50,
  },
  "Gear Coating": {
    // Klinklang — your Pokémon with any Metal Energy take 20 less.
    appliesTo: (d) => d.attachedEnergy.some((e) => e.provides.includes("Metal")),
    amount: () => 20,
  },
  "Curly Wall": {
    // Bouffalant — your Basic Colorless take 60 less if you have ≥1 other
    // Bouffalant in play.
    appliesTo: (d, h, _a, s) => {
      if (!hasSubtype(d.card, "Basic")) return false;
      if (!hasType(d.card, "Colorless")) return false;
      const owner = Object.values(s.players).find(
        (p) => p.active === h || p.bench.includes(h),
      );
      if (!owner) return false;
      const allies = [owner.active, ...owner.bench].filter(
        (p): p is PokemonInPlay => !!p,
      );
      return allies.filter((p) => p.card.name === "Bouffalant").length >= 1;
    },
    amount: () => 60,
  },
  "Stone Palace": {
    // Steven's Carbink — Bench-only; your Steven's Pokémon take 30 less.
    appliesTo: (d, h, _a, s) => {
      const owner = Object.values(s.players).find(
        (p) => p.bench.includes(h),
      );
      if (!owner) return false;
      return isNamed(d.card, "Steven's ");
    },
    amount: () => 30,
  },
  "Protective Bell": {
    // Bronzong — your Pokémon take 10 less from opp's attacks.
    appliesTo: () => true,
    amount: () => 10,
  },
  "Rock Armor": {
    // Regirock — if this Pokémon has any Energy attached, takes 30 less.
    appliesTo: (d, h) => d.instanceId === h.instanceId && d.attachedEnergy.length > 0,
    amount: () => 30,
  },
  "Intimidating Fang": {
    // Pyroar — Active-only; opp's Active attacks do 30 less damage. The
    // damage flows through Pyroar; this is a defender-side reduction gated
    // on the holder being Active.
    appliesTo: (d, h, _a, s) => {
      if (d.instanceId !== h.instanceId) return false;
      const owner = Object.values(s.players).find(
        (p) => p.active && p.active.instanceId === h.instanceId,
      );
      return !!owner;
    },
    amount: () => 30,
  },
  "Cornerstone Stance": {
    // Cornerstone Mask Ogerpon ex — prevent ALL damage from attacks by opp's
    // Pokémon that have an Ability. Massive reduction (effectively prevents).
    appliesTo: (d, h, a) => d.instanceId === h.instanceId && (a.card.abilities ?? []).length > 0,
    amount: () => 9999,
  },
  "Bouffer": {
    // Bouffalant ex — this Pokémon takes 30 less damage.
    appliesTo: (d, h) => d.instanceId === h.instanceId,
    amount: () => 30,
  },
  "Sparkling Scales": {
    // Milotic ex — prevent all damage and effects of attacks from opp's
    // Tera Pokémon done to this Pokémon.
    appliesTo: (d, h, a) =>
      d.instanceId === h.instanceId &&
      (a.card.subtypes ?? []).includes("Tera"),
    amount: () => 9999,
  },
  "Adrena-Pheromone": {
    // Fezandipiti — if any Darkness Energy attached and damaged by attack,
    // flip a coin; on heads prevent that damage. We approximate as 50/50
    // full prevent.
    appliesTo: (d, h, _a, s) => {
      if (d.instanceId !== h.instanceId) return false;
      if (!d.attachedEnergy.some((e) => e.provides.includes("Darkness"))) return false;
      return s.rng.next() < 0.5;
    },
    amount: () => 9999,
  },
  "Mysterious Rock Inn": {
    // Crustle — prevent all damage from attacks from opp's Pokémon ex.
    appliesTo: (d, h, a) =>
      d.instanceId === h.instanceId &&
      (a.card.subtypes ?? []).some((s) => /^(?:ex|EX)$/.test(s)),
    amount: () => 9999,
  },

  // -30 damage on this Pokémon (after W/R) — same shape as Diamond Coat.
  "Soft Wool":    { appliesTo: (d, h) => d.instanceId === h.instanceId, amount: () => 30 },
  "Solid Body":   { appliesTo: (d, h) => d.instanceId === h.instanceId, amount: () => 30 },
  "Thicket Body": { appliesTo: (d, h) => d.instanceId === h.instanceId, amount: () => 30 },
  "Mud Coat":     { appliesTo: (d, h) => d.instanceId === h.instanceId, amount: () => 30 },

  "Safeguard": {
    // Manaphy etc. — prevent all damage from opp's Pokémon ex done to this.
    appliesTo: (d, h, a) =>
      d.instanceId === h.instanceId &&
      (a.card.subtypes ?? []).some((s) => EX_SUBTYPE_RE.test(s)),
    amount: () => 9999,
  },
  "Armor Tail": {
    // Garchomp ex etc. — prevent damage from opp's Basic Pokémon ex done to this.
    appliesTo: (d, h, a) =>
      d.instanceId === h.instanceId &&
      (a.card.subtypes ?? []).includes("Basic") &&
      (a.card.subtypes ?? []).some((s) => EX_SUBTYPE_RE.test(s)),
    amount: () => 9999,
  },
  "Mighty Shell": {
    // Prevent damage and effects from opp's Pokémon that have any Special
    // Energy attached, done to this Pokémon.
    appliesTo: (d, h, a) =>
      d.instanceId === h.instanceId &&
      a.attachedEnergy.some((e) => e.subtypes.includes("Special")),
    amount: () => 9999,
  },
  "Repelling Veil": {
    // Team Rocket's protection — prevent effects from opp attacks against your
    // Basic Team Rocket's Pokémon. We approximate as full reduction since the
    // engine doesn't separate "damage" from "effects" in the reduction layer.
    appliesTo: (d, _h, _a) =>
      (d.card.subtypes ?? []).includes("Basic") &&
      isNamed(d.card, "Team Rocket's "),
    amount: () => 0, // effects-only would require deeper hook; flag as wired but no damage diff.
  },
  "Spherical Shield": {
    // Bench-only protection: this card grants the holder's bench full
    // immunity from opp attack damage (analogous to Shaymin's Flower Curtain
    // but unconditional on Rule Box).
    appliesTo: (d, h, _a, s) => {
      const owner = Object.values(s.players).find(
        (p) => p.active === h || p.bench.includes(h),
      );
      if (!owner) return false;
      // Only bench Pokémon of the holder's owner.
      if (!owner.bench.includes(d)) return false;
      return true;
    },
    amount: () => 9999,
  },

  // Self-protection while on bench. "As long as this Pokémon is on your
  // Bench, prevent all damage and effects of attacks from your opponent's
  // Pokémon done to this Pokémon."
  "So Submerged": {
    appliesTo: (d, h, _a, s) => {
      if (d.instanceId !== h.instanceId) return false;
      const owner = Object.values(s.players).find((p) => p.bench.includes(h));
      return !!owner;
    },
    amount: () => 9999,
  },
  "Storehouse Hideaway": {
    appliesTo: (d, h, _a, s) => {
      if (d.instanceId !== h.instanceId) return false;
      const owner = Object.values(s.players).find((p) => p.bench.includes(h));
      return !!owner;
    },
    amount: () => 9999,
  },

  // Damage cap — full prevention if incoming damage is ≥ 200 (Toedscruel,
  // Impervious Shell). Implemented as a 9999 reduction gated on raw damage,
  // but we don't know damage here yet — use a cap signal: amount returns
  // damage-200 and lets the reduction pipeline subtract that, effectively
  // capping at 199. Damage check happens in passiveDamageReduction's caller
  // via a damage parameter — here we use a sentinel: return 9999 if the
  // attacker's stadium / ability stack would imply ≥200, but since we don't
  // have that, fall back to a flat 200 reduction gated by attacker subtype
  // (heuristic: ex+VMAX hit hardest).
  "Impervious Shell": {
    appliesTo: (d, h, a) =>
      d.instanceId === h.instanceId &&
      // Heuristic gate: only big-hitter shapes typically exceed 200.
      ((a.card.subtypes ?? []).some((s) => /^(?:ex|EX|VMAX|VSTAR)$/.test(s)) ||
       (a.card.subtypes ?? []).some((s) => /^Mega/i.test(s))),
    amount: () => 200,
  },

  // Coin flip prevent — "If any damage is done to this Pokémon, flip a coin.
  // If heads, prevent that damage." Heuristic: 50% full prevention.
  "Expert Hider": {
    appliesTo: (d, h, _a, s) =>
      d.instanceId === h.instanceId && s.rng.next() < 0.5,
    amount: () => 9999,
  },
};

// Sum of passive damage-reduction contributions from the defender's side.
// Each unique ability name contributes once (no stacking).
export function passiveDamageReduction(
  state: GameState,
  defenderOwner: PlayerId,
  defender: PokemonInPlay,
  attacker: PokemonInPlay,
): number {
  const pl = state.players[defenderOwner];
  const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
  const contributions = new Map<string, number>();
  for (const holder of allies) {
    if (!abilitiesActiveOnInstance(state, holder)) continue;
    for (const ability of holder.card.abilities ?? []) {
      const rule = PASSIVE_DAMAGE_REDUCTIONS[ability.name];
      if (!rule) continue;
      if (!rule.appliesTo(defender, holder, attacker, state)) continue;
      const amt = rule.amount(defender, holder, attacker, state);
      const prev = contributions.get(ability.name) ?? 0;
      contributions.set(ability.name, Math.max(prev, amt));
    }
  }
  let total = 0;
  for (const amt of contributions.values()) total += amt;
  return total;
}

// Sum of all passive attack-bonus abilities from the attacker's side that
// apply to the current (attacker, defender) pair. "Extra Helpings" doesn't
// stack — we dedupe by ability name before summing to honor that.
export function passiveAttackBonus(
  state: GameState,
  attackerOwner: PlayerId,
  attacker: PokemonInPlay,
  defender: PokemonInPlay | null,
): number {
  const pl = state.players[attackerOwner];
  const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
  const contributions = new Map<string, number>();
  for (const holder of allies) {
    if (!abilitiesActiveOnInstance(state, holder)) continue;
    for (const ability of holder.card.abilities ?? []) {
      const rule = PASSIVE_ATTACK_BONUSES[ability.name];
      if (!rule) continue;
      if (!rule.appliesTo(attacker, holder, defender, state)) continue;
      const amt = rule.bonus(attacker, holder, defender, state);
      // For name-keyed non-stacking abilities, keep the first/max.
      const prev = contributions.get(ability.name) ?? 0;
      contributions.set(ability.name, Math.max(prev, amt));
    }
  }
  let total = 0;
  for (const amt of contributions.values()) total += amt;
  return total;
}

// --- Attack damage modifiers ----------------------------------------------

// Pre-Weakness/Resistance damage bonus the attacker contributes (from the
// current Stadium + any attached Tools).
export function stadiumAttackBonus(
  state: GameState,
  attacker: PokemonInPlay,
  defender: PokemonInPlay | null,
): number {
  let bonus = 0;
  if (defender && state.stadium?.card.name === "Postwick" && isNamed(attacker.card, "Hop's ")) {
    bonus += 30;
  }
  if (defender && toolsActive(state)) {
    const defEx = hasSubtype(defender.card, "ex") || hasSubtype(defender.card, "EX");
    const atkIsRuleBox = hasRuleBox(attacker.card);
    for (const tool of attacker.tools) {
      switch (tool.name) {
        case "Maximum Belt":
          if (defEx) bonus += 50;
          break;
        case "Brave Bangle":
          if (defEx && !atkIsRuleBox) bonus += 30;
          break;
        case "Light Ball":
          if (attacker.card.name === "Pikachu ex" && defEx) bonus += 50;
          break;
        case "Hop's Choice Band":
          if (isNamed(attacker.card, "Hop's ")) bonus += 30;
          break;
        case "Binding Mochi":
          if (attacker.statuses.includes("poisoned")) bonus += 40;
          break;
        case "Future Booster Energy Capsule":
          if (hasSubtype(attacker.card, "Future")) bonus += 20;
          break;
      }
    }
  }
  return bonus;
}

// Post-Weakness/Resistance reduction the defender contributes (Stadium +
// defender's Tools). Berry tools discard when they trigger — caller is
// expected to handle that via onBerryTriggered below.
export function stadiumDamageReduction(
  state: GameState,
  attacker: PokemonInPlay,
  defender: PokemonInPlay,
): number {
  let red = 0;
  if (state.stadium) {
    const defCard = defender.card;
    switch (state.stadium.card.name) {
      case "Full Metal Lab":
        if (hasType(defCard, "Metal")) red += 30;
        break;
      case "Granite Cave":
        if (isNamed(defCard, "Steven's ")) red += 30;
        break;
      case "Neutralization Zone":
        // "Prevent all damage done to Pokémon that don't have a Rule Box
        // (both yours and your opponent's) by attacks from the opponent's
        // Pokémon ex and Pokémon V." Gates on BOTH defender (no rule box)
        // and attacker (ex or V). Full prevention, not a small reduction.
        {
          const atkSubs = attacker.card.subtypes ?? [];
          const atkIsExOrV =
            atkSubs.some((s) => EX_SUBTYPE_RE.test(s)) ||
            atkSubs.includes("V") ||
            atkSubs.includes("VMAX") ||
            atkSubs.includes("VSTAR") ||
            atkSubs.includes("V-UNION");
          if (atkIsExOrV && !hasRuleBox(defCard)) {
            red += 9999;
          }
        }
        break;
    }
  }
  if (toolsActive(state)) {
    const attackerType = attacker.card.types[0];
    for (const tool of defender.tools) {
      red += toolDamageReduction(tool, attackerType, defender);
      // Sacred Charm — -30 vs attackers with any Ability.
      if (tool.name === "Sacred Charm" && (attacker.card.abilities ?? []).length > 0) {
        red += 30;
      }
    }
  }
  return red;
}

// Defender Tool damage-reduction. Berries trigger only when the matching type
// attacks (and discard themselves — see triggeredBerryTools).
function toolDamageReduction(
  tool: TrainerCard,
  attackerType: EnergyType | undefined,
  defender: PokemonInPlay,
): number {
  switch (tool.name) {
    case "Occa Berry": return attackerType === "Fire" ? 60 : 0;
    case "Passho Berry": return attackerType === "Water" ? 60 : 0;
    case "Babiri Berry": return attackerType === "Metal" ? 60 : 0;
    case "Colbur Berry": return attackerType === "Darkness" ? 60 : 0;
    case "Payapa Berry": return attackerType === "Psychic" ? 60 : 0;
    case "Haban Berry": return attackerType === "Dragon" ? 60 : 0;
    case "Thick Scale":
      // Only applies when the Tool's holder is a Dragon Pokémon, and the
      // attacker is Grass/Fire/Water/Lightning.
      if (!hasType(defender.card, "Dragon")) return 0;
      return attackerType && ["Grass", "Fire", "Water", "Lightning"].includes(attackerType) ? 50 : 0;
    case "Sacred Charm":
      // -30 vs Pokémon with an Ability.
      void attackerType;
      // Cannot reach attacker here without it; see passiveDamageReduction wiring.
      return 0;
    default: return 0;
  }
}

// Returns the list of tool names that should be discarded from the defender
// after this attack (berries that triggered). Caller handles the discard.
export function triggeredBerryTools(
  state: GameState,
  attacker: PokemonInPlay,
  defender: PokemonInPlay,
): string[] {
  if (!toolsActive(state)) return [];
  const attackerType = attacker.card.types[0];
  const triggered: string[] = [];
  for (const tool of defender.tools) {
    const reduction = toolDamageReduction(tool, attackerType, defender);
    if (reduction >= 50 && tool.name.endsWith("Berry")) triggered.push(tool.name);
  }
  return triggered;
}

// --- Attack cost modifiers -------------------------------------------------

// Colorless reductions to attack cost contributed by Tools.
function toolAttackCostReduction(
  tool: TrainerCard,
  attacker: PokemonInPlay,
  state: GameState,
): number {
  const card = attacker.card;
  switch (tool.name) {
    case "Counter Gain": {
      // -Colorless if we have more Prizes remaining than the opponent.
      const me = Object.values(state.players).find((p) => p.active === attacker || p.bench.includes(attacker));
      if (!me) return 0;
      const opp = Object.values(state.players).find((p) => p !== me);
      if (!opp) return 0;
      return me.prizes.length > opp.prizes.length ? 1 : 0;
    }
    case "Sparkling Crystal":
      return hasSubtype(card, "Tera") ? 1 : 0;
    case "Hop's Choice Band":
      return isNamed(card, "Hop's ") ? 1 : 0;
    default:
      return 0;
  }
}

export function effectiveAttackCost(
  state: GameState,
  attacker: PokemonInPlay,
  rawCost: EnergyType[],
  attackName?: string,
): EnergyType[] {
  let reduce = 0;
  if (toolsActive(state)) {
    for (const tool of attacker.tools) reduce += toolAttackCostReduction(tool, attacker, state);
  }
  // Nighttime Mine: Tera attacks cost Colorless more.
  if (state.stadium?.card.name === "Nighttime Mine" && hasSubtype(attacker.card, "Tera")) {
    reduce -= 1; // negative = surcharge; raises cost by 1 Colorless
  }
  // Passive ability cost reductions (Bloodmoon Ursaluna ex Seasoned Skill,
  // Crabominable / Veluza Food Prep). Predicates and counts vary; we hardcode
  // a small registry by ability name.
  if (abilitiesActiveOn(state, attacker.card)) {
    for (const ab of attacker.card.abilities ?? []) {
      if (ab.name === "Seasoned Skill" && attackName === "Blood Moon") {
        // Cost reduced by 1 Colorless per Prize the opponent has taken.
        const owner = Object.values(state.players).find(
          (p) => p.active === attacker || p.bench.includes(attacker),
        );
        const opp = Object.values(state.players).find((p) => p !== owner);
        if (opp) reduce += (6 - opp.prizes.length);
      } else if (ab.name === "Food Prep") {
        // Reduce by 1 Colorless per Kofu card in your discard pile.
        const owner = Object.values(state.players).find(
          (p) => p.active === attacker || p.bench.includes(attacker),
        );
        if (owner) {
          const count = owner.discard.filter((c) => c.name === "Kofu").length;
          reduce += count;
        }
      } else if (ab.name === "Hustle Play") {
        // Incineroar ex — reduce by 1 Colorless per opp Benched Pokémon.
        const owner = Object.values(state.players).find(
          (p) => p.active === attacker || p.bench.includes(attacker),
        );
        const opp = Object.values(state.players).find((p) => p !== owner);
        if (opp) reduce += opp.bench.length;
      } else if (ab.name === "Sniper's Eye") {
        // If your opponent has exactly 4 cards in their hand, ignore all
        // Colorless Energy in the costs of attacks used by this Pokémon.
        const owner = Object.values(state.players).find(
          (p) => p.active === attacker || p.bench.includes(attacker),
        );
        const opp = Object.values(state.players).find((p) => p !== owner);
        if (opp && opp.hand.length === 4) {
          // Strip ALL Colorless from the cost. Use a giant reduce value;
          // the loop below caps at out.length so we drop only Colorless.
          const colorlessCount = rawCost.filter((c) => c === "Colorless").length;
          reduce += colorlessCount;
        }
      } else if (ab.name === "Tuning Echo" && attackName === "Frightening Howl") {
        // If you have the same number of cards in your hand as your opponent,
        // ignore all Energy in the cost of Frightening Howl.
        const owner = Object.values(state.players).find(
          (p) => p.active === attacker || p.bench.includes(attacker),
        );
        const opp = Object.values(state.players).find((p) => p !== owner);
        if (owner && opp && owner.hand.length === opp.hand.length) {
          reduce += rawCost.length; // ignore everything
        }
      } else if (ab.name === "Plasma Bane" && attackName === "Trifrost") {
        // If your opponent has any cards in their discard pile that have
        // "Colress" in the name, this Pokémon can use the Trifrost attack
        // for Colorless. We approximate "for Colorless" by collapsing the
        // cost to a single Colorless when the condition is met.
        const owner = Object.values(state.players).find(
          (p) => p.active === attacker || p.bench.includes(attacker),
        );
        const opp = Object.values(state.players).find((p) => p !== owner);
        if (opp && opp.discard.some((c) => /Colress/.test(c.name))) {
          // Reduce all but one slot, then convert remaining slot to Colorless.
          // The simplest representation: replace cost with a single Colorless.
          return ["Colorless"];
        }
      } else if (ab.name === "Glistening Bubbles" && attackName === "Double-Edge") {
        // If you have any Tera Pokémon in play, this Pokémon can use the
        // Double-Edge attack for Psychic. Collapse cost to a single Psychic.
        const owner = Object.values(state.players).find(
          (p) => p.active === attacker || p.bench.includes(attacker),
        );
        if (owner) {
          const allies = [owner.active, ...owner.bench].filter((q): q is PokemonInPlay => !!q);
          if (allies.some((a) => (a.card.subtypes ?? []).includes("Tera"))) {
            return ["Psychic"];
          }
        }
      }
    }
  }
  if (reduce === 0) return rawCost;
  const out = rawCost.slice();
  while (reduce > 0 && out.length > 0) {
    const i = out.lastIndexOf("Colorless");
    if (i >= 0) out.splice(i, 1);
    else out.pop();
    reduce--;
  }
  while (reduce < 0) { out.push("Colorless"); reduce++; }
  return out;
}

// --- KO / damage-taken triggers -------------------------------------------

// Survival Brace: at full HP + would be KO'd by attack damage → survive at 10 HP.
// Returns the capped damage amount (may be less than the requested damage).
export function applySurvivalBrace(
  state: GameState,
  defender: PokemonInPlay,
  incomingDamage: number,
): number {
  if (!toolsActive(state)) return incomingDamage;
  const hasBrace = defender.tools.some((t) => t.name === "Survival Brace");
  if (!hasBrace) return incomingDamage;
  if (defender.damage !== 0) return incomingDamage; // must be at full HP
  const maxHp = effectiveMaxHp(defender, state);
  if (incomingDamage < maxHp) return incomingDamage; // wouldn't KO anyway
  // Cap so final damage leaves 10 HP remaining.
  return maxHp - 10;
}

// Lillie's Pearl: if the KO'd Pokémon is a Lillie's Pokémon, prize reward is
// reduced by 1.
export function prizeReductionFromTools(defender: PokemonInPlay): number {
  let reduction = 0;
  for (const tool of defender.tools) {
    // Lillie's Pearl text: "If the Pokémon this card is attached to is in the
    // Active Spot and is Knocked Out by damage from your opponent's attack,
    // your opponent takes 1 fewer Prize card." — so we want the holder to be
    // a Lillie's Pokémon (the isNamed gate) but the prize-reduction applies
    // regardless of attacker naming.
    if (tool.name === "Lillie's Pearl" && isNamed(defender.card, "Lillie's ")) {
      reduction += 1;
    }
  }
  return reduction;
}

// Tools that trigger when their holder takes damage. Returns an opaque
// action list the caller should execute.
export type ToolOnDamageAction =
  | { kind: "drawCards"; owner: "defender"; count: number } // Lucky Helmet
  | { kind: "counterDamage"; target: "attacker"; damage: number } // Punk Helmet, Deluxe Bomb
  | { kind: "applyStatusToAttacker"; status: "asleep" | "burned" | "confused" | "paralyzed" | "poisoned" } // TR Hypnotizer
  | { kind: "moveEnergyAttackerToAttackerBench" }; // Handheld Fan

export function toolOnDamageActions(
  state: GameState,
  defender: PokemonInPlay,
  defenderIsActive: boolean,
): ToolOnDamageAction[] {
  if (!toolsActive(state)) return [];
  const out: ToolOnDamageAction[] = [];
  for (const tool of defender.tools) {
    switch (tool.name) {
      case "Lucky Helmet":
        if (defenderIsActive) out.push({ kind: "drawCards", owner: "defender", count: 2 });
        break;
      case "Punk Helmet":
        if (defenderIsActive && hasType(defender.card, "Darkness")) {
          out.push({ kind: "counterDamage", target: "attacker", damage: 40 });
        }
        break;
      case "Team Rocket's Hypnotizer":
        if (defenderIsActive && isNamed(defender.card, "Team Rocket's ")) {
          out.push({ kind: "applyStatusToAttacker", status: "asleep" });
        }
        break;
      case "Deluxe Bomb":
        if (defenderIsActive) {
          // 12 damage counters = 120 damage.
          out.push({ kind: "counterDamage", target: "attacker", damage: 120 });
        }
        break;
      case "Handheld Fan":
        if (defenderIsActive) {
          out.push({ kind: "moveEnergyAttackerToAttackerBench" });
        }
        break;
    }
  }
  return out;
}

// Called from the KO flow just before the KO'd Pokémon's cards go to discard.
// Returns an action list describing post-KO tool triggers (Amulet of Hope etc.)
// so the caller can resolve them against the current state.
export type ToolOnKoAction =
  | { kind: "searchDeckAnyN"; count: number } // Amulet of Hope
  | { kind: "moveEnergyToBench"; max: number }; // Heavy Baton (retreat-cost=4 gate)

// Estimate the damage an attack would deal before committing to it. Mirrors
// the attack()-time computation: base damage → attacker bonuses (Postwick /
// tool) → turn bonuses → Weakness × → Resistance − → stadium/turn defender
// reductions → structured attack effects (only deterministic ones applied).
// Coin flips and counter scaling are approximated by their *median* value so
// the preview is stable. Good enough for a UI hint — not authoritative.
export function estimateAttackDamage(
  state: GameState,
  attackerOwner: PlayerId,
  attacker: PokemonInPlay,
  move: import("./types").Attack,
): number {
  const defOwner: PlayerId = attackerOwner === "p1" ? "p2" : "p1";
  const def = state.players[defOwner].active;
  // Mirrors the runtime attack pipeline exactly (actions.ts executeAttackHit):
  //   base → attacker bonuses → attack-effect additions → W/R → defender
  //   reductions. Must match runtime behavior or the AI preview diverges
  //   from what actually lands.
  // Resolve attack effects first so baseDamageOverride is applied before we
  // read move.damage.
  const moveEffects = getAttackEffects(move);
  let d = move.damage;
  d += stadiumAttackBonus(state, attacker, def);
  d += passiveAttackBonus(state, attackerOwner, attacker, def);
  const atkPl = state.players[attackerOwner];
  for (const b of atkPl.thisTurnAttackBonuses) {
    if (b.againstEx && (!def || !def.card.subtypes.includes("ex"))) continue;
    if (b.attackerType && !attacker.card.types.includes(b.attackerType)) continue;
    d += b.amount;
  }
  // Attack-effect additions BEFORE W/R so per-bench/per-energy/etc. are part
  // of the total the multiplier scales. Uses median / expected values for
  // coin-flip effects so the preview stays stable.
  for (const e of moveEffects) {
    switch (e.kind) {
      case "perAttachedEnergy": {
        const energies = attacker.attachedEnergy;
        const matching = e.energyType
          ? energies.filter((en) => en.provides.includes(e.energyType!)).length
          : energies.length;
        d += e.perEnergy * matching;
        break;
      }
      case "perFriendlyBench":
        d += e.perCount * atkPl.bench.length;
        break;
      case "perOpponentBench":
        d += e.perCount * state.players[defOwner].bench.length;
        break;
      case "perBothBench":
        d += e.perCount * (atkPl.bench.length + state.players[defOwner].bench.length);
        break;
      case "perDamageCounterOnSelf":
        d += e.perCount * Math.floor(attacker.damage / 10);
        break;
      case "perDamageCounterOnDefender":
        d += e.perCount * (def ? Math.floor(def.damage / 10) : 0);
        break;
      case "perEnergyOnDefender":
        d += e.perCount * (def?.attachedEnergy.length ?? 0);
        break;
      case "perPrizeOppTaken":
        d += e.perCount * (6 - state.players[defOwner].prizes.length);
        break;
      case "flipHeadsBonus":
        d += e.bonus / 2;
        break;
      case "flipHeadsDouble":
        d += d / 2;
        break;
      case "flipTailsFizzle":
        d /= 2;
        break;
      case "flipAllHeadsBonus": {
        const p = 1 / Math.pow(2, e.coins);
        d += e.bonus * p;
        break;
      }
    }
  }
  // Now apply W/R and defender reductions to the final total.
  if (def) {
    const atkType = attacker.card.types[0];
    const weak = def.card.weaknesses?.find((w) => w.type === atkType);
    const res = def.card.resistances?.find((w) => w.type === atkType);
    if (weak?.value.startsWith("×")) d *= parseInt(weak.value.slice(1), 10) || 2;
    if (res?.value.startsWith("-")) d = Math.max(0, d - (parseInt(res.value.slice(1), 10) || 30));
    d = Math.max(0, d - stadiumDamageReduction(state, attacker, def));
    const defPl = state.players[defOwner];
    for (const r of defPl.nextOpponentTurnDamageReductions) {
      if (r.defenderType && !def.card.types.includes(r.defenderType)) continue;
      d = Math.max(0, d - r.amount);
    }
  }
  // Damage-counter placement (Powerful Hand etc.) bypasses W/R and reductions —
  // add it AFTER the multiplier/subtraction step so the preview reflects what
  // actually lands.
  for (const e of moveEffects) {
    if (e.kind === "placeCountersPerHandCard") {
      d += e.countersPerCard * 10 * atkPl.hand.length;
    }
    if (e.kind === "distributeDamage" && !e.benchOnly) {
      // Distributed damage to ANY opp Pokémon: the player can route all
      // hits at the Active for max single-target damage, so add the full
      // potential to the "vs current defender" preview (Oil Salvo case).
      d += e.times * e.perHit;
    }
    // Bench-only distribution (Phantom Dive's 6 counters on Bench) does
    // NOT contribute to the Active-defender preview — those counters land
    // elsewhere. The button reflects the base damage (200) only; the 60
    // bench spread shows up in-game when the attack resolves.
  }
  return Math.max(0, Math.floor(d));
}

export function toolOnKoActions(
  state: GameState,
  defender: PokemonInPlay,
): ToolOnKoAction[] {
  if (!toolsActive(state)) return [];
  const out: ToolOnKoAction[] = [];
  for (const tool of defender.tools) {
    switch (tool.name) {
      case "Amulet of Hope":
        out.push({ kind: "searchDeckAnyN", count: 3 });
        break;
      case "Heavy Baton": {
        // Only triggers if the KO'd holder has an exact Retreat Cost of 4.
        // Card text: "move up to 3 Basic Energy cards." Cap at 3.
        const cost = defender.card.retreatCost ?? [];
        if (cost.length === 4) out.push({ kind: "moveEnergyToBench", max: 3 });
        break;
      }
    }
  }
  return out;
}
