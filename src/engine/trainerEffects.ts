// Trainer effect dispatch and pattern matching.
//
// Trainer cards carry an `effectId` on the mapped card when the text matches a
// known pattern. At play time we dispatch on that id. Unmatched trainers
// simply go to discard without doing anything (their text is still displayed
// to the player via the card tooltip).

import { logEvent } from "./rules";
import type {
  Card,
  GameState,
  PlayerId,
  PokemonCard,
  TrainerCard,
} from "./types";
import type { TrainerTarget } from "./actions";

// The set of effects we auto-detect by pattern matching the card text.
export type TrainerEffectId =
  // Draw and search
  | "drawTwo" // Professor's Research (and similar)
  | "drawUntilSeven" // Iono, Marnie — shuffle hand + draw 5-7
  | "drawUntilSix" // Colress / generic
  | "searchBasicPokemon1" // Nest Ball
  | "searchBasicPokemon2" // Buddy-Buddy Poffin
  | "searchAnyPokemon" // Ultra Ball (with discard 2)
  | "searchBasicEnergy1" // Energy Search
  | "gustOppBenched" // Boss's Orders
  | "heal30Active"
  | "rareCandyEvolve";

export interface ApiTrainer {
  name: string;
  supertype: string;
  subtypes?: string[];
  rules?: string[];
  text?: string;
}

export function detectTrainerEffect(t: ApiTrainer): TrainerEffectId | undefined {
  const text = [...(t.rules ?? []), t.text ?? ""].join("\n");
  if (!text) return undefined;

  // Iono / Marnie: both players shuffle hands into decks, then draw a
  // variable amount (Iono scales to prize cards).
  if (/each player shuffles? their hand into their deck/i.test(text))
    return "drawUntilSeven";

  // Professor's Research / Sycamore: discard hand, draw 7.
  if (/discard your hand and draw 7 cards/i.test(text))
    return "drawUntilSeven";

  // Nest Ball — search your deck for a Basic Pokémon.
  if (t.name === "Nest Ball") return "searchBasicPokemon1";

  // Buddy-Buddy Poffin — 2 Basics into hand.
  if (
    /search your deck for up to 2 basic pok[eé]mon/i.test(text) ||
    t.name === "Buddy-Buddy Poffin"
  )
    return "searchBasicPokemon2";

  // Ultra Ball (with discard 2): simplified — no discard requirement enforced.
  if (
    t.name === "Ultra Ball" ||
    /search your deck for a pok[eé]mon, reveal it/i.test(text)
  )
    return "searchAnyPokemon";

  if (t.name === "Energy Search" || /search your deck for a basic energy/i.test(text))
    return "searchBasicEnergy1";

  // Boss's Orders / Cross Switcher: gust opponent's benched to Active.
  if (
    t.name === "Boss's Orders" ||
    /switch .*benched pok[eé]mon (with (your|their) active|to the active spot)/i.test(text)
  )
    return "gustOppBenched";

  // Potion
  if (t.name === "Potion" || /heal 30 damage/i.test(text)) return "heal30Active";

  // Rare Candy: skip Stage 1 to evolve directly to Stage 2.
  if (t.name === "Rare Candy" || /evolve .*basic pok[eé]mon .*stage 2/i.test(text))
    return "rareCandyEvolve";

  return undefined;
}

// ---- Effect implementations ----------------------------------------------

function drawUpTo(
  state: GameState,
  pl: PlayerId,
  count: number,
): void {
  const player = state.players[pl];
  let drawn = 0;
  for (let i = 0; i < count; i++) {
    const c = player.deck.shift();
    if (!c) break;
    player.hand.push(c);
    drawn++;
  }
  logEvent(state, pl, `draws ${drawn} card(s).`);
}

