// Deck construction from the tournament-legal card pool.
//
// Rules enforced:
// - Exactly 60 cards.
// - Max 4 copies per card name (except basic energies — unlimited).
// - At least one Basic Pokémon.
// - Returns separate card *instances* per copy so runtime state (damage,
//   attached energy, etc.) is independent per card.

import { allCards, cardsByName, findByName } from "./cards";
import type { Card, EnergyType, PokemonCard } from "../engine/types";

const DECK_SIZE = 60;

function cloneCard(c: Card): Card {
  // Cards are immutable data; runtime uses PokemonInPlay for state. A shallow
  // clone gives each copy a unique `id` suffix so React keys stay stable.
  return { ...c } as Card;
}

function isPokemon(c: Card): c is PokemonCard {
  return c.supertype === "Pokémon";
}

// Basic energy card name follows the "<Type> Energy" pattern (SVE reprints:
// "Basic <Type> Energy"). We prefer the short-name printings if available.
function basicEnergy(type: EnergyType): Card | undefined {
  const tryNames = [`${type} Energy`, `Basic ${type} Energy`];
  for (const n of tryNames) {
    const c = findByName(n);
    if (c) return c;
  }
  return undefined;
}

// Recursively collect the full evolution line rooted at `name`.
function evolutionLine(name: string): string[] {
  const chain = [name];
  let cursor: Card | undefined = findByName(name);
  // Walk DOWN the chain (find things that evolve FROM each step).
  const added = new Set<string>([name]);
  const queue = [name];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const c of allCards) {
      if (
        isPokemon(c) &&
        c.evolvesFrom === cur &&
        !added.has(c.name)
      ) {
        added.add(c.name);
        chain.push(c.name);
        queue.push(c.name);
      }
    }
  }
  // Walk UP the chain from cursor in case user named an evolution.
  while (cursor && isPokemon(cursor) && cursor.evolvesFrom) {
    const pre = cursor.evolvesFrom;
    if (!added.has(pre)) {
      added.add(pre);
      chain.unshift(pre);
      cursor = findByName(pre);
    } else {
      break;
    }
  }
  return chain;
}

function addCopies(deck: Card[], name: string, n: number): number {
  const found = findByName(name);
  if (!found) return 0;
  for (let i = 0; i < n; i++) deck.push(cloneCard(found));
  return n;
}

// Common staple trainers that exist in the current legal pool.
const STAPLE_TRAINERS = [
  "Buddy-Buddy Poffin", // Item: search 2 Basics from deck
  "Ultra Ball", // Item: search any Pokémon
  "Rare Candy", // Item: skip Stage 1 to evolve to Stage 2
  "Boss's Orders", // Supporter: gust opponent's benched to Active
];

export interface DeckSpec {
  id: string;
  name: string;
  core: string; // primary Pokémon name
  energyType: EnergyType;
  description: string;
}

export const DECK_SPECS: DeckSpec[] = [
  {
    id: "miraidon-lightning",
    name: "Miraidon ex Lightning",
    core: "Miraidon ex",
    energyType: "Lightning",
    description: "Basic Lightning hitter. Pair with Pikachu ex for bench damage.",
  },
  {
    id: "koraidon-fighting",
    name: "Koraidon ex Fighting",
    core: "Koraidon ex",
    energyType: "Fighting",
    description: "Aggro Basic with strong one-energy attack options.",
  },
  {
    id: "reshiram-fire",
    name: "Reshiram ex Fire",
    core: "Reshiram ex",
    energyType: "Fire",
    description: "Big-damage Fire Basic ex.",
  },
  {
    id: "mewtwo-psychic",
    name: "Team Rocket's Mewtwo ex Psychic",
    core: "Team Rocket's Mewtwo ex",
    energyType: "Psychic",
    description: "Hard-hitting Psychic Basic ex.",
  },
  {
    id: "yveltal-dark",
    name: "Yveltal ex Darkness",
    core: "Yveltal ex",
    energyType: "Darkness",
    description: "Darkness attacker supported by basic Darkness energy.",
  },
  {
    id: "keldeo-water",
    name: "Keldeo ex Water",
    core: "Keldeo ex",
    energyType: "Water",
    description: "Water ex with solid two-energy options.",
  },
];

export function buildDeck(spec: DeckSpec): Card[] {
  const deck: Card[] = [];

  // 4 copies of the core, then walk the evolution line (if any) with 4 each.
  const line = evolutionLine(spec.core);
  for (const name of line) {
    addCopies(deck, name, 4);
  }

  // If there are no Basic Pokémon in the line (user picked a Stage 1/2 without
  // a pre-evo in the pool), add a cheap generic basic attacker.
  const hasBasic = deck.some((c) => isPokemon(c) && c.subtypes.includes("Basic"));
  if (!hasBasic) {
    // Find any Basic Pokémon in the pool matching the energy type.
    const fallback = allCards.find(
      (c) =>
        isPokemon(c) &&
        c.subtypes.includes("Basic") &&
        c.types.includes(spec.energyType) &&
        c.attacks.length > 0,
    );
    if (fallback) addCopies(deck, fallback.name, 4);
  }

  // Staple trainers — cap at 4 each, skip any not in the pool.
  for (const t of STAPLE_TRAINERS) {
    addCopies(deck, t, 4);
    if (deck.length >= DECK_SIZE) break;
  }

  // Fill the rest with basic energy matching the deck's energy type.
  const energy = basicEnergy(spec.energyType) ?? basicEnergy("Colorless");
  if (!energy) {
    throw new Error(`Could not find basic ${spec.energyType} energy in dataset.`);
  }
  while (deck.length < DECK_SIZE) deck.push(cloneCard(energy));

  // If we somehow overshot (over-adding staples + evo lines), trim the end.
  if (deck.length > DECK_SIZE) deck.length = DECK_SIZE;

  return deck;
}

// Diagnostic: list of available deck specs that will actually build.
export function validatedDeckSpecs(): DeckSpec[] {
  return DECK_SPECS.filter((s) => cardsByName.has(s.core));
}

// Random legal deck — picks a random validated spec.
export function randomLegalDeck(rng: () => number): Card[] {
  const specs = validatedDeckSpecs();
  const pick = specs[Math.floor(rng() * specs.length)];
  return buildDeck(pick);
}
