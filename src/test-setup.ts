// Vitest global setup: load the card dataset once before any test runs so
// the existing synchronous-import patterns (allCards, findByName) keep
// working after the dataset moved behind loadCards().

import { loadCards } from "./data/cards";

await loadCards();
