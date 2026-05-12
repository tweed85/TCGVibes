# Pokemon TCG Tournament-Legal Cards (Play! Pokemon Standard)

## Snapshot

| Field | Value |
| --- | --- |
| As-of date | 2026-04-23 |
| Region | North America |
| Governing body | Play! Pokemon (The Pokemon Company International) |
| Format | Standard |
| Rotation effective (in-person) | 2026-04-10 |
| Rotation effective (TCG Live) | 2026-03-26 |
| Legal regulation marks | H, I, J (and any future marks) |
| Rotated-out regulation marks | F, G |
| Banned cards in Standard | none (per official Play! Pokemon banned-card list) |

## Files in this directory

- `standard-legal-sets.json` — the authoritative list of standard-legal sets as of the as-of date, including each set's code, name, series, release date, and regulation mark. Also documents the banned-card list and source URLs.
- `tournament-legal-cards.json` — structured card data for every card retrieved whose regulation mark is H, I, or J. Top-level keys include `as_of_date`, `sources`, `per_set_counts`, `total_legal_cards_written`, `data_coverage_note`, and a `cards` array.
- `tournament-legal-cards.csv` — flattened spreadsheet view with columns: `name, set_code, set_name, number, rarity, regulation_mark, supertype, subtypes, hp, types`.

## Legal sets (16)

| Code | Name | Series | Release | Primary reg. mark |
| --- | --- | --- | --- | --- |
| sv4pt5 | Paldean Fates | Scarlet & Violet | 2024-01-26 | G (partial — only H/I/J reprints remain legal) |
| sv5 | Temporal Forces | Scarlet & Violet | 2024-03-22 | H |
| sv6 | Twilight Masquerade | Scarlet & Violet | 2024-05-24 | H |
| sv6pt5 | Shrouded Fable | Scarlet & Violet | 2024-08-02 | H |
| sv7 | Stellar Crown | Scarlet & Violet | 2024-09-13 | H |
| sv8 | Surging Sparks | Scarlet & Violet | 2024-11-08 | H |
| sv8pt5 | Prismatic Evolutions | Scarlet & Violet | 2025-01-17 | H |
| sv9 | Journey Together | Scarlet & Violet | 2025-03-28 | I |
| sv10 | Destined Rivals | Scarlet & Violet | 2025-05-30 | I |
| zsv10pt5 | Black Bolt | Scarlet & Violet | 2025-07-18 | I |
| rsv10pt5 | White Flare | Scarlet & Violet | 2025-07-18 | I |
| me1 | Mega Evolution | Mega Evolution | 2025-09-26 | I |
| me2 | Phantasmal Flames | Mega Evolution | 2025-11-14 | I |
| me2pt5 | Ascended Heroes | Mega Evolution | 2026-01-30 | I |
| me3 | Perfect Order | Mega Evolution | 2026-03-27 | J |
| svp | Scarlet & Violet Black Star Promos | Scarlet & Violet | rolling | mixed — only H/I/J promos remain legal |

Note: card legality in Standard is determined by the **regulation mark** printed on the card, not by set membership. Reprints of rotated cards in newer sets with an H, I, or J mark remain legal; conversely, G-marked reprints of cards that also appear in H-mark sets rotate out on 2026-04-10.

## Dataset coverage and caveats

**What is included:** every card from the `pokemon-tcg-data` GitHub mirror whose `regulationMark` is H, I, or J, plus all basic energies from the SVE subset (basic energies are always Standard-legal regardless of regulation mark).

The dataset was re-pulled directly from the upstream repo after the subagent run, which gives us full detail (attacks, abilities, retreat cost, weaknesses, resistances, rules text) on every card — the agent's original output was truncated by its `WebFetch` tool and was missing these fields.

**Known gaps:**
- Paldean Fates (sv4pt5) and early Black Star Promos (svp) are listed as legal sets but contribute only H/I/J-marked reprints; G-marked cards from those sets are correctly filtered out.

## Counts per set (cards written to outputs)

| Set | Cards written |
| --- | --- |
| sv4pt5 | 0 |
| sv5 | 218 |
| sv6 | 226 |
| sv6pt5 | 96 |
| sv7 | 167 |
| sv8 | 252 |
| sv8pt5 | 151 |
| sv9 | 189 |
| sv10 | 242 |
| zsv10pt5 | 171 |
| rsv10pt5 | 173 |
| me1 | 188 |
| me2 | 130 |
| me2pt5 | 295 |
| me3 | 124 |
| svp | 53 |
| sve (basic energies) | 18 |
| **Total** | **2,693** |

## Sources

- https://www.pokemon.com/us/pokemon-news/2026-pokemon-tcg-standard-format-rotation-announcement (2026 rotation announcement)
- https://www.pokemon.com/us/play-pokemon/about/pokemon-tcg-banned-card-list (current banned-card list — empty for Standard)
- https://www.pokemon.com/us/play-pokemon/about/mega-evolution/mega-evolution-perfect-order-banned-list-and-rule-changes-announcement
- https://www.pokemon.com/static-assets/content-assets/cms2/pdf/play-pokemon/rules/play-pokemon-tcg-tournament-handbook-en.pdf
- https://bulbapedia.bulbagarden.net/wiki/2026-27_Standard_format_(TCG)
- https://bulbapedia.bulbagarden.net/wiki/2025-26_Standard_format_(TCG)
- https://limitlesstcg.com/cards?q=reg%3Ah%2Ci%2Cj
- https://api.pokemontcg.io/v2/cards?q=set.id:<setId>
- https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master/ (static mirror of the above API data)

## How to refresh

The included per-set TXT and aggregation script live under `data/pokemon/.tmp/` during a refresh run and can be re-used. The canonical refresh flow is:

1. **Verify the legal set list.** Check the latest Play! Pokemon rotation announcement at `https://www.pokemon.com/us/play-pokemon/about/` and the TCG tournament handbook PDF. Compare against `https://bulbapedia.bulbagarden.net/wiki/Standard_format_(TCG)` and `https://limitlesstcg.com/` . Update the legal-sets list in `standard-legal-sets.json`.
2. **Check the banned-card list.** https://www.pokemon.com/us/play-pokemon/about/pokemon-tcg-banned-card-list .
3. **Pull all cards per legal set** from `https://api.pokemontcg.io/v2/cards?q=set.id:<setId>` with `pageSize=250`. Include the `X-Api-Key` header if `POKEMON_TCG_API_KEY` is in the environment. Paginate with `page` until `count < pageSize`. Retry failed requests with exponential backoff (2s, 4s, 8s — max 3 attempts). Verify `totalCount` matches the number of records written per set.
4. **Filter** to `legalities.standard == "Legal"` AND `regulationMark` in {H, I, J} AND the card not on the banned list.
5. **Write** consolidated outputs to `tournament-legal-cards.json` and `tournament-legal-cards.csv` in this directory. Keep the `as_of_date` and source URLs in every file.

If direct API access is unavailable, fall back to pulling static per-set JSON files from the `pokemon-tcg-data` GitHub repo:
`https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master/cards/en/<setCode>.json` .
