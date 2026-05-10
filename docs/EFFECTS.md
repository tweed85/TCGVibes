# Effect coverage (2,693-card pool)

Detailed rundown of attacks, abilities, trainers, stadiums, and tools wired into the engine. See [../CLAUDE.md](../CLAUDE.md) for the project entry point.

Focused audits:

- [Effect audit](./EFFECT_AUDIT.md)
- [Item audit](./ITEM_AUDIT.md)
- [Supporter audit](./SUPPORTER_AUDIT.md)
- [Tool audit](./TOOL_AUDIT.md)
- [Stadium audit](./STADIUM_AUDIT.md)

For the coverage guardrail and new-effect checklist, see
[EFFECT_AUDIT.md](EFFECT_AUDIT.md). That audit is backed by a Vitest
inventory hash so adding a new effect kind requires an explicit coverage
decision.

- **Attacks**: ~70 effect kinds — coin-flip variants, per-energy /
  per-bench / per-counter scaling, status, heal, snipe, multi-target,
  draw, locks, retreat manipulation. Bespoke: `distributeDamage`
  (Phantom Dive / Oil Salvo, interactive picker with "— N left"
  progress), `placeCountersPerHandCard` (Powerful Hand, W/R bypass),
  copy-attack pipelines, `discardDefenderEndOfOppNextTurn` (Corrosive
  Sludge), `bothActiveKnockedOut`, `attachNFromDiscardToBench`
  (Aura Jab, interactive), **`perPokemonFilter`** (Spidops Rocket
  Rush — multiplicative "N×" form correctly zeros base damage),
  `benchSnipe` with `target: "allOpponents"` hits opp Active too
  (W/R applied) plus bench (no W/R) — Frosmoth Chilling Wings, TR
  Arbok Spinning Tail. **`snipeOne`** carries a `benchOnly: boolean`
  field — when text says "Benched" it's a follow-up bench-snipe; when
  text omits "Benched" (Fezandipiti ex Cruel Arrow), the player may
  target Active or Bench, with W/R applied to the Active.
  **`snipeOnePerEnergy`** (Genesect Bug's Cannon) — N damage per
  matching energy attached, target Active or Bench. **`recurSelfFromDiscardToBench`**
  (Duskull Come and Get You) — pull up to N copies of the attacker's
  own card name from discard onto bench, respecting the 5-bench cap.
- **Abilities**: ~70 activated + triggered-on-evolve / -on-bench /
  -on-move-to-active / -on-move-to-bench. Highlights: `attachEnergy
  FromHandThenDraw` (Teal Dance), `moveDamageOwnToOpp` (Adrena-Brain,
  interactive), `putCountersOnOppThenSelfKO` (Cursed Blast,
  interactive — counter count is parsed from the holder's actual
  ability text so Dusclops places 5 and Dusknoir places 13).
  Triggered: Jewel Seeker, Psychic Draw, Heave-Ho Catcher, Cast-Off
  Shell, Multiplying Cocoon, Emergency Evolution, **Brambleghast
  Prison Panic** (Confused, not Asleep). Heave-Ho Catcher and
  Defiant Horn open the canonical `pokemonCatcher` picker for humans
  with multiple bench targets; AI / single-target paths resolve inline.
  **Lunar Cycle** (Lunatone) carries a cross-copy lock so 2 Lunatones
  in play can't both fire it the same turn.
- **Trainers**: 100+ effects, including 82 Standard Item names audited.
  Hilda + Dawn chained pickers,
  **Colress's Tenacity** (Stadium → Energy chain), **Salvatore**
  (interactive Evolution via `toEvolve`), **Perrin** (interactive
  hand-reveal → search same count via `useRevealedCount` postAction),
  **Team Rocket's Proton** (interactive search up to 3 Basic TR
  Pokémon; T1-bypassed), **Team Rocket's Ariana** (draw to 5, or 8
  if all in-play are TR), **Brock's Scouting** (Evolution branch when
  in-play has matching deck Evo, else 2-Basic search), **Lt. Surge's
  Bargain** (opp consents only when at 1 prize and would win, else
  user draws 4), **Raifort** (top-5 peek; pick any to discard, rest
  back on top — uses new `pickedDestination: "discard"` +
  `unpicked: "topOfDeck"` plumbing), **Potion / Super Potion**
  (interactive bench picker for the heal target), **Hassel**
  (post-KO precheck via `yourPokemonKoedLastOppTurn` + top-8 take-3),
  **Hop's Bag** (search up to 2 Basic Hop's-prefix Pokémon to bench;
  bench-cap clamped), **Acerola's Mischief** (precheck on opp ≤2
  prizes), **Xerosic's Machinations** (opp discards down to 3 cards),
  **Secret Box ACE SPEC** (chained Item → Tool → Supporter → Stadium
  pickers), Unfair Stamp ACE SPEC, all Standard staples. AI keeps the
  auto-resolve path on each. Current Item follow-up risk is
  human-choice fidelity for high-impact auto-resolved Items such as
  Prime Catcher, Scramble Switch, Glass Trumpet, Energy Search Pro, and
  Precious Trolley; see [Item audit](./ITEM_AUDIT.md).
