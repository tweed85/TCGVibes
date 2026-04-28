// Preset decks used by the pre-game modal's dropdown.
//
// Each spec carries a raw Limitless-style decklist; buildDeck parses and
// resolves it against the live card pool. If a specific printing is missing
// we fall back to a name-only match (handled by buildDeckFromEntries). Any
// truly unresolvable entries are logged to the console but the deck is still
// returned at whatever count it could assemble — games won't start under 60
// cards, so validatedDeckSpecs() filters those out from the UI dropdown.

import { cardsByName } from "./cards";
import { importDecklist } from "./decklistParser";
import type { Card } from "../engine/types";

const DECK_SIZE = 60;

export interface DeckSpec {
  id: string;
  name: string;
  description?: string;
  decklist: string;
}

// ---------------------------------------------------------------------------
// Preset decklists. Format is the standard Play! Pokémon / Limitless export:
//   <count> <card name> <SET> <number>
// Section headers ("Pokémon: 21" / "Trainer: 33" / "Energy: 6") are parsed
// but ignored during resolution.
// ---------------------------------------------------------------------------

const FESTIVAL_LEADS = `Pokémon: 21
4 Dipplin TWM 18
4 Grookey TWM 14
4 Thwackey TWM 15
2 Applin PRE 9
1 Applin DRI 16
1 Applin TWM 17
1 Goldeen PRE 20
1 Psyduck ASC 39
1 Rillaboom TWM 16
1 Seaking PRE 21
1 Shaymin DRI 10

Trainer: 33
4 Buddy-Buddy Poffin ASC 184
4 Festival Grounds PRE 108
4 Lillie's Determination MEG 119
4 Poké Pad ASC 198
3 Bug Catching Set PRE 102
2 Boss's Orders MEG 114
2 Judge POR 76
2 Kieran PRE 113
1 Air Balloon BLK 79
1 Brave Bangle WHT 80
1 Enhanced Hammer TWM 148
1 Eri TEF 146
1 Lana's Aid TWM 155
1 Maximum Belt TEF 154
1 Night Stretcher ASC 196
1 Switch SVI 194

Energy: 6
6 Grass Energy SVE 1`;

const ARBOLIVA = `Pokémon: 22
1 Arboliva ex DRI 23
2 Bayleef MEG 9
2 Meowth ex POR 62
2 Chikorita MEG 8
1 Noctowl SCR 115
4 Teal Mask Ogerpon ex TWM 25
1 Arboliva ex DRI 207
1 Fezandipiti ex SFA 38
1 Budew PRE 4
1 Hoothoot SCR 114
2 Meganium MEG 10
2 Smoliv DRI 21
2 Dolliv DRI 22

Trainer: 28
2 Poké Pad ASC 198
4 Lillie's Determination MEG 119
1 Lana's Aid TWM 155
2 Boss's Orders MEG 114
2 Energy Switch MEG 115
4 Forest of Vitality MEG 117
4 Ultra Ball MEG 131
1 Unfair Stamp TWM 165
3 Dawn PFL 87
4 Bug Catching Set TWM 143
1 Judge DRI 167

Energy: 10
10 Grass Energy MEE 1`;

const ALAKAZAM = `Pokémon: 23
4 Abra MEG 54
3 Kadabra MEG 55
3 Alakazam MEG 56
3 Dunsparce PAL 156
1 Dunsparce TEF 128
3 Dudunsparce TEF 129
2 Fan Rotom SCR 118
1 Shaymin DRI 10
1 Psyduck ASC 39
1 Fezandipiti ex ASC 142
1 Genesect SFA 40

Trainer: 32
3 Hilda WHT 84
3 Dawn PFL 87
3 Boss's Orders MEG 114
4 Buddy-Buddy Poffin TEF 144
4 Poké Pad ASC 198
3 Rare Candy MEG 125
2 Night Stretcher ASC 196
2 Wondrous Patch PFL 94
2 Enhanced Hammer TWM 148
4 Battle Cage PFL 85
1 Lana's Aid TWM 155
1 Lucky Helmet TWM 158

Energy: 5
4 Psychic Energy MEE 5
1 Enriching Energy SSP 191`;

