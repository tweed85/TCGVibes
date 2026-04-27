// Card data types — shaped to mirror the Pokémon TCG API so data from the
// pokemon-tournament-cards subagent can drop in with minimal adaptation.

export type EnergyType =
  | "Grass"
  | "Fire"
  | "Water"
  | "Lightning"
  | "Psychic"
  | "Fighting"
  | "Darkness"
  | "Metal"
  | "Fairy"
  | "Dragon"
  | "Colorless";

export type Supertype = "Pokémon" | "Trainer" | "Energy";

export interface Attack {
  name: string;
  cost: EnergyType[];
  damage: number; // parsed base damage; modifiers (+, ×, -) live in text
  damageText?: string; // original API string, e.g. "30+", "20×"
  text?: string;
  // Resolved lazily by getAttackEffects(): we used to run extractEffects()
  // on every attack of every card during dataset load (~5,000 regex passes
  // at boot). Most attacks are never used in any given game, so detection
  // is now deferred until the engine or AI first inspects the attack.
  // Synthetic attacks (e.g. tool-granted Geobuster) bypass this and ship
  // their own effects array.
  effects?: AttackEffect[];
  // True once getAttackEffects has populated `effects`. Distinguishes "no
  // effects detected" from "not yet detected".
  effectsResolved?: boolean;
}