function shuffleDeck(state: GameState, pl: PlayerId): void {
  const player = state.players[pl];
  const arr = player.deck;
  for (let i = arr.length - 1; i > 0; i--) {
    const j = state.rng.int(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function searchDeck<T extends Card>(
  state: GameState,
  pl: PlayerId,
  pred: (c: Card) => c is T,
  max: number,
): T[] {
  const player = state.players[pl];
  const found: T[] = [];
  const remaining: Card[] = [];
  for (const c of player.deck) {
    if (found.length < max && pred(c)) found.push(c);
    else remaining.push(c);
  }
  player.deck = remaining;
  player.hand.push(...found);
  shuffleDeck(state, pl);
  return found;
}

const isPokemonCard = (c: Card): c is PokemonCard => c.supertype === "Pokémon";
const isBasicPokemonCard = (c: Card): c is PokemonCard =>
  c.supertype === "Pokémon" && c.subtypes.includes("Basic");

export function applyTrainerEffect(
  state: GameState,
  player: PlayerId,
  t: TrainerCard,
  target?: TrainerTarget,
): void {
  const pl = state.players[player];
  const id = t.effectId as TrainerEffectId | undefined;

  switch (id) {
    case "drawTwo":
      drawUpTo(state, player, 2);
      return;

    case "drawUntilSeven": {
      // Simplified: shuffle hand into deck, draw 7 (Iono scales by Prize count).
      const hand = pl.hand.splice(0);
      pl.deck.push(...hand);
      shuffleDeck(state, player);
      drawUpTo(state, player, 7);
      return;
    }

    case "drawUntilSix": {
      drawUpTo(state, player, Math.max(0, 6 - pl.hand.length));
      return;
    }

    case "searchBasicPokemon1": {
      const got = searchDeck(state, player, isBasicPokemonCard, 1);
      if (got.length) {
        logEvent(state, player, `searches deck and adds ${got.map((c) => c.name).join(", ")}.`);
      } else {
        logEvent(state, player, "finds no Basic Pokémon.");
      }
      return;
    }

    case "searchBasicPokemon2": {
      const got = searchDeck(state, player, isBasicPokemonCard, 2);
      if (got.length) {
        logEvent(state, player, `searches deck and adds ${got.map((c) => c.name).join(", ")}.`);
      } else {
        logEvent(state, player, "finds no Basic Pokémon.");
      }
      return;
    }

    case "searchAnyPokemon": {
      const got = searchDeck(state, player, isPokemonCard, 1);
      if (got.length) {
        logEvent(state, player, `searches deck and adds ${got[0].name}.`);
      } else {
        logEvent(state, player, "finds no Pokémon.");
      }
      return;
    }

    case "searchBasicEnergy1": {
      const isBasicEnergy = (c: Card): c is Card =>
        c.supertype === "Energy" && c.subtypes.includes("Basic");
      const got = searchDeck(state, player, isBasicEnergy, 1);
      if (got.length) {
        logEvent(state, player, `searches deck and adds ${got[0].name}.`);
      }
      return;
    }

    case "gustOppBenched": {
      const oppId = player === "p1" ? "p2" : "p1";
      const opp = state.players[oppId];
      const targetId =
        target?.kind === "oppInPlay" ? target.instanceId :
        target?.kind === "inPlay" ? target.instanceId : null;
      if (!targetId || opp.bench.length === 0) return;
      const idx = opp.bench.findIndex((p) => p.instanceId === targetId);
      if (idx === -1) return;
      if (!opp.active) return;
      const pulled = opp.bench.splice(idx, 1)[0];
      const wasActive = opp.active;
      opp.active = pulled;
      opp.bench.push(wasActive);
      logEvent(state, player, `gusts ${pulled.card.name} into the Active spot.`);
      return;
    }

    case "heal30Active":
      if (pl.active) {
        pl.active.damage = Math.max(0, pl.active.damage - 30);
        logEvent(state, player, `heals 30 from ${pl.active.card.name}.`);
      }
      return;

    case "rareCandyEvolve": {
      // Simplified: no-op — the Rare Candy evolution interaction needs a
      // specific target + card chooser in the UI which is on the roadmap.
      logEvent(state, player, "plays Rare Candy (effect not yet interactive).");
      return;
    }

    default:
      return;
  }
}
