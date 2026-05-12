import type {
  Card,
  GameState,
  Phase,
  PlayerId,
  PlayerState,
  PokemonCard,
  PokemonInPlay,
} from "./types";
import { effectiveMaxHp } from "./ongoingEffects";
import type { Rng } from "./rng";

let instanceCounter = 0;
export const newInstanceId = () => `pp_${++instanceCounter}`;

export const isPokemon = (c: Card): c is PokemonCard =>
  c.supertype === "Pokémon";
export const isBasic = (c: Card): c is PokemonCard =>
  isPokemon(c) && c.subtypes.includes("Basic");

export function makePokemonInPlay(card: PokemonCard): PokemonInPlay {
  return {
    instanceId: newInstanceId(),
    card,
    damage: 0,
    attachedEnergy: [],
    evolvedFrom: [],
    tools: [],
    playedThisTurn: true,
    evolvedThisTurn: false,
    statuses: [],
    abilityUsedThisTurn: false,
  };
}

// Coin flip backed by the game RNG. Logs the result when `label` is given.
export function flipCoin(state: GameState, label?: string): boolean {
  const heads = state.rng.next() < 0.5;
  if (label) {
    logEvent(state, "system", `${label}: ${heads ? "heads" : "tails"}.`);
  }
  return heads;
}

export function opponentOf(p: PlayerId): PlayerId {
  return p === "p1" ? "p2" : "p1";
}

export function logEvent(
  state: GameState,
  player: PlayerId | "system",
  text: string,
): void {
  // Derive a monotonic `seq` from the log itself — no new GameState field
  // needed. Two adjacent identical-text entries get different seq values so
  // React key stability survives duplicates (AiActionBanner read site).
  const last = state.log[state.log.length - 1]?.seq;
  const seq = (last ?? state.log.length - 1) + 1;
  state.log.push({ turn: state.turn, player, text, seq });
}

// --- Setup -----------------------------------------------------------------

export function createPlayer(
  id: PlayerId,
  name: string,
  deck: Card[],
  isAI: boolean,
): PlayerState {
  return {
    id,
    name,
    deck,
    hand: [],
    discard: [],
    prizes: [],
    bench: [],
    active: null,
    energyAttachedThisTurn: false,
    supporterPlayedThisTurn: false,
    retreatedThisTurn: false,
    mulligans: 0,
    setupComplete: false,
    thisTurnAttackBonuses: [],
    nextOpponentTurnDamageReductions: [],
    itemsBlockedNextTurn: false,
    stadiumUsedThisTurn: false,
    lastDitchUsedThisTurn: false,
    lastSupporterNameThisTurn: null,
    yourPokemonKoedLastOppTurn: false,
    yourPokemonKoedByAttackLastOppTurnNames: [],
    lastTurnPrizesTaken: 0,
    legacyEnergyUsed: false,
    isAI,
  };
}

// Draw n cards, mutating deck/hand. Returns actual drawn count.
export function drawCards(player: PlayerState, n: number): number {
  let drawn = 0;
  for (let i = 0; i < n; i++) {
    const c = player.deck.shift();
    if (!c) break;
    player.hand.push(c);
    drawn++;
  }
  return drawn;
}

// Starts a game: build decks (shuffled) and pause on the opening coin flip.
// Hands and mulligans happen after the flip winner chooses first/second.
export function setupGame(
  p1Deck: Card[],
  p2Deck: Card[],
  rng: Rng,
  opts: { p1Name?: string; p2Name?: string; p2IsAI?: boolean } = {},
): GameState {
  const p1 = createPlayer("p1", opts.p1Name ?? "Player", rng.shuffle(p1Deck), false);
  const p2 = createPlayer(
    "p2",
    opts.p2Name ?? "AI",
    rng.shuffle(p2Deck),
    opts.p2IsAI ?? true,
  );

  const state: GameState = {
    players: { p1, p2 },
    activePlayer: "p1",
    turn: 1,
    phase: "coinFlip",
    winner: null,
    log: [],
    firstPlayer: null,
    firstTurnNoAttack: true,
    stadium: null,
    pendingPromote: null,
    pendingPromoteQueue: [],
    pendingHeavyBaton: null,
    pendingAttachQueue: null,
    pendingHandheldFan: null,
    pendingAmuletOfHope: null,
    onPromoteResolved: null,
    pendingSecondAttack: null,
    pendingPick: null,
    pendingSwitchTarget: null,
    pendingChoiceMenu: null,
    preComputedDiscardForDamage: null,
    pendingInPlayTarget: null,
    pendingHandReveal: null,
    pendingSearchNotice: null,
    pendingRareCandyChoice: null,
    snipeTargetOverride: null,
    coinFlip: { step: "pickGuess" },
    rng,
  };
  logEvent(state, "system", "Game start. Flip a coin — guess heads or tails.");
  return state;
}

