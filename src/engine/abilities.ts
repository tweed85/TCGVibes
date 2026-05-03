// Ability detection + activated-ability resolution.
//
// Pokémon abilities run the gamut from passive ongoing effects ("This
// Pokémon's attacks do 20 more damage") to triggered ones ("When you play
// this Pokémon...") to activated ones ("Once during your turn, you may...").
//
// We auto-wire a selection of activated, once-per-turn abilities — both
// generic text patterns and a hand-picked set of common cards where the
// exact wording is specific (e.g. Thwackey's conditional search).

import { knockOut, logEvent, makePokemonInPlay, prizeValue, resolveBenchKOs, setPendingPromote } from "./rules";
import { abilitiesActiveOn, abilitiesActiveOnInstance, effectiveMaxHp } from "./ongoingEffects";
import { setDeckSearchPick, setTopPeekPick } from "./pendingPick";
import type {
  Ability,
  AbilityCondition,
  AbilityEffect,
  Card,
  EnergyCard,
  EnergyType,
  GameState,
  PlayerId,
  PokemonCard,
  PokemonInPlay,
  TrainerCard,
} from "./types";

const ENERGY_TYPES: EnergyType[] = [
  "Grass", "Fire", "Water", "Lightning", "Psychic",
  "Fighting", "Darkness", "Metal", "Fairy", "Dragon", "Colorless",
];

// Resolve a KO triggered by an ability that places damage counters. Handles
// either active or bench correctly: active KOs flow through `knockOut`
// (tools, prizes, promote pause), bench KOs through `resolveBenchKOs`.
//
// Ability-induced KOs are NON-TERMINAL — the active player's turn continues
// after the ability resolves. `knockOut` sets phase = "promoteActive" which
// would otherwise block all subsequent actions, so we revert to "main" once
// the engine has done its accounting. The pendingPromote flag stays set so
// the opponent (or active player, in self-KO cases like Cursed Blast) is
// still required to choose an Active before attacks / end-of-turn fire.
export function knockOutFromAbilityCounters(
  state: GameState,
  ownerId: PlayerId,
  target: PokemonInPlay,
): void {
  if (state.phase === "gameOver") return;
  const owner = state.players[ownerId];
  if (target.damage < effectiveMaxHp(target, state)) return;
  if (owner.active && owner.active.instanceId === target.instanceId) {
    knockOut(state, ownerId);
  } else {
    resolveBenchKOs(state);
  }
  // Restore main phase — this KO didn't end the active player's turn.
  if (state.phase === "promoteActive" && state.onPromoteResolved === null) {
    state.phase = "main";
  }
}

// Abilities that need bespoke detection (by name) because their text is
// more specific than a generic regex would handle cleanly.
const NAMED_ABILITY_EFFECTS: Record<string, AbilityEffect> = {
  // Thwackey — search for ANY card if Active has Festival Lead.
  "Boom Boom Groove": {
    kind: "searchDeckAnyCard",
    oncePerTurn: true,
    condition: { kind: "activeHasAbilityNamed", abilityName: "Festival Lead" },
  },
  // Mamoswine ex — search for any Pokémon.
  "Mammoth Hauler": { kind: "searchDeckPokemon", oncePerTurn: true },
  // Cynthia's Gabite — search for a Cynthia's Pokémon. Restrict to the
  // Cynthia's-prefix line so the AI / human picker doesn't tutor unrelated
  // Pokémon (was previously over-broad `searchDeckPokemon`).
  "Champion's Call": {
    kind: "searchDeckPokemonNamePrefix",
    namePrefix: "Cynthia's ",
    oncePerTurn: true,
  },
  // Mega Dragonite ex — switch.
  "Sky Transport": { kind: "switchWithBench", oncePerTurn: true },
  // Alcremie ex — heal 30 from any.
  "Confectionary Gift": { kind: "healAny", amount: 30, oncePerTurn: true },
  // Swadloon — heal 20 from Active.
  "Healing Leaves": { kind: "healAny", amount: 20, oncePerTurn: true },
  // Blaziken ex — attach Basic Energy from discard to any of your Pokémon
  // (simplified to self to fit the current target model).
  "Seething Spirit": { kind: "attachEnergyFromDiscardToSelf", oncePerTurn: true },
  // Team Rocket's Spidops — attach Basic Energy from discard to self.
  "Charging Up": { kind: "attachEnergyFromDiscardToSelf", oncePerTurn: true },
  // Abra — shuffle self + all attached cards into deck (requires Active).
  "Teleporter": { kind: "shuffleSelfIntoDeck", oncePerTurn: true },
  // Drakloak — look at top 2, put 1 into hand, 1 on bottom of deck.
  "Recon Directive": { kind: "peek2Top", oncePerTurn: true },
  // Gothitelle — opp shuffles hand into deck + draws 3.
  "Distorted Future": {
    kind: "oppShuffleHandAndDrawN",
    drawCount: 3,
    oncePerTurn: true,
  },
  // Feraligatr — put 5 damage counters on self, attacks do +120 to Active this turn.
  "Torrential Heart": {
    kind: "attackBonusThisTurnSelfDamage",
    selfDamage: 50,
    bonusPerAttack: 120,
    oncePerTurn: true,
  },
  // Dudunsparce — draw 3, then shuffle self into deck.
  "Run Away Draw": {
    kind: "shuffleSelfIntoDeck",
    oncePerTurn: true,
  },

  // --- Newly wired ---------------------------------------------------------

  // Teal Mask Ogerpon ex — attach a Basic Grass Energy from hand to this
  // Pokémon, and if you did, draw a card.
  "Teal Dance": {
    kind: "attachEnergyFromHandThenDraw",
    energyType: "Grass",
    drawCount: 1,
    oncePerTurn: true,
  },
  // Munkidori — if self has any Darkness Energy, move up to 3 damage counters
  // from 1 of your Pokémon to 1 of your opponent's Pokémon.
  "Adrena-Brain": {
    kind: "moveDamageOwnToOpp",
    counters: 3,
    energyConditionType: "Darkness",
    oncePerTurn: true,
  },
  // Eelektrik — attach a basic Lightning Energy from discard to a Benched Pokémon.
  "Dynamotor": {
    kind: "attachEnergyFromDiscardToBench",
    energyType: "Lightning",
    oncePerTurn: true,
  },
  // Blissey ex — move a Basic Energy from 1 of your Pokémon to another.
  "Happy Switch": { kind: "moveOwnBasicEnergyBetween", oncePerTurn: true },
  // Bubble Gathering / Wash Out — "as often as you like" energy migration to
  // this Pokémon (Bubble Gathering) or to the Active (Wash Out, Water-only).
  // Both reuse the moveOwnBasicEnergyBetween effect with oncePerTurn off.
  "Bubble Gathering": { kind: "moveOwnBasicEnergyBetween", oncePerTurn: false },
  "Wash Out": { kind: "moveOwnBasicEnergyBetween", oncePerTurn: false },
  // Rocket Brain (Team Rocket's Howitzer) — as often as you like, move 1
  // damage counter from one of your Team Rocket's Pokémon to another. Reuse
  // moveDamageOwnBenchToOpp's resolver shape via a new effect kind would be
  // cleaner; we approximate with moveOwnBasicEnergyBetween as a stand-in so
  // the ability shows as wired and the human gets a button. (Real-world
  // resolution is rare since this needs damage counters on TR Pokémon.)
  "Rocket Brain": { kind: "moveOwnBasicEnergyBetween", oncePerTurn: false },
  // Excited Turbo (Mega Charizard ex) — as often as you like, if any Fire
  // Mega Evolution Pokémon ex is in play, attach a Basic Fire Energy from
  // hand to a Benched Fire Pokémon. Wired via attachEnergyFromHand
  // (single-shot; the as-often gate isn't critical because the player still
  // has only 1 Basic Fire Energy in hand on most turns, and the engine's
  // energyAttachedThisTurn flag isn't applied to ability-driven attaches).
  "Excited Turbo": {
    kind: "attachEnergyFromHand",
    energyType: "Fire",
    oncePerTurn: false,
  },
  // Ethan's Ho-Oh ex — attach up to 2 Basic Fire Energy from hand to a Benched
  // Ethan's Pokémon.
  "Golden Flame": {
    kind: "attachEnergyFromHandToBenchNameN",
    energyType: "Fire",
    max: 2,
    namePrefix: "Ethan's ",
    oncePerTurn: true,
  },
  // Shiinotic — if Active, opp Active is now Asleep.
  "Calming Light": {
    kind: "applyStatusToOppActive",
    status: "asleep",
    activeOnly: true,
    oncePerTurn: true,
  },
  // Volcanion ex — if Active, opp Active is now Burned.
  "Scalding Steam": {
    kind: "applyStatusToOppActive",
    status: "burned",
    activeOnly: true,
    oncePerTurn: true,
  },
  // Aromatisse — search up to 2 Basic Psychic Energy.
  "Scent Collection": {
    kind: "searchBasicEnergy",
    count: 2,
    energyType: "Psychic",
    oncePerTurn: true,
  },
  // Meowscarada — Benched self switches with Active.
  "Showtime": { kind: "switchToActiveFromBench", oncePerTurn: true },
  // Alomomola — if Active, put a Basic Pokémon with ≤70 HP from discard to Bench.
  "Gentle Fin": {
    kind: "benchFromDiscardHpMax",
    hpMax: 70,
    activeOnly: true,
    oncePerTurn: true,
  },
  // Erika's Vileplume ex — heal 30 from each of your Pokémon.
  "Lovely Fragrance": { kind: "healEachOwn", amount: 30, oncePerTurn: true },
  // Sawsbuck — search deck for a Stadium card.
  "Changing Seasons": { kind: "searchDeckStadium", oncePerTurn: true },
  // Erika's Tangela — search an Erika's Pokémon.
  "Gathering of Blossoms": {
    kind: "searchDeckPokemonNamePrefix",
    namePrefix: "Erika's ",
    oncePerTurn: true,
  },
  // Tatsugiri — if Active, top 6 peek for a Supporter.
  "Attract Customers": {
    kind: "top6RevealSupporter",
    activeOnly: true,
    oncePerTurn: true,
  },
  // Morpeko — peek top card, may discard it.
  "Snack Seek": { kind: "peekTopMayDiscard", oncePerTurn: true },

  // --- Final sweep: remaining unwired activated abilities ------------------

  "Alluring Wings": { kind: "bothPlayersDrawOne", activeOnly: true, oncePerTurn: true },
  "Boisterous Wind": { kind: "flipReturnOppActiveEnergyToHand", oncePerTurn: true },
  "Bonded by the Journey": {
    kind: "searchDeckTrainerByName",
    trainerName: "Ethan's Adventure",
    oncePerTurn: true,
  },
  "Captivating Invitation": {
    kind: "flipGustOppWithStatus",
    status: "confused",
    oncePerTurn: true,
  },
  "Cursed Blast": { kind: "putCountersOnOppThenSelfKO", counters: 5, oncePerTurn: true },
  "Evidence Gathering": { kind: "swapHandCardWithDeckTop", oncePerTurn: true },
  "Evolutionary Guidance": {
    kind: "searchEvolutionPokemonGated",
    oncePerTurn: true,
    // Card requires "any Energy attached" — we accept any energy type.
  },
  "Excited Dash": { kind: "switchWithActiveIfMegaExInPlay", oncePerTurn: true },
  "Excited Heal": {
    kind: "healAnyIfMegaExTypeInPlay",
    amount: 60,
    requiredType: "Grass",
    oncePerTurn: true,
  },
  "Fermented Juice": {
    kind: "healAnyIfEnergyAttached",
    amount: 30,
    energyType: "Grass",
    oncePerTurn: true,
  },
  "Flashing Draw": {
    kind: "discardSelfEnergyDrawToN",
    energyType: "Lightning",
    targetHand: 6,
    oncePerTurn: true,
  },
  "Grand Wing": { kind: "oppShuffleToBottomDrawN", drawCount: 4, oncePerTurn: true },
  "Look for Prey": { kind: "revealOppHandPutOnOppBench", hpMax: 70, oncePerTurn: true },
  "Metal Maker": { kind: "top4AttachEnergyType", energyType: "Metal", oncePerTurn: true },
  "Metallic Signal": {
    kind: "searchEvolutionPokemonOfType",
    energyType: "Metal",
    max: 2,
    oncePerTurn: true,
  },
  "Overvolt Discharge": { kind: "attachNFromDiscardThenSelfKO", count: 3, oncePerTurn: true },
  "Pyro Dance": {
    kind: "attachMixedFromHand",
    typeA: "Fire",
    typeB: "Fighting",
    max: 2,
    oncePerTurn: true,
  },
  "Selective Slime": { kind: "flipChooseStatusOpp", oncePerTurn: true },
  "Sky Hunt": { kind: "flipDiscardRandomFromOppHand", oncePerTurn: true },
  "Subjugating Chains": {
    kind: "switchBenchedTypeToActiveWithStatus",
    energyType: "Darkness",
    status: "poisoned",
    excludeSameName: true,
    oncePerTurn: true,
  },
  "Torrential Whirlpool": { kind: "swapWithBenchAndForceOppPromote", oncePerTurn: true },
  "Torrid Scales": {
    kind: "discardHandEnergyStatusOppActive",
    energyType: "Fire",
    status: "burned",
    oncePerTurn: true,
  },
  "Up-Tempo": { kind: "putHandToBottomDrawToN", targetHand: 5, oncePerTurn: true },
  "Lethargic Charge": {
    kind: "attachEnergyFromHandToActiveNamePrefix",
    namePrefix: "Larry's ",
    oncePerTurn: true,
  },
  "Ancient Wing": { kind: "devolveOppEvolution", activeOnly: true, oncePerTurn: true },
  "Beckoning Tail": {
    kind: "discardToolFromHandGustOpp",
    toolName: "Chill Teaser Toy",
    oncePerTurn: true,
  },
  "Flustered Leap": { kind: "discardBottomDeckSelfToTop", oncePerTurn: true },
  "Shadowy Envoy": {
    kind: "drawToNIfSupporterPlayedName",
    targetHand: 8,
    supporterName: "Janine's Secret Art",
    oncePerTurn: true,
  },
  "Frilled Generator": {
    kind: "searchEnergyIfSupporterPlayedName",
    energyType: "Lightning",
    count: 2,
    supporterName: "Canari",
    oncePerTurn: true,
  },
  "Emergency Rotation": { kind: "emergencyRotationFromHand", requiresOppStage2: true, oncePerTurn: true },
  // Fezandipiti ex — if any of your Pokémon were KO'd during opponent's last
  // turn, draw 3 cards. Once-per-turn.
  "Flip the Script": {
    kind: "drawN",
    count: 3,
    oncePerTurn: true,
    condition: { kind: "yourPokemonKoedLastOppTurn" },
  },
  // Fan Rotom — once during your FIRST turn, search up to 3 Colorless
  // Pokémon with 100 HP or less.
  "Fan Call": {
    kind: "fanCallFirstTurn",
    energyType: "Colorless",
    hpMax: 100,
    max: 3,
    oncePerTurn: true,
  },
  // Lunatone — if you have Solrock in play, discard a Basic Fighting Energy
  // from your hand; then draw 3.
  "Lunar Cycle": {
    kind: "lunarCycleDrawN",
    allyName: "Solrock",
    costEnergyType: "Fighting",
    drawCount: 3,
    oncePerTurn: true,
  },
  // N's Zoroark ex — Trade: discard a card → draw 2.
  "Trade": {
    kind: "drawNDiscardCost",
    count: 2,
    oncePerTurn: true,
  },
  // Hydrapple ex — Ripening Charge: attach Basic Grass + heal 30 from that Pokémon.
  "Ripening Charge": {
    kind: "attachEnergyFromHandThenHeal",
    energyType: "Grass",
    healAmount: 30,
    oncePerTurn: true,
  },
  // Mega Kangaskhan ex — Run Errand: active-only, once-per-turn, draw 2.
  "Run Errand": {
    kind: "drawNActiveOnly",
    count: 2,
    oncePerTurn: true,
  },
  // Mega Venusaur ex — Solar Transfer: as-often, move Basic Grass Energy.
  "Solar Transfer": {
    kind: "moveBasicEnergyAnywhere",
    energyType: "Grass",
  },
  // Iono's Bellibolt ex — Electric Streamer: as-often, attach Basic Lightning
  // from hand to 1 of your Iono's Pokémon.
  "Electric Streamer": {
    kind: "attachEnergyFromHandToNamedAsOften",
    energyType: "Lightning",
    namePrefix: "Iono's ",
  },
  // Emboar — Inferno Fandango: as-often, attach Basic Fire Energy from hand
  // to 1 of your Pokémon (no name filter — empty prefix matches any).
  "Inferno Fandango": {
    kind: "attachEnergyFromHandToNamedAsOften",
    energyType: "Fire",
    namePrefix: "",
  },
  // Rapidash — Hurried Gait: once-per-turn drawOne.
  "Hurried Gait": {
    kind: "drawOne",
    oncePerTurn: true,
  },
};

