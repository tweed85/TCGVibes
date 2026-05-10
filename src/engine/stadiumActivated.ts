// Once-per-turn activated Stadium effects. Unlike the passive Stadium
// modifiers in ongoingEffects.ts (which apply automatically to damage /
// retreat cost / HP), these require the player to *press* the Stadium to
// take its action on their turn.

import {
  fireTriggeredOnEvolve,
  fireTriggeredOnMoveToActive,
  fireTriggeredOnMoveToBench,
} from "./abilities";
import {
  applyEvolveSideEffects,
  endTurn,
  isPlayersFirstTurn,
  logEvent,
} from "./rules";
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

// Apply a Grand Tree evolution onto the captured ally instance. Mirrors the
// human chain-step path in pendingPick.ts so AI and human routes share the
// same status-cleanup, evolved-this-turn flag, ability-reset, and on-evolve
// trigger semantics.
function applyGrandTreeEvolution(
  state: GameState,
  player: PlayerId,
  ally: PokemonInPlay,
  evoCard: PokemonCard,
): void {
  ally.evolvedFrom.push(ally.card);
  ally.card = evoCard;
  applyEvolveSideEffects(state, ally);
  logEvent(state, player, `Grand Tree: evolves into ${evoCard.name}.`);
  fireTriggeredOnEvolve(state, player, ally);
}

