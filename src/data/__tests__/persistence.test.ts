// @vitest-environment jsdom
//
// Persistence layer tests — round-trip saveReplay / loadReplays /
// deleteReplay / markReplayUploaded / markReplayUploadError. Mocks
// idb-keyval with a Map shim rather than pulling in fake-indexeddb,
// because the persistence layer's contract is just "key/value reads
// and writes" — the IDB implementation isn't what we're testing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock idb-keyval BEFORE the module-under-test imports it. The shim is a
// plain Map so we can deterministically assert what was written.
const store = new Map<string, unknown>();
vi.mock("idb-keyval", () => ({
  get: async (key: string) => store.get(key),
  set: async (key: string, value: unknown) => {
    store.set(key, value);
  },
}));

// Import after the mock so the real module receives the stubbed get/set.
import {
  deleteReplay,
  loadReplays,
  markReplayUploaded,
  markReplayUploadError,
  saveReplay,
  type StoredReplay,
} from "../persistence";
import type { GameReplayV2 } from "../../engine/replay";

function makeReplay(localId: string, overrides: Partial<StoredReplay> = {}): StoredReplay {
  const replay: GameReplayV2 = {
    schemaVersion: 2,
    appVersion: "0.0.1",
    dataVersion: "2026-05-09",
    createdAt: "2026-05-09T12:00:00.000Z",
    initial: { p1CardIds: [], p2CardIds: [], rngSeed: 1 },
    commands: [],
  };
  return {
    localId,
    replay,
    uploaded: false,
    ...overrides,
  };
}

describe("persistence — replay layer", () => {
  beforeEach(() => {
    store.clear();
  });

  afterEach(() => {
    store.clear();
  });

  it("loadReplays returns [] when nothing is stored", async () => {
    expect(await loadReplays()).toEqual([]);
  });

  it("saveReplay then loadReplays round-trips", async () => {
    const r = makeReplay("a");
    await saveReplay(r);
    const got = await loadReplays();
    expect(got).toHaveLength(1);
    expect(got[0].localId).toBe("a");
  });

  it("saveReplay with an existing localId replaces (idempotent)", async () => {
    await saveReplay(makeReplay("a", { uploaded: false }));
    await saveReplay(makeReplay("a", { uploaded: true }));
    const got = await loadReplays();
    expect(got).toHaveLength(1);
    expect(got[0].uploaded).toBe(true);
  });

  it("saveReplay prepends new rows so newest sorts first", async () => {
    await saveReplay(makeReplay("first"));
    await saveReplay(makeReplay("second"));
    const got = await loadReplays();
    expect(got.map((r) => r.localId)).toEqual(["second", "first"]);
  });

  it("deleteReplay removes the matching row, leaves others", async () => {
    await saveReplay(makeReplay("a"));
    await saveReplay(makeReplay("b"));
    await deleteReplay("a");
    const got = await loadReplays();
    expect(got.map((r) => r.localId)).toEqual(["b"]);
  });

  it("deleteReplay on a missing id is a no-op", async () => {
    await saveReplay(makeReplay("a"));
    await deleteReplay("nonexistent");
    const got = await loadReplays();
    expect(got.map((r) => r.localId)).toEqual(["a"]);
  });

  it("markReplayUploaded flips uploaded=true and stamps remoteId + uploadedAt", async () => {
    await saveReplay(makeReplay("a"));
    await markReplayUploaded("a", "remote-123", "2026-05-09T13:00:00.000Z");
    const [row] = await loadReplays();
    expect(row.uploaded).toBe(true);
    expect(row.remoteId).toBe("remote-123");
    expect(row.uploadedAt).toBe("2026-05-09T13:00:00.000Z");
    expect(row.uploadError).toBeUndefined();
  });

  it("markReplayUploaded clears any prior uploadError", async () => {
    await saveReplay(makeReplay("a", { uploadError: "503", uploadAttemptedAt: "earlier" }));
    await markReplayUploaded("a", "remote-1", "now");
    const [row] = await loadReplays();
    expect(row.uploadError).toBeUndefined();
  });

  it("markReplayUploadError records the failure without flipping uploaded", async () => {
    await saveReplay(makeReplay("a"));
    await markReplayUploadError("a", "Network error", "2026-05-09T14:00:00.000Z");
    const [row] = await loadReplays();
    expect(row.uploaded).toBe(false);
    expect(row.uploadError).toBe("Network error");
    expect(row.uploadAttemptedAt).toBe("2026-05-09T14:00:00.000Z");
  });
});
