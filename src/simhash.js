// SimHash for near-duplicate detection of {title, snippet} text.
// Charikar's SimHash produces a 64-bit fingerprint; near-duplicates differ
// in few bits (Hamming distance). Used to merge cross-engine results that
// point to the same content under different URLs.
//
// Refs: Charikar (2002); near-dup web detection (Manku et al., WWW 2008);
// "Effective and Fast Near Duplicate Detection via Signature-Based" 2016.

const MASK64 = 0xffffffffffffffffn;

// Cheap non-crypto 64-bit hash (FNV-1a 64) of a string -> BigInt.
function fnv1a64(str) {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i) & 0xff);
    h = (h * 0x100000001b3n) & MASK64;
  }
  return h;
}

// Tokenize text into lowercase word n-grams (unigrams + bigrams) so that
// reworded snippets of the same article still hash close.
function tokenize(text) {
  const words = (text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return [];
  const toks = [...words];
  for (let i = 0; i < words.length - 1; i++) toks.push(words[i] + "_" + words[i + 1]);
  return toks;
}

/**
 * Compute a 64-bit SimHash of a text string.
 * Returns a BigInt.
 */
export function simhash(text) {
  const toks = tokenize(text);
  if (!toks.length) return 0n;
  const v = new Int32Array(64); // weighted vote per bit
  for (const tok of toks) {
    const h = fnv1a64(tok);
    for (let i = 0; i < 64; i++) {
      const bit = (h >> BigInt(i)) & 1n;
      v[i] += bit ? 1 : -1;
    }
  }
  let f = 0n;
  for (let i = 0; i < 64; i++) {
    if (v[i] > 0) f |= 1n << BigInt(i);
  }
  return f;
}

// Hamming distance between two 64-bit BigInt fingerprints.
export function hamming64(a, b) {
  let x = a ^ b;
  let n = 0;
  while (x) {
    x &= x - 1n;
    n++;
  }
  return n;
}

// Build a fingerprint for a search result (title + snippet only — NOT the URL
// host). Same article syndicated across hosts must hash close, so we exclude
// the host from the fingerprint. Cross-host dedup is the whole point.
export function resultFingerprint(r) {
  return simhash(`${r.title || ""} ${r.snippet || ""}`);
}

export { tokenize };
