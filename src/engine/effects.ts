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
import { benchDamageBlocked } from "./ongoingEffects";
import type {
  Attack,
  AttackEffect,
  GameState,
  PlayerId,
  PokemonInPlay,
} from "./types";

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
}

export function resolveAttackEffects(
  state: GameState,
  ctx: AttackContext,
): ResolvedAttack {
  const effects = ctx.move.effects ?? [];
  let damage = ctx.damage;
  const postHooks: (() => void)[] = [];

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
          const targets: PokemonInPlay[] = [];
          if (e.target === "opponentBench" || e.target === "allBench" || e.target === "allOpponents") {
            targets.push(...state.players[ctx.defenderOwner].bench);
          }
          if (e.target === "allBench") {
            targets.push(...state.players[ctx.attackerOwner].bench);
          }
          for (const t of targets) {
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
          const target =
            e.target === "self" ? ctx.attacker : ctx.defender;
          if (!target) return;
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
      case "discardOwnEnergy": {
        postHooks.push(() => {
          const attPl = state.players[ctx.attackerOwner];
          for (let i = 0; i < e.count; i++) {
            const en = ctx.attacker.attachedEnergy.shift();
            if (!en) break;
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
        case "discardOwnEnergy":
          return `discard ${e.count} energy`;
        case "drawCards":
          return `draw ${e.count}`;
      }
    })
    .join(", ");
}
