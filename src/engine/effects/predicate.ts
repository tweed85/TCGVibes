// Predicate evaluator for AttackPredicate. Pure function — reads
// game state + an attack context, returns boolean. Extracted from
// effects.ts as the first chunk of Stage 6A's mechanical split.
// No calls into other effects.ts internals.

import type {
  Attack,
  AttackPredicate,
  EnergyCard,
  GameState,
  PlayerId,
  PokemonInPlay,
} from "../types";

// Lifted from effects.ts unchanged. AttackContext is the call-time
// snapshot every predicate sees; effects.ts imports it back as the
// AttackContext argument type of resolveAttackEffects.
export interface AttackContext {
  attacker: PokemonInPlay;
  attackerOwner: PlayerId;
  defender: PokemonInPlay | null;
  defenderOwner: PlayerId;
  move: Attack;
  damage: number; // incoming base damage (after weakness/resistance)
}

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
      if (pred.subtype === "Mega") {
        return subs.some((s) => /^Mega/i.test(s));
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
        (c as EnergyCard).provides.includes(pred.energyType),
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
    case "playedNamedItemThisTurn": {
      const list = state.players[ctx.attackerOwner].itemsPlayedThisTurn ?? [];
      const part = pred.namePart.toLowerCase();
      return list.some((n) => n.toLowerCase().includes(part));
    }
    case "youHaveEnergyOfTypeAtLeast": {
      const pl = state.players[ctx.attackerOwner];
      const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
      let count = 0;
      for (const a of allies) {
        for (const e of a.attachedEnergy) {
          if (e.provides.includes(pred.energyType)) count++;
        }
      }
      return count >= pred.count;
    }
    case "selfHealedThisTurn":
      return !!ctx.attacker.healedThisTurn;
    case "selfDamagedLastOppTurn":
      return !!ctx.attacker.damagedLastOppTurn;
    case "selfUsedAttackLastTurn":
      return ctx.attacker.lastAttackUsedNamePriorTurn === pred.attackName;
    case "defenderHasNoStatus":
      return !ctx.defender || !ctx.defender.statuses.includes(pred.status);
    case "oppPrizesInRange": {
      const n = state.players[ctx.defenderOwner].prizes.length;
      return n >= pred.min && n <= pred.max;
    }
    case "yourDiscardHasCardNamed": {
      const part = pred.namePart.toLowerCase();
      return state.players[ctx.attackerOwner].discard.some(
        (c) => c.name.toLowerCase().includes(part),
      );
    }
    case "benchPokemonNamedHasDamage": {
      const part = pred.namePart.toLowerCase();
      return state.players[ctx.attackerOwner].bench.some(
        (p) => p.card.name.toLowerCase().includes(part) && p.damage > 0,
      );
    }
    case "anyBenchHasDamage":
      return state.players[ctx.attackerOwner].bench.some((p) => p.damage > 0);
    case "yourNamedPokemonKoedLastOppTurn": {
      // Card text: "If any of your <named> Pokémon were Knocked Out by
      // damage from an attack during your opponent's last turn..." We
      // track the names of attack-KO'd Pokémon in
      // `yourPokemonKoedByAttackLastOppTurnNames` (populated only inside
      // executeAttackHit's snapshot diff, so status/recoil KOs correctly
      // don't trigger). Match the namePart against the ACTUAL KO'd names
      // — not against an in-play sibling heuristic.
      const pl = state.players[ctx.attackerOwner];
      const part = pred.namePart.toLowerCase();
      return pl.yourPokemonKoedByAttackLastOppTurnNames.some((n) =>
        n.toLowerCase().includes(part),
      );
    }
    case "supporterPlayedThisTurnNameContains": {
      const last = state.players[ctx.attackerOwner].lastSupporterNameThisTurn;
      return !!last && last.toLowerCase().includes(pred.namePart.toLowerCase());
    }
    case "defenderRetreatCostAtLeast":
      return !!def && (def.card.retreatCost ?? []).length >= pred.count;
    case "yourDeckSizeAtMost":
      return state.players[ctx.attackerOwner].deck.length <= pred.count;
    case "oppHandSizeAtMost":
      return state.players[ctx.defenderOwner].hand.length <= pred.count;
    case "youHaveBenchPokemonOfTypeAndSubtype":
      return state.players[ctx.attackerOwner].bench.some(
        (p) =>
          p.card.types.includes(pred.energyType) &&
          (p.card.subtypes ?? []).includes(pred.subtype),
      );
    case "oppHasPokemonOfType": {
      const opp = state.players[ctx.defenderOwner];
      const allies = [opp.active, ...opp.bench].filter((p): p is PokemonInPlay => !!p);
      return allies.some((p) => p.card.types.includes(pred.energyType));
    }
    case "oppHasPokemonOfSubtype": {
      const opp = state.players[ctx.defenderOwner];
      const allies = [opp.active, ...opp.bench].filter((p): p is PokemonInPlay => !!p);
      return allies.some((p) => (p.card.subtypes ?? []).includes(pred.subtype));
    }
    case "youHaveBenchPokemonOfSubtype":
      return state.players[ctx.attackerOwner].bench.some(
        (p) => (p.card.subtypes ?? []).includes(pred.subtype),
      );
    case "selfHasMoreEnergyThanDefender":
      return !!def && atk.attachedEnergy.length > def.attachedEnergy.length;
    case "typeMatchesAnyOppPokemon": {
      const own = [
        state.players[ctx.attackerOwner].active,
        ...state.players[ctx.attackerOwner].bench,
      ].filter((p): p is PokemonInPlay => !!p);
      const opp = [
        state.players[ctx.defenderOwner].active,
        ...state.players[ctx.defenderOwner].bench,
      ].filter((p): p is PokemonInPlay => !!p);
      const ownTypes = new Set(own.flatMap((p) => p.card.types));
      return opp.some((p) => p.card.types.some((t) => ownTypes.has(t)));
    }
    case "hasBothNamedOnBench": {
      const bench = state.players[ctx.attackerOwner].bench;
      const a = pred.nameA.toLowerCase();
      const b = pred.nameB.toLowerCase();
      const hasA = bench.some((p) => p.card.name.toLowerCase().includes(a));
      const hasB = bench.some((p) => p.card.name.toLowerCase().includes(b));
      return hasA && hasB;
    }
    case "oppBenchAtLeast":
      return state.players[ctx.defenderOwner].bench.length >= pred.count;
    case "anyAllyOfSubtypeUsedAttackLastTurn": {
      const pl = state.players[ctx.attackerOwner];
      const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
      return allies.some(
        (p) =>
          p !== ctx.attacker &&
          (p.card.subtypes ?? []).includes(pred.subtype) &&
          p.lastAttackUsedNamePriorTurn !== undefined,
      );
    }
  }
}