const STADIUM_EFFECTS: Record<string, StadiumEffect> = {
  "Academy at Night": {
    precheck: (state, player) => {
      if (state.players[player].hand.length === 0) return "Hand is empty.";
      return null;
    },
    run: (state, player) => {
      const pl = state.players[player];
      // AI lane: pick the lowest-immediate-use card to put on top of the
      // deck. Ranking (worst-first → best-stash):
      //   1. Duplicate basic Energy of an over-stocked type
      //   2. Duplicate Pokémon already in play
      //   3. Trainer with no immediate useful target this turn
      //   4. First card (fallback)
      if (pl.isAI) {
        const handIdxs = pl.hand.map((_, i) => i);
        const score = (c: Card): number => {
          // Lower score = better to stash (less useful now).
          if (c.supertype === "Energy") {
            // Count how many of this energy type we already have available.
            const provides = (c as { provides?: string[] }).provides ?? [];
            let copies = 0;
            for (const h of pl.hand) {
              if (h.supertype === "Energy") {
                const hp = (h as { provides?: string[] }).provides ?? [];
                if (hp.some((t) => provides.includes(t))) copies++;
              }
            }
            // Duplicate basic Energy = great stash candidate.
            return 5 + copies; // more copies = even better to stash
          }
          if (c.supertype === "Pokémon") {
            const inPlay = [pl.active, ...pl.bench].some(
              (p) => p && p.card.name === c.name,
            );
            if (inPlay) return 10; // duplicate of already-in-play Pokémon
            return 100; // unique Pokémon — keep in hand
          }
          // Trainer: heuristic. Supporters are usually high value,
          // Items moderate, Stadiums depend on board state.
          const subs = c.subtypes ?? [];
          if (subs.includes("Supporter")) return 80;
          if (subs.includes("Stadium")) return state.stadium ? 30 : 60;
          return 40; // generic Item
        };
        const ranked = handIdxs.sort((a, b) => score(pl.hand[a]) - score(pl.hand[b]));
        const pick = ranked[0] ?? 0;
        const [c] = pl.hand.splice(pick, 1);
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
        effectKind: "academyAtNight",
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

      // AI lane: take Lightning only if some current or bench attacker
      // has a Lightning or Colorless cost slot — otherwise the recovery
      // is wasted. (The card text doesn't force you to take any; "up to 2"
      // covers a 0-pick path.)
      if (pl.isAI) {
        const allies = [pl.active, ...pl.bench].filter(
          (p): p is PokemonInPlay => !!p,
        );
        const lightningUseful = allies.some((p) =>
          (p.card.attacks ?? []).some((a) =>
            a.cost.some((c) => c === "Lightning" || c === "Colorless"),
          ),
        );
        if (!lightningUseful) {
          logEvent(state, player, "Levincia: no Lightning use; skips recovery.");
          return;
        }
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
      if (state.pendingPick) state.pendingPick.effectKind = "levincia";
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

      // AI lane: discard the energy type LEAST needed by current/bench
      // attackers' costs. If every Energy in hand is useful, fall back to
      // discarding a duplicate so we don't waste a one-of-its-kind type.
      if (pl.isAI) {
        const energyIdxs = pl.hand
          .map((c, i) => ({ c, i }))
          .filter(({ c }) => c.supertype === "Energy");
        if (energyIdxs.length === 0) return;
        const wantedTypes = new Set<string>();
        for (const a of allies) {
          for (const atk of a.card.attacks ?? []) {
            for (const c of atk.cost) if (c !== "Colorless") wantedTypes.add(c);
          }
        }
        // Score each hand Energy: lower = better discard candidate.
        const score = (c: Card): number => {
          if (c.supertype !== "Energy") return 1000;
          const provides = (c as { provides?: string[] }).provides ?? [];
          // Special Energy in hand is high-value — don't discard if avoidable.
          const subs = c.subtypes ?? [];
          const isSpecial = !subs.includes("Basic");
          if (isSpecial) return 100;
          // Wanted basic Energy: keep.
          if (provides.some((p) => wantedTypes.has(p))) return 50;
          // Unneeded basic Energy: prime discard candidate.
          return 5;
        };
        let pickIdx = energyIdxs[0].i;
        let pickScore = score(energyIdxs[0].c);
        for (const { c, i } of energyIdxs) {
          const s = score(c);
          if (s < pickScore) {
            pickScore = s;
            pickIdx = i;
          }
        }
        // If the least-useful Energy is still wanted, prefer a duplicate-
        // type Energy (we have multiple) over a singleton.
        if (pickScore >= 50) {
          const typeCounts = new Map<string, number>();
          for (const { c } of energyIdxs) {
            const provides = (c as { provides?: string[] }).provides ?? [];
            for (const p of provides) typeCounts.set(p, (typeCounts.get(p) ?? 0) + 1);
          }
          for (const { c, i } of energyIdxs) {
            const provides = (c as { provides?: string[] }).provides ?? [];
            const isDup = provides.some((p) => (typeCounts.get(p) ?? 0) > 1);
            if (isDup) {
              pickIdx = i;
              break;
            }
          }
        }
        const [e] = pl.hand.splice(pickIdx, 1);
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
        effectKind: "mysteryGarden",
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

      // AI: keep the existing greedy auto-resolve (Stage 1 + auto-Stage 2
      // when available). AI's Stage 2 evaluation is a Phase 1+ improvement.
      if (pl.isAI) {
        // Candidate scoring: enumerate every (Basic, Stage 1, optional
        // Stage 2) chain reachable from the current eligible Basics +
        // deck. Score each chain by the final form's HP + summed attack
        // damage, with a small Active-spot bonus. Pick the highest-scoring
        // chain. If the best Stage 2 isn't strictly an upgrade over its
        // Stage 1 (HP drop or no attacks), stop the chain at Stage 1.
        type Chain = {
          basic: PokemonInPlay;
          s1: PokemonCard;
          s1Idx: number;
          s2: PokemonCard | null;
          s2Idx: number;
          score: number;
        };
        const sumAttack = (card: PokemonCard): number => {
          let total = 0;
          for (const a of card.attacks ?? []) {
            const d = typeof a.damage === "number" ? a.damage : 0;
            if (d > total) total = d;
          }
          return total;
        };
        const chains: Chain[] = [];
        for (const basic of eligibleBasics) {
          const s1Idx = pl.deck.findIndex(
            (c) =>
              c.supertype === "Pokémon" &&
              c.subtypes.includes("Stage 1") &&
              c.evolvesFrom === basic.card.name,
          );
          if (s1Idx < 0) continue;
          const s1 = pl.deck[s1Idx] as PokemonCard;
          const s2CandIdx = pl.deck.findIndex(
            (c) =>
              c.supertype === "Pokémon" &&
              c.subtypes.includes("Stage 2") &&
              c.evolvesFrom === s1.name,
          );
          const s2 = s2CandIdx >= 0 ? (pl.deck[s2CandIdx] as PokemonCard) : null;
          // Stop-at-Stage-1 rule: chain to Stage 2 only when it is a strict
          // HP upgrade over Stage 1. Equal/regressive HP holds at Stage 1
          // until the scorer grows a richer attack/ability comparison.
          const useS2 =
            s2 !== null && (s2.hp ?? 0) > (s1.hp ?? 0);
          const finalForm = useS2 ? s2! : s1;
          let score = (finalForm.hp ?? 0) + sumAttack(finalForm) * 2;
          if (basic === pl.active) score += 40; // Active-spot bonus
          chains.push({
            basic,
            s1,
            s1Idx,
            s2: useS2 ? s2 : null,
            s2Idx: useS2 ? s2CandIdx : -1,
            score,
          });
        }
        if (chains.length === 0) return;
        chains.sort((a, b) => b.score - a.score);
        const best = chains[0];
        // Splice cards out — Stage 2 first since it's later in the deck
        // (largest index), so removing it doesn't shift Stage 1's index.
        if (best.s2 && best.s2Idx >= 0) {
          // Stage 2 may sit before Stage 1 in the deck; splice the larger
          // index first regardless to keep both lookups valid.
          const [hi, lo] = best.s2Idx > best.s1Idx
            ? [best.s2Idx, best.s1Idx]
            : [best.s1Idx, best.s2Idx];
          const isHiS2 = hi === best.s2Idx;
          const [hiCard] = pl.deck.splice(hi, 1) as [PokemonCard];
          const [loCard] = pl.deck.splice(lo, 1) as [PokemonCard];
          const s1Card = isHiS2 ? loCard : hiCard;
          const s2Card = isHiS2 ? hiCard : loCard;
          applyGrandTreeEvolution(state, player, best.basic, s1Card);
          applyGrandTreeEvolution(state, player, best.basic, s2Card);
        } else {
          const [s1Card] = pl.deck.splice(best.s1Idx, 1) as [PokemonCard];
          applyGrandTreeEvolution(state, player, best.basic, s1Card);
        }
        // Shuffle per "Then, that player shuffles their deck."
        const arr = pl.deck;
        for (let i = arr.length - 1; i > 0; i--) {
          const j = state.rng.int(i + 1);
          [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return;
      }

      // Human (single or multiple eligible Basics): open the chained
      // picker. Step 1 captures which Basic; the resolveInPlayTarget
      // handler for "grandTreeBasicTarget" opens the Stage 1 deck search,
      // and that pick's afterPick chain offers the optional (skippable)
      // Stage 2 search. Single-basic case still goes through this picker
      // so the human gets the optional Stage 2 prompt instead of an
      // automatic Stage 2 evolution.
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

      // Single Water bench: short-circuit. AI: rank Water bench by
      // estimated attack readiness (most attached Energy first, then
      // highest base damage), so we don't promote a 0-Energy Basic when
      // a powered attacker is also on the bench.
      if (pl.isAI) {
        const ranked = waterBench
          .map((b) => {
            const energyCount = b.p.attachedEnergy.length;
            const maxDamage = (b.p.card.attacks ?? []).reduce(
              (m, a) => Math.max(m, a.damage),
              0,
            );
            return { ...b, score: energyCount * 100 + maxDamage };
          })
          .sort((a, b) => b.score - a.score);
        const idx = ranked[0].idx;
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
      if (waterBench.length === 1) {
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
      // AI lane: discard the 2 lowest-immediate-use hand cards. Protect
      // immediate setup pieces — never the only Energy that would close
      // a ready attack cost this turn or the only matching evolution
      // for an in-play Basic eligible to evolve.
      if (pl.isAI) {
        const allies = [pl.active, ...pl.bench].filter(
          (p): p is PokemonInPlay => !!p,
        );
        const eligibleEvolveBasics = new Set(
          allies
            .filter((p) => p.card.subtypes.includes("Basic") && !p.playedThisTurn)
            .map((p) => p.card.name),
        );
        const wantedTypes = new Set<string>();
        for (const a of allies) {
          for (const atk of a.card.attacks ?? []) {
            for (const c of atk.cost) if (c !== "Colorless") wantedTypes.add(c);
          }
        }
        const score = (c: Card, idxInHand: number): number => {
          // Lower score = better discard candidate.
          if (c.supertype === "Energy") {
            const provides = (c as { provides?: string[] }).provides ?? [];
            const wanted = provides.some((p) => wantedTypes.has(p));
            // Count copies of this type still in hand.
            let dupCount = 0;
            for (let j = 0; j < pl.hand.length; j++) {
              if (j === idxInHand) continue;
              const h = pl.hand[j];
              if (h.supertype === "Energy") {
                const hp = (h as { provides?: string[] }).provides ?? [];
                if (hp.some((t) => provides.includes(t))) dupCount++;
              }
            }
            // Wanted singleton type — protect.
            if (wanted && dupCount === 0) return 90;
            if (wanted) return 30;
            return 10; // unwanted Energy — fine to discard
          }
          if (c.supertype === "Pokémon") {
            const evolvesFrom = (c as PokemonCard).evolvesFrom;
            if (evolvesFrom && eligibleEvolveBasics.has(evolvesFrom)) {
              // Count copies still in hand for that evolution.
              const dup =
                pl.hand.filter(
                  (h, j) =>
                    j !== idxInHand &&
                    h.supertype === "Pokémon" &&
                    (h as PokemonCard).evolvesFrom === evolvesFrom,
                ).length;
              if (dup === 0) return 85; // singleton evolution piece — protect
              return 35;
            }
            // Duplicate of in-play Pokémon → fine to discard.
            const inPlayDup = allies.some((p) => p.card.name === c.name);
            return inPlayDup ? 15 : 45;
          }
          // Trainer.
          const subs = c.subtypes ?? [];
          if (subs.includes("Supporter")) return 60;
          return 25; // Items & Stadiums are moderate
        };
        const handIdxs = pl.hand.map((_, i) => i);
        handIdxs.sort((a, b) => score(pl.hand[a], a) - score(pl.hand[b], b));
        const [iA, iB] = handIdxs.slice(0, 2);
        // Splice in descending order to keep indexes valid.
        const [hi, lo] = iA > iB ? [iA, iB] : [iB, iA];
        const a = pl.hand.splice(hi, 1)[0];
        const b = pl.hand.splice(lo, 1)[0];
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
        effectKind: "prismTower",
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
