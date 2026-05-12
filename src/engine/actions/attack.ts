// Attack pipeline: preflight → confusion flip → executeAttackHit
// (damage/effects) → finishHit (promote queue / Festival Lead second hit
// / endTurn). Resume entry points: resumeDamageScalingAttack (after the
// pre-attack discard picker) and resumeSecondAttack (after a promote
// while a Festival Lead second hit is queued).
//
// Extracted from actions.ts as part of Stage 5B internal-module split.
// `ActionResult`, `ok`, `fail` live in ./_result.ts (shared with
// actions.ts) to avoid a circular value import.

import {
  applyDamage,
  canPayCost,
  endTurn as endTurnRule,
  flipCoin,
  hasStatus,
  knockOut,
  logEvent,
  makePokemonInPlay,
  opponentOf,
  resolveBenchKOs,
} from "../rules";
import { resolveAttackEffects } from "../effects";
import { getAttackEffects } from "../../data/effectPatterns";
import {
  applySurvivalBrace,
  applyAbilityKoSurvival,
  effectiveAttackCost,
  effectiveAttacks,
  effectiveMaxHp,
  effectiveTypes,
  effectiveWeaknesses,
  energyPoolForCost,
  passiveAttackBonus,
  passiveDamageReduction,
  stadiumAttackBonus,
  stadiumDamageReduction,
  toolOnDamageActions,
  triggeredBerryTools,
  turnAttackBonus,
  turnDamageReduction,
} from "../ongoingEffects";
import { fail, ok, type ActionResult } from "./_result";
import type {
  GameState,
  PlayerId,
  PokemonCard,
  PokemonInPlay,
} from "../types";

function hasFestivalLeadTwin(state: GameState, attacker: PokemonInPlay): boolean {
  if (state.stadium?.card.name !== "Festival Grounds") return false;
  return (attacker.card.abilities ?? []).some((a) => a.name === "Festival Lead");
}

