import type { Card } from "../engine/types";
import {
  basicFireEnergy,
  basicWaterEnergy,
  blastoise,
  charizard,
  charmander,
  charmeleon,
  potion,
  professorsResearch,
  squirtle,
  wartortle,
} from "./sampleCards";

// 60-card decks (full Pokémon TCG size). Sample construction only.
export function fireDeck(): Card[] {
  const deck: Card[] = [];
  for (let i = 0; i < 4; i++) deck.push(charmander());
  for (let i = 0; i < 3; i++) deck.push(charmeleon());
  for (let i = 0; i < 2; i++) deck.push(charizard());
  for (let i = 0; i < 4; i++) deck.push(professorsResearch());
  for (let i = 0; i < 4; i++) deck.push(potion());
  while (deck.length < 60) deck.push(basicFireEnergy());
  return deck;
}

export function waterDeck(): Card[] {
  const deck: Card[] = [];
  for (let i = 0; i < 4; i++) deck.push(squirtle());
  for (let i = 0; i < 3; i++) deck.push(wartortle());
  for (let i = 0; i < 2; i++) deck.push(blastoise());
  for (let i = 0; i < 4; i++) deck.push(professorsResearch());
  for (let i = 0; i < 4; i++) deck.push(potion());
  while (deck.length < 60) deck.push(basicWaterEnergy());
  return deck;
}
