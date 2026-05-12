// Preset decks used by the pre-game modal's dropdown.
//
// Each spec carries a raw Limitless-style decklist; buildDeck parses and
// resolves it against the live card pool. If a specific printing is missing
// we fall back to a name-only match (handled by buildDeckFromEntries). Any
// truly unresolvable entries are logged to the console but the deck is still
// returned at whatever count it could assemble — games won't start under 60
// cards, so validatedDeckSpecs() filters those out from the UI dropdown.

import { cardsByName, legalMarks } from "./cards";
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

// ---------------------------------------------------------------------------
// Tournament-sourced community decks. All eight pasted verbatim from each
// player's published list at limitlesstcg.com (Prague Regional 2026), then
// validated by src/data/__tests__/communityDecks.test.ts — every entry
// resolves to a card in the current pool with zero unmatched / zero rule
// violations / parser-clean. Pair with archetype playbooks already wired
// in src/engine/aiArchetype.ts.
// ---------------------------------------------------------------------------

const MATEUSZ_DRAGAPULT_DUDUNSPARCE = `Pokémon: 19
4 Dreepy ASC 158
4 Drakloak ASC 159
3 Dragapult ex ASC 160
2 Dunsparce JTG 120
2 Dudunsparce TEF 129
1 Dudunsparce ex JTG 121
2 Munkidori ASC 99
1 Budew ASC 16

Trainer: 32
4 Lillie's Determination MEG 119
3 Crispin SCR 133
3 Boss's Orders MEG 114
2 Brock's Scouting JTG 146
1 Acerola's Mischief MEG 113
4 Buddy-Buddy Poffin ASC 184
4 Poké Pad POR 81
4 Ultra Ball MEG 131
2 Pokégear 3.0 SVI 186
2 Night Stretcher ASC 196
1 Hero's Cape TEF 152
2 Risky Ruins MEG 127

Energy: 9
4 Psychic Energy MEE 5
3 Fire Energy MEE 2
2 Darkness Energy MEE 7`;

const TRESP_CRUSTLE = `Pokémon: 10
4 Dwebble DRI 11
3 Crustle DRI 12
2 Mega Kangaskhan ex MEG 104
1 Cornerstone Mask Ogerpon ex TWM 112

Trainer: 35
4 Lillie's Determination MEG 119
4 Boss's Orders MEG 114
4 Team Rocket's Petrel ASC 207
2 Hilda WHT 84
2 Colress's Tenacity SFA 57
1 Xerosic's Machinations SFA 64
1 Pokémon Center Lady MEG 123
4 Pokégear 3.0 SVI 186
4 Jumbo Ice Cream PFL 91
2 Ultra Ball MEG 131
2 Buddy-Buddy Poffin ASC 184
1 Super Potion JTG 158
1 Switch MEG 130
1 Hero's Cape TEF 152
1 Forest of Vitality MEG 117
1 Team Rocket's Factory ASC 203

Energy: 15
4 Mist Energy TEF 161
4 Spiky Energy JTG 159
4 Growing Grass Energy POR 86
2 Rocky Fighting Energy POR 87
1 Grass Energy MEE 1`;

const KOSEK_CYNTHIA_GARCHOMP = `Pokémon: 19
4 Cynthia's Gible ASC 109
4 Cynthia's Gabite ASC 110
3 Cynthia's Garchomp ex ASC 111
4 Cynthia's Roselia DRI 7
3 Cynthia's Roserade DRI 8
1 Cynthia's Spiritomb ASC 133

Trainer: 32
4 Boss's Orders MEG 114
4 Lillie's Determination MEG 119
2 Larry's Skill PRE 115
1 Team Rocket's Petrel ASC 207
4 Poké Pad POR 81
4 Buddy-Buddy Poffin ASC 184
3 Fighting Gong MEG 116
2 Pokégear 3.0 SVI 186
2 Premium Power Pro MEG 124
1 Switch MEG 130
1 Unfair Stamp TWM 165
4 Cynthia's Power Weight DRI 162

Energy: 9
5 Fighting Energy MEE 6
4 Rocky Fighting Energy POR 87`;