// Run the damage / effects portion of an attack (one hit). Does not handle
// status checks, cost payment, or turn-ending — callers handle those.
function executeAttackHit(
  state: GameState,
  player: PlayerId,
  attackIndex: number,
): void {
  const pl = state.players[player];
  const atk = pl.active;
  if (!atk) return;
  const move = effectiveAttacks(atk)[attackIndex];
  if (!move) return;
  const defOwner = opponentOf(player);
  const def = state.players[defOwner].active;
  // Dunsparce "Dig" (and similar) — if the defender is shielded during this
  // turn, the attack does nothing at all: no damage, no non-damage effects.
  if (def?.shieldedUntilTurn !== undefined && state.turn <= def.shieldedUntilTurn) {
    logEvent(state, "system", `${def.card.name} is shielded — ${move.name} has no effect.`);
    return;
  }
  // Subtype-gated shield (Golbat "Covert Flight" — only blocks Basic
  // attackers).
  if (def) {
    const sub = (def as typeof def & {
      shieldNextTurnFromSubtype?: { turn: number; subtype: string };
    }).shieldNextTurnFromSubtype;
    if (sub && state.turn <= sub.turn && atk.card.subtypes.includes(sub.subtype)) {
      logEvent(
        state,
        "system",
        `${def.card.name} is shielded vs ${sub.subtype} — ${move.name} has no effect.`,
      );
      return;
    }
  }
  // Ability-gated shield (Deoxys "Psy Protect" — only blocks attackers
  // that have any Abilities).
  if (def) {
    const abilityShield = (def as typeof def & {
      shieldNextTurnFromAbility?: number;
    }).shieldNextTurnFromAbility;
    if (
      abilityShield !== undefined &&
      state.turn <= abilityShield &&
      (atk.card.abilities ?? []).length > 0
    ) {
      logEvent(
        state,
        "system",
        `${def.card.name} is shielded vs ability attackers — ${move.name} has no effect.`,
      );
      return;
    }
  }
  // Snapshot the defender's in-play Pokémon names BEFORE this attack so we
  // can record which ones get KO'd "by damage from an attack". Used by
  // predicates like Hop's Trevenant Horrifying Revenge that check
  // `yourPokemonKoedByAttackLastOppTurnNames`. Status/recoil/effect KOs
  // happen outside this snapshot window, so they correctly don't get
  // counted as attack-KOs.
  const defInPlayBefore: Array<{ instanceId: string; name: string }> = [];
  {
    const dp = state.players[defOwner];
    if (dp.active) defInPlayBefore.push({ instanceId: dp.active.instanceId, name: dp.active.card.name });
    for (const b of dp.bench) defInPlayBefore.push({ instanceId: b.instanceId, name: b.card.name });
  }
  // Damage pipeline — order matters per TCG rules:
  //   1. Base damage from the attack
  //   2. Attacker-side additions (Stadium / Tool / ability passives, turn
  //      bonuses like Black Belt's Training)
  //   3. Attack-effect additions (per-bench, per-energy, per-damage-counter,
  //      coin-flip bonuses) — resolved inside resolveAttackEffects
  //   4. Weakness (×) — applied to the full summed damage
  //   5. Resistance (−) — subtracted from the weakness-adjusted damage
  //   6. Defender-side reductions (Stadium, Tool Berries, Jasmine's Gaze,
  //      Iron Defender)
  //
  // Doing W/R after step 3 is critical: e.g., Dipplin "Do the Wave" adds
  // +20 per bench inside resolveAttackEffects, and that full total must be
  // doubled against a Grass-weak Lunatone, not just the base.
  // Resolve effects up front so any baseDamageOverride (e.g. "20×" zeros the
  // base for per-energy / per-bench scaling) lands before we read move.damage.
  getAttackEffects(move);
  let damage = move.damage;
  damage += stadiumAttackBonus(state, atk, def);
  damage += passiveAttackBonus(state, player, atk, def);
  damage += turnAttackBonus(state, player, atk, def);
  // "During your next turn, this Pokémon's <Name> attack does +N damage."
  // Set by selfNextTurnAttackBonus the previous turn.
  {
    const bag = atk as typeof atk & {
      nextTurnAttackBonuses?: Record<string, { amount: number; turn: number }>;
    };
    const slot = bag.nextTurnAttackBonuses?.[move.name];
    if (slot && state.turn <= slot.turn) {
      damage += slot.amount;
    }
  }
  // "During your next turn, attacks used by this Pokémon do +N damage to
  // your opponent's Active Pokémon." (Kilowattrel Wind Power Charge,
  // Donphan No Reprieve.) Set by selfNextTurnAllAttacksBonus the previous
  // turn — applies broadly to ALL attacks during this turn.
  {
    const bag = atk as typeof atk & {
      allAttackBonusUntilTurn?: { turn: number; bonus: number };
    };
    if (bag.allAttackBonusUntilTurn && state.turn <= bag.allAttackBonusUntilTurn.turn) {
      damage += bag.allAttackBonusUntilTurn.bonus;
    }
  }
  const result = resolveAttackEffects(state, {
    attacker: atk,
    attackerOwner: player,
    defender: def,
    defenderOwner: defOwner,
    move,
    damage,
  });
  damage = result.damage;
  if (def && damage > 0) {
    const atkTypes = effectiveTypes(atk.card, atk);
    // effectiveWeaknesses honors Fairy Zone (opp Dragons get Psychic weakness).
    const weak = effectiveWeaknesses(def, state).find((w) => atkTypes.includes(w.type));
    const res = def.card.resistances?.find((w) => atkTypes.includes(w.type));
    const defenderIgnoresWeakness =
      def.noWeaknessUntilTurn !== undefined && state.turn <= def.noWeaknessUntilTurn;
    if (!result.ignoreWeakness && !defenderIgnoresWeakness && weak && weak.value.startsWith("×")) {
      const mult = parseInt(weak.value.slice(1), 10) || 2;
      damage *= mult;
      logEvent(
        state,
        "system",
        `Weakness: ${def.card.name} takes ×${mult} from ${weak.type} attacks.`,
      );
    }
    if (!result.ignoreResistance && res && res.value.startsWith("-")) {
      const red = parseInt(res.value.slice(1), 10) || 30;
      damage = Math.max(0, damage - red);
      logEvent(
        state,
        "system",
        `Resistance: ${def.card.name} reduces ${res.type} damage by ${red}.`,
      );
    }
    if (!result.ignoreOppEffects) {
      const reduction = stadiumDamageReduction(state, atk, def);
      const turnRed = turnDamageReduction(state, defOwner, def);
      const passiveRed = passiveDamageReduction(state, defOwner, def, atk);
      const total = reduction + turnRed + passiveRed;
      if (total > 0) damage = Math.max(0, damage - total);
    }
  }
  // Survival Brace: cap damage so full-HP defender survives with 10 HP; it
  // discards after triggering. Skipped when the attack carries
  // `ignoreOppEffects` (Dudunsparce ex Destructive Drill / Crustle Superb
  // Scissors / etc.) — those bypass effects on opp Pokémon entirely.
  let survivalBraceTriggered = false;
  if (def && damage > 0 && !result.ignoreOppEffects) {
    const before = damage;
    damage = applySurvivalBrace(state, def, damage);
    if (damage !== before) survivalBraceTriggered = true;
  }
  // Sturdy / Focus Sash equivalents (passive abilities): cap damage so the
  // defender survives at 10 HP. Predicates handle "only at full HP" or coin
  // flip variants. Same `ignoreOppEffects` bypass.
  if (def && damage > 0 && !result.ignoreOppEffects) {
    damage = applyAbilityKoSurvival(state, def, damage);
  }
  logEvent(state, player, `attacks with ${move.name} for ${damage}.`);
  if (damage > 0) applyDamage(state, defOwner, damage);
  // Spiky Energy — "If the Pokémon this card is attached to is in the Active
  // Spot and is damaged by an attack, put 2 damage counters on the Attacking
  // Pokémon." Fires once per Spiky Energy attached, even on KO.
  if (def && damage > 0) {
    const spikyCount = def.attachedEnergy.filter((e) => e.name === "Spiky Energy").length;
    if (spikyCount > 0) {
      const counter = spikyCount * 20;
      atk.damage += counter;
      logEvent(state, "system", `${atk.card.name} takes ${counter} damage from Spiky Energy.`);
    }
  }
  // Active-only on-damage abilities: Poison Point / Incandescent Body
  // (status), Counterattacking Crest (counter damage), Spiteful Swirl
  // (1 counter on attacker, gated on Active being a Darkness Pokémon).
  if (def && damage > 0 && state.players[defOwner].active === def) {
    for (const a of (def.card.abilities ?? [])) {
      if (a.name === "Poison Point") {
        if (!atk.statuses.includes("poisoned")) atk.statuses.push("poisoned");
        logEvent(state, "system", `Poison Point: ${atk.card.name} is now Poisoned.`);
      } else if (a.name === "Incandescent Body") {
        if (!atk.statuses.includes("burned")) atk.statuses.push("burned");
        logEvent(state, "system", `Incandescent Body: ${atk.card.name} is now Burned.`);
      } else if (a.name === "Counterattacking Crest") {
        atk.damage += 50;
        logEvent(state, "system", `Counterattacking Crest: ${atk.card.name} takes 50 counter damage.`);
      } else if (a.name === "Spiteful Swirl") {
        if (def.card.types.includes("Darkness")) {
          atk.damage += 10;
          logEvent(state, "system", `Spiteful Swirl: ${atk.card.name} takes 10 counter damage.`);
        }
      } else if (a.name === "Pummeling Payback") {
        // Orthworm ex — 2 counters per Metal Energy attached.
        const metal = def.attachedEnergy.filter((e) => e.provides.includes("Metal")).length;
        if (metal > 0) {
          atk.damage += metal * 20;
          logEvent(state, "system", `Pummeling Payback: ${atk.card.name} takes ${metal * 20} damage.`);
        }
      } else if (a.name === "Counterattack" || a.name === "Counterattack Quills" || a.name === "Automated Combat") {
        atk.damage += 30;
        logEvent(state, "system", `${a.name}: ${atk.card.name} takes 30 counter damage.`);
      } else if (a.name === "Needle Armor") {
        // me4 Chesnaught — place 3 damage counters on the Attacking Pokémon
        // for each Grass Energy attached to this Pokémon.
        const grass = def.attachedEnergy.filter((e) => e.provides.includes("Grass")).length;
        if (grass > 0) {
          atk.damage += grass * 30;
          logEvent(state, "system", `Needle Armor: ${atk.card.name} takes ${grass * 30} counter damage.`);
        }
      } else if (a.name === "Exploding Needles") {
        // Only fires when this Active is KO'd by the incoming damage.
        if (def.damage >= effectiveMaxHp(def, state)) {
          atk.damage += 60;
          logEvent(state, "system", `Exploding Needles: ${atk.card.name} takes 60 counter damage.`);
        }
      } else if (a.name === "Shell Spikes") {
        // Discard 1 energy from the attacker (random; AI doesn't pick).
        if (atk.attachedEnergy.length > 0) {
          const removed = atk.attachedEnergy.shift()!;
          state.players[player].discard.push(removed);
          logEvent(state, "system", `Shell Spikes: ${atk.card.name} loses ${removed.name}.`);
        }
      } else if (a.name === "Smog Signals") {
        // When in Active and damaged, search deck for up to 2 Koffing-named
        // Pokémon and put them on the bench. Auto-applies for AI; for the
        // human, the deck-search infrastructure could open a picker but we
        // keep it auto for the on-damaged path.
        const defPl = state.players[defOwner];
        if (defPl.bench.length < 5) {
          let placed = 0;
          for (let i = 0; i < defPl.deck.length && placed < 2 && defPl.bench.length < 5; ) {
            const c = defPl.deck[i];
            if (c.supertype === "Pokémon" && c.name.includes("Koffing")) {
              defPl.deck.splice(i, 1);
              defPl.bench.push(makePokemonInPlay(c as PokemonCard));
              placed++;
            } else i++;
          }
          if (placed > 0) {
            logEvent(state, defOwner, `Smog Signals: benches ${placed} Koffing-line Pokémon.`);
            // Shuffle remaining deck.
            const arr = defPl.deck;
            for (let i = arr.length - 1; i > 0; i--) {
              const j = state.rng.int(i + 1);
              [arr[i], arr[j]] = [arr[j], arr[i]];
            }
          }
        }
      }
    }
  }
  // Bench-side on-damaged: Spiteful Swirl on Active fires already; some
  // abilities ("Exploding Needles") fire ONLY on KO — handled in postDamage
  // path below where KO is detected.
  // Tool "on damage" triggers (Lucky Helmet draw, Punk Helmet counter,
  // Team Rocket's Hypnotizer asleep, Deluxe Bomb counter). Deluxe Bomb
  // self-discards after triggering.
  if (def && damage > 0) {
    const toDiscardAfter: string[] = [];
    for (const act of toolOnDamageActions(state, def, true)) {
      if (act.kind === "drawCards") {
        const d = state.players[defOwner];
        let drawn = 0;
        for (let i = 0; i < act.count; i++) {
          const c = d.deck.shift();
          if (!c) break;
          d.hand.push(c);
          drawn++;
        }
        if (drawn > 0) logEvent(state, defOwner, `draws ${drawn} card(s) from Lucky Helmet.`);
      } else if (act.kind === "counterDamage") {
        atk.damage += act.damage;
        logEvent(state, "system", `${atk.card.name} takes ${act.damage} counter damage.`);
        // Deluxe Bomb is a single-shot item-tool that discards after trigger.
        if (def.tools.some((t) => t.name === "Deluxe Bomb")) toDiscardAfter.push("Deluxe Bomb");
      } else if (act.kind === "applyStatusToAttacker") {
        if (!atk.statuses.includes(act.status)) atk.statuses.push(act.status);
        logEvent(state, "system", `${atk.card.name} is now ${act.status}.`);
      } else if (act.kind === "moveEnergyAttackerToAttackerBench") {
        // Handheld Fan: move 1 Energy from the attacker to one of the
        // attacker's Bench Pokémon. Even if our holder is KO'd by the
        // hit, this still fires (per card text "even if this Pokémon is
        // Knocked Out").
        const attackerSide = state.players[player];
        const defenderSide = state.players[defOwner];
        if (atk.attachedEnergy.length === 0 || attackerSide.bench.length === 0) {
          // No legal move — skip silently.
        } else if (defenderSide.isAI || attackerSide.bench.length === 1) {
          // AI defender or single bench target: auto-pick the first Energy
          // and the first bench Pokémon.
          const en = atk.attachedEnergy.shift()!;
          attackerSide.bench[0].attachedEnergy.push(en);
          logEvent(
            state,
            "system",
            `Handheld Fan: ${en.name} moves from ${atk.card.name} to ${attackerSide.bench[0].card.name}.`,
          );
        } else {
          // Human defender + 2+ bench: defer the move to a defender-side
          // picker. finishHit() opens the prompt and gates endTurn on it.
          state.pendingHandheldFan = { defenderId: defOwner, attackerSideId: player };
        }
      }
    }
    for (const name of toDiscardAfter) {
      const i = def.tools.findIndex((t) => t.name === name);
      if (i >= 0) {
        const [tool] = def.tools.splice(i, 1);
        state.players[defOwner].discard.push(tool);
        logEvent(state, defOwner, `discards ${tool.name} (triggered).`);
      }
    }
  }
  // Discard any Berry Tools on the defender that just triggered.
  if (def && damage > 0) {
    const triggered = triggeredBerryTools(state, atk, def);
    if (triggered.length > 0) {
      for (const name of triggered) {
        const i = def.tools.findIndex((t) => t.name === name);
        if (i >= 0) {
          const [tool] = def.tools.splice(i, 1);
          state.players[defOwner].discard.push(tool);
          logEvent(state, defOwner, `discards ${tool.name} (berry triggered).`);
        }
      }
    }
  }
  // Survival Brace: one-shot tool, discards after trigger.
  if (def && survivalBraceTriggered) {
    const i = def.tools.findIndex((t) => t.name === "Survival Brace");
    if (i >= 0) {
      const [tool] = def.tools.splice(i, 1);
      state.players[defOwner].discard.push(tool);
      logEvent(state, defOwner, `discards ${tool.name} (Survival Brace triggered).`);
    }
  }
  if ((state.phase as string) !== "gameOver") {
    result.postDamage?.();
  }
  // Some post-hooks add damage directly to the defender's Active (e.g.,
  // Alakazam "Powerful Hand" stacking counters per hand card, or Black
  // Kyurem's conditional KO). The applyDamage() path only runs the active-KO
  // check when damage came in via the regular `damage > 0` branch, so we
  // need an explicit check here too.
  if ((state.phase as string) !== "gameOver" && def) {
    const defPl = state.players[defOwner];
    if (defPl.active === def && def.damage >= effectiveMaxHp(def, state)) {
      knockOut(state, defOwner);
    }
  }
  if ((state.phase as string) !== "gameOver") {
    resolveBenchKOs(state);
  }
  if ((state.phase as string) !== "gameOver" && pl.active && pl.active.damage >= effectiveMaxHp(pl.active, state)) {
    knockOut(state, player);
  }
  // Diff defender's in-play before/after to record which of THEIR Pokémon
  // got KO'd specifically by this attack (i.e. damage from this attack
  // resolved into a KO somewhere in the chain above). Names go onto the
  // defender's `yourPokemonKoedByAttackLastOppTurnNames`. Predicates like
  // Hop's Trevenant Horrifying Revenge consume this list on the defender's
  // NEXT turn (they're now the attacker; the field still holds the names
  // from the prior opp turn until end-of-turn cleanup clears it).
  {
    const dp = state.players[defOwner];
    const stillInPlay = new Set<string>();
    if (dp.active) stillInPlay.add(dp.active.instanceId);
    for (const b of dp.bench) stillInPlay.add(b.instanceId);
    for (const before of defInPlayBefore) {
      if (!stillInPlay.has(before.instanceId)) {
        dp.yourPokemonKoedByAttackLastOppTurnNames.push(before.name);
      }
    }
  }
}