const LUCARIO = `Pokémon: 16
3 Riolu MEG 76
3 Mega Lucario ex MEG 77
2 Makuhita MEG 72
2 Hariyama MEG 73
2 Solrock MEG 75
2 Lunatone MEG 74
1 Mega Zygarde ex POR 47
1 Meowth ex POR 62

Trainer: 34
4 Lillie's Determination MEG 119
2 Wally's Compassion MEG 132
2 Judge DRI 167
1 Boss's Orders MEG 114
4 Fighting Gong MEG 116
4 Ultra Ball MEG 131
4 Premium Power Pro MEG 124
3 Poké Pad ASC 198
3 Night Stretcher ASC 196
1 Switch MEG 130
2 Air Balloon ASC 181
1 Core Memory POR 70
2 Gravity Mountain SSP 177
1 Maximum Belt PRE 117

Energy: 10
10 Fighting Energy MEE 6`;

export const DECK_SPECS: DeckSpec[] = [
  {
    id: "festival-leads",
    name: "Festival Leads",
    description: "Dipplin + Thwackey Festival Lead twin-hit engine under Festival Grounds.",
    decklist: FESTIVAL_LEADS,
  },
  {
    id: "arboliva",
    name: "Arboliva",
    description: "Teal Mask Ogerpon ex ramp into Arboliva ex's steady pressure under Forest of Vitality.",
    decklist: ARBOLIVA,
  },
  {
    id: "alakazam",
    name: "Alakazam",
    description: "Alakazam + Dudunsparce draw engine with Battle Cage bench protection.",
    decklist: ALAKAZAM,
  },
  {
    id: "lucario-ex",
    name: "Mega Lucario",
    description: "Mega Lucario ex hits hard under Premium Power Pro with a Fighting-search engine.",
    decklist: LUCARIO,
  },
];

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

// Defense-in-depth check before a deck reaches setupGame. Curated presets
// always validate; the surface for failure is imported decks where dataset
// drift between when the user imported the deck and the current card pool
// dropped some cards (rehydrateImports keeps decks of any non-zero size, so
// a 59-card or zero-Basic deck can survive into the picker). Returns null
// if the deck is legal; otherwise a short reason for the UI.
export function validateDeckForPlay(cards: Card[]): string | null {
  if (cards.length !== 60) return `Deck has ${cards.length} cards (needs 60).`;
  if (!cards.some((c) => c.supertype === "Pokémon" && (c.subtypes ?? []).includes("Basic"))) {
    return "Deck has no Basic Pokémon — game cannot start.";
  }
  return null;
}

export function buildDeck(spec: DeckSpec): Card[] {
  const built = importDecklist(spec.decklist);
  if (built.unmatched.length > 0) {
    // Log so a dataset rotation that drops a printing surfaces clearly in the
    // dev console, but don't crash — the deck may still be playable.
    console.warn(
      `[decks] ${spec.name}: ${built.unmatched.length} unresolved entries`,
      built.unmatched,
    );
  }
  if (built.ruleViolations.length > 0) {
    console.warn(`[decks] ${spec.name}: rule violations`, built.ruleViolations);
  }
  return built.deck;
}

// Only include a preset in the dropdown if it builds to a legal 60-card deck.
// Rotating-out printings can leave a deck short; rather than shipping a bad
// default, we filter it out so users don't pick something that won't run.
export function validatedDeckSpecs(): DeckSpec[] {
  return DECK_SPECS.filter((s) => {
    const built = importDecklist(s.decklist);
    const hasBasic = built.deck.some(
      (c) => c.supertype === "Pokémon" && c.subtypes.includes("Basic"),
    );
    return built.deck.length >= DECK_SIZE && hasBasic;
  });
}

// Random preset — used by tests / fallback paths when no deck was chosen.
export function randomLegalDeck(rng: () => number): Card[] {
  const specs = validatedDeckSpecs();
  if (specs.length === 0) {
    throw new Error("No valid preset deck could be built from the current card pool.");
  }
  const pick = specs[Math.floor(rng() * specs.length)];
  return buildDeck(pick);
}

// Kept for back-compat with older call sites that imported it as a named
// symbol. Not used by the new builder.
export { cardsByName };
