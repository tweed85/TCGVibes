// Once-per-turn activated Stadium effects. Unlike the passive Stadium
// modifiers in ongoingEffects.ts (which apply automatically to damage /
// retreat cost / HP), these require the player to *press* the Stadium to
// take its action on their turn.

import { logEvent } from "./rules";
import { setDeckSearchPick } from "./pendingPick";
import type {
  Card,
  GameState,
  PlayerId,
  PokemonCard,
  PokemonInPlay,
} from "./types";

export type ActivateResult =
  | { ok: true }
  | { ok: false; reason: string };

// Which Stadiums expose an activated effect? Used by the UI to decide
// whether to show the "Use Stadium" button.
export function stadiumHasActivatedEffect(name: string | undefined): boolean {
  if (!name) return false;
  return Object.prototype.hasOwnProperty.call(STADIUM_EFFECTS, name);
}

interface StadiumEffect {
  // Returns null if the player can use the effect right now, or a reason string.
  precheck: (state: GameState, player: PlayerId) => string | null;
  // Mutates state to apply the effect.
  run: (state: GameState, player: PlayerId) => void;
}

const STADIUM_EFFECTS: Record<string, StadiumEffect> = {
  "Academy at Night": {
    precheck: (state, player) => {
      if (state.players[player].hand.length === 0) return "Hand is empty.";
      return null;
    },
    run: (state, player) => {
      // Put a card from hand on top of deck. Auto-pick the first — real use
      // would want a picker, but this keeps scope tight.
      const pl = state.players[player];
      const [c] = pl.hand.splice(0, 1);
      pl.deck.unshift(c);
      logEvent(state, player, `Academy at Night: places ${c.name} on top of deck.`);
    },
  },

  "Community Center": {
    precheck: (state, player) => {
      if (!state.players[player].supporterPlayedThisTurn) {
        return "Need to have played a Supporter this turn.";
      }
      return null;
    },
    run: (state, player) => {
      // Heal 10 from each of the activating player's Pokémon (not opponent).
      const pl = state.players[player];
      for (const p of [pl.active, ...pl.bench]) {
        if (p && p.damage > 0) p.damage = Math.max(0, p.damage - 10);
      }
      logEvent(state, player, `Community Center: heals 10 from each of their Pokémon.`);
    },
  },

  "Levincia": {
    precheck: () => null,
    run: (state, player) => {
      // Put up to 2 Basic Lightning Energy from discard into hand.
      const pl = state.players[player];
      const kept: Card[] = [];
      const pulled: Card[] = [];
      for (const c of pl.discard) {
        if (
          pulled.length < 2 &&
          c.supertype === "Energy" &&
          c.subtypes.includes("Basic") &&
          c.provides.includes("Lightning")
        ) {
          pulled.push(c);
        } else {
          kept.push(c);
        }
      }
      pl.discard = kept;
      pl.hand.push(...pulled);
      logEvent(
        state,
        player,
        pulled.length
          ? `Levincia: recovers ${pulled.length} basic Lightning Energy.`
          : "Levincia: no basic Lightning Energy in discard.",
      );
    },
  },

  "Lumiose City": {
    precheck: () => null,
    run: (state, player) => {
      // Search deck for a Basic Pokémon and put it onto the Bench.
      const isBasicPokemon = (c: Card): c is PokemonCard =>
        c.supertype === "Pokémon" && c.subtypes.includes("Basic");
      const pl = state.players[player];
      if (pl.bench.length >= 5) {
        logEvent(state, player, "Lumiose City: bench is full.");
        return;
      }
      const opened = setDeckSearchPick(
        state,
        player,
        isBasicPokemon,
        1,
        "Lumiose City: pick a Basic Pokémon to bench (your turn will end)",
        { toBench: true },
      );
      if (opened && state.pendingPick) {
        // Lumiose City: "Your turn ends after putting the Pokémon onto your
        // Bench." Flag the pick so resolvePendingPick runs endTurn when done.
        state.pendingPick.endTurnOnResolve = true;
      } else if (!opened) {
        logEvent(state, player, "Lumiose City: no Basic Pokémon in deck.");
      }
    },
  },

  "Mystery Garden": {
    precheck: (state, player) => {
      const hasEnergy = state.players[player].hand.some(
        (c) => c.supertype === "Energy",
      );
      if (!hasEnergy) return "Need an Energy card in hand.";
      return null;
    },
    run: (state, player) => {
      const pl = state.players[player];
      // Discard an Energy from hand.
      const idx = pl.hand.findIndex((c) => c.supertype === "Energy");
      if (idx < 0) return;
      const [e] = pl.hand.splice(idx, 1);
      pl.discard.push(e);
      // Draw until hand size == # Psychic Pokémon you have in play.
      const allies = [pl.active, ...pl.bench].filter(
        (p): p is PokemonInPlay => !!p,
      );
      const psychicCount = allies.filter((p) =>
        p.card.types.includes("Psychic"),
      ).length;
      let drawn = 0;
      while (pl.hand.length < psychicCount) {
        const c = pl.deck.shift();
        if (!c) break;
        pl.hand.push(c);
        drawn++;
      }
      logEvent(
        state,
        player,
        `Mystery Garden: discards ${e.name}, draws ${drawn} card(s).`,
      );
    },
  },

  "Grand Tree": {
    precheck: (state, player) => {
      if (state.players[player].bench.length === 0 && !state.players[player].active) {
        return "No Basic Pokémon in play.";
      }
      return null;
    },
    run: (state, player) => {
      // Search deck for a Stage 1 or Stage 2 Pokémon that can eventually land
      // on one of your in-play Pokémon. The evolution itself is not auto-
      // applied — the chosen card goes to hand and the player evolves normally.
      const pl = state.players[player];
      const basicNames = new Set<string>();
      const stage1Names = new Set<string>();
      for (const p of [pl.active, ...pl.bench]) {
        if (!p) continue;
        if (p.card.subtypes.includes("Basic")) basicNames.add(p.card.name);
        if (p.card.subtypes.includes("Stage 1")) stage1Names.add(p.card.name);
      }
      const pred = (c: Card): c is PokemonCard => {
        if (c.supertype !== "Pokémon" || !c.evolvesFrom) return false;
        if (c.subtypes.includes("Stage 1")) return basicNames.has(c.evolvesFrom);
        if (c.subtypes.includes("Stage 2")) {
          return stage1Names.has(c.evolvesFrom) ||
                 // Also allow if the Basic → Stage1 → Stage 2 chain exists in play.
                 basicNames.has(c.evolvesFrom);
        }
        return false;
      };
      if (
        !setDeckSearchPick(state, player, pred, 1, "Grand Tree: pick a Stage 1 or Stage 2 Pokémon")
      ) {
        logEvent(state, player, "Grand Tree: no matching evolution in deck.");
      }
    },
  },

  "Spikemuth Gym": {
    precheck: () => null,
    run: (state, player) => {
      const pred = (c: Card): c is PokemonCard =>
        c.supertype === "Pokémon" && c.name.startsWith("Marnie's ");
      if (
        !setDeckSearchPick(
          state,
          player,
          pred,
          1,
          "Spikemuth Gym: pick a Marnie's Pokémon",
        )
      ) {
        logEvent(state, player, "Spikemuth Gym: no Marnie's Pokémon in deck.");
      }
    },
  },

  "Surfing Beach": {
    precheck: (state, player) => {
      const pl = state.players[player];
      if (!pl.active) return "No Active Pokémon.";
      if (!pl.active.card.types.includes("Water"))
        return "Active must be Water-type.";
      if (!pl.bench.some((p) => p.card.types.includes("Water")))
        return "Need a benched Water Pokémon.";
      return null;
    },
    run: (state, player) => {
      const pl = state.players[player];
      if (!pl.active) return;
      const benchIdx = pl.bench.findIndex((p) =>
        p.card.types.includes("Water"),
      );
      if (benchIdx < 0) return;
      const incoming = pl.bench.splice(benchIdx, 1)[0];
      const outgoing = pl.active;
      pl.active = incoming;
      pl.bench.push(outgoing);
      logEvent(
        state,
        player,
        `Surfing Beach: switches ${outgoing.card.name} → ${incoming.card.name}.`,
      );
    },
  },

  "Team Rocket's Factory": {
    precheck: (state, player) => {
      if (!state.players[player].supporterPlayedThisTurn)
        return "Need to have played a Supporter this turn.";
      // Additional check: it must have been a Team Rocket Supporter. We don't
      // currently track *which* Supporter, so we approximate by checking the
      // discard for a recent Team Rocket Supporter. Close enough for MVP.
      const disc = state.players[player].discard;
      const recent = disc[disc.length - 1];
      if (
        !recent ||
        recent.supertype !== "Trainer" ||
        !recent.subtypes.includes("Supporter") ||
        !recent.name.includes("Team Rocket")
      ) {
        return "Last Supporter played wasn't a Team Rocket one.";
      }
      return null;
    },
    run: (state, player) => {
      const pl = state.players[player];
      let drawn = 0;
      for (let i = 0; i < 2; i++) {
        const c = pl.deck.shift();
        if (!c) break;
        pl.hand.push(c);
        drawn++;
      }
      logEvent(state, player, `Team Rocket's Factory: draws ${drawn}.`);
    },
  },
};

// Activate the current Stadium's effect for `player`. Enforces once-per-turn
// and the stadium's specific precheck.
export function useStadium(
  state: GameState,
  player: PlayerId,
): ActivateResult {
  if (state.phase !== "main") {
    return { ok: false, reason: "Not in main phase." };
  }
  if (state.activePlayer !== player) {
    return { ok: false, reason: "Not your turn." };
  }
  if (!state.stadium) {
    return { ok: false, reason: "No Stadium in play." };
  }
  const pl = state.players[player];
  if (pl.stadiumUsedThisTurn) {
    return { ok: false, reason: "Stadium already used this turn." };
  }
  const effect = STADIUM_EFFECTS[state.stadium.card.name];
  if (!effect) {
    return { ok: false, reason: "This Stadium has no activated effect." };
  }
  const block = effect.precheck(state, player);
  if (block) return { ok: false, reason: block };
  effect.run(state, player);
  pl.stadiumUsedThisTurn = true;
  return { ok: true };
}