// Shared post-hit branching — used by both the first hit (in attack) and the
// second hit (resumed by promoteBenchToActive after a KO). Returns true if
// the attack sequence is fully resolved (endTurn already called), false if
// we're paused on a pendingPromote or gameOver.
function finishHit(
  state: GameState,
  player: PlayerId,
  attackIndex: number,
  wasSecond: boolean,
): void {
  // Did the first hit trigger a second-hit eligibility?
  if (!wasSecond) {
    const atk = state.players[player].active;
    if (atk && hasFestivalLeadTwin(state, atk)) {
      state.pendingSecondAttack = { player, attackIndex };
      logEvent(state, "system", "Festival Lead: attack continues for a second hit.");
      if (state.pendingPromote) {
        // Defender KO'd → wait for promote, then run the second hit.
        state.onPromoteResolved = "secondAttack";
        return;
      }
      // No promote pause → run the second hit inline.
      state.pendingSecondAttack = null;
      executeAttackHit(state, player, attackIndex);
      finishHit(state, player, attackIndex, true);
      return;
    }
  }
  // End of sequence.
  if (state.pendingPromote) {
    state.onPromoteResolved = "endTurn";
    return;
  }
  if (
    state.pendingInPlayTarget &&
    (state.pendingInPlayTarget.action.kind === "distributeDamage" ||
      state.pendingInPlayTarget.action.kind === "attachEnergyFromDiscardPicker") &&
    state.pendingInPlayTarget.action.finishTurn
  ) {
    return;
  }
  // Handheld Fan: human defender hasn't picked the bench target yet. Open
  // the picker now and gate endTurn on it (resolveInPlayTarget's
  // "handheldFanPick" case fires endTurn after the move applies).
  if (state.pendingHandheldFan) {
    const fan = state.pendingHandheldFan;
    state.pendingInPlayTarget = {
      player: fan.defenderId,
      label: "Handheld Fan: pick a Benched Pokémon (opponent's side) to receive 1 Energy",
      scope: "opp",
      slot: "bench",
      filter: "anyPokemon",
      action: { kind: "handheldFanPick" },
    };
    return;
  }
  const phaseAfter: string = state.phase;
  if (phaseAfter !== "gameOver") endTurnRule(state);
}

