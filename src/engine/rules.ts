import type {
  Card,
  EnergyType,
  GameState,
  Phase,
  PlayerId,
  PlayerState,
  PokemonCard,
  PokemonInPlay,
} from "./types";
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
    playedThisTurn: true,
    evolvedThisTurn: false,
  };
}

export function opponentOf(p: PlayerId): PlayerId {
  return p === "p1" ? "p2" : "p1";
}

export function logEvent(
  state: GameState,
  player: PlayerId | "system",
  text: string,
): void {
  state.log.push({ turn: state.turn, player, text });
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

// Starts a game: shuffle, deal 7, mulligan if no basics, place 6 prizes,
// both players must place an active basic before turn 1.
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

  for (const pl of [p1, p2]) {
    // Mulligan until opening hand has at least one Basic.
    let safety = 20;
    while (safety-- > 0) {
      pl.hand = [];
      pl.deck = rng.shuffle([...pl.deck, ...pl.hand]);
      drawCards(pl, 7);
      if (pl.hand.some(isBasic)) break;
    }
    // Prizes: top 6.
    pl.prizes = pl.deck.splice(0, 6);
  }

  // Auto-place each player's first Basic as active (MVP — skip choose-starter UI).
  for (const pl of [p1, p2]) {
    const idx = pl.hand.findIndex(isBasic);
    if (idx >= 0) {
      const [card] = pl.hand.splice(idx, 1) as [PokemonCard];
      pl.active = makePokemonInPlay(card);
      pl.active.playedThisTurn = false;
    }
  }

  const state: GameState = {
    players: { p1, p2 },
    activePlayer: "p1",
    turn: 1,
    phase: "draw",
    winner: null,
    log: [],
    firstTurnNoAttack: true,
  };
  logEvent(state, "system", "Game start. P1 goes first.");
  // P1 draws for turn 1.
  drawCards(p1, 1);
  state.phase = "main";
  return state;
}

// --- Energy cost matching --------------------------------------------------

export function canPayCost(
  attached: EnergyType[],
  cost: EnergyType[],
): boolean {
  const pool = attached.slice();
  // First match specific-type costs, then Colorless can be paid by anything.
  const specific = cost.filter((c) => c !== "Colorless");
  const colorless = cost.length - specific.length;
  for (const need of specific) {
    const i = pool.indexOf(need);
    if (i === -1) return false;
    pool.splice(i, 1);
  }
  return pool.length >= colorless;
}

export const energyProvidedBy = (p: PokemonInPlay): EnergyType[] =>
  p.attachedEnergy.flatMap((e) => e.provides);

// --- Damage / KO / win -----------------------------------------------------

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
  if (target.damage >= target.card.hp) knockOut(state, defenderOwner);
}

export function knockOut(state: GameState, ownerId: PlayerId): void {
  const owner = state.players[ownerId];
  if (!owner.active) return;
  const ko = owner.active;
  logEvent(state, "system", `${ko.card.name} is Knocked Out!`);
  // Move active + evolution stack + attached energy to discard.
  owner.discard.push(ko.card, ...ko.evolvedFrom, ...ko.attachedEnergy);
  owner.active = null;

  // Opponent takes a prize.
  const opp = state.players[opponentOf(ownerId)];
  const prize = opp.prizes.shift();
  if (prize) {
    opp.hand.push(prize);
    logEvent(state, opp.id, `takes a Prize (${prize.name}).`);
  }

  // Win by prizes.
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
    logEvent(state, "system", `${owner.name} has no Pokémon left. ${opp.name} wins.`);
    return;
  }
  // Auto-promote first benched (MVP; UI can add a chooser later).
  owner.active = owner.bench.shift()!;
  owner.active.playedThisTurn = false;
  logEvent(state, owner.id, `promotes ${owner.active.card.name} to Active.`);
}

// Win-by-deckout: if active player can't draw at start of turn, they lose.
export function startTurnDraw(state: GameState): void {
  const p = state.players[state.activePlayer];
  const drawn = drawCards(p, 1);
  if (drawn === 0) {
    const winner = opponentOf(state.activePlayer);
    state.winner = winner;
    state.phase = "gameOver";
    logEvent(state, "system", `${p.name} cannot draw. ${state.players[winner].name} wins.`);
  }
}

export function endTurn(state: GameState): void {
  if (state.phase === "gameOver") return;
  const prev = state.players[state.activePlayer];
  prev.energyAttachedThisTurn = false;
  prev.supporterPlayedThisTurn = false;
  for (const p of [prev.active, ...prev.bench]) {
    if (p) {
      p.playedThisTurn = false;
      p.evolvedThisTurn = false;
    }
  }
  state.firstTurnNoAttack = false;
  state.activePlayer = opponentOf(state.activePlayer);
  state.turn += 1;
  state.phase = "draw";
  logEvent(state, "system", `Turn ${state.turn} — ${state.players[state.activePlayer].name}'s turn.`);
  startTurnDraw(state);
  // startTurnDraw may set phase to gameOver on deck-out; otherwise advance to main.
  if ((state.phase as Phase) !== "gameOver") state.phase = "main";
}
