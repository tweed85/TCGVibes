// Interactive-pick infrastructure.
//
// Search / peek / discard-recovery effects pull a set of candidate cards out
// of the player's deck or discard and ask them to pick up to N. The chosen
// cards go to hand; the rest go back per `PendingPick.unpicked`. While a pick
// is pending, the game is paused (phase = "pick"); other player actions are
// blocked until the pick resolves.

import { endTurn as endTurnRule, logEvent, makePokemonInPlay } from "./rules";
import { fireTriggeredOnBench } from "./abilities";
import type {
  Card,
  GameState,
  PlayerId,
} from "./types";

export type ActionResult =
  | { ok: true }
  | { ok: false; reason: string };

const ok: ActionResult = { ok: true };
const fail = (reason: string): ActionResult => ({ ok: false, reason });

function shuffleDeck(state: GameState, pl: PlayerId): void {
  const player = state.players[pl];
  const arr = player.deck;
  for (let i = arr.length - 1; i > 0; i--) {
    const j = state.rng.int(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ---------------------------------------------------------------------------
// Builders — extract candidate cards and set state.pendingPick.
// Return true if a pick was set, false if no candidates exist (caller should
// log a "no eligible cards" message and move on).
// ---------------------------------------------------------------------------

// Prize cards are their own face-down pile — they must NEVER appear in a
// deck / discard search pool. We defensively filter by identity: if a prize
// Card reference somehow shows up in `pl.deck`, drop it on the floor.
function excludePrizes(pl: { prizes: Card[] }, cards: Card[]): Card[] {
  if (pl.prizes.length === 0) return cards;
  const prizeSet = new Set(pl.prizes);
  return cards.filter((c) => !prizeSet.has(c));
}

export function setDeckSearchPick(
  state: GameState,
  player: PlayerId,
  pred: (c: Card) => boolean,
  max: number,
  label: string,
  options: { toBench?: boolean } = {},
): boolean {
  const pl = state.players[player];
  const safeDeck = excludePrizes(pl, pl.deck);
  const pool: Card[] = [];
  const rest: Card[] = [];
  for (const c of safeDeck) {
    if (pred(c)) pool.push(c);
    else rest.push(c);
  }
  if (pool.length === 0) {
    // Still shuffle to hide information from the player.
    shuffleDeck(state, player);
    return false;
  }
  pl.deck = rest;
  state.pendingPick = {
    player,
    label,
    pool,
    min: 0,
    max: Math.min(max, pool.length),
    unpicked: "shuffleIntoDeck",
    source: "deck",
    toBench: options.toBench,
  };
  state.phase = "pick";
  return true;
}

export function setTopPeekPick(
  state: GameState,
  player: PlayerId,
  slice: number,
  eligible: (c: Card) => boolean,
  max: number,
  label: string,
): boolean {
  const pl = state.players[player];
  // Defensively ensure the deck has no prize references before we peek.
  pl.deck = excludePrizes(pl, pl.deck);
  const pool = pl.deck.splice(0, slice);
  if (pool.length === 0) return false;
  const eligibleIndexes: number[] = [];
  pool.forEach((c, i) => { if (eligible(c)) eligibleIndexes.push(i); });
  state.pendingPick = {
    player,
    label,
    pool,
    min: 0,
    max: Math.min(max, eligibleIndexes.length),
    eligibleIndexes,
    unpicked: "shuffleIntoDeck",
    source: "deckTop",
  };
  state.phase = "pick";
  return true;
}

export function setBottomPeekPick(
  state: GameState,
  player: PlayerId,
  slice: number,
  eligible: (c: Card) => boolean,
  max: number,
  label: string,
): boolean {
  const pl = state.players[player];
  pl.deck = excludePrizes(pl, pl.deck);
  const start = Math.max(0, pl.deck.length - slice);
  const pool = pl.deck.splice(start, slice);
  if (pool.length === 0) return false;
  const eligibleIndexes: number[] = [];
  pool.forEach((c, i) => { if (eligible(c)) eligibleIndexes.push(i); });
  state.pendingPick = {
    player,
    label,
    pool,
    min: 0,
    max: Math.min(max, eligibleIndexes.length),
    eligibleIndexes,
    unpicked: "shuffleIntoDeck",
    source: "deckBottom",
  };
  state.phase = "pick";
  return true;
}

export function setDiscardRecoveryPick(
  state: GameState,
  player: PlayerId,
  pred: (c: Card) => boolean,
  max: number,
  label: string,
): boolean {
  const pl = state.players[player];
  const pool: Card[] = [];
  const rest: Card[] = [];
  for (const c of pl.discard) {
    if (pred(c)) pool.push(c);
    else rest.push(c);
  }
  if (pool.length === 0) return false;
  pl.discard = rest;
  state.pendingPick = {
    player,
    label,
    pool,
    min: 0,
    max: Math.min(max, pool.length),
    unpicked: "returnToDiscard",
    source: "discard",
  };
  state.phase = "pick";
  return true;
}

// ---------------------------------------------------------------------------
// AI auto-resolve — picks greedily up to `max` from the eligible pool.
// ---------------------------------------------------------------------------

export function resolveAiPendingPick(
  state: GameState,
  player: PlayerId,
): boolean {
  const pick = state.pendingPick;
  if (!pick || pick.player !== player) return false;
  const eligible = pick.eligibleIndexes ?? pick.pool.map((_, i) => i);
  const take = Math.min(pick.max, eligible.length);
  const picked = eligible.slice(0, take);
  resolvePendingPick(state, player, picked);
  return true;
}

// ---------------------------------------------------------------------------
// Resolver.
// ---------------------------------------------------------------------------

export function resolvePendingPick(
  state: GameState,
  player: PlayerId,
  pickedIndexes: number[],
): ActionResult {
  const pick = state.pendingPick;
  if (!pick) return fail("No pick pending.");
  if (pick.player !== player) return fail("Not your pick.");

  // Deduplicate + validate.
  const uniq = [...new Set(pickedIndexes)].sort((a, b) => a - b);
  if (uniq.length > pick.max) return fail(`Pick at most ${pick.max}.`);
  if (uniq.length < pick.min) return fail(`Pick at least ${pick.min}.`);
  for (const i of uniq) {
    if (i < 0 || i >= pick.pool.length) return fail("Invalid pick.");
    if (pick.eligibleIndexes && !pick.eligibleIndexes.includes(i)) {
      return fail("Selection not eligible.");
    }
  }

  const picked: Card[] = [];
  const unpicked: Card[] = [];
  for (let i = 0; i < pick.pool.length; i++) {
    if (uniq.includes(i)) picked.push(pick.pool[i]);
    else unpicked.push(pick.pool[i]);
  }

  const pl = state.players[player];
  pl.hand.push(...picked);

  switch (pick.unpicked) {
    case "shuffleIntoDeck":
      pl.deck.push(...unpicked);
      shuffleDeck(state, player);
      break;
    case "bottomOfDeck":
      pl.deck.push(...unpicked);
      break;
    case "returnToDiscard":
      pl.discard.push(...unpicked);
      break;
  }

  if (picked.length) {
    logEvent(state, player, `picks ${picked.map((c) => c.name).join(", ")}.`);
  } else {
    logEvent(state, player, "picks nothing.");
  }

  // Pokémon from the pick go to hand by default. A few effects instead bench
  // them directly (Nest Ball, Buddy-Buddy Poffin, Hop's Bag, Lumiose City).
  // Newly benched Pokémon fire any triggered-on-bench abilities.
  const benchedFromPick: import("./types").PokemonInPlay[] = [];
  if (pick.toBench && picked.length > 0) {
    for (const c of picked) {
      if (c.supertype !== "Pokémon") continue;
      // Cards are moved to hand by the block above; pull them back out.
      const hi = pl.hand.lastIndexOf(c);
      if (hi < 0) continue;
      pl.hand.splice(hi, 1);
      if (pl.bench.length >= 5) {
        // No open slot — the card stays in hand as a pragmatic fallback.
        pl.hand.push(c);
        logEvent(state, player, `${c.name} stays in hand (bench is full).`);
        continue;
      }
      const inPlay = makePokemonInPlay(c);
      inPlay.playedThisTurn = true;
      pl.bench.push(inPlay);
      benchedFromPick.push(inPlay);
      logEvent(state, player, `benches ${c.name}.`);
    }
  }

  const shouldEndTurn = pick.endTurnOnResolve === true;
  state.pendingPick = null;
  state.phase = "main";
  // Fire triggered-on-bench abilities *after* clearing pendingPick so any
  // ability that opens its own pendingPick (e.g. Last-Ditch Catch) takes hold.
  for (const p of benchedFromPick) fireTriggeredOnBench(state, player, p);
  if (shouldEndTurn) endTurnRule(state);
  return ok;
}
