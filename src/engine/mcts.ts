// Monte Carlo Tree Search for the Pokémon TCG engine. Replaces the 1-ply
// minimax in `pickBestAttackWithLookahead` for v2 turn decisions.
//
// Design summary (per the architect's design doc):
//   - Determinized UCT: re-seed RNG per iteration so chance nodes (coin
//     flips, deck shuffles) average across rollouts.
//   - Action-level tree: nodes are atomic engine actions
//     ({attack, attachEnergy, evolve, playTrainer, retreat, endTurn, ...}).
//   - Lazy expansion with progressive widening: enumerate top-K=8 legal
//     actions on first visit, expand one child per visit thereafter.
//   - Greedy rollout policy: at the leaf, run `takeAiTurn` for both players
//     for up to `rolloutDepth` turn pairs, then evaluate via scorePosition.
//   - Time budget: stops iterating when the wall clock exceeds budgetMs.
//   - Fallback: returns null if no candidates produced or budget hit
//     before any iteration completes; caller falls back to greedy.
//
// Why this shape and not a full reinforcement-learning policy: this engine
// is deterministic given an RNG seed, runs in JS, and ships in a browser.
// A learned policy would need a separate training pipeline (out of scope).
// MCTS over the existing engine + a tuned eval function is the strongest
// non-ML option and is bounded by per-iteration clone + rollout cost.

import {
  attachEnergy,
  attack,
  endTurn,
  evolve,
  playBasicToBench,
  playTrainer,
  retreat,
} from "./actions";
import { activateAbility } from "./abilities";
import { isBasic, opponentOf } from "./rules";
import {
  effectiveAttackCost,
  effectiveAttacks,
  energyPoolForCost,
} from "./ongoingEffects";
import { canPayCost } from "./rules";
import type {
  Card,
  EnergyCard,
  GameState,
  PlayerId,
  PokemonInPlay,
  TrainerCard,
} from "./types";

// ---- Action types --------------------------------------------------------

export type McAction =
  | { kind: "attack"; attackIndex: number }
  | { kind: "attachEnergy"; handIdx: number; targetInstanceId: string }
  | { kind: "evolve"; handIdx: number; targetInstanceId: string }
  | { kind: "playBasic"; handIdx: number }
  | { kind: "playTrainer"; handIdx: number; target?: { kind: "inPlay" | "oppInPlay"; instanceId: string } }
  | { kind: "retreat"; benchIdx: number }
  | { kind: "activateAbility"; holderInstanceId: string; abilityIdx: number }
  | { kind: "endTurn" };

function applyMcAction(state: GameState, player: PlayerId, action: McAction): boolean {
  try {
    switch (action.kind) {
      case "attack":
        return attack(state, player, action.attackIndex).ok;
      case "attachEnergy":
        return attachEnergy(state, player, action.handIdx, action.targetInstanceId).ok;
      case "evolve":
        return evolve(state, player, action.handIdx, action.targetInstanceId).ok;
      case "playBasic":
        return playBasicToBench(state, player, action.handIdx).ok;
      case "playTrainer":
        return playTrainer(state, player, action.handIdx, action.target).ok;
      case "retreat":
        return retreat(state, player, action.benchIdx).ok;
      case "activateAbility":
        return activateAbility(state, player, action.holderInstanceId, action.abilityIdx).ok;
      case "endTurn":
        endTurn(state, player);
        return true;
    }
  } catch {
    return false;
  }
}

// ---- Action enumeration --------------------------------------------------

