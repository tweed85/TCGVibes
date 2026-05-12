// Interactive pending state: deck-search picks, in-play target clicks,
// hand-reveal prompts, choice menus, search-notice modals, evolution
// chain steps. Discriminated unions keep AI lane routing stable.

import type { Card, EnergyCard, EnergyType, StatusCondition } from "./cards";
import type { PlayerId } from "./core";

// What to do with cards the player didn't pick when a pending pick resolves.
export type PendingPickFallback =
  | "shuffleIntoDeck" // search / top-peek effects
  | "bottomOfDeck" // a few peek effects
  | "topOfDeck" // peek-and-discard: kept cards go back on top in pool order
  | "discard" // Explorer's Guidance: unpicked top cards are discarded
  | "returnToDiscard"; // discard-recovery effects

// Stable AI-routing discriminant for pending deck/discard picks. Lets the AI
// auto-resolver dispatch on `pendingPick.effectKind` instead of parsing
// `label` text — labels are display-only and may shift without notice. Only
// effects whose AI lane needs card-specific scoring need a kind here; generic
// search picks fall through to `resolveAiPendingPickSmart`.
export type PendingPickEffectKind =
  | "preciousTrolley"
  | "energySearchPro"
  | "academyAtNight"
  | "prismTower"
  | "mysteryGarden"
  | "levincia"
  | "grandTreeStage1" // pick the Stage 1 to evolve onto the captured Basic
  | "grandTreeStage2" // optional Stage 2 search (skippable)
  | "glassTrumpetEnergyPick" // step 1: pick basic Energy from discard
  | "reconDirective" // Drakloak — top-2 peek, pick 1 to hand, other to bottom
  | "peekTopMayDiscard"; // Morpeko — top-1 peek, optional discard

// Reveal-opponent's-hand prompt. The initiator (`player`) picks which cards
// from the target's hand (`target`) to act on (discard / move to bottom).
// Filter restricts which hand cards are eligible.
// Pick-one-option menu prompt. The chosen option's `id` flows to the
// resolver, which dispatches by `effectKind` to apply the matching
// engine effect.
export type PendingChoiceMenuEffectKind =
  | "selectiveSlimeStatus" // Cradily / Grafaiai — pick Burned / Confused / Poisoned to apply to opp Active
  ;

export interface PendingChoiceMenu {
  player: PlayerId;
  label: string;
  options: { id: string; label: string }[];
  effectKind: PendingChoiceMenuEffectKind;
}

