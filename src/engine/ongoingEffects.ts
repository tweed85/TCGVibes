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

// Dizzying Valley: Confused doesn't clear on evolve/devolve.
export function confusedPersistsOnEvolve(state: GameState): boolean {
  return state.stadium?.card.name === "Dizzying Valley";
}

// Forest of Vitality: Grass Pokémon can evolve the turn they're played
// (except on turn 1).
export function canEvolveOnPlayTurn(state: GameState, evolved: PokemonCard): boolean {
  if (state.stadium?.card.name !== "Forest of Vitality") return false;
  if (state.turn === 1) return false;
  return evolved.types.includes("Grass");
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
        if (!hasRuleBox(defCard)) red += 9999;
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
  | { kind: "counterDamage"; target: "attacker"; damage: number }; // Punk Helmet

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
    }
  }
  return out;
}
