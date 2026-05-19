---
name: weekend-meta-refresh
description: Pull standings + pairings + archetype labels from Limitless labs and RK9 for new Regionals, re-aggregate the matchup matrix, and (when warranted) wire newly-emerged archetypes into the engine. Invoke after each weekend of competitive play.
---

# Weekend Meta Refresh

The Standard meta moves every weekend. This skill brings four data layers up to
date and wires anything new into the engine:

1. **Limitless labs standings** — ~512 ranked players per event with archetype
   labels. The primary signal for "what's the field running?"
2. **RK9 round-by-round pairings** — every game result (~7,000 pairings per
   1,500-player Regional). Joined with labs labels to produce the
   matchup matrix.
3. **Engine archetype detection** — `src/engine/aiArchetype.ts`. When labs
   surfaces a new archetype with significant share, wire it so the AI plays
   it correctly and DeckDoctor can grade it.
4. **Matchup aggregates** — `data/rk9-pairings/aggregates.json`. Wilson 95%
   CIs across all wired archetypes.

This file is the operator runbook AND the auditable trail for the data the
engine consumes. Don't skip phases — each one feeds the next.

## When to invoke

Whenever new Regional / International results land. Typical cadence: one
weekend per month during competitive season, every weekend during peak.

Invocation:
```
/weekend-meta-refresh <event-name-1> <event-name-2> ...
```

If the user doesn't provide event names, ask them (one short question with the
events you can see on rk9.gg / limitlesstcg.com from the past 14 days).

## Prerequisites

- Working directory: `/Users/tweed/Documents/TCGVibes`
- Node 18+ available (`node -v`)
- Network access to `labs.limitlesstcg.com` and `rk9.gg`
- Existing snapshot baseline: `data/rk9-pairings/labels.json` (manual top-cut
  labels — usually fine as-is) and `data/rk9-pairings/labs-*.json` (refreshed
  per event in Phase 2)

## Phase 1 — Discover IDs

Each event has TWO IDs we need to know — they don't share a numbering scheme.

### Limitless labs ID

Limitless labs IDs are sequential 4-digit numbers (e.g. `0063` for LA 2026).
**Don't trust user memory for these — labs IDs drift event-to-event and the
numbering doesn't always match official tournament order.** Probe directly:

```bash
# Probe a range of likely IDs; print the tournament title from each.
for id in 0061 0062 0063 0064 0065 0066 0067 0068 0069 0070; do
  echo -n "$id: "
  curl -sL -H "User-Agent: tcgvibes-snapshot-agent/1.0" \
    "https://labs.limitlesstcg.com/$id/standings" 2>/dev/null \
    | grep -oE '<title>[^<]*</title>' | head -1
done
```

Match titles against the events the user named. Verify before fetching — a
wrong labs ID corrupts the aggregator (the cross-event name-matching rate
drops to near-zero; see "labs-0061 was Querétaro, not Prague" mishap on
2026-05-19 for the canonical failure mode).

### RK9 tournament ID

RK9 IDs are alphanumeric strings (e.g. `LS01wQe8A4VHbkNmRSRG`). Find them by:

1. Visit `https://rk9.gg/tournaments/` and locate the event in the list.
2. Click into the event — the URL has the ID: `https://rk9.gg/tournament/<id>`.
3. The standings + pairings URL pattern uses this same `<id>`.

You can also `curl https://rk9.gg/tournaments/` and grep `href="/tournament/`
to harvest IDs programmatically.

### Pod number

For Masters (the only division we currently aggregate): **`pod=2`**.
Junior=0, Senior=1, Masters=2. The standings parser scopes to `id="P<n>-standings"`
markers — passing the wrong pod returns zero standings.

## Phase 2 — Fetch raw data

Run these per event, in parallel where possible. The fetchers are
politeness-throttled (250ms between RK9 requests) so they take a few minutes
per Regional.