export interface PendingHandReveal {
  player: PlayerId;
  target: PlayerId;
  label: string;
  min: number;
  max: number;
  filter: "item" | "tool" | "itemOrTool" | "supporter" | "pokemon" | "basicPokemon" | "energy" | "any";
  // Optional max-HP cap; only consulted when filter selects Pokémon variants.
  // Used by Mandibuzz Look for Prey (Basic Pokémon with HP ≤ 70).
  hpMax?: number;
  action: "discard" | "toBottomOfDeck" | "toTopOfDeck" | "swapWithDeckTop" | "toOppBench";
  // Stable AI-routing identity. Phase 2.1 — replaced legacy reuse of
  // `PendingPickEffectKind` with a dedicated `PendingHandRevealEffectKind`
  // union (see aiPolicies.ts). Existing call sites for `academyAtNight`,
  // `prismTower`, and `mysteryGarden` migrated.
  effectKind?: import("../aiPolicies").PendingHandRevealEffectKind;
  // Optional follow-up run by the resolver after the pick completes.
  // `useRevealedCount` (Perrin): when set, the post-search caps at the
  // number of cards the player actually revealed instead of the fixed max
  // (Perrin: "search for the SAME number of Pokémon").
  postAction?:
    | { kind: "drawUntilHand"; targetSize: number } // Naveen / Mystery Garden
    | { kind: "drawCards"; count: number } // Kofu / Prism Tower
    | { kind: "searchDeckAnyPokemon"; max: number; label: string; useRevealedCount?: boolean }
    | { kind: "secretBoxStartItemSearch" }; // Secret Box: kicks off Item → Tool → Supporter → Stadium chain
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
    | { kind: "typedEnergySwitchSource"; energyType: EnergyType; asOften?: boolean } // Dewgong Wash Out, Azumarill ex Bubble Gathering
    | { kind: "typedEnergySwitchDest"; sourceInstanceId: string; energyType: EnergyType; asOften?: boolean }
    | { kind: "abilityHealAny"; amount: number } // Generic ability "heal N from 1 of your Pokémon"
    | { kind: "abilityPlaceCountersOnOpp"; counters: number; abilityName: string } // Mega Greninja ex Mortal Shuriken et al.
    | { kind: "abilitySwitchBenchedTypeWithStatus"; energyType: EnergyType; status: StatusCondition; excludeSameName: boolean; holderName: string; abilityName: string }
    | { kind: "abilitySwapWithBenchForceOppPromote"; abilityName: string }
    | { kind: "abilityDevolveOppEvolution"; abilityName: string }
    // Magneton Overvolt Discharge — re-arming. Each click picks one Basic
    // Energy from discard and attaches to the clicked typed ally; remaining
    // decrements; on close, the holder self-KOs.
    | { kind: "abilityAttachAnyBasicFromDiscardToTyped"; remaining: number; typeFilter: import("./cards").EnergyType; holderInstanceId: string; abilityName: string }
    // Infernape Pyro Dance — re-arming. Each click attaches the first eligible
    // typed Basic Energy from hand (typeA or typeB) to the clicked ally.
    | { kind: "abilityAttachMixedFromHand"; remaining: number; typeA: import("./cards").EnergyType; typeB: import("./cards").EnergyType; abilityName: string }
    // Energy Blender / Iron Shake-Up — re-arming move source picker. Cancel
    // to stop. `energyType` undefined = any energy (Delcatty Energy Blender).
    | { kind: "attackMoveAnyEnergySource"; energyType: import("./cards").EnergyType | null; attackName: string }
    | { kind: "attackMoveAnyEnergyDest"; sourceInstanceId: string; energyType: import("./cards").EnergyType | null; attackName: string }
    // Top-N peek + multi-attach distribution. After resolving the peek-pick,
    // the chosen energies are queued and the user clicks an ally per energy.
    | { kind: "abilityAttachQueuedEnergyToAlly"; queue: import("./cards").EnergyCard[]; abilityName: string }
    // Attach all Basic Energy from hand to your Pokémon "in any way".
    | { kind: "attackAttachBasicFromHandToAlly"; remaining: number; attackName: string }
    // Phase 7 — pre-attack discard-for-damage picker. Opens BEFORE the
    // attack runs. Each click discards one matching Energy from the
    // clicked ally; increment `discarded`. Cancel / max → resume the
    // attack via `resumeDamageScalingAttack` with the count in
    // `state.preComputedDiscardForDamage`.
    | { kind: "attackDiscardForDamagePicker"; discarded: number; max: number; energyType: EnergyType | null; attackerOwner: PlayerId; attackIndex: number; attackName: string }
    | { kind: "jacintheHeal" } // Jacinthe — heal 150 from a damaged Psychic
    | { kind: "pokeVitalAHeal" } // Poké Vital A — heal 150 from any damaged ally
    | { kind: "potionHeal" } // Potion — heal 30 from any 1 of your Pokémon
    | { kind: "superPotionHeal" } // Super Potion — heal 60 + discard 1 Energy
    | { kind: "wondrousPatchAttach" } // Wondrous Patch — attach Psychic from discard to a Benched Psychic
    // Ability: move N damage counters from `sourceInstanceId` (already
    // chosen — the most-damaged ally) to whichever opp Pokémon the player
    // clicks. Resolves any KO triggered by the placement. (Munkidori
    // Adrena-Brain.)
    | { kind: "abilityMoveDamage"; counters: number; sourceInstanceId: string; abilityName: string }
    // Ability: place N counters on the clicked opp Pokémon, then KO the
    // ability holder. (Dusknoir Cursed Blast.)
    | { kind: "abilityCursedBlast"; counters: number; holderInstanceId: string; ownerId: PlayerId; abilityName: string }
    // Ability: attach the stashed basic Energy from discard to the clicked
    // own Pokémon. (Blaziken ex Seething Spirit.)
    | { kind: "abilityAttachEnergyFromDiscard"; energyIndexInDiscard: number; ownerId: PlayerId; abilityName: string }
    // Crispin — after choosing the attach Energy from deck, click one of
    // your Pokémon to receive it.
    | { kind: "crispinAttachEnergy"; energy: EnergyCard }
    // Shaymin "Send Flowers" — first-step picker. Player clicks a Benched
    // Pokémon of `pokemonType`; resolver chains into a deck-search-pick that
    // attaches the chosen Energy to the clicked instance via `attachToInstanceId`.
    | { kind: "sendFlowersAttach"; attackName: string; pokemonType: string }
    // Distributed-damage attack picker (Oil Salvo / Phantom Dive). Each
    // click hits the chosen opp Pokémon for `perHit` damage; `remaining`
    // decrements. When remaining reaches 0, the picker closes. `benchOnly`
    // restricts targets to the opp's Bench (Phantom Dive).
    | { kind: "distributeDamage"; remaining: number; perHit: number; ignoreWR: boolean; benchOnly?: boolean; attackName: string; finishTurn?: boolean }
    // Multi-pick energy attach to your own Bench (Aura Jab et al.). Each
    // click pulls one matching basic Energy out of discard and attaches
    // to the clicked Bench Pokémon. `remaining` decrements; when 0 OR
    // discard runs dry, the picker closes.
    | { kind: "attachEnergyFromDiscardPicker"; remaining: number; energyType: EnergyType; attackName: string; finishTurn?: boolean }
    // Heavy Baton: the energies were stashed mid-KO; the player picks one of
    // their Bench Pokémon to receive them all at once.
    | { kind: "heavyBatonPick" }
    // Prime Catcher step 1: pick the opp Benched Pokémon to gust to Active.
    | { kind: "primeCatcherGust" }
    // Prime Catcher step 2 (optional): pick own Benched Pokémon to swap with
    // own Active. Skipped via `skipPrimeCatcherSelfSwitch`.
    | { kind: "primeCatcherSelfSwitch" }
    // Surfing Beach: pick which Water-typed Benched Pokémon to switch into
    // the Active spot.
    | { kind: "surfingBeachSwitch" }
    // Grand Tree step 1: pick the Basic in play to evolve. The chain
    // captures the chosen instance ID and then opens a deck search for
    // matching Stage 1 / Stage 2 cards.
    | { kind: "grandTreeBasicTarget" }
    // Glass Trumpet step 2 (after the discard-recovery picker stashed
    // basic Energy in `pendingAttachQueue`): each click on a Benched
    // Colorless Pokémon attaches one queued Energy. `remaining` decrements;
    // when 0 OR queue is empty, the picker closes. `pickedInstanceIds`
    // tracks already-attached targets — the card text says "attach a Basic
    // Energy ... to each of them," so a single target cannot receive
    // multiple Energy in one resolution. Player may skip remaining picks
    // via `skipGlassTrumpetAttach`; queued Energy then returns to discard.
    | { kind: "glassTrumpetAttach"; remaining: number; pickedInstanceIds: string[] }
    // Scramble Switch step 1: pick the Bench Pokémon to switch into the
    // Active spot. Step 2 (energy transfer) is currently always-move-all
    // — see APPROXIMATION comment in trainerEffects.ts.
    | { kind: "scrambleSwitchTarget" }
    // Handheld Fan: defender picks one of the attacker's Bench Pokémon to
    // receive an Energy moved off the attacker's Active. This runs on the
    // defender's side during the attacker's turn — `player` on the
    // pending prompt is the defender; `targetOwner` is the attacker.
    | { kind: "handheldFanPick" };
}