const PIRES_MEGA_STARMIE_DUSKNOIR = `Pokémon: 21
4 Duskull PRE 35
3 Dusclops PRE 36
2 Dusknoir PRE 37
3 Staryu POR 20
2 Mega Starmie ex POR 21
2 Munkidori ASC 99
1 Fezandipiti ex ASC 142
1 Latias ex SSP 76
1 Bloodmoon Ursaluna ex TWM 141
1 Budew ASC 16
1 Meowth ex POR 62

Trainer: 30
4 Lillie's Determination MEG 119
3 Hilda WHT 84
2 Boss's Orders MEG 114
1 Judge POR 76
1 Wally's Compassion MEG 132
4 Ultra Ball MEG 131
4 Buddy-Buddy Poffin ASC 184
3 Pokégear 3.0 SVI 186
3 Poké Pad POR 81
2 Night Stretcher ASC 196
3 Risky Ruins MEG 127

Energy: 9
3 Water Energy MEE 3
3 Darkness Energy MEE 7
2 Ignition Energy WHT 86
1 Legacy Energy TWM 167`;

const CIPOLLA_DRAGAPULT_BLAZIKEN = `Pokémon: 23
4 Dreepy ASC 158
4 Drakloak ASC 159
2 Dragapult ex ASC 160
2 Torchic DRI 40
1 Combusken DRI 41
2 Blaziken ex JTG 24
2 Munkidori ASC 99
2 Budew ASC 16
1 Fezandipiti ex ASC 142
1 Meowth ex POR 62
1 Lillie's Clefairy ex ASC 76
1 Shaymin DRI 10

Trainer: 29
4 Lillie's Determination MEG 119
3 Boss's Orders MEG 114
2 Crispin SCR 133
2 Dawn PFL 87
4 Buddy-Buddy Poffin ASC 184
4 Ultra Ball MEG 131
3 Poké Pad POR 81
2 Rare Candy MEG 125
2 Night Stretcher ASC 196
1 Unfair Stamp TWM 165
1 Risky Ruins MEG 127
1 Team Rocket's Watchtower ASC 210

Energy: 8
3 Psychic Energy MEE 5
3 Fire Energy MEE 2
2 Darkness Energy MEE 7`;

const ROSU_GRIMMSNARL_FROSLASS = `Pokémon: 20
4 Munkidori ASC 99
3 Marnie's Impidimp DRI 134
2 Marnie's Morgrem DRI 135
2 Marnie's Grimmsnarl ex DRI 136
2 Snorunt ASC 46
2 Froslass TWM 53
2 Budew ASC 16
1 Tatsugiri TWM 131
1 Shaymin DRI 10
1 Yveltal MEG 88

Trainer: 31
4 Lillie's Determination MEG 119
4 Team Rocket's Petrel ASC 207
3 Boss's Orders MEG 114
4 Buddy-Buddy Poffin ASC 184
4 Poké Pad POR 81
3 Night Stretcher ASC 196
2 Rare Candy MEG 125
1 Unfair Stamp TWM 165
1 Energy Switch MEG 115
1 Air Balloon ASC 181
4 Spikemuth Gym DRI 169

Energy: 9
9 Darkness Energy MEE 7`;

const ZANCHI_MEGA_STARMIE_FROSLASS = `Pokémon: 16
3 Snorunt ASC 46
2 Froslass TWM 53
2 Mega Froslass ex ASC 47
3 Staryu POR 20
2 Mega Starmie ex POR 21
3 Munkidori ASC 99
1 Meowth ex POR 62

Trainer: 35
4 Lillie's Determination MEG 119
4 Hilda WHT 84
2 Crispin SCR 133
2 Boss's Orders MEG 114
2 Wally's Compassion MEG 132
1 Larry's Skill PRE 115
4 Buddy-Buddy Poffin ASC 184
4 Poké Pad POR 81
4 Ultra Ball MEG 131
2 Night Stretcher ASC 196
2 Pokégear 3.0 SVI 186
1 Air Balloon ASC 181
3 Risky Ruins MEG 127

Energy: 9
4 Water Energy MEE 3
3 Darkness Energy MEE 7
1 Ignition Energy WHT 86
1 Legacy Energy TWM 167`;