- **Stadiums**: 29 Standard Stadium names audited. Most passives are
  wired, and the activated framework is shared with preflight via
  `precheckStadium()`. Includes **Postwick** (mirror-symmetric +30
  dmg for BOTH players' Hop's-prefix attacks) and **Spikemuth Gym**
  (item-lock-immune Marnie's-prefix search). Current follow-up risk is
  human-choice fidelity for activated Stadiums that still auto-pick the
  first legal card or target; see [Stadium audit](./STADIUM_AUDIT.md).
- **Tools**: 34 Standard Tool names audited — HP boosters, retreat helpers, damage boosters,
  berries with auto-discard, KO-triggered (Survival Brace, Lillie's
  Pearl, Amulet of Hope, **Heavy Baton** — interactive Bench-target
  picker that fires after the holder's owner promotes). On-damage
  hooks: Lucky Helmet, Punk Helmet, Deluxe Bomb, TR Hypnotizer,
  **Handheld Fan** (moves Energy from attacker to attacker's bench).
  Future-typed: **Future Booster Energy Capsule** (+20 damage, free
  retreat). Ancient-typed: **Ancient Booster Energy Capsule** (+60
  HP + status immunity + clears statuses on attach).
  HP-threshold helpers: **Rescue Board** (-1 retreat, free at HP ≤ 30).
  Self-discarding TM tools: **Technical Machine: Fluorite** (3-cost
  attack on holder; discards at end of turn; any tool whose name
  starts with "Technical Machine" auto-discards in `endTurn`).
  Cost-reduction tools: **Hop's Choice Band** (-1 Colorless attack
  cost AND +30 dmg vs Active for Hop's Pokémon). Cost-reduction
  loop in `effectiveAttackCost` strips Colorless slots only — never
  pops a typed-energy slot when no Colorless is available.
- **Tera Pokémon bench immunity**: 33+ Tera ex inherit the rule "while
  on your Bench, prevent all damage done to this Pokémon by attacks."
  Wired via `teraBenchImmunity` in [../src/engine/ongoingEffects.ts](../src/engine/ongoingEffects.ts);
  every bench-snipe / spread / counter-placement effect-handler in
  [../src/engine/effects.ts](../src/engine/effects.ts) checks it before
  applying bench damage.

## Effect prefabs (preferred path for new card work)

[../src/engine/effectPrefabs.ts](../src/engine/effectPrefabs.ts) wraps
the core deck-search / discard-recovery primitives in semantic helpers
(`searchDeckToBench`, `searchDeckToHand`, `recoverFromDiscardToHand`).
New trainer / ability cases that fit one of these patterns SHOULD call
the prefab rather than `setDeckSearchPick` / `setDiscardRecoveryPick`
directly. The prefabs are byte-equivalent to the underlying calls
([../src/engine/__tests__/prefabBehavior.test.ts](../src/engine/__tests__/prefabBehavior.test.ts)
pins the pendingPick shape), so opting in costs nothing at runtime
while improving readability and centralising patterns we'll iterate on.

Migrated to date: Buddy-Buddy Poffin, Energy Search, Lana's Aid (Phase 3);
Nest Ball, Poké Ball (heads branch), Night Stretcher (v2.5). Cards with
extra prelude cost (Ultra Ball / Earthen Vessel) or output destinations
the existing prefabs don't cover (Super Rod / Energy Recycler →
discard-to-deck) are held until the prefab catalogue grows to fit them.
