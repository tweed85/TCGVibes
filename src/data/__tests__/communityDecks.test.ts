// Pre-flight check for tournament-sourced community decks the user wants
// to add to DECK_SPECS. Per the user's "no cards dropped" requirement,
// these tests fail loudly if any entry doesn't resolve against the current
// 2,693-card pool — so dataset rotations + naming drift surface here
// before any deck reaches setupGame.
//
// Each deck verifies four invariants:
//   1. Parser produces exactly 60 cards (no >4-cap silent truncation)
//   2. unmatched.length === 0 (every entry resolves to a printing in pool)
//   3. ruleViolations.length === 0 (no >4 / dupe-ACE-SPEC drops)
//   4. nameOnlyMatches logged but not failed — informational only
//      (a name-only match means the printing rotated but the card is still
//       playable via name fallback; legal but worth flagging)
//
// On failure, console.log surfaces the offending entries with set+number so
// the user can decide whether to substitute, update the dataset, or drop
// the deck.

import { describe, it, expect } from "vitest";
import { importDecklist } from "../decklistParser";

interface CommunityDeck {
  id: string;
  source: string;
  decklist: string;
}

// Pasted verbatim from limitlesstcg.com player decklist pages, validated
// line-by-line against the user's eyeball-check before landing.
const COMMUNITY_DECKS: CommunityDeck[] = [
  {
    id: "mateusz-dragapult-dudunsparce",
    source: "Mateusz Łaszkiewicz, 1st (Champion), Prague Regional 2026",
    decklist: `Pokémon: 19
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
2 Darkness Energy MEE 7`,
  },
  {
    id: "tresp-crustle",
    source: "Elmar Tresp, 2nd (Finalist), Prague Regional 2026",
    decklist: `Pokémon: 10
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
1 Grass Energy MEE 1`,
  },
  {
    id: "kosek-cynthia-garchomp",
    source: "Neddy Kosek, 3rd, Prague Regional 2026",
    decklist: `Pokémon: 19
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
4 Rocky Fighting Energy POR 87`,
  },
  {
    id: "pires-mega-starmie-dusknoir",
    source: "João Pires, 4th, Prague Regional 2026",
    decklist: `Pokémon: 21
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
1 Legacy Energy TWM 167`,
  },
  {
    id: "cipolla-dragapult-blaziken",
    source: "Vincenzo Cipolla, 8th, Prague Regional 2026",
    decklist: `Pokémon: 23
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
2 Darkness Energy MEE 7`,
  },
  {
    id: "rosu-grimmsnarl-froslass",
    source: "Nicklas Rosu, 12th (Top 16), Prague Regional 2026",
    decklist: `Pokémon: 20
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
9 Darkness Energy MEE 7`,
  },
  {
    id: "zanchi-mega-starmie-froslass",
    source: "Lorenzo Zanchi, 32nd, Prague Regional 2026",
    decklist: `Pokémon: 16
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
1 Legacy Energy TWM 167`,
  },
  {
    id: "reklev-hops-trevenant",
    source: "Tord Reklev (livestream), Prague top-64 list, Prague Regional 2026",
    decklist: `Pokémon: 17
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
3 Mist Energy TEF 161`,
  },
];

describe("Community deck pre-flight (no cards silently dropped)", () => {
  for (const { id, source, decklist } of COMMUNITY_DECKS) {
    describe(`${id} — ${source}`, () => {
      const result = importDecklist(decklist);

      it("parser totals exactly 60 cards", () => {
        if (result.totalCards !== 60) {
          console.log(`\n[${id}] totalCards = ${result.totalCards} (expected 60)`);
        }
        expect(result.totalCards).toBe(60);
      });

      it("every entry resolves to a card in the pool (no unmatched)", () => {
        if (result.unmatched.length > 0) {
          console.log(`\n[${id}] UNMATCHED — these cards are NOT in the pool, would be silently dropped:`);
          for (const u of result.unmatched) {
            console.log(`  - ${u.count}× ${u.name} (${u.limitlessSet} ${u.number})`);
          }
        }
        expect(result.unmatched).toEqual([]);
      });

      it("no rule violations (no >4 truncation, no dupe ACE SPEC)", () => {
        if (result.ruleViolations.length > 0) {
          console.log(`\n[${id}] RULE VIOLATIONS:`);
          for (const v of result.ruleViolations) console.log(`  - ${v}`);
        }
        expect(result.ruleViolations).toEqual([]);
      });

      it("no parser errors (every line parsed cleanly)", () => {
        if (result.parseErrors.length > 0) {
          console.log(`\n[${id}] PARSE ERRORS:`);
          for (const e of result.parseErrors) console.log(`  - ${e}`);
        }
        expect(result.parseErrors).toEqual([]);
      });

      it("built deck has 60 Card objects (matches totalCards)", () => {
        expect(result.deck.length).toBe(60);
      });

      // Informational only — name-only matches mean the printing rotated
      // out but the card itself is still in the pool. Legal, but worth
      // surfacing. We log without failing.
      it("logs name-only matches (informational, not a failure)", () => {
        if (result.nameOnlyMatches.length > 0) {
          console.log(`\n[${id}] NAME-ONLY MATCHES — set+number didn't resolve, fell back to name match (legal but flagged):`);
          for (const n of result.nameOnlyMatches) {
            console.log(`  - ${n.count}× ${n.name} (requested ${n.limitlessSet} ${n.number})`);
          }
        }
        // Always pass — informational only.
        expect(true).toBe(true);
      });
    });
  }
});
