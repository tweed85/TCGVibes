# TCGVibes

A browser-based Pokémon TCG clone. Vite + React + TypeScript. Plays a human
vs. a simple AI, local hot-seat style, using the real Play! Pokémon
Standard-format card pool (North America, snapshot 2026-04-23).

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm run typecheck  # tsc -b --noEmit
npm run build
```

Node 18+ required.

## Layout

```
data/pokemon/                            # Card dataset (2,693 cards)
  tournament-legal-cards.json              ← imported by the engine
  tournament-legal-cards.csv
  standard-legal-sets.json
  README.md                                ← dataset provenance + refresh
.claude/agents/pokemon-tournament-cards.md # Subagent that refreshes the dataset

src/
  engine/                                # Pure rule logic, no React
    types.ts                               Card / game-state type definitions
    rules.ts                               Setup, mulligans, prizes, KO, Checkup,
                                             pokemonCheckup, endTurn/passTurn
    actions.ts                             Player actions: play/evolve/attach/
                                             retreat/attack/playTrainer/promote
    effects.ts                             Attack effect resolver (coin flips,
                                             per-energy, bench snipe, status, ...)
    trainerEffects.ts                      Trainer-card effect dispatch
    abilities.ts                           Ability detection + activation
    ai.ts                                  Greedy legal-move AI + promote picker
    rng.ts                                 Seeded mulberry32
  data/
    cards.ts                               Loads JSON, exports typed card list
    cardMapper.ts                          API-shape → engine-shape conversion
    effectPatterns.ts                      Regex patterns for attack text
    decks.ts                               Curated deck builder (6 archetypes)
  ui/CardView.tsx                        Card + Pokemon-in-play renderers
  App.tsx                                Main board + interaction glue
  styles.css
```

## Architecture notes

- **Card schema mirrors the Pokémon TCG API.** `cardMapper.ts` is the only
  translation layer; the rest of the engine uses engine types.
- **Effects are data-driven.** Attack text is regex-matched at load time
  (`effectPatterns.ts`) and attached as a structured `AttackEffect[]` on the
  Attack. The runtime resolver (`effects.ts`) dispatches on `kind`.
  Unmatched text is preserved as free-form `text` for display.
- **Trainer and ability effects follow the same pattern.** `detectTrainerEffect`
  and `detectAbilityEffect` return a narrow union; unknown effects just don't
  fire but the card still discards / displays.
- **RNG lives on `GameState`.** All coin flips and shuffles go through
  `state.rng` so games with the same seed are reproducible.
- **Turn flow handles paused states.** When an Active is KO'd, the engine
  sets `pendingPromote` + `phase = "promoteActive"` and queues what to run
  after the promote via `onPromoteResolved` ("endTurn" after an attack-KO,
  "passTurn" after a Checkup-KO). `promoteBenchToActive` dispatches on it.

## Rules implemented

- 60-card deck, max 4 per name (except basic energy)
- 7-card opening hand, mulligan for no-Basic + **opponent draws N extra**
- 6 Prizes; draw 1 per KO. **ex/V = 2 Prizes, VMAX/V-UNION = 3**
- 5-slot bench; active + bench zones
- 1 Energy attach / turn, 1 Supporter / turn, 1 retreat / turn
- **First player cannot attack or play a Supporter on T1**
- Weakness ×2, Resistance −N
- All 5 Special Conditions (Asleep, Burned, Confused, Paralyzed, Poisoned)
  with proper Pokémon Checkup processing + attack-time confusion flip
- Retreat + evolution clear special conditions
- Stadium zone (new Stadium replaces old, discards it)
- Pokémon Tool attach mechanic (max 1 per Pokémon; discarded with holder)
- **Mega Evolution rule: evolving into a Mega ends the turn**
- Bench KOs from snipe/recoil/status resolve with prize draws
- Player-picks-Active on KO (AI auto-picks highest HP)
- Win conditions: prizes=0, no Pokémon left, opponent can't draw

## Effect coverage across the 2,693-card pool

- **Attacks (3,373 total)** — 562 (17%) auto-wired. Patterns: flipHeadsBonus (55),
  flipTailsFizzle (21), flipHeadsDouble, perAttachedEnergy (33), benchSnipe (9),
  selfDamage (93), applyStatus (176), heal (52), discardOwnEnergy (88),
  drawCards (39).
- **Abilities (505 total; 179 activated)** — 37 auto-wired. Patterns: drawOne,
  drawTwo, healSelf, searchBasicEnergy, attachEnergyFromHand.
- **Trainers (399 total)** — staples wired: Professor's Research-style
  drawUntilSeven (7), Buddy-Buddy Poffin (5), Ultra Ball (3), Boss's Orders (3),
  Rare Candy (2 — interactive chooser still TODO), Potion, Energy Search.

## Known gaps (intentional MVP scope)

Displayed-but-not-evaluated effects the engine accepts in stride:
- Ultra Ball enforces its "discard 2" cost but auto-picks the first 2 hand
  cards (no chooser yet)
- Rare Candy needs an interactive Stage-2 chooser UI
- Stadium ongoing effects: HP boosts wired (Lively +30 Basic, Gravity
  Mountain -30 Stage 2). Not yet wired: once-per-turn Stadium activated
  effects (Lumiose City search, Levincia energy recovery, etc.), damage
  reduction (Full Metal Lab, Granite Cave), bench-size changes (Area Zero)
- Tool ongoing effects: HP boosts (Hero's Cape +100, Cynthia's Power Weight
  +70 for Cynthia's Pokémon, Ancient Booster +60 for Ancient) and retreat
  reductions (Air Balloon -CC, Rescue Board -C, Future Booster for Future)
  wired. Not yet wired: damage reduction Tools (Berries, Sacred Charm,
  Thick Scale), KO-triggered Tools (Amulet of Hope, Lucky Helmet, Survival
  Brace), damage-boost Tools (Maximum Belt, Brave Bangle, Light Ball, Hop's
  Choice Band)
- Passive abilities ("This Pokémon's attacks do +20") not evaluated
- Conditional attack bonuses ("if Stadium in play, +50")
- Bench-target picker for "1 of your opponent's Benched Pokémon" attacks
- Starter/bench setup phase (auto-places first Basic — no multi-basic layout)
- Hand-size 0 loss condition is covered by can't-draw, but no separate log for it
- No support for Lost Zone card effects (zone exists but unused)

## Decks available

Built from real card data in `src/data/decks.ts`. Each is 60 cards,
with evolution line, staple trainers, and matching basic energy:
Miraidon ex Lightning, Koraidon ex Fighting, Reshiram ex Fire,
Team Rocket's Mewtwo ex Psychic, Yveltal ex Darkness, Keldeo ex Water.

Card-name limits (max 4 except basic energy) are enforced by the builder.

## Dataset refresh

The `.claude/agents/pokemon-tournament-cards.md` subagent is set up to
re-pull the legal pool. The agent's WebFetch was truncating ~90 cards/set,
so the current snapshot was fetched directly from
`raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data` (see the Python
flow in recent shell history if re-running manually). 2,693 cards, reg
marks H/I/J, as of 2026-04-23.

## Conventions

- Comments explain **why**, not what. Leave identifiers to name themselves.
- No unnecessary error handling at internal boundaries; trust the engine.
- Keep UI dumb — all rule decisions live in `src/engine/`.
- Prefer editing existing files over adding new ones.
- `npm run typecheck` must pass before commit.

## Working branch

`claude/autonomous-agents-9wBMF`. All feature work lives here; `main` is
still the initial commit.
