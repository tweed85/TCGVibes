// Persistence helpers for user-authored data (imported decks).
//
// Why IndexedDB instead of localStorage: on iOS WebView, localStorage is
// subject to cleanup under storage pressure and has a hard ~5MB cap. A user
// with many imported decks (each up to ~3KB of decklist JSON) could hit
// either limit. IndexedDB has higher quotas and is the recommended modern
// store for app data.
//
// idb-keyval gives us a tiny (~600B gzipped) Promise-based key/value API
// over IDB without forcing us to write our own object-store boilerplate.
// Settings stay in localStorage — they're 100 bytes and need synchronous
// init before the first render.

import { get, set } from "idb-keyval";
import type { DeckListEntry } from "./decklistParser";
import type { GameReplayV2 } from "../engine/replay";

export interface PersistedImport {
  id: string;
  name: string;
  entries: DeckListEntry[];
}

/** A single replay row stored locally. Lives parallel to the live
 *  `replayRef` in App.tsx — finalized replays land here at game end. */
export interface StoredReplay {
  /** uuid v4 generated at save time. Stable across upload retries. */
  localId: string;
  replay: GameReplayV2;
  uploaded: boolean;
  uploadedAt?: string;
  /** Supabase row id when uploaded. */
  remoteId?: string;
  /** Last upload failure reason; cleared on the next successful attempt. */
  uploadError?: string;
  uploadAttemptedAt?: string;
}

const IDB_KEY = "tcgvibes.imports";
const REPLAYS_IDB_KEY = "tcgvibes.replays.v1";
// Old localStorage key kept for one-time migration on first IDB load.
const LEGACY_LOCALSTORAGE_KEY = "tcgvibes.imports.v1";

export async function loadImportedDecks(): Promise<PersistedImport[]> {
  const fromIdb = await get<PersistedImport[]>(IDB_KEY);
  if (fromIdb && Array.isArray(fromIdb)) return fromIdb;
  // First run after upgrade — migrate any localStorage value into IDB so we
  // don't lose existing user decks. Drop the localStorage entry once
  // migrated to keep the source of truth single.
  try {
    const raw = localStorage.getItem(LEGACY_LOCALSTORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PersistedImport[];
      if (Array.isArray(parsed)) {
        await set(IDB_KEY, parsed);
        localStorage.removeItem(LEGACY_LOCALSTORAGE_KEY);
        return parsed;
      }
    }
  } catch {
    // Ignore — corrupted legacy data shouldn't block IDB use.
  }
  return [];
}

export async function saveImportedDecks(imports: PersistedImport[]): Promise<void> {
  try {
    await set(IDB_KEY, imports);
  } catch {
    // Storage quota or transient IDB error — fall through silently. The
    // in-memory imports list is still authoritative for this session.
  }
}

// ---- Replay persistence ----------------------------------------------------
//
// Replays land in IDB at game end via the App's outcome useEffect. The whole
// list is read/written as one array because typical users will have ≤100
// rows and idb-keyval doesn't expose an object-store API anyway. If volume
// ever grows past a few MB we'd swap to a per-row key scheme — `tcgvibes.
// replays.v1` is intentionally suffixed so a future schema bump can land
// at `tcgvibes.replays.v2` without mutating v1 in place.

export async function loadReplays(): Promise<StoredReplay[]> {
  const stored = await get<StoredReplay[]>(REPLAYS_IDB_KEY);
  if (stored && Array.isArray(stored)) return stored;
  return [];
}

export async function saveReplay(replay: StoredReplay): Promise<void> {
  try {
    const existing = await loadReplays();
    // Replace if the same localId is already present (idempotent for retries),
    // otherwise prepend so the newest row sorts first by default.
    const filtered = existing.filter((r) => r.localId !== replay.localId);
    await set(REPLAYS_IDB_KEY, [replay, ...filtered]);
  } catch {
    // Storage quota or transient IDB error — fall through silently.
  }
}

export async function deleteReplay(localId: string): Promise<void> {
  try {
    const existing = await loadReplays();
    const filtered = existing.filter((r) => r.localId !== localId);
    await set(REPLAYS_IDB_KEY, filtered);
  } catch {
    // Same fall-through.
  }
}

/** Mark a replay row as uploaded with its server-assigned remote id. The
 *  caller is responsible for handing in a fresh `now` ISO string for
 *  `uploadedAt` so a deterministic test can fix the value. */
export async function markReplayUploaded(
  localId: string,
  remoteId: string,
  now: string = new Date().toISOString(),
): Promise<void> {
  try {
    const existing = await loadReplays();
    const updated = existing.map((r) =>
      r.localId === localId
        ? {
            ...r,
            uploaded: true,
            uploadedAt: now,
            remoteId,
            // Clear any prior failure so the UI no longer surfaces it.
            uploadError: undefined,
          }
        : r,
    );
    await set(REPLAYS_IDB_KEY, updated);
  } catch {
    // Same fall-through.
  }
}

/** Record a failed upload attempt on a row. Doesn't flip `uploaded`;
 *  leaves the row available for the manual retry button. */
export async function markReplayUploadError(
  localId: string,
  error: string,
  now: string = new Date().toISOString(),
): Promise<void> {
  try {
    const existing = await loadReplays();
    const updated = existing.map((r) =>
      r.localId === localId
        ? { ...r, uploadError: error, uploadAttemptedAt: now }
        : r,
    );
    await set(REPLAYS_IDB_KEY, updated);
  } catch {
    // Same fall-through.
  }
}