export interface PendingPick {
  player: PlayerId;
  // Human-readable description of what to pick.
  label: string;
  // Cards the player is choosing from (pulled out of their source zone).
  pool: Card[];
  min: number; // minimum picks required (0 for "max" effects)
  max: number; // maximum picks allowed
  // If set, only these pool indexes are pickable (rest are shown but disabled).
  eligibleIndexes?: number[];
  // For deck searches: snapshot of the cards in the deck that did NOT match
  // the predicate, so the UI's "All" tab can show the entire deck even though
  // only `pool` cards are pickable. These cards remain in `pl.deck` while the
  // picker is open — this field is just a stable copy for rendering.
  nonEligiblePool?: Card[];
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
  // Where picked cards go. Default "hand". "discard" routes picks straight to
  // the discard pile (Raifort). "topOfDeck" routes search picks to the top
  // after shuffling the unpicked cards back (Ciphermaniac's Codebreaking).
  pickedDestination?: "hand" | "discard" | "topOfDeck";
  // If true, picked Pokémon are applied as an evolution onto a matching ally
  // (Salvatore: search for an Evolution, put it onto the Pokémon it evolves
  // from). Falls back to depositing in hand if no eligible ally is found.
  toEvolve?: boolean;
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
  // If true, the picker enforces "different basic Energy types" — the
  // resolver rejects a selection whose picked basic-Energy cards include
  // any duplicate `provides` type. UI may grey out same-type tiles after
  // the first selection, but the resolver is the correctness layer.
  // (Energy Search Pro.)
  uniqueByEnergyType?: boolean;
  // Stable identity for AI lane routing. When set, the AI auto-resolver
  // dispatches to a card-specific scorer instead of falling through to the
  // generic greedy ranker. Never parsed from `label`.
  effectKind?: PendingPickEffectKind;
  // Effect-specific continuation that needs the cards selected by this pick.
  afterPick?:
    | { kind: "crispinHandEnergy" }
    | { kind: "crispinAttachEnergy" }
    // Grand Tree step 2: apply the picked Stage 1 (in hand) onto the
    // captured Basic instance, run applyEvolveSideEffects, then open the
    // optional Stage 2 search keyed off the same instance.
    | { kind: "grandTreeApplyStage1"; targetInstanceId: string }
    // Grand Tree step 3: apply the optional picked Stage 2 onto the
    // already-evolved Stage 1 instance.
    | { kind: "grandTreeApplyStage2"; targetInstanceId: string }
    // Glass Trumpet step 2: pull the selected basic Energy out of the
    // discard-recovery hand-deposit, stash them on `pendingAttachQueue`,
    // and open the per-Colorless-Bench attach picker.
    | { kind: "glassTrumpetStash" }
    // Powerglass: pull the picked basic Energy out of hand, attach it to
    // the Active, and resume endTurn via `finishEndTurn`.
    | { kind: "powerglassAttach" }
    // Amulet of Hope: after the post-promote picker resolves, run the
    // deferred onPromoteResolved continuation (typically endTurn from the
    // attacker's attack flow).
    | { kind: "amuletOfHopeResume" };
}

