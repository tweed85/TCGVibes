// Private cross-resolver helpers extracted from effects.ts as part of
// Stage 6A.2. None of these are part of the public engine surface;
// effects.ts imports them back and calls them from resolveAttackEffects.
// The underscore prefix marks the file as internal-only.

import { logEvent } from "../rules";
import type { AttackContext } from "./predicate";
import type {
  AttackEffect,
  AttackSearchFilter,
  Card,
  EnergyCard,
  GameState,
  PokemonInPlay,
} from "../types";

export function shuffleArr<T>(state: GameState, arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = state.rng.int(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// Predicate matching an `AttackSearchFilter` against a Card.
export function searchFilterMatches(
  c: Card,
  filter: AttackSearchFilter,
): boolean {
  switch (filter.kind) {
    case "any":
      return true;
    case "pokemon":
      return c.supertype === "Pokémon";
    case "basicPokemon":
      return c.supertype === "Pokémon" && (c.subtypes ?? []).includes("Basic");
    case "stage1Pokemon":
      return c.supertype === "Pokémon" && (c.subtypes ?? []).includes("Stage 1");
    case "stage2Pokemon":
      return c.supertype === "Pokémon" && (c.subtypes ?? []).includes("Stage 2");
    case "evolutionPokemon":
      return c.supertype === "Pokémon" && ((c.subtypes ?? []).includes("Stage 1") || (c.subtypes ?? []).includes("Stage 2"));
    case "pokemonOfType":
      return c.supertype === "Pokémon" && c.types.includes(filter.energyType);
    case "basicEnergy":
      return c.supertype === "Energy" && (c.subtypes ?? []).includes("Basic");
    case "basicEnergyType":
      return c.supertype === "Energy" && (c.subtypes ?? []).includes("Basic") &&
        (c as EnergyCard).provides.includes(filter.energyType);
    case "supporter":
      return c.supertype === "Trainer" && (c.subtypes ?? []).includes("Supporter");
    case "item":
      return c.supertype === "Trainer" && (c.subtypes ?? []).includes("Item");
    case "tool":
      return c.supertype === "Trainer" && ((c.subtypes ?? []).includes("Pokémon Tool") || (c.subtypes ?? []).includes("Tool"));
    case "trainer":
      return c.supertype === "Trainer";
  }
}

export function describeFilter(f: AttackSearchFilter): string {
  switch (f.kind) {
    case "any": return "card";
    case "pokemon": return "Pokémon";
    case "basicPokemon": return "Basic Pokémon";
    case "stage1Pokemon": return "Stage 1 Pokémon";
    case "stage2Pokemon": return "Stage 2 Pokémon";
    case "evolutionPokemon": return "Evolution Pokémon";
    case "pokemonOfType": return `${f.energyType} Pokémon`;
    case "basicEnergy": return "Basic Energy";
    case "basicEnergyType": return `Basic ${f.energyType} Energy`;
    case "supporter": return "Supporter";
    case "item": return "Item";
    case "tool": return "Pokémon Tool";
    case "trainer": return "Trainer";
  }
}

// Resolve an attack-driven deck search. AI auto-picks; human gets pendingPick.
// Destination: hand / bench (Pokémon only) / attachSelf (Energy → attacker) /
// attachAll (Energy → first matching ally).
export function resolveSearchDeckAttack(
  state: GameState,
  ctx: AttackContext,
  e: Extract<AttackEffect, { kind: "searchDeckAttack" }>,
): void {
  const pl = state.players[ctx.attackerOwner];
  const prizes = new Set(pl.prizes);
  const pool = pl.deck.filter((c) => !prizes.has(c) && searchFilterMatches(c, e.filter));
  if (pool.length === 0) {
    logEvent(state, ctx.attackerOwner, `${ctx.move.name}: no ${describeFilter(e.filter)} in deck.`);
    shuffleArr(state, pl.deck);
    return;
  }
  // Cap by destination logistics.
  let max = e.max;
  if (e.destination === "bench") {
    max = Math.min(max, 5 - pl.bench.length);
    if (max <= 0) {
      logEvent(state, ctx.attackerOwner, `${ctx.move.name}: bench is full.`);
      return;
    }
  }
  // For AI, auto-pick the first `max` matching cards.
  if (pl.isAI || max === 0) {
    const picked: Card[] = [];
    for (let i = 0; i < max; i++) {
      const idx = pl.deck.findIndex((c) => !prizes.has(c) && searchFilterMatches(c, e.filter));
      if (idx < 0) break;
      const [c] = pl.deck.splice(idx, 1);
      picked.push(c);
    }
    if (picked.length > 0) deliverSearchedCards(state, ctx, e, picked);
    shuffleArr(state, pl.deck);
    return;
  }
  // Humans: open a pending pick. Pull pool out of the deck for the picker.
  pl.deck = pl.deck.filter((c) => prizes.has(c) || !pool.includes(c));
  const description = describeFilter(e.filter);
  const destPhrase =
    e.destination === "hand" ? "to your hand" :
    e.destination === "bench" ? "onto your Bench" :
    e.destination === "attachSelf" ? `to ${ctx.attacker.card.name}` :
    "to your Pokémon";
  state.pendingPick = {
    player: ctx.attackerOwner,
    label: `${ctx.move.name}: pick up to ${max} ${description} ${destPhrase}`,
    pool,
    min: 0, // attack-driven searches are always "may" in practice
    max: Math.min(max, pool.length),
    unpicked: "shuffleIntoDeck",
    source: "deck",
    toBench: e.destination === "bench",
    attachToInstanceId: e.destination === "attachSelf" ? ctx.attacker.instanceId : undefined,
    attachAll: e.destination === "attachAll",
  };
  state.phase = "pick";
}

export function deliverSearchedCards(
  state: GameState,
  ctx: AttackContext,
  e: Extract<AttackEffect, { kind: "searchDeckAttack" }>,
  cards: Card[],
): void {
  const pl = state.players[ctx.attackerOwner];
  if (cards.length === 0) return;
  if (e.destination === "hand") {
    pl.hand.push(...cards);
    logEvent(state, ctx.attackerOwner, `${ctx.move.name}: puts ${cards.map((c) => c.name).join(", ")} into hand.`);
    return;
  }
  if (e.destination === "bench") {
    for (const c of cards) {
      if (pl.bench.length >= 5) break;
      if (c.supertype !== "Pokémon") continue;
      pl.bench.push({
        instanceId: `sda-${Date.now()}-${Math.random()}`,
        card: c,
        damage: 0,
        attachedEnergy: [],
        evolvedFrom: [],
        tools: [],
        playedThisTurn: true,
        evolvedThisTurn: false,
        statuses: [],
        abilityUsedThisTurn: false,
      });
    }
    logEvent(state, ctx.attackerOwner, `${ctx.move.name}: benches ${cards.map((c) => c.name).join(", ")}.`);
    return;
  }
  if (e.destination === "attachSelf") {
    for (const c of cards) {
      if (c.supertype !== "Energy") continue;
      ctx.attacker.attachedEnergy.push(c as EnergyCard);
    }
    logEvent(state, ctx.attackerOwner, `${ctx.move.name}: attaches ${cards.map((c) => c.name).join(", ")} to ${ctx.attacker.card.name}.`);
    return;
  }
  if (e.destination === "attachAll") {
    // Round-robin across allies starting with attacker.
    const allies = [ctx.attacker, ...pl.bench];
    let i = 0;
    for (const c of cards) {
      if (c.supertype !== "Energy") continue;
      const dest = allies[i % allies.length];
      dest.attachedEnergy.push(c as EnergyCard);
      i++;
    }
    logEvent(state, ctx.attackerOwner, `${ctx.move.name}: attaches ${cards.length} Energy across your Pokémon.`);
    return;
  }
}

// Mist Energy / Rocky Fighting Energy: "Prevent all effects of attacks used by
// your opponent's Pokémon done to the Pokémon this card is attached to."
// Damage still goes through — only non-damage effects are prevented.
//
// Also handles ability-based effect prevention:
// - Emperor's Stance / Unaware: "Prevent all effects of attacks used by your
//   opponent's Pokémon done to this Pokémon. (Damage is not an effect.)"
// - Luminous Wing: "Prevent all effects of your opponent's Pokémon's
//   Abilities done to this Pokémon." Activated only against ability-effects;
//   we still surface it via the same gate so callers don't apply non-damage
//   ability effects against the holder.
export function effectsPrevented(defender: PokemonInPlay): boolean {
  for (const e of defender.attachedEnergy) {
    if (e.name === "Mist Energy") return true;
    if (e.name === "Rocky Fighting Energy" && defender.card.types.includes("Fighting")) return true;
  }
  for (const ab of defender.card.abilities ?? []) {
    if (ab.name === "Emperor's Stance" || ab.name === "Unaware" || ab.name === "Luminous Wing") {
      return true;
    }
  }
  return false;
}