```bash
# Labs standings (~512 players per event, fast).
node scripts/snapshot/fetch-limitless-labels.mjs <labs-id>

# RK9 pairings (all rounds + standings — slow, ~30-60s per event).
npm run snapshot:fetch-rk9 -- <rk9-id> --pod 2

# Decklists for every labs-ranked player (~2,000 across 4 Regionals,
# 100ms throttle ≈ 3-4 min). Resumable via the existing cache —
# re-running pulls only new URLs.
npm run snapshot:fetch-limitless-decklists
```

Labs / RK9 output goes to `data/rk9-pairings/` (gitignored). Labs output:
`labs-<labs-id>.json`. RK9 output: `<rk9-id>.json`. Decklists go to
`src/data/aggregates/decklists.json` (committed — runtime UI loads it).

**Sanity check after each fetch:** the JSON should have `playerCount` (labs)
or `standings.length` (RK9) close to the published field size. If a Regional
had 1,500 Masters players and RK9 returns 3,000+ standings, the pod scoping
is broken (cross-pod bleed) — fix the parser before continuing.

## Phase 3 — Aggregate the matchup matrix

```bash
npm run snapshot:aggregate-rk9
```

This walks every `*.json` in `data/rk9-pairings/` (excluding `labs-*`,
`labels`, `aggregates*`), joins pairings against the merged label set (manual
labels.json + auto labs-*.json files), and writes three files:

- `data/rk9-pairings/aggregates.json` — full output (gitignored cache)
- `src/data/aggregates/cells.json` — runtime matchup matrix (committed)
- `src/data/aggregates/pairings.json` — per-pairing records for the
   DeckDoctor drill-down + round filter (committed, ~1.9MB)

The committed files in `src/data/aggregates/` are what the UI imports.
Stage them after a refresh — they're how the runtime sees the new data.

Read the printed summary:
- `labeledPairings` — pairings where BOTH players had a label. Higher is better.
- `cells` — distinct (hero, villain) archetype matchup cells with ≥1 game.
- `uniqueLabeledPlayers` — players from the labs roster that actually appear
  in RK9 pairings. Below ~70% suggests a labs↔RK9 name-matching gap (re-check
  diacritic / stroked-letter handling).

## Phase 4 — Analyze unmapped coverage

The deciding question for this skill: did labs surface any new archetypes
worth wiring? Run:

```bash
node -e "
const fs = require('fs');
let totalPlayers = 0;
let unknownPlayers = 0;
const counts = {};
const files = fs.readdirSync('data/rk9-pairings/')
  .filter(f => f.startsWith('labs-') && f.endsWith('.json'));
for (const f of files) {
  const d = JSON.parse(fs.readFileSync('data/rk9-pairings/' + f, 'utf8'));
  totalPlayers += d.players.length;
  for (const p of d.players) {
    if (p.archetype === 'unknown' && p.archetypeSlug) {
      unknownPlayers++;
      counts[p.archetypeSlug] = (counts[p.archetypeSlug] ?? 0) + 1;
    }
  }
}
const mapped = totalPlayers - unknownPlayers;
console.log('Total labs players: ' + totalPlayers);
console.log('Mapped: ' + mapped + ' (' + (100*mapped/totalPlayers).toFixed(1) + '%)');
console.log('Unknown: ' + unknownPlayers + ' (' + (100*unknownPlayers/totalPlayers).toFixed(1) + '%)');
console.log();
console.log('Top 20 unmapped slugs:');
const sorted = Object.entries(counts).sort((a,b) => b[1] - a[1]);
for (const [slug, n] of sorted.slice(0, 20)) {
  console.log('  ' + n.toString().padStart(4) + '  ' + slug);
}
"
```

**Decision rule:**

- **≥ 20 players on a single labs slug not currently mapped** → strong
  candidate for wiring. Drives meaningful AI / DeckDoctor coverage.
- **10–19 players** → wire if the slug is durable (appeared in a previous
  event too). Skip if one-off.
