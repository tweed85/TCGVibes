# Item audit

Audit date: May 10, 2026.

Scope: all Standard-format Trainer cards with subtype `Item`, excluding
`Pokémon Tool`, in `data/pokemon/tournament-legal-cards.json`. Implementation
paths reviewed: `src/engine/actions.ts`, `src/engine/trainerEffects.ts`,
`src/engine/pendingPick.ts`, and targeted engine tests.

## Inventory

The current dataset contains 82 unique Standard Item names:

- Accompanying Flute
- Antique Cover Fossil
- Antique Jaw Fossil
- Antique Plume Fossil
- Antique Root Fossil
- Antique Sail Fossil
- Arven's Sandwich
- Awakening Drum
- Big Catching Net
- Blowtorch
- Boxed Order
- Brilliant Blender
- Buddy-Buddy Poffin
- Bug Catching Set
- Call Bell
- Chill Teaser Toy
- Crushing Hammer
- Dangerous Laser
- Deduction Kit
- Dragon Elixir
- Dusk Ball
- Energy Coin
- Energy Recycler
- Energy Retrieval
- Energy Search
- Energy Search Pro
- Energy Swatter
- Energy Switch
- Enhanced Hammer
- Fighting Gong
- Glass Trumpet
- Hand Trimmer
- Hole-Digging Shovel
- Hop's Bag
- Hyper Aroma
- Iron Defender
- Jumbo Ice Cream
- Love Ball
- Lumiose Galette
- Master Ball
- Max Rod
- Meddling Memo
- Mega Signal
- Megaton Blower
- Miracle Headset
- N's PP Up
- Night Stretcher
- Ogre's Mask
- Poké Ball
- Poké Pad
- Poké Vital A
- Pokégear 3.0
- Pokémon Catcher
- Potion
- Precious Trolley
- Premium Power Pro
- Prime Catcher
- Rare Candy
- Reboot Pod
- Redeemable Ticket
- Repel
- Roto-Stick
- Sacred Ash
- Scoop Up Cyclone
- Scramble Switch
- Secret Box
- Special Red Card
- Strange Timepiece
- Super Potion
- Switch
- Team Rocket's Bother-Bot
- Team Rocket's Great Ball
- Team Rocket's Transceiver
- Team Rocket's Venture Bomb
- Tera Orb
- TM Machine
- Tomes of Transformation
- Tool Scrapper
- Treasure Tracker
- Ultra Ball
- Unfair Stamp
- Wondrous Patch

Every Item name above is recognized by name in `trainerEffects.ts`. That does
not mean every Item is fully faithful: several are simplified, auto-targeted,
or missing a player-choice prompt.

## Current coverage

Strong coverage areas:

- Deck search to hand: Energy Search, Fighting Gong, Hyper Aroma, Master Ball,
  Mega Signal, Poké Ball, Poké Pad, Team Rocket's Great Ball, Team Rocket's
  Transceiver, Tera Orb, TM Machine, Treasure Tracker.
- Deck search to bench: Buddy-Buddy Poffin, Hop's Bag, Nest Ball-like path,
  Precious Trolley.
- Top/bottom peek search: Bug Catching Set, Dusk Ball, Pokégear 3.0.
- Discard recovery to hand: Energy Retrieval, Max Rod, Miracle Headset, Night
  Stretcher.
- Search/discard ACE SPECs: Brilliant Blender, Secret Box.
- Switch/gust basics: Switch, Pokémon Catcher, Repel, Scoop Up Cyclone,
  Energy Switch.
- Healing Items: Potion, Super Potion, Arven's Sandwich, Dragon Elixir,
  Jumbo Ice Cream, Lumiose Galette, Poké Vital A.
- Energy denial: Crushing Hammer, Enhanced Hammer, Tool Scrapper, Megaton
  Blower.
- Rule/turn gates: Rare Candy, Secret Box, Special Red Card, Unfair Stamp,
  Call Bell.
- Fossils: Antique Fossils play as 60-HP Basic Colorless Pokémon with Fossil
  status/retreat protections.

The engine already uses human pickers for many meaningful choices:

- Ultra Ball discard-two hand picker, then Pokémon search
- Rare Candy target + Stage 2 choice
- Potion and Super Potion target pickers
- Energy Switch two-step source/destination picker
- Tool Scrapper repeat target picker
- Enhanced Hammer / Crushing Hammer target pickers
- Wondrous Patch target picker
- Secret Box discard cost + chained category searches
- Max Rod / Night Stretcher / Energy Retrieval discard-recovery pickers

## High-priority correctness risks

### Item choice debt

These Items currently auto-pick cards or targets for humans and should get
picker flows:

- Accompanying Flute: should reveal opponent's top 5, then the activating
  player chooses any number of Basic Pokémon found there to bench.
- Big Catching Net: should choose up to 3 Water Pokémon / Basic Water Energy
  from discard instead of auto-recycling Pokémon first.
