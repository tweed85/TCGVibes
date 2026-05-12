// Card image URLs sourced from Limitless TCG's CDN.
//
// English (TPCi) URL pattern:
//   https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/tpci/<SET>/<SET>_<NNN>_R_EN_LG.png
//   <SET> = Limitless set code (uppercase), <NNN> = card number zero-padded to 3.
//   The "_R_EN_LG" suffix is invariant (not rarity).
//
// Japanese (TPC) URL pattern — used as a stopgap for sets where the English
// release hasn't hit Limitless's CDN yet (e.g. me4 / Chaos Rising, mapped from
// the Japanese Ninja Spinner / M4 set):
//   https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/tpc/<SET>/<SET>_<N>_R_JP_LG.png
//   Note: path is "tpc" (no `i`), number is NOT zero-padded, suffix is "_R_JP_LG".
//
// Our local dataset uses pokemon-tcg-data set codes (sv10, me1, …) — different
// from Limitless's codes (DRI, MEG, …). The two maps below translate between
// them, with the JP map taking precedence (so we can flip a set from JP → EN
// by removing it from SET_CODE_TO_LIMITLESS_JP once the English images land).

const SET_CODE_TO_LIMITLESS: Record<string, string> = {
  // SV-series main sets
  sv4pt5: "PAF",   // Paldean Fates
  sv5: "TEF",      // Temporal Forces
  sv6: "TWM",      // Twilight Masquerade
  sv6pt5: "SFA",   // Shrouded Fable
  sv7: "SCR",      // Stellar Crown
  sv8: "SSP",      // Surging Sparks
  sv8pt5: "PRE",   // Prismatic Evolutions
  sv9: "JTG",      // Journey Together
  sv10: "DRI",     // Destined Rivals
  zsv10pt5: "BLK", // Black Bolt
  rsv10pt5: "WHT", // White Flare
  // Mega Evolution block
  me1: "MEG",       // Mega Evolution
  me2: "PFL",       // Phantasmal Flames
  me2pt5: "ASC",    // Ascended Heroes
  me3: "POR",       // Perfect Order
  // Auxiliary
  sve: "SVE",       // Scarlet & Violet Energies
  svp: "SVP",       // Black Star Promos
};

// Japanese-origin sets whose English counterpart hasn't released / isn't on
// Limitless's TPCi CDN yet. Images come from the Japanese TPC bucket.
const SET_CODE_TO_LIMITLESS_JP: Record<string, string> = {
  me4: "M4",        // Chaos Rising (EN, releases 2026-05-22) ↔ Ninja Spinner (JP)
};

function padNumber(num: string): string | null {
  // Limitless's English bucket uses zero-padded numeric card numbers. Some
  // cards have non-numeric prefixes (e.g. "TG01") that we can't map — skip.
  const m = num.match(/^(\d+)$/);
  if (!m) return null;
  return m[1].padStart(3, "0");
}

function plainNumber(num: string): string | null {
  // Japanese bucket uses the raw numeric card number (no zero-pad).
  const m = num.match(/^(\d+)$/);
  if (!m) return null;
  return m[1];
}

export function cardImageUrl(
  setCode: string | undefined,
  number: string | undefined,
): string | undefined {
  if (!setCode || !number) return undefined;
  const jpSet = SET_CODE_TO_LIMITLESS_JP[setCode];
  if (jpSet) {
    const n = plainNumber(number);
    if (!n) return undefined;
    return `https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/tpc/${jpSet}/${jpSet}_${n}_R_JP_LG.png`;
  }
  const ltSet = SET_CODE_TO_LIMITLESS[setCode];
  if (!ltSet) return undefined;
  const padded = padNumber(number);
  if (!padded) return undefined;
  return `https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/tpci/${ltSet}/${ltSet}_${padded}_R_EN_LG.png`;
}
