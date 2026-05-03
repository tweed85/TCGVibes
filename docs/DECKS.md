# Decks available

Twelve curated decks live in [../src/data/decks.ts](../src/data/decks.ts).
See [../CLAUDE.md](../CLAUDE.md) for the project entry point.

## Curated archetypes (4 baseline)

- `festival-leads` — Dipplin + Thwackey twin-hit engine under Festival Grounds
- `arboliva` — Teal Mask Ogerpon ex ramp into Arboliva ex
- `alakazam` — Alakazam + Dudunsparce draw engine with Battle Cage
- `lucario-ex` — Mega Lucario ex hits hard under Premium Power Pro

## Community decks (8 Prague Regional 2026 lists)

Fetched verbatim from each player's published list at limitlesstcg.com,
validated by [../src/data/__tests__/communityDecks.test.ts](../src/data/__tests__/communityDecks.test.ts):

- `mateusz-dragapult-dudunsparce` — 1st (Champion). Dragapult ex Phantom
  Dive primary; Dudunsparce ex Destructive Drill bypasses EX-immunity walls.
  Hero's Cape ACE SPEC on the 1-prize Dudunsparce.
- `tresp-crustle` — 2nd (Finalist). Mysterious Rock Inn EX-attack immunity
  + Mega Kangaskhan ex backup. Hero's Cape = 250-HP Crustle.
- `kosek-cynthia-garchomp` — 3rd. Cynthia's-prefix engine + Garchomp ex
  Corkscrew Dive. Unfair Stamp ACE SPEC.
- `pires-mega-starmie-dusknoir` — 4th. Mega Starmie ex Jetting Blow + Dusknoir
  Cursed Blast for anti-Crustle bypass. Risky Ruins compound spread.
- `cipolla-dragapult-blaziken` — 8th. Stage-2 setup deck. Blaziken ex
  Charging Up energy accel into Dragapult ex Phantom Dive.
- `rosu-grimmsnarl-froslass` — 12th (Top 16). Marnie's-prefix engine +
  Spikemuth Gym (item-lock-immune stadium-search). Punk Up energy accel.
- `zanchi-mega-starmie-froslass` — 32nd. Risky Ruins passive 2-counter
  spread + Mega Froslass ex hand-size scaling damage.
- `reklev-hops-trevenant` — Tord Reklev's stream of the Prague top-64
  Hop's Trevenant list. Single-prize Hop's-prefix engine. Horrifying
  Revenge (130 dmg if you lost a KO last turn) + Postwick / Hop's
  Choice Band damage layering.

## Custom decks

Custom decks via `decklistParser` (PTCGL text), persisted to IndexedDB.
Parser truncates over-cap entries; `validateDeckForPlay` runs at the
picker as defense-in-depth and rejects ≠60-card / zero-Basic decks
before they reach `setupGame`.

## Deck builder UX

The deck builder UI ([../src/ui/DeckBuilderModal.tsx](../src/ui/DeckBuilderModal.tsx))
groups by **gameplay equivalence** ([../src/data/cardEquivalence.ts](../src/data/cardEquivalence.ts))
— one tile per mechanically distinct card. Multi-printing groups show
a "N arts" badge; clicking opens [VariantPicker](../src/ui/VariantPicker.tsx)
for art selection. Rule-of-4 aggregates across printings of the same name.

## Dataset refresh

[`.claude/agents/pokemon-tournament-cards.md`](../.claude/agents/pokemon-tournament-cards.md)
refreshes the legal pool. WebFetch was truncating ~90 cards/set; current
snapshot fetched directly from `raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data`.
2,693 cards, reg marks H/I/J, as of 2026-04-23.