/**
 * Read-only legality check — returns `ok` if `attack(state, player, idx)`
 * would commit, else the same `fail` reason the engine would emit. Mutates
 * nothing. Drives the UI's pre-click attack-button disable + tooltip so
 * the player sees WHY an attack isn't legal before they click, instead
 * of getting a post-click rejection toast. `attack()` itself routes
 * through this so the UI and engine can never disagree about legality.
 *
 * Gates checked, in order: gameOver, ownership of turn, main phase,
 * Active exists, first-turn-attack ban (Debut Performance bypass),
 * asleep/paralyzed status, `cantAttackUntilTurn`, Power Saver active
 * condition, attack index in range, per-attack lock, Born to Slack
 * (requires opp ex/V in play), Energy cost via `canPayCost` against
 * the effective pool.
 */
export function attackPreflight(
  state: GameState,
  player: PlayerId,
  attackIndex: number,
): ActionResult {
  if (state.phase === "gameOver") return fail("Game is over.");
  if (state.activePlayer !== player) return fail("Not your turn.");
  if (state.phase !== "main") return fail("Not in main phase.");
  const pl = state.players[player];
  const atk = pl.active;
  if (!atk) return fail("No Active Pokémon.");
  if (state.firstTurnNoAttack) {
    // Debut Performance (Meloetta ex) — bypasses the first-turn attack ban.
    const allowsFirstTurn = (atk.card.abilities ?? []).some((a) => a.name === "Debut Performance");
    if (!allowsFirstTurn) return fail("No attacking on the first turn.");
  }
  if (hasStatus(atk, "asleep")) return fail("Asleep Pokémon can't attack.");
  if (hasStatus(atk, "paralyzed")) return fail("Paralyzed Pokémon can't attack.");
  if (atk.cantAttackUntilTurn !== undefined && state.turn <= atk.cantAttackUntilTurn) {
    return fail("This Pokémon can't attack this turn.");
  }
  for (const ab of atk.card.abilities ?? []) {
    if (ab.name === "Power Saver") {
      const allies = [pl.active, ...pl.bench].filter((p): p is typeof pl.active & {} => !!p);
      const trCount = allies.filter((p) => p.card.name.startsWith("Team Rocket's ")).length;
      if (trCount < 4) {
        return fail("Power Saver: requires 4 or more Team Rocket's Pokémon in play.");
      }
    }
  }
  const move = effectiveAttacks(atk)[attackIndex];
  if (!move) return fail("No such attack.");
  const perAttackLock = (atk as typeof atk & { cantUseAttacksUntilTurn?: Record<string, number> }).cantUseAttacksUntilTurn;
  if (perAttackLock && perAttackLock[move.name] !== undefined && state.turn <= perAttackLock[move.name]) {
    return fail(`This Pokémon can't use ${move.name} this turn.`);
  }
  if ((atk.card.abilities ?? []).some((a) => a.name === "Born to Slack")) {
    const oppId: PlayerId = player === "p1" ? "p2" : "p1";
    const oppAllies = [state.players[oppId].active, ...state.players[oppId].bench]
      .filter((p): p is PokemonInPlay => !!p);
    const hasExOrV = oppAllies.some((p) =>
      (p.card.subtypes ?? []).some((s) => /^(?:ex|EX|V|VMAX|VSTAR|V-UNION)$/.test(s)),
    );
    if (!hasExOrV) {
      return fail("Born to Slack: opponent has no Pokémon ex or V in play.");
    }
  }
  const provided = energyPoolForCost(atk, state);
  const effectiveCost = effectiveAttackCost(state, atk, move.cost, move.name);
  if (!canPayCost(provided, effectiveCost))
    return fail("Not enough Energy for that attack.");
  return ok;
}

