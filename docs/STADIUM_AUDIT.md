# Stadium audit

Audit date: May 10, 2026.

Scope: all Standard-format Stadium names in `data/pokemon/tournament-legal-cards.json`
and their implementation paths in `src/engine/actions.ts`,
`src/engine/stadiumActivated.ts`, `src/engine/ongoingEffects.ts`,
`src/engine/effects.ts`, and `src/engine/rules.ts`.

## Inventory

The current dataset contains 29 unique Standard Stadium names:

- Academy at Night
- Ange Floette
- Area Zero Underdepths
- Battle Cage
- Community Center
- Dizzying Valley
- Festival Grounds
- Forest of Vitality
- Full Metal Lab
- Grand Tree
- Granite Cave
- Gravity Mountain
- Jamming Tower
- Levincia
- Lively Stadium
- Lumiose City
- Mystery Garden
- N's Castle
- Neutralization Zone
- Nighttime Mine
- Paradise Resort
- Perilous Jungle
- Postwick
- Prism Tower
- Risky Ruins
- Spikemuth Gym
- Surfing Beach
- Team Rocket's Factory
- Team Rocket's Watchtower

## Current coverage

Stadium play/replacement is centralized in `playTrainer()`:

- blocks playing a Stadium with the same name as the current Stadium
- discards the replaced Stadium to its controller's discard pile
- sets `state.stadium = { card, controller }`
- sweeps KOs after HP-shrinking Stadiums
- trims both benches back to 5 when Area Zero Underdepths leaves play

Passive Stadium coverage is broad:

- HP modifiers: Lively Stadium, Gravity Mountain, Ange Floette
- bench size: Area Zero Underdepths
- bench placement damage: Risky Ruins
- bench protection: Battle Cage
- status immunity/persistence: Festival Grounds, Dizzying Valley
- evolution exception: Forest of Vitality
- retreat modifiers: N's Castle, Paradise Resort
- ability/tool suppression: Team Rocket's Watchtower, Jamming Tower
- attack modifiers: Postwick, Nighttime Mine
- damage reduction/prevention: Full Metal Lab, Granite Cave, Neutralization Zone
- checkup poison modifier: Perilous Jungle

Activated Stadium framework exists in `stadiumActivated.ts` and is shared with
preflight via `precheckStadium()`. Implemented activated Stadiums:

- Academy at Night
- Community Center
- Levincia
- Lumiose City
- Mystery Garden
- Grand Tree
- Spikemuth Gym
- Surfing Beach
- Team Rocket's Factory
- Prism Tower

## High-priority correctness risks

### Activated Stadium choice debt

Several activated Stadiums currently auto-pick the first legal card or target.
That is acceptable for AI shortcuts, but it is not correct for human play:

- Academy at Night: must choose which hand card goes on top of the deck.
- Levincia: must choose up to 2 Basic Lightning Energy from discard.
- Mystery Garden: must choose which Energy to discard.
- Grand Tree: must choose the Basic in play, then the Stage 1, then optionally
  the Stage 2.
- Surfing Beach: must choose which Benched Water Pokémon switches Active.
- Prism Tower: must choose which 2 hand cards to discard.

Lumiose City and Spikemuth Gym already use deck-search picker plumbing, so they
are in better shape than the auto-pick Stadiums.

### Ange Floette play exception

Ange Floette has two unusual pieces of text:

- it can only be played by discarding Prism Tower from play
- it can be played even if Prism Tower was played during the same turn

The HP passive for Mega Floette ex is implemented in `effectiveMaxHp()`, but the
special play restriction/exception is not represented in `playTrainer()`.

### Battle Cage semantics

Battle Cage should prevent damage counters placed on Benched Pokémon by effects
of attacks and abilities from the opponent's Pokémon. It should not prevent
ordinary attack damage done to Benched Pokémon.

The engine currently exposes this as `benchDamageBlocked()`, and several call
sites describe it as blocking bench damage. Audit each use before changing it:
some call sites are counter-placement effects and are correct; any true
bench-damage attack path should remain damage, not be blocked by Battle Cage.

### Grand Tree first-turn gate

Grand Tree currently checks `state.turn === 1`. The engine has player-specific
first-turn logic elsewhere, and Grand Tree should use the same per-player rule
gate. This matters in local/hot-seat or any future nonstandard setup sequence
where global turn number and player first-turn status diverge.

### Area Zero trim ordering

The engine trims both players' benches from the end when Area Zero Underdepths
leaves play or a player no longer has a Tera Pokémon. That is deterministic and
safe, but exact table behavior can require player choice and/or a controller
ordering decision. If Area Zero precision becomes important, promote this to a
pending choice instead of silently trimming newest bench entries.

### Neutralization Zone discard restriction

Neutralization Zone's attack-damage prevention is implemented. Its text also
prevents the Stadium from being put into a player's hand or deck from the
discard pile. Recovery effects that move Trainers/Stadiums out of discard
should explicitly exclude it.

## Recommended implementation order

1. Add human picker plumbing for the simple activated Stadiums:
   Academy at Night, Prism Tower, Mystery Garden, Surfing Beach, Levincia.
2. Add tests that each activated Stadium uses a picker for humans while AI can
   still auto-resolve through the existing shortcut path.
3. Fix Grand Tree with a multi-step pending flow and the shared first-turn gate.
4. Implement Ange Floette's Prism Tower replacement requirement and same-turn
   exception.
5. Pin Battle Cage with two integration tests: one counter-placement effect
   blocked, one true bench-damage attack not blocked.
6. Add a Stadium inventory guard test similar to the broader effect audit so
   newly added Stadium names must be triaged.

## Test targets

Existing useful suites:

- `src/engine/__tests__/ongoingEffects.test.ts`
- `src/engine/__tests__/preflightContract.test.ts`
- `src/engine/__tests__/mvpPickers.test.ts`
- `src/engine/__tests__/auditFixes.test.ts`

New focused tests should live near the behavior they protect:

- passive modifier tests in `ongoingEffects.test.ts`
- activated Stadium picker tests in `mvpPickers.test.ts` or a new
  `stadiumActivated.test.ts`
- Stadium play/replacement tests near `trainerRules.test.ts` or a new
  `stadiumRules.test.ts`
