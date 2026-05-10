// Interactive-pick infrastructure.
//
// Search / peek / discard-recovery effects pull a set of candidate cards out
// of the player's deck or discard and ask them to pick up to N. The chosen
// cards go to hand; the rest go back per `PendingPick.unpicked`. While a pick
// is pending, the game is paused (phase = "pick"); other player actions are
// blocked until the pick resolves.

import { applyEvolveSideEffects, endTurn as endTurnRule, finishEndTurn, logEvent, makePokemonInPlay } from "./rules";
import { fireTriggeredOnBench, fireTriggeredOnEvolve } from "./abilities";
import type {
  Card,
  EnergyCard,
  GameState,
  PlayerId,
} from "./types";

export type ActionResult =
  | { ok: true }
  | { ok: false; reason: string };

const ok: ActionResult = { ok: true };
const fail = (reason: string): ActionResult => ({ ok: false, reason });

function shuffleDeck(state: GameState, pl: PlayerId): void {
  const player = state.players[pl];
  const arr = player.deck;
  for (let i = arr.length - 1; i > 0; i--) {
    const j = state.rng.int(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function isBasicEnergy(c: Card): c is EnergyCard {
  return c.supertype === "Energy" && (c.subtypes ?? []).includes("Basic");
}

function energyTypes(c: EnergyCard): string[] {
  return c.provides.length > 0 ? c.provides : [c.name];
}

// ---------------------------------------------------------------------------
// Builders — extract candidate cards and set state.pendingPick.
// Return true if a pick was set, false if no candidates exist (caller should
// log a "no eligible cards" message and move on).
// ---------------------------------------------------------------------------

// Prize cards are their own face-down pile — they must NEVER appear in a
// deck / discard search pool. We defensively filter by identity: if a prize
// Card reference somehow shows up in `pl.deck`, drop it on the floor.
function excludePrizes(pl: { prizes: Card[] }, cards: Card[]): Card[] {
  if (pl.prizes.length === 0) return cards;
  const prizeSet = new Set(pl.prizes);
  return cards.filter((c) => !prizeSet.has(c));
}

export function setDeckSearchPick(
  state: GameState,
  player: PlayerId,
  pred: (c: Card) => boolean,
  max: number,
  label: string,
  options: {
    toBench?: boolean;
    toEvolve?: boolean;
    postResolveChain?: import("./types").DeckSearchChainStep;
    min?: number;
    // After the pick resolves, route the picked Energy onto this Pokémon
    // (instead of leaving it in hand). Used by Shaymin "Send Flowers"
    // and Wondrous-Patch-style flows. Only meaningful when the predicate
    // restricts to Energy.
    attachToInstanceId?: string;
    afterPick?: import("./types").PendingPick["afterPick"];
    // Enforce different basic Energy types in the picked set (Energy
    // Search Pro). Resolver rejects duplicates.
    uniqueByEnergyType?: boolean;
  } = {},
): boolean {
  const pl = state.players[player];
  const safeDeck = excludePrizes(pl, pl.deck);
  const pool: Card[] = [];
  const rest: Card[] = [];
  for (const c of safeDeck) {
    if (pred(c)) pool.push(c);
    else rest.push(c);
  }
  if (pool.length === 0) {
    // Still shuffle to hide information from the player.
    shuffleDeck(state, player);
    // If a chain step is queued, surface a Continue-style notice so the
    // user is told this stage had no qualifying cards BEFORE the next stage
    // opens. The notice's Continue button fires the chain.
    if (options.postResolveChain) {
      state.pendingSearchNotice = {
        player,
        message: stageSkipMessage(label),
        nextChain: options.postResolveChain,
      };
      state.phase = "main";
    }
    return false;
  }
  pl.deck = rest;
  state.pendingPick = {
    player,
    label,
    pool,
    min: Math.max(0, options.min ?? 0),
    max: Math.min(max, pool.length),
    unpicked: "shuffleIntoDeck",
    source: "deck",
    toBench: options.toBench,
    toEvolve: options.toEvolve,
    postResolveChain: options.postResolveChain,
    attachToInstanceId: options.attachToInstanceId,
    afterPick: options.afterPick,
    uniqueByEnergyType: options.uniqueByEnergyType,
    // Snapshot the non-matching deck cards so the UI's "All" tab can show
    // the entire deck during the search. Slice() to avoid sharing state with
    // pl.deck (which gets mutated when the pick resolves).
    nonEligiblePool: rest.slice(),
  };
  state.phase = "pick";
  return true;
}

// Derive a friendly skip message from the pick's label. Labels follow the
// "Dawn (X of 3): pick 1 <Subtype> Pokémon" convention; the subtype is the
// part after "pick 1" or "pick a".
function stageSkipMessage(label: string): string {
  const m = label.match(/pick (?:1|a|an|up to \d+)\s+(.+?)(?:\s+to|\s+from|\s*$)/i);
  const category = m?.[1]?.trim() ?? "card";
  return `No ${category} in your deck. Continue to the next step.`;
}

// Resolve the "no qualifying cards" notice — clears it and fires the queued
// chain step (if any).
export function resolvePendingSearchNotice(
  state: GameState,
  clicker: PlayerId,
): ActionResult {
  const notice = state.pendingSearchNotice;
  if (!notice || notice.player !== clicker) return fail("No search notice pending.");
  const next = notice.nextChain;
  state.pendingSearchNotice = null;
  if (next) applyChainStep(state, clicker, next);
  return ok;
}

// Opens the next stage of a multi-step deck search. Keyed by the chain step's
// `kind` since each step has its own predicate + label.
function applyChainStep(
  state: GameState,
  player: PlayerId,
  step: import("./types").DeckSearchChainStep,
): void {
  switch (step.kind) {
    case "dawn-stage1": {
      // Dawn rules: each stage is INDEPENDENT — Stage 1 doesn't have to
      // evolve from the Basic picked. Predicate matches any Stage 1.
      const pred = (c: Card) =>
        c.supertype === "Pokémon" && (c.subtypes ?? []).includes("Stage 1");
      if (!setDeckSearchPick(state, player, pred, 1, "Dawn (2 of 3): pick any Stage 1 Pokémon", {
        postResolveChain: { kind: "dawn-stage2" },
      })) {
        logEvent(state, player, "Dawn: no Stage 1 Pokémon in deck.");
      }
      break;
    }
    case "dawn-stage2": {
      // Dawn rules: Stage 2 doesn't have to evolve from the Stage 1 picked.
      // Predicate matches any Stage 2 in the deck.
      const pred = (c: Card) =>
        c.supertype === "Pokémon" && (c.subtypes ?? []).includes("Stage 2");
      if (!setDeckSearchPick(state, player, pred, 1, "Dawn (3 of 3): pick any Stage 2 Pokémon")) {
        logEvent(state, player, "Dawn: no Stage 2 Pokémon in deck.");
      }
      break;
    }
    case "hilda-energy": {
      // Hilda step 2: after the Evolution Pokémon, pick any Energy. Card
      // text says "an Energy card" — Special Energy (e.g. Spiky, Mist,
      // Telepathic Psychic) is eligible too, not just Basic.
      const pred = (c: Card) => c.supertype === "Energy";
      if (!setDeckSearchPick(state, player, pred, 1, "Hilda (2 of 2): pick an Energy")) {
        logEvent(state, player, "Hilda: no Energy in deck.");
      }
      break;
    }
    case "colress-energy": {
      // Colress's Tenacity step 2: after the Stadium, pick a basic Energy.
      const pred = (c: Card) =>
        c.supertype === "Energy" && (c.subtypes ?? []).includes("Basic");
      if (!setDeckSearchPick(state, player, pred, 1, "Colress's Tenacity (2 of 2): pick a basic Energy")) {
        logEvent(state, player, "Colress's Tenacity: no basic Energy in deck.");
      }
      break;
    }
    case "secret-box-tool": {
      // Secret Box step 2 of 4 — after Item, pick a Pokémon Tool.
      const pred = (c: Card) =>
        c.supertype === "Trainer" &&
        ((c.subtypes ?? []).includes("Pokémon Tool") || (c.subtypes ?? []).includes("Tool"));
      if (!setDeckSearchPick(state, player, pred, 1, "Secret Box (2 of 4): pick a Pokémon Tool", {
        postResolveChain: { kind: "secret-box-supporter" },
      })) {
        logEvent(state, player, "Secret Box: no Pokémon Tool in deck.");
      }
      break;
    }
    case "secret-box-supporter": {
      // Secret Box step 3 of 4 — pick a Supporter.
      const pred = (c: Card) =>
        c.supertype === "Trainer" && (c.subtypes ?? []).includes("Supporter");
      if (!setDeckSearchPick(state, player, pred, 1, "Secret Box (3 of 4): pick a Supporter", {
        postResolveChain: { kind: "secret-box-stadium" },
      })) {
        logEvent(state, player, "Secret Box: no Supporter in deck.");
      }
      break;
    }
    case "secret-box-stadium": {
      // Secret Box step 4 of 4 — pick a Stadium.
      const pred = (c: Card) =>
        c.supertype === "Trainer" && (c.subtypes ?? []).includes("Stadium");
      if (!setDeckSearchPick(state, player, pred, 1, "Secret Box (4 of 4): pick a Stadium")) {
        logEvent(state, player, "Secret Box: no Stadium in deck.");
      }
      break;
    }
    case "larry-skill-supporter": {
      // Larry's Skill step 2 of 3 — after the Pokémon, pick a Supporter.
      const pred = (c: Card) =>
        c.supertype === "Trainer" && (c.subtypes ?? []).includes("Supporter");
      if (!setDeckSearchPick(state, player, pred, 1, "Larry's Skill (2 of 3): pick a Supporter", {
        postResolveChain: { kind: "larry-skill-energy" },
      })) {
        logEvent(state, player, "Larry's Skill: no Supporter in deck.");
      }
      break;
    }
    case "larry-skill-energy": {
      // Larry's Skill step 3 of 3 — pick a Basic Energy.
      const pred = (c: Card) =>
        c.supertype === "Energy" && (c.subtypes ?? []).includes("Basic");
      if (!setDeckSearchPick(state, player, pred, 1, "Larry's Skill (3 of 3): pick a Basic Energy")) {
        logEvent(state, player, "Larry's Skill: no Basic Energy in deck.");
      }
      break;
    }
  }
}

function applyAfterPick(
  state: GameState,
  player: PlayerId,
  afterPick: NonNullable<import("./types").PendingPick["afterPick"]>,
  picked: Card[],
): void {
  const pl = state.players[player];
  switch (afterPick.kind) {
    case "crispinHandEnergy": {
      const handEnergy = picked.find(isBasicEnergy);
      if (!handEnergy) return;
      const pickedTypes = new Set(energyTypes(handEnergy));
      const pred = (c: Card): boolean =>
        isBasicEnergy(c) && energyTypes(c).every((t) => !pickedTypes.has(t));
      if (!setDeckSearchPick(
        state,
        player,
        pred,
        1,
        "Crispin (2 of 2): pick a different basic Energy to attach",
        { afterPick: { kind: "crispinAttachEnergy" } },
      )) {
        logEvent(state, player, "Crispin: no different basic Energy in deck to attach.");
      }
      break;
    }
    case "crispinAttachEnergy": {
      const attachEnergy = picked.find(isBasicEnergy);
      if (!attachEnergy) return;
      const handIdx = pl.hand.lastIndexOf(attachEnergy);
      if (handIdx >= 0) pl.hand.splice(handIdx, 1);
      const allies = [pl.active, ...pl.bench].filter((p): p is import("./types").PokemonInPlay => !!p);
      if (allies.length === 0) {
        pl.hand.push(attachEnergy);
        logEvent(state, player, "Crispin: no Pokémon in play to attach Energy to.");
        return;
      }
      state.pendingInPlayTarget = {
        player,
        label: `Crispin: pick one of your Pokémon to attach ${attachEnergy.name}`,
        scope: "own",
        slot: "anywhere",
        filter: "anyPokemon",
        action: { kind: "crispinAttachEnergy", energy: attachEnergy },
      };
      break;
    }
    case "amuletOfHopeResume": {
      // Picker has resolved; the picked cards are already in hand. Resume
      // the deferred onPromoteResolved continuation (set by the attacker's
      // finishHit or by the test that triggered the KO).
      const cont = state.onPromoteResolved;
      state.onPromoteResolved = null;
      if (cont === "endTurn") endTurnRule(state);
      // Other continuations (passTurn, secondAttack) live in actions.ts and
      // would need a lazy import to invoke here. The common case
      // (opponent-attack KO) sets "endTurn" so this covers the audit path.
      break;
    }
    case "powerglassAttach": {
      // Pull the picked basic Energy out of hand (resolvePendingPick put
      // it there as the default destination), attach to Active, then
      // resume the deferred endTurn body.
      const energy = picked.find(isBasicEnergy);
      if (energy) {
        const handIdx = pl.hand.lastIndexOf(energy);
        if (handIdx >= 0) {
          pl.hand.splice(handIdx, 1);
          if (pl.active) {
            pl.active.attachedEnergy.push(energy);
            logEvent(state, player, `Powerglass attaches ${energy.name} to ${pl.active.card.name}.`);
          } else {
            pl.discard.push(energy);
          }
        }
      }
      // Resume endTurn from the post-Powerglass body.
      finishEndTurn(state);
      break;
    }
    case "glassTrumpetStash": {
      // Pull the picked basic Energy back out of hand (resolvePendingPick
      // deposited them there as the default destination), stash on
      // pendingAttachQueue, and open the per-Colorless-Bench attach
      // picker. This way the Energy never visibly transits the hand.
      const energies: EnergyCard[] = [];
      for (const c of picked) {
        if (!isBasicEnergy(c)) continue;
        const idx = pl.hand.lastIndexOf(c);
        if (idx >= 0) {
          pl.hand.splice(idx, 1);
          energies.push(c);
        }
      }
      if (energies.length === 0) return;
      state.pendingAttachQueue = {
        ownerId: player,
        energies,
        sourceLabel: "Glass Trumpet",
      };
      state.pendingInPlayTarget = {
        player,
        label: `Glass Trumpet: pick a Benched Colorless Pokémon to attach ${energies[0].name}`,
        scope: "own",
        slot: "bench",
        filter: "anyPokemon",
        action: { kind: "glassTrumpetAttach", remaining: energies.length },
      };
      break;
    }
    case "grandTreeApplyStage1":
    case "grandTreeApplyStage2": {
      const stageEvo = picked.find(
        (c) =>
          c.supertype === "Pokémon" &&
          !!(c as import("./types").PokemonCard).evolvesFrom,
      ) as import("./types").PokemonCard | undefined;
      if (!stageEvo) return;
      const handIdx = pl.hand.lastIndexOf(stageEvo);
      if (handIdx < 0) return;
      const ally = [pl.active, ...pl.bench]
        .filter((p): p is import("./types").PokemonInPlay => !!p)
        .find((p) => p.instanceId === afterPick.targetInstanceId);
      if (!ally) {
        // Captured ally is gone (KO'd between steps?) — leave the card in
        // hand as a defensive fallback.
        return;
      }
      if (ally.card.name !== stageEvo.evolvesFrom) {
        // Mismatch (the captured ally evolved out from under us). Bail.
        return;
      }
      pl.hand.splice(handIdx, 1);
      ally.evolvedFrom.push(ally.card);
      ally.card = stageEvo;
      applyEvolveSideEffects(state, ally);
      logEvent(state, player, `Grand Tree: evolves into ${stageEvo.name}.`);
      fireTriggeredOnEvolve(state, player, ally);

      // After Stage 1 lands, optionally chain into the Stage 2 search.
      if (afterPick.kind === "grandTreeApplyStage1") {
        const targetInstanceId = afterPick.targetInstanceId;
        const stage2Pred = (c: Card) =>
          c.supertype === "Pokémon" &&
          (c.subtypes ?? []).includes("Stage 2") &&
          (c as import("./types").PokemonCard).evolvesFrom === ally.card.name;
        if (
          !setDeckSearchPick(
            state,
            player,
            stage2Pred,
            1,
            `Grand Tree (optional): pick a Stage 2 that evolves from ${ally.card.name}`,
            {
              afterPick: { kind: "grandTreeApplyStage2", targetInstanceId },
            },
          )
        ) {
          // No Stage 2 in deck — log and shuffle.
          logEvent(state, player, "Grand Tree: no matching Stage 2 in deck.");
          shuffleDeck(state, player);
        }
      } else {
        // After the optional Stage 2, shuffle once.
        shuffleDeck(state, player);
      }
      break;
    }
  }
}

export function setTopPeekPick(
  state: GameState,
  player: PlayerId,
  slice: number,
  eligible: (c: Card) => boolean,
  max: number,
  label: string,
): boolean {
  const pl = state.players[player];
  // Defensively ensure the deck has no prize references before we peek.
  pl.deck = excludePrizes(pl, pl.deck);
  const pool = pl.deck.splice(0, slice);
  if (pool.length === 0) return false;
  const eligibleIndexes: number[] = [];
  pool.forEach((c, i) => { if (eligible(c)) eligibleIndexes.push(i); });
  state.pendingPick = {
    player,
    label,
    pool,
    min: 0,
    max: Math.min(max, eligibleIndexes.length),
    eligibleIndexes,
    unpicked: "shuffleIntoDeck",
    source: "deckTop",
  };
  state.phase = "pick";
  return true;
}

export function setBottomPeekPick(
  state: GameState,
  player: PlayerId,
  slice: number,
  eligible: (c: Card) => boolean,
  max: number,
  label: string,
): boolean {
  const pl = state.players[player];
  pl.deck = excludePrizes(pl, pl.deck);
  const start = Math.max(0, pl.deck.length - slice);
  const pool = pl.deck.splice(start, slice);
  if (pool.length === 0) return false;
  const eligibleIndexes: number[] = [];
  pool.forEach((c, i) => { if (eligible(c)) eligibleIndexes.push(i); });
  state.pendingPick = {
    player,
    label,
    pool,
    min: 0,
    max: Math.min(max, eligibleIndexes.length),
    eligibleIndexes,
    unpicked: "shuffleIntoDeck",
    source: "deckBottom",
  };
  state.phase = "pick";
  return true;
}

export function setDiscardRecoveryPick(
  state: GameState,
  player: PlayerId,
  pred: (c: Card) => boolean,
  max: number,
  label: string,
): boolean {
  const pl = state.players[player];
  const pool: Card[] = [];
  const rest: Card[] = [];
  for (const c of pl.discard) {
    if (pred(c)) pool.push(c);
    else rest.push(c);
  }
  if (pool.length === 0) return false;
  pl.discard = rest;
  state.pendingPick = {
    player,
    label,
    pool,
    min: 0,
    max: Math.min(max, pool.length),
    unpicked: "returnToDiscard",
    source: "discard",
  };
  state.phase = "pick";
  return true;
}

// ---------------------------------------------------------------------------
// AI auto-resolve — picks greedily up to `max` from the eligible pool.
// ---------------------------------------------------------------------------

export function resolveAiPendingPick(
  state: GameState,
  player: PlayerId,
): boolean {
  const pick = state.pendingPick;
  if (!pick || pick.player !== player) return false;
  const eligible = pick.eligibleIndexes ?? pick.pool.map((_, i) => i);
  const take = Math.min(pick.max, eligible.length);
  const picked = eligible.slice(0, take);
  resolvePendingPick(state, player, picked);
  return true;
}

// ---------------------------------------------------------------------------
// Resolver.
// ---------------------------------------------------------------------------

export function resolvePendingPick(
  state: GameState,
  player: PlayerId,
  pickedIndexes: number[],
): ActionResult {
  const pick = state.pendingPick;
  if (!pick) return fail("No pick pending.");
  if (pick.player !== player) return fail("Not your pick.");

  // Deduplicate + validate.
  const uniq = [...new Set(pickedIndexes)].sort((a, b) => a - b);
  if (uniq.length > pick.max) return fail(`Pick at most ${pick.max}.`);
  if (uniq.length < pick.min) return fail(`Pick at least ${pick.min}.`);
  for (const i of uniq) {
    if (i < 0 || i >= pick.pool.length) return fail("Invalid pick.");
    if (pick.eligibleIndexes && !pick.eligibleIndexes.includes(i)) {
      return fail("Selection not eligible.");
    }
  }

  const picked: Card[] = [];
  const unpicked: Card[] = [];
  for (let i = 0; i < pick.pool.length; i++) {
    if (uniq.includes(i)) picked.push(pick.pool[i]);
    else unpicked.push(pick.pool[i]);
  }

  // Different-basic-Energy-types constraint (Energy Search Pro). The UI
  // may grey out same-type tiles, but the resolver is the correctness
  // layer — reject duplicates here even if a future UI bug allows them.
  if (pick.uniqueByEnergyType) {
    const seen = new Set<string>();
    for (const c of picked) {
      if (!isBasicEnergy(c)) continue;
      for (const t of energyTypes(c)) {
        if (seen.has(t)) return fail("Energy types must be different.");
        seen.add(t);
      }
    }
  }

  const pl = state.players[player];
  if (pick.pickedDestination === "discard") {
    pl.discard.push(...picked);
  } else if (pick.pickedDestination === "topOfDeck") {
    // Routed after unpicked cards are returned/shuffled below.
  } else {
    pl.hand.push(...picked);
  }

  // Energy-attach destinations (attack-driven deck searches): pull picked
  // Energy cards back out of the hand and route them onto Pokémon in play.
  if (pick.attachToInstanceId || pick.attachAll) {
    const allies = [pl.active, ...pl.bench].filter((p): p is import("./types").PokemonInPlay => !!p);
    const target = pick.attachToInstanceId
      ? allies.find((a) => a.instanceId === pick.attachToInstanceId)
      : null;
    let i = 0;
    for (const c of picked) {
      if (c.supertype !== "Energy") continue;
      const hi = pl.hand.lastIndexOf(c);
      if (hi < 0) continue;
      pl.hand.splice(hi, 1);
      if (target) {
        target.attachedEnergy.push(c as import("./types").EnergyCard);
      } else if (pick.attachAll && allies.length > 0) {
        allies[i % allies.length].attachedEnergy.push(c as import("./types").EnergyCard);
        i++;
      } else {
        // Fallback: stays in hand.
        pl.hand.push(c);
      }
    }
  }

  switch (pick.unpicked) {
    case "shuffleIntoDeck":
      pl.deck.push(...unpicked);
      shuffleDeck(state, player);
      break;
    case "bottomOfDeck":
      pl.deck.push(...unpicked);
      break;
    case "topOfDeck":
      pl.deck.unshift(...unpicked);
      break;
    case "discard":
      pl.discard.push(...unpicked);
      break;
    case "returnToDiscard":
      pl.discard.push(...unpicked);
      break;
  }

  if (pick.pickedDestination === "topOfDeck" && picked.length > 0) {
    pl.deck.unshift(...picked);
  }

  if (picked.length) {
    logEvent(state, player, `picks ${picked.map((c) => c.name).join(", ")}.`);
  } else {
    logEvent(state, player, "picks nothing.");
  }

  // Salvatore-style: picked Evolution Pokémon go straight onto a matching
  // ally instead of into hand. Run this BEFORE the bench branch so a
  // search-result that evolves a Pokémon doesn't accidentally also flow
  // through the bench placement.
  if (pick.toEvolve && picked.length > 0) {
    for (const c of picked) {
      if (c.supertype !== "Pokémon") continue;
      const evoCard = c as import("./types").PokemonCard;
      if (!evoCard.evolvesFrom) continue;
      const hi = pl.hand.lastIndexOf(c);
      if (hi < 0) continue;
      // Find an eligible ally — must match name AND not have been played
      // this turn. Active first, then bench by index (deterministic when
      // multiple allies match).
      const candidates = [pl.active, ...pl.bench].filter(
        (p): p is import("./types").PokemonInPlay => !!p,
      );
      const ally = candidates.find(
        (p) => p.card.name === evoCard.evolvesFrom && !p.playedThisTurn,
      );
      if (!ally) {
        // Picked card stays in hand — defensive fallback if no eligible
        // ally exists (rare since the predicate filters for this).
        continue;
      }
      pl.hand.splice(hi, 1);
      ally.evolvedFrom.push(ally.card);
      ally.card = evoCard;
      applyEvolveSideEffects(state, ally);
      logEvent(state, player, `evolves ${ally.card.name}.`);
      fireTriggeredOnEvolve(state, player, ally);
    }
  }

  // Pokémon from the pick go to hand by default. A few effects instead bench
  // them directly (Nest Ball, Buddy-Buddy Poffin, Hop's Bag, Lumiose City).
  // Newly benched Pokémon fire any triggered-on-bench abilities.
  const benchedFromPick: import("./types").PokemonInPlay[] = [];
  if (pick.toBench && picked.length > 0) {
    for (const c of picked) {
      if (c.supertype !== "Pokémon") continue;
      // Cards are moved to hand by the block above; pull them back out.
      const hi = pl.hand.lastIndexOf(c);
      if (hi < 0) continue;
      pl.hand.splice(hi, 1);
      if (pl.bench.length >= 5) {
        // No open slot — the card stays in hand as a pragmatic fallback.
        pl.hand.push(c);
        logEvent(state, player, `${c.name} stays in hand (bench is full).`);
        continue;
      }
      const inPlay = makePokemonInPlay(c);
      inPlay.playedThisTurn = true;
      pl.bench.push(inPlay);
      benchedFromPick.push(inPlay);
      logEvent(state, player, `benches ${c.name}.`);
    }
  }

  const shouldEndTurn = pick.endTurnOnResolve === true;
  const chain = pick.postResolveChain;
  const afterPick = pick.afterPick;
  state.pendingPick = null;
  state.phase = "main";
  // Fire triggered-on-bench abilities *after* clearing pendingPick so any
  // ability that opens its own pendingPick (e.g. Last-Ditch Catch) takes hold.
  for (const p of benchedFromPick) fireTriggeredOnBench(state, player, p);
  // Chained multi-stage search (Dawn Basic → Stage 1 → Stage 2). Runs after
  // the current pool is returned/shuffled so the next stage's predicate
  // searches the freshly-updated deck.
  if (chain) applyChainStep(state, player, chain);
  if (afterPick) applyAfterPick(state, player, afterPick, picked);
  if (shouldEndTurn) endTurnRule(state);
  return ok;
}