- **< 10 players** → don't wire. Long-tail; not worth engine surface.
- **`other`** (Limitless's residual bucket) is never an archetype to wire.

Report the candidates to the user and confirm before proceeding to Phase 5.

## Phase 5 — Wire new archetypes (conditional)

Skip if Phase 4 found nothing wire-worthy. Otherwise, for **each** new
archetype, follow this checklist. Don't batch — wire one, run the detection
test, then move to the next. Each archetype touches the same 5 surfaces:

### 5a. Engine wiring (`src/engine/aiArchetype.ts`)

1. **Add slug to `Archetype` union** (top of file). Place new entries in a
   commented "Stage N expansion" block so the change is auditable.

2. **Add `SIGNATURES` entry** — 4 cards. **signature[0] must be a card unique
   to this archetype** (typically the headlining attacker). Cards 1-3 are
   secondaries and score 2 points each (signature[0] scores 5).

   **Insertion order matters for tie-breaking.** Place new entries AFTER any
   existing archetype that shares signature cards. Example: `dragapult-ex`
   shares `Dragapult ex / Drakloak / Dreepy` with `dragapult-blaziken` and
   `dragapult-dudunsparce` — `dragapult-ex` is placed last so the partner
   variants win the tie when their partner card (Blaziken ex / Dudunsparce ex)
   is present.

3. **Add `ARCHETYPE_PROFILES` entry** — minimal. Required fields:
   ```ts
   id: "<slug>",
   core: NO_CARDS, support: NO_CARDS, tech: NO_CARDS, optional: NO_CARDS,
   mainAttackers: ["<unique attacker>", ...],
   energyPlan: {
     attackers: [...same as mainAttackers],
     requiredTypes: ["Water", "Psychic"],  // basic energy types the attackers need
     acceleration: [...energy-accel cards if any],
     manualEnergyIsThinOk: true,           // ONLY for wall/control plans
   },
   notes: ["one-line plan description"],
   ```

   If the deck uses Ignition / Legacy / Tera energy to satisfy a type the
   `requiredTypes` check doesn't model, add `expectedExceptions` (see Crustle
   profile + starmie-dusknoir profile for templates).

4. **Add `PLAYBOOKS` entry** — minimal T1 / T2 / T3 cardBonus + abilityBonus.
   Copy the structure from a structurally-similar archetype (Stage-2 evolve
   decks → `dragapult-dudunsparce`; box decks → `mega-absol-box`; single-prize
   control → `slowking-scr`; Mega evolve → `lucario-ex`). T1 boosts evolve
   seed + signature stadium / tool; T2 boosts evolve targets + Lillie's
   Determination; T3 boosts attackers + Boss's Orders + ACE SPEC.

5. **Add bonus function cases** — 4 switch statements:
   - `archetypeTrainerBonus` — signature trainers (stadium, ACE SPEC, key supporter)
   - `archetypeAttachBonus` — energy-attach priority (lead attacker first)
   - `archetypeBenchBonus` — bench-drop priority (evolve seeds)
   - `archetypeAbilityBonus` — signature abilities only

   It's fine to leave any of these returning `0` if the archetype's plan is
   structurally similar enough to a generic deck — the playbook + signatures
   are the load-bearing piece. The bonus functions are for sustained
   archetype play beyond T3.

### 5b. Labs slug lookup (`scripts/snapshot/fetch-limitless-labels.mjs`)

Add the new engine slug to `labsSlugToEngineArchetype`. **Also add any labs
slug variants** — the labs URL slug doesn't always match the engine slug:

- `festival-leads` (engine) ← `festival-lead` (labs, singular)
- `cynthia-garchomp` (engine) ← `cynthia-garchomp-ex` (labs, -ex suffix)
- `lucario-ex` (engine) ← `lucario-hariyama` (labs, partner-card name)
- `mega-starmie-froslass` (engine) ← `starmie-froslass` (labs, dropped Mega)

After fetcher edit, refetch the labs files so the new mapping flows through:
```bash
for id in <each labs-id>; do
  node scripts/snapshot/fetch-limitless-labels.mjs $id
done
```