- Blowtorch: should choose the discard target among opposing Tools, opposing
  Special Energy, or Stadium after paying the Fire Energy cost.
- Chill Teaser Toy: should choose which opposing Pokémon's Energy returns to
  hand.
- Deduction Kit: should choose top-3 reorder or bottom-shuffle mode; currently
  only logs the look.
- Energy Recycler: should choose up to 5 Basic Energy from discard.
- Energy Search Pro: should choose which Basic Energy types to take.
- Energy Swatter: should reveal opponent hand and choose the Energy to bottom.
- Glass Trumpet: should choose up to 2 Benched Colorless targets and the
  discard Energy attached to each.
- N's PP Up: should choose the Benched N's Pokémon and Basic Energy.
- Precious Trolley: should choose which Basic Pokémon to bench, respecting
  remaining bench slots.
- Prime Catcher: should choose both the opposing gust target and own switch
  target.
- Reboot Pod: should choose/assign Basic Energy to each Future Pokémon when
  multiple discard Energy are available.
- Sacred Ash: should choose up to 5 Pokémon from discard.
- Scramble Switch: should choose the switch target and how much Energy moves to
  the new Active.
- Strange Timepiece: should choose which evolved Psychic Pokémon and how many
  Evolution cards to remove.
- Tomes of Transformation: should choose the Basic Pokémon in discard and the
  Basic Pokémon in play; current path auto-picks after consuming the second
  Tomes.

### Simplified or cosmetic Items

These are recognized but only approximated:

- Deduction Kit does not reorder cards or put shuffled cards on bottom.
- Team Rocket's Bother-Bot reveals/logs information but does not track face-up
  Prize state and auto-declines the prize/hand-card swap.
- Prime Catcher now opens a chained gust + optional self-switch picker for
  human players (with `skipPrimeCatcherSelfSwitch` for replay).
- Scramble Switch now opens a switch-target picker for humans, but the
  Energy transfer step is an APPROXIMATION: the engine always moves *all*
  Energy from the previous Active. Card text says "you may move any
  amount of Energy" — the granular per-Energy choice is deferred until a
  generic energy-selection prompt lane lands.
- Accompanying Flute benches every eligible Basic found until bench is full,
  rather than letting the player choose any number.

### Precheck gaps

Some Items still rely on "play and log no effect" behavior when no legal
candidate exists. That is less harmful than Supporter drift because Items are
not once-per-turn, but it still makes hand dimming and player feedback weaker.
Good candidates for shared prechecks:

- discard recovery/recycle: Big Catching Net, Energy Recycler, Energy Retrieval,
  Sacred Ash
- target-heavy Items: Accompanying Flute, Blowtorch, Chill Teaser Toy,
  Energy Swatter, Glass Trumpet, N's PP Up, Scramble Switch, Strange Timepiece
- deck search with hard costs: Boxed Order, Call Bell, Energy Coin,
  Energy Search Pro, Precious Trolley

### Engine determinism

`Accompanying Flute` previously created benched Pokémon with `Math.random()`.
That has been removed in favor of the shared `makePokemonInPlay()` path. The
remaining non-test `Math.random()` call sites are outside this Item audit, but
they should be reviewed separately because gameplay randomness should come from
`state.rng`.

## Recommended implementation order

1. Add focused picker tests for the most-played/highest-impact Items:
   Prime Catcher, Scramble Switch, Glass Trumpet, Energy Search Pro,
   Precious Trolley.
2. Fix Prime Catcher and Scramble Switch first. Both can swing games and are
   currently heuristic-heavy.
3. Convert the discard/recycle Items to `setDiscardRecoveryPick()`-style flows:
   Energy Recycler, Sacred Ash, Big Catching Net.
4. Add reveal/choice flows for opponent-hand/top-deck Items:
   Accompanying Flute, Energy Swatter, Team Rocket's Bother-Bot.
5. Add preflight contract cases for Item-specific prechecks once those helpers
   are shared with `precheckTrainerEffect()`.
6. Add an Item inventory guard test so every new Standard Item name must be
   classified as full, approximate, or intentionally unsupported.

## Test targets

Existing useful suites:

- `src/engine/__tests__/trainerDetection.test.ts`
- `src/engine/__tests__/mvpPickers.test.ts`
- `src/engine/__tests__/auditFixes.test.ts`
- `src/engine/__tests__/auditFixes2.test.ts`
- `src/engine/__tests__/integration.test.ts`

Suggested new/expanded suites:

- `src/engine/__tests__/itemAudit.test.ts` for high-risk Item behavior pins
- `src/engine/__tests__/preflightContract.test.ts` for Item precheck parity
- `src/engine/__tests__/replay.test.ts` coverage for command-resolvable Item
  prompts once Prime Catcher / Scramble Switch gain multi-step prompt flows