/**
 * Execute an attack. Phase-gated by `attackPreflight` (T1 ban, status
 * locks, per-attack lock, Power Saver, Born to Slack, Energy cost). Pipeline:
 *   1. Confusion flip — heads continues, tails self-damages + skips effect
 *   2. `executeAttackHit` — pre-attack picker (discard-for-damage), pay
 *      cost, apply damage + effects, route through `applyDamage` so
 *      opponent-attack-only KO triggers fire
 *   3. `finishHit` — promote queue + Festival Lead second hit + endTurn,
 *      deferred when a player-facing picker is still open
 * `resumeDamageScalingAttack` / `resumeSecondAttack` re-enter mid-pipeline
 * after pickers / promotes resolve.
 */
export function attack(
  state: GameState,
  player: PlayerId,
  attackIndex: number,
): ActionResult {
  const pre = attackPreflight(state, player, attackIndex);
  if (!pre.ok) return pre;
  const atk = state.players[player].active!;

  // Confusion: flip on attack; on tails, attack fails and 30 damage to self.
  if (hasStatus(atk, "confused")) {
    const heads = flipCoin(state, `${atk.card.name} confusion flip`);
    if (!heads) {
      atk.damage += 30;
      logEvent(state, "system", `${atk.card.name} hurts itself in confusion (30 damage).`);
      if (atk.damage >= effectiveMaxHp(atk, state)) knockOut(state, player);
      if (state.pendingPromote) {
        state.onPromoteResolved = "endTurn";
        return ok;
      }
      const phase2: string = state.phase;
      if (phase2 !== "gameOver") endTurnRule(state);
      return ok;
    }
  }

  // Phase 7 — pre-attack discard-for-damage picker. For Inferno X /
  // Bellowing Thunder / Spill the Tea (and any future damage-scaling
  // discard attack), open a picker BEFORE running the attack so the
  // player can choose which energies to discard. The picker resolves
  // via `resumeDamageScalingAttack` which re-enters the attack flow
  // with `state.preComputedDiscardForDamage` set.
  if (state.preComputedDiscardForDamage === null && !state.players[player].isAI) {
    const move = effectiveAttacks(atk)[attackIndex];
    if (move) {
      const effects = getAttackEffects(move);
      const damageScalingDiscard = effects.find(
        (e) =>
          e.kind === "discardAnyEnergyAcrossOwnForDamage" ||
          e.kind === "discardEnergyAnywhereForDamage",
      );
      if (damageScalingDiscard) {
        const energyType =
          (damageScalingDiscard as { energyType?: import("../types").EnergyType }).energyType ?? null;
        const max =
          damageScalingDiscard.kind === "discardEnergyAnywhereForDamage"
            ? (damageScalingDiscard as { max: number }).max
            : Number.POSITIVE_INFINITY;
        const allies = [state.players[player].active, ...state.players[player].bench].filter(
          (p): p is PokemonInPlay => !!p,
        );
        const hasEligible = allies.some((p) =>
          p.attachedEnergy.some((en) =>
            energyType == null
              ? en.subtypes.includes("Basic")
              : en.provides.includes(energyType),
          ),
        );
        if (hasEligible) {
          state.pendingInPlayTarget = {
            player,
            label: `${move.name}: discard a${energyType ? ` ${energyType}` : "ny Basic"} Energy from one of your Pokémon (Cancel to apply damage)`,
            scope: "own",
            slot: "anywhere",
            filter: "hasAnyEnergy",
            action: {
              kind: "attackDiscardForDamagePicker",
              discarded: 0,
              max: Number.isFinite(max) ? max : 99,
              energyType,
              attackerOwner: player,
              attackIndex,
              attackName: move.name,
            },
          };
          return ok;
        }
      }
    }
  }

  executeAttackHit(state, player, attackIndex);
  finishHit(state, player, attackIndex, false);
  // Per-attack overrides (snipe target, etc.) are single-use — consumed.
  state.snipeTargetOverride = null;
  // Clear the pre-attack discard count after the attack completes.
  state.preComputedDiscardForDamage = null;
  return ok;
}