### 5c. Tests

Update three files. Don't skip any — they catch silent regressions:

1. **`src/engine/__tests__/archetypeDetection.test.ts`** — add a `CASES`
   entry with the synthetic signature card set and a confidence floor. Add a
   collision test if the new archetype shares signature cards with an
   existing one (template: see "does not confuse X with Y" tests).

2. **`src/data/__tests__/metaSnapshotIntegrity.test.ts`** — add the slug to
   `VALID_ARCHETYPES`. This guards snapshot JSON typos.

3. **`scripts/snapshot/__tests__/fetch-limitless-labels.test.mjs`** — add the
   slug under "maps wired labs slugs to engine archetypes". Remove from the
   "routes truly-unwired variants to 'unknown'" list if previously there.

### 5d. Verify per-archetype

After each archetype is wired:
```bash
npm run typecheck
npx vitest run src/engine/__tests__/archetypeDetection.test.ts
```

If detection picks the WRONG archetype for the new entry, the signature
ordering is wrong (or it scored lower than an existing archetype that
shouldn't have matched). Fix before moving on.

## Phase 6 — Verify the whole pipeline

```bash
npm run snapshot:aggregate-rk9   # re-aggregate with the new wirings
npm run typecheck                 # all-or-nothing
npm run test                      # 1078+ tests; baseline is ~10s
```

Re-run the Phase 4 unmapped analysis. Coverage should have jumped by the sum
of player counts of newly-wired slugs. If it didn't, an archetype is silently
misdetecting — debug by importing a labs decklist into DeckDoctor.

## Phase 7 — Report to the user

Always print:
- **Events processed** (names + dates)
- **Pairings added** (delta from previous aggregates if knowable, or absolute)
- **Coverage before → after** (% of labs-ranked players that map to a wired
  archetype)
- **New archetypes wired** (slug + signature[0] per entry)
- **Anomalies** (any per-event coverage < 70%, any new collision-test failures
  that needed creative resolution, any labs slug that the deciding rule
  punted on)

Don't commit unless the user explicitly asks. Per CLAUDE.md: "Only create
commits when requested by the user." Stage the changes and report them; the
user makes the merge call.

## Anti-patterns (do not do)

- **Don't add curated `DECK_SPECS` entries** as part of this skill. Adding a
  new preset deck for every wired archetype balloons `presetDeckSmoke.test.ts`
  (N² test pairs), and most archetypes don't have an authoritative
  decklist available without a deeper Limitless scrape. Engine detection
  works against any imported PTCGL list — preset decks are a separate
  feature.

- **Don't touch the meta snapshot JSON** (`src/data/metaSnapshots/*.json`)
  in this skill. Those are generated by the gitignored snapshot agent; this
  skill produces the labs / RK9 data that the agent consumes. Hand-editing
  the snapshot creates silent inconsistencies between `archetypes[].metaShare`
  and the matchup matrix.

- **Don't lower the confidence floor in `archetypeDetection.test.ts`** to make
  a flaky detection pass. If a signature scores below "high", the signature
  isn't distinctive enough — add a more-unique card to signature[0]
  instead.

- **Don't wire archetypes from the `other` bucket.** Limitless puts decks
  with no archetype label there; it isn't a real archetype.

- **Don't commit `data/rk9-pairings/`** — it's gitignored on purpose. The
  data is reproducible from the fetchers; carrying the files in git inflates
  history and creates merge conflicts on every refresh.

## Reference: prior labs ID → tournament mapping

Pinned so the next operator doesn't repeat the Querétaro mistake (2026-05-19):

| labs ID | Tournament |
|---|---|
| 0061 | Querétaro Regional 2026 |
| 0062 | Prague Regional 2026 |
| 0063 | Los Angeles Regional 2026 |
| 0064 | Utrecht Regional 2026 |
| 0065 | Campinas Regional 2026 |

Append to this table after each refresh.