// Discriminated union of engine-understood attack effects. Text for effects
// not matching any of these is preserved in Attack.text for display, but
// doesn't trigger engine behavior.
export type AttackEffect =
  | { kind: "flipHeadsBonus"; bonus: number } // "Flip a coin. If heads, this attack does N more damage."
  | { kind: "flipTailsFizzle" } // "Flip a coin. If tails, this attack does nothing."
  | { kind: "flipHeadsDouble" } // "Flip a coin. If heads, this attack does X more damage." with bonus=base
  | { kind: "perAttachedEnergy"; perEnergy: number; energyType?: EnergyType } // "N damage for each Energy attached."
  | { kind: "perFriendlyBench"; perCount: number } // "N damage for each of your Benched Pokémon."
  | { kind: "perOpponentBench"; perCount: number } // "... for each of your opponent's Benched Pokémon."
  | { kind: "perBothBench"; perCount: number } // "... for each Benched Pokémon (both yours and your opponent's)."
  | { kind: "perDamageCounterOnSelf"; perCount: number } // "... for each damage counter on this Pokémon."
  | { kind: "perDamageCounterOnDefender"; perCount: number } // "... for each damage counter on the opponent's Active."
  | { kind: "perEnergyOnDefender"; perCount: number } // "... for each Energy attached to your opponent's Active."
  | { kind: "perEnergyOnBothActives"; perCount: number } // "... for each Energy attached to both Active Pokémon."
  // "Discard up to N Energy from your Benched Pokémon. +M damage per discard."
  | { kind: "discardBenchEnergyForDamage"; max: number; damagePer: number }
  // "You may discard any amount of Energy from this Pokémon. +N damage per discarded card." (Iron Hands etc.)
  | { kind: "discardOwnEnergyForDamage"; damagePer: number; max?: number }
  // Discard a Stadium in play (Eternatus Shatter etc.)
  | { kind: "discardStadium" }
  // "Put N damage counters on opp's Benched Pokémon in any way." (Dragapult Phantom Dive.)
  | { kind: "placeCountersOnOppBenchAny"; counters: number }
  // "During opp's next turn, attacks by Defending do N less damage."
  | { kind: "defenderAttacksWeakerNextTurn"; amount: number }
  // "During opp's next turn, if this Pokémon is damaged, put N damage counters on the Attacker."
  | { kind: "counterAttackerNextTurn"; counters: number }
  // "Your opponent discards N cards from their hand." (random)
  | { kind: "oppDiscardsHand"; count: number }
  // "This attack does N damage for each card in your opponent's hand."
  | { kind: "perCardInOppHand"; perCount: number }
  // "You may attach any number of Basic Energy cards from your hand to your Pokémon in any way you like." (Alolan Exeggutor Tropical Frenzy)
  | { kind: "attachAnyBasicFromHandAll" }
  // "You may put this Pokémon into your hand. (Discard all attached cards.)" (Team Rocket's Crobat ex)
  | { kind: "returnSelfToHandDiscardAttached" }
  // "Put an Energy attached to this Pokémon into your hand." (Landorus Screw Knuckle)
  | { kind: "ownEnergyToHand"; count: number }
  // "Switch in 1 of your opponent's Benched Pokémon to the Active Spot." (Clefairy Follow Me)
  | { kind: "gustOppBenchedAttack" }
  // "Discard any amount of Basic Energy from your Pokémon. +N damage per card discarded."
  // OR with type filter ("any amount of Fire Energy from among your Pokémon").
  | { kind: "discardAnyEnergyAcrossOwnForDamage"; damagePer: number; energyType?: EnergyType }
  // "You may discard up to N Energy cards from your hand. +M damage per discarded."
  | { kind: "discardHandEnergyForDamage"; max: number; damagePer: number }
  // "This attack does N damage for each Pokémon Tool attached to all of your Pokémon."
  | { kind: "perOwnToolAttached"; perCount: number }
  // "Your opponent chooses N cards from their hand and shuffles them into their deck."
  | { kind: "oppChoosesHandToDeck"; count: number }
  // "Discard up to N Energy cards from this Pokémon. +M damage per discarded."
  | { kind: "discardOwnEnergyUpToForDamage"; max: number; damagePer: number; energyType?: EnergyType }
  // "During your opponent's next turn, this Pokémon has no Weakness." (Archaludon Metal Defender)
  | { kind: "selfNoWeaknessNextTurn" }
  // "Discard a card from your hand. If you do, draw N cards." (Klefki Stick 'n' Draw, Tropius Fruit Bearing)
  | { kind: "discardHandForDraw"; drawCount: number }
  // "If <pred>, this attack's base damage is N." (Mega Mawile ex Huge Bite)
  | { kind: "conditionalBaseDamageOverride"; baseDamage: number; predicate: AttackPredicate }
  // "Look at the top card of your deck. You may discard that card." (Litwick Brighten and Burn)
  | { kind: "peekTopMayDiscard" }
  // "Discard the top N cards of your deck. +M damage per <Type> Energy discarded." (Mega Abomasnow Hammer-lanche)
  | { kind: "millSelfForDamagePerType"; count: number; damagePer: number; energyType: EnergyType }
  // "Move all damage counters from 1 of your Benched Pokémon to 1 of your opponent's Pokémon."
  | { kind: "moveDamageOwnBenchToOpp" }
  // "Knock Out each of your opponent's Pokémon that has N HP or less remaining." (Yveltal ex Soul Destroyer)
  | { kind: "koAllOppWithLowHp"; hpMax: number }
  // "Choose 2 of your opponent's Benched Pokémon. Shuffle those Pokémon and all attached cards into deck."
  | { kind: "shuffleOppBenchToDeck"; count: number }
  // "Look at the top N cards of your deck. You may put any number of Pokémon found there onto your Bench."
  | { kind: "peekTopOptionalBench"; count: number }
  // "You may discard N <Type> Energy from this Pokémon and make opp's Active Pokémon <Status>." (Mega Eelektross Disaster Shock)
  | { kind: "discardOwnEnergyForStatus"; count: number; energyType: EnergyType; status: StatusCondition }
  // "Reveal any number of <Name1>, <Name2>, and <Name3> from your hand. +N damage per revealed." (Doublade Weaponized Swords)
  | { kind: "revealNamedFromHandForDamage"; namesPattern: string[]; damagePer: number }
  // "Discard a <Name> Energy from this Pokémon. If you do, discard opp's Active Pokémon and all attached cards." (Team Rocket's Moltres ex Evil Incineration)
  | { kind: "discardSpecialEnergyKoOpp"; energyName: string }
  // "Your opponent reveals their hand." (Hoothoot Silent Wing — info-only.)
  | { kind: "revealOppHand" }
  // "For each of your Benched Pokémon, search your deck for a card that
  // evolves from that Pokémon and put it onto that Pokémon to evolve it."
  | { kind: "searchEvolveBench" }
  // "During your next turn, this Pokémon's <Name> attack does N more damage."
  // (Meloetta Echoed Voice, Metagross Meteor Mash, etc.)
  | { kind: "selfNextTurnAttackBonus"; attackName: string; bonus: number }
  // "This Pokémon can't use <Name> again until it leaves the Active Spot."
  // (Gouging Fire Blaze Blitz.) Lock until move-out.
  | { kind: "selfCantUseAttackUntilLeavesActive"; attackName: string }
  // "If your opponent's Active Pokémon has exactly N damage counters on it,
  // that Pokémon is Knocked Out." (Mega Absol Terminal Period.)
  | { kind: "koOppIfExactlyDamageCounters"; counters: number }
  // "Discard up to N Pokémon Tools from your opponent's Pokémon." (Minccino)
  | { kind: "discardOppToolsN"; max: number }
  // "This attack does N damage for each Special Energy card attached to this Pokémon."
  | { kind: "perSpecialEnergyOnSelf"; perCount: number }
  // "This attack does N less damage for each damage counter on this Pokémon."
  | { kind: "perDamageCounterReduction"; perCount: number }
  // "Attach a Basic Energy card from your hand to 1 of your Pokémon." (simple — auto-pick)
  | { kind: "attachBasicFromHandToOne" }
  // "You may put N Energy attached to opp's Active Pokémon into their hand."
  | { kind: "bounceOppEnergyToHand"; count: number }
  // "At the end of your opponent's next turn, put N damage counters on the Defending Pokémon."
  | { kind: "delayedDamageOnDefender"; counters: number }
  // "Put damage counters on opp's Active Pokémon until its remaining HP is N."
  | { kind: "damageOppDownTo"; floorHp: number }
  // "Discard this Pokémon and all attached cards." (Revavroom Shattering Speed — self-KO)
  | { kind: "selfKoDiscardAll" }
  // "Discard the top N cards of your deck." (self-mill, no damage rider)
  | { kind: "discardTopOfOwnDeck"; count: number }
  // "Reveal the top N cards of your deck. This attack does M damage for each
  // <subtype> card found. Then, discard those <subtype> cards and shuffle." (Iron Thorns Destructo-Press)
  | { kind: "revealTopForFilteredDamage"; count: number; damagePer: number; subtype: string }
  // "This attack does N damage for each damage counter on all of your Benched <X> Pokémon."
  | { kind: "perCountersOnFilteredBench"; perCount: number; filter: PokemonFilter }
  // "Put 1 of your Benched Pokémon and all attached cards into your hand."
  | { kind: "bounceOneBench" }
  // "Discard the top card of each player's deck. +N damage per Energy card discarded."
  | { kind: "millBothForEnergyDamage"; damagePer: number }
  // "This attack does N damage for each Prize card you have taken."
  | { kind: "perPrizeYouTaken"; perCount: number }
  // "This attack does N damage for each [type] Energy card in your opponent's discard pile."
  | { kind: "perEnergyInOppDiscard"; perCount: number; energyType?: EnergyType }
  // "This attack does N damage for each Special Condition affecting your opponent's Active Pokémon."
  | { kind: "perStatusOnDefender"; perCount: number }
  // "This attack does N more damage for each [card filter] in your discard pile."
  | { kind: "perCardInOwnDiscard"; perCount: number; filter: PokemonFilter | { kind: "energyOfType"; energyType: EnergyType } | { kind: "cardNamePart"; namePart: string } }
  // "Discard a [type] Energy from your opponent's Active Pokémon."
  | { kind: "discardTypedOppEnergy"; count: number; energyType: EnergyType }
  // "This Pokémon recovers from all Special Conditions." (Arboliva Aroma Shot)
  | { kind: "selfRecoverAllStatuses" }
  | { kind: "perPrizeOppTaken"; perCount: number } // "... for each Prize card your opponent has taken."
  | { kind: "benchSnipe"; damage: number; target: "opponentBench" | "allBench" | "allOpponents" | "ownBench" }
  | { kind: "selfDamage"; damage: number } // "This Pokémon also does N damage to itself."
  | { kind: "applyStatus"; status: StatusCondition; target: "defender" | "self"; requiresHeads?: boolean }
  | { kind: "heal"; amount: number; target: "self" | "active" }
  // "Heal N damage from 1 of your Pokémon." Auto-picks the most-damaged ally.
  | { kind: "healOneOfYours"; amount: number }
  // "Heal from this Pokémon the same amount of damage you did to opp's Active."
  // Giga Drain pattern — drain attacker for damage dealt this hit.
  | { kind: "healEqualToDamageDealt" }
  // "Heal N damage from each of your <subtype> Pokémon." (Leavanny "Healing
  // Wrapping" — only heals Basic Pokémon.)
  | { kind: "healEachOwnSubtype"; amount: number; subtype: "Basic" | "Stage 1" | "Stage 2" | "Evolution" }
  | { kind: "discardOwnEnergy"; count: number } // "Discard N Energy from this Pokémon."
  | { kind: "drawCards"; count: number }
  | { kind: "drawUntilHandSize"; targetSize: number; optional?: boolean } // "Draw cards until you have N in hand."
  | { kind: "blockOppItemsNextTurn" } // Budew Itchy Pollen — opp can't play Items next turn.
  | { kind: "flipMultiCoinsPerHeads"; coins: number; perHeads: number } // "Flip N coins. N damage per heads."
  // "Flip N coins. If all of them are heads, this attack does M more damage."
  | { kind: "flipAllHeadsBonus"; coins: number; bonus: number }
  | { kind: "selfCantAttackNextTurn" } // During your next turn, this Pokémon can't attack.
  | { kind: "defenderCantRetreatNextTurn" } // During opp's next turn, Defending can't retreat.
  | { kind: "defenderCantAttackNextTurn" } // During opp's next turn, Defending can't use attacks.
  | { kind: "selfDamageReductionNextTurn"; amount: number } // "takes N less damage next turn"
  | { kind: "snipeOne"; damage: number } // "This attack also does N damage to 1 of opp's Benched"
  // "This attack does N damage to 2/3 of your opponent's Pokémon." Hits both
  // Active + Bench; auto-picks the most-damaged targets.
  | { kind: "damageMultipleTargets"; damage: number; count: number; benchOnly: boolean }
  | { kind: "switchOutOpponent" } // Opp promotes new Active from bench
  | { kind: "selfSwitch" } // Switch attacker with a benched Pokémon
  | { kind: "discardOppEnergy"; count: number } // Discard N Energy from opp's Active
  | { kind: "discardOppSpecialEnergy"; count: number } // Discard N Special Energy from opp's Active
  | { kind: "flipHeadsDiscardOppEnergy" } // Flip — heads: discard one Energy from opp's Active
  | { kind: "multiCoinFlipDiscardOppEnergy"; coins: number } // Flip N coins; per heads, discard 1 Energy
  | { kind: "multiCoinFlipMillOpp"; coins: number } // Flip N coins; per heads, mill 1
  | { kind: "healEachOwnPokemon"; amount: number } // Heal N from each of your Pokémon
  | { kind: "discardTopOfOppDeck"; count: number } // Mill the opp deck by N
  | { kind: "discardOppTools" } // "Before doing damage, discard all Tools from opp's Active"
  | { kind: "callForFamily"; max: number } // "Search your deck for up to N Basic Pokémon and put them onto your Bench."
  | { kind: "flipUntilTailsPerHeads"; perHeads: number } // Geometric damage ("Flip until you get tails")
  | { kind: "placeCountersPerHandCard"; countersPerCard: number } // Alakazam "Powerful Hand"
  // "Place N damage counters on <target>." Direct damage-counter placement
  // bypasses Weakness/Resistance. Targets: opp Active / opp Benched / 1 opp Pokémon.
  | { kind: "placeCounters"; counters: number; target: "oppActive" | "oppBench" | "anyOpp" }
  // Per-Pokémon-in-play damage scaling, filtered. Generalizes the existing
  // `perFriendlyBench` etc. so cards like Wigglytuff "Round" work.
  | { kind: "perPokemonFilter"; side: "friendly" | "opponent"; perCount: number; filter: PokemonFilter; includeActive: boolean }
  | { kind: "fizzleIfNoStadium" } // Fan Rotom "Assault Landing"
  | { kind: "shieldNextTurn"; requiresHeads: boolean } // Dunsparce "Dig" — prevent damage+effects next turn
  | { kind: "searchEnergyAttachBenchType"; pokemonType: EnergyType } // Shaymin DRI "Send Flowers"
  | { kind: "attachNFromDiscardToBench"; energyType: EnergyType; max: number } // Mega Lucario ex "Aura Jab"
  // "Attach up to N Basic <type> Energy cards from discard to this Pokémon."
  | { kind: "attachNFromDiscardToSelf"; energyType: EnergyType; max: number }
  // "Attach a Basic Energy card from discard to 1 of your Benched Pokémon."
  // (Furfrou Energy Assist / Oricorio.) energyType undefined = any Basic Energy.
  | { kind: "attachBasicFromDiscardToOneBench"; energyType?: EnergyType; max: number }
  // "Attach a Basic <type> Energy card from discard to each of your Benched."
  | { kind: "attachBasicFromDiscardToEachBench"; energyType: EnergyType }
  // "Put up to N <filter> Pokémon from your discard pile onto your Bench."
  | { kind: "recoverPokemonFromDiscardToBench"; max: number; filter: PokemonFilter }
  // "Put up to N Pokémon from your discard pile into your hand."
  | { kind: "recoverPokemonFromDiscardToHand"; max: number; filter: PokemonFilter }
  // "Put a Supporter card from your discard pile into your hand."
  | { kind: "recoverTrainerFromDiscard"; max: number; subtype: "Supporter" | "Item" | "Pokémon Tool" | "any" }
  | { kind: "selfCantUseAttackNextTurn"; attackName: string } // Riolu / Mega Brave — only THIS attack is locked
  | { kind: "multiCoinPerOppPokemon"; damagePerHeads: number } // Mega Zygarde ex "Nullifying Zero"
  | { kind: "fizzleIfNoAlly"; allyName: string } // Solrock Cosmic Beam
  | { kind: "ignoreWeaknessResistance" } // Cosmic Beam — ignore both
  | { kind: "ignoreWeaknessOnly" } // "isn't affected by Weakness."
  | { kind: "ignoreResistanceOnly" } // "isn't affected by Resistance." (Naclstack Rock Hurl)
  | { kind: "ignoreOppEffects" } // "isn't affected by any effects on opp's Active." (Mega Lopunny Spiky Hopper)
  | { kind: "returnSelfToHand" } // Meowth ex Tuck Tail
  // Generic predicate-gated damage modifier. `mode: "bonus"` adds N damage
  // when the predicate matches; `mode: "fizzleIfNot"` zeros all damage when
  // the predicate fails. The attack still pays cost either way.
  | { kind: "conditionalDamage"; bonus: number; mode: "bonus" | "fizzleIfNot"; predicate: AttackPredicate }
  // Predicate-gated KO: if the predicate matches the defender, the attack
  // automatically KOs the defender regardless of HP/damage. (Haxorus Axe Blast.)
  | { kind: "conditionalKoDefender"; predicate: AttackPredicate }
  // Predicate-gated status on defender — used for Black Kyurem Ice Age etc.
  | { kind: "conditionalStatus"; status: StatusCondition; target: "defender" | "self"; predicate: AttackPredicate }
  // Attack-driven deck search. The most common attack template family. The
  // engine opens a `pendingPick` for human players (auto-picks for AI). Picked
  // cards go to hand by default; `destination` overrides for attach / bench
  // targets.
  | {
      kind: "searchDeckAttack";
      filter: AttackSearchFilter;
      destination: "hand" | "bench" | "attachSelf" | "attachAll";
      max: number;
      optional?: boolean; // "you may search..."
    }
  // "Search your deck for a card that evolves from this Pokémon and put it
  // onto this Pokémon to evolve it." (Misdreavus Ascension etc.) Auto-picks
  // the first eligible evolution from the deck.
  | { kind: "searchEvolveSelf" }
  // "For each of your Benched Pokémon, search your deck for a Basic <Type>
  // Energy card and attach it..." (Mega Gardevoir Overflowing Wishes). Auto-
  // resolves: one card per benched ally, capped by deck contents.
  | { kind: "searchEnergyForEachBench"; energyType: EnergyType }
  // "Choose a random card from opp's hand. They reveal it and shuffle into
  // their deck." (Aipom Astonish, Rotom etc.)
  | { kind: "randomOppHandToDeck"; count: number }
  | { kind: "randomOppHandDiscard"; count: number } // "Discard a random card from opp's hand."
  | { kind: "multiCoinFlipRandomOppHandDiscard"; coins: number } // "Flip N coins. For each heads, discard random."
  // "Your opponent reveals their hand. Discard <filter> card(s) you find
  // there." (Luxray ex Piercing Gaze, Mega Absol ex Claw of Darkness, Rotom
  // Crushing Pulse.) Auto-picks for AI, opens pendingHandReveal for humans.
  | { kind: "revealOppHandDiscard"; filter: "any" | "item" | "tool" | "itemOrTool" | "supporter"; max: number; min: number }
  // "Your opponent reveals their hand. This attack does N damage for each
  // <filter> card you find there." (Whimsicott ex Wondrous Cotton, Beautifly
  // Energy Straw.) damagePer × matching cards is added to base damage.
  | { kind: "damagePerCardClassInOppHand"; damagePer: number; filter: "trainer" | "energy" | "pokemon" | "item" | "supporter" }
  // "Move an Energy from this Pokémon to 1 of your Benched Pokémon."
  // count = "all" | number. Auto-picks the first benched ally.
  | { kind: "moveOwnEnergyToBench"; count: number | "all" }
  // "You may move an Energy from your opponent's Active Pokémon to 1 of
  // their Benched Pokémon." (Gengar ex Tricky Steps.)
  | { kind: "moveOppEnergyToBench"; count: number };

