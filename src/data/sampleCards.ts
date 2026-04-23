// Placeholder card data for the framework. Shapes mirror the Pokémon TCG API
// so the pokemon-tournament-cards subagent's output can replace this later.
// These are NOT official card values — just enough to exercise the engine.

import type {
  Card,
  EnergyCard,
  PokemonCard,
  TrainerCard,
} from "../engine/types";

let uid = 0;
const id = (prefix: string) => `${prefix}-${++uid}`;

export const basicFireEnergy = (): EnergyCard => ({
  id: id("fire-energy"),
  name: "Fire Energy",
  supertype: "Energy",
  subtypes: ["Basic"],
  provides: ["Fire"],
});

export const basicWaterEnergy = (): EnergyCard => ({
  id: id("water-energy"),
  name: "Water Energy",
  supertype: "Energy",
  subtypes: ["Basic"],
  provides: ["Water"],
});

export const charmander = (): PokemonCard => ({
  id: id("charmander"),
  name: "Charmander",
  supertype: "Pokémon",
  subtypes: ["Basic"],
  hp: 70,
  types: ["Fire"],
  attacks: [
    { name: "Scratch", cost: ["Colorless"], damage: 10 },
    { name: "Ember", cost: ["Fire", "Colorless"], damage: 30 },
  ],
  weaknesses: [{ type: "Water", value: "×2" }],
  retreatCost: ["Colorless"],
});

export const charmeleon = (): PokemonCard => ({
  id: id("charmeleon"),
  name: "Charmeleon",
  supertype: "Pokémon",
  subtypes: ["Stage 1"],
  hp: 100,
  types: ["Fire"],
  evolvesFrom: "Charmander",
  attacks: [
    { name: "Flame Tail", cost: ["Fire", "Colorless"], damage: 50 },
  ],
  weaknesses: [{ type: "Water", value: "×2" }],
  retreatCost: ["Colorless", "Colorless"],
});

export const charizard = (): PokemonCard => ({
  id: id("charizard"),
  name: "Charizard",
  supertype: "Pokémon",
  subtypes: ["Stage 2"],
  hp: 170,
  types: ["Fire"],
  evolvesFrom: "Charmeleon",
  attacks: [
    { name: "Fire Spin", cost: ["Fire", "Fire", "Colorless", "Colorless"], damage: 120 },
  ],
  weaknesses: [{ type: "Water", value: "×2" }],
  retreatCost: ["Colorless", "Colorless", "Colorless"],
});

export const squirtle = (): PokemonCard => ({
  id: id("squirtle"),
  name: "Squirtle",
  supertype: "Pokémon",
  subtypes: ["Basic"],
  hp: 70,
  types: ["Water"],
  attacks: [
    { name: "Tackle", cost: ["Colorless"], damage: 10 },
    { name: "Bubble", cost: ["Water"], damage: 20 },
  ],
  weaknesses: [{ type: "Lightning", value: "×2" }],
  retreatCost: ["Colorless"],
});

export const wartortle = (): PokemonCard => ({
  id: id("wartortle"),
  name: "Wartortle",
  supertype: "Pokémon",
  subtypes: ["Stage 1"],
  hp: 100,
  types: ["Water"],
  evolvesFrom: "Squirtle",
  attacks: [
    { name: "Water Gun", cost: ["Water", "Colorless"], damage: 40 },
  ],
  weaknesses: [{ type: "Lightning", value: "×2" }],
  retreatCost: ["Colorless"],
});

export const blastoise = (): PokemonCard => ({
  id: id("blastoise"),
  name: "Blastoise",
  supertype: "Pokémon",
  subtypes: ["Stage 2"],
  hp: 180,
  types: ["Water"],
  evolvesFrom: "Wartortle",
  attacks: [
    { name: "Hydro Pump", cost: ["Water", "Water", "Colorless"], damage: 100 },
  ],
  weaknesses: [{ type: "Lightning", value: "×2" }],
  retreatCost: ["Colorless", "Colorless", "Colorless"],
});

export const professorsResearch = (): TrainerCard => ({
  id: id("professors-research"),
  name: "Professor's Research",
  supertype: "Trainer",
  subtypes: ["Supporter"],
  text: "Discard your hand and draw 7 cards. (MVP: draws 2.)",
  effectId: "drawTwo",
});

export const potion = (): TrainerCard => ({
  id: id("potion"),
  name: "Potion",
  supertype: "Trainer",
  subtypes: ["Item"],
  text: "Heal 30 damage from your Active Pokémon.",
  effectId: "heal30Active",
});

// All sample cards surfaced for UI / deck builders later.
export const allSampleCards: Card[] = [
  charmander(),
  charmeleon(),
  charizard(),
  squirtle(),
  wartortle(),
  blastoise(),
  basicFireEnergy(),
  basicWaterEnergy(),
  professorsResearch(),
  potion(),
];
