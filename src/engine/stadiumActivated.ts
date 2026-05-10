// Once-per-turn activated Stadium effects. Unlike the passive Stadium
// modifiers in ongoingEffects.ts (which apply automatically to damage /
// retreat cost / HP), these require the player to *press* the Stadium to
// take its action on their turn.

import { fireTriggeredOnMoveToActive, fireTriggeredOnMoveToBench } from "./abilities";
import { endTurn, isPlayersFirstTurn, logEvent } from "./rules";
import { setDeckSearchPick, setDiscardRecoveryPick } from "./pendingPick";
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
      const pl = state.players[player];
      // AI: keep auto-pick of the first hand card.
      if (pl.isAI) {
        const [c] = pl.hand.splice(0, 1);
        pl.deck.unshift(c);
        logEvent(state, player, `Academy at Night: places ${c.name} on top of deck.`);
        return;
      }
      // Human: open a hand picker; resolver routes the chosen card to deck top.
      state.pendingHandReveal = {
        player,
        target: player,
        label: "Academy at Night: pick a card from your hand to put on top of your deck",
        min: 1,
        max: 1,
        filter: "any",
        action: "toTopOfDeck",
      };
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
      const pl = state.players[player];
      const isBasicLightning = (c: Card) =>
        c.supertype === "Energy" &&
        c.subtypes.includes("Basic") &&
        c.provides.includes("Lightning");

      // AI: keep the existing greedy auto-pull of up to 2.
      if (pl.isAI) {
        const kept: Card[] = [];
        const pulled: Card[] = [];
        for (const c of pl.discard) {
          if (pulled.length < 2 && isBasicLightning(c)) pulled.push(c);
          else kept.push(c);
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
        return;
      }

      // Human: open a discard-recovery picker (up to 2).
      if (!setDiscardRecoveryPick(
        state, player, isBasicLightning, 2,
        "Levincia: pick up to 2 Basic Lightning Energy from your discard pile",
      )) {
        logEvent(state, player, "Levincia: no basic Lightning Energy in discard.");
      }
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
      // Psychic-Pokémon-in-play count drives the eventual hand-size target.
      const allies = [pl.active, ...pl.bench].filter(
        (p): p is PokemonInPlay => !!p,
      );
      const psychicCount = allies.filter((p) =>
        p.card.types.includes("Psychic"),
      ).length;

      // AI: keep the existing first-Energy auto-discard + drawUntilHand.
      if (pl.isAI) {
        const idx = pl.hand.findIndex((c) => c.supertype === "Energy");
        if (idx < 0) return;
        const [e] = pl.hand.splice(idx, 1);
        pl.discard.push(e);
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
        return;
      }

      // Human: open a hand picker for the Energy to discard. The resolver
      // discards the picked card BEFORE applying drawUntilHand, so the
      // draw count is computed against the post-discard hand size.
      state.pendingHandReveal = {
        player,
        target: player,
        label: "Mystery Garden: pick an Energy from your hand to discard",
        min: 1,
        max: 1,
        filter: "energy",
        action: "discard",
        postAction: { kind: "drawUntilHand", targetSize: psychicCount },
      };
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
      // Per-player first-turn gate (matches every other "no evolution on
      // your first turn" check in the engine).
      if (isPlayersFirstTurn(state, player)) {
        return "Grand Tree can't evolve a Basic on your first turn.";
      }
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
      const pl = state.players[player];
      const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
      const eligibleBasics = allies.filter(
        (p) =>
          p.card.subtypes.includes("Basic") &&
          !p.playedThisTurn &&
          !p.evolvedThisTurn &&
          pl.deck.some(
            (c) =>
              c.supertype === "Pokémon" &&
              c.subtypes.includes("Stage 1") &&
              c.evolvesFrom === p.card.name,
          ),
      );
      if (eligibleBasics.length === 0) return;

      // AI or single eligible Basic: keep auto-pick. Same shape as the
      // previous greedy resolve — Stage 1 then optional Stage 2, with a
      // final shuffle.
      if (pl.isAI || eligibleBasics.length === 1) {
        const basic = eligibleBasics[0];
        const idx = pl.deck.findIndex(
          (c) =>
            c.supertype === "Pokémon" &&
            c.subtypes.includes("Stage 1") &&
            c.evolvesFrom === basic.card.name,
        );
        if (idx < 0) return;
        const [s1] = pl.deck.splice(idx, 1) as [PokemonCard];
        basic.evolvedFrom.push(basic.card);
        basic.card = s1;
        basic.evolvedThisTurn = true;
        basic.abilityUsedThisTurn = false;
        logEvent(state, player, `Grand Tree: evolves into ${s1.name}.`);
        const s2idx = pl.deck.findIndex(
          (c) =>
            c.supertype === "Pokémon" &&
            c.subtypes.includes("Stage 2") &&
            c.evolvesFrom === basic.card.name,
        );
        if (s2idx >= 0) {
          const [s2] = pl.deck.splice(s2idx, 1) as [PokemonCard];
          basic.evolvedFrom.push(basic.card);
          basic.card = s2;
          logEvent(state, player, `Grand Tree: evolves into ${s2.name}.`);
        }
        // Shuffle per "Then, that player shuffles their deck."
        const arr = pl.deck;
        for (let i = arr.length - 1; i > 0; i--) {
          const j = state.rng.int(i + 1);
          [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return;
      }

      // Human with multiple eligible Basics: open the chained picker.
      // Step 1 captures which Basic. Step 2 (deck search for Stage 1) is
      // opened by resolveInPlayTarget's "grandTreeBasicTarget" handler,
      // which also queues the optional Stage 2 chain step.
      state.pendingInPlayTarget = {
        player,
        label: "Grand Tree: pick a Basic Pokémon in play to evolve",
        scope: "own",
        slot: "anywhere",
        filter: "isBasic",
        action: { kind: "grandTreeBasicTarget" },
      };
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
      const waterBench = pl.bench
        .map((p, idx) => ({ p, idx }))
        .filter((b) => b.p.card.types.includes("Water"));
      if (waterBench.length === 0) return;

      // Single Water bench OR AI: short-circuit to the first match.
      if (pl.isAI || waterBench.length === 1) {
        const { idx } = waterBench[0];
        const incoming = pl.bench.splice(idx, 1)[0];
        const outgoing = pl.active;
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
        return;
      }

      // Human with multiple Water bench: open a picker. The Water-type
      // narrowing happens inside the surfingBeachSwitch action handler.
      state.pendingInPlayTarget = {
        player,
        label: "Surfing Beach: pick a Benched Water Pokémon to switch into the Active spot",
        scope: "own",
        slot: "bench",
        filter: "anyPokemon",
        action: { kind: "surfingBeachSwitch" },
      };
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

  // me4 Prism Tower — once per turn, each player may discard 2 cards from
  // their hand to draw 1.
  "Prism Tower": {
    precheck: (state, player) => {
      const pl = state.players[player];
      if (pl.hand.length < 2) return "Need 2 cards in hand to discard.";
      if (pl.deck.length === 0) return "Deck is empty.";
      return null;
    },
    run: (state, player) => {
      const pl = state.players[player];
      // AI: keep the existing first-2 auto-discard.
      if (pl.isAI) {
        const [a, b] = pl.hand.splice(0, 2);
        pl.discard.push(a, b);
        const drawn = pl.deck.shift();
        if (drawn) pl.hand.push(drawn);
        logEvent(state, player, `Prism Tower: discards 2, draws 1.`);
        return;
      }
      // Human: open a hand picker for the 2 discards; the post-action
      // draws 1 card after the discards apply.
      state.pendingHandReveal = {
        player,
        target: player,
        label: "Prism Tower: pick 2 cards from your hand to discard, then draw 1",
        min: 2,
        max: 2,
        filter: "any",
        action: "discard",
        postAction: { kind: "drawCards", count: 1 },
      };
    },
  },
};

/**
 * Pre-activation guard for the current Stadium. Runs every check
 * `useStadium` does BEFORE it would mutate state. Shared with the
 * preflight surface so dim/tooltip UI matches the engine's real reasons.
 */
export function precheckStadium(
  state: GameState,
  player: PlayerId,
): { ok: true } | { ok: false; reason: string } {
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
  return { ok: true };
}

// Activate the current Stadium's effect for `player`. Enforces once-per-turn
// and the stadium's specific precheck.
export function useStadium(
  state: GameState,
  player: PlayerId,
): ActivateResult {
  const pre = precheckStadium(state, player);
  if (!pre.ok) return pre;
  // precheckStadium guarantees state.stadium and the named effect exist.
  const effect = STADIUM_EFFECTS[state.stadium!.card.name];
  effect.run(state, player);
  state.players[player].stadiumUsedThisTurn = true;
  return { ok: true };
}
