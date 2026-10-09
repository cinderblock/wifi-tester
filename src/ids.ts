// Crockford base32: no I, L, O, U, so codes survive being read aloud or retyped.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomBase32(chars: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(chars));
  let out = '';
  for (const b of bytes) out += ALPHABET[b & 31];
  return out;
}

/** 26 chars × 5 bits = 130 bits. The unguessable key to one report. */
export function newReportId(): string {
  return randomBase32(26).toLowerCase();
}

/** Short human handle. Not unique by construction; agents look it up via ?code=. */
export function newReportCode(): string {
  return randomBase32(6);
}