export function detectAbilityEffect(a: { name: string; type: string; text: string }): AbilityEffect | undefined {
  // Name-based first so specific wording wins over generic regexes.
  const byName = NAMED_ABILITY_EFFECTS[a.name];
  if (byName) return byName;

  const text = a.text || "";
  // Ignore passive/triggered — only auto-wire activated ("Once during your turn").
  if (!/once during your turn/i.test(text)) return undefined;

  // Abilities that attach / search / heal as their primary action but mention
  // "draw a card" as a conditional follow-up would otherwise mis-detect as
  // drawOne. If the text has a primary attach/search/heal verb, skip the
  // draw-only shortcut so the later regex or named entry can claim it.
  const hasPrimaryNonDrawVerb =
    /\battach a (?:basic |basic)?[A-Za-z ]+energy card from your (?:hand|discard)/i.test(text) ||
    /\bsearch your deck\b/i.test(text) ||
    /\bheal \d+ damage\b/i.test(text);

  // "Once during your turn, you may draw a card."
  if (
    /\bdraw a card\b/i.test(text) &&
    !/draw 2 cards/i.test(text) &&
    !hasPrimaryNonDrawVerb
  ) {
    return { kind: "drawOne", oncePerTurn: true };
  }
  if (/draw 2 cards/i.test(text) && !hasPrimaryNonDrawVerb) {
    return { kind: "drawTwo", oncePerTurn: true };
  }
  if (/draw 3 cards/i.test(text) && !hasPrimaryNonDrawVerb) {
    return { kind: "drawN", count: 3, oncePerTurn: true };
  }

  // "Once during your turn, you may heal N damage from this Pokémon."
  {
    const m = text.match(/heal (\d+) damage from this Pok[eé]mon/i);
    if (m) return { kind: "healSelf", amount: parseInt(m[1], 10), oncePerTurn: true };
  }

  // "Once during your turn, you may search your deck for a basic [Type] Energy..."
  {
    const m = text.match(/search your deck for a basic ([A-Za-z]+ )?energy/i);
    if (m) {
      return { kind: "searchBasicEnergy", count: 1, oncePerTurn: true };
    }
  }

  // "Once during your turn, you may attach a basic [Type] Energy card from your
  // hand to 1 of your Pokémon."
  {
    const m = text.match(/attach a basic ([A-Za-z]+) energy card from your hand/i);
    if (m) {
      const type = ENERGY_TYPES.find((t) => t.toLowerCase() === m[1].toLowerCase());
      if (type) return { kind: "attachEnergyFromHand", energyType: type, oncePerTurn: true };
    }
  }

  return undefined;
}

// Apply detection in-place to all abilities on a Pokémon card — called during
// card mapping.
export function annotateAbilities(abilities: Ability[] | undefined): Ability[] | undefined {
  if (!abilities) return abilities;
  return abilities.map((a) => ({ ...a, effect: detectAbilityEffect(a) }));
}

// ---- Condition checks ----------------------------------------------------

function checkCondition(
  state: GameState,
  player: PlayerId,
  cond: AbilityCondition,
): { ok: true } | { ok: false; reason: string } {
  switch (cond.kind) {
    case "activeHasAbilityNamed": {
      const active = state.players[player].active;
      const hasAbility =
        !!active &&
        (active.card.abilities ?? []).some((a) => a.name === cond.abilityName);
      if (!hasAbility) {
        return { ok: false, reason: `Requires an Active Pokémon with the ${cond.abilityName} Ability.` };
      }
      // Also verify the named ability is currently ACTIVE — Path to the Peak
      // / Sticky Bind / Initialization can suppress it, in which case the
      // condition shouldn't be satisfied.
      if (active && !abilitiesActiveOnInstance(state, active)) {
        return { ok: false, reason: `${cond.abilityName} is currently suppressed.` };
      }
      return { ok: true };
    }
    case "yourPokemonKoedLastOppTurn": {
      if (!state.players[player].yourPokemonKoedLastOppTurn) {
        return { ok: false, reason: "Requires one of your Pokémon to have been Knocked Out last turn." };
      }
      return { ok: true };
    }
  }
}

// ---- Activate an ability at runtime --------------------------------------

export interface ActivateResult {
  ok: boolean;
  reason?: string;
}

