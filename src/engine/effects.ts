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
  GameState,
  PlayerId,
  PokemonInPlay,
} from "./types";

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
          const targets: Array<[PlayerId, PokemonInPlay]> = [];
          if (e.target === "opponentBench" || e.target === "allBench" || e.target === "allOpponents") {
            for (const p of state.players[ctx.defenderOwner].bench) targets.push([ctx.defenderOwner, p]);
          }
          if (e.target === "allBench") {
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

      case "selfDamageReductionNextTurn": {
        postHooks.push(() => {
          state.players[ctx.attackerOwner].nextOpponentTurnDamageReductions.push({
            amount: e.amount,
          });
          logEvent(state, "system", `${ctx.attacker.card.name} will take ${e.amount} less damage next turn.`);
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
        // across benched allies.
        postHooks.push(() => {
          const pl = state.players[ctx.attackerOwner];
          if (pl.bench.length === 0) return;
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
          if (attached > 0) {
            logEvent(
              state,
              ctx.attackerOwner,
              `${ctx.move.name}: attaches ${attached} ${e.energyType} Energy from discard to Bench.`,
            );
          }
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
        // Weakness/Resistance multipliers already ran in executeAttackHit
        // before resolveAttackEffects. Reverse-engineering to strip them out
        // isn't practical, so we approximate by adding a damage correction
        // post-hook based on what the applied weakness/resistance was.
        if (ctx.defender) {
          const atkType = ctx.attacker.card.types[0];
          const weak = ctx.defender.card.weaknesses?.find((w) => w.type === atkType);
          const res = ctx.defender.card.resistances?.find((w) => w.type === atkType);
          // Reverse the weakness multiplier: damage was multiplied by N; divide.
          if (weak?.value.startsWith("×")) {
            const mult = parseInt(weak.value.slice(1), 10) || 2;
            damage = Math.floor(damage / mult);
          }
          // Reverse the resistance subtraction: add back what was subtracted.
          if (res?.value.startsWith("-")) {
            damage += parseInt(res.value.slice(1), 10) || 30;
          }
        }
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
        case "blockOppItemsNextTurn":
          return "locks opp items next turn";
        case "flipMultiCoinsPerHeads":
          return `${e.coins} flips × ${e.perHeads}`;
        case "selfCantAttackNextTurn":
          return "self-lock next turn";
        case "defenderCantRetreatNextTurn":
          return "defender no retreat next turn";
        case "selfDamageReductionNextTurn":
          return `self -${e.amount} next turn`;
        case "snipeOne":
          return `snipe ${e.damage}`;
        case "switchOutOpponent":
          return "force opp promote";
        case "selfSwitch":
          return "switch to bench";
        case "discardOppEnergy":
          return `discard ${e.count} opp energy`;
        case "flipHeadsDiscardOppEnergy":
          return "flip → discard opp energy";
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
        case "fizzleIfNoStadium":
          return "fizzles without Stadium";
        case "shieldNextTurn":
          return e.requiresHeads ? "flip→shield next turn" : "shield next turn";
        case "searchEnergyAttachBenchType":
          return `search Energy → Bench ${e.pokemonType}`;
        case "attachNFromDiscardToBench":
          return `attach ${e.max} ${e.energyType} from discard → bench`;
        case "selfCantUseAttackNextTurn":
          return `lock ${e.attackName} next turn`;
        case "multiCoinPerOppPokemon":
          return `multi-coin ${e.damagePerHeads}/heads`;
        case "fizzleIfNoAlly":
          return `fizzles without ${e.allyName}`;
        case "ignoreWeaknessResistance":
          return "ignore W/R";
        case "returnSelfToHand":
          return "return self to hand";
      }
    })
    .join(", ");
}
