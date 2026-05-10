# Supporter Effect Audit

Last updated: 2026-05-10

This audit covers the 74 unique Standard-pool Supporter names in
`data/pokemon/tournament-legal-cards.json`, with implementation checked against
`src/engine/trainerEffects.ts`.

## Rule

For human-controlled players, a Supporter must not silently choose a meaningful
card, Pokemon, Energy, or branch when the physical card asks the player to
choose. AI may keep deterministic heuristics, but human paths should open a
picker or an explicit branch control.

## Fixed In This Pass

- **Crispin**: now opens a two-step Energy picker. The player chooses which
  basic Energy goes to hand, then chooses a different-type basic Energy to
  attach, then clicks the receiving Pokemon.
- **Kofu**: now asks the player which 2 hand cards go to the bottom before
  drawing 4.
- **Explorer's Guidance**: now asks which 2 of the top 6 go to hand; the rest
  are discarded.
- **Ciphermaniac's Codebreaking**: now asks which 2 deck cards go on top
  instead of taking the first 2.

These are pinned in `src/engine/__tests__/mvpPickers.test.ts`.

## Already Interactive / Acceptable

- Search pickers: Boss's Orders, Brock's Scouting, Colress's Tenacity, Cyrano,
  Dawn, Drayton, Eri, Ethan's Adventure, Hassel, Hilda, Lana's Aid, Larry's
  Skill, Lisia's Appeal, Naveen, Perrin, Raifort, Salvatore, Team Rocket's
  Petrel, Team Rocket's Proton, Xerosic's Machinations where modeled as a hand
  discard picker, and similar deck/discard searches.
- Target pickers: Jacinthe, N's Plan, Poké Vital A, Wally's Compassion, and
  other already-wired in-play target flows.
- No-choice draw/shuffle/heal/modifier Supporters: Judge, Lacey, Lillie's
  Determination, Carmine, Drasna, Fennel, Jasmine's Gaze, Black Belt's
  Training, Roxie's Performance, etc.

## Remaining High-Priority Choice Debt

- **Kieran**: the engine auto-selects damage vs switch. Human players need a
  branch choice, then a switch picker when they choose switch.
- **AZ's Tranquility**: human path opens the switch picker but the heal-80
  follow-up is still documented as a TODO. This is a correctness bug.
- **Janine's Secret Art**: auto-selects Darkness targets. Needs per-target
  attachment choice for humans.
- **Philippe**: auto-selects the Metal Pokemon target. Needs a target picker.
- **Rosa's Encouragement**: auto-selects the Stage 2 target and attached
  Energy. Needs target picker and Energy count/choice.
- **Acerola's Mischief**: approximates the effect as broad next-turn damage
  prevention. Needs a single chosen Pokemon target and exact ex-only prevention.
- **Team Rocket's Giovanni**: auto-selects both own switch target and opposing
  gust target. Needs chained pickers.

## Remaining Medium-Priority Approximations

- **Waitress**: top-6 Basic Energy attach still auto-attaches to Active. Needs
  top-card Energy choice and target picker if the card text allows any Pokemon.
- **Firebreather / searchBasicEnergyN**: currently searches any basic Energy
  rather than enforcing the named type for each detected card.
- **Energy Search Pro**: auto-takes one of each type. Human path should allow
  choosing any number of different basic Energy types.
- **Accompanying Flute**: auto-benches every eligible opposing Basic from top 5.
  The player should choose which Basic Pokemon to bench.
- **Briar / Anthea & Concordia**: currently logged as visual-only. Needs the
  prize-taking hook or should be blocked from claiming support.

## Follow-Up Plan

1. Add branch-choice infrastructure for Supporters with "Choose 1" text
   (Kieran first).
2. Add reusable "pick Energy, then pick target" helpers for Janine, Philippe,
   Rosa, Waitress-like flows.
3. Replace broad turn flags with target-scoped prevention/bonus state for
   Acerola's Mischief and prize-bonus Supporters.
4. Keep adding one regression test per Supporter moved out of approximation.

