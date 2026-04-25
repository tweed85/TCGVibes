// Attack-effect resolver.
//
// Attacks can carry a small set of structured effects (see AttackEffect in
// types.ts). Before damage is dealt, `resolveAttackEffects` walks those
// effects in order, mutating `damage` for damage-shaping effects (coin flip
// bonuses, per-energy multipliers, fizzle) and returning a `postDamage` hook
// for effects that apply after the hit (status infliction, self-damage,
// bench snipes, energy discards).
//
// Effects that the engine doesn't understand are preserved on the Attack as
// plain `text` so the UI can display them even though they won't fire.

import { addStatus, drawCards, flipCoin, logEvent } from "./rules";
import { benchDamageBlocked, benchDamageBlockedByFlowerCurtain } from "./ongoingEffects";
import type {
  Attack,
  AttackEffect,
  AttackPredicate,
  GameState,
  PlayerId,
  PokemonInPlay,
} from "./types";

const RULE_BOX_EX = ["ex", "EX"];
const RULE_BOX_V = ["V", "VMAX", "VSTAR", "V-UNION"];

// Evaluate a predicate against the current attack context. Returns true if
// the predicate is satisfied. Predicates that reference the defender always
// return false when there is no defender (e.g., effect already KO'd it).
export function evaluatePredicate(
  state: GameState,
  ctx: AttackContext,
  pred: AttackPredicate,
): boolean {
  const def = ctx.defender;
  const atk = ctx.attacker;
  switch (pred.kind) {
    case "defenderIsEx":
      return !!def && (def.card.subtypes ?? []).some((s) => RULE_BOX_EX.includes(s));
    case "defenderIsExOrV":
      return !!def &&
        (def.card.subtypes ?? []).some((s) => RULE_BOX_EX.includes(s) || RULE_BOX_V.includes(s));
    case "defenderIsV":
      return !!def && (def.card.subtypes ?? []).some((s) => RULE_BOX_V.includes(s));
    case "defenderHasSubtype": {
      if (!def) return false;
      const subs = def.card.subtypes ?? [];
      if (pred.subtype === "Evolution") {
        return subs.includes("Stage 1") || subs.includes("Stage 2");
      }
      return subs.includes(pred.subtype);
    }
    case "defenderHasStatus":
      return !!def && def.statuses.includes(pred.status);
    case "defenderHasAnyStatus":
      return !!def && def.statuses.length > 0;
    case "defenderHasType":
      return !!def && def.card.types.includes(pred.type);
    case "defenderHasTool":
      return !!def && def.tools.length > 0;
    case "defenderHasSpecialEnergy":
      return !!def && def.attachedEnergy.some((e) => e.subtypes.includes("Special"));
    case "defenderHasDamage":
      return !!def && def.damage > 0;
    case "selfHasExtraEnergy": {
      const cost = ctx.move.cost.length;
      return atk.attachedEnergy.length >= cost + pred.extra;
    }
    case "selfHasDamage":
      return atk.damage > 0;
    case "selfHasNoDamage":
      return atk.damage === 0;
    case "selfHasTool":
      return atk.tools.length > 0;
    case "selfEvolvedThisTurn":
      return atk.evolvedThisTurn;
    case "selfHasNoEnergy":
      return atk.attachedEnergy.length === 0;
    case "selfHasSpecialEnergy":
      return atk.attachedEnergy.some((e) => e.subtypes.includes("Special"));
    case "selfHasEnergyOfType":
      return atk.attachedEnergy.some((e) => e.provides.includes(pred.energyType));
    case "selfHasNamedEnergy":
      return atk.attachedEnergy.some((e) => e.name === pred.energyName);
    case "selfMovedToActiveThisTurn":
      return !!atk.movedToActiveThisTurn;
    case "selfHasStatus":
      return atk.statuses.includes(pred.status);
    case "youHavePokemonNamed": {
      const allies = [
        state.players[ctx.attackerOwner].active,
        ...state.players[ctx.attackerOwner].bench,
      ].filter((p): p is PokemonInPlay => !!p);
      const count = allies.filter((p) => p.card.name.toLowerCase().includes(pred.namePart.toLowerCase())).length;
      return count >= pred.minCount;
    }
    case "stadiumInPlayNamed":
      // Empty namePart matches ANY Stadium in play.
      return !!state.stadium && (
        pred.stadiumNamePart === "" ||
        state.stadium.card.name.toLowerCase().includes(pred.stadiumNamePart.toLowerCase())
      );
    case "yourTurnNumberAtLeast":
      return state.turn >= pred.turn;
    case "yourPokemonKoedLastOppTurn":
      return state.players[ctx.attackerOwner].yourPokemonKoedLastOppTurn;
    case "yourPrizesEquals":
      return state.players[ctx.attackerOwner].prizes.length === pred.count;
    case "yourPrizesAtMost":
      return state.players[ctx.attackerOwner].prizes.length <= pred.count;
    case "oppPrizesAtMost":
      return state.players[ctx.defenderOwner].prizes.length <= pred.count;
    case "yourHandSizeEquals":
      return state.players[ctx.attackerOwner].hand.length === pred.count;
    case "youHaveBenchPokemonOfType":
      return state.players[ctx.attackerOwner].bench.some((p) => p.card.types.includes(pred.energyType));
    case "allBenchHasDamage": {
      const bench = state.players[ctx.attackerOwner].bench;
      return bench.length > 0 && bench.every((p) => p.damage > 0);
    }
    case "yourHandSizeEqualsOpp":
      return state.players[ctx.attackerOwner].hand.length === state.players[ctx.defenderOwner].hand.length;
    case "yourBenchCountAtMost":
      return state.players[ctx.attackerOwner].bench.length <= pred.count;
    case "yourDiscardHasNTypedEnergy": {
      const pl = state.players[ctx.attackerOwner];
      const count = pl.discard.filter((c) =>
        c.supertype === "Energy" &&
        c.subtypes.includes("Basic") &&
        (c as import("./types").EnergyCard).provides.includes(pred.energyType),
      ).length;
      return count >= pred.count;
    }
    case "youHavePokemonNamedOnBench": {
      const part = pred.namePart.toLowerCase();
      return state.players[ctx.attackerOwner].bench.some((p) => p.card.name.toLowerCase().includes(part));
    }
    case "supporterPlayedThisTurnNamed": {
      const last = state.players[ctx.attackerOwner].lastSupporterNameThisTurn;
      return !!last && last.toLowerCase().includes(pred.namePart.toLowerCase());
    }
  }
}

