// Once-per-turn activated Stadium effects. Unlike the passive Stadium
// modifiers in ongoingEffects.ts (which apply automatically to damage /
// retreat cost / HP), these require the player to *press* the Stadium to
// take its action on their turn.

import { fireTriggeredOnMoveToActive, fireTriggeredOnMoveToBench } from "./abilities";
import { endTurn, logEvent } from "./rules";
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
    precheck: (state, player) => {
      if (state.players[player].bench.length >= 5) return "Your bench is full.";
      // Card text: "If a player searches their deck in this way, their turn
      // ends." This is a real cost — caller must accept that activating it
      // ends their turn.
      return null;
    },
    run: (state, player) => {
      // Search deck for a Basic Pokémon and put it onto the Bench.
      const isBasicPokemon = (c: Card): c is PokemonCard =>
        c.supertype === "Pokémon" && c.subtypes.includes("Basic");
      const opened = setDeckSearchPick(
        state,
        player,
        isBasicPokemon,
        1,
        "Lumiose City: pick a Basic Pokémon to bench (your turn will end)",
        { toBench: true },
      );
      if (opened && state.pendingPick) {
        // "Your turn ends after putting the Pokémon onto your Bench." Flag
        // the pick so resolvePendingPick runs endTurn when done.
        state.pendingPick.endTurnOnResolve = true;
      } else {
        // No Basic in deck — per the card's "if a player searches their
        // deck" clause, the search still happened (just yielded nothing) so
        // the turn still ends.
        logEvent(state, player, "Lumiose City: no Basic Pokémon in deck — turn ends anyway.");
        endTurn(state);
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
      // Need at least one Basic Pokémon in play that's eligible to evolve
      // (not played-this-turn) AND a matching Stage 1 in deck.
      const pl = state.players[player];
      const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
      const eligibleBasics = allies.filter(
        (p) => p.card.subtypes.includes("Basic") && !p.playedThisTurn && !p.evolvedThisTurn,
      );
      if (eligibleBasics.length === 0) return "No eligible Basic Pokémon in play.";
      if (state.turn === 1) return "Grand Tree can't evolve a Basic on your first turn.";
      const hasStage1Match = pl.deck.some(
        (c) =>
          c.supertype === "Pokémon" &&
          c.subtypes.includes("Stage 1") &&
          eligibleBasics.some((p) => p.card.name === c.evolvesFrom),
      );
      if (!hasStage1Match) return "No matching Stage 1 evolution in deck.";
      return null;
    },
    run: (state, player) => {
      // Real card text:
      // "search your deck for a Stage 1 Pokémon that evolves from 1 of your
      //  Basic Pokémon and put it onto that Pokémon to evolve it. If that
      //  Pokémon was evolved in this way, you may search your deck for a
      //  Stage 2 Pokémon that evolves from that Pokémon and put it onto
      //  that Pokémon to evolve it."
      // Implementation auto-picks the first eligible Basic + matching Stage 1
      // (interactive picker would be a multi-step pendingInPlayTarget — kept
      // out of scope for this pass).
      const pl = state.players[player];
      const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
      const eligibleBasics = allies.filter(
        (p) => p.card.subtypes.includes("Basic") && !p.playedThisTurn && !p.evolvedThisTurn,
      );
      // Stage 1 search.
      let evolved: PokemonInPlay | null = null;
      for (const basic of eligibleBasics) {
        const idx = pl.deck.findIndex(
          (c) =>
            c.supertype === "Pokémon" &&
            c.subtypes.includes("Stage 1") &&
            c.evolvesFrom === basic.card.name,
        );
        if (idx >= 0) {
          const [s1] = pl.deck.splice(idx, 1) as [PokemonCard];
          basic.evolvedFrom.push(basic.card);
          basic.card = s1;
          basic.evolvedThisTurn = true;
          basic.abilityUsedThisTurn = false;
          evolved = basic;
          logEvent(state, player, `Grand Tree: evolves into ${s1.name}.`);
          break;
        }
      }
      if (!evolved) {
        logEvent(state, player, "Grand Tree: no Stage 1 found.");
        // Still shuffle deck per "Then, that player shuffles their deck."
        const arr = pl.deck;
        for (let i = arr.length - 1; i > 0; i--) {
          const j = state.rng.int(i + 1);
          [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return;
      }
      // Stage 2 search — only if the just-evolved Stage 1 has a matching
      // Stage 2 in deck. Auto-applies the second evolution.
      const s2idx = pl.deck.findIndex(
        (c) =>
          c.supertype === "Pokémon" &&
          c.subtypes.includes("Stage 2") &&
          c.evolvesFrom === evolved!.card.name,
      );
      if (s2idx >= 0) {
        const [s2] = pl.deck.splice(s2idx, 1) as [PokemonCard];
        evolved.evolvedFrom.push(evolved.card);
        evolved.card = s2;
        // Stage 1 → Stage 2 in the same activation; per rule we keep
        // evolvedThisTurn true.
        logEvent(state, player, `Grand Tree: evolves into ${s2.name}.`);
      }
      // Shuffle deck after.
      const arr = pl.deck;
      for (let i = arr.length - 1; i > 0; i--) {
        const j = state.rng.int(i + 1);
        [arr[i], arr[j]] = [arr[j], arr[i]];
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
      // Switch rule: outgoing Pokémon recovers from all Special Conditions.
      outgoing.statuses = [];
      pl.active = incoming;
      pl.bench.push(outgoing);
      logEvent(
        state,
        player,
        `Surfing Beach: switches ${outgoing.card.name} → ${incoming.card.name}.`,
      );
      fireTriggeredOnMoveToActive(state, player, incoming);
      fireTriggeredOnMoveToBench(state, player, outgoing);
    },
  },

  "Team Rocket's Factory": {
    precheck: (state, player) => {
      const last = state.players[player].lastSupporterNameThisTurn;
      if (!last) return "Need to have played a Supporter this turn.";
      if (!last.includes("Team Rocket")) {
        return `Last Supporter "${last}" wasn't a Team Rocket one.`;
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
