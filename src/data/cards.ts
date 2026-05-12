// Loads the tournament-legal dataset and exposes typed card lookups.
//
// The 3.3MB JSON used to be imported statically at module init, which forced
// it into the engine bundle and ran the full mapCard() over 2,693 cards
// before first paint. Now it's dynamic-imported inside loadCards(), so the
// JSON splits into its own chunk and parsing is deferred until the app
// actually needs it (boot — App.tsx awaits loadCards before rendering the
// game UI; tests use a setup file).
//
// Consumers keep their existing synchronous API: `let` exports start empty
// and are mutated by loadCards(). Module bindings are live, so importers
// see the populated values once the promise resolves.

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

export let datasetAsOf = "";
export let datasetFormat = "";
export let legalMarks: string[] = [];
export let allCards: Card[] = [];
export let cardsById: Map<string, Card> = new Map();
export let cardsByName: Map<string, Card[]> = new Map();

let loadPromise: Promise<void> | null = null;
let loaded = false;

export function cardsAreLoaded(): boolean {
  return loaded;
}

export function loadCards(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    // Vite splits this into its own chunk because of the dynamic import.
    const mod = await import("../../data/pokemon/tournament-legal-cards.json");
    const doc = (mod.default ?? mod) as unknown as RawDoc;
    const mapped = doc.cards.map(mapCard);
    allCards = mapped;
    cardsById = new Map(mapped.map((c) => [c.id, c]));
    const byName = new Map<string, Card[]>();
    for (const c of mapped) {
      if (!byName.has(c.name)) byName.set(c.name, []);
      byName.get(c.name)!.push(c);
    }
    cardsByName = byName;
    datasetAsOf = doc.as_of_date;
    datasetFormat = `${doc.format} (${doc.region})`;
    legalMarks = doc.legal_regulation_marks;
    loaded = true;
  })();
  return loadPromise;
}

export function findByName(name: string): Card | undefined {
  return cardsByName.get(name)?.[0];
}