export type PokemonFilter =
  | { kind: "any" }
  | { kind: "namePart"; namePart: string }
  | { kind: "type"; energyType: EnergyType }
  | { kind: "subtype"; subtype: string }
  | { kind: "hasAttackNamed"; attackName: string };

export type AttackSearchFilter =
  | { kind: "any" }
  | { kind: "pokemon" }
  | { kind: "basicPokemon" }
  | { kind: "stage1Pokemon" }
  | { kind: "stage2Pokemon" }
  | { kind: "evolutionPokemon" }
  | { kind: "pokemonOfType"; energyType: EnergyType }
  | { kind: "basicEnergy" }
  | { kind: "basicEnergyType"; energyType: EnergyType }
  | { kind: "supporter" }
  | { kind: "item" }
  | { kind: "tool" }
  | { kind: "trainer" };

// Discriminated union of state predicates evaluated against the current
// attacker / defender / game-state at attack time.
export type AttackPredicate =
  // Defender properties
  | { kind: "defenderIsEx" }
  | { kind: "defenderIsExOrV" }
  | { kind: "defenderIsV" }
  | { kind: "defenderHasSubtype"; subtype: "Basic" | "Stage 1" | "Stage 2" | "Evolution" }
  | { kind: "defenderHasStatus"; status: StatusCondition }
  | { kind: "defenderHasAnyStatus" }
  | { kind: "defenderHasType"; type: EnergyType }
  | { kind: "defenderHasTool" }
  | { kind: "defenderHasSpecialEnergy" }
  | { kind: "defenderHasDamage" }
  // Attacker properties
  | { kind: "selfHasExtraEnergy"; extra: number }
  | { kind: "selfHasDamage" }
  | { kind: "selfHasNoDamage" }
  | { kind: "selfHasTool" }
  | { kind: "selfEvolvedThisTurn" }
  | { kind: "selfHasNoEnergy" }
  | { kind: "selfHasSpecialEnergy" }
  | { kind: "selfHasEnergyOfType"; energyType: EnergyType }
  | { kind: "selfHasNamedEnergy"; energyName: string }
  | { kind: "selfMovedToActiveThisTurn" }
  | { kind: "selfHasStatus"; status: StatusCondition }
  // Game-state
  | { kind: "youHavePokemonNamed"; namePart: string; minCount: number }
  | { kind: "stadiumInPlayNamed"; stadiumNamePart: string }
  | { kind: "yourTurnNumberAtLeast"; turn: number }
  | { kind: "yourPokemonKoedLastOppTurn" }
  | { kind: "yourPrizesEquals"; count: number }
  | { kind: "yourPrizesAtMost"; count: number }
  | { kind: "oppPrizesAtMost"; count: number }
  | { kind: "yourHandSizeEquals"; count: number }
  | { kind: "youHaveBenchPokemonOfType"; energyType: EnergyType }
  | { kind: "allBenchHasDamage" }
  | { kind: "yourHandSizeEqualsOpp" }
  | { kind: "yourBenchCountAtMost"; count: number }
  | { kind: "yourDiscardHasNTypedEnergy"; count: number; energyType: EnergyType }
  | { kind: "youHavePokemonNamedOnBench"; namePart: string }
  | { kind: "supporterPlayedThisTurnNamed"; namePart: string };