const REKLEV_HOPS_TREVENANT = `Pokémon: 17
4 Hop's Phantump ASC 95
3 Hop's Trevenant ASC 96
2 Hop's Snorlax JTG 117
2 Hop's Cramorant ASC 177
1 Genesect SFA 40
1 Latias ex SSP 76
1 Fezandipiti ex ASC 142
1 Lillie's Clefairy ex ASC 76
1 Shaymin DRI 10
1 Hop's Zacian ex JTG 111

Trainer: 36
4 Lillie's Determination MEG 119
4 Boss's Orders MEG 114
4 Team Rocket's Petrel ASC 207
3 Hassel TWM 151
4 Poké Pad POR 81
2 Hop's Bag JTG 147
2 Night Stretcher ASC 196
2 Pokégear 3.0 SVI 186
1 Ultra Ball MEG 131
1 Secret Box TWM 163
4 Hop's Choice Band JTG 148
1 Air Balloon ASC 181
4 Postwick JTG 154

Energy: 7
4 Telepathic Psychic Energy POR 88
3 Mist Energy TEF 161`;

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
  {
    id: "mateusz-dragapult-dudunsparce",
    name: "Dragapult / Dudunsparce (Mateusz Łaszkiewicz, Prague 1st)",
    description: "Champion list. Dragapult ex Phantom Dive primary; Dudunsparce ex Destructive Drill bypasses EX-immunity walls. Hero's Cape ACE SPEC on the 1-prize Dudunsparce.",
    decklist: MATEUSZ_DRAGAPULT_DUDUNSPARCE,
  },
  {
    id: "tresp-crustle",
    name: "Crustle (Elmar Tresp, Prague 2nd)",
    description: "Wall-first finalist list. Mysterious Rocking Inability immunity to EX damage; Mega Kangaskhan ex backup attacker. Hero's Cape ACE SPEC = 250 HP Crustle.",
    decklist: TRESP_CRUSTLE,
  },
  {
    id: "kosek-cynthia-garchomp",
    name: "Cynthia's Garchomp ex (Neddy Kosek, Prague 3rd)",
    description: "Cynthia's-prefix evolution engine. Cynthia's Roserade energy ramp + Garchomp ex Corkscrew Dive (attack + draw). Unfair Stamp ACE SPEC.",
    decklist: KOSEK_CYNTHIA_GARCHOMP,
  },
  {
    id: "pires-mega-starmie-dusknoir",
    name: "Mega Starmie / Dusknoir (João Pires, Prague 4th)",
    description: "Mega Starmie ex Jetting Blow + Dusknoir Cursed Blast (anti-Crustle bypass). Risky Ruins compound spread damage.",
    decklist: PIRES_MEGA_STARMIE_DUSKNOIR,
  },
  {
    id: "cipolla-dragapult-blaziken",
    name: "Dragapult / Blaziken (Vincenzo Cipolla, Prague 8th)",
    description: "Stage-2 setup deck. Blaziken ex Charging Up energy acceleration into Dragapult ex Phantom Dive.",
    decklist: CIPOLLA_DRAGAPULT_BLAZIKEN,
  },
  {
    id: "rosu-grimmsnarl-froslass",
    name: "Marnie's Grimmsnarl ex / Froslass (Nicklas Rosu, Prague Top 16)",
    description: "Marnie's-prefix engine + Spikemuth Gym (item-lock-immune stadium-search). Punk Up energy acceleration on evolve.",
    decklist: ROSU_GRIMMSNARL_FROSLASS,
  },
  {
    id: "zanchi-mega-starmie-froslass",
    name: "Mega Starmie / Mega Froslass ex (Lorenzo Zanchi, Prague)",
    description: "Risky Ruins stadium passive 2-counter spread + Mega Froslass ex hand-size scaling damage.",
    decklist: ZANCHI_MEGA_STARMIE_FROSLASS,
  },
  {
    id: "reklev-hops-trevenant",
    name: "Hop's Trevenant",
    description: "Single-prize Hop's-prefix engine. Hop's Trevenant Horrifying Revenge (130 dmg if you lost a KO last turn) + Postwick / Hop's Choice Band damage layering.",
    decklist: REKLEV_HOPS_TREVENANT,
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
  if (legalMarks.length > 0) {
    const illegal = cards.find(
      (c) => c.regulationMark && !legalMarks.includes(c.regulationMark),
    );
    if (illegal) {
      return `${illegal.name} has regulation mark ${illegal.regulationMark}, which is not legal in the current Standard card pool (${legalMarks.join("/")}).`;
    }
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