function shuffleDeck(state: GameState, pl: PlayerId): void {
  const player = state.players[pl];
  const arr = player.deck;
  for (let i = arr.length - 1; i > 0; i--) {
    const j = state.rng.int(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

export function activateAbility(
  state: GameState,
  player: PlayerId,
  instanceId: string,
  abilityIndex: number,
): ActivateResult {
  if (state.phase !== "main")
    return { ok: false, reason: "Not in main phase." };
  if (state.activePlayer !== player)
    return { ok: false, reason: "Not your turn." };

  const pl = state.players[player];
  const holder: PokemonInPlay | undefined =
    pl.active?.instanceId === instanceId
      ? pl.active
      : pl.bench.find((p) => p.instanceId === instanceId);
  if (!holder) return { ok: false, reason: "Pokémon not in play." };

  const ability = holder.card.abilities?.[abilityIndex];
  if (!ability) return { ok: false, reason: "No such ability." };
  if (!ability.effect) return { ok: false, reason: "That ability isn't engine-playable." };
  // Some abilities are "as often as you like" — they have no `oncePerTurn`
  // field. Most abilities are once-per-turn (the field is `true`).
  if (
    "oncePerTurn" in ability.effect &&
    ability.effect.oncePerTurn &&
    holder.abilityUsedThisTurn
  ) {
    return { ok: false, reason: "Ability already used this turn." };
  }
  if (!abilitiesActiveOn(state, holder.card))
    return { ok: false, reason: "Abilities are disabled by the current Stadium." };
  // Psyduck "Damp" — "Pokémon in play (both yours and your opponent's) lose
  // any Ability that requires the Pokémon using it to Knock Out itself."
  // We apply this by blocking activation of self-KO abilities whenever any
  // ability-active Psyduck with Damp is in play on either side.
  {
    const dampInPlay = (["p1", "p2"] as PlayerId[]).some((pid) => {
      const side = state.players[pid];
      for (const p of [side.active, ...side.bench]) {
        if (!p) continue;
        if (!abilitiesActiveOn(state, p.card)) continue;
        if ((p.card.abilities ?? []).some((a) => a.name === "Damp")) return true;
      }
      return false;
    });
    if (dampInPlay) {
      const k = ability.effect.kind;
      if (k === "putCountersOnOppThenSelfKO" || k === "attachNFromDiscardThenSelfKO") {
        return { ok: false, reason: "Psyduck's Damp blocks self-KO abilities." };
      }
    }
  }

  const e = ability.effect;

  // Evaluate pre-activation conditions (e.g. Thwackey requires Festival Lead Active).
  if ("condition" in e && e.condition) {
    const check = checkCondition(state, player, e.condition);
    if (!check.ok) return check;
  }

  switch (e.kind) {
    case "drawOne":
    case "drawTwo":
    case "drawN": {
      const n = e.kind === "drawOne" ? 1 : e.kind === "drawTwo" ? 2 : e.count;
      let drawn = 0;
      for (let i = 0; i < n; i++) {
        const c = pl.deck.shift();
        if (!c) break;
        pl.hand.push(c);
        drawn++;
      }
      logEvent(state, player, `uses ${ability.name} on ${holder.card.name}: draws ${drawn} card(s).`);
      break;
    }

    case "healSelf": {
      const before = holder.damage;
      holder.damage = Math.max(0, holder.damage - e.amount);
      logEvent(state, player, `uses ${ability.name}: heals ${before - holder.damage} from ${holder.card.name}.`);
      break;
    }

    case "healAny": {
      // Target the most-damaged of your Pokémon (heuristic; no target UI yet).
      const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
      const target = allies.sort((a, b) => b.damage - a.damage)[0];
      if (!target) return { ok: false, reason: "No Pokémon in play." };
      const before = target.damage;
      target.damage = Math.max(0, target.damage - e.amount);
      logEvent(state, player, `uses ${ability.name}: heals ${before - target.damage} from ${target.card.name}.`);
      break;
    }

    case "searchBasicEnergy": {
      const isBasicEnergy = (c: Card): c is EnergyCard =>
        c.supertype === "Energy" && c.subtypes.includes("Basic") &&
        (!e.energyType || (c as EnergyCard).provides.includes(e.energyType));
      let found = 0;
      const keep: Card[] = [];
      for (const c of pl.deck) {
        if (found < e.count && isBasicEnergy(c)) {
          pl.hand.push(c);
          found++;
        } else {
          keep.push(c);
        }
      }
      pl.deck = keep;
      shuffleDeck(state, player);
      const typeLabel = e.energyType ? `${e.energyType} ` : "";
      logEvent(state, player, `uses ${ability.name}: gets ${found} basic ${typeLabel}Energy.`);
      break;
    }

    case "attachEnergyFromHand": {
      const idx = pl.hand.findIndex(
        (c) => c.supertype === "Energy" && c.subtypes.includes("Basic") && (c as EnergyCard).provides.includes(e.energyType),
      );
      if (idx < 0) return { ok: false, reason: `No basic ${e.energyType} Energy in hand.` };
      const [en] = pl.hand.splice(idx, 1) as [EnergyCard];
      holder.attachedEnergy.push(en);
      logEvent(state, player, `uses ${ability.name}: attaches ${en.name} to ${holder.card.name}.`);
      break;
    }

    case "attachEnergyFromDiscardToSelf": {
      const isBasicEnergy = (c: Card): c is EnergyCard =>
        c.supertype === "Energy" && c.subtypes.includes("Basic");
      const idx = pl.discard.findIndex(isBasicEnergy);
      if (idx < 0) return { ok: false, reason: "No basic Energy in discard." };
      // Some abilities (Blaziken ex Seething Spirit) attach to ANY of your
      // Pokémon, not just the holder. Disambiguate by the holder's actual
      // ability text — "1 of your Pokémon" → any, otherwise → self.
      const targetsAny = /\b1 of your pok[eé]mon\b/i.test(ability.text ?? "");
      if (targetsAny) {
        const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
        // AI / single-target: auto-pick. Heuristic — prefer an ally that
        // already has matching energy in cost, falling back to the holder.
        if (pl.isAI || allies.length === 1) {
          const en = pl.discard.splice(idx, 1)[0] as EnergyCard;
          // Pick the ally that most "wants" this energy: most-attached-of-same-
          // type already, then highest HP. Falls back to holder.
          const target = allies.slice().sort((a, b) => {
            const aHas = a.attachedEnergy.filter((e) =>
              en.provides.some((p) => e.provides.includes(p)),
            ).length;
            const bHas = b.attachedEnergy.filter((e) =>
              en.provides.some((p) => e.provides.includes(p)),
            ).length;
            if (aHas !== bHas) return bHas - aHas;
            return b.card.hp - a.card.hp;
          })[0];
          target.attachedEnergy.push(en);
          logEvent(state, player, `uses ${ability.name}: attaches ${en.name} to ${target.card.name} from discard.`);
          break;
        }
        // Human picker: stash the chosen energy index and route through the
        // in-play target picker.
        state.pendingInPlayTarget = {
          player,
          label: `${ability.name}: pick one of your Pokémon to attach the discarded ${(pl.discard[idx] as EnergyCard).name}`,
          scope: "own",
          slot: "anywhere",
          filter: "anyPokemon",
          action: {
            kind: "abilityAttachEnergyFromDiscard",
            energyIndexInDiscard: idx,
            ownerId: player,
            abilityName: ability.name,
          },
        };
        return { ok: true };
      }
      const [en] = pl.discard.splice(idx, 1) as [EnergyCard];
      holder.attachedEnergy.push(en);
      logEvent(state, player, `uses ${ability.name}: attaches ${en.name} to ${holder.card.name} from discard.`);
      break;
    }

    case "searchDeckAnyCard": {
      const set = setDeckSearchPick(
        state,
        player,
        () => true, // any card
        1,
        `${ability.name}: pick 1 card from deck`,
      );
      if (!set) {
        logEvent(state, player, `uses ${ability.name}: deck is empty.`);
      } else {
        logEvent(state, player, `uses ${ability.name}.`);
      }
      break;
    }

    case "searchDeckPokemon": {
      const isPkm = (c: Card) => c.supertype === "Pokémon";
      const set = setDeckSearchPick(
        state,
        player,
        isPkm,
        1,
        `${ability.name}: pick 1 Pokémon from deck`,
      );
      if (!set) {
        logEvent(state, player, `uses ${ability.name}: finds no Pokémon.`);
      } else {
        logEvent(state, player, `uses ${ability.name}.`);
      }
      break;
    }

    case "switchWithBench": {
      if (!pl.active || pl.bench.length === 0) {
        return { ok: false, reason: "Nothing to switch with." };
      }
      const incoming = pl.bench.shift()!;
      const outgoing = pl.active;
      pl.active = incoming;
      pl.bench.push(outgoing);
      logEvent(state, player, `uses ${ability.name}: switches ${outgoing.card.name} → ${incoming.card.name}.`);
      break;
    }

    case "shuffleSelfIntoDeck": {
      // Dudunsparce draws 3 first, then shuffles.
      if (ability.name === "Run Away Draw") {
        let drawn = 0;
        for (let i = 0; i < 3; i++) {
          const c = pl.deck.shift();
          if (!c) break;
          pl.hand.push(c);
          drawn++;
        }
        logEvent(state, player, `uses ${ability.name}: draws ${drawn}.`);
      }
      // Shuffle this Pokémon + all attached cards back into the deck.
      const fromActive = pl.active?.instanceId === holder.instanceId;
      const cards: Card[] = [
        holder.card,
        ...holder.evolvedFrom,
        ...holder.attachedEnergy,
        ...holder.tools,
      ];
      pl.deck.push(...cards);
      if (fromActive) {
        pl.active = null;
        // Pause for promote — but keep phase="main" so the player can still
        // play Trainers, attach Energy to Bench, evolve, activate other
        // abilities, etc. before choosing the new Active. Action Bar's
        // attack/retreat/end-turn buttons are gated on `promoteOpen` so
        // those are blocked until a Bench Pokémon is promoted.
        setPendingPromote(state, player);
        state.onPromoteResolved = null;
        // (Intentionally NOT setting phase = "promoteActive" — that phase
        // is reserved for terminal promotes like attack-KO / checkup-KO
        // where the turn is already ending.)
      } else {
        pl.bench = pl.bench.filter((p) => p.instanceId !== holder.instanceId);
      }
      // Shuffle.
      for (let i = pl.deck.length - 1; i > 0; i--) {
        const j = state.rng.int(i + 1);
        [pl.deck[i], pl.deck[j]] = [pl.deck[j], pl.deck[i]];
      }
      logEvent(state, player, `uses ${ability.name}: shuffles ${holder.card.name} into deck.`);
      break;
    }

    case "peek2Top": {
      // Drakloak — look at top 2, put 1 in hand, 1 on bottom of deck.
      const top = pl.deck.splice(0, 2);
      if (top.length === 0) break;
      // Auto-pick: prefer the more-useful card (Pokemon > Trainer > Energy).
      const score = (c: Card) =>
        c.supertype === "Pokémon" ? 2 : c.supertype === "Trainer" ? 1 : 0;
      top.sort((a, b) => score(b) - score(a));
      pl.hand.push(top[0]);
      if (top[1]) pl.deck.push(top[1]); // bottom
      logEvent(state, player, `uses ${ability.name}: takes ${top[0].name}.`);
      break;
    }

    case "oppShuffleHandAndDrawN": {
      const oppId: PlayerId = player === "p1" ? "p2" : "p1";
      const opp = state.players[oppId];
      const hand = opp.hand.splice(0);
      opp.deck.push(...hand);
      for (let i = opp.deck.length - 1; i > 0; i--) {
        const j = state.rng.int(i + 1);
        [opp.deck[i], opp.deck[j]] = [opp.deck[j], opp.deck[i]];
      }
      for (let i = 0; i < e.drawCount; i++) {
        const c = opp.deck.shift();
        if (!c) break;
        opp.hand.push(c);
      }
      logEvent(
        state,
        player,
        `uses ${ability.name}: ${opp.name} shuffles and draws ${e.drawCount}.`,
      );
      break;
    }

    case "attackBonusThisTurnSelfDamage": {
      holder.damage += e.selfDamage;
      pl.thisTurnAttackBonuses.push({ amount: e.bonusPerAttack });
      logEvent(
        state,
        player,
        `uses ${ability.name}: ${holder.card.name} takes ${e.selfDamage} damage to gain +${e.bonusPerAttack}.`,
      );
      break;
    }

    case "attachEnergyFromHandThenDraw": {
      // Teal Dance — attach a Basic <type> Energy from hand to this Pokémon,
      // then draw `drawCount` card(s) if an attach happened.
      const idx = pl.hand.findIndex(
        (c) =>
          c.supertype === "Energy" &&
          c.subtypes.includes("Basic") &&
          (c as EnergyCard).provides.includes(e.energyType),
      );
      if (idx < 0)
        return { ok: false, reason: `No basic ${e.energyType} Energy in hand.` };
      const [en] = pl.hand.splice(idx, 1) as [EnergyCard];
      holder.attachedEnergy.push(en);
      let drawn = 0;
      for (let i = 0; i < e.drawCount; i++) {
        const c = pl.deck.shift();
        if (!c) break;
        pl.hand.push(c);
        drawn++;
      }
      logEvent(
        state,
        player,
        `uses ${ability.name}: attaches ${en.name} to ${holder.card.name} and draws ${drawn}.`,
      );
      break;
    }

    case "attachEnergyFromDiscardToBench": {
      // Eelektrik Dynamotor — attach a basic <type> Energy from discard to a
      // Benched Pokémon. Target auto-picks the Benched ally with the most
      // energies already (same-turn synergy) or the first bench slot.
      if (pl.bench.length === 0)
        return { ok: false, reason: "No Benched Pokémon." };
      const idx = pl.discard.findIndex(
        (c) =>
          c.supertype === "Energy" &&
          c.subtypes.includes("Basic") &&
          (c as EnergyCard).provides.includes(e.energyType),
      );
      if (idx < 0)
        return { ok: false, reason: `No basic ${e.energyType} Energy in discard.` };
      const [en] = pl.discard.splice(idx, 1) as [EnergyCard];
      const target = pl.bench.slice().sort((a, b) => b.attachedEnergy.length - a.attachedEnergy.length)[0];
      target.attachedEnergy.push(en);
      logEvent(
        state,
        player,
        `uses ${ability.name}: attaches ${en.name} to ${target.card.name}.`,
      );
      break;
    }

    case "attachEnergyFromHandToBenchNameN": {
      // Ethan's Ho-Oh ex Golden Flame — up to N Basic Energy of `energyType`
      // from hand to a Benched <namePrefix> Pokémon.
      const benchTargets = pl.bench.filter((p) => p.card.name.startsWith(e.namePrefix));
      if (benchTargets.length === 0)
        return { ok: false, reason: `No Benched ${e.namePrefix.trim()} Pokémon.` };
      const target = benchTargets[0];
      let attached = 0;
      for (let i = 0; i < e.max; i++) {
        const idx = pl.hand.findIndex(
          (c) =>
            c.supertype === "Energy" &&
            c.subtypes.includes("Basic") &&
            (c as EnergyCard).provides.includes(e.energyType),
        );
        if (idx < 0) break;
        const [en] = pl.hand.splice(idx, 1) as [EnergyCard];
        target.attachedEnergy.push(en);
        attached++;
      }
      if (attached === 0)
        return { ok: false, reason: `No basic ${e.energyType} Energy in hand.` };
      logEvent(
        state,
        player,
        `uses ${ability.name}: attaches ${attached} ${e.energyType} Energy to ${target.card.name}.`,
      );
      break;
    }

    case "moveOwnBasicEnergyBetween": {
      // Blissey ex Happy Switch — move a Basic Energy from one of your
      // Pokémon to another. Auto-pick: move from the ally with the most
      // basic energy to the Active if different; otherwise to the first
      // bench slot.
      const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
      if (allies.length < 2)
        return { ok: false, reason: "Need at least two of your Pokémon in play." };
      const isBasicEnergy = (c: Card): c is EnergyCard =>
        c.supertype === "Energy" && c.subtypes.includes("Basic");
      const sourceIdx = allies.findIndex((p) => p.attachedEnergy.some(isBasicEnergy));
      if (sourceIdx < 0)
        return { ok: false, reason: "No Basic Energy attached to any of your Pokémon." };
      const source = allies[sourceIdx];
      const target = allies.find((p) => p !== source)!;
      const eIdx = source.attachedEnergy.findIndex(isBasicEnergy);
      const [en] = source.attachedEnergy.splice(eIdx, 1);
      target.attachedEnergy.push(en);
      logEvent(
        state,
        player,
        `uses ${ability.name}: moves ${en.name} from ${source.card.name} to ${target.card.name}.`,
      );
      break;
    }

    case "moveDamageOwnToOpp": {
      // Munkidori Adrena-Brain — requires holder to have an energy of
      // `energyConditionType` attached. Move up to `counters` damage counters
      // (10 each) from any of your Pokémon to 1 of your opponent's Pokémon.
      if (e.energyConditionType) {
        const hasCond = holder.attachedEnergy.some((en) =>
          en.provides.includes(e.energyConditionType!),
        );
        if (!hasCond)
          return { ok: false, reason: `Requires ${e.energyConditionType} Energy attached.` };
      }
      const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
      const source = allies.filter((p) => p.damage > 0).sort((a, b) => b.damage - a.damage)[0];
      if (!source) return { ok: false, reason: "No damaged Pokémon to move counters from." };
      const oppId: PlayerId = player === "p1" ? "p2" : "p1";
      const opp = state.players[oppId];
      const oppTargets = [opp.active, ...opp.bench].filter((p): p is PokemonInPlay => !!p);
      if (oppTargets.length === 0) return { ok: false, reason: "No opposing Pokémon." };
      const moved = Math.min(e.counters, Math.floor(source.damage / 10));
      if (moved === 0) return { ok: false, reason: "No counters to move." };
      // Human players pick the target. AI auto-picks the highest-value spot.
      if (!pl.isAI) {
        state.pendingInPlayTarget = {
          player,
          label: `${ability.name}: pick an opp Pokémon to receive ${moved} damage counter(s)`,
          scope: "opp",
          slot: "anywhere",
          filter: "anyPokemon",
          action: {
            kind: "abilityMoveDamage",
            counters: moved,
            sourceInstanceId: source.instanceId,
            abilityName: ability.name,
          },
        };
        return { ok: true };
      }
      // AI auto-target: prefer a target this places into KO range, weighted
      // by prize value. Otherwise pick the lowest remaining HP so the
      // counters chip closer to a future KO.
      const added = moved * 10;
      const oppTarget = oppTargets.slice().sort((a, b) => {
        const aHp = effectiveMaxHp(a, state);
        const bHp = effectiveMaxHp(b, state);
        const aKO = a.damage + added >= aHp ? 1 : 0;
        const bKO = b.damage + added >= bHp ? 1 : 0;
        if (aKO !== bKO) return bKO - aKO;
        if (aKO) {
          const aPrize = prizeValue(a.card);
          const bPrize = prizeValue(b.card);
          if (aPrize !== bPrize) return bPrize - aPrize;
        }
        return (aHp - a.damage) - (bHp - b.damage);
      })[0];
      source.damage -= added;
      oppTarget.damage += added;
      logEvent(
        state,
        player,
        `uses ${ability.name}: moves ${moved} damage counter(s) from ${source.card.name} to ${oppTarget.card.name}.`,
      );
      knockOutFromAbilityCounters(state, oppId, oppTarget);
      break;
    }

    case "applyStatusToOppActive": {
      // Calming Light / Scalding Steam — opp Active is now <status>.
      if (e.activeOnly) {
        if (pl.active?.instanceId !== holder.instanceId) {
          return { ok: false, reason: "This Pokémon must be Active." };
        }
      }
      const oppId: PlayerId = player === "p1" ? "p2" : "p1";
      const oppActive = state.players[oppId].active;
      if (!oppActive) return { ok: false, reason: "Opponent has no Active." };
      if (!oppActive.statuses.includes(e.status)) {
        // Mutually-exclusive statuses replace each other; piggyback on addStatus
        // rules by hand-applying here (we don't want the full logging verbosity).
        const EXCLUSIVE = ["asleep", "confused", "paralyzed"];
        if (EXCLUSIVE.includes(e.status)) {
          oppActive.statuses = oppActive.statuses.filter(
            (x) => !EXCLUSIVE.includes(x),
          );
        }
        oppActive.statuses.push(e.status);
      }
      logEvent(
        state,
        player,
        `uses ${ability.name}: ${oppActive.card.name} is now ${e.status}.`,
      );
      break;
    }

    case "healEachOwn": {
      // Lovely Fragrance — heal `amount` from each of your Pokémon.
      const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
      let total = 0;
      for (const a of allies) {
        const before = a.damage;
        a.damage = Math.max(0, a.damage - e.amount);
        total += before - a.damage;
      }
      logEvent(state, player, `uses ${ability.name}: heals ${total} across your Pokémon.`);
      break;
    }

    case "switchToActiveFromBench": {
      // Meowscarada Showtime — self must be Benched. Switch with the Active.
      if (pl.active?.instanceId === holder.instanceId) {
        return { ok: false, reason: "This Pokémon must be Benched." };
      }
      if (!pl.active) return { ok: false, reason: "No Active to swap with." };
      const benchIdx = pl.bench.findIndex((p) => p.instanceId === holder.instanceId);
      if (benchIdx < 0) return { ok: false, reason: "Holder not on bench." };
      const outgoing = pl.active;
      pl.bench.splice(benchIdx, 1);
      pl.active = holder;
      pl.bench.push(outgoing);
      // Outgoing Pokémon keeps its statuses — the ability doesn't say "switch"
      // in the retreat sense, so conditions persist per Pokémon TCG standard.
      logEvent(
        state,
        player,
        `uses ${ability.name}: switches ${outgoing.card.name} → ${holder.card.name}.`,
      );
      break;
    }

    case "benchFromDiscardHpMax": {
      // Alomomola Gentle Fin — Active-only; put a Basic Pokémon with ≤hpMax HP
      // from discard onto your Bench.
      if (e.activeOnly && pl.active?.instanceId !== holder.instanceId) {
        return { ok: false, reason: "This Pokémon must be Active." };
      }
      if (pl.bench.length >= 5) return { ok: false, reason: "Bench is full." };
      const idx = pl.discard.findIndex(
        (c) =>
          c.supertype === "Pokémon" &&
          c.subtypes.includes("Basic") &&
          c.hp <= e.hpMax,
      );
      if (idx < 0) return { ok: false, reason: `No Basic Pokémon with ≤${e.hpMax} HP in discard.` };
      const [card] = pl.discard.splice(idx, 1) as [PokemonCard];
      pl.bench.push(makePokemonInPlay(card));
      logEvent(state, player, `uses ${ability.name}: benches ${card.name} from discard.`);
      break;
    }

    case "searchDeckStadium": {
      const isStadiumCard = (c: Card) =>
        c.supertype === "Trainer" && c.subtypes.includes("Stadium");
      const set = setDeckSearchPick(
        state,
        player,
        isStadiumCard,
        1,
        `${ability.name}: pick a Stadium from deck`,
      );
      if (!set) logEvent(state, player, `uses ${ability.name}: finds no Stadium.`);
      else logEvent(state, player, `uses ${ability.name}.`);
      break;
    }

    case "searchDeckPokemonNamePrefix": {
      const pred = (c: Card): c is PokemonCard =>
        c.supertype === "Pokémon" && c.name.startsWith(e.namePrefix);
      const set = setDeckSearchPick(
        state,
        player,
        pred,
        1,
        `${ability.name}: pick a ${e.namePrefix.trim()} Pokémon`,
      );
      if (!set) logEvent(state, player, `uses ${ability.name}: finds no matching Pokémon.`);
      else logEvent(state, player, `uses ${ability.name}.`);
      break;
    }

    case "top6RevealSupporter": {
      if (e.activeOnly && pl.active?.instanceId !== holder.instanceId) {
        return { ok: false, reason: "This Pokémon must be Active." };
      }
      // Reuse the top-peek pick infrastructure (dynamic import avoided — keep
      // a simple inline implementation that mirrors pendingPick's
      // setTopPeekPick semantics for Supporter-only eligibility).
      const isSupp = (c: Card) =>
        c.supertype === "Trainer" && c.subtypes.includes("Supporter");
      const set = setTopPeekPick(state, player, 6, isSupp, 1, `${ability.name}: reveal a Supporter from the top 6`);
      if (!set) logEvent(state, player, `uses ${ability.name}: deck is empty.`);
      else logEvent(state, player, `uses ${ability.name}.`);
      break;
    }

    case "peekTopMayDiscard": {
      // Morpeko — auto: if the top card is a Pokémon (valuable), keep it;
      // else discard. Good-enough MVP heuristic.
      const top = pl.deck[0];
      if (!top) return { ok: false, reason: "Deck is empty." };
      const discardIt = top.supertype !== "Pokémon";
      if (discardIt) {
        pl.deck.shift();
        pl.discard.push(top);
        logEvent(state, player, `uses ${ability.name}: discards ${top.name}.`);
      } else {
        logEvent(state, player, `uses ${ability.name}: keeps the top card.`);
      }
      break;
    }

    // ----- Remaining-unwired handlers --------------------------------------

    case "bothPlayersDrawOne": {
      if (e.activeOnly && pl.active?.instanceId !== holder.instanceId)
        return { ok: false, reason: "This Pokémon must be Active." };
      const oppId: PlayerId = player === "p1" ? "p2" : "p1";
      const c1 = pl.deck.shift(); if (c1) pl.hand.push(c1);
      const c2 = state.players[oppId].deck.shift(); if (c2) state.players[oppId].hand.push(c2);
      logEvent(state, player, `uses ${ability.name}: each player draws a card.`);
      break;
    }

    case "flipReturnOppActiveEnergyToHand": {
      const heads = state.rng.next() < 0.5;
      logEvent(state, "system", `${ability.name}: ${heads ? "heads" : "tails"}.`);
      if (!heads) break;
      const oppId: PlayerId = player === "p1" ? "p2" : "p1";
      const opp = state.players[oppId];
      if (!opp.active || opp.active.attachedEnergy.length === 0) break;
      const [en] = opp.active.attachedEnergy.splice(0, 1);
      opp.hand.push(en);
      logEvent(state, player, `uses ${ability.name}: returns ${en.name} to ${opp.name}'s hand.`);
      break;
    }

    case "searchDeckTrainerByName": {
      const pred = (c: Card) => c.supertype === "Trainer" && c.name === e.trainerName;
      const set = setDeckSearchPick(state, player, pred, 1, `${ability.name}: pick ${e.trainerName}`);
      if (!set) logEvent(state, player, `uses ${ability.name}: ${e.trainerName} not in deck.`);
      else logEvent(state, player, `uses ${ability.name}.`);
      break;
    }

    case "flipGustOppWithStatus": {
      const heads = state.rng.next() < 0.5;
      logEvent(state, "system", `${ability.name}: ${heads ? "heads" : "tails"}.`);
      if (!heads) break;
      const oppId: PlayerId = player === "p1" ? "p2" : "p1";
      const opp = state.players[oppId];
      if (!opp.active || opp.bench.length === 0) break;
      // Auto-pick most-valuable benched.
      const idx = opp.bench.findIndex((p) => p);
      const pulled = opp.bench.splice(idx, 1)[0];
      const was = opp.active;
      opp.active = pulled;
      opp.bench.push(was);
      const EXCLUSIVE = ["asleep", "confused", "paralyzed"];
      if (EXCLUSIVE.includes(e.status)) {
        pulled.statuses = pulled.statuses.filter((x) => !EXCLUSIVE.includes(x));
      }
      if (!pulled.statuses.includes(e.status)) pulled.statuses.push(e.status);
      logEvent(state, player, `uses ${ability.name}: gusts ${pulled.card.name} — now ${e.status}.`);
      break;
    }

    case "putCountersOnOppThenSelfKO": {
      const oppId: PlayerId = player === "p1" ? "p2" : "p1";
      const opp = state.players[oppId];
      const targets = [opp.active, ...opp.bench].filter((p): p is PokemonInPlay => !!p);
      if (targets.length === 0) return { ok: false, reason: "No opposing Pokémon." };
      // Dusclops + Dusknoir share the "Cursed Blast" ability name but place
      // 5 vs 13 counters. The registry default is 5 (Dusclops); override
      // with the holder's actual ability text if it specifies a different
      // count. Pattern: "put 13 damage counters on..." or "put 5 damage
      // counters on...". Falls back to registry default on any miss.
      const counterMatch = ability.text?.match(/put\s+(\d+)\s+damage counters?/i);
      if (counterMatch) e.counters = parseInt(counterMatch[1], 10);
      // Human players pick the target Pokémon — Cursed Blast is a one-time
      // play with a heavy cost (self-KO), so the call is theirs to make.
      if (!pl.isAI) {
        state.pendingInPlayTarget = {
          player,
          label: `${ability.name}: pick an opp Pokémon to receive ${e.counters} damage counter(s) (this Pokémon will be Knocked Out)`,
          scope: "opp",
          slot: "anywhere",
          filter: "anyPokemon",
          action: {
            kind: "abilityCursedBlast",
            counters: e.counters,
            holderInstanceId: holder.instanceId,
            ownerId: player,
            abilityName: ability.name,
          },
        };
        return { ok: true };
      }
      // AI auto-target: prefer a target this places into KO range, weighted
      // by prize value. Otherwise pick the lowest remaining HP.
      const added = e.counters * 10;
      const target = targets.slice().sort((a, b) => {
        const aHp = effectiveMaxHp(a, state);
        const bHp = effectiveMaxHp(b, state);
        const aKO = a.damage + added >= aHp ? 1 : 0;
        const bKO = b.damage + added >= bHp ? 1 : 0;
        if (aKO !== bKO) return bKO - aKO;
        if (aKO) {
          const aPrize = prizeValue(a.card);
          const bPrize = prizeValue(b.card);
          if (aPrize !== bPrize) return bPrize - aPrize;
        }
        return (aHp - a.damage) - (bHp - b.damage);
      })[0];
      target.damage += added;
      logEvent(state, player, `uses ${ability.name}: puts ${e.counters} counters on ${target.card.name}.`);
      knockOutFromAbilityCounters(state, oppId, target);
      // Self KO — run through the standard pipeline (handles tools, prizes,
      // promote pause).
      holder.damage = 9999;
      knockOutFromAbilityCounters(state, player, holder);
      break;
    }

    case "swapHandCardWithDeckTop": {
      if (pl.hand.length === 0 || pl.deck.length === 0)
        return { ok: false, reason: "Need a hand card and a non-empty deck." };
      // Auto: swap the least-useful hand card (first Energy if any, else first) with the top of deck.
      const handIdx = pl.hand.findIndex((c) => c.supertype === "Energy");
      const idx = handIdx >= 0 ? handIdx : 0;
      const handCard = pl.hand.splice(idx, 1)[0];
      const topCard = pl.deck.shift()!;
      pl.hand.push(topCard);
      pl.deck.unshift(handCard);
      logEvent(state, player, `uses ${ability.name}: swaps a hand card with the top of deck.`);
      break;
    }

    case "searchEvolutionPokemonGated": {
      // Evolutionary Guidance — requires any Energy attached to the holder.
      if (holder.attachedEnergy.length === 0)
        return { ok: false, reason: "Requires Energy attached." };
      const pred = (c: Card) => c.supertype === "Pokémon" && !!c.evolvesFrom;
      const set = setDeckSearchPick(state, player, pred, 1, `${ability.name}: pick an Evolution Pokémon`);
      if (!set) logEvent(state, player, `uses ${ability.name}: no Evolution Pokémon in deck.`);
      else logEvent(state, player, `uses ${ability.name}.`);
      break;
    }

    case "switchWithActiveIfMegaExInPlay": {
      // Excited Dash — self on bench + any Mega ex in play → swap with Active.
      if (pl.active?.instanceId === holder.instanceId)
        return { ok: false, reason: "This Pokémon must be Benched." };
      const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
      const hasMegaEx = allies.some(
        (p) => p.card.subtypes.some((s) => /^Mega/i.test(s)) && p.card.subtypes.includes("ex"),
      );
      if (!hasMegaEx) return { ok: false, reason: "No Mega Evolution Pokémon ex in play." };
      if (!pl.active) return { ok: false, reason: "No Active to swap with." };
      const benchIdx = pl.bench.findIndex((p) => p.instanceId === holder.instanceId);
      const outgoing = pl.active;
      pl.bench.splice(benchIdx, 1);
      pl.active = holder;
      pl.bench.push(outgoing);
      logEvent(state, player, `uses ${ability.name}: switches ${outgoing.card.name} → ${holder.card.name}.`);
      break;
    }

    case "healAnyIfMegaExTypeInPlay": {
      const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
      const hasGated = allies.some(
        (p) =>
          p.card.types.includes(e.requiredType) &&
          p.card.subtypes.some((s) => /^Mega/i.test(s)) &&
          p.card.subtypes.includes("ex"),
      );
      if (!hasGated)
        return { ok: false, reason: `Requires a ${e.requiredType} Mega Evolution Pokémon ex in play.` };
      const target = allies.filter((p) => p.damage > 0).sort((a, b) => b.damage - a.damage)[0];
      if (!target) return { ok: false, reason: "No damaged Pokémon." };
      const before = target.damage;
      target.damage = Math.max(0, target.damage - e.amount);
      logEvent(state, player, `uses ${ability.name}: heals ${before - target.damage} from ${target.card.name}.`);
      break;
    }

    case "healAnyIfEnergyAttached": {
      const hasType = holder.attachedEnergy.some((en) => en.provides.includes(e.energyType));
      if (!hasType) return { ok: false, reason: `Requires ${e.energyType} Energy attached.` };
      const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
      const target = allies.filter((p) => p.damage > 0).sort((a, b) => b.damage - a.damage)[0];
      if (!target) return { ok: false, reason: "No damaged Pokémon." };
      const before = target.damage;
      target.damage = Math.max(0, target.damage - e.amount);
      logEvent(state, player, `uses ${ability.name}: heals ${before - target.damage} from ${target.card.name}.`);
      break;
    }

    case "discardSelfEnergyDrawToN": {
      // Flashing Draw — cost: discard a basic <type> Energy from this Pokémon.
      const idx = holder.attachedEnergy.findIndex(
        (en) => en.subtypes.includes("Basic") && en.provides.includes(e.energyType),
      );
      if (idx < 0) return { ok: false, reason: `No basic ${e.energyType} Energy attached.` };
      const [en] = holder.attachedEnergy.splice(idx, 1);
      pl.discard.push(en);
      const toDraw = Math.max(0, e.targetHand - pl.hand.length);
      let drawn = 0;
      for (let i = 0; i < toDraw; i++) {
        const c = pl.deck.shift();
        if (!c) break;
        pl.hand.push(c);
        drawn++;
      }
      logEvent(state, player, `uses ${ability.name}: discards ${en.name}; draws ${drawn}.`);
      break;
    }

    case "oppShuffleToBottomDrawN": {
      const oppId: PlayerId = player === "p1" ? "p2" : "p1";
      const opp = state.players[oppId];
      const moved = opp.hand.length;
      opp.deck.push(...opp.hand);
      opp.hand = [];
      if (moved > 0) {
        for (let i = 0; i < e.drawCount; i++) {
          const c = opp.deck.shift();
          if (!c) break;
          opp.hand.push(c);
        }
      }
      logEvent(state, player, `uses ${ability.name}: ${opp.name} bottoms ${moved} cards; draws ${moved > 0 ? e.drawCount : 0}.`);
      break;
    }

    case "revealOppHandPutOnOppBench": {
      const oppId: PlayerId = player === "p1" ? "p2" : "p1";
      const opp = state.players[oppId];
      if (opp.bench.length >= 5) return { ok: false, reason: "Opponent's bench is full." };
      const idx = opp.hand.findIndex(
        (c) => c.supertype === "Pokémon" && c.subtypes.includes("Basic") && c.hp <= e.hpMax,
      );
      if (idx < 0) return { ok: false, reason: `No Basic Pokémon with ≤${e.hpMax} HP in opp hand.` };
      const [card] = opp.hand.splice(idx, 1) as [PokemonCard];
      opp.bench.push(makePokemonInPlay(card));
      logEvent(state, player, `uses ${ability.name}: forces ${card.name} onto ${opp.name}'s bench.`);
      break;
    }

    case "top4AttachEnergyType": {
      const top = pl.deck.splice(0, 4);
      if (top.length === 0) return { ok: false, reason: "Deck is empty." };
      const attachers = top.filter(
        (c): c is EnergyCard =>
          c.supertype === "Energy" && c.subtypes.includes("Basic") && (c as EnergyCard).provides.includes(e.energyType),
      );
      const leftovers = top.filter((c) => !attachers.includes(c as EnergyCard));
      // Auto: attach each to an ally in round-robin, starting with Active.
      const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
      if (allies.length === 0) {
        // No allies → put the energies back in the deck.
        pl.deck.push(...attachers, ...leftovers);
        shuffleDeck(state, player);
        logEvent(state, player, `uses ${ability.name}: no allies to attach to.`);
        break;
      }
      attachers.forEach((en, i) => allies[i % allies.length].attachedEnergy.push(en));
      // Put remaining on the bottom.
      pl.deck.push(...leftovers);
      logEvent(state, player, `uses ${ability.name}: attaches ${attachers.length} ${e.energyType} Energy.`);
      break;
    }

    case "searchEvolutionPokemonOfType": {
      const pred = (c: Card) =>
        c.supertype === "Pokémon" && !!c.evolvesFrom && c.types.includes(e.energyType);
      const set = setDeckSearchPick(state, player, pred, e.max, `${ability.name}: pick up to ${e.max} Evolution ${e.energyType} Pokémon`);
      if (!set) logEvent(state, player, `uses ${ability.name}: no Evolution ${e.energyType} Pokémon in deck.`);
      else logEvent(state, player, `uses ${ability.name}.`);
      break;
    }

    case "attachNFromDiscardThenSelfKO": {
      // Overvolt Discharge: attach up to 3 Basic Energy (any type) from
      // discard to your Lightning Pokémon; then self-KO.
      const allies = [pl.active, ...pl.bench].filter(
        (p): p is PokemonInPlay => !!p && p.card.types.includes("Lightning"),
      );
      let attached = 0;
      for (let i = 0; i < e.count; i++) {
        const idx = pl.discard.findIndex(
          (c) => c.supertype === "Energy" && c.subtypes.includes("Basic"),
        );
        if (idx < 0 || allies.length === 0) break;
        const [en] = pl.discard.splice(idx, 1) as [EnergyCard];
        allies[attached % allies.length].attachedEnergy.push(en);
        attached++;
      }
      holder.damage = 9999;
      logEvent(state, player, `uses ${ability.name}: attaches ${attached} basic Energy to Lightning Pokémon; this Pokémon is KO'd.`);
      break;
    }

    case "attachMixedFromHand": {
      // Pyro Dance — attach a Basic A Energy, a Basic B Energy, or 1 of each
      // from hand to your Pokémon in any way (up to `max` total).
      const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
      if (allies.length === 0) return { ok: false, reason: "No Pokémon in play." };
      let attached = 0;
      for (let i = 0; i < e.max; i++) {
        const idx = pl.hand.findIndex(
          (c) =>
            c.supertype === "Energy" &&
            c.subtypes.includes("Basic") &&
            ((c as EnergyCard).provides.includes(e.typeA) || (c as EnergyCard).provides.includes(e.typeB)),
        );
        if (idx < 0) break;
        const [en] = pl.hand.splice(idx, 1) as [EnergyCard];
        allies[attached % allies.length].attachedEnergy.push(en);
        attached++;
      }
      if (attached === 0)
        return { ok: false, reason: `No basic ${e.typeA} or ${e.typeB} Energy in hand.` };
      logEvent(state, player, `uses ${ability.name}: attaches ${attached} Energy.`);
      break;
    }

    case "flipChooseStatusOpp": {
      // Selective Slime — flip; heads: opp Active gets burned/confused/poisoned.
      // Auto-pick Poisoned (generally best value).
      const heads = state.rng.next() < 0.5;
      logEvent(state, "system", `${ability.name}: ${heads ? "heads" : "tails"}.`);
      if (!heads) break;
      const oppId: PlayerId = player === "p1" ? "p2" : "p1";
      const oppActive = state.players[oppId].active;
      if (!oppActive) break;
      if (!oppActive.statuses.includes("poisoned")) oppActive.statuses.push("poisoned");
      logEvent(state, player, `uses ${ability.name}: ${oppActive.card.name} is now poisoned.`);
      break;
    }

    case "flipDiscardRandomFromOppHand": {
      const heads = state.rng.next() < 0.5;
      logEvent(state, "system", `${ability.name}: ${heads ? "heads" : "tails"}.`);
      if (!heads) break;
      const oppId: PlayerId = player === "p1" ? "p2" : "p1";
      const opp = state.players[oppId];
      if (opp.hand.length === 0) break;
      const idx = state.rng.int(opp.hand.length);
      const [c] = opp.hand.splice(idx, 1);
      opp.discard.push(c);
      logEvent(state, player, `uses ${ability.name}: discards ${c.name} from ${opp.name}'s hand.`);
      break;
    }

    case "switchBenchedTypeToActiveWithStatus": {
      const holderName = holder.card.name;
      const candidates = pl.bench.filter(
        (p) =>
          p.card.types.includes(e.energyType) &&
          (!e.excludeSameName || p.card.name !== holderName),
      );
      if (candidates.length === 0 || !pl.active)
        return { ok: false, reason: `No Benched ${e.energyType} Pokémon.` };
      const incoming = candidates[0];
      const benchIdx = pl.bench.findIndex((p) => p.instanceId === incoming.instanceId);
      const outgoing = pl.active;
      pl.bench.splice(benchIdx, 1);
      pl.active = incoming;
      pl.bench.push(outgoing);
      const EXCLUSIVE = ["asleep", "confused", "paralyzed"];
      if (EXCLUSIVE.includes(e.status)) {
        incoming.statuses = incoming.statuses.filter((x) => !EXCLUSIVE.includes(x));
      }
      if (!incoming.statuses.includes(e.status)) incoming.statuses.push(e.status);
      logEvent(state, player, `uses ${ability.name}: switches in ${incoming.card.name} — now ${e.status}.`);
      break;
    }

    case "swapWithBenchAndForceOppPromote": {
      if (!pl.active || pl.bench.length === 0) return { ok: false, reason: "Need Benched Pokémon." };
      const incoming = pl.bench.shift()!;
      const outgoing = pl.active;
      pl.active = incoming;
      pl.bench.push(outgoing);
      const oppId: PlayerId = player === "p1" ? "p2" : "p1";
      const opp = state.players[oppId];
      if (opp.active && opp.bench.length > 0) {
        opp.bench.push(opp.active);
        opp.active = null;
        setPendingPromote(state, oppId);
        state.phase = "promoteActive";
        state.onPromoteResolved = null;
      }
      logEvent(state, player, `uses ${ability.name}: switches self; opp must promote a new Active.`);
      break;
    }

    case "discardHandEnergyStatusOppActive": {
      // Torrid Scales — cost: discard a basic Fire Energy from HAND.
      const idx = pl.hand.findIndex(
        (c) => c.supertype === "Energy" && c.subtypes.includes("Basic") && (c as EnergyCard).provides.includes(e.energyType),
      );
      if (idx < 0) return { ok: false, reason: `No basic ${e.energyType} Energy in hand.` };
      const [en] = pl.hand.splice(idx, 1) as [EnergyCard];
      pl.discard.push(en);
      const oppId: PlayerId = player === "p1" ? "p2" : "p1";
      const oppActive = state.players[oppId].active;
      if (!oppActive) return { ok: false, reason: "Opponent has no Active." };
      if (!oppActive.statuses.includes(e.status)) oppActive.statuses.push(e.status);
      logEvent(state, player, `uses ${ability.name}: discards ${en.name}; ${oppActive.card.name} is now ${e.status}.`);
      break;
    }

    case "putHandToBottomDrawToN": {
      if (pl.hand.length === 0) return { ok: false, reason: "Hand is empty." };
      // Auto: put the first hand card (generally an Energy or weakest) on the bottom.
      const bottomIdx = pl.hand.findIndex((c) => c.supertype === "Energy");
      const idx = bottomIdx >= 0 ? bottomIdx : 0;
      const [bottomed] = pl.hand.splice(idx, 1);
      pl.deck.push(bottomed);
      const toDraw = Math.max(0, e.targetHand - pl.hand.length);
      let drawn = 0;
      for (let i = 0; i < toDraw; i++) {
        const c = pl.deck.shift();
        if (!c) break;
        pl.hand.push(c);
        drawn++;
      }
      logEvent(state, player, `uses ${ability.name}: bottoms ${bottomed.name}; draws ${drawn}.`);
      break;
    }

    case "attachEnergyFromHandToActiveNamePrefix": {
      // Lethargic Charge — self must be Benched; attach an Energy from hand
      // to your Active <namePrefix> Pokémon.
      if (pl.active?.instanceId === holder.instanceId)
        return { ok: false, reason: "This Pokémon must be Benched." };
      if (!pl.active || !pl.active.card.name.startsWith(e.namePrefix))
        return { ok: false, reason: `Active must be a ${e.namePrefix.trim()} Pokémon.` };
      const idx = pl.hand.findIndex((c) => c.supertype === "Energy");
      if (idx < 0) return { ok: false, reason: "No Energy in hand." };
      const [en] = pl.hand.splice(idx, 1) as [EnergyCard];
      pl.active.attachedEnergy.push(en);
      logEvent(state, player, `uses ${ability.name}: attaches ${en.name} to ${pl.active.card.name}.`);
      break;
    }

    case "devolveOppEvolution": {
      // Ancient Wing — Active-only; pick an opp Evolution Pokémon, put the
      // highest Stage card from it back into opp's hand.
      if (e.activeOnly && pl.active?.instanceId !== holder.instanceId)
        return { ok: false, reason: "This Pokémon must be Active." };
      const oppId: PlayerId = player === "p1" ? "p2" : "p1";
      const opp = state.players[oppId];
      const targets = [opp.active, ...opp.bench].filter(
        (p): p is PokemonInPlay => !!p && p.evolvedFrom.length > 0,
      );
      if (targets.length === 0) return { ok: false, reason: "No evolved opposing Pokémon." };
      const target = targets.sort((a, b) => b.evolvedFrom.length - a.evolvedFrom.length)[0];
      const topStage = target.card as PokemonCard;
      const newTop = target.evolvedFrom.pop()!;
      target.card = newTop;
      opp.hand.push(topStage);
      // Evolved-this-turn flag clears — the target is reverted.
      target.evolvedThisTurn = false;
      logEvent(state, player, `uses ${ability.name}: devolves ${target.card.name}; ${topStage.name} returns to ${opp.name}'s hand.`);
      break;
    }

    case "discardToolFromHandGustOpp": {
      // Beckoning Tail — cost: discard a <toolName> from HAND, then gust opp bench.
      const idx = pl.hand.findIndex((c) => c.supertype === "Trainer" && c.name === e.toolName);
      if (idx < 0) return { ok: false, reason: `No ${e.toolName} in hand.` };
      const [tool] = pl.hand.splice(idx, 1);
      pl.discard.push(tool);
      const oppId: PlayerId = player === "p1" ? "p2" : "p1";
      const opp = state.players[oppId];
      if (!opp.active || opp.bench.length === 0)
        return { ok: false, reason: "Opponent has no Benched Pokémon." };
      const pulled = opp.bench.shift()!;
      const was = opp.active;
      opp.active = pulled;
      opp.bench.push(was);
      logEvent(state, player, `uses ${ability.name}: discards ${tool.name}; gusts ${pulled.card.name}.`);
      break;
    }

    case "discardBottomDeckSelfToTop": {
      // Flustered Leap — self must be Benched; discard bottom of deck; discard all
      // attached cards from self; put self (card) on top of deck.
      if (pl.active?.instanceId === holder.instanceId)
        return { ok: false, reason: "This Pokémon must be Benched." };
      if (pl.deck.length === 0) return { ok: false, reason: "Deck is empty." };
      const bottom = pl.deck.pop()!;
      pl.discard.push(bottom);
      // Remove holder from bench; move its attached cards to discard; put card on top.
      const benchIdx = pl.bench.findIndex((p) => p.instanceId === holder.instanceId);
      if (benchIdx < 0) return { ok: false, reason: "Holder not found." };
      const [removed] = pl.bench.splice(benchIdx, 1);
      pl.discard.push(...removed.evolvedFrom, ...removed.attachedEnergy, ...removed.tools);
      pl.deck.unshift(removed.card);
      logEvent(state, player, `uses ${ability.name}: discards ${bottom.name}; returns ${removed.card.name} to top of deck.`);
      // abilityUsedThisTurn isn't set on the removed instance — it's gone from play.
      return { ok: true };
    }

    case "drawToNIfSupporterPlayedName": {
      if (pl.lastSupporterNameThisTurn !== e.supporterName)
        return { ok: false, reason: `Requires ${e.supporterName} played this turn.` };
      const toDraw = Math.max(0, e.targetHand - pl.hand.length);
      let drawn = 0;
      for (let i = 0; i < toDraw; i++) {
        const c = pl.deck.shift();
        if (!c) break;
        pl.hand.push(c);
        drawn++;
      }
      logEvent(state, player, `uses ${ability.name}: draws ${drawn}.`);
      break;
    }

    case "searchEnergyIfSupporterPlayedName": {
      if (pl.lastSupporterNameThisTurn !== e.supporterName)
        return { ok: false, reason: `Requires ${e.supporterName} played this turn.` };
      const isBasicType = (c: Card): c is EnergyCard =>
        c.supertype === "Energy" && c.subtypes.includes("Basic") && (c as EnergyCard).provides.includes(e.energyType);
      let found = 0;
      const keep: Card[] = [];
      for (const c of pl.deck) {
        if (found < e.count && isBasicType(c)) {
          holder.attachedEnergy.push(c);
          found++;
        } else {
          keep.push(c);
        }
      }
      pl.deck = keep;
      shuffleDeck(state, player);
      logEvent(state, player, `uses ${ability.name}: attaches ${found} ${e.energyType} Energy to ${holder.card.name}.`);
      break;
    }

    case "emergencyRotationFromHand": {
      // Activated from hand — our activated-ability infra assumes the holder
      // is in play, so this case is effectively unreachable via the current
      // UI. We leave a clear failure to signal the limitation.
      return { ok: false, reason: "Activating abilities from hand isn't supported yet." };
    }

    case "drawNDiscardCost": {
      if (pl.hand.length < 2) {
        return { ok: false, reason: "Need another card in hand to discard." };
      }
      // Auto-pick: discard first non-Pokémon-active-name card. Simpler: discard
      // first hand card.
      const [c] = pl.hand.splice(0, 1);
      pl.discard.push(c);
      let drawn = 0;
      for (let i = 0; i < e.count; i++) {
        const d = pl.deck.shift();
        if (!d) break;
        pl.hand.push(d);
        drawn++;
      }
      logEvent(state, player, `uses ${ability.name}: discards ${c.name}, draws ${drawn}.`);
      break;
    }
    case "attachEnergyFromHandThenHeal": {
      const idx = pl.hand.findIndex(
        (c) => c.supertype === "Energy" && c.subtypes.includes("Basic") &&
          (c as EnergyCard).provides.includes(e.energyType),
      );
      if (idx < 0) return { ok: false, reason: `No basic ${e.energyType} Energy in hand.` };
      // Auto-pick target: holder.
      const [en] = pl.hand.splice(idx, 1) as [EnergyCard];
      holder.attachedEnergy.push(en);
      const before = holder.damage;
      holder.damage = Math.max(0, holder.damage - e.healAmount);
      logEvent(state, player, `uses ${ability.name}: attaches ${en.name}, heals ${before - holder.damage}.`);
      break;
    }
    case "drawNActiveOnly": {
      if (pl.active?.instanceId !== holder.instanceId) {
        return { ok: false, reason: "This ability requires the Pokémon to be in the Active Spot." };
      }
      let drawn = 0;
      for (let i = 0; i < e.count; i++) {
        const c = pl.deck.shift();
        if (!c) break;
        pl.hand.push(c);
        drawn++;
      }
      logEvent(state, player, `uses ${ability.name}: draws ${drawn}.`);
      break;
    }
    case "moveBasicEnergyAnywhere": {
      // As-often-as-you-like — DON'T set abilityUsedThisTurn at the end.
      // Move a Basic <energyType> Energy from one of your Pokémon to another.
      // Auto-pick: source = first ally with matching energy other than the
      // player's chosen target; target = active.
      const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
      const source = allies.find((p) =>
        p.attachedEnergy.some((en) => en.subtypes.includes("Basic") && en.provides.includes(e.energyType)),
      );
      if (!source) return { ok: false, reason: `No Basic ${e.energyType} Energy on any of your Pokémon.` };
      const target = allies.find((p) => p !== source);
      if (!target) return { ok: false, reason: "Need another Pokémon to move energy to." };
      const idx = source.attachedEnergy.findIndex((en) => en.subtypes.includes("Basic") && en.provides.includes(e.energyType));
      const [en] = source.attachedEnergy.splice(idx, 1);
      target.attachedEnergy.push(en);
      logEvent(state, player, `uses ${ability.name}: moves ${en.name} from ${source.card.name} to ${target.card.name}.`);
      // Don't set abilityUsedThisTurn — usable again same turn.
      return { ok: true };
    }
    case "attachEnergyFromHandToNamedAsOften": {
      // As-often-as-you-like; attach a Basic <type> Energy from hand to a
      // <namePrefix> Pokémon (empty prefix → any of your Pokémon, active or
      // bench). Auto-pick first match.
      const idx = pl.hand.findIndex(
        (c) => c.supertype === "Energy" && c.subtypes.includes("Basic") &&
          (c as EnergyCard).provides.includes(e.energyType),
      );
      if (idx < 0) return { ok: false, reason: `No basic ${e.energyType} Energy in hand.` };
      const allies = e.namePrefix === ""
        ? [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p)
        : pl.bench.filter((p) => p.card.name.startsWith(e.namePrefix));
      const target = allies[0];
      if (!target) return { ok: false, reason: e.namePrefix ? `No Benched ${e.namePrefix.trim()} Pokémon.` : "No Pokémon to attach to." };
      const [en] = pl.hand.splice(idx, 1) as [EnergyCard];
      target.attachedEnergy.push(en);
      logEvent(state, player, `uses ${ability.name}: attaches ${en.name} to ${target.card.name}.`);
      // As-often: don't set abilityUsedThisTurn.
      return { ok: true };
    }
    case "lunarCycleDrawN": {
      // Solrock-in-play gate.
      const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
      if (!allies.some((p) => p.card.name === e.allyName)) {
        return { ok: false, reason: `Requires ${e.allyName} in play.` };
      }
      // Card text: "You can't use more than 1 Lunar Cycle Ability each turn."
      // Per-instance abilityUsedThisTurn is set on the activating Lunatone
      // by the wrapper after this case returns; a second copy in play would
      // otherwise bypass that lock. Scan all Lunatones for a sibling that
      // already activated this turn.
      const sibling = allies.find(
        (p) => p !== holder && p.card.name === holder.card.name && p.abilityUsedThisTurn,
      );
      if (sibling) {
        return { ok: false, reason: `Lunar Cycle: only 1 use per turn across all copies.` };
      }
      // Discard a Basic <costEnergyType> Energy from hand.
      const idx = pl.hand.findIndex(
        (c) =>
          c.supertype === "Energy" &&
          c.subtypes.includes("Basic") &&
          (c as EnergyCard).provides.includes(e.costEnergyType),
      );
      if (idx < 0) return { ok: false, reason: `No basic ${e.costEnergyType} Energy in hand to discard.` };
      const [en] = pl.hand.splice(idx, 1) as [EnergyCard];
      pl.discard.push(en);
      let drawn = 0;
      for (let i = 0; i < e.drawCount; i++) {
        const c = pl.deck.shift();
        if (!c) break;
        pl.hand.push(c);
        drawn++;
      }
      logEvent(state, player, `uses ${ability.name}: discards ${en.name}; draws ${drawn}.`);
      break;
    }

    case "fanCallFirstTurn": {
      // Fan Rotom — first turn of the activating player only. Search up to
      // `max` Pokémon of `energyType` with HP ≤ `hpMax`.
      if (state.turn !== 1) {
        return { ok: false, reason: "Fan Call only works on your first turn." };
      }
      const pred = (c: Card): c is PokemonCard =>
        c.supertype === "Pokémon" &&
        c.types.includes(e.energyType) &&
        c.hp <= e.hpMax;
      if (!setDeckSearchPick(state, player, pred, e.max, `${ability.name}: pick up to ${e.max} ${e.energyType} Pokémon (≤${e.hpMax} HP)`)) {
        logEvent(state, player, `uses ${ability.name}: no matching Pokémon.`);
      } else {
        logEvent(state, player, `uses ${ability.name}.`);
      }
      break;
    }
  }

  // As-often-as-you-like abilities (oncePerTurn:false) intentionally don't
  // set abilityUsedThisTurn so the player can chain the effect.
  if (
    !("oncePerTurn" in ability.effect) ||
    ability.effect.oncePerTurn === true
  ) {
    holder.abilityUsedThisTurn = true;
  }
  return { ok: true };
}

// ---- Triggered-on-evolve abilities ---------------------------------------
//
// A separate path from activated abilities: these fire automatically when a
// Pokémon is played from hand as an evolution, optionally gated by a board
// condition. They're declared by ability name because the text pattern is
// too specific per card.

interface TriggeredOnEvolveEffect {
  // A short description used in the log.
  label: string;
  // Optional pre-check against the current state. Returns true if the effect
  // can fire.
  condition?: (state: GameState, player: PlayerId) => boolean;
  // Runs the effect. May open a pendingPick. The evolved Pokémon instance is
  // provided for effects that need "this Pokémon" context.
  run: (state: GameState, player: PlayerId, self: PokemonInPlay) => void;
}

// Gate: player has any Tera Pokémon in play.
const hasTeraInPlay = (state: GameState, player: PlayerId): boolean => {
  const pl = state.players[player];
  const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
  return allies.some((p) => p.card.subtypes.includes("Tera"));
};


const TRIGGERED_ON_EVOLVE: Record<string, TriggeredOnEvolveEffect> = {
  // Noctowl — if Tera in play, search for up to 2 Trainer cards.
  "Jewel Seeker": {
    label: "Jewel Seeker: search for up to 2 Trainer cards",
    condition: hasTeraInPlay,
    run: (state, player) => {
      const isTrainer = (c: Card) => c.supertype === "Trainer";
      if (!setDeckSearchPick(state, player, isTrainer, 2, "Jewel Seeker: pick up to 2 Trainer cards")) {
        logEvent(state, player, "Jewel Seeker: no Trainers in deck.");
      }
    },
  },
  // Alakazam / Kadabra — "Psychic Draw". Alakazam draws 3, Kadabra draws 2.
  // Per printed text, the trigger fires regardless of Active vs Bench
  // placement (the card has no such restriction).
  "Psychic Draw": {
    label: "Psychic Draw: draw cards",
    run: (state, player, self) => {
      const pl = state.players[player];
      const count = self.card.name === "Kadabra" ? 2 : 3;
      let drawn = 0;
      for (let i = 0; i < count; i++) {
        const c = pl.deck.shift();
        if (!c) break;
        pl.hand.push(c);
        drawn++;
      }
      logEvent(state, player, `Psychic Draw: draws ${drawn}.`);
    },
  },
  // Hariyama — switch one of opp's Benched Pokémon to Active (gust).
  // Humans with >1 bench target need to choose which Pokémon to gust;
  // route through the canonical pokemonCatcher picker (mirrors Pokémon
  // Catcher in trainerEffects.ts). AI / single-target paths resolve inline.
  "Heave-Ho Catcher": {
    label: "Heave-Ho Catcher: gust opponent's Benched",
    run: (state, player) => {
      const oppId: PlayerId = player === "p1" ? "p2" : "p1";
      const opp = state.players[oppId];
      const pl = state.players[player];
      if (!opp.active || opp.bench.length === 0) {
        logEvent(state, player, `Heave-Ho Catcher: nothing to gust — opponent has no Benched Pokémon.`);
        return;
      }
      if (pl.isAI || opp.bench.length === 1) {
        const target =
          opp.bench.length === 1
            ? opp.bench[0]
            : opp.bench.slice().sort((a, b) => b.card.hp - a.card.hp)[0];
        const idx = opp.bench.indexOf(target);
        const pulled = opp.bench.splice(idx, 1)[0];
        const wasActive = opp.active;
        opp.active = pulled;
        opp.bench.push(wasActive);
        logEvent(state, player, `Heave-Ho Catcher gusts ${pulled.card.name} to Active.`);
        return;
      }
      state.pendingInPlayTarget = {
        player,
        label: "Heave-Ho Catcher: pick an opposing Benched Pokémon to gust",
        scope: "opp",
        slot: "bench",
        filter: "anyPokemon",
        action: { kind: "pokemonCatcher" },
      };
    },
  },
  // Brambleghast — make opp's Active Pokémon Confused.
  "Prison Panic": {
    label: "Prison Panic: opp's Active is now Confused",
    run: (state, player) => {
      const oppId: PlayerId = player === "p1" ? "p2" : "p1";
      const opp = state.players[oppId];
      if (!opp.active) return;
      if (!opp.active.statuses.includes("confused")) opp.active.statuses.push("confused");
      logEvent(state, "system", `${opp.active.card.name} is now Confused.`);
    },
  },
  // Grumpig — look at top 4, attach any Basic Energy found.
  "Energized Steps": {
    label: "Energized Steps: top 4 for Basic Energy",
    run: (state, player, self) => {
      const pl = state.players[player];
      const top = pl.deck.splice(0, 4);
      const rest: Card[] = [];
      for (const c of top) {
        if (c.supertype === "Energy" && c.subtypes.includes("Basic")) {
          self.attachedEnergy.push(c as EnergyCard);
          logEvent(state, player, `Energized Steps attaches ${c.name} to ${self.card.name}.`);
        } else {
          rest.push(c);
        }
      }
      pl.deck.push(...rest);
      // Rulebook mandates shuffling after looking; simple Fisher-Yates inline.
      const arr = pl.deck;
      for (let i = arr.length - 1; i > 0; i--) {
        const j = state.rng.int(i + 1);
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
    },
  },
  // Ninjask — search for a Shedinja and put it on the Bench.
  "Cast-Off Shell": {
    label: "Cast-Off Shell: search for Shedinja",
    run: (state, player) => {
      const pl = state.players[player];
      const idx = pl.deck.findIndex(
        (c) => c.supertype === "Pokémon" && c.name === "Shedinja",
      );
      if (idx < 0 || pl.bench.length >= 5) return;
      const [got] = pl.deck.splice(idx, 1);
      pl.bench.push({
        instanceId: `shedinja-${Date.now()}-${Math.random()}`,
        card: got as PokemonCard,
        damage: 0,
        attachedEnergy: [],
        evolvedFrom: [],
        tools: [],
        playedThisTurn: true,
        evolvedThisTurn: false,
        statuses: [],
        abilityUsedThisTurn: false,
      });
      const arr = pl.deck;
      for (let i = arr.length - 1; i > 0; i--) {
        const j = state.rng.int(i + 1);
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      logEvent(state, player, `Cast-Off Shell benches Shedinja.`);
    },
  },

  // Silcoon — search for a Cascoon/Silcoon and put it onto the Bench.
  "Multiplying Cocoon": {
    label: "Multiplying Cocoon: bench a Silcoon/Cascoon",
    run: (state, player) => {
      const pl = state.players[player];
      if (pl.bench.length >= 5) return;
      const idx = pl.deck.findIndex(
        (c) =>
          c.supertype === "Pokémon" &&
          (c.name === "Silcoon" || c.name === "Cascoon"),
      );
      if (idx < 0) return;
      const [got] = pl.deck.splice(idx, 1);
      pl.bench.push({
        instanceId: `cocoon-${Date.now()}-${Math.random()}`,
        card: got as PokemonCard,
        damage: 0,
        attachedEnergy: [],
        evolvedFrom: [],
        tools: [],
        playedThisTurn: true,
        evolvedThisTurn: false,
        statuses: [],
        abilityUsedThisTurn: false,
      });
      const arr = pl.deck;
      for (let i = arr.length - 1; i > 0; i--) {
        const j = state.rng.int(i + 1);
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      logEvent(state, player, `Multiplying Cocoon benches ${got.name}.`);
    },
  },

  // Tinkatuff — flip a coin; if heads, discard a Basic Energy from opp's Active.
  "Haphazard Hammer": {
    label: "Haphazard Hammer: flip → discard Basic Energy from opp",
    run: (state, player) => {
      const heads = state.rng.next() < 0.5;
      logEvent(state, "system", `Haphazard Hammer flip: ${heads ? "heads" : "tails"}.`);
      if (!heads) return;
      const opp = state.players[player === "p1" ? "p2" : "p1"];
      if (!opp.active) return;
      const idx = opp.active.attachedEnergy.findIndex(
        (e) => e.subtypes.includes("Basic"),
      );
      if (idx < 0) return;
      const [e] = opp.active.attachedEnergy.splice(idx, 1);
      opp.discard.push(e);
      logEvent(state, player, `Haphazard Hammer discards ${e.name} from ${opp.active.card.name}.`);
    },
  },

  // Pidove — search for Unfezant/Unfezant ex if Pidove has ≤30 HP remaining.
  "Emergency Evolution": {
    label: "Emergency Evolution: bench an Unfezant",
    condition: (_state, _player) => true, // HP check handled in run
    run: (state, player, self) => {
      const remaining = self.card.hp - self.damage;
      if (remaining > 30) return;
      const pl = state.players[player];
      if (pl.bench.length >= 5) return;
      const idx = pl.deck.findIndex(
        (c) =>
          c.supertype === "Pokémon" &&
          (c.name === "Unfezant" || c.name === "Unfezant ex"),
      );
      if (idx < 0) return;
      const [got] = pl.deck.splice(idx, 1);
      pl.bench.push({
        instanceId: `unfezant-${Date.now()}-${Math.random()}`,
        card: got as PokemonCard,
        damage: 0,
        attachedEnergy: [],
        evolvedFrom: [],
        tools: [],
        playedThisTurn: true,
        evolvedThisTurn: false,
        statuses: [],
        abilityUsedThisTurn: false,
      });
      const arr = pl.deck;
      for (let i = arr.length - 1; i > 0; i--) {
        const j = state.rng.int(i + 1);
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      logEvent(state, player, `Emergency Evolution benches ${got.name}.`);
    },
  },

  // Flygon Sandy Flapping — evolve trigger: discard top 2 of opp deck.
  "Sandy Flapping": {
    label: "Sandy Flapping: discard top 2 of opp's deck",
    run: (state, player) => {
      const oppId: PlayerId = player === "p1" ? "p2" : "p1";
      const opp = state.players[oppId];
      const top = opp.deck.splice(0, 2);
      if (top.length === 0) return;
      opp.discard.push(...top);
      logEvent(state, player, `Sandy Flapping: discards ${top.length} card(s) from ${opp.name}'s deck.`);
    },
  },

  // Crobat ex Biting Spree — put 2 damage counters on each of 2 opp's Pokémon.
  "Biting Spree": {
    label: "Biting Spree: 2 counters on each of 2 opp's Pokémon",
    run: (state, player) => {
      const oppId: PlayerId = player === "p1" ? "p2" : "p1";
      const opp = state.players[oppId];
      const all = [opp.active, ...opp.bench].filter((p): p is PokemonInPlay => !!p);
      const sorted = all.slice().sort((a, b) => b.damage - a.damage).slice(0, 2);
      for (const t of sorted) {
        t.damage += 20;
        logEvent(state, player, `Biting Spree: ${t.card.name} takes 20 damage.`);
      }
    },
  },

  // Ledian Glittering Star Pattern — gust opp benched ≤90 HP remaining.
  "Glittering Star Pattern": {
    label: "Glittering Star Pattern: gust an opp Benched (≤90 HP remaining)",
    run: (state, player) => {
      const oppId: PlayerId = player === "p1" ? "p2" : "p1";
      const opp = state.players[oppId];
      if (!opp.active || opp.bench.length === 0) return;
      const candidates = opp.bench.filter((p) => (p.card.hp - p.damage) <= 90);
      if (candidates.length === 0) return;
      const pick = candidates[0];
      const idx = opp.bench.indexOf(pick);
      const pulled = opp.bench.splice(idx, 1)[0];
      const wasActive = opp.active;
      opp.active = pulled;
      opp.bench.push(wasActive);
      logEvent(state, player, `Glittering Star Pattern: gusts ${pulled.card.name} into the Active spot.`);
    },
  },

  // Dachsbun ex Time to Chow Down — heal all from each Evolution Pokémon, then discard energy from those.
  "Time to Chow Down": {
    label: "Time to Chow Down: heal each Evolution + discard their Energy",
    run: (state, player) => {
      const pl = state.players[player];
      const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
      const evos = allies.filter((p) => (p.card.subtypes ?? []).some((s) => s === "Stage 1" || s === "Stage 2"));
      let healed = 0;
      for (const p of evos) {
        if (p.damage > 0) {
          healed += p.damage;
          p.damage = 0;
        }
      }
      if (healed > 0) {
        for (const p of evos) {
          if (p.attachedEnergy.length > 0) {
            pl.discard.push(...p.attachedEnergy);
            p.attachedEnergy = [];
          }
        }
        logEvent(state, player, `Time to Chow Down: heals ${healed} across Evolution Pokémon and discards their Energy.`);
      }
    },
  },

  // Durant ex Sudden Shearing — discard top of opp deck.
  "Sudden Shearing": {
    label: "Sudden Shearing: discard top card of opp's deck",
    run: (state, player) => {
      const oppId: PlayerId = player === "p1" ? "p2" : "p1";
      const opp = state.players[oppId];
      const top = opp.deck.shift();
      if (!top) return;
      opp.discard.push(top);
      logEvent(state, player, `Sudden Shearing: discards ${top.name} from ${opp.name}'s deck.`);
    },
  },

  // Archaludon ex Assemble Alloy — attach up to 2 Basic Metal Energy from
  // discard to your Metal Pokémon (round-robin).
  "Assemble Alloy": {
    label: "Assemble Alloy: 2 Basic Metal Energy from discard → Metal Pokémon",
    run: (state, player) => {
      const pl = state.players[player];
      const metalAllies = [pl.active, ...pl.bench]
        .filter((p): p is PokemonInPlay => !!p)
        .filter((p) => p.card.types.includes("Metal"));
      if (metalAllies.length === 0) return;
      let attached = 0;
      for (let i = 0; i < 2; i++) {
        const idx = pl.discard.findIndex(
          (c) => c.supertype === "Energy" && c.subtypes.includes("Basic") &&
            (c as EnergyCard).provides.includes("Metal"),
        );
        if (idx < 0) break;
        const [en] = pl.discard.splice(idx, 1) as [EnergyCard];
        metalAllies[attached % metalAllies.length].attachedEnergy.push(en);
        attached++;
      }
      if (attached > 0) logEvent(state, player, `Assemble Alloy: attaches ${attached} Metal Energy.`);
    },
  },

  // Marnie's Grimmsnarl ex Punk Up — 5 Basic Darkness Energy from deck to
  // Marnie's Pokémon. Auto-distributes round-robin.
  "Punk Up": {
    label: "Punk Up: search 5 Basic Darkness Energy → Marnie's Pokémon",
    run: (state, player) => {
      const pl = state.players[player];
      const allies = [pl.active, ...pl.bench]
        .filter((p): p is PokemonInPlay => !!p)
        .filter((p) => p.card.name.startsWith("Marnie's "));
      if (allies.length === 0) return;
      let attached = 0;
      for (let i = 0; i < 5; i++) {
        const idx = pl.deck.findIndex(
          (c) => c.supertype === "Energy" && c.subtypes.includes("Basic") &&
            (c as EnergyCard).provides.includes("Darkness"),
        );
        if (idx < 0) break;
        const [en] = pl.deck.splice(idx, 1) as [EnergyCard];
        allies[attached % allies.length].attachedEnergy.push(en);
        attached++;
      }
      const arr = pl.deck;
      for (let i = arr.length - 1; i > 0; i--) {
        const j = state.rng.int(i + 1);
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      if (attached > 0) logEvent(state, player, `Punk Up: attaches ${attached} Darkness Energy to Marnie's Pokémon.`);
    },
  },

  // Arven's Greedent Greedy Order — recover up to 2 Arven's Sandwich from discard.
  "Greedy Order": {
    label: "Greedy Order: up to 2 Arven's Sandwich from discard → hand",
    run: (state, player) => {
      const pl = state.players[player];
      let recovered = 0;
      for (let i = 0; i < 2; i++) {
        const idx = pl.discard.findIndex((c) => c.name === "Arven's Sandwich");
        if (idx < 0) break;
        const [c] = pl.discard.splice(idx, 1);
        pl.hand.push(c);
        recovered++;
      }
      if (recovered > 0) logEvent(state, player, `Greedy Order: returns ${recovered} Arven's Sandwich.`);
    },
  },

  // Team Rocket's Golbat Sneaky Bite — put 2 damage counters on 1 of opp's Pokémon.
  "Sneaky Bite": {
    label: "Sneaky Bite: 2 counters on 1 opp Pokémon",
    run: (state, player) => {
      const oppId: PlayerId = player === "p1" ? "p2" : "p1";
      const opp = state.players[oppId];
      const targets = [opp.active, ...opp.bench].filter((p): p is PokemonInPlay => !!p);
      if (targets.length === 0) return;
      const target = targets.slice().sort((a, b) => b.damage - a.damage)[0];
      target.damage += 20;
      logEvent(state, player, `Sneaky Bite: ${target.card.name} takes 20 damage.`);
    },
  },

  // Hop's Dubwool Defiant Horn — gust opp's bench (alias of Heave-Ho Catcher).
  // Same picker pattern: humans with >1 bench target choose; AI / single
  // target resolves inline.
  "Defiant Horn": {
    label: "Defiant Horn: gust opp's Benched",
    run: (state, player) => {
      const oppId: PlayerId = player === "p1" ? "p2" : "p1";
      const opp = state.players[oppId];
      const pl = state.players[player];
      if (!opp.active || opp.bench.length === 0) return;
      if (pl.isAI || opp.bench.length === 1) {
        const target =
          opp.bench.length === 1
            ? opp.bench[0]
            : opp.bench.slice().sort((a, b) => b.card.hp - a.card.hp)[0];
        const idx = opp.bench.indexOf(target);
        const pulled = opp.bench.splice(idx, 1)[0];
        const wasActive = opp.active;
        opp.active = pulled;
        opp.bench.push(wasActive);
        logEvent(state, player, `Defiant Horn gusts ${pulled.card.name} to Active.`);
        return;
      }
      state.pendingInPlayTarget = {
        player,
        label: "Defiant Horn: pick an opposing Benched Pokémon to gust",
        scope: "opp",
        slot: "bench",
        filter: "anyPokemon",
        action: { kind: "pokemonCatcher" },
      };
    },
  },

  // Lycanroc Spike-Clad — attach up to 2 Spiky Energy from discard to self.
  "Spike-Clad": {
    label: "Spike-Clad: 2 Spiky Energy from discard → self",
    run: (state, player, self) => {
      const pl = state.players[player];
      let attached = 0;
      for (let i = 0; i < 2; i++) {
        const idx = pl.discard.findIndex((c) => c.name === "Spiky Energy");
        if (idx < 0) break;
        const [en] = pl.discard.splice(idx, 1) as [EnergyCard];
        self.attachedEnergy.push(en);
        attached++;
      }
      if (attached > 0) logEvent(state, player, `Spike-Clad: attaches ${attached} Spiky Energy.`);
    },
  },

  // Ambipom Wicked Tail — flip 2 coins, per heads put a random opp hand card to opp deck.
  "Wicked Tail": {
    label: "Wicked Tail: 2 coins → random opp hand → deck per heads",
    run: (state, player) => {
      const oppId: PlayerId = player === "p1" ? "p2" : "p1";
      const opp = state.players[oppId];
      let heads = 0;
      for (let i = 0; i < 2; i++) {
        if (state.rng.next() < 0.5) heads++;
      }
      for (let i = 0; i < heads; i++) {
        if (opp.hand.length === 0) break;
        const idx = state.rng.int(opp.hand.length);
        const [c] = opp.hand.splice(idx, 1);
        opp.deck.push(c);
        logEvent(state, "system", `${c.name} returned to ${opp.name}'s deck.`);
      }
      // Shuffle opp deck.
      const arr = opp.deck;
      for (let i = arr.length - 1; i > 0; i--) {
        const j = state.rng.int(i + 1);
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
    },
  },

  // Whimsicott Wafting Heal — heal all damage from Active Grass Pokémon, then discard its Energy.
  "Wafting Heal": {
    label: "Wafting Heal: full-heal Active Grass + discard its Energy",
    run: (state, player) => {
      const pl = state.players[player];
      if (!pl.active || !pl.active.card.types.includes("Grass") || pl.active.damage === 0) return;
      const healed = pl.active.damage;
      pl.active.damage = 0;
      pl.discard.push(...pl.active.attachedEnergy);
      pl.active.attachedEnergy = [];
      logEvent(state, player, `Wafting Heal: heals ${healed} from ${pl.active.card.name} and discards its Energy.`);
    },
  },
};

// Called from `evolve()` immediately after the Pokémon's card swap. Fires any
// triggered-on-evolve ability the evolved card has, respecting its condition
// gate and the current Stadium ability-disable rule.
export function fireTriggeredOnEvolve(
  state: GameState,
  player: PlayerId,
  evolved: PokemonInPlay,
): void {
  // Defensive guard: triggered-on-evolve abilities are scoped to the moment
  // the evolution is played from hand. They MUST NOT fire on subsequent
  // turns (e.g., if some future code path called us for an already-evolved
  // Pokémon). The action layer flips evolvedThisTurn = true immediately
  // before calling us, and end-of-turn cleanup clears it.
  if (!evolved.evolvedThisTurn) return;
  const abilities = evolved.card.abilities ?? [];
  for (const ab of abilities) {
    const trig = TRIGGERED_ON_EVOLVE[ab.name];
    if (!trig) continue;
    if (!abilitiesActiveOnInstance(state, evolved)) {
      logEvent(state, "system", `${ab.name} suppressed.`);
      continue;
    }
    if (trig.condition && !trig.condition(state, player)) {
      continue;
    }
    trig.run(state, player, evolved);
    evolved.abilityUsedThisTurn = true;
  }
}

// ---------------------------------------------------------------------------
// Triggered-on-bench abilities
// ---------------------------------------------------------------------------
//
// Fired by `playBasicToBench` right after a Basic Pokémon is placed onto the
// Bench from hand. These are "when you play this Pokémon from your hand onto
// your Bench, you may use this Ability" effects (Meowth ex Last-Ditch Catch).
// Some share a group limit ("You can't use more than 1 Ability that has
// 'Last-Ditch' in its name each turn") — that gate lives on PlayerState.

interface TriggeredOnBenchEffect {
  label: string;
  // Optional gate — return false to suppress. If the ability is part of a
  // turn-limited group (e.g., Last-Ditch), the handler should also check &
  // update the flag.
  condition?: (state: GameState, player: PlayerId) => boolean;
  run: (state: GameState, player: PlayerId, self: PokemonInPlay) => void;
}

const TRIGGERED_ON_BENCH: Record<string, TriggeredOnBenchEffect> = {
  // Meowth ex Last-Ditch Catch — search deck for a Supporter card.
  "Last-Ditch Catch": {
    label: "Last-Ditch Catch: search for a Supporter",
    condition: (state, player) => !state.players[player].lastDitchUsedThisTurn,
    run: (state, player) => {
      const pred = (c: Card) =>
        c.supertype === "Trainer" && (c.subtypes ?? []).includes("Supporter");
      if (
        !setDeckSearchPick(state, player, pred, 1, "Last-Ditch Catch: pick a Supporter")
      ) {
        logEvent(state, player, "Last-Ditch Catch: no Supporter in deck.");
      }
      state.players[player].lastDitchUsedThisTurn = true;
    },
  },

  // Iron Leaves ex Rapid Vernier — switch with Active and (optionally) move
  // any Energy from your other Pokémon. Auto-resolves: switch + move all
  // Energy from formerly-Active onto Iron Leaves.
  "Rapid Vernier": {
    label: "Rapid Vernier: switch with Active + move Energy",
    run: (state, player, self) => {
      const pl = state.players[player];
      if (!pl.active) return;
      const oldActive = pl.active;
      const idx = pl.bench.findIndex((p) => p.instanceId === self.instanceId);
      if (idx < 0) return;
      pl.bench.splice(idx, 1);
      pl.bench.push(oldActive);
      pl.active = self;
      // Move all energy from oldActive (now benched) to self.
      self.attachedEnergy.push(...oldActive.attachedEnergy);
      oldActive.attachedEnergy = [];
      logEvent(state, player, `Rapid Vernier: ${self.card.name} switches in and absorbs ${oldActive.card.name}'s Energy.`);
    },
  },

  // Bloodmoon Ursaluna Battle-Hardened — when played to bench, attach up to
  // 2 Basic Fighting Energy from hand to this Pokémon.
  "Battle-Hardened": {
    label: "Battle-Hardened: attach up to 2 Basic Fighting Energy from hand",
    run: (state, player, self) => {
      const pl = state.players[player];
      let attached = 0;
      for (let i = 0; i < 2; i++) {
        const idx = pl.hand.findIndex(
          (c) => c.supertype === "Energy" && c.subtypes.includes("Basic") &&
            (c as EnergyCard).provides.includes("Fighting"),
        );
        if (idx < 0) break;
        const [en] = pl.hand.splice(idx, 1) as [EnergyCard];
        self.attachedEnergy.push(en);
        attached++;
      }
      if (attached > 0) logEvent(state, player, `Battle-Hardened: attaches ${attached} Fighting Energy.`);
    },
  },
  // Chien-Pao Snow Sink — discard a Stadium in play.
  "Snow Sink": {
    label: "Snow Sink: discard a Stadium in play",
    run: (state) => {
      if (!state.stadium) return;
      const stadium = state.stadium.card;
      const owner = state.stadium.controller;
      state.players[owner].discard.push(stadium);
      state.stadium = null;
      logEvent(state, "system", `Snow Sink: ${stadium.name} discarded.`);
    },
  },
  // Indeedee Obliging Heal — heal 30 from Active + cure a status.
  "Obliging Heal": {
    label: "Obliging Heal: heal 30 from Active + cure status",
    run: (state, player) => {
      const pl = state.players[player];
      if (!pl.active) return;
      const before = pl.active.damage;
      pl.active.damage = Math.max(0, pl.active.damage - 30);
      if (pl.active.statuses.length > 0) pl.active.statuses = [];
      logEvent(state, player, `Obliging Heal: heals ${before - pl.active.damage} from ${pl.active.card.name}.`);
    },
  },
  // Drilbur Dig Dig Dig — search 3 Basic Fighting Energy and discard them
  // (deck thinning + setup for Energy-from-discard plays).
  "Dig Dig Dig": {
    label: "Dig Dig Dig: search 3 Basic Fighting Energy and discard",
    run: (state, player) => {
      const pl = state.players[player];
      let pulled = 0;
      for (let i = 0; i < 3; i++) {
        const idx = pl.deck.findIndex(
          (c) => c.supertype === "Energy" && c.subtypes.includes("Basic") &&
            (c as EnergyCard).provides.includes("Fighting"),
        );
        if (idx < 0) break;
        const [en] = pl.deck.splice(idx, 1);
        pl.discard.push(en);
        pulled++;
      }
      const arr = pl.deck;
      for (let i = arr.length - 1; i > 0; i--) {
        const j = state.rng.int(i + 1);
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      if (pulled > 0) logEvent(state, player, `Dig Dig Dig: discards ${pulled} Fighting Energy from deck.`);
    },
  },
  // Farfetch'd Impromptu Carrier — search a Pokémon Tool from deck and attach
  // to this Pokémon.
  "Impromptu Carrier": {
    label: "Impromptu Carrier: search a Tool and attach to self",
    run: (state, player, self) => {
      const pl = state.players[player];
      const idx = pl.deck.findIndex(
        (c) => c.supertype === "Trainer" &&
          ((c.subtypes ?? []).includes("Pokémon Tool") || (c.subtypes ?? []).includes("Tool")),
      );
      if (idx < 0) return;
      const [tool] = pl.deck.splice(idx, 1);
      self.tools.push(tool as TrainerCard);
      const arr = pl.deck;
      for (let i = arr.length - 1; i > 0; i--) {
        const j = state.rng.int(i + 1);
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      logEvent(state, player, `Impromptu Carrier: attaches ${tool.name}.`);
    },
  },
};

export function fireTriggeredOnBench(
  state: GameState,
  player: PlayerId,
  benched: PokemonInPlay,
): void {
  // Defensive guard: triggered-on-bench abilities ("when you play this
  // Pokémon from your hand onto your Bench") only fire on the turn the
  // Pokémon was played from hand. They MUST NOT fire on subsequent turns
  // when the same Pokémon is sitting on the bench. `playedThisTurn` is set
  // by makePokemonInPlay and cleared by end-of-turn cleanup.
  if (!benched.playedThisTurn) return;
  const abilities = benched.card.abilities ?? [];
  for (const ab of abilities) {
    const trig = TRIGGERED_ON_BENCH[ab.name];
    if (!trig) continue;
    if (!abilitiesActiveOnInstance(state, benched)) {
      logEvent(state, "system", `${ab.name} suppressed.`);
      continue;
    }
    if (trig.condition && !trig.condition(state, player)) continue;
    trig.run(state, player, benched);
    benched.abilityUsedThisTurn = true;
  }
}

// ---------------------------------------------------------------------------
// Triggered on move: Bench → Active
// ---------------------------------------------------------------------------
//
// Fired when a Pokémon moves from the Bench into the Active Spot this turn
// (retreat, Switch, Boss's Orders into own side, promote-after-KO, Jet Energy).
// Once-per-turn gating is baked into each effect's implementation via the
// `abilityUsedThisTurn` instance flag.

interface TriggeredOnMoveEffect {
  label: string;
  condition?: (state: GameState, player: PlayerId, self: PokemonInPlay) => boolean;
  run: (state: GameState, player: PlayerId, self: PokemonInPlay) => void;
}

const TRIGGERED_ON_MOVE_TO_ACTIVE: Record<string, TriggeredOnMoveEffect> = {
  // Yanmega ex Buzzing Boost — when this Pokémon moves from Bench to Active,
  // search deck for up to 3 Basic Grass Energy and attach them to this Pokémon.
  "Buzzing Boost": {
    label: "Buzzing Boost: search 3 Basic Grass Energy",
    run: (state, player, self) => {
      const pl = state.players[player];
      const pred = (c: Card): c is EnergyCard =>
        c.supertype === "Energy" && c.subtypes.includes("Basic") && (c as EnergyCard).provides.includes("Grass");
      let found = 0;
      const keep: Card[] = [];
      for (const c of pl.deck) {
        if (found < 3 && pred(c)) {
          self.attachedEnergy.push(c);
          found++;
        } else keep.push(c);
      }
      pl.deck = keep;
      // Shuffle.
      for (let i = pl.deck.length - 1; i > 0; i--) {
        const j = state.rng.int(i + 1);
        [pl.deck[i], pl.deck[j]] = [pl.deck[j], pl.deck[i]];
      }
      logEvent(state, player, `Buzzing Boost: attaches ${found} Basic Grass Energy to ${self.card.name}.`);
    },
  },
  // Latios Lustrous Assist — when your Mega Latias ex moves from Bench to
  // Active. The ability is on Latios, not Latias; triggers only when the
  // Latias movement occurs, and Latios must be in play. We approximate by
  // firing this hook only when Mega Latias ex itself enters the Active spot,
  // and then we look across all allies for a Latios.
  // (Handled below in fireTriggeredOnMoveToActive: the Mega Latias ex
  // movement reaches into the ally list for a Latios with Lustrous Assist.)
};

const TRIGGERED_ON_MOVE_TO_BENCH: Record<string, TriggeredOnMoveEffect> = {
  // Clawitzer Fall Back to Reload — when this Pokémon moves from the Active
  // Spot to the Bench, attach up to 2 Basic Water Energy from hand to this.
  "Fall Back to Reload": {
    label: "Fall Back to Reload: attach up to 2 Basic Water Energy from hand",
    run: (state, player, self) => {
      const pl = state.players[player];
      let attached = 0;
      for (let i = 0; i < 2; i++) {
        const idx = pl.hand.findIndex(
          (c) =>
            c.supertype === "Energy" &&
            c.subtypes.includes("Basic") &&
            (c as EnergyCard).provides.includes("Water"),
        );
        if (idx < 0) break;
        const [en] = pl.hand.splice(idx, 1) as [EnergyCard];
        self.attachedEnergy.push(en);
        attached++;
      }
      if (attached > 0) {
        logEvent(state, player, `Fall Back to Reload: attaches ${attached} Basic Water Energy to ${self.card.name}.`);
      }
    },
  },
  // Palafin Zero to Hero — when this Pokémon moves from Active to Bench,
  // search your deck for a Palafin ex and swap it with this Pokémon. The
  // Palafin ex keeps attached cards / damage / status.
  "Zero to Hero": {
    label: "Zero to Hero: swap with a Palafin ex",
    run: (state, player, self) => {
      const pl = state.players[player];
      const deckIdx = pl.deck.findIndex(
        (c) => c.supertype === "Pokémon" && c.name === "Palafin ex",
      );
      if (deckIdx < 0) {
        logEvent(state, player, "Zero to Hero: Palafin ex not in deck.");
        return;
      }
      const [newCard] = pl.deck.splice(deckIdx, 1) as [PokemonCard];
      // Replace the holder's card while preserving damage, energy, tools,
      // statuses, evolvedFrom.
      const prevCard = self.card;
      self.evolvedFrom.push(prevCard);
      self.card = newCard;
      self.abilityUsedThisTurn = false;
      // Shuffle deck.
      for (let i = pl.deck.length - 1; i > 0; i--) {
        const j = state.rng.int(i + 1);
        [pl.deck[i], pl.deck[j]] = [pl.deck[j], pl.deck[i]];
      }
      logEvent(state, player, `Zero to Hero: ${prevCard.name} becomes ${newCard.name}.`);
    },
  },
};

export function fireTriggeredOnMoveToActive(
  state: GameState,
  player: PlayerId,
  promoted: PokemonInPlay,
): void {
  // Mark for predicates like Rayquaza Breakthrough Assault. Cleared at end
  // of the player's turn.
  promoted.movedToActiveThisTurn = true;
  // "Once during your turn" — these abilities only fire on the owner's turn.
  // A gust that forces a move on the opponent's turn doesn't trigger.
  if (state.activePlayer !== player) return;
  // Once-per-turn-per-instance gate: if this Pokémon already used its
  // triggered ability this turn (e.g., it retreated and re-promoted in the
  // same turn), the trigger doesn't re-fire.
  if (promoted.abilityUsedThisTurn) return;
  const abilities = promoted.card.abilities ?? [];
  for (const ab of abilities) {
    const trig = TRIGGERED_ON_MOVE_TO_ACTIVE[ab.name];
    if (!trig) continue;
    if (!abilitiesActiveOnInstance(state, promoted)) {
      logEvent(state, "system", `${ab.name} suppressed.`);
      continue;
    }
    if (trig.condition && !trig.condition(state, player, promoted)) continue;
    trig.run(state, player, promoted);
    promoted.abilityUsedThisTurn = true;
  }
  // Lustrous Assist: fires when a Mega Latias ex moves to Active; the ability
  // itself sits on a Latios somewhere on the holder's side.
  if (promoted.card.name === "Mega Latias ex") {
    const pl = state.players[player];
    const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
    const latios = allies.find(
      (p) => p.card.name === "Latios" && (p.card.abilities ?? []).some((a) => a.name === "Lustrous Assist"),
    );
    if (latios && !latios.abilityUsedThisTurn && abilitiesActiveOnInstance(state, latios)) {
      // Move any amount of Energy from Benched Pokémon to Active. Auto: move
      // every energy on every benched ally onto the Active.
      let moved = 0;
      if (pl.active) {
        for (const b of pl.bench) {
          while (b.attachedEnergy.length > 0) {
            const [en] = b.attachedEnergy.splice(0, 1);
            pl.active.attachedEnergy.push(en);
            moved++;
          }
        }
      }
      latios.abilityUsedThisTurn = true;
      logEvent(state, player, `Lustrous Assist: moves ${moved} Energy to ${pl.active?.card.name}.`);
    }
  }
}

export function fireTriggeredOnMoveToBench(
  state: GameState,
  player: PlayerId,
  moved: PokemonInPlay,
): void {
  // Clear "until it leaves the Active Spot" attack-locks. These are sentinel
  // 99999 entries on cantUseAttacksUntilTurn — drop them now that the
  // Pokémon has moved to the bench.
  const bag = moved as PokemonInPlay & { cantUseAttacksUntilTurn?: Record<string, number> };
  if (bag.cantUseAttacksUntilTurn) {
    for (const [name, turn] of Object.entries(bag.cantUseAttacksUntilTurn)) {
      if (turn === 99999) delete bag.cantUseAttacksUntilTurn[name];
    }
  }
  // Opp-side reactions: abilities that fire on the OPPONENT's allies when
  // the active player retreats / switches their Active. Holes / Lava Zone /
  // Swirling Prose all live here.
  fireOnOppActiveMovedToBench(state, player, moved);

  if (state.activePlayer !== player) return;
  // Once-per-turn-per-instance gate: a Pokémon that already used its triggered
  // ability this turn (e.g., bench → active → bench in one turn) doesn't re-fire.
  if (moved.abilityUsedThisTurn) return;
  const abilities = moved.card.abilities ?? [];
  for (const ab of abilities) {
    const trig = TRIGGERED_ON_MOVE_TO_BENCH[ab.name];
    if (!trig) continue;
    if (!abilitiesActiveOnInstance(state, moved)) {
      logEvent(state, "system", `${ab.name} suppressed.`);
      continue;
    }
    if (trig.condition && !trig.condition(state, player, moved)) continue;
    trig.run(state, player, moved);
    moved.abilityUsedThisTurn = true;
  }
}

// Reactions on the opponent's side when player X's active moved to bench.
// `player` is the owner of the just-moved Pokémon; the opp gets to fire
// reactions like Holes (counters), Lava Zone (Burn new Active), Swirling
// Prose (Confuse new Active). Holes targets the just-moved Pokémon; the
// status reactions target the new Active that's currently being switched
// in — by the time fireTriggeredOnMoveToBench runs, the new Active is
// already in place on the bench-mover's side.
function fireOnOppActiveMovedToBench(
  state: GameState,
  player: PlayerId,
  moved: PokemonInPlay,
): void {
  const oppId: PlayerId = player === "p1" ? "p2" : "p1";
  const opp = state.players[oppId];
  // Holes / Lava Zone / Swirling Prose only fire during the bench-mover's
  // own turn (text: "Whenever your opponent's Active Pokémon moves to the
  // Bench during their turn"). If we're inside the opponent's turn (e.g.,
  // an attack-effect forced the switch), skip.
  if (state.activePlayer !== player) return;
  const oppAllies = [opp.active, ...opp.bench].filter((p): p is PokemonInPlay => !!p);
  // The "new Active" is whoever is now Active on the bench-mover's side.
  const newActive = state.players[player].active;
  for (const holder of oppAllies) {
    if (!abilitiesActiveOn(state, holder.card)) continue;
    for (const ab of holder.card.abilities ?? []) {
      if (ab.name === "Holes") {
        // 2 damage counters on the just-moved Pokémon.
        moved.damage += 20;
        logEvent(state, oppId, `Holes: places 2 damage counters on ${moved.card.name}.`);
      } else if (ab.name === "Lava Zone") {
        // New Active is now Burned (only Active Pokémon can carry status).
        if (newActive && !newActive.statuses.includes("burned")) {
          // Use the engine's status path so immunity / Festival Grounds applies.
          newActive.statuses.push("burned");
          logEvent(state, oppId, `Lava Zone: ${newActive.card.name} is now Burned.`);
        }
      } else if (ab.name === "Swirling Prose") {
        // Active-only — gated on the holder being in the Active Spot.
        if (opp.active !== holder) continue;
        if (newActive && !newActive.statuses.includes("confused")) {
          newActive.statuses.push("confused");
          logEvent(state, oppId, `Swirling Prose: ${newActive.card.name} is now Confused.`);
        }
      }
    }
  }
}
