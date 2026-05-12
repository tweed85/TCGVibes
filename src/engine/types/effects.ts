// Attack effects, predicates, filters. Discriminated unions used to drive
// data-driven attack resolution. Type-only cycle with ./cards is fine —
// no runtime values cross.

import type { EnergyType, StatusCondition } from "./cards";

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
  | { kind: "healEachOwnSubtype"; amount: number; subtype: "Basic" | "Stage 1" | "Stage 2" | "Evolution" | "Tera" }
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
  // "This attack [also] does N damage to 1 of your opponent's [Benched]
  // Pokémon." If the text says "Benched", the snipe targets bench only
  // (typically a follow-up after a main attack — Insta-Strike pattern).
  // If the text omits "Benched" (Fezandipiti ex Cruel Arrow), the player
  // may target Active or Bench, with W/R applied to the Active target.
  | { kind: "snipeOne"; damage: number; benchOnly: boolean }
  // "N damage to 1 of your opponent's Pokémon for each <type> Energy
  // attached to this Pokémon." (Genesect Bug's Cannon — N=20×Grass count.)
  // Targets opp Active or Bench (not "Benched only" — covers either). Apply
  // W/R only when target is Active per parenthetical.
  | { kind: "snipeOnePerEnergy"; perEnergy: number; energyType: EnergyType }
  // Duskull "Come and Get You": "Put up to N <SelfName> from your discard
  // pile onto your Bench." `selfNameOnly: true` flags the same-name match;
  // a future variant could allow line-name (e.g. "Hop's Phantump").
  | { kind: "recurSelfFromDiscardToBench"; max: number; selfNameOnly: true }
  // "This attack does N damage to 2/3 of your opponent's Pokémon." Hits both
  // Active + Bench; auto-picks the most-damaged targets.
  | { kind: "damageMultipleTargets"; damage: number; count: number; benchOnly: boolean }
  // "Choose 1 of your opponent's Pokémon N times. ... For each time you
  // chose a Pokémon, do M damage to it." (Arboliva ex Oil Salvo.) Damage
  // is repeatable on the same target; bypasses Weakness/Resistance per
  // standard ruling for these distributed-damage attacks.
  // `benchOnly` covers "Put N damage counters on your opponent's BENCHED
  // Pokémon in any way you like" (Dragapult ex Phantom Dive). counter
  // placement always bypasses W/R, so we encode it as the same kind.
  | { kind: "distributeDamage"; times: number; perHit: number; ignoreWR: boolean; benchOnly?: boolean }
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
  // "This attack does N less damage for each Energy attached to the opp's
  // Active Pokémon." (Tinkaton Windup Swing)
  | { kind: "damageReducedPerEnergyOnDefender"; perCount: number }
  // "Discard N <Type> Energy from your hand. If you can't, this attack does
  // nothing." (Ceruledge Infernal Slash)
  | { kind: "discardEnergyFromHandOrFizzle"; count: number; energyType?: EnergyType }
  // "Shuffle this Pokémon and all attached cards into your deck." (Lokix)
  | { kind: "selfShuffleIntoDeck" }
  // "Put N <Type> Energy attached to this Pokémon into your hand."
  // (Volcanion Backfire) — moves attached energy back to hand.
  | { kind: "returnAttachedEnergyToHand"; count: number; energyType?: EnergyType }
  // "This attack also does N damage to each Benched Pokémon (both yours and
  // your opponent's)." (Gloom Disperse Drool)
  | { kind: "alsoDamageEachBench"; damage: number; sides: "both" | "opp" | "self" }
  // "This attack does N damage for each Pokémon Tool attached to all
  // Pokémon (both sides)." (Bronzong Tool Drop)
  | { kind: "perAttachedToolBothSides"; perCount: number }
  // "This attack does N damage for each damage counter on all of your
  // Benched <named> Pokémon." (Raticate Retaliatory Incisors)
  | { kind: "perDamageCounterOnBenchNamed"; perCount: number; namePart: string }
  // Move 1 attached energy of a given type from this Pokémon to a Benched
  // Pokémon. (Frosmoth Cold Cyclone)
  | { kind: "moveOneEnergyToBench"; energyType?: EnergyType }
  // Discard a single attached energy of a given type from this Pokémon
  // (cost-style; not energy-for-damage). (Raichu Strong Volt)
  | { kind: "discardSingleAttachedEnergy"; energyType?: EnergyType }
  // "This attack does +N damage for each Prize card your opponent took
  // during their last turn." (Okidogi Settle the Score)
  | { kind: "perPrizeOppTookLastTurn"; perCount: number }
  // Search deck for a mix of cards by filter list, all to hand. (Celebi
  // Traverse Time: 3 cards in any combination of Grass Pokémon and Stadium
  // cards.) Each filter slot independently matches one card.
  | { kind: "searchDeckMixedToHand"; max: number; filters: AttackSearchFilter[] }
  // Search deck for up to N basic <Type> Pokémon and put them onto your
  // Bench. (Xerneas Geo Gate)
  | { kind: "searchDeckBasicTypeToBench"; max: number; pokemonType: EnergyType }
  // "Search your deck for any number of Pokémon that have '<Name>' in their
  // name and put them onto your Bench." (Rotom Roto Call) — capped by
  // available bench slots.
  | { kind: "searchDeckNamedPokemonToBench"; namePart: string }
  // "Discard random cards from your opponent's hand until they have N cards
  // in their hand." (Furfrou Hand Trim) — only fires if opp's hand is over
  // the cap. Random selection per cycle.
  | { kind: "oppHandTrimToCount"; targetCount: number }
  // Energy Sketch family — flip N coins, attach <count> Basic Energy from
  // discard to bench based on heads. (Smeargle Energizing Sketch)
  | { kind: "flipNAttachBasicFromDiscardToBench"; coins: number }
  // "Flip a coin until you get tails. Search your deck for a number of
  // basic Energy up to the number of heads and attach to this Pokémon."
  // (Snorlax Gormandizer)
  | { kind: "flipUntilTailsAttachBasicSelf" }
  // "Discard up to N Energy cards from your hand. +M damage per discard."
  // (Mawile Double Eater) — same shape as discardOwnEnergyForDamage but the
  // discard source is HAND, not the attacker's attached energy.
  | { kind: "discardEnergyFromHandForDamage"; max: number; damagePer: number }
  // "Search deck for up to N Basic Energy cards of different types and
  // attach to your <subtypeFilter> Pokémon in any way." (Terapagos Prism Charge)
  | { kind: "searchBasicEnergyDifferentTypesToBenchSubtype"; max: number; benchSubtype: string }
  // "Move a Water Energy from this Pokémon to a Benched <type> Pokémon."
  // (Frosmoth) — already covered above by moveOneEnergyToBench; kept for
  // forward compatibility with type-targeted variants.
  | { kind: "selfDamageAndStatusOpp"; selfDamage: number; status: StatusCondition }
  // Self-bench snipe — "This attack also does N damage to 1 of your Benched
  // Pokémon." (Manectric Flash Impact)
  | { kind: "alsoDamageOwnBench"; damage: number }
  // Search deck for a single Basic <Type> Energy and attach it to one of
  // your Pokémon. (Teal Mask Ogerpon Grass Kagura, Hearthflame Mask, Wellspring Mask)
  | { kind: "searchBasicEnergyAttachOne"; energyType: EnergyType }
  // Search deck for up to N <named> Pokémon and put them in hand. (Misty's
  // Lapras Swim Together)
  | { kind: "searchDeckNamedPokemonToHand"; namePart: string; max: number }
  // "This attack does N more damage for each <named> card in your discard
  // pile." (Ethan's Typhlosion Buddy Blast — Ethan's Adventure)
  | { kind: "perCardInOwnDiscardNamed"; namePart: string; perCount: number }
  // "This attack does N damage for each of your Pokémon that has '<X>' in
  // its name that has any damage counters." (Paldean Tauros Raging Charge)
  | { kind: "perOwnPokemonNamedWithDamage"; namePart: string; perCount: number }
  // Discard top N from deck; +M damage per discarded card matching <named>.
  // (Misty's Gyarados Splashing Panic)
  | { kind: "discardTopNAndDamagePerNamed"; topN: number; namePart: string; perCount: number }
  // Search deck for up to N basic <named> Pokémon and bench. (Steven's
  // Baltoy Summoning Sign)
  | { kind: "searchDeckBasicNamedToBench"; namePart: string; max: number }
  // "Discard N <Type> Energy cards from your hand, and Knock Out your
  // opponent's Active Pokémon. If you can't discard N cards in this way,
  // this attack does nothing." (Hydrapple Hydra Breath)
  | { kind: "discardEnergyFromHandAndKoOpp"; count: number; energyType: EnergyType }
  // "Choose 1 of your opponent's Active Pokémon's attacks and use it as
  // this attack." (Clefable Metronome — auto-pick first opp attack the
  // attacker can pay for; the engine resolves it as a regular attack.)
  | { kind: "useOppActiveAttack"; coinFlip?: boolean }
  // "Choose 1 of your Benched <Name> Pokémon's attacks and use it as this
  // attack." (N's Zoroark ex Night Joker — picks the highest-damage attack
  // among the named bench whose cost the attacker can pay.) Cost is paid
  // from THIS Pokémon's attached Energy; the source attack's effects are
  // copied verbatim, but the actor stays the holder of Night Joker.
  | { kind: "useBenchedAllyNamedAttack"; namePart: string }
  // Move all damage counters from one of your Benched <named> Pokémon to
  // opp's Active. (Team Rocket's Wobbuffet Rocket Mirror)
  | { kind: "moveAllBenchDamageNamedToOppActive"; namePart: string }
  // Flip 3 coins; put up to N=heads cards from discard to hand. (Stoutland
  // Odor Sleuth)
  | { kind: "flipNRecoverDiscardToHand"; coins: number; filter: AttackSearchFilter }
  // Attach a Basic Energy from hand to this Pokémon (no type filter).
  // (Tornadus Wrapped in Wind)
  | { kind: "attachBasicEnergyFromHandToSelf" }
  // Discard up to N Supporter cards with <named> from hand; +M damage per
  // discard. (Team Rocket's Honchkrow Rocket Feathers)
  | { kind: "discardNamedSupporterFromHandForDamage"; namePart: string; perCount: number; max: number }
  // "Flip a coin for each <Type> Pokémon you have in play. This attack
  // does N damage for each heads." (Scrafty Ruffians Attack)
  | { kind: "flipPerPokemonOfTypePerHeads"; energyType: EnergyType; perHeads: number }
  // "If this Pokémon has N or more <Type> Energy attached, this attack
  // does M more damage." (Abomasnow Frozen Wood)
  | { kind: "ifSelfEnergyAtLeastBonus"; energyType: EnergyType; count: number; bonus: number }
  // Inteleon Bring Down: "Choose a Pokémon in play (yours or your
  // opponent's) that has the least HP remaining, except this Pokémon, and
  // it is Knocked Out."
  | { kind: "koLowestHpInPlay" }
  // Shiftry Reversing Gust: "Flip a coin. If heads, choose 1 of your
  // opponent's Pokémon. Shuffle that Pokémon and all attached cards into
  // their deck."
  | { kind: "flipShuffleOppPokemonIntoDeck" }
  // Sandslash Sand Attack: "During your opponent's next turn, if the
  // Defending Pokémon tries to use an attack, your opponent flips a coin.
  // If tails, that attack doesn't happen."
  | { kind: "defenderAttackCoinFlipNextTurn" }
  // Pachirisu Electrified Incisors: "During your opponent's next turn,
  // whenever they attach an Energy card from their hand to the Defending
  // Pokémon, place 8 damage counters on that Pokémon."
  | { kind: "defenderEnergyAttachPenaltyNextTurn"; counters: number }
  // Watchog Focus Energy: "During your next turn, this Pokémon's <Name>
  // attack's base damage is N." (Generalizes selfNextTurnAttackBonus to
  // a fixed override.)
  | { kind: "selfNextTurnAttackBaseOverride"; attackName: string; baseDamage: number }
  // Crawdaunt Cutting Riposte: "If this Pokémon has any damage counters
  // on it, this attack can be used for <Type>." (Type-cost rewriting.)
  | { kind: "altTypeCostIfDamaged"; energyType: EnergyType }
  // Salazzle Sudden Scorching: "Your opponent discards a card from their
  // hand. If this Pokémon evolved from <Source> during this turn, your
  // opponent discards 2 more cards."
  | { kind: "oppDiscardWithEvolveBonus"; baseCount: number; bonusCount: number; sourceCardName: string }
  // N's Vanilluxe Snow Coating: "Double the number of damage counters on
  // each of your opponent's Pokémon."
  | { kind: "doubleOppDamageCounters" }
  // Team Rocket's Murkrow Torment: "Choose 1 of your opponent's Active
  // Pokémon's attacks. During your opponent's next turn, that Pokémon
  // can't use that attack." (Auto-pick the most-impactful attack.)
  | { kind: "lockOneOppAttackNextTurn" }
  // Team Rocket's Blipbug Searching Eyes: "Look at 1 of your opponent's
  // face-down Prize cards." (No mechanical effect in our engine since we
  // don't track face-up Prize state, but logged.)
  | { kind: "peekOppPrize" }
  // Gothorita Fortunate Eye: "Look at the top 5 cards of your opponent's
  // deck and put them back in any order." (No-op for AI; logged.)
  | { kind: "peekOppDeckTop"; count: number }
  // Cinderace Turbo Flare: "Search your deck for up to N Basic Energy
  // cards and attach them to your Benched Pokémon in any way you like."
  | { kind: "searchBasicEnergyAttachBench"; max: number }
  // Dialga Chrono Burst: "You may shuffle all Energy attached to this
  // Pokémon into your deck and have this attack do N more damage."
  | { kind: "optionalShuffleSelfEnergyForBonus"; bonus: number }
  // Meloetta Soothing Melody: "Heal N damage from 1 of your Benched
  // <Type> Pokémon."
  | { kind: "healOneBenchPokemonByType"; amount: number; pokemonType: EnergyType }
  // Miltank Bellyful of Milk: "Flip 2 coins. If both of them are heads,
  // heal all damage from 1 of your Pokémon."
  | { kind: "flipBothHeadsHealOne" }
  // Dedenne Tail Generator: "Choose Basic <Type> Energy cards from your
  // discard pile up to the amount of Energy attached to all of your
  // opponent's Pokémon and attach them to your <Type> Pokémon in any way."
  | { kind: "attachDiscardEnergyByOppEnergy"; energyType: EnergyType; pokemonType: EnergyType }
  // Kyogre Riptide: "This attack does N damage for each Basic <Type>
  // Energy card in your discard pile. Then, shuffle those cards into your
  // deck."
  | { kind: "perBasicEnergyInDiscardThenShuffle"; energyType: EnergyType; perCount: number }
  // Boldore Smack Down: "If your opponent's Active Pokémon has Fighting
  // Resistance, this attack does N more damage."
  | { kind: "ifDefenderHasResistanceOfTypeBonus"; resistanceType: EnergyType; bonus: number }
  // Basculin Bared Fangs: "If your opponent's Active Pokémon has no damage
  // counters on it before this attack does damage, this attack does
  // nothing."
  | { kind: "fizzleIfDefenderUndamaged" }
  // Team Rocket's Exeggutor Tri Kinesis: "Flip 3 coins. If all of them
  // are heads, Knock Out 1 of your opponent's Pokémon." (Auto-target
  // most-damaged opp Pokémon.)
  | { kind: "flipAllHeadsKoOppOne"; coins: number }
  // Chi-Yu Scorching Earth: "If your opponent has a Stadium in play,
  // discard it. If you do, your opponent can't play any Stadium cards
  // from their hand during their next turn."
  | { kind: "discardOppStadiumAndLock" }
  // Medicham Harmonious Spirit Palm: "If this Pokémon and your opponent's
  // Active Pokémon have the same amount of Energy attached, this attack
  // does N more damage."
  | { kind: "ifEqualEnergyBonus"; bonus: number }
  // Search deck for up to N Basic <Type> Energy cards and attach to bench.
  // (Boltund Electrifying Dash)
  | { kind: "searchBasicEnergyTypeAttachBench"; max: number; energyType: EnergyType }
  // Move any amount of <Type> Energy among your Pokémon. (Forretress)
  | { kind: "moveAnyEnergyAcrossOwn"; energyType?: EnergyType }
  // Attach a Basic <Type> Energy card from discard to this Pokémon. (Varoom)
  | { kind: "attachBasicEnergyDiscardToSelfTyped"; energyType: EnergyType }
  // Put a Basic <Type> Energy card from discard into your hand. (Poltchageist)
  | { kind: "recoverBasicEnergyTypeToHand"; energyType: EnergyType }
  // Heal N damage from 1 of your Benched Pokémon of <subtype> (e.g. Ancient).
  // (Scream Tail Supportive Singing)
  | { kind: "healOneBenchBySubtype"; amount: number; subtype: string }
  // "Put up to N damage counters on this Pokémon. This attack does M damage
  // for each damage counter you placed in this way." (Walking Wake)
  | { kind: "selfPlaceCountersForDamage"; max: number; damagePer: number }
  // "Discard a Basic <Type> Energy card from your hand. If you can't, this
  // attack does nothing." (Decidueye Power Shot — single energy)
  | { kind: "discardSingleEnergyFromHandOrFizzle"; energyType: EnergyType }
  // Vikavolt Circuit Cannon: "This attack does N more damage for each of
  // your Benched <Name>."
  | { kind: "perBenchPokemonNamed"; namePart: string; perCount: number }
  // Aggron Angry Slam / Hawlucha: "This attack does N damage for each of
  // your Pokémon that has any damage counters on it." (in play, both
  // active and bench)
  | { kind: "perOwnPokemonWithDamage"; perCount: number }
  // "If you have more Prize cards remaining than your opponent, +N damage."
  // (Hawlucha Prize Count)
  | { kind: "ifMorePrizesThanOpp"; bonus: number }
  // Move any number of damage counters from opp's Bench to opp's Active.
  // (Sableye Damage Collection)
  | { kind: "moveAllOppBenchDamageToOppActive" }
  // "This attack does N more damage for each Colorless in opp Active's
  // Retreat Cost." (Ariados String Bind)
  | { kind: "perColorlessOnDefenderRetreat"; perCount: number }
  // "Discard up to N <Type> Energy cards from your Pokémon. +M damage per."
  // (Sinistcha Spill the Tea — variant of discardOwnEnergyForDamage with
  // a specific energy type filter that walks ALL of your Pokémon, not just
  // attacker.)
  | { kind: "discardEnergyAnywhereForDamage"; max: number; damagePer: number; energyType?: EnergyType }
  // "Put N damage counters on 1 of your opponent's Pokémon for each Basic
  // <Type> Energy card in your discard pile. Then, shuffle those Energy
  // cards into your deck." (Sinistcha ex Re-Brew)
  | { kind: "perBasicEnergyDiscardCountersOnOpp"; perCount: number; energyType: EnergyType }
  // "Discard a card from your hand. If you do, your opponent discards a
  // card from their hand." (Team Rocket's Porygon Hacking)
  | { kind: "discardOwnAndOppHand" }
  // "Attach up to N Basic Energy cards from your discard pile to your
  // Pokémon in any way you like." (Morpeko Pick and Stick)
  | { kind: "attachAnyBasicEnergyDiscardN"; max: number }
  // "During your opponent's next turn, they can't play any Pokémon from
  // their hand to evolve their Pokémon." (Bronzong Evolution Jammer)
  | { kind: "blockOppEvolveNextTurn" }
  // "During your opponent's next turn, attacks used by the Defending
  // Pokémon cost Colorless more, and its Retreat Cost is Colorless more."
  // (Rillaboom Drum Beating)
  | { kind: "defenderAttackAndRetreatCostUpNextTurn"; amount: number }
  // "Attach a Basic <Type> Energy card from your hand to 1 of your Benched
  // Pokémon. If you do, heal all damage from that Pokémon." (Leafeon
  // Leaflet Blessings)
  | { kind: "attachBasicEnergyTypeToBenchAndHeal"; energyType: EnergyType }
  // Bench-shuffle (your): "Shuffle 1 of your Benched Pokémon and all
  // attached cards into your deck." (Chimecho Homeward Chime)
  | { kind: "shuffleOwnBenchPokemonIntoDeck" }
  // "Put N damage counters on 1 of your opponent's Pokémon." (Swirlix
  // Sneaky Placement) — generalizes single-target counter placement.
  | { kind: "placeCountersOnOneOpp"; counters: number }
  // Conkeldurr Gutsy Swing: "If this Pokémon is affected by a Special
  // Condition, ignore all Energy in this attack's cost." (Cost rewrite)
  | { kind: "freeCostIfStatus" }
  // Mega Heracross ex Juggernaut Horn: "If this Pokémon was damaged by an
  // attack during your opponent's last turn, this attack does that much
  // more damage." (Variable bonus = damage taken.)
  | { kind: "damageEqualToDamageTakenLastTurn" }
  // Cresselia Crescent Purge: "You may turn 1 of your face-down Prize
  // cards face up. If you do, this attack does N more damage." (Auto-take
  // the bonus since prize face-up tracking isn't modeled.)
  | { kind: "autoOptionalBonus"; bonus: number }
  // Iron Valiant Majestic Sword: "If you played a <subtype> Supporter
  // card from your hand during this turn, this attack does N more damage."
  | { kind: "ifPlayedSupporterSubtypeBonus"; supporterSubtype: string; bonus: number }
  // Hippowdon Super Sandstorm: "This attack also does N damage to each
  // Benched Pokémon that has any damage counters on it (both yours and
  // opponent's)."
  | { kind: "alsoDamageBenchWithCounters"; damage: number }
  // Bronzong-style: "This attack does N damage for each Pokémon in play
  // that has '<X>' or '<Y>' in its name (both yours and your opponent's)."
  | { kind: "perInPlayPokemonNamed"; namePart: string; perCount: number; bothSides: boolean }
  // Boldore-style mass deck-search-and-bench. (Grubbin/Froakie Flock —
  // already have searchDeckNamedPokemonToBench but not the "up to N"
  // variant; we add the bounded version.)
  | { kind: "searchDeckNamedToBenchN"; namePart: string; max: number }
  // Pokémon ex bespoke effects ----------------------------------------------
  // Persian ex Haughty Order: reveal top N of opp deck, choose one attack
  // from a Pokémon found there and use it as this attack. Auto-pick the
  // highest-damage attack; shuffle revealed back into opp's deck.
  | { kind: "useAttackFromOppDeckTop"; revealCount: number }
  // Scream Tail ex Scream: block opp from playing Supporter cards next turn.
  | { kind: "blockOppSupportersNextTurn" }
  // Lapras ex Larimar Rain: look at top N of YOUR deck, attach any number
  // of Energy cards from those to your Pokémon, shuffle the rest back.
  | { kind: "topNAttachAnyEnergyToOwn"; count: number }
  // Palossand ex Barite Jail: put damage counters on each opp Bench until
  // its remaining HP is N.
  | { kind: "fillOppBenchUntilHpN"; targetHp: number }
  // Alolan Exeggutor ex Swinging Sphene: coin flip → KO opp Active Basic
  // (heads) or KO 1 opp Benched Basic (tails).
  | { kind: "flipKoOppActiveOrBenchedBasic" }
  // Leafeon ex Moss Agate: heal N from each of your Benched Pokémon.
  // Variant of healEachOwnPokemon limited to bench.
  | { kind: "healEachOwnBench"; amount: number }
  // Flareon ex Burning Charge: search up to N Basic Energy and attach to
  // 1 of your Pokémon (auto-target attacker).
  | { kind: "searchBasicEnergyAttachOneN"; max: number }
  // Glaceon ex Euclase: KO ANY opp Pokémon with exactly N damage counters.
  | { kind: "koOppAnyWithExactlyDamageCounters"; counters: number }
  // Espeon ex Amazez: devolve each opp evolved Pokémon by shuffling its
  // highest-stage card into the opponent's deck.
  | { kind: "devolveAllOppEvolvedToDeck" }
  // Veluza ex Purging Strike: optionally discard your hand for +N damage.
  // Auto-discards (always opt-in) since the bonus typically wins.
  | { kind: "optionalDiscardHandForBonus"; bonus: number }
  // Mimikyu ex Mischievous Hands: place N damage counters on each of M opp
  // Pokémon (auto-pick most-damaged among Active+Bench).
  | { kind: "placeCountersOnNOpp"; counters: number; targetCount: number }
  // Dudunsparce ex Tenacious Tail: +N per opp Pokémon ex in play.
  | { kind: "perOppPokemonEx"; perCount: number }
  // Mamoswine ex Rumbling March: +N per Stage 2 on your Bench.
  | { kind: "perOwnBenchSubtype"; subtype: string; perCount: number }
  // Per-Supporter-named in own discard. (TR Porygon2/Porygon-Z R Command)
  | { kind: "perSupporterInOwnDiscardNamed"; namePart: string; perCount: number }
  // Per-Pokémon-in-own-discard that has a specific attack name. (Dartrix
  // United Wings — "20 damage for each Pokémon in your discard pile that
  // has the <Name> attack.")
  | { kind: "perPokemonInDiscardWithAttack"; attackName: string; perCount: number }
  // Discard all opp Tools AND opp Active Special Energy. (Mow Rotom
  // Reaping Dash) — bundles two existing one-off effects.
  | { kind: "discardAllOppToolsAndSpecialEnergy" }
  // Optional self-energy-to-hand for damage bonus. (Zarude Jungle Whip)
  // Distinct from optionalShuffleSelfEnergyForBonus (which sends to deck).
  | { kind: "optionalSelfEnergyToHandForBonus"; bonus: number }
  // Shuffle 1 of opp's Benched Pokémon into their deck. (Illumise Slowing
  // Perfume — has its own go-second-T1 gate via fizzleIfNot.)
  | { kind: "shuffleOppBenchedIntoDeck" }
  // Win the game outright if a prize-count condition is met.
  // (N's Sigilyph Victory Symbol — exactly 1 Prize remaining)
  | { kind: "winGameIfPrizesEquals"; prizes: number }
  // Both Active Pokémon are KO'd. (Annihilape Destined Fight)
  | { kind: "bothActiveKnockedOut" }
  // Look at top N of your own deck (info-only). (Iron Valiant Calculation)
  | { kind: "peekOwnDeckTop"; count: number }
  // Search deck for a single Stadium card and put it into hand.
  // (Hop's Silicobra Turf Maker)
  | { kind: "searchStadiumToHand" }
  // Put a Trainer card from your discard pile into your hand.
  // (Dedenne Electromagnetic Sonar)
  | { kind: "recoverTrainerFromDiscardToHand" }
  // Shuffle up to N Basic <Type> Energy cards from discard back to deck.
  // (Wooper Scoop Water)
  | { kind: "shuffleBasicEnergyDiscardToDeck"; max: number; energyType: EnergyType }
  // Discard the top N cards of your deck. (Fraxure Dragon Pulse — simple
  // mill-self.)
  | { kind: "millOwnDeck"; count: number }
  // Discard top N + N damage per energy card discarded. (Quagsire
  // Drenched Headbutt)
  | { kind: "discardTopNAndDamagePerEnergy"; topN: number; perCount: number }
  // 2 damage counters on each opp Pokémon that has any damage counters.
  // (Yveltal Corrosive Winds)
  | { kind: "countersOnEachDamagedOpp"; counters: number }
  // N damage counters on each opp Pokémon. (Uxie Painful Memories)
  | { kind: "countersOnEachOpp"; counters: number }
  // N damage counters on each Pokémon (both sides) that has an Ability.
  // (Cofagrigus Law of the Underworld)
  | { kind: "countersOnEachWithAbility"; counters: number }
  // Search deck for a Pokémon that evolves from one of your Pokémon and
  // put it on. (Duosion Cellular Evolution)
  | { kind: "searchAndEvolveOne" }
  // Search deck for any number of Basic <Name> Pokémon and bench them.
  // (Lillie's Comfey Inviting Flowers)
  | { kind: "searchAnyBasicNamedToBench"; namePart: string }
  // Search deck for up to N Basic <Type> Energy and attach to one of your
  // Benched Pokémon. (Smoochum Delightful Kiss)
  | { kind: "searchBasicEnergyTypeAttachOneBench"; energyType: EnergyType; max: number }
  // Attach up to N Basic <Type> Energy from your hand to your Pokémon in
  // any way you like. (Mesprit Full Heart)
  | { kind: "attachBasicEnergyTypeFromHandN"; energyType: EnergyType; max: number }
  // N more damage per damage counter on all opp Pokémon (sum across all).
  // (Azelf Neurokinesis)
  | { kind: "perDamageCounterOnAllOpp"; perCount: number }
  // Self gets +N attack damage during your next turn (broad — applies to
  // all attacks). (Kilowattrel Wind Power Charge — modeled by tracking on
  // the Pokémon and consulting in actions.ts.)
  | { kind: "selfNextTurnAllAttacksBonus"; bonus: number }
  // During opp's next turn, if they attach an Energy from hand to the
  // Defending Pokémon, their turn ends. (Hypno Daydream)
  | { kind: "oppEnergyAttachEndsTurn" }
  // The Defending Pokémon takes N more damage from attacks during your
  // next turn. (Vibrava Screech)
  | { kind: "defenderTakesMoreNextTurn"; bonus: number }
  // Lock your own Pokémon from attacking next turn. (Electivire Unleash
  // Lightning)
  | { kind: "lockOwnAttackersNextTurn" }
  // During opp's next turn, Pokémon with N or fewer Energy attached can't
  // attack. (Walrein Frigid Fangs)
  | { kind: "lockOppLowEnergyAttackersNextTurn"; maxEnergy: number }
  // Damage reduced per Colorless in opp's retreat. (Iron Bundle Gusting
  // Collision — opposite direction of perColorlessOnDefenderRetreat.)
  | { kind: "damageReducedPerColorlessOnDefenderRetreat"; perCount: number }
  // Prevent damage to your <Subtype> Pokémon from attacks by opp's ex
  // during opp's next turn. (Miraidon C.O.D.E.: Protect)
  | { kind: "protectSubtypeFromExNextTurn"; subtype: string }
  // +N Prize cards if the Defending Pokémon is KO'd during your next
  // turn. (Ribombee Plentiful Pollen)
  | { kind: "bonusPrizesIfDefenderKoNextTurn"; bonus: number }
  // N damage per Item card in opp's discard pile. (Tirtouga Ancient
  // Seaweed)
  | { kind: "perItemInOppDiscard"; perCount: number }
  // Move 1 attached Energy from opp's Active to opp's hand. (Octillery
  // Aqua Wash, Paldean Tauros Upthrusting Horns variants)
  | { kind: "bounceOppActiveEnergyToOppHand"; count: number; defenderSubtype?: string }
  // Devolve 1 opp Pokémon (highest stage to opp's hand). (Espathra
  // Mystical Eyes)
  | { kind: "devolveOneOppToHand" }
  // Move all damage counters from 1 of your Benched <Subtype> Pokémon to
  // opp Active. (Flutter Mane Perplexing Transfer — Ancient subtype)
  | { kind: "moveAllBenchDamageBySubtypeToOppActive"; subtype: string }
  // Defender of <Subtype> can't attack next turn. (Paldean Tauros
  // Blocking Stomp — Basic subtype only)
  | { kind: "defenderOfSubtypeCantAttackNextTurn"; subtype: string }
  // 60 per opp Pokémon ex OR Pokémon V in play. (Zoroark Illusory
  // Hijacking)
  | { kind: "perOppPokemonExOrV"; perCount: number }
  // Discard all Special Energy from all opp's Pokémon. (Ceruledge Cursed
  // Edge)
  | { kind: "discardAllOppSpecialEnergy" }
  // Discard own Tools or fizzle. (Melmetal Reforged Axe — discard all
  // Pokémon Tools from this Pokémon; if can't, attack does nothing.)
  | { kind: "discardOwnToolsOrFizzle" }
  // Search opp's discard for up to N Energy cards and attach to opp's
  // Pokémon. (Grafaiai Mischievous Painting)
  | { kind: "attachOppDiscardEnergyToOpp"; max: number }
  // Each player draws N. (Comfey Flower Shower)
  | { kind: "eachPlayerDrawsN"; count: number }
  // Flip until tails, search up-to-heads cards from deck to hand.
  // (Gholdengo All-You-Can-Grab)
  | { kind: "flipUntilTailsSearchToHand" }
  // Use opp's Active <Subtype> Pokémon's attack. (TR Mimikyu Gemstone
  // Mimicry — Tera subtype.)
  | { kind: "useOppActiveAttackOfSubtype"; subtype: string }
  // Search and evolve up to N of your Pokémon (TR Nidorina Dark Awakening)
  // — picks up to N <Type> Pokémon, finds an evolution for each.
  | { kind: "searchAndEvolveNamedTypePokemon"; energyType: EnergyType; max: number }
  // Counter damage equal to damage taken next turn. (Zamazenta Strong
  // Bash) — equivalent to Counterattacking Crest sized to incoming damage.
  | { kind: "counterAttackerEqualToTakenNextTurn" }
  // Search 2 cards, then put on top of deck in any order. (Dialga Time
  // Manipulation)
  | { kind: "searchAndTopdeckTwo" }
  // Attach an Energy card from discard to this Pokémon (any type).
  // (Landorus Fist of Focus)
  | { kind: "attachAnyEnergyDiscardToSelf" }
  // Attach a Basic <Type> Energy from your discard pile to one of your
  // <Type-of-Pokémon> Pokémon. (Druddigon Dragon's Fury — Fire to Dragon)
  | { kind: "attachBasicEnergyDiscardToTypePokemon"; energyType: EnergyType; pokemonType: EnergyType }
  // Place damage counters that deal 50 to each Pokémon in play with damage
  // counters except this Pokémon. (Raichu Collateral Bolts)
  | { kind: "damageEachWithCountersExceptSelf"; damage: number }
  // Drifblim Everyone Explode Now: 50 damage per X-named in play, plus 30
  // self-damage to each X-named in play.
  | { kind: "perNamedInPlayWithSelfDamage"; namePart: string; perCount: number; selfDamage: number }
  // Flip a coin; if heads, choose a Special Condition for opp Active.
  // (Grafaiai Miraculous Paint — auto-pick the most-impactful: Asleep.)
  | { kind: "flipChooseStatusOpp" }
  // Slowking Seek Inspiration: discard top of deck; if Pokémon w/o Rule
  // Box, copy one of its attacks. Auto-pick the highest-damage attack.
  | { kind: "discardTopUsePokemonNoRuleBoxAttack" }
  // Musharna Dream Calling: search any number of "Fennel" cards and put
  // into hand. Variant of named-trainer-search.
  | { kind: "searchAnyNamedTrainerToHand"; namePart: string }
  // Move 1 Energy from one opp Pokémon to another (auto-pick: from the
  // most-energized to a Pokémon with the least). (Elgyem Slight Shift)
  | { kind: "moveOppEnergyAcrossOpp" }
  // Flip N coins, attach <count> Basic <Type> Energy from discard to bench.
  // (Pachirisu Crackling Charge — typed variant of flipNAttachBasicFromDiscardToBench)
  | { kind: "flipNAttachBasicTypeFromDiscardToBench"; coins: number; energyType: EnergyType }
  // Search deck for up to N Basic Energy and attach to <Subtype> Pokémon.
  // (Miraidon Peak Acceleration — Future)
  | { kind: "searchBasicEnergyAttachSubtype"; max: number; subtype: string }
  // Tiered coin flip damage. (Zangoose Fury Cutter — different bonus per
  // heads-count after N coins.)
  | { kind: "tieredFlipDamage"; coins: number; tiers: number[] }
  // Search deck for any Energy cards (basic AND special) to hand.
  // (Heliolisk Parabolic Charge)
  | { kind: "searchAnyEnergyToHand"; max: number }
  // Rewrite the Defending Pokémon's Weakness type for opp's next turn.
  // (Oranguru "Now You're in My Power")
  | { kind: "rewriteDefenderWeaknessNextTurn"; toType: EnergyType }
  // Status-only "only if this used <attack> last turn" gate (Miltank
  // Moomoo Rolling). Implemented as a fizzle predicate.
  | { kind: "fizzleUnlessUsedAttackLastTurn"; attackName: string }
  // Both Active Pokémon are now <Status>. (Komala Slumbering Smack)
  | { kind: "bothActiveNowStatus"; status: StatusCondition }
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
  | { kind: "moveOppEnergyToBench"; count: number }
  // Discard the top card of YOUR deck. If it's a Supporter, use its effect
  // as the effect of this attack. (Ninetales me1-20 Supernatural
  // Shapeshifter.)
  | { kind: "discardTopOfOwnDeckUseSupporterEffect" }
  // At the end of opp's NEXT turn, discard the Defending Pokémon and all
  // attached cards (treated as a KO — prizes are taken). (Team Rocket's
  // Grimer sv10-123 Corrosive Sludge.)
  | { kind: "discardDefenderEndOfOppNextTurn" }
  // me4 (Chaos Rising) additions ---------------------------------------------
  // Mega Floette ex "Gentle Light" — heal N from each Pokémon on both sides.
  | { kind: "healEachInPlayBothSides"; amount: number }
  // Delphox "Energized Storm" / Xerneas "Geostorm" — N damage per Energy
  // attached to all Pokémon (or all of your Pokémon).
  | { kind: "perEnergyAcrossInPlay"; perCount: number; energyType?: EnergyType; side: "friendly" | "both" }
  // Mega Greninja ex "Ninja Spinner" — return one typed Energy to hand for
  // a damage bonus.
  | { kind: "optionalSelfTypedEnergyToHandForBonus"; energyType: EnergyType; bonus: number }
  // Metagross "Metallic Hammer" — discard N typed Energy from self for a
  // damage bonus.
  | { kind: "optionalDiscardSelfEnergyForBonus"; count: number; energyType?: EnergyType; bonus: number }
  // Trevenant "Cursed Root" — defender can't have Energy attached from opp's
  // hand during opp's next turn.
  | { kind: "defenderCantBeAttachedNextTurn" }
  // Gourgeist ex "Horror Rondo" — N more per friendly bench Pokémon that
  // has any damage counters on it.
  | { kind: "perDamagedFriendlyBench"; perCount: number }
  // Mega Dragalge ex "Corrosive Liquid" — discard ALL Tools and ALL Special
  // Energy from EVERY one of opp's Pokémon (Active + Bench).
  | { kind: "discardAllOppToolsAndSpecialEnergyAll" }
  // Mega Dragalge ex "Pernicious Poison" — Poison + heavy poison strength
  // (N damage counters per Checkup instead of 1).
  | { kind: "applyHeavyPoison"; counters: number }
  // Golisopod "Vital Slash" — set self shield next turn iff this attack
  // KO'd the defender.
  | { kind: "shieldNextTurnIfKoThisAttack" }
  // Golbat "Covert Flight" — shield next turn against attackers with a
  // specific subtype only.
  | { kind: "selfShieldNextTurnFromSubtype"; subtype: string }
  // Deoxys "Psy Protect" — shield next turn against attackers that have
  // any Abilities.
  | { kind: "selfShieldNextTurnFromAbility" }
  // Watchog "Snipe Check" — flip N coins; for each heads, peek opp hand
  // and pick a card to put on top of opp deck. Auto-resolved as a hand
  // disruption (cards land on top, then opp shuffles).
  | { kind: "multiCoinPickFromOppHandToTopDeck"; coins: number }
  // Tauros "Target Together" — flip 1 coin per friendly Pokémon whose
  // name includes <namePart>; deal `damagePerHeads` damage to a chosen
  // opp target per heads.
  | { kind: "perNamedAllyCoinDamageChosen"; namePart: string; damagePerHeads: number }
  // Deoxys "Psy Spear" — also-snipe-bench gated by self extra energy.
  | { kind: "conditionalSnipeBench"; extraEnergy: number; damage: number };

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
  | { kind: "defenderHasSubtype"; subtype: "Basic" | "Stage 1" | "Stage 2" | "Evolution" | "Tera" | "Future" | "Ancient" | "Mega" }
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
  | { kind: "supporterPlayedThisTurnNamed"; namePart: string }
  // "If you have at least N <Type> Energy in play, ..."
  | { kind: "youHaveEnergyOfTypeAtLeast"; energyType: EnergyType; count: number }
  // "If this Pokémon was healed during this turn, ..." (Vileplume Lively Flower)
  | { kind: "selfHealedThisTurn" }
  // "If this Pokémon was damaged by an attack during your opponent's last
  // turn, ..." (Mega Heracross ex Juggernaut Horn)
  | { kind: "selfDamagedLastOppTurn" }
  // "If this Pokémon used <Name> during your last turn, ..." (Togedemaru ex)
  | { kind: "selfUsedAttackLastTurn"; attackName: string }
  // "If your opponent's Active Pokémon isn't <Status>, this attack does
  // nothing." (Camerupt Roasting Burn)
  | { kind: "defenderHasNoStatus"; status: StatusCondition }
  // "If your opponent has exactly N or M Prize cards remaining, ..."
  // (Hop's Cramorant Fickle Spitting — 3 or 4)
  | { kind: "oppPrizesInRange"; min: number; max: number }
  // "If <named> is in your discard pile, ..." (Serperior Solar Coiling)
  | { kind: "yourDiscardHasCardNamed"; namePart: string }
  // "If any of your Benched <named> have any damage counters on them, ..."
  // (Pangoro Master's Punch)
  | { kind: "benchPokemonNamedHasDamage"; namePart: string }
  // "If your Benched Pokémon have any damage counters on them, ..."
  // (Hawlucha Vengeful Kick)
  | { kind: "anyBenchHasDamage" }
  // "If any of your <named> Pokémon were Knocked Out by damage from an
  // attack during your opponent's last turn, ..." (Hop's Trevenant)
  | { kind: "yourNamedPokemonKoedLastOppTurn"; namePart: string }
  // "If you played a <named> Supporter card during this turn, ..." (Team
  // Rocket's Kangaskhan ex)
  | { kind: "supporterPlayedThisTurnNameContains"; namePart: string }
  // "If the Retreat Cost of your opponent's Active Pokémon is N or more, ..."
  // (Talonflame Aero Chase) — measured in Colorless count.
  | { kind: "defenderRetreatCostAtLeast"; count: number }
  // "If there are N or fewer cards in your deck, ..." (Rabsca Counterturn)
  | { kind: "yourDeckSizeAtMost"; count: number }
  // Opp hand size predicates.
  | { kind: "oppHandSizeAtMost"; count: number }
  // "If you have any Stage 2 <Type> Pokémon on your Bench, ..." (Sableye)
  | { kind: "youHaveBenchPokemonOfTypeAndSubtype"; energyType: EnergyType; subtype: string }
  // "If your opponent has any <Type> Pokémon in play, ..." (Electivire, Slither Wing variants)
  | { kind: "oppHasPokemonOfType"; energyType: EnergyType }
  // "If your opponent has any <Subtype> Pokémon in play, ..." (Future / Ancient / Tera)
  | { kind: "oppHasPokemonOfSubtype"; subtype: string }
  // "If you have any Tera Pokémon on your Bench, ..." (Ho-Oh)
  | { kind: "youHaveBenchPokemonOfSubtype"; subtype: string }
  // "If this Pokémon has more Energy attached than your opponent's Active
  // Pokémon, ..." (Swalot)
  | { kind: "selfHasMoreEnergyThanDefender" }
  // "If any of your Pokémon in play are the same type as any of your
  // opponent's Pokémon in play, ..." (Enamorus)
  | { kind: "typeMatchesAnyOppPokemon" }
  // "If <Name1> and <Name2> are on your Bench, ..." (Metagross — Beldum + Metang)
  | { kind: "hasBothNamedOnBench"; nameA: string; nameB: string }
  // "If your opponent has N or more Benched Pokémon, ..." (Iron Crown)
  | { kind: "oppBenchAtLeast"; count: number }
  // "If 1 of your other <Subtype> Pokémon used an attack during your last
  // turn, ..." (Koraidon — gates on the team's last-turn activity)
  | { kind: "anyAllyOfSubtypeUsedAttackLastTurn"; subtype: string }
  // "If you played <NamedItem> from your hand during this turn, ..." (Espurr
  // me4 Buddy Attack — references Tomes of Transformation by name.)
  | { kind: "playedNamedItemThisTurn"; namePart: string };