/**
 * Mid-pipeline re-entry: called when the pre-attack discard-for-damage
 * picker resolves (Inferno X / Bellowing Thunder / Spill the Tea). Records
 * the chosen discard count in `state.preComputedDiscardForDamage`, then
 * runs `executeAttackHit` + `finishHit` — preflight + confusion flip are
 * skipped because the first pass already cleared them. Single-use
 * overrides (snipe target, discard count) clear after the call.
 */
export function resumeDamageScalingAttack(
  state: GameState,
  player: PlayerId,
  attackIndex: number,
  discarded: number,
): void {
  state.preComputedDiscardForDamage = discarded;
  executeAttackHit(state, player, attackIndex);
  finishHit(state, player, attackIndex, false);
  state.snipeTargetOverride = null;
  state.preComputedDiscardForDamage = null;
}

/**
 * Mid-pipeline re-entry: resume a queued Festival Lead second hit after
 * the opponent has promoted a new Active. Called by `promoteBenchToActive`
 * when `state.onPromoteResolved === "secondAttack"`. Re-checks legality
 * because the world may have shifted during the promote:
 *   - attacker may have been KO'd by an on-damage / passive trigger
 *   - opp may have no Active to receive the hit (game-over edge)
 *   - attacker may have been put Asleep / Paralyzed by an ongoing
 *     condition that landed mid-promote
 * Aborted second hits fall through to `endTurnRule` directly.
 */
export function resumeSecondAttack(state: GameState): void {
  const queued = state.pendingSecondAttack;
  if (!queued) return;
  const { player, attackIndex } = queued;
  state.pendingSecondAttack = null;
  if ((state.phase as string) === "gameOver") return;
  const attacker = state.players[player].active;
  const defender = state.players[player === "p1" ? "p2" : "p1"].active;
  if (!attacker || !defender) {
    logEvent(state, "system", "Second hit canceled — no valid attacker/defender.");
    if ((state.phase as string) !== "gameOver") endTurnRule(state);
    return;
  }
  if (hasStatus(attacker, "asleep") || hasStatus(attacker, "paralyzed")) {
    logEvent(state, "system", `${attacker.card.name} can't follow up — status prevented it.`);
    if ((state.phase as string) !== "gameOver") endTurnRule(state);
    return;
  }
  executeAttackHit(state, player, attackIndex);
  finishHit(state, player, attackIndex, true);
  state.snipeTargetOverride = null;
}
