# Meta claims and external summaries

External AI summaries, articles, and social posts are useful prompts, but they
are not source data for TCGVibes. App-facing meta claims should come from the
checked-in snapshot pipeline under `src/data/metaSnapshots/` or from a fresh
documented refresh.

## Current checked-in snapshot

Latest research snapshot: `src/data/metaSnapshots/2026-05.json`

- Generated: 2026-05-09
- Window: 2026-04-20 through 2026-05-07
- Source style: 20 largest Standard Limitless events in the window, online-heavy
- Unknown/unmapped archetype share: 43.44%
- Matchup coverage share: 56.56%

Top mapped archetypes in the current snapshot:

| Archetype | Meta share | Sample |
| --- | ---: | ---: |
| dragapult-dudunsparce | 14.43% | 624 |
| dragapult-blaziken | 6.43% | 278 |
| festival-leads | 5.02% | 217 |
| rocket-mewtwo | 4.58% | 198 |
| cynthia-garchomp | 4.40% | 190 |
| lucario-ex | 4.37% | 189 |
| alakazam | 4.23% | 183 |
| mega-starmie-froslass | 3.40% | 147 |
| arboliva | 3.24% | 140 |
| crustle | 2.89% | 125 |

Mapped Dragapult variants currently sum to 20.86%. Because the snapshot has a
large unknown bucket, a generic external statement like "Dragapult is about
35%" may be directionally plausible, but it is not precise enough to encode in
the app without a refreshed source that maps the same archetype taxonomy.

## How to use external summaries

Do:

- Use them as a checklist for possible missing archetypes, rule assumptions,
  or deck-doctor advice.
- Compare them against `src/data/metaSnapshots/*.json`.
- Refresh the snapshot through `docs/META_SNAPSHOT_AGENT.md` when current
  recommendations need to change.
- Preserve caveats: date window, event mix, online/offline split, unknown
  archetype share, and sample size.

Do not:

- Hard-code rounded meta shares from unsourced prose.
- Replace checked-in snapshot values with a claim that uses a different
  taxonomy.
- Add cards/archetypes to AI playbooks solely because an external summary says
  they are popular.
- Treat a set-level legality list as authoritative when the app validates by
  regulation mark and resolved card object.

## Grok May 2026 summary comparison

The summary's broad format notes match the app's assumptions: post-rotation
Standard uses H/I/J+ regulation marks, G rotated out, and reprints are legal
when the resolved card has a legal mark.

The meta section is advisory only. In the current checked-in snapshot,
Dragapult variants are the top mapped family but not encoded as a 35% share.
Crustle is present and important as an anti-ex wall, but its mapped share is
2.89% in this online-heavy window. Any stronger claim should come from a new
snapshot refresh rather than direct prose ingestion.