export type StatusCondition = "asleep" | "burned" | "confused" | "paralyzed" | "poisoned";

export interface Ability {
  name: string;
  type: string; // "Ability" | "Poké-Power" | "Poké-Body" | "Ancient Trait"
  text: string;
  effect?: AbilityEffect; // auto-detected; if present, UI shows an Activate button
}

// Narrow set of supported activated-ability effects.
export type AbilityEffect =
  | { kind: "drawOne"; oncePerTurn: true }
  | { kind: "drawTwo"; oncePerTurn: true }
  | { kind: "drawN"; count: number; oncePerTurn: true; condition?: AbilityCondition }
  | { kind: "healSelf"; amount: number; oncePerTurn: true }
  | { kind: "healAny"; amount: number; oncePerTurn: true } // heal one of your Pokémon
  | { kind: "searchBasicEnergy"; count: number; energyType?: EnergyType; oncePerTurn: true }
  | { kind: "attachEnergyFromHand"; energyType: EnergyType; oncePerTurn: true }
  | { kind: "attachEnergyFromHandThenDraw"; energyType: EnergyType; drawCount: number; oncePerTurn: true } // Teal Dance
  | { kind: "attachEnergyFromDiscardToSelf"; oncePerTurn: true } // any Basic Energy from discard → self
  | { kind: "attachEnergyFromDiscardToBench"; energyType: EnergyType; oncePerTurn: true } // Dynamotor
  | { kind: "attachEnergyFromHandToBenchNameN"; energyType: EnergyType; max: number; namePrefix: string; oncePerTurn: true } // Golden Flame: up to 2 Fire to Bench Ethan's
  | { kind: "moveOwnBasicEnergyBetween"; oncePerTurn: true } // Happy Switch
  | { kind: "moveDamageOwnToOpp"; counters: number; energyConditionType?: EnergyType; oncePerTurn: true } // Adrena-Brain (needs Darkness attached)
  | { kind: "applyStatusToOppActive"; status: StatusCondition; activeOnly: boolean; oncePerTurn: true } // Calming Light, Scalding Steam
  | { kind: "healEachOwn"; amount: number; oncePerTurn: true } // Lovely Fragrance
  | { kind: "switchToActiveFromBench"; oncePerTurn: true } // Showtime (Meowscarada) — self must be Benched
  | { kind: "benchFromDiscardHpMax"; hpMax: number; activeOnly: boolean; oncePerTurn: true } // Gentle Fin
  | { kind: "searchDeckStadium"; oncePerTurn: true } // Changing Seasons
  | { kind: "searchDeckPokemonNamePrefix"; namePrefix: string; oncePerTurn: true } // Gathering of Blossoms (Erika's)
  | { kind: "top6RevealSupporter"; oncePerTurn: true; activeOnly: boolean } // Attract Customers
  | { kind: "peekTopMayDiscard"; oncePerTurn: true } // Snack Seek
  // -- remaining-unwired sweep --
  | { kind: "bothPlayersDrawOne"; activeOnly: boolean; oncePerTurn: true } // Alluring Wings
  | { kind: "flipReturnOppActiveEnergyToHand"; oncePerTurn: true } // Boisterous Wind
  | { kind: "searchDeckTrainerByName"; trainerName: string; oncePerTurn: true } // Bonded by the Journey
  | { kind: "flipGustOppWithStatus"; status: StatusCondition; oncePerTurn: true } // Captivating Invitation
  | { kind: "putCountersOnOppThenSelfKO"; counters: number; oncePerTurn: true } // Cursed Blast
  | { kind: "swapHandCardWithDeckTop"; oncePerTurn: true } // Evidence Gathering
  | { kind: "searchEvolutionPokemonGated"; oncePerTurn: true; energyConditionAttached?: EnergyType } // Evolutionary Guidance
  | { kind: "switchWithActiveIfMegaExInPlay"; oncePerTurn: true } // Excited Dash
  | { kind: "healAnyIfMegaExTypeInPlay"; amount: number; requiredType: EnergyType; oncePerTurn: true } // Excited Heal
  | { kind: "healAnyIfEnergyAttached"; amount: number; energyType: EnergyType; oncePerTurn: true } // Fermented Juice
  | { kind: "discardSelfEnergyDrawToN"; energyType: EnergyType; targetHand: number; oncePerTurn: true } // Flashing Draw
  | { kind: "oppShuffleToBottomDrawN"; drawCount: number; oncePerTurn: true } // Grand Wing
  | { kind: "revealOppHandPutOnOppBench"; hpMax: number; oncePerTurn: true } // Look for Prey
  | { kind: "top4AttachEnergyType"; energyType: EnergyType; oncePerTurn: true } // Metal Maker
  | { kind: "searchEvolutionPokemonOfType"; energyType: EnergyType; max: number; oncePerTurn: true } // Metallic Signal
  | { kind: "attachNFromDiscardThenSelfKO"; count: number; oncePerTurn: true } // Overvolt Discharge
  | { kind: "attachMixedFromHand"; typeA: EnergyType; typeB: EnergyType; max: number; oncePerTurn: true } // Pyro Dance
  | { kind: "flipChooseStatusOpp"; oncePerTurn: true } // Selective Slime
  | { kind: "flipDiscardRandomFromOppHand"; oncePerTurn: true } // Sky Hunt
  | { kind: "switchBenchedTypeToActiveWithStatus"; energyType: EnergyType; status: StatusCondition; excludeSameName: boolean; oncePerTurn: true } // Subjugating Chains
  | { kind: "swapWithBenchAndForceOppPromote"; oncePerTurn: true } // Torrential Whirlpool
  | { kind: "discardHandEnergyStatusOppActive"; energyType: EnergyType; status: StatusCondition; oncePerTurn: true } // Torrid Scales
  | { kind: "putHandToBottomDrawToN"; targetHand: number; oncePerTurn: true } // Up-Tempo
  | { kind: "attachEnergyFromHandToActiveNamePrefix"; namePrefix: string; oncePerTurn: true } // Lethargic Charge
  | { kind: "devolveOppEvolution"; activeOnly: boolean; oncePerTurn: true } // Ancient Wing
  | { kind: "discardToolFromHandGustOpp"; toolName: string; oncePerTurn: true } // Beckoning Tail
  | { kind: "discardBottomDeckSelfToTop"; oncePerTurn: true } // Flustered Leap
  | { kind: "drawToNIfSupporterPlayedName"; targetHand: number; supporterName: string; oncePerTurn: true } // Shadowy Envoy
  | { kind: "searchEnergyIfSupporterPlayedName"; energyType: EnergyType; count: number; supporterName: string; oncePerTurn: true } // Frilled Generator
  | { kind: "emergencyRotationFromHand"; requiresOppStage2: boolean; oncePerTurn: true } // Emergency Rotation (activated from hand)
  | { kind: "fanCallFirstTurn"; energyType: EnergyType; hpMax: number; max: number; oncePerTurn: true } // Fan Rotom "Fan Call"
  | { kind: "lunarCycleDrawN"; allyName: string; costEnergyType: EnergyType; drawCount: number; oncePerTurn: true } // Lunatone "Lunar Cycle"
  | { kind: "searchDeckAnyCard"; oncePerTurn: true; condition?: AbilityCondition } // search for any 1 card
  | { kind: "searchDeckPokemon"; oncePerTurn: true } // search for any 1 Pokémon
  | { kind: "switchWithBench"; oncePerTurn: true }
  | { kind: "shuffleSelfIntoDeck"; oncePerTurn: true } // Abra Teleporter
  | { kind: "peek2Top"; oncePerTurn: true } // Drakloak Recon Directive — look at top 2, take 1
  | { kind: "oppShuffleHandAndDrawN"; drawCount: number; oncePerTurn: true } // Gothitelle Distorted Future
  | { kind: "attackBonusThisTurnSelfDamage"; selfDamage: number; bonusPerAttack: number; oncePerTurn: true } // Feraligatr Torrential Heart
  // "You must discard a card from your hand. Once during your turn, draw N cards." (N's Zoroark ex Trade)
  | { kind: "drawNDiscardCost"; count: number; oncePerTurn: true }
  // "Once during your turn, attach Basic Grass Energy from hand to 1 of your Pokémon. If attached, heal N from that Pokémon." (Hydrapple ex Ripening Charge)
  | { kind: "attachEnergyFromHandThenHeal"; energyType: EnergyType; healAmount: number; oncePerTurn: true }
  // "Once during your turn, if this Pokémon is in the Active Spot, draw 2 cards." (Mega Kangaskhan Run Errand)
  | { kind: "drawNActiveOnly"; count: number; oncePerTurn: true }
  // "As often as you like during your turn, you may use this Ability. Move a
  // Basic <Type> Energy from 1 of your Pokémon to another of your Pokémon." (Mega Venusaur Solar Transfer)
  | { kind: "moveBasicEnergyAnywhere"; energyType: EnergyType }
  // "As often as you like during your turn, attach a Basic <Type> Energy
  // card from your hand to 1 of your <NamePart> Pokémon." (Iono's Bellibolt Electric Streamer)
  | { kind: "attachEnergyFromHandToNamedAsOften"; energyType: EnergyType; namePrefix: string };

