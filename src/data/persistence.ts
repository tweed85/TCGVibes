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

export interface PersistedImport {
  id: string;
  name: string;
  entries: DeckListEntry[];
}

const IDB_KEY = "tcgvibes.imports";
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
