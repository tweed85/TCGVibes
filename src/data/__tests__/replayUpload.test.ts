// @vitest-environment jsdom
//
// Cloud replay upload — Supabase client is lazy-loaded via dynamic import.
// Tests inject a stub through the `loadSupabase` dep so we never hit the
// network or even resolve the real package.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetClientForTests,
  uploadReplay,
  type UploadResult,
} from "../replayUpload";
import type { StoredReplay } from "../persistence";
import type { GameReplayV2 } from "../../engine/replay";

function mkStored(overrides: Partial<StoredReplay> = {}): StoredReplay {
  const replay: GameReplayV2 = {
    schemaVersion: 2,
    appVersion: "0.0.1",
    dataVersion: "2026-05-09",
    createdAt: "2026-05-09T12:00:00.000Z",
    initial: { p1CardIds: [], p2CardIds: [], rngSeed: 1 },
    commands: [{ kind: "endTurn", player: "p1" }],
    outcome: {
      winner: "p1",
      completedAt: "2026-05-09T13:00:00.000Z",
      gameMode: "vsCPU",
    },
  };
  return { localId: "local-1", replay, uploaded: false, ...overrides };
}

function mkSupabaseStub(opts: {
  insertResult?: { data: { id: string } | null; error: { message: string } | null };
} = {}) {
  const insertCalls: unknown[] = [];
  const single = vi.fn(async () =>
    opts.insertResult ?? { data: { id: "remote-uuid" }, error: null },
  );
  const select = vi.fn(() => ({ single }));
  const insert = vi.fn((row: unknown) => {
    insertCalls.push(row);
    return { select };
  });
  const from = vi.fn((_table: string) => ({ insert }));
  const createClient = vi.fn(() => ({ from }));
  return {
    module: { createClient } as unknown as typeof import("@supabase/supabase-js"),
    insertCalls,
    single,
    select,
    insert,
    from,
    createClient,
  };
}

describe("uploadReplay", () => {
  beforeEach(() => {
    _resetClientForTests();
  });

  afterEach(() => {
    _resetClientForTests();
    vi.clearAllMocks();
  });

  it("happy path: returns ok with remoteId from the inserted row", async () => {
    const stub = mkSupabaseStub();
    const r: UploadResult = await uploadReplay(mkStored(), "client-uuid", {
      loadSupabase: async () => stub.module,
      env: { url: "https://x.supabase.co", anonKey: "anon" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.remoteId).toBe("remote-uuid");
    // Insert was called with the expected shape.
    expect(stub.insertCalls).toHaveLength(1);
    const row = stub.insertCalls[0] as Record<string, unknown>;
    expect(row.client_id).toBe("client-uuid");
    expect(row.schema_version).toBe(2);
    expect(row.winner).toBe("p1");
    expect(row.game_mode).toBe("vsCPU");
    expect(row.turn_count).toBe(1);
  });

  it("network / server error: returns ok=false with the error message", async () => {
    const stub = mkSupabaseStub({
      insertResult: { data: null, error: { message: "503 Service Unavailable" } },
    });
    const r = await uploadReplay(mkStored(), "client-uuid", {
      loadSupabase: async () => stub.module,
      env: { url: "https://x.supabase.co", anonKey: "anon" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("503 Service Unavailable");
  });

  it("oversize replay short-circuits before the network call", async () => {
    const stub = mkSupabaseStub();
    // Build a replay whose JSON exceeds 200KB. Padding the note field is
    // the cleanest way that still typechecks.
    const big = mkStored();
    big.replay = { ...big.replay, note: "x".repeat(200_001) };
    const r = await uploadReplay(big, "client-uuid", {
      loadSupabase: async () => stub.module,
      env: { url: "https://x.supabase.co", anonKey: "anon" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/too large/i);
    expect(stub.insert).not.toHaveBeenCalled();
  });

  it("missing env vars: returns ok=false with a clear reason (no crash)", async () => {
    const stub = mkSupabaseStub();
    const r = await uploadReplay(mkStored(), "client-uuid", {
      loadSupabase: async () => stub.module,
      env: { url: undefined, anonKey: undefined },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not configured/i);
    expect(stub.createClient).not.toHaveBeenCalled();
  });

  it("replay without outcome: returns ok=false (game didn't finish)", async () => {
    const stub = mkSupabaseStub();
    const noOutcome = mkStored();
    noOutcome.replay = { ...noOutcome.replay, outcome: undefined };
    const r = await uploadReplay(noOutcome, "client-uuid", {
      loadSupabase: async () => stub.module,
      env: { url: "https://x.supabase.co", anonKey: "anon" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no outcome/i);
    expect(stub.insert).not.toHaveBeenCalled();
  });
});