// Conditional gates evaluated at activation time. If the condition fails,
// the button is disabled (or the activation blocked with a reason).
export type AbilityCondition =
  | { kind: "activeHasAbilityNamed"; abilityName: string }
  | { kind: "yourPokemonKoedLastOppTurn" };

export interface WeaknessResistance {
  type: EnergyType;
  value: string; // e.g. "×2", "-30"
}

interface CardBase {
  id: string;
  name: string;
  setCode?: string;
  number?: string;
  regulationMark?: string;
  imageSmall?: string;
  imageLarge?: string;
}

export interface PokemonCard extends CardBase {
  supertype: "Pokémon";
  subtypes: string[]; // "Basic", "Stage 1", "Stage 2", "ex", "V", ...
  hp: number;
  types: EnergyType[];
  evolvesFrom?: string;
  attacks: Attack[];
  abilities?: Ability[];
  weaknesses?: WeaknessResistance[];
  resistances?: WeaknessResistance[];
  retreatCost: EnergyType[]; // Colorless placeholders
  rules?: string[]; // ex/VSTAR/rule-box text
}

export interface EnergyCard extends CardBase {
  supertype: "Energy";
  subtypes: string[]; // "Basic" | "Special"
  provides: EnergyType[]; // Basic energy provides one of its type
}

