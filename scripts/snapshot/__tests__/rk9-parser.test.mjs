// Unit tests for the RK9 pairings parser. Runs against captured fixture HTML
// from a real Prague Regional 2026 fetch so the regex assertions catch any
// future site-template changes.
//
// Fixtures:
//   __fixtures__/standings.html      — P2-standings panel from the static page
//   __fixtures__/round-finals.html   — round-17 (finals) inline pairing

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverRounds,
  extractName,
  extractRecord,
  extractTable,
  parsePairingRow,
  parseRound,
  parseStandings,
} from "../rk9-parser.mjs";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const standingsHtml = readFileSync(join(FIXTURE_DIR, "standings.html"), "utf8");
const finalsHtml = readFileSync(join(FIXTURE_DIR, "round-finals.html"), "utf8");

describe("rk9-parser", () => {
  describe("extractName", () => {
    it("splits 'First<br> Last [CC]<br>' into name + country", () => {
      const { name, country } = extractName(
        '<span class="name">Mateusz<br> Łaszkiewicz [PL]<br></span>',
      );
      expect(name).toBe("Mateusz Łaszkiewicz");
      expect(country).toBe("PL");
    });

    it("returns empty when no <span class=\"name\"> present (bye / empty player slot)", () => {
      const { name, country } = extractName(
        '<div class="col-5 text-center player player2"></div>',
      );
      expect(name).toBe("");
      expect(country).toBeUndefined();
    });

    it("handles all-caps names like ULADZIMIR MAZALEUSKI", () => {
      const { name, country } = extractName(
        '<span class="name">ULADZIMIR<br> MAZALEUSKI [PL]<br></span>',
      );
      expect(name).toBe("ULADZIMIR MAZALEUSKI");
      expect(country).toBe("PL");
    });
  });

  describe("extractRecord", () => {
    it("parses '(W-L-T)' tuples", () => {
      expect(extractRecord("Mateusz<br> Łaszkiewicz [PL]<br></span> (14-1-2) <br>")).toEqual({
        wins: 14,
        losses: 1,
        ties: 2,
      });
    });

    it("returns undefined when no record present", () => {
      expect(extractRecord("just a name")).toBeUndefined();
    });
  });

  describe("extractTable", () => {
    it("parses the inner <span class=\"tablenumber\"> value", () => {
      expect(extractTable('<span class="tablenumber "> 201 </span>')).toBe(201);
    });

    it("returns null when no table number (Day 1 unseeded rounds)", () => {
      expect(extractTable("<span>no number</span>")).toBeNull();
    });
  });

  describe("parsePairingRow", () => {
    it("extracts both players + table + result from a completed round", () => {
      const sampleRow =
        '<div class="row row-cols-3 match no-gutter complete">' +
        '<div id="cell-2-17-201-1" class="col-5 text-center player player1 loser"><span class="name">Elmar<br> Tresp [DE]<br></span> (13-3-1) <br></div>' +
        '<div id="cell-2-17-201-3" class="col-2 text-center"> Table<br><span class="tablenumber "> 201 </span><br></div>' +
        '<div id="cell-2-17-201-2" class="col-5 text-center player player2 winner"><span class="name">Mateusz<br> Łaszkiewicz [PL]<br></span> (14-1-2) <br></div>' +
        "</div>";
      const row = parsePairingRow(sampleRow);
      expect(row).not.toBeNull();
      expect(row.table).toBe(201);
      expect(row.player1.name).toBe("Elmar Tresp");
      expect(row.player1.country).toBe("DE");
      expect(row.player1.loser).toBe(true);
      expect(row.player1.winner).toBe(false);
      expect(row.player2.name).toBe("Mateusz Łaszkiewicz");
      expect(row.player2.winner).toBe(true);
      // From player1's perspective: opponent won → result = "loss"
      expect(row.result).toBe("loss");
    });

    it("flags 'bye' when player2 is empty", () => {
      const byeRow =
        '<div class="row row-cols-3 match no-gutter complete">' +
        '<div class="col-5 player player1 winner"><span class="name">Solo<br> Player [US]<br></span> (1-0-0) <br></div>' +
        '<div class="col-2 text-center"></div>' +
        '<div class="col-5 player player2"></div>' +
        "</div>";
      const row = parsePairingRow(byeRow);
      expect(row.result).toBe("bye");
      expect(row.player2.name).toBe("");
    });
  });

  describe("parseRound (against finals fixture)", () => {
    it("parses the Prague finals (Mateusz beat Elmar at table 201)", () => {
      const pairings = parseRound(finalsHtml);
      expect(pairings.length).toBeGreaterThanOrEqual(1);
      const finals = pairings.find((p) => p.table === 201);
      expect(finals).toBeDefined();
      expect(finals.player1.name).toBe("Elmar Tresp");
      expect(finals.player2.name).toBe("Mateusz Łaszkiewicz");
      // Mateusz won → from player1 perspective = loss
      expect(finals.result).toBe("loss");
      expect(finals.player2.winner).toBe(true);
    });
  });

  describe("parseStandings (against fixture)", () => {
    it("parses 1,300+ finishers from the Prague Masters standings panel", () => {
      const standings = parseStandings(standingsHtml, 2);
      // Prague had 1,723 Masters entries total but standings only list
      // finishers (~1,367 after drops). Allow a wide range.
      expect(standings.length).toBeGreaterThan(1000);
    });

    it("identifies Mateusz Łaszkiewicz as 1st place [PL]", () => {
      const standings = parseStandings(standingsHtml, 2);
      const first = standings.find((s) => s.finish === 1);
      expect(first).toBeDefined();
      expect(first.name).toBe("Mateusz Łaszkiewicz");
      expect(first.country).toBe("PL");
    });

    it("identifies Elmar Tresp as 2nd, Neddy Kosek as 3rd, João Pires as 4th", () => {
      const standings = parseStandings(standingsHtml, 2);
      expect(standings.find((s) => s.finish === 2).name).toBe("Elmar Tresp");
      expect(standings.find((s) => s.finish === 3).name).toBe("Neddy Kosek");
      expect(standings.find((s) => s.finish === 4).name).toBe("João Pires");
    });

    it("country codes are valid ISO 3166-1 alpha-2 (or RK9 vendor-specific like UK/IM)", () => {
      const standings = parseStandings(standingsHtml, 2);
      for (const s of standings) {
        expect(/^[A-Z]{2}$/.test(s.country), `country "${s.country}" not 2-letter`).toBe(true);
      }
    });

    it("standings are sorted ascending by finish", () => {
      const standings = parseStandings(standingsHtml, 2);
      for (let i = 1; i < standings.length; i++) {
        expect(standings[i].finish).toBeGreaterThanOrEqual(standings[i - 1].finish);
      }
    });
  });

  describe("discoverRounds", () => {
    it("finds all 17 Masters rounds from a fixture-like static-HTML snippet", () => {
      // Synthesize a small static-HTML snippet that includes all 17 round
      // tabs + hx-get URLs for rounds 1-16 (round 17 is inlined w/o hx-get).
      const snippet = Array.from({ length: 17 }, (_, i) => i + 1)
        .map((n) => `<a id="P2R${n}-tab"></a>`)
        .join("") +
        Array.from({ length: 16 }, (_, i) => i + 1)
          .map((n) => `<div hx-get="/pairings/X?pod=2&rnd=${n}"></div>`)
          .join("");
      const rounds = discoverRounds(snippet, 2);
      expect(rounds).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
    });

    it("returns empty array when pod has no round tabs", () => {
      expect(discoverRounds('<div id="P2R1-tab"></div>', 9)).toEqual([]);
    });
  });
});
