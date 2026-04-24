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

**Attack effects (3,373 total instances)** — ~25 kinds wired:
flipHeadsBonus, flipTailsFizzle, flipHeadsDouble, flipMultiCoinsPerHeads,
flipUntilTailsPerHeads, perAttachedEnergy, perFriendlyBench,
perOpponentBench, perBothBench, perDamageCounterOnSelf,
perDamageCounterOnDefender, perEnergyOnDefender, perPrizeOppTaken,
benchSnipe, snipeOne, selfDamage, applyStatus, heal, discardOwnEnergy,
drawCards, blockOppItemsNextTurn, selfCantAttackNextTurn,
defenderCantRetreatNextTurn, selfDamageReductionNextTurn, switchOutOpponent,
selfSwitch, discardOppEnergy, flipHeadsDiscardOppEnergy, healEachOwnPokemon,
discardTopOfOppDeck, discardOppTools, callForFamily.

**Abilities** (505 total; 179 activated-once-per-turn):
- Activated (wired by name/pattern): drawOne, drawTwo, drawN, healSelf,
  healAny, searchBasicEnergy, attachEnergyFromHand,
  attachEnergyFromDiscardToSelf, searchDeckAnyCard (Thwackey conditional),
  searchDeckPokemon, switchWithBench, shuffleSelfIntoDeck (Abra, Dudunsparce),
  peek2Top (Drakloak), oppShuffleHandAndDrawN (Gothitelle),
  attackBonusThisTurnSelfDamage (Feraligatr).
- Triggered-on-evolve: Jewel Seeker (Noctowl + Tera gate), Psychic Draw
  (Alakazam/Kadabra), Heave-Ho Catcher (Hariyama), Prison Panic
  (Brambleghast), Energized Steps (Grumpig), Cast-Off Shell (Ninjask),
  Multiplying Cocoon (Silcoon), Haphazard Hammer (Tinkatuff),
  Emergency Evolution (Pidove).

**Trainers (399 total)** — ~60+ effects wired across Items, Supporters,
Stadiums, Tools. Coverage includes: all 6 preset-deck staples, discard
recovery (Night Stretcher, Energy Retrieval, Lana's Aid, Tarragon),
search (Nest/Poké/Master/Ultra Ball, Poffin, Tera Orb, Mega Signal, Hop's
Bag, Fighting Gong, TM Machine, etc.), heals (Potion, Super Potion,
Arven's Sandwich, Lumiose Galette, Jumbo Ice Cream, Cook, Pokémon Center
Lady, Jacinthe, Clemont's, Fennel, Bianca's Devotion, Poké Vital A),
disruption (Enhanced/Crushing Hammer, Hand Trimmer, Hole-Digging Shovel,
Tool Scrapper, Xerosic's Machinations, Ruffian, Eri, Dangerous Laser),
gusts (Boss's Orders, Pokémon Catcher, Prime Catcher, Repel, Lisia's
Appeal), turn-scoped (Black Belt's Training, Premium Power Pro, Jasmine's
Gaze, Iron Defender), Rare Candy (interactive Stage-2 chooser).

**Stadiums (42 total)** — 12+ passives wired:
Lively Stadium, Gravity Mountain, Full Metal Lab, Granite Cave,
Neutralization Zone, Postwick, N's Castle, Paradise Resort, Jamming
Tower, Team Rocket's Watchtower, Area Zero Underdepths, Festival
Grounds, Battle Cage, Risky Ruins, Perilous Jungle, Dizzying Valley,
Forest of Vitality, Nighttime Mine.

**Tools (47 total)** — ~18 wired:
HP: Hero's Cape, Cynthia's Power Weight, Ancient Booster Energy Capsule.
Retreat: Air Balloon, Rescue Board, Future Booster Energy Capsule.
Damage boost: Maximum Belt, Brave Bangle, Light Ball, Hop's Choice Band,
Binding Mochi.
Berry reductions + auto-discard: Occa, Passho, Babiri, Colbur, Payapa,
Haban. Thick Scale (Dragon).
Cost: Counter Gain, Sparkling Crystal.
On-damage: Lucky Helmet, Punk Helmet, Team Rocket's Hypnotizer, Deluxe
Bomb.
KO-triggered: Survival Brace (damage cap), Lillie's Pearl (-1 prize),
Amulet of Hope (search 3), Heavy Baton (Energy move on retreat-cost-4 KO).
End-of-turn: Powerglass.

## Test suite

Vitest — **111 tests across 6 files** in `src/engine/__tests__/` and
`src/data/__tests__/`. Covers energy-cost matching, Stadium+Tool
passive modifiers, full-game setup+coin-flip+checkup flow, trainer-effect
detection against the live dataset, and attack-text pattern detection for
every wired AttackEffect kind.

Run with `npm run test` or watch mode `npm run test:watch`.

## Known gaps (intentional MVP scope)

- Ultra Ball auto-picks the first 2 hand cards to discard (no chooser).
- Stadium once-per-turn activated effects (Academy at Night, Community
  Center, Levincia, Lumiose City, Mystery Garden, Spikemuth Gym, Surfing
  Beach, Team Rocket's Factory, Grand Tree) need a per-turn Stadium
  button UI — not wired.
- Fossil "play as 60-HP Basic" mechanic not modeled (Antique Cover/Jaw/
  Plume/Root/Sail Fossil).
- Some multi-step interactive Supporters auto-pick rather than prompt
  (Perrin, Cassiopeia, Salvatore, Colress's Tenacity sequential picks).
- A few niche KO/damage-trigger Tools skipped (Handheld Fan energy return,
  Heavy Baton auto-target is primitive).
- Bench-target picker for attacks that say "1 of your opponent's Benched
  Pokémon" (snipeOne currently auto-targets most-damaged).
- Prize-pick UI (player always takes top prize; no effect on gameplay
  since no wired card reveals/manipulates prize identity).
- Passive attack-modifying abilities ("This Pokémon's attacks do +20")
  not evaluated.

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