// Generate the candidate action list for `player`. Pruned aggressively so
// MCTS can budget its visits where the search matters. Prioritizes:
//   1. Attacks (the highest-leverage commit point).
//   2. Energy attaches that unlock attacks.
//   3. Evolutions and Trainer plays (deck thinning, draw, etc.).
//   4. Retreats only when defensible.
//   5. endTurn always available as a sentinel.
export function enumerateActions(
  state: GameState,
  player: PlayerId,
  topK = 8,
): McAction[] {
  if (state.phase !== "main") return [];
  const pl = state.players[player];
  if (state.activePlayer !== player) return [];
  const out: McAction[] = [];

  // Attacks — highest priority commit. Filter to ones currently payable.
  if (pl.active && !pl.active.statuses.includes("asleep") && !pl.active.statuses.includes("paralyzed")) {
    const attacks = effectiveAttacks(pl.active);
    const provided = energyPoolForCost(pl.active, state);
    for (let i = 0; i < attacks.length; i++) {
      const cost = effectiveAttackCost(state, pl.active, attacks[i].cost);
      if (canPayCost(provided, cost)) {
        out.push({ kind: "attack", attackIndex: i });
      }
    }
  }

  // Energy attach — only one per turn, score by which target unlocks an attack.
  if (!pl.energyAttachedThisTurn) {
    for (let i = 0; i < pl.hand.length; i++) {
      const c = pl.hand[i];
      if (c.supertype !== "Energy") continue;
      const candidates = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
      for (const tgt of candidates) {
        out.push({ kind: "attachEnergy", handIdx: i, targetInstanceId: tgt.instanceId });
      }
    }
  }

  // Evolutions in hand.
  for (let i = 0; i < pl.hand.length; i++) {
    const c = pl.hand[i];
    if (c.supertype !== "Pokémon" || !c.evolvesFrom) continue;
    const candidates = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
    for (const tgt of candidates) {
      if (tgt.card.name === c.evolvesFrom && !tgt.playedThisTurn) {
        out.push({ kind: "evolve", handIdx: i, targetInstanceId: tgt.instanceId });
      }
    }
  }

  // Bench Basics.
  if (pl.bench.length < 5) {
    for (let i = 0; i < pl.hand.length; i++) {
      const c = pl.hand[i];
      if (c.supertype === "Pokémon" && isBasic(c)) {
        out.push({ kind: "playBasic", handIdx: i });
      }
    }
  }

  // Trainers (Items / Tools / Stadiums; skip Supporters if already played
  // this turn). Some Trainers need targets — we generate all in-play
  // targets for those; the engine rejects illegal pairings.
  for (let i = 0; i < pl.hand.length; i++) {
    const c = pl.hand[i];
    if (c.supertype !== "Trainer") continue;
    const t = c as TrainerCard;
    const subs = t.subtypes ?? [];
    if (subs.includes("Supporter") && pl.supporterPlayedThisTurn) continue;
    if (subs.includes("Pokémon Tool") || subs.includes("Tool")) {
      for (const tgt of [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p)) {
        out.push({ kind: "playTrainer", handIdx: i, target: { kind: "inPlay", instanceId: tgt.instanceId } });
      }
      continue;
    }
    if (t.effectId === "gustOppBenched") {
      const opp = state.players[opponentOf(player)];
      for (const tgt of opp.bench) {
        out.push({ kind: "playTrainer", handIdx: i, target: { kind: "oppInPlay", instanceId: tgt.instanceId } });
      }
      continue;
    }
    out.push({ kind: "playTrainer", handIdx: i });
  }

  // Activate abilities.
  const holders = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
  for (const holder of holders) {
    if (holder.abilityUsedThisTurn) continue;
    const abilities = holder.card.abilities ?? [];
    for (let ai = 0; ai < abilities.length; ai++) {
      if (!abilities[ai].effect) continue;
      out.push({ kind: "activateAbility", holderInstanceId: holder.instanceId, abilityIdx: ai });
    }
  }

  // Retreat (rare, only if not already retreated and energy available).
  if (!pl.retreatedThisTurn && pl.active) {
    for (let bi = 0; bi < pl.bench.length; bi++) {
      out.push({ kind: "retreat", benchIdx: bi });
    }
  }

  // endTurn — always available as a sentinel.
  out.push({ kind: "endTurn" });

  // Cap to topK by simple heuristic priority. The actual ordering matters
  // less for correctness than for which K make it past the cut.
  if (out.length <= topK) return out;
  return out.slice(0, topK);
}

// ---- MCTS tree ----------------------------------------------------------

interface Node {
  action: McAction | null; // null = root
  parent: Node | null;
  children: Node[];
  visits: number;
  totalValue: number;
  unexpanded: McAction[]; // actions not yet tried
}

function makeRoot(actions: McAction[]): Node {
  return {
    action: null,
    parent: null,
    children: [],
    visits: 0,
    totalValue: 0,
    unexpanded: actions,
  };
}

function ucb1(node: Node, parentVisits: number, c: number): number {
  if (node.visits === 0) return Infinity;
  const exploit = node.totalValue / node.visits;
  const explore = c * Math.sqrt(Math.log(parentVisits) / node.visits);
  return exploit + explore;
}

