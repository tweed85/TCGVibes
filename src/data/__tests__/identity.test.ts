// @vitest-environment jsdom
//
// Identity helper — generates + persists an anonymous device-scoped uuid.
// Lives in localStorage parallel to `tcgvibes.settings.v1` so it's
// synchronously available at boot.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Vitest 4 + jsdom 29 ships a localStorage stub without setItem/getItem
// methods. Provide a real Map-backed Storage shim before the module-under-
// test imports. (App.tsx works in production because the browser provides
// the real Storage.)
const fakeStorage = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => {
      m.set(k, String(v));
    },
    removeItem: (k: string) => {
      m.delete(k);
    },
    clear: () => {
      m.clear();
    },
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    get length() {
      return m.size;
    },
    _map: m,
  };
})();
vi.stubGlobal("localStorage", fakeStorage);

import { getOrCreateClientId } from "../identity";

const KEY = "tcgvibes.clientId.v1";

describe("getOrCreateClientId", () => {
  beforeEach(() => {
    fakeStorage._map.clear();
  });

  afterEach(() => {
    fakeStorage._map.clear();
  });

  it("generates and persists a uuid on first call", () => {
    expect(localStorage.getItem(KEY)).toBeNull();
    const id = getOrCreateClientId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(localStorage.getItem(KEY)).toBe(id);
  });

  it("returns the same id on subsequent calls (stable across renders)", () => {
    const a = getOrCreateClientId();
    const b = getOrCreateClientId();
    expect(a).toBe(b);
  });

  it("ignores junk values in localStorage and regenerates", () => {
    localStorage.setItem(KEY, "not a uuid");
    const id = getOrCreateClientId();
    expect(id).not.toBe("not a uuid");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    // The junk value was overwritten with the fresh id.
    expect(localStorage.getItem(KEY)).toBe(id);
  });
});
