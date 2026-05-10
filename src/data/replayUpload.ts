// Cloud replay upload — Supabase client wrapper. Lazy-loads
// @supabase/supabase-js so the dep doesn't land in the boot bundle for
// users who never opt in to cloud upload (verify post-build by inspecting
// `dist/assets/` for a separate chunk).
//
// Reads VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY from env. .env.local
// is gitignored; .env.example shows the required keys. If env vars are
// missing the upload short-circuits with a clear failure rather than
// crashing — keeps local dev painless.
//
// Privacy / payload contract:
//   What gets uploaded: the StoredReplay's full GameReplayV2 (decklist
//   card IDs, command stream, outcome, app/data version), the anonymous
//   client_id, and a few extracted fields (winner, game_mode,
//   p1/p2_archetype if detected, turn_count) for indexable queries.
//   What does NOT: deck names, user names, IP addresses (Supabase is
//   instructed not to log via project settings), any sign-in token —
//   there's no auth in v1.

import type { StoredReplay } from "./persistence";
import type { GameReplayV2 } from "../engine/replay";

const MAX_REPLAY_BYTES = 200_000;

export type UploadResult =
  | { ok: true; remoteId: string }
  | { ok: false; reason: string };

interface UploadDeps {
  /** Optional injection seam for tests — replaces the dynamic import of
   *  @supabase/supabase-js. Production callers omit this and the module
   *  is dynamically imported on first use. */
  loadSupabase?: () => Promise<typeof import("@supabase/supabase-js")>;
  /** Optional injection seam for env vars; production reads from
   *  import.meta.env. */
  env?: { url: string | undefined; anonKey: string | undefined };
}

let cachedClient: import("@supabase/supabase-js").SupabaseClient | null = null;

async function getClient(
  deps: UploadDeps,
): Promise<import("@supabase/supabase-js").SupabaseClient | null> {
  if (cachedClient) return cachedClient;
  const env = deps.env ?? {
    url: import.meta.env.VITE_SUPABASE_URL,
    anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
  };
  if (!env.url || !env.anonKey) return null;
  const mod = deps.loadSupabase
    ? await deps.loadSupabase()
    : await import("@supabase/supabase-js");
  cachedClient = mod.createClient(env.url, env.anonKey, {
    auth: { persistSession: false },
  });
  return cachedClient;
}

/** Best-effort archetype labels extracted from the replay's command stream
 *  + decklist. v1 is intentionally minimal — the offline ETL re-runs
 *  detection if needed. Returning null is fine; the column is nullable. */
function extractArchetypeHints(_replay: GameReplayV2): {
  p1: string | null;
  p2: string | null;
} {
  // Placeholder: real detection lives in src/engine/aiArchetype.ts. Wiring
  // it here would pull a lot of engine deps into the upload path; the ETL
  // does the heavy lifting. Leaving null keeps payloads honest.
  return { p1: null, p2: null };
}

/** Number of player turns played, derived from the command stream. Useful
 *  filter for "interesting" games at training time. */
function countTurns(replay: GameReplayV2): number {
  return replay.commands.filter((c) => c.kind === "endTurn").length;
}

export async function uploadReplay(
  stored: StoredReplay,
  clientId: string,
  deps: UploadDeps = {},
): Promise<UploadResult> {
  const replay = stored.replay;
  if (!replay.outcome) {
    return { ok: false, reason: "Replay has no outcome (game didn't finish)." };
  }
  // Client-side size guard — server has a matching CHECK constraint, but
  // failing here saves a request when we already know the row will reject.
  const json = JSON.stringify(replay);
  if (json.length > MAX_REPLAY_BYTES) {
    return { ok: false, reason: "Replay too large (>200KB)." };
  }
  const client = await getClient(deps);
  if (!client) {
    return {
      ok: false,
      reason: "Cloud upload not configured (missing VITE_SUPABASE_URL / ANON_KEY).",
    };
  }
  const archetypes = extractArchetypeHints(replay);
  const row = {
    client_id: clientId,
    schema_version: replay.schemaVersion,
    app_version: replay.appVersion,
    data_version: replay.dataVersion,
    created_at: replay.createdAt,
    completed_at: replay.outcome.completedAt,
    winner: replay.outcome.winner,
    game_mode: replay.outcome.gameMode,
    p1_archetype: archetypes.p1,
    p2_archetype: archetypes.p2,
    turn_count: countTurns(replay),
    replay,
  };
  const { data, error } = await client
    .from("replays")
    .insert(row)
    .select("id")
    .single();
  if (error || !data) {
    return {
      ok: false,
      reason: error?.message ?? "Upload failed (no row returned).",
    };
  }
  return { ok: true, remoteId: data.id as string };
}

// Test-only: reset the cached client so tests can inject a fresh stub.
export function _resetClientForTests(): void {
  cachedClient = null;
}
