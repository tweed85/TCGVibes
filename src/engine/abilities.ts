// Ability detection + activated-ability resolution.
//
// Pokémon abilities run the gamut from passive ongoing effects ("This
// Pokémon's attacks do 20 more damage") to triggered ones ("When you play
// this Pokémon...") to activated ones ("Once during your turn, you may...").
//
// We auto-wire a selection of activated, once-per-turn abilities — both
// generic text patterns and a hand-picked set of common cards where the
// exact wording is specific (e.g. Thwackey's conditional search).

import { logEvent } from "./rules";
import { abilitiesActiveOn } from "./ongoingEffects";
import { setDeckSearchPick } from "./pendingPick";
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
} from "./types";

const ENERGY_TYPES: EnergyType[] = [
  "Grass", "Fire", "Water", "Lightning", "Psychic",
  "Fighting", "Darkness", "Metal", "Fairy", "Dragon", "Colorless",
];

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
  // Cynthia's Gabite — search for any Cynthia's Pokémon (we approximate as any Pokémon).
  "Champion's Call": { kind: "searchDeckPokemon", oncePerTurn: true },
  // Mega Dragonite ex — switch.
  "Sky Transport": { kind: "switchWithBench", oncePerTurn: true },
  // Alcremie ex — heal 30 from any.
  "Confectionary Gift": { kind: "healAny", amount: 30, oncePerTurn: true },
  // Erika's Vileplume ex — heal 30 from each (approximated via heal-each pattern).
  // Swadloon — heal 20 from Active (approximated as healAny and auto-target Active).
  "Healing Leaves": { kind: "healAny", amount: 20, oncePerTurn: true },
  // Blaziken ex — attach Basic Energy from discard to any of your Pokémon
  // (simplified to self to fit the current target model).
  "Seething Spirit": { kind: "attachEnergyFromDiscardToSelf", oncePerTurn: true },
  // Team Rocket's Spidops — attach Basic Energy from discard to self.
  "Charging Up": { kind: "attachEnergyFromDiscardToSelf", oncePerTurn: true },
};

export function detectAbilityEffect(a: { name: string; type: string; text: string }): AbilityEffect | undefined {
  // Name-based first so specific wording wins over generic regexes.
  const byName = NAMED_ABILITY_EFFECTS[a.name];
  if (byName) return byName;

  const text = a.text || "";
  // Ignore passive/triggered — only auto-wire activated ("Once during your turn").
  if (!/once during your turn/i.test(text)) return undefined;

  // "Once during your turn, you may draw a card."
  if (/\bdraw a card\b/i.test(text) && !/draw 2 cards/i.test(text)) {
    return { kind: "drawOne", oncePerTurn: true };
  }
  if (/draw 2 cards/i.test(text)) {
    return { kind: "drawTwo", oncePerTurn: true };
  }
  if (/draw 3 cards/i.test(text)) {
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
  if (ability.effect.oncePerTurn && holder.abilityUsedThisTurn)
    return { ok: false, reason: "Ability already used this turn." };
  if (!abilitiesActiveOn(state, holder.card))
    return { ok: false, reason: "Abilities are disabled by the current Stadium." };

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
        c.supertype === "Energy" && c.subtypes.includes("Basic");
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
      logEvent(state, player, `uses ${ability.name}: gets ${found} basic Energy.`);
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
  }

  holder.abilityUsedThisTurn = true;
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
  // Alakazam — draw 3 cards.
  "Psychic Draw": {
    label: "Psychic Draw: draw 3",
    run: (state, player) => {
      const pl = state.players[player];
      let drawn = 0;
      for (let i = 0; i < 3; i++) {
        const c = pl.deck.shift();
        if (!c) break;
        pl.hand.push(c);
        drawn++;
      }
      logEvent(state, player, `Psychic Draw: draws ${drawn}.`);
    },
  },
  // Hariyama — switch one of opp's Benched Pokémon to Active (gust).
  "Heave-Ho Catcher": {
    label: "Heave-Ho Catcher: gust opponent's Benched",
    run: (state, player) => {
      const oppId: PlayerId = player === "p1" ? "p2" : "p1";
      const opp = state.players[oppId];
      if (!opp.active || opp.bench.length === 0) return;
      // Auto-pick highest-HP bench target for strongest gust impact.
      const target = opp.bench.slice().sort((a, b) => b.card.hp - a.card.hp)[0];
      const idx = opp.bench.indexOf(target);
      const pulled = opp.bench.splice(idx, 1)[0];
      const wasActive = opp.active;
      opp.active = pulled;
      opp.bench.push(wasActive);
      logEvent(state, player, `Heave-Ho Catcher gusts ${pulled.card.name} to Active.`);
    },
  },
  // Brambleghast — make opp's Active Pokémon Asleep.
  "Prison Panic": {
    label: "Prison Panic: opp's Active is now Asleep",
    run: (state, player) => {
      const oppId: PlayerId = player === "p1" ? "p2" : "p1";
      const opp = state.players[oppId];
      if (!opp.active) return;
      if (!opp.active.statuses.includes("asleep")) opp.active.statuses.push("asleep");
      logEvent(state, "system", `${opp.active.card.name} is now Asleep.`);
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
};

// Called from `evolve()` immediately after the Pokémon's card swap. Fires any
// triggered-on-evolve ability the evolved card has, respecting its condition
// gate and the current Stadium ability-disable rule.
export function fireTriggeredOnEvolve(
  state: GameState,
  player: PlayerId,
  evolved: PokemonInPlay,
): void {
  const abilities = evolved.card.abilities ?? [];
  for (const ab of abilities) {
    const trig = TRIGGERED_ON_EVOLVE[ab.name];
    if (!trig) continue;
    if (!abilitiesActiveOn(state, evolved.card)) {
      logEvent(state, "system", `${ab.name} suppressed by current Stadium.`);
      continue;
    }
    if (trig.condition && !trig.condition(state, player)) {
      continue;
    }
    trig.run(state, player, evolved);
    evolved.abilityUsedThisTurn = true;
  }
}
