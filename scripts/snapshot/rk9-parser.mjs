// Pure parsing functions for RK9 pairings HTML. Separated from the fetcher
// so they're testable in isolation against captured fixture HTML.

// RK9 returns name fields like "First<br> Last [CC]<br>" — split on <br>,
// strip [CC] suffix, trim, then re-join. Country tag extracted separately.
export function extractName(html) {
  const m = html.match(/<span class="name">([\s\S]*?)<\/span>/);
  if (!m) return { name: "", country: undefined };
  const inner = m[1].replace(/<br\s*\/?>/gi, " ").replace(/\s+/g, " ").trim();
  const cMatch = inner.match(/\[([A-Z]{2})\]\s*$/);
  const country = cMatch ? cMatch[1] : undefined;
  const name = inner.replace(/\s*\[[A-Z]{2}\]\s*$/, "").trim();
  return { name, country };
}

// "(W-L-T)" record after a player's name. Optional.
export function extractRecord(html) {
  const m = html.match(/\((\d+)-(\d+)-(\d+)\)/);
  if (!m) return undefined;
  return { wins: +m[1], losses: +m[2], ties: +m[3] };
}

// Table number inside <span class="tablenumber">N</span>
export function extractTable(html) {
  const m = html.match(/<span class="tablenumber[^"]*">\s*(\d+)\s*<\/span>/);
  return m ? +m[1] : null;
}

// One pairing row spans `<div class="row row-cols-3 match ...">...</div>`.
// Inside, player1 is the first .col-5, player2 the second .col-5.
// "winner" or "loser" class on each col-5 indicates the result. A "complete"
// class on the outer row means the match has resolved; "incomplete" rows
// are skipped (mid-round live data).
export function parsePairingRow(rowHtml) {
  if (!rowHtml.includes('class="row row-cols-3 match')) return null;
  const complete = / complete\b/.test(rowHtml);
  // Split into player columns by the two col-5 divs.
  const colMatches = [...rowHtml.matchAll(/<div[^>]*class="col-5[^"]*"[^>]*>([\s\S]*?)<\/div>/g)];
  if (colMatches.length < 2) return null;
  const p1Html = colMatches[0][0];
  const p2Html = colMatches[1][0];
  const tableNumber = extractTable(rowHtml);
  const player1 = {
    ...extractName(p1Html),
    record: extractRecord(p1Html),
    winner: /\bwinner\b/.test(p1Html),
    loser: /\bloser\b/.test(p1Html),
  };
  const player2 = {
    ...extractName(p2Html),
    record: extractRecord(p2Html),
    winner: /\bwinner\b/.test(p2Html),
    loser: /\bloser\b/.test(p2Html),
  };
  // Result: "win" if p1 winner, "loss" if p1 loser, "tie" if neither
  // (both unmarked but match is complete), "bye" when player2 is empty.
  let result = "incomplete";
  if (complete) {
    if (!player2.name) result = "bye";
    else if (player1.winner) result = "win";
    else if (player1.loser) result = "loss";
    else result = "tie";
  }
  return { table: tableNumber, player1, player2, result };
}

export function parseRound(html) {
  const fragments = html.split(/(?=<div class="row row-cols-3 match)/);
  const rows = [];
  for (const frag of fragments) {
    if (!frag.startsWith('<div class="row row-cols-3 match')) continue;
    const row = parsePairingRow(frag);
    if (row) rows.push(row);
  }
  return rows;
}

// Discover available rounds from the static page. Two signals:
//   - `id="P{pod}R{n}-tab"` markers (every round tab the UI renders)
//   - `hx-get="?pod=X&rnd=N"` URLs (lazy-loaded rounds)
// The tab IDs are the source of truth — RK9 inlines some rounds (finals)
// directly in the static HTML without an hx-get URL, so the hx-get sweep
// alone would miss them.
export function discoverRounds(staticHtml, pod = 2) {
  const rounds = new Set();
  const tabRx = new RegExp(`id="P${pod}R(\\d+)-tab"`, "g");
  for (const m of staticHtml.matchAll(tabRx)) rounds.add(+m[1]);
  const hxRx = new RegExp(`hx-get="/pairings/[^"]+\\?pod=${pod}&rnd=(\\d+)"`, "g");
  for (const m of staticHtml.matchAll(hxRx)) rounds.add(+m[1]);
  return [...rounds].sort((a, b) => a - b);
}

// For rounds inlined directly in the static HTML (typically the finals),
// extract the pairings out of the round's tab-pane. Returns null if the
// round isn't found inline.
export function extractInlineRound(staticHtml, pod, rnd) {
  const rx = new RegExp(
    `id="P${pod}R${rnd}"[^>]*>([\\s\\S]*?)(?=<div[^>]*id="P${pod}(?:R\\d+|-standings)"|$)`,
  );
  const m = staticHtml.match(rx);
  if (!m) return null;
  return parseRound(m[1]);
}

// Standings parser. RK9 embeds standings inside the
// `<div id="P{pod}-standings" role="tabpanel">` panel as a simple
// `<br>`-delimited list: " 1. First Last [CC] <br> 2. ..."
// Slice from the target panel's opener to the next standings panel's
// opener (different pod, e.g. P2 -> P9 -> P0 for Masters / Senior /
// Junior). The order of pods in the HTML is not predictable; iterate
// to find the closest next `id="P{N}-standings"` to clip the panel.
export function parseStandings(html, pod = 2) {
  const startRx = new RegExp(`id="P${pod}-standings"[^>]*>`);
  const m = html.match(startRx);
  if (!m || m.index === undefined) return [];
  const startIdx = m.index + m[0].length;
  // Find the nearest NEXT standings panel of a different pod.
  let stopIdx = html.length;
  const stopRx = /id="P\d+-standings"[^>]*>/g;
  stopRx.lastIndex = startIdx;
  for (const sm of html.matchAll(stopRx)) {
    if (sm.index === undefined) continue;
    if (sm.index <= startIdx) continue;
    // Skip if it's our own panel (shouldn't happen, but defensive).
    if (sm[0].includes(`P${pod}-standings`)) continue;
    stopIdx = sm.index;
    break;
  }
  const panel = html.slice(startIdx, stopIdx);
  const rowRx = /(\d+)\.\s*([^<\[]+?)\s*\[([A-Z]{2})\]/g;
  const out = [];
  for (const r of panel.matchAll(rowRx)) {
    out.push({ finish: +r[1], name: r[2].trim(), country: r[3] });
  }
  out.sort((a, b) => a.finish - b.finish);
  return out;
}