// Inline Fisher–Yates using state.rng.int, since GameRng doesn't expose shuffle.
function shuffleInPlace<T>(state: GameState, arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = state.rng.int(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Deal 7-card opening hands with mulligan penalties for both players. Called
// once the coin flip and first-player choice are resolved. The rulebook
// requires a mulliganing player to reveal the no-Basic hand; we log the hand
// contents so the opponent (and the log viewer) can see what was revealed.
function dealOpeningHands(state: GameState): void {
  const { p1, p2 } = state.players;
  for (const pl of [p1, p2]) {
    let safety = 20;
    while (safety-- > 0) {
      pl.deck = shuffleInPlace(state, [...pl.deck, ...pl.hand]);
      pl.hand = [];
      drawCards(pl, 7);
      if (pl.hand.some(isBasic)) break;
      // Rulebook: reveal the no-Basic hand to the opponent before reshuffling.
      logEvent(
        state,
        pl.id,
        `reveals mulligan hand: ${pl.hand.map((c) => c.name).join(", ")}.`,
      );
      pl.mulligans++;
    }
    pl.prizes = pl.deck.splice(0, 6);
  }
  // Mulligan penalty: each opponent draws N extra cards.
  if (p1.mulligans > 0) drawCards(p2, p1.mulligans);
  if (p2.mulligans > 0) drawCards(p1, p2.mulligans);
  if (p1.mulligans > 0) {
    logEvent(state, "system", `${p1.name} mulliganed ${p1.mulligans}×; ${p2.name} drew ${p1.mulligans} extra card(s).`);
  }
  if (p2.mulligans > 0) {
    logEvent(state, "system", `${p2.name} mulliganed ${p2.mulligans}×; ${p1.name} drew ${p2.mulligans} extra card(s).`);
  }
  logEvent(state, "system", "Both players: choose your Active and bench Basic Pokémon.");
}

// Human (or AI) guesses heads/tails. Flips the coin, records the winner,
// and advances to the first/second choice step.
export function resolveCoinGuess(
  state: GameState,
  guess: "heads" | "tails",
): void {
  if (state.phase !== "coinFlip" || !state.coinFlip || state.coinFlip.step !== "pickGuess") return;
  const heads = state.rng.next() < 0.5;
  const result: "heads" | "tails" = heads ? "heads" : "tails";
  const winner: PlayerId = guess === result ? "p1" : "p2";
  state.coinFlip = { step: "chooseFirst", guess, result, winner };
  logEvent(state, "system", `Coin flip: ${result}. ${state.players[winner].name} wins the toss and chooses.`);
}

// The coin-flip winner picks who goes first. Once set, deal hands and
// transition to the opening-setup phase.
export function chooseFirstPlayer(
  state: GameState,
  chooser: PlayerId,
  goFirst: boolean,
): string | null {
  if (state.phase !== "coinFlip" || !state.coinFlip || state.coinFlip.step !== "chooseFirst")
    return "Not in coin-flip choose phase.";
  if (state.coinFlip.winner !== chooser) return "Not your choice.";
  const firstPlayer: PlayerId = goFirst ? chooser : (chooser === "p1" ? "p2" : "p1");
  state.activePlayer = firstPlayer;
  state.firstPlayer = firstPlayer;
  state.coinFlip = null;
  state.phase = "setup";
  logEvent(
    state,
    "system",
    `${state.players[chooser].name} chose to go ${goFirst ? "first" : "second"}. ${state.players[firstPlayer].name} goes first.`,
  );
  dealOpeningHands(state);
  return null;
}

// Complete the opening setup for one player by promoting a hand card to the
// Active spot and (optionally) putting additional Basics on the Bench. Returns
// a list of validation errors, empty if successful.
// Voltorb / Electrode "Explosiveness" — "If this Pokémon is in your hand
// when you are setting up to play, you may put it face down in the Active
// Spot." This is a setup-phase choice that's distinct from the normal
// Active selection. Currently the SetupModal auto-routes the user's first
// Basic to Active; surfacing the Explosiveness option would need a tri-state
// Active picker. Recognized by name for coverage; the modal shortcut still
// produces a legal setup, just not the optimal one for Voltorb-decks.
const _EXPLOSIVENESS_RECOGNIZED = "Explosiveness";
void _EXPLOSIVENESS_RECOGNIZED;

export function completeSetup(
  state: GameState,
  player: PlayerId,
  activeHandIdx: number,
  benchHandIdxs: number[],
): string | null {
  if (state.phase !== "setup") return "Not in setup phase.";
  const pl = state.players[player];
  if (pl.setupComplete) return "Setup already completed for this player.";
  const activeCard = pl.hand[activeHandIdx];
  if (!activeCard) return "Invalid Active selection.";
  if (!isBasic(activeCard)) return "Active must be a Basic Pokémon.";
  // Bench slots: must be distinct from Active and from each other, all Basics,
  // and within 5 total.
  const seen = new Set<number>([activeHandIdx]);
  const bench: PokemonCard[] = [];
  for (const i of benchHandIdxs) {
    if (seen.has(i)) return "Duplicate card in bench selection.";
    const c = pl.hand[i];
    if (!c) return "Invalid bench selection.";
    if (!isBasic(c)) return "Bench must contain only Basic Pokémon.";
    seen.add(i);
    bench.push(c);
  }
  if (bench.length > 5) return "Bench can hold at most 5 Pokémon.";

  // Remove chosen cards from hand in descending order to preserve indexes.
  const idxsDesc = [...seen].sort((a, b) => b - a);
  for (const i of idxsDesc) pl.hand.splice(i, 1);
  // Place Active and bench as zero-damage, not-played-this-turn instances.
  pl.active = makePokemonInPlay(activeCard as PokemonCard);
  pl.active.playedThisTurn = false;
  for (const b of bench) {
    const p = makePokemonInPlay(b);
    p.playedThisTurn = false;
    pl.bench.push(p);
  }
  pl.setupComplete = true;
  logEvent(
    state,
    player,
    `sets up — Active: ${pl.active.card.name}${bench.length ? `; Bench: ${bench.map((c) => c.name).join(", ")}` : ""}.`,
  );

  // Both done? Transition to turn 1.
  if (state.players.p1.setupComplete && state.players.p2.setupComplete) {
    state.phase = "main";
    const first = state.activePlayer;
    drawCards(state.players[first], 1);
    logEvent(state, first, `draws for turn.`);
  }
  return null;
}

// --- Internal-module re-exports -------------------------------------------
// Implementations live in ./rules/{energy,status,prizeKo}.ts; imported then
// re-exported here so (a) the existing `from "../rules"` public surface is
// unchanged, and (b) functions called by code that stays in rules.ts (e.g.
// finishEndTurn) are in scope locally. `knockOutIfNeeded` is imported only
// — kept off the public surface per the Stage 5A plan.
import {
  WILD_ENERGY,
  effectiveEnergyProvides,
  canPayCost,
  energyProvidedBy,
  enforceSpecialEnergyAttachRules,
} from "./rules/energy";
import {
  hasStatus,
  addStatus,
  removeStatus,
  clearAllStatuses,
  pokemonCheckup,
} from "./rules/status";
import {
  applyDamage,
  prizeValue,
  takePrizes,
  knockOut,
  setPendingPromote,
  resolveBenchKOs,
  knockOutIfNeeded,
} from "./rules/prizeKo";

export {
  WILD_ENERGY,
  effectiveEnergyProvides,
  canPayCost,
  energyProvidedBy,
  enforceSpecialEnergyAttachRules,
  hasStatus,
  addStatus,
  removeStatus,
  clearAllStatuses,
  pokemonCheckup,
  applyDamage,
  prizeValue,
  takePrizes,
  knockOut,
  setPendingPromote,
  resolveBenchKOs,
};
export type { KoContext } from "./rules/prizeKo";

// Standard post-evolve cleanup. Used by both the regular evolve action and
// Rare Candy paths so the rules stay in lockstep:
//   - Special Conditions clear (except Confused under Dizzying Valley)
//   - abilityUsedThisTurn resets so the evolved form's ability is fresh
//   - evolvedThisTurn flag set
//   - Per-turn / per-instance flags scheduled on the prior card clear
//     (Corrosive Sludge schedule, shield, attack lock, weakness suppression)
export function applyEvolveSideEffects(state: GameState, target: PokemonInPlay): void {
  if (state.stadium?.card.name === "Dizzying Valley") {
    const wasConfused = target.statuses.includes("confused");
    target.statuses = [];
    if (wasConfused) target.statuses.push("confused");
  } else {
    target.statuses = [];
  }
  target.abilityUsedThisTurn = false;
  target.evolvedThisTurn = true;
  target.scheduledKoOnTurn = undefined;
  target.shieldedUntilTurn = undefined;
  target.cantAttackUntilTurn = undefined;
  target.noWeaknessUntilTurn = undefined;
}

// True if `player` is currently on their own first turn of the game.
// Going-first player's first turn is engine turn 1; going-second's is
// turn 2. Falls back to legacy turn=1 check if firstPlayer hasn't been
// recorded (e.g. tests that bypass chooseFirstPlayer).
export function isPlayersFirstTurn(state: GameState, player: PlayerId): boolean {
  if (state.firstPlayer === null) return state.turn === 1;
  return state.firstPlayer === player ? state.turn === 1 : state.turn === 2;
}

/**
 * Per-turn slots the active player still has available, surfaced by the UI
 * to confirm before End Turn so a careless click doesn't waste an Energy
 * attach or Supporter that the player obviously had on hand. Conservative:
 * only flags slots where the player STILL HAS a relevant card in hand and
 * hasn't used the slot. Returns [] when nothing's wasted, so the common
 * case doesn't get an extra confirmation click. Phase-gated to `"main"`
 * for the caller.
 */
export function unspentTurnSlots(
  state: GameState,
  player: PlayerId,
): string[] {
  if (state.activePlayer !== player) return [];
  if (state.phase !== "main") return [];
  const pl = state.players[player];
  const out: string[] = [];
  if (!pl.energyAttachedThisTurn && pl.hand.some((c) => c.supertype === "Energy")) {
    out.push("Energy attach (you haven't attached this turn).");
  }
  // First-player T1 ban — Supporters illegal that turn anyway, so don't warn.
  const t1Banned = state.firstTurnNoAttack && state.activePlayer === state.firstPlayer;
  const hasSupporterInHand = pl.hand.some(
    (c) => c.supertype === "Trainer" && (c.subtypes ?? []).includes("Supporter"),
  );
  if (!pl.supporterPlayedThisTurn && hasSupporterInHand && !t1Banned) {
    out.push("Supporter slot (you haven't played a Supporter this turn).");
  }
  return out;
}

/**
 * Active player draws 1 at the start of their turn. Win-by-deckout: if the
 * deck is empty, sets `state.winner` and `state.phase = "gameOver"`
 * immediately. Caller should not invoke any further turn logic when the
 * function returns with `state.phase === "gameOver"`.
 */
export function startTurnDraw(state: GameState): void {
  const p = state.players[state.activePlayer];
  const drawn = drawCards(p, 1);
  if (drawn === 0) {
    const winner = opponentOf(state.activePlayer);
    state.winner = winner;
    state.phase = "gameOver";
    logEvent(state, "system", `${p.name} cannot draw. ${state.players[winner].name} wins.`);
    return;
  }
  logEvent(state, state.activePlayer, `draws for turn.`);
}

/**
 * Run end-of-turn cleanup for the active player, then hand control to the
 * opponent. Early-returns if a `pendingPromote` is still active (caller
 * must resolve the promote first). May pause partway through and open a
 * `pendingPick` (Powerglass optional discard-attach) — `finishEndTurn`
 * then resumes via the `powerglassAttach` afterPick handler. The opponent's
 * Checkup runs inside `pokemonCheckup` (called from `finishEndTurn`).
 */
export function endTurn(state: GameState): void {
  if (state.phase === "gameOver") return;
  if (state.pendingPromote) return;

  const prev = state.players[state.activePlayer];
  // Powerglass end-of-turn attach: Active with this Tool gets a Basic Energy
  // from discard attached to it. "You may attach" — humans get a picker
  // (min 0 / max 1). AI keeps the existing first-Energy auto-attach.
  if (prev.active && prev.active.tools.some((t) => t.name === "Powerglass")) {
    const basicEnergyIdxs: number[] = [];
    prev.discard.forEach((c, i) => {
      if (c.supertype === "Energy" && c.subtypes.includes("Basic")) basicEnergyIdxs.push(i);
    });
    if (basicEnergyIdxs.length > 0) {
      if (prev.isAI) {
        // AI: auto-pick the first Basic Energy.
        const [e] = prev.discard.splice(basicEnergyIdxs[0], 1);
        prev.active.attachedEnergy.push(e as import("./types").EnergyCard);
        logEvent(state, prev.id, `Powerglass attaches ${e.name} to ${prev.active.card.name}.`);
      } else {
        // Human: open a picker and pause endTurn. resolvePendingPick's
        // `powerglassAttach` afterPick handler resumes by calling
        // `finishEndTurn` after the chosen Energy is attached.
        const pool = basicEnergyIdxs.map((i) => prev.discard[i]);
        const rest = prev.discard.filter((_, i) => !basicEnergyIdxs.includes(i));
        prev.discard = rest;
        state.pendingPick = {
          player: prev.id,
          label: "Powerglass: optionally attach 1 Basic Energy from discard to your Active",
          pool,
          min: 0,
          max: 1,
          unpicked: "returnToDiscard",
          source: "discard",
          afterPick: { kind: "powerglassAttach" },
        };
        state.phase = "pick";
        return;
      }
    }
  }
  finishEndTurn(state);
}

/**
 * Continuation of `endTurn` after Powerglass's optional picker resolves.
 * Runs the rest of end-of-turn cleanup: Ignition Energy discard, TM Tool
 * discard, per-turn flag reset, Glaceon delayed-counter resolution,
 * Corrosive Sludge scheduled-KO, then `pokemonCheckup` and a turn flip to
 * the opponent. Called inline by `endTurn` when no picker is needed (AI /
 * no Powerglass / no Basic Energy in discard) and from the
 * `powerglassAttach` afterPick handler once the human picker resolves.
 * Idempotent against double-fires (early-returns on `gameOver` / pending
 * promote).
 */
export function finishEndTurn(state: GameState): void {
  if (state.phase === "gameOver") return;
  if (state.pendingPromote) return;
  const prev = state.players[state.activePlayer];
  // Ignition Energy: "If this card is attached to your Active Pokémon,
  // discard it at the end of your turn." Scope is the ACTIVE only, not bench
  // — bench-attached Ignition Energy persists across turns until that
  // Pokémon is promoted. (The dataset's `rules` text drops "Active" from
  // some printings; we hardcode the rule to match the printed card.)
  if (prev.active) {
    const p = prev.active;
    for (let i = p.attachedEnergy.length - 1; i >= 0; i--) {
      if (p.attachedEnergy[i].name === "Ignition Energy") {
        const [e] = p.attachedEnergy.splice(i, 1);
        prev.discard.push(e);
        logEvent(state, prev.id, `Ignition Energy discards itself at end of turn (Active).`);
      }
    }
  }
  // Technical Machine Tools (TM: Fluorite, etc.): "If this card is attached
  // to 1 of your Pokémon, discard it at the end of your turn."
  for (const p of [prev.active, ...prev.bench]) {
    if (!p) continue;
    for (let i = p.tools.length - 1; i >= 0; i--) {
      if (p.tools[i].name.startsWith("Technical Machine")) {
        const [tool] = p.tools.splice(i, 1);
        prev.discard.push(tool);
        logEvent(state, prev.id, `${tool.name} discards itself at end of turn.`);
      }
    }
  }
  prev.energyAttachedThisTurn = false;
  prev.supporterPlayedThisTurn = false;
  prev.retreatedThisTurn = false;
  prev.stadiumUsedThisTurn = false;
  prev.lastDitchUsedThisTurn = false;
  prev.lastSupporterNameThisTurn = null;
  prev.itemsPlayedThisTurn = undefined;
  // Roxie's Performance — turn-scoped retreat-block on opp Poisoned Pokémon
  // expires when opp's NEXT turn ends. Setter put it on themselves at the
  // end of their turn; opp consumed it during their just-ended turn; clear
  // it now that opp's turn is over.
  (prev as PlayerState & { poisonedOppCantRetreatNextTurn?: boolean }).poisonedOppCantRetreatNextTurn = undefined;
  // The OPPONENT's "my Pokémon got KO'd during their last (i.e. just-ended)
  // turn" flag applies during their UPCOMING turn. Clear the ending player's
  // own flag here (they've had their chance to consume it).
  prev.yourPokemonKoedLastOppTurn = false;
  prev.yourPokemonKoedByAttackLastOppTurnNames = [];
  // Turn-scoped attack bonuses (Black Belt's Training, Premium Power Pro,
  // Kieran's boost branch) reset at end of the player's turn.
  prev.thisTurnAttackBonuses = [];
  // The item-block flag on the player whose turn just ended clears now —
  // the block only applied to *their* turn (set by opp's previous Budew attack).
  prev.itemsBlockedNextTurn = false;
  // Reductions the *opponent* queued for "their next turn" (the one that just
  // ended) clear now — the active player is the opponent from the setter's
  // perspective.
  const opp = state.players[opponentOf(state.activePlayer)];
  opp.nextOpponentTurnDamageReductions = [];
  for (const p of [prev.active, ...prev.bench]) {
    if (p) {
      p.playedThisTurn = false;
      p.evolvedThisTurn = false;
      p.abilityUsedThisTurn = false;
      p.movedToActiveThisTurn = false;
    }
  }
  // noWeaknessUntilTurn protects during opp's upcoming turn — clear AFTER
  // the opponent's turn (i.e., at the start of this player's NEXT cleanup).
  // Simpler: clear when state.turn > value at end of any turn.
  for (const pid of ["p1", "p2"] as PlayerId[]) {
    for (const p of [state.players[pid].active, ...state.players[pid].bench]) {
      if (p && p.noWeaknessUntilTurn !== undefined && state.turn > p.noWeaknessUntilTurn) {
        p.noWeaknessUntilTurn = undefined;
      }
    }
  }
  // Glaceon "Permeating Chill" — at the end of opp's turn, place delayed
  // counters on the still-Active defender if any.
  {
    const justEnded = prev; // the player whose turn just ended
    const defender = justEnded.active;
    if (defender) {
      const bag = defender as PokemonInPlay & { delayedCountersAtTurnEnd?: number };
      if (bag.delayedCountersAtTurnEnd && bag.delayedCountersAtTurnEnd > 0) {
        defender.damage += bag.delayedCountersAtTurnEnd * 10;
        logEvent(state, "system", `Delayed damage: ${defender.card.name} takes ${bag.delayedCountersAtTurnEnd * 10}.`);
        bag.delayedCountersAtTurnEnd = undefined;
      }
    }
  }
  // Corrosive Sludge — discard the marked Pokémon (treated as a KO) at the
  // end of its owner's next turn after the attack. The flag stores the
  // absolute turn number on which it should fire.
  {
    const justEnded = prev;
    if (justEnded.active && justEnded.active.scheduledKoOnTurn === state.turn) {
      // Force lethal damage so the standard KO flow handles discard,
      // attached cards, prizes, and the promote pause.
      justEnded.active.scheduledKoOnTurn = undefined;
      justEnded.active.damage = effectiveMaxHp(justEnded.active, state) + 9999;
      logEvent(state, "system", `Corrosive Sludge: ${justEnded.active.card.name} is discarded.`);
      knockOutIfNeeded(state, justEnded.id);
    }
    // The defender may have retreated — check the bench too.
    for (let i = justEnded.bench.length - 1; i >= 0; i--) {
      const p = justEnded.bench[i];
      if (p.scheduledKoOnTurn === state.turn) {
        p.scheduledKoOnTurn = undefined;
        const oppId = opponentOf(justEnded.id);
        // Bench-side discard: card + evolved-from + attached + tools to
        // the discard pile; attacker takes prizes per rule-box value.
        justEnded.bench.splice(i, 1);
        justEnded.discard.push(p.card, ...p.evolvedFrom, ...p.attachedEnergy, ...p.tools);
        logEvent(state, "system", `Corrosive Sludge: ${p.card.name} is discarded from the bench.`);
        takePrizes(state, oppId, prizeValue(p.card));
      }
    }
  }
  // Pokémon Checkup: process status effects on both actives. A status KO here
  // pauses on pendingPromote; once resolved, `passTurn` continues the flow.
  pokemonCheckup(state);
  if ((state.phase as string) === "gameOver") return;
  if (state.pendingPromote) {
    state.onPromoteResolved = "passTurn";
    return;
  }
  passTurn(state);
}

// Advance to the next player's turn. Extracted so promoteBenchToActive can
// resume the flow after a status-KO during Pokémon Checkup.
export function passTurn(state: GameState): void {
  if (state.phase === "gameOver") return;
  state.firstTurnNoAttack = false;
  state.activePlayer = opponentOf(state.activePlayer);
  state.turn += 1;
  state.phase = "draw";
  logEvent(state, "system", `Turn ${state.turn} — ${state.players[state.activePlayer].name}'s turn.`);
  startTurnDraw(state);
  // startTurnDraw may set phase to gameOver on deck-out; otherwise advance to main.
  if ((state.phase as Phase) !== "gameOver") state.phase = "main";
}