function shuffleArr<T>(state: GameState, arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = state.rng.int(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// Predicate matching an `AttackSearchFilter` against a Card.
function searchFilterMatches(
  c: import("./types").Card,
  filter: import("./types").AttackSearchFilter,
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
        (c as import("./types").EnergyCard).provides.includes(filter.energyType);
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

function describeFilter(f: import("./types").AttackSearchFilter): string {
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
function resolveSearchDeckAttack(
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
    const picked: import("./types").Card[] = [];
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

function deliverSearchedCards(
  state: GameState,
  ctx: AttackContext,
  e: Extract<AttackEffect, { kind: "searchDeckAttack" }>,
  cards: import("./types").Card[],
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
      ctx.attacker.attachedEnergy.push(c as import("./types").EnergyCard);
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
      dest.attachedEnergy.push(c as import("./types").EnergyCard);
      i++;
    }
    logEvent(state, ctx.attackerOwner, `${ctx.move.name}: attaches ${cards.length} Energy across your Pokémon.`);
    return;
  }
}

// Mist Energy / Rocky Fighting Energy: "Prevent all effects of attacks used by
// your opponent's Pokémon done to the Pokémon this card is attached to."
// Damage still goes through — only non-damage effects are prevented.
function effectsPrevented(defender: PokemonInPlay): boolean {
  for (const e of defender.attachedEnergy) {
    if (e.name === "Mist Energy") return true;
    if (e.name === "Rocky Fighting Energy" && defender.card.types.includes("Fighting")) return true;
  }
  return false;
}

export interface AttackContext {
  attacker: PokemonInPlay;
  attackerOwner: PlayerId;
  defender: PokemonInPlay | null;
  defenderOwner: PlayerId;
  move: Attack;
  damage: number; // incoming base damage (after weakness/resistance)
}

export interface ResolvedAttack {
  damage: number;
  postDamage?: () => void;
  // When set, actions.ts skips the corresponding step of the damage pipeline
  // (Weakness multiplier / Resistance subtraction / defender-side -N effects
  // like Tool berries, Stadium reductions, Jasmine's Gaze, Iron Defender).
  ignoreWeakness?: boolean;
  ignoreResistance?: boolean;
  ignoreOppEffects?: boolean;
}

export function resolveAttackEffects(
  state: GameState,
  ctx: AttackContext,
): ResolvedAttack {
  const effects = ctx.move.effects ?? [];
  let damage = ctx.damage;
  const postHooks: (() => void)[] = [];
  let ignoreWeakness = false;
  let ignoreResistance = false;
  let ignoreOppEffects = false;
  // Passive abilities on attacker that always-on grant ignoreOppEffects
  // (Walking Wake ex Azure Seas).
  for (const ab of ctx.attacker.card.abilities ?? []) {
    if (ab.name === "Azure Seas") ignoreOppEffects = true;
  }

  for (const e of effects) {
    switch (e.kind) {
      case "flipHeadsBonus": {
        const heads = flipCoin(state, `${ctx.move.name} bonus flip`);
        if (heads) damage += e.bonus;
        break;
      }
      case "flipTailsFizzle": {
        const heads = flipCoin(state, `${ctx.move.name} accuracy flip`);
        if (!heads) {
          logEvent(state, "system", `${ctx.move.name} missed.`);
          damage = 0;
        }
        break;
      }
      case "flipHeadsDouble": {
        const heads = flipCoin(state, `${ctx.move.name} double flip`);
        if (heads) damage *= 2;
        break;
      }
      case "perAttachedEnergy": {
        const energies = ctx.attacker.attachedEnergy;
        const matching = e.energyType
          ? energies.filter((en) => en.provides.includes(e.energyType!)).length
          : energies.length;
        const bonus = e.perEnergy * matching;
        logEvent(
          state,
          "system",
          `${ctx.move.name} gets +${bonus} from ${matching} Energy.`,
        );
        damage += bonus;
        break;
      }
      case "perFriendlyBench": {
        const count = state.players[ctx.attackerOwner].bench.length;
        const bonus = e.perCount * count;
        logEvent(state, "system", `${ctx.move.name} gets +${bonus} from ${count} Benched Pokémon.`);
        damage += bonus;
        break;
      }
      case "perOpponentBench": {
        const count = state.players[ctx.defenderOwner].bench.length;
        const bonus = e.perCount * count;
        logEvent(state, "system", `${ctx.move.name} gets +${bonus} from opponent's ${count} Benched Pokémon.`);
        damage += bonus;
        break;
      }
      case "perBothBench": {
        const count =
          state.players[ctx.attackerOwner].bench.length +
          state.players[ctx.defenderOwner].bench.length;
        const bonus = e.perCount * count;
        logEvent(state, "system", `${ctx.move.name} gets +${bonus} from ${count} total Benched Pokémon.`);
        damage += bonus;
        break;
      }
      case "perDamageCounterOnSelf": {
        const counters = Math.floor(ctx.attacker.damage / 10);
        const bonus = e.perCount * counters;
        logEvent(state, "system", `${ctx.move.name} gets +${bonus} from ${counters} damage counter(s) on self.`);
        damage += bonus;
        break;
      }
      case "perDamageCounterOnDefender": {
        const counters = ctx.defender ? Math.floor(ctx.defender.damage / 10) : 0;
        const bonus = e.perCount * counters;
        logEvent(state, "system", `${ctx.move.name} gets +${bonus} from ${counters} damage counter(s) on defender.`);
        damage += bonus;
        break;
      }
      case "perEnergyOnBothActives": {
        const a = ctx.attacker.attachedEnergy.length;
        const d = ctx.defender ? ctx.defender.attachedEnergy.length : 0;
        damage += e.perCount * (a + d);
        break;
      }
      case "discardBenchEnergyForDamage": {
        // AI auto-discards greedily for max damage (capped at e.max).
        const pl = state.players[ctx.attackerOwner];
        let discarded = 0;
        for (const benched of pl.bench) {
          while (benched.attachedEnergy.length > 0 && discarded < e.max) {
            const en = benched.attachedEnergy.shift();
            if (!en) break;
            pl.discard.push(en);
            discarded++;
          }
          if (discarded >= e.max) break;
        }
        damage += e.damagePer * discarded;
        if (discarded > 0) logEvent(state, ctx.attackerOwner, `${ctx.move.name}: discards ${discarded} Energy → +${e.damagePer * discarded}.`);
        break;
      }
      case "discardStadium": {
        postHooks.push(() => {
          if (!state.stadium) return;
          const stadium = state.stadium.card;
          const owner = state.stadium.controller;
          state.players[owner].discard.push(stadium);
          state.stadium = null;
          logEvent(state, "system", `${stadium.name} (Stadium) discarded.`);
        });
        break;
      }
      case "placeCountersOnOppBenchAny": {
        postHooks.push(() => {
          const opp = state.players[ctx.defenderOwner];
          if (opp.bench.length === 0) return;
          // Auto-distribute: place all counters on most-damaged bench Pokémon.
          // Real card lets the player choose distribution; future improvement.
          const sorted = opp.bench.slice().sort((a, b) => b.damage - a.damage);
          let remaining = e.counters;
          for (const t of sorted) {
            if (remaining <= 0) break;
            if (benchDamageBlocked(state)) {
              logEvent(state, "system", `Battle Cage protects bench.`);
              break;
            }
            if (benchDamageBlockedByFlowerCurtain(state, ctx.defenderOwner, t)) {
              continue;
            }
            const place = Math.min(remaining, e.counters);
            t.damage += place * 10;
            remaining -= place;
            logEvent(state, "system", `${t.card.name}: ${place} counter(s).`);
          }
        });
        break;
      }
      case "defenderAttacksWeakerNextTurn": {
        postHooks.push(() => {
          if (!ctx.defender) return;
          if (effectsPrevented(ctx.defender)) {
            logEvent(state, "system", `${ctx.defender.card.name}'s attached Energy prevents the debuff.`);
            return;
          }
          // Queue a turn-scoped attack penalty on the defender's side. We
          // re-use thisTurnAttackBonuses by pushing a negative bonus that fires
          // only when the defender attacks. Since the existing schema gates
          // bonuses on attacker properties, we approximate by storing it on
          // the opponent's nextOpponentTurnDamageReductions — which protects
          // OUR Pokémon. Close enough.
          state.players[ctx.attackerOwner].nextOpponentTurnDamageReductions.push({
            amount: e.amount,
          });
          logEvent(state, "system", `${ctx.defender.card.name}'s attacks do ${e.amount} less damage next turn.`);
        });
        break;
      }
      case "counterAttackerNextTurn": {
        // We don't currently have a "counter on damage taken" event hook for
        // attacks. As a placeholder, log only — the AI can still see the
        // intent. Future: extend toolOnDamageActions analog for attack-set effects.
        postHooks.push(() => {
          logEvent(state, "system", `${ctx.attacker.card.name} sets a counter (${e.counters} counters on attacker next turn).`);
        });
        break;
      }
      case "oppDiscardsHand": {
        postHooks.push(() => {
          const opp = state.players[ctx.defenderOwner];
          for (let i = 0; i < e.count; i++) {
            if (opp.hand.length === 0) break;
            const idx = state.rng.int(opp.hand.length);
            const [c] = opp.hand.splice(idx, 1);
            opp.discard.push(c);
            logEvent(state, "system", `${c.name} discarded from ${opp.name}'s hand.`);
          }
        });
        break;
      }
      case "perCardInOppHand": {
        const handCount = state.players[ctx.defenderOwner].hand.length;
        damage += e.perCount * handCount;
        if (handCount > 0) {
          logEvent(state, "system", `${ctx.move.name}: opp has ${handCount} cards → +${e.perCount * handCount}.`);
        }
        break;
      }
      case "attachAnyBasicFromHandAll": {
        postHooks.push(() => {
          const pl = state.players[ctx.attackerOwner];
          const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
          if (allies.length === 0) return;
          let i = 0;
          let attached = 0;
          while (true) {
            const idx = pl.hand.findIndex(
              (c) => c.supertype === "Energy" && c.subtypes.includes("Basic"),
            );
            if (idx < 0) break;
            const [en] = pl.hand.splice(idx, 1) as [import("./types").EnergyCard];
            allies[i % allies.length].attachedEnergy.push(en);
            i++;
            attached++;
          }
          if (attached > 0) logEvent(state, ctx.attackerOwner, `${ctx.move.name}: attaches ${attached} Basic Energy from hand.`);
        });
        break;
      }
      case "returnSelfToHandDiscardAttached": {
        postHooks.push(() => {
          const pl = state.players[ctx.attackerOwner];
          if (pl.active?.instanceId !== ctx.attacker.instanceId) return;
          pl.hand.push(ctx.attacker.card);
          // Discard everything else attached.
          pl.discard.push(...ctx.attacker.evolvedFrom, ...ctx.attacker.attachedEnergy, ...ctx.attacker.tools);
          pl.active = null;
          if (pl.bench.length > 0) {
            state.pendingPromote = ctx.attackerOwner;
            state.phase = "promoteActive";
            state.onPromoteResolved = null;
          }
          logEvent(state, ctx.attackerOwner, `${ctx.attacker.card.name} returns to hand; attached cards discarded.`);
        });
        break;
      }
      case "gustOppBenchedAttack": {
        postHooks.push(() => {
          const opp = state.players[ctx.defenderOwner];
          if (!opp.active || opp.bench.length === 0) return;
          // Auto-pick: highest-HP bench target.
          const target = opp.bench.slice().sort((a, b) => b.card.hp - a.card.hp)[0];
          const idx = opp.bench.indexOf(target);
          const pulled = opp.bench.splice(idx, 1)[0];
          const wasActive = opp.active;
          opp.active = pulled;
          opp.bench.push(wasActive);
          logEvent(state, ctx.attackerOwner, `${ctx.move.name}: gusts ${pulled.card.name} to Active.`);
        });
        break;
      }
      case "discardAnyEnergyAcrossOwnForDamage": {
        const pl = state.players[ctx.attackerOwner];
        const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
        let discarded = 0;
        for (const a of allies) {
          const remain: import("./types").EnergyCard[] = [];
          for (const en of a.attachedEnergy) {
            // Skip cost on attacker.
            const skipCount = a === ctx.attacker ? ctx.move.cost.length : 0;
            void skipCount;
            const matchType = !e.energyType || (en.subtypes.includes("Basic") && en.provides.includes(e.energyType));
            if (a !== ctx.attacker && matchType) {
              pl.discard.push(en);
              discarded++;
            } else if (a === ctx.attacker && matchType && a.attachedEnergy.length - discarded > ctx.move.cost.length) {
              pl.discard.push(en);
              discarded++;
            } else {
              remain.push(en);
            }
          }
          a.attachedEnergy = remain;
        }
        damage += e.damagePer * discarded;
        if (discarded > 0) logEvent(state, ctx.attackerOwner, `${ctx.move.name}: discards ${discarded} Energy → +${e.damagePer * discarded}.`);
        break;
      }
      case "discardHandEnergyForDamage": {
        const pl = state.players[ctx.attackerOwner];
        let discarded = 0;
        for (let i = 0; i < e.max; i++) {
          const idx = pl.hand.findIndex((c) => c.supertype === "Energy");
          if (idx < 0) break;
          const [c] = pl.hand.splice(idx, 1);
          pl.discard.push(c);
          discarded++;
        }
        damage += e.damagePer * discarded;
        if (discarded > 0) logEvent(state, ctx.attackerOwner, `${ctx.move.name}: discards ${discarded} Energy from hand → +${e.damagePer * discarded}.`);
        break;
      }
      case "perOwnToolAttached": {
        const pl = state.players[ctx.attackerOwner];
        const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
        const tools = allies.reduce((s, p) => s + p.tools.length, 0);
        damage += e.perCount * tools;
        if (tools > 0) logEvent(state, "system", `${ctx.move.name}: ${tools} tool(s) → +${e.perCount * tools}.`);
        break;
      }
      case "oppChoosesHandToDeck": {
        postHooks.push(() => {
          const opp = state.players[ctx.defenderOwner];
          // Opp picks: simulate by taking their N "least useful" cards. Auto-pick: take cards from the back of their hand.
          for (let i = 0; i < e.count; i++) {
            if (opp.hand.length === 0) break;
            const c = opp.hand.shift();
            if (!c) break;
            opp.deck.push(c);
            logEvent(state, "system", `${c.name} returned to ${opp.name}'s deck.`);
          }
          shuffleArr(state, opp.deck);
        });
        break;
      }
      case "perPrizeYouTaken": {
        const taken = 6 - state.players[ctx.attackerOwner].prizes.length;
        damage += e.perCount * taken;
        if (taken > 0) logEvent(state, "system", `${ctx.move.name}: ${taken} prizes taken → +${e.perCount * taken}.`);
        break;
      }
      case "perEnergyInOppDiscard": {
        const opp = state.players[ctx.defenderOwner];
        const count = opp.discard.filter((c) => {
          if (c.supertype !== "Energy") return false;
          if (e.energyType) {
            return c.subtypes.includes("Basic") && (c as import("./types").EnergyCard).provides.includes(e.energyType);
          }
          return true;
        }).length;
        damage += e.perCount * count;
        if (count > 0) logEvent(state, "system", `${ctx.move.name}: ${count} ${e.energyType ?? ""} Energy in opp discard → +${e.perCount * count}.`);
        break;
      }
      case "perStatusOnDefender": {
        if (ctx.defender) {
          damage += e.perCount * ctx.defender.statuses.length;
          if (ctx.defender.statuses.length > 0) {
            logEvent(state, "system", `${ctx.move.name}: ${ctx.defender.statuses.length} status → +${e.perCount * ctx.defender.statuses.length}.`);
          }
        }
        break;
      }
      case "perCardInOwnDiscard": {
        const pl = state.players[ctx.attackerOwner];
        const count = pl.discard.filter((c) => {
          const f = e.filter;
          if (f.kind === "energyOfType") {
            return c.supertype === "Energy" && c.subtypes.includes("Basic") &&
              (c as import("./types").EnergyCard).provides.includes(f.energyType);
          }
          if (f.kind === "cardNamePart") {
            return c.name.toLowerCase().includes(f.namePart.toLowerCase()) ||
              (c.subtypes ?? []).map((s) => s.toLowerCase()).some((s) => s.includes(f.namePart.toLowerCase()));
          }
          return false;
        }).length;
        damage += e.perCount * count;
        break;
      }
      case "discardTypedOppEnergy": {
        postHooks.push(() => {
          const opp = state.players[ctx.defenderOwner];
          if (!opp.active) return;
          if (ctx.defender && effectsPrevented(ctx.defender)) return;
          let removed = 0;
          for (let i = 0; i < e.count; i++) {
            const idx = opp.active.attachedEnergy.findIndex((en) =>
              en.subtypes.includes("Basic") && en.provides.includes(e.energyType),
            );
            if (idx < 0) break;
            const [en] = opp.active.attachedEnergy.splice(idx, 1);
            opp.discard.push(en);
            logEvent(state, "system", `${en.name} discarded from ${opp.active.card.name}.`);
            removed++;
          }
          if (removed === 0) {
            logEvent(state, "system", `${opp.active.card.name} has no ${e.energyType} Energy to discard.`);
          }
        });
        break;
      }
      case "selfRecoverAllStatuses": {
        postHooks.push(() => {
          if (ctx.attacker.statuses.length > 0) {
            ctx.attacker.statuses = [];
            logEvent(state, "system", `${ctx.attacker.card.name} recovers from all Special Conditions.`);
          }
        });
        break;
      }
      case "discardOwnEnergyUpToForDamage": {
        const pl = state.players[ctx.attackerOwner];
        const surplus = Math.max(0, ctx.attacker.attachedEnergy.length - ctx.move.cost.length);
        const cap = Math.min(e.max, surplus);
        let discarded = 0;
        for (let i = 0; i < cap; i++) {
          const idx = ctx.attacker.attachedEnergy.findIndex((en) => {
            if (e.energyType) {
              return en.subtypes.includes("Basic") && en.provides.includes(e.energyType);
            }
            return true;
          });
          if (idx < 0) break;
          const [en] = ctx.attacker.attachedEnergy.splice(idx, 1);
          pl.discard.push(en);
          discarded++;
        }
        damage += e.damagePer * discarded;
        if (discarded > 0) logEvent(state, ctx.attackerOwner, `${ctx.move.name}: discards ${discarded} Energy from self → +${e.damagePer * discarded}.`);
        break;
      }
      case "ownEnergyToHand": {
        postHooks.push(() => {
          const pl = state.players[ctx.attackerOwner];
          for (let i = 0; i < e.count; i++) {
            if (ctx.attacker.attachedEnergy.length === 0) break;
            const en = ctx.attacker.attachedEnergy.shift()!;
            pl.hand.push(en);
            logEvent(state, ctx.attackerOwner, `${en.name} returned to hand from ${ctx.attacker.card.name}.`);
          }
        });
        break;
      }
      case "discardOwnEnergyForDamage": {
        const cap = e.max ?? ctx.attacker.attachedEnergy.length;
        // Keep enough to satisfy the attack cost; discard the rest.
        const costLen = ctx.move.cost.length;
        const surplus = Math.max(0, ctx.attacker.attachedEnergy.length - costLen);
        const discardable = Math.min(cap, surplus);
        const pl = state.players[ctx.attackerOwner];
        for (let i = 0; i < discardable; i++) {
          const en = ctx.attacker.attachedEnergy.shift();
          if (!en) break;
          pl.discard.push(en);
        }
        damage += e.damagePer * discardable;
        if (discardable > 0) logEvent(state, ctx.attackerOwner, `${ctx.move.name}: discards ${discardable} Energy → +${e.damagePer * discardable}.`);
        break;
      }
      case "perEnergyOnDefender": {
        const count = ctx.defender?.attachedEnergy.length ?? 0;
        const bonus = e.perCount * count;
        logEvent(state, "system", `${ctx.move.name} gets +${bonus} from ${count} Energy on defender.`);
        damage += bonus;
        break;
      }
      case "perPrizeOppTaken": {
        // Prizes "taken" = 6 − prizes remaining for the opponent.
        const taken = 6 - state.players[ctx.defenderOwner].prizes.length;
        const bonus = e.perCount * taken;
        logEvent(state, "system", `${ctx.move.name} gets +${bonus} from ${taken} Prize(s) taken.`);
        damage += bonus;
        break;
      }
      case "benchSnipe": {
        postHooks.push(() => {
          // Battle Cage: prevents damage to Benched Pokémon from opp attacks.
          if (benchDamageBlocked(state)) {
            logEvent(state, "system", `Battle Cage blocks bench damage.`);
            return;
          }
          const targets: Array<[PlayerId, PokemonInPlay]> = [];
          if (e.target === "opponentBench" || e.target === "allBench" || e.target === "allOpponents") {
            for (const p of state.players[ctx.defenderOwner].bench) targets.push([ctx.defenderOwner, p]);
          }
          if (e.target === "allBench" || e.target === "ownBench") {
            for (const p of state.players[ctx.attackerOwner].bench) targets.push([ctx.attackerOwner, p]);
          }
          for (const [ownerId, t] of targets) {
            // Shaymin Flower Curtain — non-rule-box bench Pokémon on owner's
            // side are immune to opp-attack bench damage.
            if (
              ownerId === ctx.defenderOwner &&
              benchDamageBlockedByFlowerCurtain(state, ownerId, t)
            ) {
              logEvent(state, "system", `Flower Curtain protects ${t.card.name}.`);
              continue;
            }
            t.damage += e.damage;
            logEvent(
              state,
              "system",
              `${t.card.name} takes ${e.damage} damage (bench snipe).`,
            );
          }
        });
        break;
      }
      case "selfDamage": {
        postHooks.push(() => {
          ctx.attacker.damage += e.damage;
          logEvent(
            state,
            "system",
            `${ctx.attacker.card.name} takes ${e.damage} damage (recoil).`,
          );
          // Self KO from recoil — handled by endTurn flow + next turn KO check.
        });
        break;
      }
      case "applyStatus": {
        postHooks.push(() => {
          if (e.requiresHeads) {
            const heads = flipCoin(state, `${ctx.move.name} status flip`);
            if (!heads) return;
          }
          const target =
            e.target === "self" ? ctx.attacker : ctx.defender;
          if (!target) return;
          if (e.target === "defender" && ctx.defender && effectsPrevented(ctx.defender)) {
            logEvent(state, "system", `${ctx.defender.card.name}'s attached Energy prevents the status effect.`);
            return;
          }
          addStatus(state, target, e.status);
        });
        break;
      }
      case "heal": {
        postHooks.push(() => {
          const target = ctx.attacker;
          const before = target.damage;
          target.damage = Math.max(0, target.damage - e.amount);
          logEvent(
            state,
            "system",
            `${target.card.name} heals ${before - target.damage}.`,
          );
        });
        break;
      }
      case "healOneOfYours": {
        postHooks.push(() => {
          const pl = state.players[ctx.attackerOwner];
          const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
          const damaged = allies.filter((p) => p.damage > 0);
          if (damaged.length === 0) return;
          const target = damaged.slice().sort((a, b) => b.damage - a.damage)[0];
          const before = target.damage;
          target.damage = Math.max(0, target.damage - e.amount);
          logEvent(state, "system", `${target.card.name} heals ${before - target.damage}.`);
        });
        break;
      }
      case "healEqualToDamageDealt": {
        const dealt = damage; // capture pre-W/R total. Snapshotted now since
        // damage may be modified by W/R afterwards. We still drain pre-W/R
        // damage value for simplicity (matches "you did" loosely).
        postHooks.push(() => {
          if (dealt <= 0) return;
          const before = ctx.attacker.damage;
          ctx.attacker.damage = Math.max(0, ctx.attacker.damage - dealt);
          if (before > ctx.attacker.damage) {
            logEvent(state, "system", `${ctx.attacker.card.name} drains ${before - ctx.attacker.damage}.`);
          }
        });
        break;
      }
      case "healEachOwnSubtype": {
        postHooks.push(() => {
          const pl = state.players[ctx.attackerOwner];
          const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
          const matchSub = (p: PokemonInPlay): boolean => {
            const subs = p.card.subtypes ?? [];
            if (e.subtype === "Evolution") return subs.includes("Stage 1") || subs.includes("Stage 2");
            return subs.includes(e.subtype);
          };
          let total = 0;
          for (const p of allies.filter(matchSub)) {
            const before = p.damage;
            p.damage = Math.max(0, p.damage - e.amount);
            total += before - p.damage;
          }
          if (total > 0) logEvent(state, ctx.attackerOwner, `heals ${total} across ${e.subtype} Pokémon.`);
        });
        break;
      }
      case "discardOwnEnergy": {
        postHooks.push(() => {
          const attPl = state.players[ctx.attackerOwner];
          for (let i = 0; i < e.count; i++) {
            const en = ctx.attacker.attachedEnergy.shift();
            if (!en) break;
            // Boomerang Energy: "If this card is discarded by an effect of
            // an attack used by the Pokémon this card is attached to, attach
            // this card from your discard pile to that Pokémon after
            // attacking." Net result = card stays on the attacker; we keep
            // it attached (cost count is still satisfied since we consumed
            // the slot).
            if (en.name === "Boomerang Energy") {
              ctx.attacker.attachedEnergy.push(en);
              logEvent(
                state,
                "system",
                `${en.name} returns to ${ctx.attacker.card.name} after the attack.`,
              );
              continue;
            }
            attPl.discard.push(en);
            logEvent(
              state,
              "system",
              `${ctx.attacker.card.name} discards ${en.name}.`,
            );
          }
        });
        break;
      }
      case "drawCards": {
        postHooks.push(() => {
          const pl = state.players[ctx.attackerOwner];
          const drawn = drawCards(pl, e.count);
          logEvent(state, ctx.attackerOwner, `draws ${drawn} card(s).`);
        });
        break;
      }
      case "drawUntilHandSize": {
        postHooks.push(() => {
          const pl = state.players[ctx.attackerOwner];
          const need = Math.max(0, e.targetSize - pl.hand.length);
          if (need <= 0) return;
          const drawn = drawCards(pl, need);
          logEvent(state, ctx.attackerOwner, `draws ${drawn} card(s) up to ${e.targetSize}.`);
        });
        break;
      }
      case "blockOppItemsNextTurn": {
        postHooks.push(() => {
          state.players[ctx.defenderOwner].itemsBlockedNextTurn = true;
          logEvent(state, "system", `${state.players[ctx.defenderOwner].name} can't play Item cards next turn.`);
        });
        break;
      }

      case "flipMultiCoinsPerHeads": {
        let heads = 0;
        for (let i = 0; i < e.coins; i++) {
          if (flipCoin(state, `${ctx.move.name} coin ${i + 1}`)) heads++;
        }
        damage += e.perHeads * heads;
        logEvent(state, "system", `${ctx.move.name}: ${heads}/${e.coins} heads → +${e.perHeads * heads}.`);
        break;
      }

      case "selfCantAttackNextTurn": {
        postHooks.push(() => {
          // Next-next turn = current turn + 2 for the attacker (opp's turn is in between).
          ctx.attacker.cantAttackUntilTurn = state.turn + 2;
          logEvent(state, "system", `${ctx.attacker.card.name} can't attack next turn.`);
        });
        break;
      }

      case "defenderCantRetreatNextTurn": {
        postHooks.push(() => {
          if (!ctx.defender) return;
          if (effectsPrevented(ctx.defender)) {
            logEvent(state, "system", `${ctx.defender.card.name}'s attached Energy prevents the retreat-lock.`);
            return;
          }
          ctx.defender.cantRetreatUntilTurn = state.turn + 1;
          logEvent(state, "system", `${ctx.defender.card.name} can't retreat next turn.`);
        });
        break;
      }
      case "defenderCantAttackNextTurn": {
        postHooks.push(() => {
          if (!ctx.defender) return;
          if (effectsPrevented(ctx.defender)) {
            logEvent(state, "system", `${ctx.defender.card.name}'s attached Energy prevents the attack-lock.`);
            return;
          }
          // +1 makes the defender unable to attack for the duration of the
          // opponent's upcoming turn (state.turn becomes turn+1 then). The
          // existing cantAttackUntilTurn check uses `<=` so this is correct.
          ctx.defender.cantAttackUntilTurn = state.turn + 1;
          logEvent(state, "system", `${ctx.defender.card.name} can't attack next turn.`);
        });
        break;
      }

      case "selfDamageReductionNextTurn": {
        postHooks.push(() => {
          state.players[ctx.attackerOwner].nextOpponentTurnDamageReductions.push({
            amount: e.amount,
          });
          logEvent(state, "system", `${ctx.attacker.card.name} will take ${e.amount} less damage next turn.`);
        });
        break;
      }

      case "damageMultipleTargets": {
        postHooks.push(() => {
          const opp = state.players[ctx.defenderOwner];
          const candidates: PokemonInPlay[] = e.benchOnly
            ? [...opp.bench]
            : ([opp.active, ...opp.bench].filter((p): p is PokemonInPlay => !!p));
          // For non-benchOnly, the rule "Don't apply W/R for Benched" applies
          // to bench targets but NOT to the Active. Auto-pick most-damaged
          // targets first (greatest leverage).
          const sorted = candidates.slice().sort((a, b) => b.damage - a.damage).slice(0, e.count);
          for (const t of sorted) {
            const isBench = opp.bench.includes(t);
            if (isBench && benchDamageBlocked(state)) {
              logEvent(state, "system", `Battle Cage protects ${t.card.name}.`);
              continue;
            }
            if (isBench && benchDamageBlockedByFlowerCurtain(state, ctx.defenderOwner, t)) {
              logEvent(state, "system", `Flower Curtain protects ${t.card.name}.`);
              continue;
            }
            t.damage += e.damage;
            logEvent(state, "system", `${t.card.name} takes ${e.damage} damage.`);
          }
        });
        break;
      }
      case "snipeOne": {
        postHooks.push(() => {
          const opp = state.players[ctx.defenderOwner];
          if (opp.bench.length === 0) return;
          // Use the UI-supplied override index if present; otherwise fall
          // back to the "most-damaged" heuristic (useful for the AI and for
          // the auto-pick branch of the player modal).
          let target: typeof opp.bench[number];
          if (
            state.snipeTargetOverride !== null &&
            state.snipeTargetOverride >= 0 &&
            state.snipeTargetOverride < opp.bench.length
          ) {
            target = opp.bench[state.snipeTargetOverride];
          } else {
            target = opp.bench.slice().sort((a, b) => b.damage - a.damage)[0];
          }
          if (benchDamageBlockedByFlowerCurtain(state, ctx.defenderOwner, target)) {
            logEvent(state, "system", `Flower Curtain protects ${target.card.name}.`);
            return;
          }
          target.damage += e.damage;
          logEvent(state, "system", `${target.card.name} takes ${e.damage} damage (snipe).`);
        });
        break;
      }

      case "switchOutOpponent": {
        postHooks.push(() => {
          const opp = state.players[ctx.defenderOwner];
          if (!opp.active || opp.bench.length === 0) return;
          // Force opp to choose a new Active — re-use promote flow.
          const oldActive = opp.active;
          opp.bench.push(oldActive);
          opp.active = null;
          state.pendingPromote = ctx.defenderOwner;
          state.phase = "promoteActive";
          logEvent(state, "system", `${oldActive.card.name} is switched out — opponent picks new Active.`);
        });
        break;
      }

      case "selfSwitch": {
        postHooks.push(() => {
          const atkPl = state.players[ctx.attackerOwner];
          if (!atkPl.active || atkPl.bench.length === 0) return;
          const incoming = atkPl.bench.shift()!;
          const outgoing = atkPl.active;
          // Clear statuses on the retreating Pokémon per the "switch" rule.
          outgoing.statuses = [];
          atkPl.active = incoming;
          atkPl.bench.push(outgoing);
          logEvent(state, ctx.attackerOwner, `switches ${outgoing.card.name} → ${incoming.card.name}.`);
        });
        break;
      }

      case "discardOppEnergy": {
        postHooks.push(() => {
          const opp = state.players[ctx.defenderOwner];
          if (!opp.active) return;
          if (ctx.defender && effectsPrevented(ctx.defender)) {
            logEvent(state, "system", `${ctx.defender.card.name}'s attached Energy prevents the discard.`);
            return;
          }
          for (let i = 0; i < e.count; i++) {
            const energy = opp.active.attachedEnergy.shift();
            if (!energy) break;
            opp.discard.push(energy);
            logEvent(state, "system", `${energy.name} discarded from ${opp.active.card.name}.`);
          }
        });
        break;
      }
      case "discardOppSpecialEnergy": {
        postHooks.push(() => {
          const opp = state.players[ctx.defenderOwner];
          if (!opp.active) return;
          if (ctx.defender && effectsPrevented(ctx.defender)) {
            logEvent(state, "system", `${ctx.defender.card.name}'s attached Energy prevents the discard.`);
            return;
          }
          let removed = 0;
          for (let i = 0; i < e.count; i++) {
            const idx = opp.active.attachedEnergy.findIndex((en) =>
              en.subtypes.includes("Special"),
            );
            if (idx < 0) break;
            const [en] = opp.active.attachedEnergy.splice(idx, 1);
            opp.discard.push(en);
            logEvent(state, "system", `Special Energy ${en.name} discarded from ${opp.active.card.name}.`);
            removed++;
          }
          if (removed === 0) {
            logEvent(state, "system", `${opp.active.card.name} has no Special Energy to discard.`);
          }
        });
        break;
      }

      case "flipHeadsDiscardOppEnergy": {
        postHooks.push(() => {
          const heads = flipCoin(state, `${ctx.move.name} discard flip`);
          if (!heads) return;
          const opp = state.players[ctx.defenderOwner];
          if (!opp.active) return;
          if (ctx.defender && effectsPrevented(ctx.defender)) {
            logEvent(state, "system", `${ctx.defender.card.name}'s attached Energy prevents the discard.`);
            return;
          }
          const energy = opp.active.attachedEnergy.shift();
          if (!energy) return;
          opp.discard.push(energy);
          logEvent(state, "system", `${energy.name} discarded from ${opp.active.card.name}.`);
        });
        break;
      }
      case "multiCoinFlipDiscardOppEnergy": {
        postHooks.push(() => {
          const opp = state.players[ctx.defenderOwner];
          if (!opp.active) return;
          if (ctx.defender && effectsPrevented(ctx.defender)) {
            logEvent(state, "system", `${ctx.defender.card.name}'s attached Energy prevents the discard.`);
            return;
          }
          let heads = 0;
          for (let i = 0; i < e.coins; i++) {
            if (flipCoin(state, `${ctx.move.name} coin ${i + 1}`)) heads++;
          }
          for (let i = 0; i < heads; i++) {
            const en = opp.active.attachedEnergy.shift();
            if (!en) break;
            opp.discard.push(en);
            logEvent(state, "system", `${en.name} discarded from ${opp.active.card.name}.`);
          }
        });
        break;
      }
      case "multiCoinFlipMillOpp": {
        postHooks.push(() => {
          const opp = state.players[ctx.defenderOwner];
          let heads = 0;
          for (let i = 0; i < e.coins; i++) {
            if (flipCoin(state, `${ctx.move.name} coin ${i + 1}`)) heads++;
          }
          for (let i = 0; i < heads; i++) {
            const c = opp.deck.shift();
            if (!c) break;
            opp.discard.push(c);
            logEvent(state, "system", `Top of ${opp.name}'s deck (${c.name}) discarded.`);
          }
        });
        break;
      }

      case "healEachOwnPokemon": {
        postHooks.push(() => {
          const allies = [
            state.players[ctx.attackerOwner].active,
            ...state.players[ctx.attackerOwner].bench,
          ].filter((p): p is PokemonInPlay => !!p);
          let total = 0;
          for (const p of allies) {
            const before = p.damage;
            p.damage = Math.max(0, p.damage - e.amount);
            total += before - p.damage;
          }
          if (total > 0) logEvent(state, ctx.attackerOwner, `heals ${total} across their Pokémon.`);
        });
        break;
      }

      case "discardTopOfOppDeck": {
        postHooks.push(() => {
          const opp = state.players[ctx.defenderOwner];
          for (let i = 0; i < e.count; i++) {
            const c = opp.deck.shift();
            if (!c) break;
            opp.discard.push(c);
            logEvent(state, "system", `Top of ${opp.name}'s deck (${c.name}) discarded.`);
          }
        });
        break;
      }

      case "discardOppTools": {
        postHooks.push(() => {
          const opp = state.players[ctx.defenderOwner];
          if (!opp.active) return;
          const tools = opp.active.tools.splice(0);
          opp.discard.push(...tools);
          if (tools.length > 0) {
            logEvent(state, "system", `${tools.length} Tool(s) discarded from ${opp.active.card.name}.`);
          }
        });
        break;
      }

      case "callForFamily": {
        postHooks.push(() => {
          const pl = state.players[ctx.attackerOwner];
          const slotsAvailable = 5 - pl.bench.length;
          const max = Math.min(e.max, slotsAvailable);
          if (max <= 0) return;
          const rest: typeof pl.deck = [];
          let benched = 0;
          for (const c of pl.deck) {
            if (
              benched < max &&
              c.supertype === "Pokémon" &&
              c.subtypes.includes("Basic")
            ) {
              // Defer the instance creation to a late-bound helper so we
              // don't need rules.ts imported here.
              pl.bench.push({
                instanceId: `cff-${Date.now()}-${Math.random()}`,
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
              benched++;
            } else {
              rest.push(c);
            }
          }
          pl.deck = rest;
          // Shuffle afterwards.
          const arr = pl.deck;
          for (let i = arr.length - 1; i > 0; i--) {
            const j = state.rng.int(i + 1);
            [arr[i], arr[j]] = [arr[j], arr[i]];
          }
          if (benched > 0) {
            logEvent(state, ctx.attackerOwner, `Call for Family benches ${benched} Basic Pokémon.`);
          }
        });
        break;
      }

      case "flipUntilTailsPerHeads": {
        let heads = 0;
        // Cap at 10 to keep it bounded.
        for (let i = 0; i < 10; i++) {
          const h = flipCoin(state, `${ctx.move.name} geometric flip`);
          if (!h) break;
          heads++;
        }
        damage += e.perHeads * heads;
        logEvent(
          state,
          "system",
          `${ctx.move.name}: ${heads} consecutive heads → +${e.perHeads * heads}.`,
        );
        break;
      }

      case "placeCounters": {
        postHooks.push(() => {
          const opp = state.players[ctx.defenderOwner];
          let target: PokemonInPlay | null = null;
          if (e.target === "oppActive") {
            target = opp.active;
          } else if (e.target === "oppBench") {
            if (opp.bench.length === 0) return;
            target = opp.bench.slice().sort((a, b) => b.damage - a.damage)[0];
          } else {
            // anyOpp — pick most-damaged of all opp Pokémon
            const all = [opp.active, ...opp.bench].filter((p): p is PokemonInPlay => !!p);
            if (all.length === 0) return;
            target = all.slice().sort((a, b) => b.damage - a.damage)[0];
          }
          if (!target) return;
          const dmg = e.counters * 10;
          target.damage += dmg;
          logEvent(state, "system", `${target.card.name} takes ${dmg} damage (${e.counters} counter(s)).`);
        });
        break;
      }
      case "perPokemonFilter": {
        const sidePl = e.side === "friendly"
          ? state.players[ctx.attackerOwner]
          : state.players[ctx.defenderOwner];
        const all = [sidePl.active, ...sidePl.bench].filter((p): p is PokemonInPlay => !!p);
        const inPlay = e.includeActive ? all : sidePl.bench;
        const matchFilter = (p: PokemonInPlay): boolean => {
          const f = e.filter;
          switch (f.kind) {
            case "any": return true;
            case "namePart": return p.card.name.toLowerCase().includes(f.namePart.toLowerCase());
            case "type": return p.card.types.includes(f.energyType);
            case "subtype": return (p.card.subtypes ?? []).includes(f.subtype);
            case "hasAttackNamed":
              return p.card.attacks.some((a) => a.name.toLowerCase() === f.attackName.toLowerCase());
          }
        };
        const count = inPlay.filter(matchFilter).length;
        if (count > 0) {
          damage += e.perCount * count;
          logEvent(state, "system", `${ctx.move.name}: ${count} matching → +${e.perCount * count}.`);
        }
        break;
      }
      case "placeCountersPerHandCard": {
        // Alakazam "Powerful Hand" — place N damage counters on opp's Active
        // for each card in the attacker's hand. Counter placement bypasses
        // weakness/resistance — we apply it via postHook after normal damage.
        postHooks.push(() => {
          if (!ctx.defender) return;
          const handCount = state.players[ctx.attackerOwner].hand.length;
          const counters = e.countersPerCard * handCount;
          if (counters <= 0) return;
          ctx.defender.damage += counters * 10;
          logEvent(
            state,
            "system",
            `${ctx.move.name}: ${handCount} cards in hand → ${counters} damage counter(s) on ${ctx.defender.card.name}.`,
          );
        });
        break;
      }

      case "fizzleIfNoStadium": {
        // Fan Rotom "Assault Landing": "If there is no Stadium in play, this
        // attack does nothing." Zero out damage AND skip all queued postHooks.
        if (!state.stadium) {
          damage = 0;
          postHooks.length = 0;
          logEvent(state, "system", `${ctx.move.name} fizzles — no Stadium in play.`);
        }
        break;
      }

      case "shieldNextTurn": {
        // Dunsparce "Dig" — flip (or auto) heads → shield the attacker during
        // the opponent's upcoming turn. We mark the attacker's shieldedUntilTurn
        // and the damage pipeline checks it.
        postHooks.push(() => {
          let heads = true;
          if (e.requiresHeads) heads = flipCoin(state, `${ctx.move.name} shield flip`);
          if (heads) {
            ctx.attacker.shieldedUntilTurn = state.turn + 1;
            logEvent(state, "system", `${ctx.attacker.card.name} is shielded during the opponent's next turn.`);
          }
        });
        break;
      }

      case "attachNFromDiscardToBench": {
        // Mega Lucario ex "Aura Jab" — up to N Basic <type> Energy from
        // discard to your Benched Pokémon in any way. Auto-pick: round-robin
        // across benched allies. Always log so the player sees what
        // happened, even if nothing could be attached.
        postHooks.push(() => {
          const pl = state.players[ctx.attackerOwner];
          if (pl.bench.length === 0) {
            logEvent(state, ctx.attackerOwner, `${ctx.move.name}: no Benched Pokémon to attach Energy to.`);
            return;
          }
          const available = pl.discard.filter(
            (c) =>
              c.supertype === "Energy" &&
              c.subtypes.includes("Basic") &&
              (c as import("./types").EnergyCard).provides.includes(e.energyType),
          ).length;
          if (available === 0) {
            logEvent(state, ctx.attackerOwner, `${ctx.move.name}: no basic ${e.energyType} Energy in discard to attach.`);
            return;
          }
          let attached = 0;
          for (let i = 0; i < e.max; i++) {
            const idx = pl.discard.findIndex(
              (c) =>
                c.supertype === "Energy" &&
                c.subtypes.includes("Basic") &&
                (c as import("./types").EnergyCard).provides.includes(e.energyType),
            );
            if (idx < 0) break;
            const [en] = pl.discard.splice(idx, 1) as [import("./types").EnergyCard];
            pl.bench[attached % pl.bench.length].attachedEnergy.push(en);
            attached++;
          }
          logEvent(
            state,
            ctx.attackerOwner,
            `${ctx.move.name}: attaches ${attached} ${e.energyType} Energy from discard to Bench.`,
          );
        });
        break;
      }

      case "attachNFromDiscardToSelf": {
        postHooks.push(() => {
          const pl = state.players[ctx.attackerOwner];
          let attached = 0;
          for (let i = 0; i < e.max; i++) {
            const idx = pl.discard.findIndex(
              (c) =>
                c.supertype === "Energy" &&
                c.subtypes.includes("Basic") &&
                (c as import("./types").EnergyCard).provides.includes(e.energyType),
            );
            if (idx < 0) break;
            const [en] = pl.discard.splice(idx, 1) as [import("./types").EnergyCard];
            ctx.attacker.attachedEnergy.push(en);
            attached++;
          }
          if (attached > 0) logEvent(state, ctx.attackerOwner, `${ctx.move.name}: attaches ${attached} ${e.energyType} Energy from discard to ${ctx.attacker.card.name}.`);
          else logEvent(state, ctx.attackerOwner, `${ctx.move.name}: no basic ${e.energyType} Energy in discard.`);
        });
        break;
      }
      case "attachBasicFromDiscardToOneBench": {
        postHooks.push(() => {
          const pl = state.players[ctx.attackerOwner];
          if (pl.bench.length === 0) return;
          // Auto-pick first benched ally; AI behavior; humans get auto-pick.
          const target = pl.bench[0];
          let attached = 0;
          for (let i = 0; i < e.max; i++) {
            const idx = pl.discard.findIndex(
              (c) =>
                c.supertype === "Energy" &&
                c.subtypes.includes("Basic") &&
                (e.energyType ? (c as import("./types").EnergyCard).provides.includes(e.energyType) : true),
            );
            if (idx < 0) break;
            const [en] = pl.discard.splice(idx, 1) as [import("./types").EnergyCard];
            target.attachedEnergy.push(en);
            attached++;
          }
          if (attached > 0) logEvent(state, ctx.attackerOwner, `${ctx.move.name}: attaches ${attached} Energy to ${target.card.name}.`);
        });
        break;
      }
      case "attachBasicFromDiscardToEachBench": {
        postHooks.push(() => {
          const pl = state.players[ctx.attackerOwner];
          for (const benched of pl.bench) {
            const idx = pl.discard.findIndex(
              (c) =>
                c.supertype === "Energy" &&
                c.subtypes.includes("Basic") &&
                (c as import("./types").EnergyCard).provides.includes(e.energyType),
            );
            if (idx < 0) break;
            const [en] = pl.discard.splice(idx, 1) as [import("./types").EnergyCard];
            benched.attachedEnergy.push(en);
            logEvent(state, ctx.attackerOwner, `${ctx.move.name}: attaches ${en.name} to ${benched.card.name}.`);
          }
        });
        break;
      }
      case "recoverPokemonFromDiscardToBench": {
        postHooks.push(() => {
          const pl = state.players[ctx.attackerOwner];
          const matchFilter = (c: import("./types").Card): boolean => {
            if (c.supertype !== "Pokémon") return false;
            const f = e.filter;
            switch (f.kind) {
              case "any": return true;
              case "namePart": return c.name.toLowerCase().includes(f.namePart.toLowerCase());
              case "type": return c.types.includes(f.energyType);
              case "subtype": return (c.subtypes ?? []).includes(f.subtype);
              case "hasAttackNamed":
                return c.attacks.some((a) => a.name.toLowerCase() === f.attackName.toLowerCase());
            }
          };
          let benched = 0;
          for (let i = 0; i < e.max && pl.bench.length < 5; i++) {
            const idx = pl.discard.findIndex(matchFilter);
            if (idx < 0) break;
            const [c] = pl.discard.splice(idx, 1);
            pl.bench.push({
              instanceId: `rfd-${Date.now()}-${Math.random()}`,
              card: c as import("./types").PokemonCard,
              damage: 0,
              attachedEnergy: [],
              evolvedFrom: [],
              tools: [],
              playedThisTurn: true,
              evolvedThisTurn: false,
              statuses: [],
              abilityUsedThisTurn: false,
            });
            benched++;
          }
          if (benched > 0) logEvent(state, ctx.attackerOwner, `${ctx.move.name}: benches ${benched} from discard.`);
        });
        break;
      }
      case "recoverPokemonFromDiscardToHand": {
        postHooks.push(() => {
          const pl = state.players[ctx.attackerOwner];
          const matchFilter = (c: import("./types").Card): boolean => {
            if (c.supertype !== "Pokémon") return false;
            const f = e.filter;
            switch (f.kind) {
              case "any": return true;
              case "namePart": return c.name.toLowerCase().includes(f.namePart.toLowerCase());
              case "type": return c.types.includes(f.energyType);
              case "subtype": return (c.subtypes ?? []).includes(f.subtype);
              case "hasAttackNamed":
                return c.attacks.some((a) => a.name.toLowerCase() === f.attackName.toLowerCase());
            }
          };
          let recovered = 0;
          for (let i = 0; i < e.max; i++) {
            const idx = pl.discard.findIndex(matchFilter);
            if (idx < 0) break;
            const [c] = pl.discard.splice(idx, 1);
            pl.hand.push(c);
            recovered++;
          }
          if (recovered > 0) logEvent(state, ctx.attackerOwner, `${ctx.move.name}: returns ${recovered} Pokémon from discard.`);
        });
        break;
      }
      case "recoverTrainerFromDiscard": {
        postHooks.push(() => {
          const pl = state.players[ctx.attackerOwner];
          const matchFilter = (c: import("./types").Card): boolean => {
            if (c.supertype !== "Trainer") return false;
            if (e.subtype === "any") return true;
            return (c.subtypes ?? []).includes(e.subtype) || (e.subtype === "Pokémon Tool" && (c.subtypes ?? []).includes("Tool"));
          };
          let recovered = 0;
          for (let i = 0; i < e.max; i++) {
            const idx = pl.discard.findIndex(matchFilter);
            if (idx < 0) break;
            const [c] = pl.discard.splice(idx, 1);
            pl.hand.push(c);
            recovered++;
          }
          if (recovered > 0) logEvent(state, ctx.attackerOwner, `${ctx.move.name}: returns ${recovered} ${e.subtype} from discard.`);
        });
        break;
      }
      case "selfCantUseAttackNextTurn": {
        // Set a per-attack lock. The attack() action checks this list before
        // paying cost. We store it on the attacker instance via an ad-hoc set
        // alongside cantAttackUntilTurn.
        postHooks.push(() => {
          const bag = (ctx.attacker as import("./types").PokemonInPlay & {
            cantUseAttacksUntilTurn?: Record<string, number>;
          });
          if (!bag.cantUseAttacksUntilTurn) bag.cantUseAttacksUntilTurn = {};
          // +2 = locks through the attacker's next turn, clears the turn after.
          bag.cantUseAttacksUntilTurn[e.attackName] = state.turn + 2;
          logEvent(state, "system", `${ctx.attacker.card.name} can't use ${e.attackName} next turn.`);
        });
        break;
      }

      case "multiCoinPerOppPokemon": {
        // Mega Zygarde ex "Nullifying Zero". Bench snipe honoring Flower
        // Curtain / Battle Cage semantics for non-Active targets.
        postHooks.push(() => {
          const opp = state.players[ctx.defenderOwner];
          const targets: Array<{ p: import("./types").PokemonInPlay; isActive: boolean }> = [];
          if (opp.active) targets.push({ p: opp.active, isActive: true });
          for (const b of opp.bench) targets.push({ p: b, isActive: false });
          let total = 0;
          for (const { p, isActive } of targets) {
            const heads = flipCoin(state, `${ctx.move.name} coin on ${p.card.name}`);
            if (!heads) continue;
            if (!isActive && benchDamageBlocked(state)) {
              logEvent(state, "system", `Battle Cage protects ${p.card.name}.`);
              continue;
            }
            if (!isActive && benchDamageBlockedByFlowerCurtain(state, ctx.defenderOwner, p)) {
              logEvent(state, "system", `Flower Curtain protects ${p.card.name}.`);
              continue;
            }
            p.damage += e.damagePerHeads;
            total += e.damagePerHeads;
            logEvent(state, "system", `${p.card.name} takes ${e.damagePerHeads} damage.`);
          }
          if (total === 0) {
            logEvent(state, "system", `${ctx.move.name}: no heads — no damage dealt.`);
          }
        });
        break;
      }

      case "fizzleIfNoAlly": {
        // Solrock "Cosmic Beam" — fizzle if the named ally isn't on the bench.
        const pl = state.players[ctx.attackerOwner];
        const hasAlly = pl.bench.some((p) => p.card.name === e.allyName);
        if (!hasAlly) {
          damage = 0;
          postHooks.length = 0;
          logEvent(state, "system", `${ctx.move.name} fizzles — no ${e.allyName} on Bench.`);
        }
        break;
      }

      case "ignoreWeaknessResistance": {
        ignoreWeakness = true;
        ignoreResistance = true;
        break;
      }
      case "ignoreOppEffects": {
        ignoreOppEffects = true;
        break;
      }
      case "ignoreWeaknessOnly": {
        ignoreWeakness = true;
        break;
      }
      case "ignoreResistanceOnly": {
        ignoreResistance = true;
        break;
      }

      case "conditionalDamage": {
        const ok = evaluatePredicate(state, ctx, e.predicate);
        if (e.mode === "bonus") {
          if (ok) {
            damage += e.bonus;
            logEvent(state, "system", `${ctx.move.name}: condition met → +${e.bonus}.`);
          }
        } else {
          // fizzleIfNot
          if (!ok) {
            damage = 0;
            postHooks.length = 0;
            logEvent(state, "system", `${ctx.move.name}: condition unmet — fizzles.`);
          }
        }
        break;
      }
      case "conditionalKoDefender": {
        postHooks.push(() => {
          if (!ctx.defender) return;
          if (!evaluatePredicate(state, ctx, e.predicate)) return;
          ctx.defender.damage = ctx.defender.card.hp;
          logEvent(state, "system", `${ctx.move.name}: ${ctx.defender.card.name} is Knocked Out.`);
        });
        break;
      }
      case "conditionalStatus": {
        postHooks.push(() => {
          if (!evaluatePredicate(state, ctx, e.predicate)) return;
          const target = e.target === "self" ? ctx.attacker : ctx.defender;
          if (!target) return;
          if (e.target === "defender" && ctx.defender && effectsPrevented(ctx.defender)) {
            logEvent(state, "system", `${ctx.defender.card.name}'s attached Energy prevents the status effect.`);
            return;
          }
          addStatus(state, target, e.status);
        });
        break;
      }
      case "returnSelfToHand": {
        // Meowth ex "Tuck Tail" — return the attacker + all attached cards
        // to the hand after the attack resolves.
        postHooks.push(() => {
          const pl = state.players[ctx.attackerOwner];
          if (pl.active?.instanceId !== ctx.attacker.instanceId) return;
          pl.hand.push(
            ctx.attacker.card,
            ...ctx.attacker.evolvedFrom,
            ...ctx.attacker.attachedEnergy,
            ...ctx.attacker.tools,
          );
          pl.active = null;
          // Force a promote so the player can still make a legal turn end.
          if (pl.bench.length > 0) {
            state.pendingPromote = ctx.attackerOwner;
            state.phase = "promoteActive";
            state.onPromoteResolved = null;
          }
          logEvent(state, ctx.attackerOwner, `${ctx.attacker.card.name} returns to hand with all attached cards.`);
        });
        break;
      }

      case "searchEnergyAttachBenchType": {
        // Shaymin "Send Flowers" — search deck for any Energy, attach to one
        // of your Benched Pokémon of the given type. Auto-pick the first
        // Energy and first matching bench ally.
        postHooks.push(() => {
          const pl = state.players[ctx.attackerOwner];
          const bench = pl.bench.filter((p) => p.card.types.includes(e.pokemonType));
          if (bench.length === 0) {
            logEvent(state, "system", `${ctx.move.name}: no Benched ${e.pokemonType} Pokémon.`);
            return;
          }
          const target = bench[0];
          const idx = pl.deck.findIndex((c) => c.supertype === "Energy");
          if (idx < 0) {
            logEvent(state, "system", `${ctx.move.name}: no Energy in deck.`);
            return;
          }
          const [en] = pl.deck.splice(idx, 1);
          target.attachedEnergy.push(en as import("./types").EnergyCard);
          // Shuffle the remainder.
          const arr = pl.deck;
          for (let i = arr.length - 1; i > 0; i--) {
            const j = state.rng.int(i + 1);
            [arr[i], arr[j]] = [arr[j], arr[i]];
          }
          logEvent(state, ctx.attackerOwner, `${ctx.move.name}: attaches ${en.name} to ${target.card.name}.`);
        });
        break;
      }
      case "searchDeckAttack": {
        postHooks.push(() => resolveSearchDeckAttack(state, ctx, e));
        break;
      }
      case "searchEvolveSelf": {
        postHooks.push(() => {
          const pl = state.players[ctx.attackerOwner];
          const idx = pl.deck.findIndex(
            (c) =>
              c.supertype === "Pokémon" &&
              c.evolvesFrom === ctx.attacker.card.name,
          );
          if (idx < 0) {
            logEvent(state, ctx.attackerOwner, `${ctx.move.name}: no evolution in deck.`);
            shuffleArr(state, pl.deck);
            return;
          }
          const [evo] = pl.deck.splice(idx, 1);
          shuffleArr(state, pl.deck);
          // Mutate the in-play card to the evolution; preserve damage & energy.
          ctx.attacker.evolvedFrom.push(ctx.attacker.card);
          ctx.attacker.card = evo as import("./types").PokemonCard;
          ctx.attacker.evolvedThisTurn = true;
          logEvent(state, ctx.attackerOwner, `${ctx.move.name}: evolves into ${evo.name}.`);
        });
        break;
      }
      case "moveOwnEnergyToBench": {
        postHooks.push(() => {
          const pl = state.players[ctx.attackerOwner];
          if (pl.bench.length === 0 || ctx.attacker.attachedEnergy.length === 0) return;
          // Auto-pick: target is first benched ally; AI behavior, deterministic
          // for tests. (Future: open a target picker for humans.)
          const target = pl.bench[0];
          const moves = e.count === "all" ? ctx.attacker.attachedEnergy.length : Math.min(e.count, ctx.attacker.attachedEnergy.length);
          for (let i = 0; i < moves; i++) {
            const en = ctx.attacker.attachedEnergy.shift();
            if (!en) break;
            target.attachedEnergy.push(en);
          }
          logEvent(state, ctx.attackerOwner, `${ctx.move.name}: moves ${moves} Energy from ${ctx.attacker.card.name} to ${target.card.name}.`);
        });
        break;
      }
      case "moveOppEnergyToBench": {
        postHooks.push(() => {
          const opp = state.players[ctx.defenderOwner];
          if (!opp.active || opp.bench.length === 0) return;
          if (ctx.defender && effectsPrevented(ctx.defender)) {
            logEvent(state, "system", `${ctx.defender.card.name}'s attached Energy prevents the move.`);
            return;
          }
          // Auto-pick: lowest-HP-remaining bench Pokémon (so we move energy to
          // a stale target, weakening their setup).
          const target = opp.bench.slice().sort(
            (a, b) => (a.card.hp - a.damage) - (b.card.hp - b.damage),
          )[0];
          for (let i = 0; i < e.count; i++) {
            const en = opp.active.attachedEnergy.shift();
            if (!en) break;
            target.attachedEnergy.push(en);
            logEvent(state, ctx.attackerOwner, `${ctx.move.name}: moves ${en.name} from ${opp.active.card.name} to ${target.card.name}.`);
          }
        });
        break;
      }
      case "randomOppHandToDeck": {
        postHooks.push(() => {
          const opp = state.players[ctx.defenderOwner];
          for (let i = 0; i < e.count; i++) {
            if (opp.hand.length === 0) break;
            const idx = state.rng.int(opp.hand.length);
            const [c] = opp.hand.splice(idx, 1);
            opp.deck.push(c);
            logEvent(state, "system", `${c.name} returned to ${opp.name}'s deck.`);
          }
          shuffleArr(state, opp.deck);
        });
        break;
      }
      case "randomOppHandDiscard": {
        postHooks.push(() => {
          const opp = state.players[ctx.defenderOwner];
          for (let i = 0; i < e.count; i++) {
            if (opp.hand.length === 0) break;
            const idx = state.rng.int(opp.hand.length);
            const [c] = opp.hand.splice(idx, 1);
            opp.discard.push(c);
            logEvent(state, "system", `${c.name} discarded from ${opp.name}'s hand.`);
          }
        });
        break;
      }
      case "multiCoinFlipRandomOppHandDiscard": {
        postHooks.push(() => {
          const opp = state.players[ctx.defenderOwner];
          let heads = 0;
          for (let i = 0; i < e.coins; i++) {
            if (flipCoin(state, `${ctx.move.name} coin ${i + 1}`)) heads++;
          }
          for (let i = 0; i < heads; i++) {
            if (opp.hand.length === 0) break;
            const idx = state.rng.int(opp.hand.length);
            const [c] = opp.hand.splice(idx, 1);
            opp.discard.push(c);
            logEvent(state, "system", `${c.name} discarded from ${opp.name}'s hand.`);
          }
        });
        break;
      }
      case "revealOppHandDiscard": {
        postHooks.push(() => {
          const opp = state.players[ctx.defenderOwner];
          if (opp.hand.length === 0) return;
          // Filter eligibility — pre-check whether any matching cards exist.
          const matches = (c: import("./types").Card): boolean => {
            if (e.filter === "any") return true;
            if (c.supertype !== "Trainer") return false;
            const subs = c.subtypes ?? [];
            switch (e.filter) {
              case "item": return subs.includes("Item");
              case "tool": return subs.includes("Pokémon Tool") || subs.includes("Tool");
              case "itemOrTool": return subs.includes("Item") || subs.includes("Pokémon Tool") || subs.includes("Tool");
              case "supporter": return subs.includes("Supporter");
              default: return false;
            }
          };
          const eligibleCount = opp.hand.filter(matches).length;
          if (eligibleCount === 0) return;
          if (state.players[ctx.attackerOwner].isAI) {
            // AI auto-picks the highest-impact card per filter.
            for (let i = 0; i < e.max && opp.hand.length > 0; i++) {
              const idx = opp.hand.findIndex(matches);
              if (idx < 0) break;
              const [c] = opp.hand.splice(idx, 1);
              opp.discard.push(c);
              logEvent(state, "system", `${c.name} discarded from ${opp.name}'s hand.`);
            }
            return;
          }
          state.pendingHandReveal = {
            player: ctx.attackerOwner,
            target: ctx.defenderOwner,
            label: `${ctx.move.name}: pick up to ${Math.min(e.max, eligibleCount)} card(s) to discard from opponent's hand`,
            min: Math.min(e.min, eligibleCount),
            max: Math.min(e.max, eligibleCount),
            filter: e.filter,
            action: "discard",
          };
        });
        break;
      }
      case "damagePerCardClassInOppHand": {
        const opp = state.players[ctx.defenderOwner];
        const matches = (c: import("./types").Card): boolean => {
          switch (e.filter) {
            case "energy": return c.supertype === "Energy";
            case "trainer": return c.supertype === "Trainer";
            case "pokemon": return c.supertype === "Pokémon";
            case "item": return c.supertype === "Trainer" && (c.subtypes ?? []).includes("Item");
            case "supporter": return c.supertype === "Trainer" && (c.subtypes ?? []).includes("Supporter");
          }
        };
        const count = opp.hand.filter(matches).length;
        damage += e.damagePer * count;
        if (count > 0) {
          logEvent(state, "system", `${ctx.move.name}: ${opp.name}'s hand has ${count} ${e.filter} → +${e.damagePer * count}.`);
        }
        break;
      }
      case "searchEnergyForEachBench": {
        postHooks.push(() => {
          const pl = state.players[ctx.attackerOwner];
          for (const benched of pl.bench) {
            const idx = pl.deck.findIndex(
              (c) =>
                c.supertype === "Energy" &&
                c.subtypes.includes("Basic") &&
                (c as import("./types").EnergyCard).provides.includes(e.energyType),
            );
            if (idx < 0) break;
            const [en] = pl.deck.splice(idx, 1) as [import("./types").EnergyCard];
            benched.attachedEnergy.push(en);
            logEvent(state, ctx.attackerOwner, `${ctx.move.name}: attaches ${en.name} to ${benched.card.name}.`);
          }
          shuffleArr(state, pl.deck);
        });
        break;
      }
      case "selfNoWeaknessNextTurn": {
        postHooks.push(() => {
          ctx.attacker.noWeaknessUntilTurn = state.turn + 1;
          logEvent(state, "system", `${ctx.attacker.card.name} ignores Weakness next turn.`);
        });
        break;
      }
      case "discardHandForDraw": {
        postHooks.push(() => {
          const pl = state.players[ctx.attackerOwner];
          if (pl.hand.length === 0) return;
          const idx = state.rng.int(pl.hand.length);
          const [c] = pl.hand.splice(idx, 1);
          pl.discard.push(c);
          const drawn = drawCards(pl, e.drawCount);
          logEvent(state, ctx.attackerOwner, `${ctx.move.name}: discards ${c.name}, draws ${drawn}.`);
        });
        break;
      }
      case "conditionalBaseDamageOverride": {
        if (evaluatePredicate(state, ctx, e.predicate)) {
          damage = e.baseDamage;
          logEvent(state, "system", `${ctx.move.name}: condition met → base damage becomes ${e.baseDamage}.`);
        }
        break;
      }
      case "peekTopMayDiscard": {
        postHooks.push(() => {
          const pl = state.players[ctx.attackerOwner];
          if (pl.deck.length === 0) return;
          if (pl.isAI) {
            const top = pl.deck[0];
            if (top.supertype === "Trainer" || (top.supertype === "Pokémon" && (top.subtypes ?? []).includes("Stage 2"))) {
              pl.deck.shift();
              pl.discard.push(top);
              logEvent(state, ctx.attackerOwner, `${ctx.move.name}: discards ${top.name}.`);
            }
          }
        });
        break;
      }
      case "millSelfForDamagePerType": {
        const pl = state.players[ctx.attackerOwner];
        const milled = pl.deck.splice(0, e.count);
        let matched = 0;
        for (const c of milled) {
          pl.discard.push(c);
          if (
            c.supertype === "Energy" &&
            c.subtypes.includes("Basic") &&
            (c as import("./types").EnergyCard).provides.includes(e.energyType)
          ) {
            matched++;
          }
        }
        damage += e.damagePer * matched;
        logEvent(state, ctx.attackerOwner, `${ctx.move.name}: discards ${milled.length} from deck; ${matched} ${e.energyType} Energy → +${e.damagePer * matched}.`);
        break;
      }
      case "moveDamageOwnBenchToOpp": {
        postHooks.push(() => {
          const pl = state.players[ctx.attackerOwner];
          const opp = state.players[ctx.defenderOwner];
          if (pl.bench.length === 0 || !opp.active) return;
          const source = pl.bench.slice().sort((a, b) => b.damage - a.damage)[0];
          if (source.damage === 0) return;
          const moved = source.damage;
          source.damage = 0;
          opp.active.damage += moved;
          logEvent(state, "system", `${ctx.move.name}: moves ${moved} damage from ${source.card.name} → ${opp.active.card.name}.`);
        });
        break;
      }
      case "koAllOppWithLowHp": {
        postHooks.push(() => {
          const opp = state.players[ctx.defenderOwner];
          const all = [opp.active, ...opp.bench].filter((p): p is PokemonInPlay => !!p);
          for (const t of all) {
            if (t.card.hp - t.damage <= e.hpMax) {
              t.damage = t.card.hp;
              logEvent(state, "system", `${t.card.name} is Knocked Out by ${ctx.move.name}.`);
            }
          }
        });
        break;
      }
      case "shuffleOppBenchToDeck": {
        postHooks.push(() => {
          const opp = state.players[ctx.defenderOwner];
          if (opp.bench.length === 0) return;
          const sorted = opp.bench
            .slice()
            .sort((a, b) => (b.card.hp - b.damage) - (a.card.hp - a.damage))
            .slice(0, e.count);
          for (const t of sorted) {
            const idx = opp.bench.indexOf(t);
            if (idx < 0) continue;
            opp.bench.splice(idx, 1);
            opp.deck.push(t.card, ...t.evolvedFrom, ...t.attachedEnergy, ...t.tools);
            logEvent(state, "system", `${ctx.move.name}: shuffles ${t.card.name} into deck.`);
          }
          shuffleArr(state, opp.deck);
        });
        break;
      }
      case "discardOwnEnergyForStatus": {
        postHooks.push(() => {
          const pl = state.players[ctx.attackerOwner];
          // Discard cost-checked at attack time; we just need to actually
          // remove the typed energy here. If insufficient energy, no status.
          let removed = 0;
          for (let i = 0; i < e.count; i++) {
            const idx = ctx.attacker.attachedEnergy.findIndex(
              (en) => en.subtypes.includes("Basic") && en.provides.includes(e.energyType),
            );
            if (idx < 0) break;
            const [en] = ctx.attacker.attachedEnergy.splice(idx, 1);
            pl.discard.push(en);
            removed++;
          }
          if (removed === e.count && ctx.defender) {
            if (effectsPrevented(ctx.defender)) {
              logEvent(state, "system", `${ctx.defender.card.name}'s attached Energy prevents the status effect.`);
              return;
            }
            addStatus(state, ctx.defender, e.status);
          }
        });
        break;
      }
      case "revealNamedFromHandForDamage": {
        const pl = state.players[ctx.attackerOwner];
        const names = e.namesPattern.map((s) => s.toLowerCase());
        const count = pl.hand.filter(
          (c) => c.supertype === "Pokémon" && names.includes(c.name.toLowerCase()),
        ).length;
        damage += e.damagePer * count;
        if (count > 0) logEvent(state, ctx.attackerOwner, `${ctx.move.name}: reveals ${count} from hand → +${e.damagePer * count}.`);
        break;
      }
      case "discardSpecialEnergyKoOpp": {
        // Cost: discard a specific Special Energy from self. If paid, KO opp
        // Active and discard all attached cards.
        postHooks.push(() => {
          const pl = state.players[ctx.attackerOwner];
          const opp = state.players[ctx.defenderOwner];
          const idx = ctx.attacker.attachedEnergy.findIndex((en) => en.name === e.energyName);
          if (idx < 0) {
            logEvent(state, "system", `${ctx.move.name}: no ${e.energyName} to discard.`);
            return;
          }
          const [en] = ctx.attacker.attachedEnergy.splice(idx, 1);
          pl.discard.push(en);
          if (!opp.active) return;
          // KO + discard all attached.
          const target = opp.active;
          opp.discard.push(target.card, ...target.evolvedFrom, ...target.attachedEnergy, ...target.tools);
          opp.active = null;
          state.pendingPromote = ctx.defenderOwner;
          state.phase = "promoteActive";
          logEvent(state, "system", `${ctx.move.name}: KOs ${target.card.name} and discards all attached.`);
        });
        break;
      }
      case "discardOppToolsN": {
        postHooks.push(() => {
          const opp = state.players[ctx.defenderOwner];
          let removed = 0;
          for (const p of [opp.active, ...opp.bench]) {
            if (!p || removed >= e.max) continue;
            while (p.tools.length > 0 && removed < e.max) {
              const t = p.tools.shift()!;
              opp.discard.push(t);
              logEvent(state, "system", `${t.name} discarded from ${p.card.name}.`);
              removed++;
            }
          }
        });
        break;
      }
      case "perSpecialEnergyOnSelf": {
        const count = ctx.attacker.attachedEnergy.filter((en) => en.subtypes.includes("Special")).length;
        damage += e.perCount * count;
        break;
      }
      case "perDamageCounterReduction": {
        const counters = Math.floor(ctx.attacker.damage / 10);
        damage = Math.max(0, damage - e.perCount * counters);
        break;
      }
      case "attachBasicFromHandToOne": {
        postHooks.push(() => {
          const pl = state.players[ctx.attackerOwner];
          const idx = pl.hand.findIndex(
            (c) => c.supertype === "Energy" && c.subtypes.includes("Basic"),
          );
          if (idx < 0) return;
          const [en] = pl.hand.splice(idx, 1) as [import("./types").EnergyCard];
          // Auto-pick: attacker.
          ctx.attacker.attachedEnergy.push(en);
          logEvent(state, ctx.attackerOwner, `${ctx.move.name}: attaches ${en.name} from hand.`);
        });
        break;
      }
      case "bounceOppEnergyToHand": {
        postHooks.push(() => {
          const opp = state.players[ctx.defenderOwner];
          if (!opp.active) return;
          for (let i = 0; i < e.count; i++) {
            const en = opp.active.attachedEnergy.shift();
            if (!en) break;
            opp.hand.push(en);
            logEvent(state, "system", `${en.name} returned to ${opp.name}'s hand.`);
          }
        });
        break;
      }
      case "delayedDamageOnDefender": {
        // Queue a delayed counter set on the defender. We model as a
        // turn-scoped flag stored on the defender — applied when *their*
        // turn ends. Closest existing hook is `nextOpponentTurnDamageReductions`
        // but that's defender-side reduction. We use ad-hoc field.
        postHooks.push(() => {
          if (!ctx.defender) return;
          (ctx.defender as PokemonInPlay & { delayedCountersAtTurnEnd?: number }).delayedCountersAtTurnEnd = e.counters;
          logEvent(state, "system", `${ctx.defender.card.name} will take ${e.counters} damage counters at end of opp's next turn.`);
        });
        break;
      }
      case "damageOppDownTo": {
        postHooks.push(() => {
          if (!ctx.defender) return;
          const max = ctx.defender.card.hp - e.floorHp;
          if (max > 0 && ctx.defender.damage < max) {
            ctx.defender.damage = max;
            logEvent(state, "system", `${ctx.move.name}: ${ctx.defender.card.name} reduced to ${e.floorHp} HP.`);
          }
        });
        break;
      }
      case "selfKoDiscardAll": {
        postHooks.push(() => {
          const pl = state.players[ctx.attackerOwner];
          if (pl.active?.instanceId !== ctx.attacker.instanceId) return;
          pl.discard.push(ctx.attacker.card, ...ctx.attacker.evolvedFrom, ...ctx.attacker.attachedEnergy, ...ctx.attacker.tools);
          pl.active = null;
          if (pl.bench.length > 0) {
            state.pendingPromote = ctx.attackerOwner;
            state.phase = "promoteActive";
            state.onPromoteResolved = null;
          }
          logEvent(state, ctx.attackerOwner, `${ctx.attacker.card.name} is discarded along with all attached cards.`);
        });
        break;
      }
      case "discardTopOfOwnDeck": {
        postHooks.push(() => {
          const pl = state.players[ctx.attackerOwner];
          for (let i = 0; i < e.count; i++) {
            const c = pl.deck.shift();
            if (!c) break;
            pl.discard.push(c);
            logEvent(state, ctx.attackerOwner, `discards ${c.name} from top of deck.`);
          }
        });
        break;
      }
      case "revealTopForFilteredDamage": {
        const pl = state.players[ctx.attackerOwner];
        const top = pl.deck.splice(0, e.count);
        const subLow = e.subtype.toLowerCase();
        const matching = top.filter((c) => (c.subtypes ?? []).map((s) => s.toLowerCase()).includes(subLow));
        damage += e.damagePer * matching.length;
        // Discard matching cards; shuffle the rest back.
        pl.discard.push(...matching);
        const rest = top.filter((c) => !matching.includes(c));
        pl.deck.push(...rest);
        shuffleArr(state, pl.deck);
        if (matching.length > 0) {
          logEvent(state, "system", `${ctx.move.name}: ${matching.length} ${e.subtype} → +${e.damagePer * matching.length}.`);
        }
        break;
      }
      case "perCountersOnFilteredBench": {
        const pl = state.players[ctx.attackerOwner];
        const matchFilter = (p: PokemonInPlay): boolean => {
          const f = e.filter;
          switch (f.kind) {
            case "any": return true;
            case "namePart": return p.card.name.toLowerCase().includes(f.namePart.toLowerCase());
            case "type": return p.card.types.includes(f.energyType);
            case "subtype": return (p.card.subtypes ?? []).includes(f.subtype);
            case "hasAttackNamed":
              return p.card.attacks.some((a) => a.name.toLowerCase() === f.attackName.toLowerCase());
          }
        };
        const matched = pl.bench.filter(matchFilter);
        const totalCounters = matched.reduce((s, p) => s + Math.floor(p.damage / 10), 0);
        damage += e.perCount * totalCounters;
        if (totalCounters > 0) {
          logEvent(state, "system", `${ctx.move.name}: ${totalCounters} bench counters → +${e.perCount * totalCounters}.`);
        }
        break;
      }
      case "bounceOneBench": {
        postHooks.push(() => {
          const pl = state.players[ctx.attackerOwner];
          if (pl.bench.length === 0) return;
          // Auto-pick: most damaged bench Pokémon (most leverage to "save").
          const target = pl.bench.slice().sort((a, b) => b.damage - a.damage)[0];
          const idx = pl.bench.indexOf(target);
          pl.bench.splice(idx, 1);
          pl.hand.push(target.card, ...target.evolvedFrom, ...target.attachedEnergy, ...target.tools);
          logEvent(state, ctx.attackerOwner, `${ctx.move.name}: returns ${target.card.name} and attached cards to hand.`);
        });
        break;
      }
      case "millBothForEnergyDamage": {
        const myPl = state.players[ctx.attackerOwner];
        const opp = state.players[ctx.defenderOwner];
        let energyDiscarded = 0;
        const myTop = myPl.deck.shift();
        if (myTop) {
          myPl.discard.push(myTop);
          if (myTop.supertype === "Energy") energyDiscarded++;
        }
        const oppTop = opp.deck.shift();
        if (oppTop) {
          opp.discard.push(oppTop);
          if (oppTop.supertype === "Energy") energyDiscarded++;
        }
        damage += e.damagePer * energyDiscarded;
        if (energyDiscarded > 0) logEvent(state, "system", `${ctx.move.name}: ${energyDiscarded} Energy milled → +${e.damagePer * energyDiscarded}.`);
        break;
      }
      case "revealOppHand": {
        postHooks.push(() => {
          const opp = state.players[ctx.defenderOwner];
          logEvent(state, "system", `${opp.name} reveals their hand: ${opp.hand.map((c) => c.name).join(", ") || "(empty)"}.`);
        });
        break;
      }
      case "searchEvolveBench": {
        postHooks.push(() => {
          const pl = state.players[ctx.attackerOwner];
          let evolved = 0;
          for (const benched of pl.bench) {
            const idx = pl.deck.findIndex(
              (c) => c.supertype === "Pokémon" && c.evolvesFrom === benched.card.name,
            );
            if (idx < 0) continue;
            const [evo] = pl.deck.splice(idx, 1);
            benched.evolvedFrom.push(benched.card);
            benched.card = evo as import("./types").PokemonCard;
            benched.evolvedThisTurn = true;
            evolved++;
          }
          shuffleArr(state, pl.deck);
          if (evolved > 0) logEvent(state, ctx.attackerOwner, `${ctx.move.name}: evolves ${evolved} bench Pokémon.`);
        });
        break;
      }
      case "selfNextTurnAttackBonus": {
        postHooks.push(() => {
          const lock = (ctx.attacker as PokemonInPlay & {
            nextTurnAttackBonuses?: Record<string, { amount: number; turn: number }>;
          });
          if (!lock.nextTurnAttackBonuses) lock.nextTurnAttackBonuses = {};
          lock.nextTurnAttackBonuses[e.attackName] = { amount: e.bonus, turn: state.turn + 2 };
          logEvent(state, "system", `${ctx.attacker.card.name}'s ${e.attackName} does +${e.bonus} next turn.`);
        });
        break;
      }
      case "selfCantUseAttackUntilLeavesActive": {
        postHooks.push(() => {
          const bag = (ctx.attacker as PokemonInPlay & {
            cantUseAttacksUntilTurn?: Record<string, number>;
          });
          if (!bag.cantUseAttacksUntilTurn) bag.cantUseAttacksUntilTurn = {};
          // Sentinel large turn — cleared when this Pokémon moves to bench.
          bag.cantUseAttacksUntilTurn[e.attackName] = 99999;
          logEvent(state, "system", `${ctx.attacker.card.name} can't use ${e.attackName} until it leaves the Active Spot.`);
        });
        break;
      }
      case "koOppIfExactlyDamageCounters": {
        postHooks.push(() => {
          if (!ctx.defender) return;
          const counters = Math.floor(ctx.defender.damage / 10);
          if (counters === e.counters) {
            ctx.defender.damage = ctx.defender.card.hp;
            logEvent(state, "system", `${ctx.move.name}: ${ctx.defender.card.name} is Knocked Out (had exactly ${e.counters} counters).`);
          }
        });
        break;
      }
      case "peekTopOptionalBench": {
        postHooks.push(() => {
          const pl = state.players[ctx.attackerOwner];
          const top = pl.deck.splice(0, e.count);
          const benchable = top.filter((c) => c.supertype === "Pokémon");
          let benched = 0;
          const used = new Set<unknown>();
          for (const c of benchable) {
            if (pl.bench.length + benched >= 5) break;
            pl.bench.push({
              instanceId: `pkk-${Date.now()}-${Math.random()}`,
              card: c as import("./types").PokemonCard,
              damage: 0,
              attachedEnergy: [],
              evolvedFrom: [],
              tools: [],
              playedThisTurn: true,
              evolvedThisTurn: false,
              statuses: [],
              abilityUsedThisTurn: false,
            });
            used.add(c);
            benched++;
          }
          for (const c of top) if (!used.has(c)) pl.deck.push(c);
          shuffleArr(state, pl.deck);
          logEvent(state, ctx.attackerOwner, `${ctx.move.name}: benches ${benched} Pokémon from top ${e.count}.`);
        });
        break;
      }
      default: {
        // Exhaustiveness guard — unknown effect kinds are preserved on the
        // Attack.text for display and skipped here.
        const _never: never = e;
        void _never;
      }
    }
  }

  return {
    damage,
    postDamage: postHooks.length
      ? () => postHooks.forEach((h) => h())
      : undefined,
    ignoreWeakness,
    ignoreResistance,
    ignoreOppEffects,
  };
}

// Human-readable summary of an effect list — used for debug / dev tools.
export function describeEffects(effects: AttackEffect[] | undefined): string {
  if (!effects?.length) return "";
  return effects
    .map((e) => {
      switch (e.kind) {
        case "flipHeadsBonus":
          return `flip→+${e.bonus}`;
        case "flipTailsFizzle":
          return `flip→miss on tails`;
        case "flipHeadsDouble":
          return `flip→×2`;
        case "perAttachedEnergy":
          return `+${e.perEnergy} per ${e.energyType ?? "energy"}`;
        case "perFriendlyBench":
          return `+${e.perCount} per own bench`;
        case "perOpponentBench":
          return `+${e.perCount} per opp bench`;
        case "perBothBench":
          return `+${e.perCount} per bench (both)`;
        case "perDamageCounterOnSelf":
          return `+${e.perCount} per dmg counter (self)`;
        case "perDamageCounterOnDefender":
          return `+${e.perCount} per dmg counter (def)`;
        case "perEnergyOnDefender":
          return `+${e.perCount} per energy (def)`;
        case "perEnergyOnBothActives":
          return `+${e.perCount} per energy (both)`;
        case "discardBenchEnergyForDamage":
          return `+${e.damagePer} per discarded bench energy`;
        case "discardOwnEnergyForDamage":
          return `+${e.damagePer} per discarded own energy`;
        case "discardStadium":
          return "discard Stadium";
        case "placeCountersOnOppBenchAny":
          return `place ${e.counters} counters on opp bench`;
        case "defenderAttacksWeakerNextTurn":
          return `defender -${e.amount} dmg next turn`;
        case "counterAttackerNextTurn":
          return `counter ${e.counters} on attacker next turn`;
        case "oppDiscardsHand":
          return `opp discards ${e.count} hand`;
        case "perCardInOppHand":
          return `+${e.perCount} per opp hand card`;
        case "attachAnyBasicFromHandAll":
          return "attach all basic energy from hand";
        case "returnSelfToHandDiscardAttached":
          return "return self to hand (discard attached)";
        case "ownEnergyToHand":
          return `bounce ${e.count} own energy`;
        case "gustOppBenchedAttack":
          return "gust opp bench";
        case "discardAnyEnergyAcrossOwnForDamage":
          return `+${e.damagePer} per any-energy discard`;
        case "discardHandEnergyForDamage":
          return `+${e.damagePer} per hand-energy discard`;
        case "perOwnToolAttached":
          return `+${e.perCount} per own tool`;
        case "oppChoosesHandToDeck":
          return `opp ${e.count} hand → deck`;
        case "discardOwnEnergyUpToForDamage":
          return `+${e.damagePer} per discarded own energy (≤${e.max})`;
        case "perPrizeYouTaken":
          return `+${e.perCount} per prize taken`;
        case "perEnergyInOppDiscard":
          return `+${e.perCount} per ${e.energyType ?? ""} in opp discard`;
        case "perStatusOnDefender":
          return `+${e.perCount} per status on def`;
        case "perCardInOwnDiscard":
          return `+${e.perCount} per discard ${e.filter.kind}`;
        case "discardTypedOppEnergy":
          return `discard ${e.count} ${e.energyType} from opp`;
        case "selfRecoverAllStatuses":
          return "cure self all statuses";
        case "selfNoWeaknessNextTurn":
          return "no Weakness next turn";
        case "discardHandForDraw":
          return `discard hand → draw ${e.drawCount}`;
        case "conditionalBaseDamageOverride":
          return `base = ${e.baseDamage} if cond`;
        case "peekTopMayDiscard":
          return "peek top → may discard";
        case "millSelfForDamagePerType":
          return `mill ${e.count} → +${e.damagePer} per ${e.energyType}`;
        case "moveDamageOwnBenchToOpp":
          return "move bench damage → opp";
        case "koAllOppWithLowHp":
          return `KO ≤${e.hpMax} HP opp`;
        case "shuffleOppBenchToDeck":
          return `shuffle ${e.count} opp bench → deck`;
        case "peekTopOptionalBench":
          return `peek top ${e.count} → bench`;
        case "discardOwnEnergyForStatus":
          return `discard ${e.count} ${e.energyType} → ${e.status}`;
        case "revealNamedFromHandForDamage":
          return `+${e.damagePer} per revealed from hand`;
        case "discardSpecialEnergyKoOpp":
          return `discard ${e.energyName} → KO opp`;
        case "revealOppHand":
          return "reveal opp hand";
        case "searchEvolveBench":
          return "evolve bench from deck";
        case "selfNextTurnAttackBonus":
          return `${e.attackName} +${e.bonus} next turn`;
        case "selfCantUseAttackUntilLeavesActive":
          return `lock ${e.attackName} until move`;
        case "koOppIfExactlyDamageCounters":
          return `KO if exactly ${e.counters} counters`;
        case "discardOppToolsN":
          return `discard up to ${e.max} opp Tools`;
        case "perSpecialEnergyOnSelf":
          return `+${e.perCount} per special energy`;
        case "perDamageCounterReduction":
          return `-${e.perCount} per counter`;
        case "attachBasicFromHandToOne":
          return "attach 1 Basic Energy from hand";
        case "bounceOppEnergyToHand":
          return `bounce ${e.count} opp energy → hand`;
        case "delayedDamageOnDefender":
          return `delayed ${e.counters} on defender`;
        case "damageOppDownTo":
          return `damage opp down to ${e.floorHp}`;
        case "selfKoDiscardAll":
          return "self-KO + discard all";
        case "discardTopOfOwnDeck":
          return `mill self ${e.count}`;
        case "revealTopForFilteredDamage":
          return `reveal top ${e.count} → +${e.damagePer} per ${e.subtype}`;
        case "perCountersOnFilteredBench":
          return `+${e.perCount} per bench counter (${e.filter.kind})`;
        case "bounceOneBench":
          return "bounce 1 bench → hand";
        case "millBothForEnergyDamage":
          return `mill both → +${e.damagePer} per energy`;
        case "perPrizeOppTaken":
          return `+${e.perCount} per prize taken`;
        case "benchSnipe":
          return `${e.damage} to bench`;
        case "selfDamage":
          return `self ${e.damage}`;
        case "applyStatus":
          return `→${e.status}`;
        case "heal":
          return `heal ${e.amount}`;
        case "healOneOfYours":
          return `heal ${e.amount} (target)`;
        case "healEqualToDamageDealt":
          return "heal = damage dealt";
        case "healEachOwnSubtype":
          return `heal ${e.amount} each ${e.subtype}`;
        case "discardOwnEnergy":
          return `discard ${e.count} energy`;
        case "drawCards":
          return `draw ${e.count}`;
        case "drawUntilHandSize":
          return `draw to ${e.targetSize}`;
        case "blockOppItemsNextTurn":
          return "locks opp items next turn";
        case "flipMultiCoinsPerHeads":
          return `${e.coins} flips × ${e.perHeads}`;
        case "selfCantAttackNextTurn":
          return "self-lock next turn";
        case "defenderCantRetreatNextTurn":
          return "defender no retreat next turn";
        case "defenderCantAttackNextTurn":
          return "defender no attack next turn";
        case "selfDamageReductionNextTurn":
          return `self -${e.amount} next turn`;
        case "snipeOne":
          return `snipe ${e.damage}`;
        case "damageMultipleTargets":
          return `${e.damage} to ${e.count} targets`;
        case "switchOutOpponent":
          return "force opp promote";
        case "selfSwitch":
          return "switch to bench";
        case "discardOppEnergy":
          return `discard ${e.count} opp energy`;
        case "discardOppSpecialEnergy":
          return `discard ${e.count} opp special energy`;
        case "flipHeadsDiscardOppEnergy":
          return "flip → discard opp energy";
        case "multiCoinFlipDiscardOppEnergy":
          return `${e.coins} flips → discard opp energy/heads`;
        case "multiCoinFlipMillOpp":
          return `${e.coins} flips → mill 1/heads`;
        case "healEachOwnPokemon":
          return `heal ${e.amount} each own`;
        case "discardTopOfOppDeck":
          return `mill opp ${e.count}`;
        case "discardOppTools":
          return "discard opp tools";
        case "callForFamily":
          return `bench up to ${e.max} Basics`;
        case "flipUntilTailsPerHeads":
          return `geom ${e.perHeads}/heads`;
        case "placeCountersPerHandCard":
          return `${e.countersPerCard}× counter per hand card`;
        case "placeCounters":
          return `place ${e.counters} counters on ${e.target}`;
        case "perPokemonFilter":
          return `+${e.perCount} per ${e.side} ${e.filter.kind}`;
        case "fizzleIfNoStadium":
          return "fizzles without Stadium";
        case "shieldNextTurn":
          return e.requiresHeads ? "flip→shield next turn" : "shield next turn";
        case "searchEnergyAttachBenchType":
          return `search Energy → Bench ${e.pokemonType}`;
        case "attachNFromDiscardToBench":
          return `attach ${e.max} ${e.energyType} from discard → bench`;
        case "attachNFromDiscardToSelf":
          return `attach ${e.max} ${e.energyType} from discard → self`;
        case "attachBasicFromDiscardToOneBench":
          return `attach ${e.max} from discard → 1 bench`;
        case "attachBasicFromDiscardToEachBench":
          return `attach ${e.energyType} per bench from discard`;
        case "recoverPokemonFromDiscardToBench":
          return `bench ${e.max} from discard`;
        case "recoverPokemonFromDiscardToHand":
          return `recover ${e.max} Pokémon`;
        case "recoverTrainerFromDiscard":
          return `recover ${e.max} ${e.subtype}`;
        case "selfCantUseAttackNextTurn":
          return `lock ${e.attackName} next turn`;
        case "multiCoinPerOppPokemon":
          return `multi-coin ${e.damagePerHeads}/heads`;
        case "fizzleIfNoAlly":
          return `fizzles without ${e.allyName}`;
        case "ignoreWeaknessResistance":
          return "ignore W/R";
        case "ignoreWeaknessOnly":
          return "ignore W";
        case "ignoreResistanceOnly":
          return "ignore R";
        case "ignoreOppEffects":
          return "ignore opp effects";
        case "returnSelfToHand":
          return "return self to hand";
        case "conditionalDamage":
          return e.mode === "bonus" ? `+${e.bonus} if cond` : `fizzles if !cond`;
        case "conditionalKoDefender":
          return "KO if cond";
        case "conditionalStatus":
          return `→${e.status} if cond`;
        case "searchDeckAttack":
          return `search→${e.destination} ×${e.max}`;
        case "searchEvolveSelf":
          return "evolve from deck";
        case "searchEnergyForEachBench":
          return `attach ${e.energyType} per bench`;
        case "randomOppHandToDeck":
          return `${e.count} random opp hand → deck`;
        case "randomOppHandDiscard":
          return `${e.count} random opp hand → discard`;
        case "multiCoinFlipRandomOppHandDiscard":
          return `${e.coins} flips → random opp discard/heads`;
        case "revealOppHandDiscard":
          return `reveal+discard ×${e.max} (${e.filter})`;
        case "damagePerCardClassInOppHand":
          return `+${e.damagePer} per ${e.filter} in opp hand`;
        case "moveOwnEnergyToBench":
          return `move ${e.count} energy → bench`;
        case "moveOppEnergyToBench":
          return `move ${e.count} opp energy → bench`;
      }
    })
    .join(", ");
}
