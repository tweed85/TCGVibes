# Rules assumptions

TCGVibes is a Standard-format Pokemon TCG simulator, not a generic card-game
framework. These are the concrete rule assumptions the engine currently treats
as authoritative.

## Format legality

- The current Standard pool is loaded from `data/pokemon/` through
  `src/data/cards.ts`.
- Legal regulation marks come from the dataset metadata
  (`legal_regulation_marks`) and are exposed as `legalMarks`.
- Deck play validation rejects card objects with an explicit regulation mark
  outside the current pool. This is a defense-in-depth guard for stale saved
  imports; normal decklists resolve against the current legal dataset first.
- Legality follows the resolved card object's regulation mark, not just the
  name or set family. A pasted old printing may still resolve to a legal
  current reprint when the parser can safely match one.
- Deck size is exactly 60.
- A playable deck must contain at least one Basic Pokemon.
- The parser enforces the 4-per-name cap except Basic Energy, plus one
  Radiant Pokemon and one ACE SPEC card for today's supported formats.

## Game setup

- `setupGame()` creates shuffled player decks from resolved `Card[]` objects
  and starts at `phase = "coinFlip"`.
- `resolveCoinGuess()` records the coin result and winner.
- `chooseFirstPlayer()` deals opening hands, handles mulligans, and moves to
  setup.
- `completeSetup()` chooses Active/Bench Pokemon for each player and starts
  the first turn once both sides are complete.
- Opening setup requires a Basic Pokemon as Active; bench placement is capped
  at five Pokemon.

## Turn structure

- The active player draws at the start of their turn.
- Main-phase commands route through engine actions; React is only the command
  surface.
- The engine enforces one manual Energy attachment, one Supporter, and one
  retreat per turn.
- The first player cannot attack on their first turn and cannot play a
  Supporter on that turn unless a card-specific exception explicitly allows it.
- First-turn evolution and same-turn evolution gates live in the engine.

## Damage and KOs

- Damage is represented as integer damage points; one counter is 10 damage.
- The attack pipeline order is:
  base damage, attacker-side bonuses, attack-effect modifiers, Weakness,
  Resistance, defender-side reductions/survival effects, damage application,
  on-damage hooks, post-damage effects, KOs, prizes, and promotions.
- Weakness and Resistance apply only to Active Pokemon unless an effect
  explicitly says otherwise. Bench damage/counter placement generally bypasses
  Weakness and Resistance.
- Normal Pokemon give 1 Prize, Pokemon ex give 2, and Mega Evolution Pokemon
  ex give 3. Radiant Pokemon are still 1 Prize.
- Terminal KOs use `setPendingPromote()` so simultaneous/chained promotion
  queues are handled consistently.

## Special Conditions

- The engine models Asleep, Burned, Confused, Paralyzed, and Poisoned.
- Checkup applies condition damage/coin flips, then clears/updates turn-based
  condition state as appropriate.
- Retreat and evolution clear Special Conditions from the affected Pokemon.

## Determinism

- Gameplay randomness must use `state.rng`, never `Math.random()`.
- Undo stores serialized state plus RNG cursor.
- Replays store the initial seed and successful command stream; per-command
  RNG state is intentionally not recorded.

## Card-specific effects

- Card text is mapped in `src/data/cardMapper.ts`, with attack effects lazily
  detected by `getAttackEffects()`.
- Rule decisions belong in `src/engine/`; UI previews must read engine gates
  rather than reimplementing legality.
- Effects that require human choice should expose an explicit pending prompt,
  a `GameCommand` resolver for replay, and an AI auto-resolution path.

When changing any of these assumptions, update the relevant tests and docs in
the same PR.
