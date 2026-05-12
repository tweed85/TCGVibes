// Anonymous device-scoped client ID. Generated once on first run, persisted
// to localStorage, used as the only correlation key for cloud-uploaded
// replays. No PII, no login.
//
// Lives parallel to `tcgvibes.settings.v1` (also synchronous via
// localStorage) so the identity is available the same render the
// outcome-finalize effect first fires; no async race vs game-end.
//
// On reinstall the id is lost — that's fine for v1. A user who wants
// stable identity across devices needs the future sign-in flow (out of
// scope; documented in docs/REPLAY.md cloud section).

const STORAGE_KEY = "tcgvibes.clientId.v1";

/** Read the persisted client id, generating + saving a fresh one if absent.
 *  Synchronous — callers can rely on the return value during render. */
export function getOrCreateClientId(): string {
  // Defensive: localStorage may be unavailable in unusual sandboxes
  // (Capacitor WebView with private mode, certain test runners). Fall
  // back to a fresh per-call uuid so callers don't crash; they just lose
  // cross-session correlation, which is acceptable for v1.
  if (typeof localStorage === "undefined") return generateId();
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing && isUuidLike(existing)) return existing;
    const fresh = generateId();
    localStorage.setItem(STORAGE_KEY, fresh);
    return fresh;
  } catch {
    return generateId();
  }
}

function generateId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID. Not cryptographic
  // — that's fine; the id is a correlation token, not a secret.
  const r = () => Math.random().toString(16).slice(2, 10);
  return `${r()}${r()}-${r().slice(0, 4)}-4${r().slice(0, 3)}-${r().slice(0, 4)}-${r()}${r().slice(0, 4)}`;
}

function isUuidLike(s: string): boolean {
  // Permissive: accept the canonical 8-4-4-4-12 hex shape OR our fallback
  // (which is the same shape). Rejects junk like "" or "undefined".
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