export interface TrainerCard extends CardBase {
  supertype: "Trainer";
  subtypes: string[]; // "Item" | "Supporter" | "Stadium" | "Pokémon Tool"
  text: string;
  rules?: string[];
  // Effects are kept data-driven via an effect id the engine interprets.
  effectId?: string;
}

export type Card = PokemonCard | EnergyCard | TrainerCard;

// Runtime instance of a Pokémon in play (active or bench).
export interface PokemonInPlay {
  instanceId: string;
  card: PokemonCard;
  damage: number;
  attachedEnergy: EnergyCard[];
  evolvedFrom: PokemonCard[]; // stack of pre-evolutions
  tools: TrainerCard[]; // Pokémon Tool cards attached — max 1 per Pokémon
  playedThisTurn: boolean;
  evolvedThisTurn: boolean;
  statuses: StatusCondition[]; // asleep/paralyzed/confused are mutually exclusive with each other; poisoned/burned can coexist
  abilityUsedThisTurn: boolean; // tracks "once during your turn" abilities
  // Turn-locked restrictions applied by attacks with "during your/opponent's
  // next turn, this/Defending Pokémon can't …" text. Inclusive turn number.
  cantAttackUntilTurn?: number;
  cantRetreatUntilTurn?: number;
  // Dunsparce "Dig": heads on the attack sets this to state.turn + 1 so
  // during the opponent's next turn, all incoming damage and non-damage
  // effects directed at this Pokémon are prevented.
  shieldedUntilTurn?: number;
  // True only on the turn this Pokémon moved from Bench to Active. Used by
  // attack predicates like Rayquaza Breakthrough Assault. Cleared at end of
  // its owner's turn.
  movedToActiveThisTurn?: boolean;
  // Set by attacks like Archaludon "Metal Defender" — during the opponent's
  // upcoming turn, this Pokémon ignores its own Weakness. Cleared at end of
  // its owner's turn.
  noWeaknessUntilTurn?: number;
}