// Next step in a chained deck search — keyed by a symbolic id so the
// resolver knows which predicate + label to use for the next pick.
export type DeckSearchChainStep =
  | { kind: "dawn-stage1" } // Dawn: after picking the Basic, pick a Stage 1
  | { kind: "dawn-stage2" } // Dawn: after picking the Stage 1, pick a Stage 2
  | { kind: "hilda-energy" } // Hilda: after the Evolution, pick a basic Energy
  | { kind: "colress-energy" } // Colress's Tenacity: after Stadium, pick basic Energy
  | { kind: "secret-box-tool" } // Secret Box step 2 of 4
  | { kind: "secret-box-supporter" } // Secret Box step 3 of 4
  | { kind: "secret-box-stadium" } // Secret Box step 4 of 4
  | { kind: "larry-skill-supporter" } // Larry's Skill: after the Pokémon, pick a Supporter
  | { kind: "larry-skill-energy" } // Larry's Skill: after the Supporter, pick a Basic Energy
  // Grand Tree: after the Basic was chosen + Stage 1 search opened, this
  // step optionally opens the Stage 2 search keyed off the just-evolved
  // instance. `targetInstanceId` is the captured ally so the chain
  // evolves the user's chosen Basic, not the first matching ally.
  | { kind: "grand-tree-stage2"; targetInstanceId: string };

// Short "hey, heads up" modal shown between chained deck searches when the
// current stage has no qualifying cards. Lets the player acknowledge the
// miss before the next stage's pick opens, so skipped stages aren't silent.
export interface PendingSearchNotice {
  player: PlayerId;
  message: string;
  // Optional follow-up: when the user clicks Continue, this chain step fires.
  nextChain: DeckSearchChainStep | null;
}
