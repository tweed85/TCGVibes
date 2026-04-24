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

const hasSubtype = (c: PokemonCard, s: string) => (c.subtypes ?? []).includes(s);
const hasType = (c: PokemonCard, t: EnergyType) => c.types.includes(t);
const isNamed = (c: PokemonCard, prefix: string) => c.name.startsWith(prefix);

const RULE_BOX_MARKERS = ["ex", "EX", "V", "VMAX", "VSTAR", "V-UNION", "GX", "Radiant"];
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

// Festival Grounds: Pokémon with any Energy attached can't be affected by
// Special Conditions. Return true if the holder is currently status-immune.
export function isStatusImmune(p: PokemonInPlay, state: GameState): boolean {
  if (state.stadium?.card.name !== "Festival Grounds") return false;
  return p.attachedEnergy.length > 0;
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
  }
  return toolAttacks.length > 0 ? [...base, ...toolAttacks] : base;
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
// The type check runs against the Pokémon currently in play (target), not
// against the evolution card in hand. If a Grass Basic evolves into a non-
// Grass Stage 1 this turn via FoV, the new Stage 1 can't re-evolve this turn
// regardless (evolvedThisTurn blocks), so we don't need to check the
// evolution card's type.
export function canEvolveOnPlayTurn(
  state: GameState,
  target: PokemonInPlay,
): boolean {
  if (state.stadium?.card.name !== "Forest of Vitality") return false;
  if (state.turn === 1) return false;
  // Must be a Basic (not already evolved) and a Grass Pokémon.
  if (!target.card.subtypes.includes("Basic")) return false;
  if (target.evolvedThisTurn) return false;
  return target.card.types.includes("Grass");
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
// Pokémon Checkup (so 30 instead of 10).
export function poisonExtraCounters(state: GameState, p: PokemonInPlay): number {
  if (state.stadium?.card.name !== "Perilous Jungle") return 0;
  if (p.card.types.includes("Darkness")) return 0;
  return 20;
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
  return Math.max(10, hp);
}

// --- Retreat cost ---------------------------------------------------------

function toolRetreatReduction(tool: TrainerCard): number {
  switch (tool.name) {
    case "Air Balloon": return 2;
    case "Rescue Board": return 1;
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

export function effectiveRetreatCost(p: PokemonInPlay, state?: GameState): EnergyType[] {
  const cost = p.card.retreatCost ?? [];
  let reduce = 0;
  let surcharge = 0;
  if (state?.stadium) {
    reduce += stadiumRetreatReduction(state.stadium.card, p.card);
    surcharge += stadiumRetreatSurcharge(state.stadium.card, p.card);
  }
  if (!state || toolsActive(state)) {
    for (const tool of p.tools) {
      if (toolRetreatGate(tool, p.card)) reduce += toolRetreatReduction(tool);
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
  const atkType = attacker.card.types[0];
  for (const b of pl.thisTurnAttackBonuses) {
    if (b.againstEx && !defEx) continue;
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
};

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
    if (!abilitiesActiveOn(state, holder.card)) continue;
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
        // Reduces damage *from* attackers with a rule box (ex/V) by 20.
        // Gates on the attacker, not the defender.
        if (hasRuleBox(attacker.card)) red += 20;
        break;
    }
  }
  if (toolsActive(state)) {
    const attackerType = attacker.card.types[0];
    for (const tool of defender.tools) {
      red += toolDamageReduction(tool, attackerType, defender);
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
): EnergyType[] {
  if (!toolsActive(state)) return rawCost;
  let reduce = 0;
  for (const tool of attacker.tools) reduce += toolAttackCostReduction(tool, attacker, state);
  // Nighttime Mine: Tera attacks cost Colorless more.
  if (state.stadium?.card.name === "Nighttime Mine" && hasSubtype(attacker.card, "Tera")) {
    reduce -= 1; // negative = surcharge; raises cost by 1 Colorless
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
  | { kind: "applyStatusToAttacker"; status: "asleep" | "burned" | "confused" | "paralyzed" | "poisoned" }; // TR Hypnotizer

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
          out.push({ kind: "counterDamage", target: "attacker", damage: 60 });
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
  for (const e of move.effects ?? []) {
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
        const cost = defender.card.retreatCost ?? [];
        if (cost.length === 4) out.push({ kind: "moveEnergyToBench", max: 4 });
        break;
      }
    }
  }
  return out;
}
