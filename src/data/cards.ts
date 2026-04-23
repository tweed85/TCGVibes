// Loads the tournament-legal dataset and exposes typed card lookups.

import rawData from "../../data/pokemon/tournament-legal-cards.json";
import type { Card } from "../engine/types";
import { mapCard, type ApiCard } from "./cardMapper";

interface RawDoc {
  as_of_date: string;
  region: string;
  format: string;
  legal_regulation_marks: string[];
  total_legal_cards_written: number;
  cards: ApiCard[];
}

const doc = rawData as unknown as RawDoc;

export const datasetAsOf = doc.as_of_date;
export const datasetFormat = `${doc.format} (${doc.region})`;
export const legalMarks = doc.legal_regulation_marks;

export const apiCards: ApiCard[] = doc.cards;
export const allCards: Card[] = apiCards.map(mapCard);

// Indexes for fast lookup.
export const cardsById = new Map(allCards.map((c) => [c.id, c]));

const _byName = new Map<string, Card[]>();
for (const c of allCards) {
  if (!_byName.has(c.name)) _byName.set(c.name, []);
  _byName.get(c.name)!.push(c);
}
export const cardsByName = _byName;

export function findByName(name: string): Card | undefined {
  const arr = _byName.get(name);
  return arr?.[0];
}