export type PlayerId = "p1" | "p2";

export interface PlayerState {
  id: PlayerId;
  name: string;
  deck: Card[];
  hand: Card[];
  discard: Card[];
  prizes: Card[];
  bench: PokemonInPlay[]; // up to 5
  active: PokemonInPlay | null;
  energyAttachedThisTurn: boolean;
  supporterPlayedThisTurn: boolean;
  retreatedThisTurn: boolean;
  mulligans: number; // count of mulligans taken at setup
  setupComplete: boolean; // true after the player has chosen Active + bench at opening
  // Turn-scoped attack bonuses applied to this player's attacks, cleared at
  // end of their turn. E.g. Black Belt's Training: +40 vs ex, Premium Power Pro:
  // +30 for Fighting.
  thisTurnAttackBonuses: TurnAttackBonus[];
  // Damage reductions that apply during the opponent's NEXT turn (set by
  // Supporters like Jasmine's Gaze or Items like Iron Defender, cleared when
  // that turn ends).
  nextOpponentTurnDamageReductions: TurnDamageReduction[];
  // Budew's Itchy Pollen and similar attacks set this on the opponent so they
  // can't play Item cards during their next turn. Cleared when that turn ends.
  itemsBlockedNextTurn: boolean;
  // True if this player has used the in-play Stadium's activated ability
  // this turn (stadiums with once-per-turn "may" effects).
  stadiumUsedThisTurn: boolean;
  // Tracks "Last-Ditch" ability group usage ("You can't use more than 1
  // Ability that has 'Last-Ditch' in its name each turn."). Cleared at end
  // of turn.
  lastDitchUsedThisTurn: boolean;
  // Name of the last Supporter this player played this turn (null if none).
  // Used by abilities gated on a specific Supporter having been played
  // (Shadowy Envoy → Janine's Secret Art, Frilled Generator → Canari).
  // Cleared at end of turn.
  lastSupporterNameThisTurn: string | null;
  // True during this player's turn when ≥1 of their Pokémon was KO'd during
  // the opponent's turn that just ended. Consumed by Flip the Script / etc.
  // Cleared at the end of this player's turn.
  yourPokemonKoedLastOppTurn: boolean;
  // Set true once this player's Legacy Energy has triggered its "opp takes
  // 1 fewer Prize" effect. "Can't be applied more than once per game."
  legacyEnergyUsed: boolean;
  isAI: boolean;
}

export interface TurnAttackBonus {
  amount: number;
  // Optional gates. attackerType must match. The defender-shape gates
  // (againstEx, againstV) are OR-ed when both are set on one entry — e.g.
  // Kieran's "+30 vs ex AND V" fires if the defender is ex OR V.
  againstEx?: boolean; // only vs opponent's Active Pokémon ex
  againstV?: boolean; // only vs opponent's Active Pokémon V (V/VMAX/VSTAR/V-UNION)
  attackerType?: EnergyType; // only attacks from this type
}

export interface TurnDamageReduction {
  amount: number;
  defenderType?: EnergyType; // only when defender is this type (Iron Defender: Metal)
}

export interface StadiumInPlay {
  card: TrainerCard;
  controller: PlayerId;
}

export type Phase =
  | "coinFlip" // pre-game coin toss: player guesses heads/tails, winner chooses first
  | "setup"
  | "draw"
  | "main"
  | "attack"
  | "between"
  | "promoteActive" // waiting for a player to choose a new Active from their Bench
  | "pick" // waiting for a player to pick cards from a pool (search / peek / recover)
  | "gameOver";

// Pre-game coin-flip state. Null once the flip is fully resolved and both
// players' hands have been dealt.
export interface CoinFlipState {
  step: "pickGuess" | "chooseFirst";
  guess?: "heads" | "tails";
  result?: "heads" | "tails";
  winner?: PlayerId;
}

// What to do with cards the player didn't pick when a pending pick resolves.
export type PendingPickFallback =
  | "shuffleIntoDeck" // search / top-peek effects
  | "bottomOfDeck" // a few peek effects
  | "returnToDiscard"; // discard-recovery effects

// Reveal-opponent's-hand prompt. The initiator (`player`) picks which cards
// from the target's hand (`target`) to act on (discard / move to bottom).
// Filter restricts which hand cards are eligible.
export interface PendingHandReveal {
  player: PlayerId;
  target: PlayerId;
  label: string;
  min: number;
  max: number;
  filter: "item" | "tool" | "itemOrTool" | "supporter" | "any";
  action: "discard" | "toBottomOfDeck";
  // Optional follow-up run by the resolver after the pick completes.
  postAction?:
    | { kind: "drawUntilHand"; targetSize: number } // Naveen
    | { kind: "searchDeckAnyPokemon"; max: number; label: string }; // Ultra Ball
}

// Click-an-in-play-Pokémon prompt. `scope` restricts which side/slot is
// pickable; `filter` narrows further (e.g. "only Pokémon with a Tool").
// `action` tells the resolver what to do with the chosen target.
export interface PendingInPlayTarget {
  player: PlayerId; // whose click resolves this
  label: string;
  scope: "own" | "opp" | "both";
  slot: "active" | "bench" | "anywhere";
  filter?:
    | "hasTool"
    | "hasSpecialEnergy"
    | "hasAnyEnergy"
    | "hasBasicEnergy"
    | "isBasic"
    | "anyPokemon";
  // Action descriptor. `remaining` supports multi-pick effects (Tool Scrapper).
  action:
    | { kind: "enhancedHammer" }
    | { kind: "crushingHammer" }
    | { kind: "pokemonCatcher" }
    | { kind: "toolScrapper"; remaining: number }
    | { kind: "heavyBaton"; count: number; source: string } // source = KO'd Pokémon instanceId (already gone; source fed via state)
    | { kind: "scoopUpCyclone" }
    | { kind: "lisiasAppeal" }
    | { kind: "nPlanEnergySource"; remaining: number }
    | { kind: "wallysCompassion" }
    | { kind: "energySwitchSource" } // first step: user picks the source Pokémon
    | { kind: "energySwitchDest"; sourceInstanceId: string } // second step: user picks destination
    | { kind: "jacintheHeal" } // Jacinthe — heal 150 from a damaged Psychic
    | { kind: "pokeVitalAHeal" } // Poké Vital A — heal 150 from any damaged ally
    | { kind: "wondrousPatchAttach" }; // Wondrous Patch — attach Psychic from discard to a Benched Psychic
}

