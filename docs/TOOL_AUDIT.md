# Tool Card Audit

Last updated: 2026-05-10

This audit covers the 34 unique Standard-pool Pokémon Tool names in
`data/pokemon/tournament-legal-cards.json`, checked against
`src/engine/actions.ts`, `src/engine/ongoingEffects.ts`,
`src/engine/rules.ts`, `src/engine/preflight.ts`, and
`src/engine/trainerEffects.ts`.

## Rule

Tool attachment and Tool-trigger effects should keep the engine authoritative:

- playing a Tool requires a legal in-play target with an open Tool slot;
- passive Tool math must be shared by attacks, previews, AI estimates, and
  legality checks;
- human-controlled triggered Tool effects must not silently choose a target,
  Energy, or searched card when the card text asks the player to choose;
- AI may keep deterministic heuristics as long as human paths stay interactive.

## Current Coverage

General attachment is implemented in `playTrainer`:

- Tools must be attached to one of your Pokémon in play.
- A target with an existing Tool is rejected.
- Rotom/Multi Adapter can raise the cap to 2 Tools.
- Tool play is blocked by opponent Active lock effects.
- ACE SPEC blocking via Genesect's ACE Nullifier is checked before attach.
- Ancient Booster Energy Capsule clears statuses on attach when attached to an
  Ancient Pokémon.

Passive and triggered Tool effects currently covered:

- **HP modifiers**: Hero's Cape, Cynthia's Power Weight, Ancient Booster Energy
  Capsule.
- **Retreat modifiers**: Air Balloon, Rescue Board, Future Booster Energy
  Capsule, Gravity Gemstone.
- **Attack-cost modifiers**: Counter Gain, Sparkling Crystal, Hop's Choice Band.
- **Attack grants**: Core Memory, Technical Machine: Fluorite.
- **Damage bonuses**: Maximum Belt, Brave Bangle, Light Ball, Hop's Choice Band,
  Binding Mochi, Future Booster Energy Capsule.
- **Damage reductions**: Occa Berry, Passho Berry, Babiri Berry, Colbur Berry,
  Payapa Berry, Haban Berry, Thick Scale, Sacred Charm.
- **On-damage triggers**: Lucky Helmet, Punk Helmet, Team Rocket's Hypnotizer,
  Deluxe Bomb, Handheld Fan.
- **KO / would-KO triggers**: Survival Brace, Lillie's Pearl, Amulet of Hope,
  Heavy Baton.
- **End-turn trigger**: Powerglass.
- **Self-discarding TM cleanup**: Technical Machine tools discard at end turn.

Pinned test coverage already exists across:

- `src/engine/__tests__/ongoingEffects.test.ts`
- `src/engine/__tests__/auditFixes.test.ts`
- `src/engine/__tests__/auditFixes2.test.ts`
- `src/engine/__tests__/mvpPickers.test.ts`
- `src/engine/__tests__/koCause.test.ts`

## Fully Or Mostly Covered Tools

- Air Balloon
- Ancient Booster Energy Capsule
- Babiri Berry
- Binding Mochi
- Brave Bangle
- Colbur Berry
- Core Memory
- Counter Gain
- Cynthia's Power Weight
- Deluxe Bomb
- Future Booster Energy Capsule
- Gravity Gemstone
- Haban Berry
- Heavy Baton
- Hero's Cape
- Hop's Choice Band
- Light Ball
- Lillie's Pearl
- Lucky Helmet
- Maximum Belt
- Occa Berry
- Passho Berry
- Payapa Berry
- Punk Helmet
- Rescue Board
- Sacred Charm
- Sparkling Crystal
- Survival Brace
- Team Rocket's Hypnotizer
- Technical Machine: Fluorite
- Thick Scale

## High-Priority Choice Debt

All three flagged Tools now have full picker fidelity for human players.

- **Handheld Fan** (fixed): defers the auto-move when the defender is human
  + the attacker has 2+ bench. The defender picks one of the attacker's
  Benched Pokémon to receive the Energy. The attacker's `endTurn` is gated
  on the picker resolving (mirrors the Heavy Baton pause-and-resume pattern).
  Energy auto-pick is preserved (first attached) — the destination is the
  meaningful choice the audit cared about.
- **Powerglass** (fixed): end-of-turn picker over basic Energy in discard
  with `min: 0, max: 1`. Pauses `endTurn` via a `finishEndTurn(state)`
  refactor so the rest of the end-turn body (Ignition / TM cleanup,
  flag resets, Pokémon Checkup, `passTurn`) only runs after the picker
  resolves. AI keeps the existing first-Energy auto-attach.
- **Amulet of Hope** (fixed): post-promote deck-search picker (max 3) for
  human owners. The picker opens after `promoteBenchToActive` completes,
  so KO/promote/Heavy Baton ordering stays stable. AI keeps the existing
  priority-based auto-search (Basic → Supporter → Pokémon → Energy).

## High-Priority Correctness Debt

- **Sacred Charm / Thick Scale / Berry reductions in previews and AI**: damage
  resolution uses the shared reduction helpers, but any future refactor must
  keep `estimateAttackDamage()` aligned. These should remain in contract tests
  because Tool reductions change both user previews and AI move selection.
- **Rescue Board remaining HP**: current logic checks `holder.card.hp -
  holder.damage`. If a future legal path allows Rescue Board plus HP modifiers
  on the same holder, this should use effective max HP. With the current one
  Tool rule, the risk is mostly Rotom/Multi Adapter edge cases.
- **Heavy Baton trigger gate**: current code gates on printed retreat cost
  length exactly 4. Confirm against official rulings whether "has a Retreat
  Cost of exactly 4" means printed cost or effective cost after modifiers.

## Unimplemented / Approximate Tools

- **Technical Machine: Fluorite**: attack and discard are implemented; keep
  future TM tools explicit rather than assuming every TM shares Fluorite's
  cleanup/effect shape.
- **Core Memory**: Geobuster is implemented for Mega Zygarde ex; any future
  tool-granted attack should be added explicitly with a focused test.

## Low-Priority / Metadata Notes

- `docs/EFFECTS.md` now links to this audit and uses the current 34-name
  Standard Tool count. A future contract test should generate/check that count
  automatically.
- Most Tool cards are not represented by `TrainerEffectId` because passive
  Tools are handled by `actions.ts` / `ongoingEffects.ts`, not
  `applyTrainerEffect`. That is fine, but tests should keep checking behavior,
  not detection ids.

## Follow-Up Plan

1. Add a reusable post-damage Tool prompt lane for defender-owned choices.
   Start with Handheld Fan.
2. Add an end-turn optional-effect prompt for Powerglass: choose/decline Basic
   Energy from discard.
3. Move Amulet of Hope from auto-search to a post-KO deck-search picker that
   opens after prize/payment/promotion ordering is stable.
4. Add a Tool audit contract test that inventories all 34 Standard Tools and
   classifies each as covered, approximate, or intentionally passive.
5. Update `docs/EFFECTS.md` once the contract test exists, replacing the "~24"
   count with the generated current count.
