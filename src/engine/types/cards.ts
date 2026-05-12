// Card schema + cross-cutting primitives. Mirrors the Pokémon TCG API so
// data from the pokemon-tournament-cards subagent drops in with minimal
// adaptation. Type-only cycle with ./effects is fine — TypeScript handles
// it cleanly because no runtime values cross the boundary.

import type { AttackEffect, AttackPredicate } from "./effects";

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

export type StatusCondition =
  | "asleep"
  | "burned"
  | "confused"
  | "paralyzed"
  | "poisoned";

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
  | { kind: "attachEnergyFromHand"; energyType: EnergyType; oncePerTurn: boolean }
  | { kind: "attachEnergyFromHandThenDraw"; energyType: EnergyType; drawCount: number; oncePerTurn: true } // Teal Dance
  | { kind: "attachEnergyFromDiscardToSelf"; oncePerTurn: true } // any Basic Energy from discard → self
  | { kind: "attachEnergyFromDiscardToBench"; energyType: EnergyType; oncePerTurn: true } // Dynamotor
  | { kind: "attachEnergyFromHandToBenchNameN"; energyType: EnergyType; max: number; namePrefix: string; oncePerTurn: true } // Golden Flame: up to 2 Fire to Bench Ethan's
  | { kind: "moveOwnBasicEnergyBetween"; oncePerTurn: boolean } // Happy Switch (true), Bubble Gathering / Wash Out (false: as often as you like)
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
  | { kind: "attachEnergyFromHandToNamedAsOften"; energyType: EnergyType; namePrefix: string }
  // me4 (Chaos Rising) -------------------------------------------------------
  // Delphox "Flaring Magic" — discard a basic <type> Energy from HAND, then
  // draw cards until you have N cards in your hand.
  | { kind: "discardHandEnergyDrawToN"; energyType: EnergyType; targetHand: number; oncePerTurn: true; activeOnly?: boolean }
  // Mega Greninja ex "Mortal Shuriken" — Active-only; discard a basic
  // <type> Energy from HAND, place N damage counters on 1 opp Pokémon.
  | { kind: "discardHandEnergyPlaceCountersOnOpp"; energyType: EnergyType; counters: number; oncePerTurn: true; activeOnly: true }
  // Crobat "Nighttime Maneuvers" — Active-only; search deck for any card,
  // shuffle deck, put that card on top.
  | { kind: "searchDeckAnyCardToTopdeck"; oncePerTurn: true; activeOnly: true };

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

// Re-export AttackPredicate so call sites importing both Attack and
// AttackPredicate from "./cards" don't need a second import. Tests and the
// engine still import predicate from "./effects" directly.
export type { AttackPredicate };
