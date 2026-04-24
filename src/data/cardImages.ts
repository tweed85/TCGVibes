// Card image URLs sourced from Limitless TCG's CDN.
//
// URL pattern: https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/tpci/<SET>/<SET>_<NNN>_R_EN_LG.png
// where <SET> is the Limitless set code (uppercase) and <NNN> is the card number
// zero-padded to 3 digits. The "_R_EN_LG" suffix is invariant (not rarity).
//
// Our local dataset uses pokemon-tcg-data set codes (sv10, me1, …) — different
// from Limitless's codes (DRI, MEG, …). SET_CODE_TO_LIMITLESS maps between them
// for the sets in the currently legal pool.

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

function padNumber(num: string): string | null {
  // Limitless uses zero-padded numeric card numbers. Some cards have
  // non-numeric prefixes (e.g. "TG01") that we can't map — skip those.
  const m = num.match(/^(\d+)$/);
  if (!m) return null;
  return m[1].padStart(3, "0");
}

export function cardImageUrl(
  setCode: string | undefined,
  number: string | undefined,
): string | undefined {
  if (!setCode || !number) return undefined;
  const ltSet = SET_CODE_TO_LIMITLESS[setCode];
  if (!ltSet) return undefined;
  const padded = padNumber(number);
  if (!padded) return undefined;
  return `https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/tpci/${ltSet}/${ltSet}_${padded}_R_EN_LG.png`;
}
