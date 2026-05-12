// Central registry of AI / MCTS tunable constants. Sourced from ai.ts and
// mcts.ts at the locations noted; this module is the parity-first
// extraction point so future tuning lives in one place. Changes here are
// load-bearing — validate with aiDecisionQuality.test.ts (49 scenarios)
// and aiBenchmark.test.ts before landing.

// --- MCTS defaults (moved from mcts.ts:280-283) ---------------------------

// Default per-search wall-clock budget. Per-player override lives on
// PlayerState.mctsBudgetMs; this is the fallback when no override is set.
export const MCTS_DEFAULT_BUDGET_MS = 5000;
// UCB1 exploration constant. Tuned for prize-scaled leaf values (game-win
// = ±1,000,000), not the textbook √2 / 1.41 used for [0,1] rewards.
export const MCTS_EXPLORATION_C = 350;
// Rollout depth in turn pairs (each pair = one full P1+P2 cycle).
export const MCTS_ROLLOUT_DEPTH_TURNS = 2;
// Progressive-widening cap on actions expanded at each tree node.
export const MCTS_TOP_K = 8;

// --- Gust target selection (moved from ai.ts:945-954) ---------------------

export const GUST_MIN_SCORE = 120;
export const GUST_KO_BASE = 150;
export const GUST_KO_PRIZE_MULTIPLIER = 60;
export const GUST_GAIN_KO_BONUS = 80;
export const GUST_HIGHER_PRIZE_BONUS = 50;
export const GUST_ACTIVE_KO_DISCOUNT = 100;
export const GUST_GAME_WIN_BONUS = 10000;
export const GUST_FUTURE_THREAT_MIN_DAMAGE = 120;
export const GUST_FUTURE_THREAT_MULTIPLIER = 1.25;
export const GUST_PROTECTED_TARGET_PENALTY = 10000;

// --- Candidate generator scoring (moved from ai.ts:2172) ------------------

// Each priority band gets CANDIDATE_BAND points of headroom for the
// per-category localScore (final = priority * CANDIDATE_BAND + localScore).
// Keep ≥ the max localScore any generator can emit, or band ordering breaks.
export const CANDIDATE_BAND = 10_000;

// --- scorePosition load-bearing weights (moved from ai.ts:3429-3432) ------
// Drive the v2 threat-aware leaf eval responsible for the measured +12.5pp
// v2+MCTS win-rate edge over v1. Change only with benchmark evidence.

export const ACTIVE_OHKO_BASE_PENALTY = 60;
export const ACTIVE_OHKO_PRIZE_PENALTY = 80;
export const OPP_ACTIVE_OHKO_BASE_BONUS = 50;
export const OPP_ACTIVE_OHKO_PRIZE_BONUS = 60;

// --- Phase 2B threat / readiness overlays (moved from ai.ts:3439-3443) ----
// Additive v2 overlays on top of the OHKO weights above. Smaller magnitudes
// — they tune prize-pressure context and immediate attack options on top
// of the raw threat detection. Benchmark coverage at PR boundary.

export const ACTIVE_OHKO_GAME_LOSING_PENALTY = 150;
export const ACTIVE_OHKO_BENCH_COUNTER_MITIGATION = 30;
export const OPP_ACTIVE_GAME_WINNING_BONUS = 200;
export const ACTIVE_CAN_ATTACK_NOW_BONUS = 15;
export const EVOLUTION_IN_HAND_UNLOCK_BONUS = 10;

// --- Grouped view ---------------------------------------------------------
// Convenience object grouping the same constants by domain. Read-sites in
// ai.ts / mcts.ts use the named exports above (identifier-stable); this
// grouped object is the canonical surface for future tuning sweeps and
// debug overlays. Don't enable MCTS by default — runtime selection lives
// on PlayerState.aiVersion / PlayerState.mctsBudgetMs.

export const AI_CONFIG = {
  mcts: {
    defaultBudgetMs: MCTS_DEFAULT_BUDGET_MS,
    explorationC: MCTS_EXPLORATION_C,
    rolloutDepthTurns: MCTS_ROLLOUT_DEPTH_TURNS,
    topK: MCTS_TOP_K,
  },
  gust: {
    minScore: GUST_MIN_SCORE,
    koBase: GUST_KO_BASE,
    koPrizeMultiplier: GUST_KO_PRIZE_MULTIPLIER,
    gainKoBonus: GUST_GAIN_KO_BONUS,
    higherPrizeBonus: GUST_HIGHER_PRIZE_BONUS,
    activeKoDiscount: GUST_ACTIVE_KO_DISCOUNT,
    gameWinBonus: GUST_GAME_WIN_BONUS,
    futureThreatMinDamage: GUST_FUTURE_THREAT_MIN_DAMAGE,
    futureThreatMultiplier: GUST_FUTURE_THREAT_MULTIPLIER,
    protectedTargetPenalty: GUST_PROTECTED_TARGET_PENALTY,
  },
  candidates: {
    band: CANDIDATE_BAND,
  },
  scoring: {
    activeOhkoBasePenalty: ACTIVE_OHKO_BASE_PENALTY,
    activeOhkoPrizePenalty: ACTIVE_OHKO_PRIZE_PENALTY,
    oppActiveOhkoBaseBonus: OPP_ACTIVE_OHKO_BASE_BONUS,
    oppActiveOhkoPrizeBonus: OPP_ACTIVE_OHKO_PRIZE_BONUS,
    activeOhkoGameLosingPenalty: ACTIVE_OHKO_GAME_LOSING_PENALTY,
    activeOhkoBenchCounterMitigation: ACTIVE_OHKO_BENCH_COUNTER_MITIGATION,
    oppActiveGameWinningBonus: OPP_ACTIVE_GAME_WINNING_BONUS,
    activeCanAttackNowBonus: ACTIVE_CAN_ATTACK_NOW_BONUS,
    evolutionInHandUnlockBonus: EVOLUTION_IN_HAND_UNLOCK_BONUS,
  },
  debugMode: false,
} as const;