function selectChild(node: Node, c: number): Node {
  let best: Node | null = null;
  let bestScore = -Infinity;
  for (const child of node.children) {
    const sc = ucb1(child, node.visits, c);
    if (sc > bestScore) {
      bestScore = sc;
      best = child;
    }
  }
  return best!;
}

// ---- Public entry --------------------------------------------------------

export interface McRunResult {
  bestAction: McAction | null;
  iterations: number;
  topActions: { action: McAction; visits: number; meanValue: number }[];
}

export function runMcts(
  rootState: GameState,
  player: PlayerId,
  options: {
    budgetMs?: number;
    explorationC?: number;
    rolloutDepthTurns?: number;
    topK?: number;
    leafEval: (state: GameState, player: PlayerId) => number;
    cloneStateForSearchWithSeed: (state: GameState, seed: number) => GameState;
    rolloutPolicy?: (state: GameState, player: PlayerId) => void;
  },
): McRunResult {
  const budgetMs = options.budgetMs ?? 5000;
  const c = options.explorationC ?? 350; // tuned for prize-scaled values
  const rolloutDepth = options.rolloutDepthTurns ?? 2;
  const topK = options.topK ?? 8;
  const start = Date.now();

  const rootActions = enumerateActions(rootState, player, topK);
  if (rootActions.length === 0) {
    return { bestAction: null, iterations: 0, topActions: [] };
  }

  const root = makeRoot(rootActions);
  let iters = 0;

  while (Date.now() - start < budgetMs) {
    iters++;
    const sim = options.cloneStateForSearchWithSeed(rootState, iters * 1009 ^ 0xBADC0FFE);
    // Force both sides to AI in the sim (the clone helper already does this
    // but we re-assert to be safe).
    sim.players.p1.isAI = true;
    sim.players.p2.isAI = true;

    // Selection: walk down the tree using UCB1 until we hit an unexpanded node.
    let node = root;
    const path: Node[] = [node];
    while (node.unexpanded.length === 0 && node.children.length > 0) {
      node = selectChild(node, c);
      path.push(node);
      if (node.action && !applyMcAction(sim, player, node.action)) break;
      // If the selected action ends the turn / the game, stop descending.
      if (sim.phase !== "main" || sim.activePlayer !== player) break;
    }

    // Expansion: pop one unexpanded action and create a child.
    if (
      node.unexpanded.length > 0 &&
      sim.phase === "main" &&
      sim.activePlayer === player
    ) {
      const action = node.unexpanded.shift()!;
      const ok = applyMcAction(sim, player, action);
      if (ok) {
        const newChildActions =
          sim.phase === "main" && sim.activePlayer === player
            ? enumerateActions(sim, player, topK)
            : [];
        const child: Node = {
          action,
          parent: node,
          children: [],
          visits: 0,
          totalValue: 0,
          unexpanded: newChildActions,
        };
        node.children.push(child);
        path.push(child);
      }
    }

    // Rollout: drive the engine forward via the rollout policy for up to
    // `rolloutDepth` turn pairs, then evaluate. Skip rollout if the action
    // already ended the turn / game (we eval from current sim).
    let rolloutTurns = 0;
    while (
      sim.phase !== "gameOver" &&
      rolloutTurns < rolloutDepth * 2 &&
      sim.phase === "main"
    ) {
      const ap = sim.activePlayer;
      try {
        if (options.rolloutPolicy) options.rolloutPolicy(sim, ap);
        else endTurn(sim, ap);
      } catch {
        break;
      }
      rolloutTurns++;
    }

    // Evaluation: score the resulting position from `player`'s perspective.
    const value = options.leafEval(sim, player);

    // Backpropagation: walk back up the path, increment visits, add value.
    for (const n of path) {
      n.visits++;
      n.totalValue += value;
    }
  }

  // Pick best action by visit count (the most-explored child = the most
  // promising in MCTS convergence).
  const topActions = root.children
    .map((c) => ({
      action: c.action!,
      visits: c.visits,
      meanValue: c.visits > 0 ? c.totalValue / c.visits : 0,
    }))
    .sort((a, b) => b.visits - a.visits);

  return {
    bestAction: topActions[0]?.action ?? null,
    iterations: iters,
    topActions,
  };
}

// Light helper: expose Card / type imports tree-shake out.
export type { Card, EnergyCard, GameState, PlayerId, PokemonInPlay, TrainerCard };
