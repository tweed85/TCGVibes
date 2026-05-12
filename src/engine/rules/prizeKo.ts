// Damage, KO routing, prize logic, and bench-KO resolution. Extracted
// from rules.ts as part of Stage 5A internal-module split. `logEvent`
// and `opponentOf` are imported from "../rules" — circular at the
// module-import graph, safe at runtime because both are hoisted
// function declarations only called inside function bodies here.

import { logEvent, opponentOf } from "../rules";
import {
  effectiveMaxHp,
  enforceAreaZeroBench,
  prizeReductionFromTools,
  toolOnKoActions,
} from "../ongoingEffects";
import type {
  Card,
  EnergyCard,
  GameState,
  PlayerId,
  PokemonCard,
  PokemonInPlay,
} from "../types";

/**
 * Apply damage to the defender's Active. Caller is responsible for applying
 * Weakness/Resistance and any reductions; this is the post-modifier sink.
 * Routes through `knockOut` with `byOpponentAttack: true` when HP hits 0 —
 * which is the gate that lets opponent-attack-only KO triggers (Legacy
 * Energy, Heavy Baton, Amulet of Hope, Lillie's Pearl) fire. Self-damage
 * from recoil / status / Cursed Blast must NOT flow through here.
 */
export function applyDamage(
  state: GameState,
  defenderOwner: PlayerId,
  damage: number,
): void {
  const target = state.players[defenderOwner].active;
  if (!target) return;
  // Apply weakness (×2) / resistance (-30) against attacker's type.
  // (MVP simplification handled by caller when computing damage.)
  target.damage += damage;
  logEvent(
    state,
    "system",
    `${target.card.name} takes ${damage} damage (now ${target.damage}).`,
  );
  if (target.damage >= effectiveMaxHp(target, state)) {
    knockOut(state, defenderOwner, { byOpponentAttack: true });
  }
}

// Prize-card value when KO'd. Mega Evolution ex / VMAX / V-UNION give 3;
// ex/V/VSTAR/GX give 2; Radiant and everything else give 1.
export function prizeValue(card: PokemonCard): number {
  const subs = card.subtypes ?? [];
  // Mega Evolution ex Rule: "When your Mega Evolution Pokémon ex is Knocked
  // Out, your opponent takes 3 Prize cards." Cards mark this with both "MEGA"
  // (or "Mega ...") and "ex" subtypes — check Mega first.
  if (subs.some((s) => /^mega(?:\s|$)/i.test(s))) return 3;
  if (subs.includes("VMAX")) return 3;
  if (subs.includes("VSTAR")) return 2;
  if (subs.includes("V")) return 2;
  if (subs.includes("V-UNION")) return 3;
  if (subs.includes("ex") || subs.includes("EX") || subs.includes("GX")) return 2;
  // Radiant Pokémon give 1 prize (not 2) but carry restrictions; treat as 1.
  return 1;
}

/**
 * Move `count` Prize cards from `taker`'s prize pile into their hand.
 * Caller is responsible for checking the win condition (prizes=0) afterward
 * — `takePrizes` does not promote the player or set `state.winner`.
 */
export function takePrizes(state: GameState, taker: PlayerId, count: number): void {
  const opp = state.players[taker];
  let taken = 0;
  for (let i = 0; i < count; i++) {
    const prize = opp.prizes.shift();
    if (!prize) break;
    opp.hand.push(prize);
    taken++;
    logEvent(state, opp.id, `takes a Prize (${prize.name}).`);
  }
  if (taken < count) {
    logEvent(
      state,
      "system",
      `Only ${taken} Prize(s) remaining of ${count} owed.`,
    );
  }
}

export interface KoContext {
  byOpponentAttack?: boolean;
}

/**
 * KO the Active Pokémon of `ownerId` and resolve prize/win logic. Ordering:
 *   1. KO-triggered Tool effects fire BEFORE the card hits discard (so the
 *      Tool itself is still attached for predicates that check it).
 *   2. Opponent-attack-only triggers (Legacy Energy, Heavy Baton, Amulet of
 *      Hope, Lillie's Pearl, Final Chain, Infinite Shadow) only fire when
 *      `ctx.byOpponentAttack === true` AND the KO didn't happen on the
 *      victim's own turn. `applyDamage` is the only caller that sets that.
 *   3. Prizes are taken and the active is cleared, but no promote prompt
 *      is set here — callers route through `setPendingPromote` (which
 *      respects the FIFO promote queue) when a new Active is needed.
 *   4. Win condition (prizes=0 OR no Pokémon left) is evaluated last;
 *      sets `state.winner` and `state.phase = "gameOver"` in place.
 */
