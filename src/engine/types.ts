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
  effects?: AttackEffect[]; // resolved at attack time (coin flips, statuses, etc.)
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
  | { kind: "perPrizeOppTaken"; perCount: number } // "... for each Prize card your opponent has taken."
  | { kind: "benchSnipe"; damage: number; target: "opponentBench" | "allBench" | "allOpponents" }
  | { kind: "selfDamage"; damage: number } // "This Pokémon also does N damage to itself."
  | { kind: "applyStatus"; status: StatusCondition; target: "defender" | "self" }
  | { kind: "heal"; amount: number; target: "self" | "active" }
  | { kind: "discardOwnEnergy"; count: number } // "Discard N Energy from this Pokémon."
  | { kind: "drawCards"; count: number }
  | { kind: "blockOppItemsNextTurn" } // Budew Itchy Pollen — opp can't play Items next turn.
  | { kind: "flipMultiCoinsPerHeads"; coins: number; perHeads: number } // "Flip N coins. N damage per heads."
  | { kind: "selfCantAttackNextTurn" } // During your next turn, this Pokémon can't attack.
  | { kind: "defenderCantRetreatNextTurn" } // During opp's next turn, Defending can't retreat.
  | { kind: "selfDamageReductionNextTurn"; amount: number } // "takes N less damage next turn"
  | { kind: "snipeOne"; damage: number } // "This attack also does N damage to 1 of opp's Benched"
  | { kind: "switchOutOpponent" } // Opp promotes new Active from bench
  | { kind: "selfSwitch" } // Switch attacker with a benched Pokémon
  | { kind: "discardOppEnergy"; count: number } // Discard N Energy from opp's Active
  | { kind: "flipHeadsDiscardOppEnergy" } // Flip — heads: discard one Energy from opp's Active
  | { kind: "healEachOwnPokemon"; amount: number } // Heal N from each of your Pokémon
  | { kind: "discardTopOfOppDeck"; count: number } // Mill the opp deck by N
  | { kind: "discardOppTools" } // "Before doing damage, discard all Tools from opp's Active"
  | { kind: "callForFamily"; max: number } // "Search your deck for up to N Basic Pokémon and put them onto your Bench."
  | { kind: "flipUntilTailsPerHeads"; perHeads: number } // Geometric damage ("Flip until you get tails")
  | { kind: "placeCountersPerHandCard"; countersPerCard: number } // Alakazam "Powerful Hand"
  | { kind: "fizzleIfNoStadium" } // Fan Rotom "Assault Landing"
  | { kind: "shieldNextTurn"; requiresHeads: boolean } // Dunsparce "Dig" — prevent damage+effects next turn
  | { kind: "searchEnergyAttachBenchType"; pokemonType: EnergyType } // Shaymin DRI "Send Flowers"
  | { kind: "attachNFromDiscardToBench"; energyType: EnergyType; max: number } // Mega Lucario ex "Aura Jab"
  | { kind: "selfCantUseAttackNextTurn"; attackName: string } // Riolu / Mega Brave — only THIS attack is locked
  | { kind: "multiCoinPerOppPokemon"; damagePerHeads: number } // Mega Zygarde ex "Nullifying Zero"
  | { kind: "fizzleIfNoAlly"; allyName: string } // Solrock Cosmic Beam
  | { kind: "ignoreWeaknessResistance" } // Cosmic Beam
  | { kind: "returnSelfToHand" }; // Meowth ex Tuck Tail

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
  | { kind: "attackBonusThisTurnSelfDamage"; selfDamage: number; bonusPerAttack: number; oncePerTurn: true }; // Feraligatr Torrential Heart

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
  rarity?: string;
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
  // Optional gates — all must match for the bonus to apply.
  againstEx?: boolean; // only vs opponent's Active Pokémon ex
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
    | { kind: "energySwitchDest"; sourceInstanceId: string }; // second step: user picks destination
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
