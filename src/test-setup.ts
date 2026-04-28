// Vitest global setup: load the card dataset once before any test runs so
// the existing synchronous-import patterns (allCards, findByName) keep
// working after the dataset moved behind loadCards(). DOM-aware tests
// (those with `// @vitest-environment jsdom` at the top of the file) get
// jest-dom matchers; node-environment engine tests just ignore them.

import { loadCards } from "./data/cards";
import "@testing-library/jest-dom/vitest";

await loadCards();