export function knockOut(
  state: GameState,
  ownerId: PlayerId,
  ctx: KoContext = {},
): void {
  const owner = state.players[ownerId];
  if (!owner.active) return;
  const ko = owner.active;
  const byOpponentAttack = ctx.byOpponentAttack === true && state.activePlayer !== ownerId;
  // If the KO happens on the opponent's turn, flag the KO'd player so their
  // Flip-the-Script-style "if one of your Pokémon was KO'd last turn" gate
  // can fire on their next turn.
  if (state.activePlayer !== ownerId) owner.yourPokemonKoedLastOppTurn = true;
  // Resolve KO-triggered Tool effects BEFORE the KO'd card goes to discard,
  // so the Tool is still "attached" for any condition checks. These effects
  // take place from the KO'd player's perspective.
  for (const act of byOpponentAttack ? toolOnKoActions(state, ko) : []) {
    if (act.kind === "searchDeckAnyN") {
      // Amulet of Hope — search your deck for up to N cards. Mid-KO we can't
      // open an interactive pick (pendingPromote needs the phase), so:
      //   - AI owner: keep the priority-based auto-search (Basic → Supporter
      //     → Pokémon → Energy → other), preserved unchanged.
      //   - Human owner: stash on `pendingAmuletOfHope` and defer the picker
      //     until after `promoteBenchToActive` completes. Mirrors Heavy
      //     Baton's pause-and-resume pattern.
      if (owner.isAI) {
        const priority = (c: Card): number => {
          if (c.supertype === "Pokémon" && c.subtypes.includes("Basic")) return 4;
          if (c.supertype === "Trainer" && c.subtypes.includes("Supporter")) return 3;
          if (c.supertype === "Pokémon") return 2;
          if (c.supertype === "Energy") return 1;
          return 0;
        };
        const sortedIdxs = owner.deck
          .map((c, i) => ({ i, prio: priority(c) }))
          .sort((a, b) => b.prio - a.prio)
          .slice(0, act.count)
          .map((x) => x.i)
          .sort((a, b) => b - a); // splice from high to low index
        const taken: Card[] = [];
        for (const i of sortedIdxs) taken.push(...owner.deck.splice(i, 1));
        owner.hand.push(...taken);
        if (taken.length > 0) {
          logEvent(
            state,
            ownerId,
            `Amulet of Hope: searches deck for ${taken.map((c) => c.name).join(", ")}.`,
          );
        }
        const arr = owner.deck;
        for (let i = arr.length - 1; i > 0; i--) {
          const j = state.rng.int(i + 1);
          [arr[i], arr[j]] = [arr[j], arr[i]];
        }
      } else {
        // Human: defer the picker until after the promote completes.
        state.pendingAmuletOfHope = { ownerId };
        logEvent(state, ownerId, "Amulet of Hope: pick up to 3 cards from your deck after you promote.");
      }
    } else if (act.kind === "moveEnergyToBench") {
      // Heavy Baton — move Energy from the KO'd Pokémon to a Benched ally.
      // Path A (auto): AI controllers and humans with ≤1 bench have no
      // meaningful choice — auto-target the highest-energy bench Pokémon
      // (continuation-of-game heuristic: reinforce the prepared hitter).
      // Path B (interactive): a human with 2+ bench picks the recipient.
      // Energies stash on `pendingHeavyBaton`; the picker fires after the
      // owner promotes a new Active (mid-KO can't open a picker because
      // pendingPromote takes the phase). The energies are pulled out of
      // `ko.attachedEnergy` so the standard discard-attached-cards step
      // doesn't sweep them away.
      if (owner.bench.length > 0 && ko.attachedEnergy.length > 0) {
        // Card text: "move up to 3 Basic Energy cards." Filter to Basic Energy
        // only — Special Energy cards do NOT move.
        const basicEnergyIdxs: number[] = [];
        for (let i = 0; i < ko.attachedEnergy.length; i++) {
          if (ko.attachedEnergy[i].subtypes.includes("Basic")) basicEnergyIdxs.push(i);
        }
        const moveCount = Math.min(act.max, basicEnergyIdxs.length);
        if (moveCount === 0) break;
        const interactive = !owner.isAI && owner.bench.length > 1;
        if (interactive) {
          // Splice basics out (back-to-front so indexes stay valid).
          const moved: EnergyCard[] = [];
          for (let i = basicEnergyIdxs.length - 1; i >= 0 && moved.length < moveCount; i--) {
            const [e] = ko.attachedEnergy.splice(basicEnergyIdxs[i], 1);
            moved.unshift(e);
          }
          state.pendingHeavyBaton = {
            ownerId,
            energies: moved,
            max: moved.length,
          };
          logEvent(state, ownerId, `Heavy Baton: pick a Bench Pokémon to receive ${moved.length} Energy.`);
        } else {
          const target = owner.bench
            .slice()
            .sort((a, b) => b.attachedEnergy.length - a.attachedEnergy.length)[0];
          let moved = 0;
          for (let i = basicEnergyIdxs.length - 1; i >= 0 && moved < moveCount; i--) {
            const [e] = ko.attachedEnergy.splice(basicEnergyIdxs[i], 1);
            target.attachedEnergy.push(e);
            moved++;
          }
          if (moved > 0) {
            logEvent(state, ownerId, `Heavy Baton moves ${moved} Basic Energy to ${target.card.name}.`);
          }
        }
      }
    }
  }
  // Flygon Sandy Flapping — when this Pokémon is KO'd in the Active Spot
  // from opponent's damage, discard top 2 of opp's deck.
  {
    const hasSandyFlapping = (ko.card.abilities ?? []).some(
      (a) => a.name === "Sandy Flapping",
    );
    if (hasSandyFlapping) {
      const oppId = opponentOf(ownerId);
      const opp = state.players[oppId];
      const top = opp.deck.splice(0, 2);
      if (top.length > 0) {
        opp.discard.push(...top);
        logEvent(state, ownerId, `Sandy Flapping (KO): discards ${top.length} card(s) from ${opp.name}'s deck.`);
      }
    }
  }

  const basePrizes = prizeValue(ko.card);
  let reduction = byOpponentAttack ? prizeReductionFromTools(ko) : 0;
  let bonus = 0;
  // Legacy Energy — once per game per player: if KO'd by opponent's attack,
  // opp takes 1 fewer Prize.
  const hasLegacy = ko.attachedEnergy.some((e) => e.name === "Legacy Energy");
  if (byOpponentAttack && hasLegacy && !owner.legacyEnergyUsed) {
    reduction += 1;
    owner.legacyEnergyUsed = true;
    logEvent(state, ownerId, `Legacy Energy triggers — opponent takes 1 fewer Prize.`);
  }
  // Fragile Husk (Shedinja) — if KO'd by opp's Pokémon ex, opp takes 0 prizes.
  if ((ko.card.abilities ?? []).some((a) => a.name === "Fragile Husk")) {
    const oppActive = state.players[opponentOf(ownerId)].active;
    if (oppActive && (oppActive.card.subtypes ?? []).some((s) => /^(?:ex|EX)$/.test(s))) {
      reduction += 99;
      logEvent(state, ownerId, `Fragile Husk: opponent takes no Prizes.`);
    }
  }
  // Shadowy Concealment (Mega Gengar ex) — if 1 of your Darkness Pokémon is
  // KO'd by opp's ex, opp takes 1 fewer Prize. Doesn't stack.
  if (ko.card.types.includes("Darkness")) {
    const allies = [owner.active, ...owner.bench].filter((p): p is PokemonInPlay => !!p);
    const hasShadowy = allies.some((p) => (p.card.abilities ?? []).some((a) => a.name === "Shadowy Concealment"));
    if (hasShadowy) {
      const oppActive = state.players[opponentOf(ownerId)].active;
      if (oppActive && (oppActive.card.subtypes ?? []).some((s) => /^(?:ex|EX)$/.test(s))) {
        reduction += 1;
        logEvent(state, ownerId, `Shadowy Concealment: opponent takes 1 fewer Prize.`);
      }
    }
  }
  // Greedy Eater (Hydreigon ex) — if you (the KOing player) have Hydreigon ex
  // with this ability and the KO'd Pokémon is Basic, take 1 more Prize.
  {
    const taker = state.players[opponentOf(ownerId)];
    const takerAllies = [taker.active, ...taker.bench].filter((p): p is PokemonInPlay => !!p);
    const hasGreedy = takerAllies.some((p) => (p.card.abilities ?? []).some((a) => a.name === "Greedy Eater"));
    if (hasGreedy && (ko.card.subtypes ?? []).includes("Basic")) {
      bonus += 1;
      logEvent(state, taker.id, `Greedy Eater: takes 1 more Prize.`);
    }
    // Wonder Kiss (Togekiss) — when opp Active is KO'd, flip → +1 Prize.
    const hasWonderKiss = takerAllies.some((p) => (p.card.abilities ?? []).some((a) => a.name === "Wonder Kiss"));
    if (hasWonderKiss) {
      const heads = state.rng.next() < 0.5;
      if (heads) {
        bonus += 1;
        logEvent(state, taker.id, `Wonder Kiss flip: heads — takes 1 more Prize.`);
      } else {
        logEvent(state, taker.id, `Wonder Kiss flip: tails.`);
      }
    }
  }
  // Oh No You Don't (Munkidori ex) — if KO'd by opp's Pokémon AND you have
  // any Pecharunt ex in play, opp takes 1 fewer Prize.
  if ((ko.card.abilities ?? []).some((a) => a.name === "Oh No You Don't")) {
    const ownerAllies = [owner.active, ...owner.bench].filter((p): p is PokemonInPlay => !!p);
    if (ownerAllies.some((p) => p.card.name === "Pecharunt ex")) {
      reduction += 1;
      logEvent(state, ownerId, `Oh No You Don't: opp takes 1 fewer Prize.`);
    }
  }
  // Final Chain — if KO'd by opp's attack, search deck for any 1 card and
  // put into hand. AI auto-picks the most useful card (any draw / energy / ex);
  // simplest heuristic: pick the first ex Pokémon, else first energy, else
  // first card.
  if (byOpponentAttack && (ko.card.abilities ?? []).some((a) => a.name === "Final Chain")) {
    const deck = owner.deck;
    if (deck.length > 0) {
      const isEx = (c: Card) =>
        c.supertype === "Pokémon" && (c.subtypes ?? []).some((s) => /^(?:ex|EX)$/.test(s));
      const isEnergy = (c: Card) => c.supertype === "Energy";
      let idx = deck.findIndex(isEx);
      if (idx < 0) idx = deck.findIndex(isEnergy);
      if (idx < 0) idx = 0;
      const [picked] = deck.splice(idx, 1);
      owner.hand.push(picked);
      // Shuffle the rest in place via Fisher–Yates using state.rng.
      for (let i = deck.length - 1; i > 0; i--) {
        const j = state.rng.int(i + 1);
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
      logEvent(state, ownerId, `Final Chain: searches deck for ${picked.name}.`);
    }
  }
  // Infinite Shadow — if KO'd by opp's attack, return this card to hand
  // instead of the discard pile (attached cards still go to discard).
  const infiniteShadow =
    byOpponentAttack && (ko.card.abilities ?? []).some((a) => a.name === "Infinite Shadow");
  const prizes = Math.max(0, basePrizes - reduction + bonus);
  if (prizes !== basePrizes) {
    logEvent(state, "system", `${ko.card.name} Knocked Out — prizes reduced.`);
  }
  logEvent(
    state,
    "system",
    `${ko.card.name} is Knocked Out! (${prizes} Prize${prizes !== 1 ? "s" : ""})`,
  );
  // Move active + evolution stack + attached energy + tools to discard.
  // Infinite Shadow returns the KO'd card to hand instead; attached cards
  // and pre-evolutions still go to discard. Diver's Catch (Wugtrio) — if a
  // Water Pokémon is KO'd and any owner ally has this ability, Basic Water
  // Energy on that Pokémon returns to hand instead of going to discard.
  const ownerAllies = [owner.active, ...owner.bench].filter((p): p is PokemonInPlay => !!p);
  const hasDiversCatch = ownerAllies.some((p) =>
    (p.card.abilities ?? []).some((a) => a.name === "Diver's Catch"),
  );
  const energyToHand: EnergyCard[] = [];
  const energyToDiscard: EnergyCard[] = [];
  if (hasDiversCatch && ko.card.types.includes("Water")) {
    for (const e of ko.attachedEnergy) {
      if ((e.subtypes ?? []).includes("Basic") && e.provides.includes("Water")) {
        energyToHand.push(e);
      } else {
        energyToDiscard.push(e);
      }
    }
    if (energyToHand.length > 0) {
      logEvent(state, ownerId, `Diver's Catch: returns ${energyToHand.length} Basic Water Energy to hand.`);
    }
  } else {
    energyToDiscard.push(...ko.attachedEnergy);
  }
  if (infiniteShadow) {
    owner.hand.push(ko.card);
    owner.hand.push(...energyToHand);
    owner.discard.push(
      ...ko.evolvedFrom,
      ...energyToDiscard,
      ...(ko.tools ?? []),
    );
    logEvent(state, ownerId, `Infinite Shadow: ${ko.card.name} returns to hand.`);
  } else {
    owner.hand.push(...energyToHand);
    owner.discard.push(
      ko.card,
      ...ko.evolvedFrom,
      ...energyToDiscard,
      ...(ko.tools ?? []),
    );
  }
  owner.active = null;
  // Area Zero Underdepths — if the KO'd Pokémon was the holder's only Tera,
  // their bench cap drops back to 5 and excess bench Pokémon are discarded.
  enforceAreaZeroBench(state);

  takePrizes(state, opponentOf(ownerId), prizes);

  // Win by prizes.
  const opp = state.players[opponentOf(ownerId)];
  if (opp.prizes.length === 0) {
    state.winner = opp.id;
    state.phase = "gameOver";
    logEvent(state, "system", `${opp.name} wins by taking all Prizes.`);
    return;
  }

  // Owner must promote a benched Pokémon. If none, owner loses.
  if (owner.bench.length === 0) {
    state.winner = opp.id;
    state.phase = "gameOver";
    logEvent(
      state,
      "system",
      `${owner.name} has no Pokémon left. ${opp.name} wins.`,
    );
    return;
  }
  // Pause the game for the owner to pick a new active (UI / AI resolves it
  // via promoteBenchToActive). The activePlayer is unchanged.
  setPendingPromote(state, ownerId);
  state.phase = "promoteActive";
}

// Internal helper used by both prizeKo.ts (damageFromStatus-after-checkup
// in status.ts) and rules.ts (Corrosive Sludge scheduled-KO in
// finishEndTurn). Not part of the public rules surface.
export function knockOutIfNeeded(state: GameState, ownerId: PlayerId): void {
  const owner = state.players[ownerId];
  if (owner.active && owner.active.damage >= effectiveMaxHp(owner.active, state)) {
    knockOut(state, ownerId);
  }
}

// Schedule `ownerId` to promote a benched Pokémon. If another player is
// already pending (both-Active-KO from Dark Pulse, attacker self-bounce while
// defender is also KO'd, etc.), queue this one — promoteBenchToActive drains
// the queue in FIFO order. Caller is responsible for setting state.phase
// (terminal promotes use "promoteActive"; non-terminal — e.g. Run Away Draw,
// Cursed Blast — keep phase="main" so the player can keep playing).
export function setPendingPromote(state: GameState, ownerId: PlayerId): void {
  if (state.pendingPromote && state.pendingPromote !== ownerId) {
    if (!state.pendingPromoteQueue.includes(ownerId)) {
      state.pendingPromoteQueue.push(ownerId);
    }
  } else {
    state.pendingPromote = ownerId;
  }
}

// Knock out benched Pokémon whose damage >= HP (e.g., bench snipe damage).
// Returns true if any bench KOs were resolved.
export function resolveBenchKOs(state: GameState): boolean {
  let any = false;
  for (const pid of ["p1", "p2"] as PlayerId[]) {
    const pl = state.players[pid];
    const survivors: typeof pl.bench = [];
    for (const p of pl.bench) {
      if (p.damage >= effectiveMaxHp(p, state)) {
        // Bench KO during the opponent's turn flags the owner for next-turn
        // Flip-the-Script gating.
        if (state.activePlayer !== pid) pl.yourPokemonKoedLastOppTurn = true;
        const prizes = prizeValue(p.card);
        logEvent(
          state,
          "system",
          `${p.card.name} is Knocked Out on the Bench! (${prizes} Prize${prizes > 1 ? "s" : ""})`,
        );
        pl.discard.push(
          p.card,
          ...p.evolvedFrom,
          ...p.attachedEnergy,
          ...(p.tools ?? []),
        );
        takePrizes(state, opponentOf(pid), prizes);
        any = true;
        // Check prize-out win mid-loop.
        const opp = state.players[opponentOf(pid)];
        if (opp.prizes.length === 0 && state.phase !== "gameOver") {
          state.winner = opp.id;
          state.phase = "gameOver";
          logEvent(state, "system", `${opp.name} wins by taking all Prizes.`);
          return true;
        }
      } else {
        survivors.push(p);
      }
    }
    pl.bench = survivors;
  }
  return any;
}