export interface PendingPick {
  player: PlayerId;
  // Human-readable description of what to pick.
  label: string;
  // Cards the player is choosing from (pulled out of their source zone).
  pool: Card[];
  min: number; // minimum picks required (0 for "may" effects)
  max: number; // maximum picks allowed
  // If set, only these pool indexes are pickable (rest are shown but disabled).
  eligibleIndexes?: number[];
  // What to do with unpicked cards once the pick resolves.
  unpicked: PendingPickFallback;
  // Where the pool came from — surfaced in the UI so the user knows Prize
  // cards are never involved in a deck search.
  source: "deck" | "deckTop" | "deckBottom" | "discard";
  // If true, the turn ends immediately when this pick resolves (Lumiose City).
  endTurnOnResolve?: boolean;
  // If true, picked Pokémon go straight onto the Bench instead of the hand
  // (Nest Ball, Buddy-Buddy Poffin, Hop's Bag, Lumiose City).
  toBench?: boolean;
  // If set, picked Energy cards are attached to the in-play Pokémon with this
  // instanceId (used by attack-driven searches with destination "attachSelf").
  attachToInstanceId?: string;
  // If true, picked Energy cards are attached round-robin across all of the
  // player's Pokémon (active + bench), starting from the Active.
  attachAll?: boolean;
  // If set, another deck search is opened immediately after this pick
  // resolves. Used by multi-stage search supporters like Dawn (Basic → Stage
  // 1 → Stage 2) where each stage has a different predicate.
  postResolveChain?: DeckSearchChainStep;
}

// Next step in a chained deck search — keyed by a symbolic id so the
// resolver knows which predicate + label to use for the next pick.
export type DeckSearchChainStep =
  | { kind: "dawn-stage1" } // Dawn: after picking the Basic, pick a Stage 1
  | { kind: "dawn-stage2" }; // Dawn: after picking the Stage 1, pick a Stage 2

// Short "hey, heads up" modal shown between chained deck searches when the
// current stage has no qualifying cards. Lets the player acknowledge the
// miss before the next stage's pick opens, so skipped stages aren't silent.
export interface PendingSearchNotice {
  player: PlayerId;
  message: string;
  // Optional follow-up: when the user clicks Continue, this chain step fires.
  nextChain: DeckSearchChainStep | null;
}

export interface LogEntry {
  turn: number;
  player: PlayerId | "system";
  text: string;
}

// Minimal RNG interface attached to GameState so effects can flip coins,
// shuffle, and pick targets without threading an extra parameter everywhere.
export interface GameRng {
  next(): number;
  int(maxExclusive: number): number;
}

export interface GameState {
  players: Record<PlayerId, PlayerState>;
  activePlayer: PlayerId;
  turn: number;
  phase: Phase;
  winner: PlayerId | null;
  log: LogEntry[];
  // True on the very first player's first turn — they cannot attack or play a Supporter.
  firstTurnNoAttack: boolean;
  // Stadium card currently in play (replaces previous when a new one is played).
  stadium: StadiumInPlay | null;
  // If non-null, game is paused waiting for this player to pick a new Active from their Bench.
  pendingPromote: PlayerId | null;
  // What to do once the promote resolves.
  //  - "endTurn": KO happened during attack, run endTurn next
  //  - "passTurn": KO happened during checkup, skip cleanup and pass to opponent
  //  - "secondAttack": a Festival Lead second-hit is queued; run it after the
  //    opponent promotes, then endTurn
  onPromoteResolved: "endTurn" | "passTurn" | "secondAttack" | null;
  // Queued repeat attack (Dipplin/Festival Lead "attack twice"). Set when the
  // first hit resolves and the attacker still qualifies for a second hit.
  pendingSecondAttack: { player: PlayerId; attackIndex: number } | null;
  // If non-null, a player is being asked to pick cards from a pool (search /
  // peek / discard recovery). Blocks normal actions until resolved.
  pendingPick: PendingPick | null;
  // If non-null, the named player must click one of their own benched
  // Pokémon to complete a switch (e.g., the Switch item). The UI shows a
  // status prompt; clicking a bench Pokémon resolves it.
  pendingSwitchTarget: PlayerId | null;
  // If non-null, a player must click an in-play Pokémon (own or opponent,
  // scoped by the action) to complete a trainer effect that needs a target
  // (Enhanced Hammer, Crushing Hammer on heads, Tool Scrapper, Heavy Baton,
  // Scoop Up Cyclone).
  pendingInPlayTarget: PendingInPlayTarget | null;
  // If non-null, a hand-reveal pick is pending (Eri, Xerosic's Machinations).
  pendingHandReveal: PendingHandReveal | null;
  // If non-null, an inter-stage search notice is pending (Dawn skipping an
  // empty category, etc.) — a small modal waits for the user to click
  // Continue before moving on to the next chained stage.
  pendingSearchNotice: PendingSearchNotice | null;
  // If non-null, Rare Candy has been played on a Basic and the player must
  // pick which Stage 2 (from their hand) to use when multiple match.
  pendingRareCandyChoice: {
    player: PlayerId;
    targetInstanceId: string;
    handIndexes: number[]; // indexes into the player's hand at the moment of the pick
  } | null;
  // Override for `snipeOne`-style attacks: when set, the effect targets the
  // opponent's bench Pokémon at this index instead of auto-picking. Cleared
  // after the attack.
  snipeTargetOverride: number | null;
  // Pre-game coin flip / first-player choice. Non-null until the winner has
  // picked first/second and hands are about to be dealt.
  coinFlip: CoinFlipState | null;
  rng: GameRng;
}
