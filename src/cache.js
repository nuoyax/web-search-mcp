// Disk-backed JSON KV cache for search results and fetched pages.
// Frequency-aware TTL per the incremental-crawling literature: high-churn
// sites (news) expire fast, stable docs stay cached long.
//
// Ref: "Design of a Priority Based Frequency Regulated Incremental Crawler"
// (2010) — refresh interval scaled by page change frequency.
//
// Conditional revalidation (RFC 9111 §4.3.4): when a cached page expires we
// don't refetch blindly — we send If-None-Match / If-Modified-Since with the
// stored validators and reuse the old body on a 304. Saves bandwidth, parse
// work, and a 304 is lighter on the host's rate-limit budget than a 200.

import * as fs from "node:fs";
import * as path from "node:path";

const CACHE_DIR = process.env.CACHE_DIR
  ? path.resolve(process.env.CACHE_DIR)
  : path.join(process.cwd(), "cache");

const ENABLED = (process.env.CACHE_DISABLED ?? "0") !== "1";

// TTL buckets by host category (ms).
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const TTL_BY_HOST = [
  // News / frequently-updated aggregators: short TTL.
  { re: /news|163\.com|sina|sohu|qq\.com|xinhuanet|cctv|reuters|bbc|nytimes|guardian|cnbeta/i, ttl: 1 * HOUR },
  // Search-engine result pages themselves: very short (results shift fast).
  { re: /baidu|bing|duckduckgo|sogou|so\.com|google/i, ttl: 30 * 60 * 1000 },
  // API endpoints / docs / specs: long TTL.
  { re: /docs\.|developer|api\.|spec|wikipedia|github|arxiv|doi\.org|openalex|semanticscholar/i, ttl: 7 * DAY },
  // Default.
  { re: /.*/, ttl: 6 * HOUR },
];

function ttlFor(url) {
  let host = "";
  try { host = new URL(url).hostname; } catch { host = url; }
  for (const b of TTL_BY_HOST) if (b.re.test(host)) return b.ttl;
  return 6 * HOUR;
}

// Stable filename from a key string.
function fileFor(key) {
  // FNV-1a 64 over the key's UTF-8 bytes. Iterating UTF-16 code units with
  // `& 0xff` (the old form) collapses CJK chars that differ only in the high
  // byte — e.g. "一" (U+4E00) and "渀" (U+6E00) both fed 0x00, so two
  // different single-char CN queries hashed to the same file → stale HIT with
  // the wrong results. UTF-8 bytes make every distinct string distinct.
  const bytes = Buffer.from(key, "utf8");
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i]);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return path.join(CACHE_DIR, h.toString(16).padStart(16, "0") + ".json");
}

function ensureDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    try { fs.mkdirSync(CACHE_DIR, { recursive: true }); }
    catch { /* cache disabled if dir unwritable */ }
  }
}

/**
 * Read a cached value. Returns null on miss / disabled / corrupt / expired.
 * @param {string} key
 * @returns {{value:any, age:number, ttl:number, expiresAt:number, etag?:string, lastModified?:string}|null}
 */
export function cacheGet(key) {
  if (!ENABLED) return null;
  const entry = readEntry(key);
  if (!entry) return null;
  const now = Date.now();
  if (entry.expiresAt && now >= entry.expiresAt) return null; // expired
  return entryView(entry, now);
}

/**
 * Read a cached value EVEN IF EXPIRED, as long as it carries revalidation
 * validators (ETag / Last-Modified). Used by fetch_url to drive a conditional
 * GET (If-None-Match / If-Modified-Since) instead of a blind refetch — on a
 * 304 the cached body is reused and the TTL refreshed.
 * @param {string} key
 * @returns {{value:any, age:number, ttl:number, expiresAt:number, etag?:string, lastModified?:string}|null}
 */
export function cacheGetStale(key) {
  if (!ENABLED) return null;
  const entry = readEntry(key);
  if (!entry) return null;
  if (!entry.etag && !entry.lastModified) return null; // nothing to revalidate against
  return entryView(entry, Date.now());
}

function readEntry(key) {
  let raw;
  try { raw = fs.readFileSync(fileFor(key), "utf8"); } catch { return null; }
  let entry;
  try { entry = JSON.parse(raw); } catch { return null; }
  if (!entry || typeof entry !== "object") return null;
  return entry;
}

function entryView(entry, now) {
  const view = {
    value: entry.value,
    age: now - entry.cachedAt,
    ttl: entry.ttl,
    expiresAt: entry.expiresAt,
  };
  if (entry.etag) view.etag = entry.etag;
  if (entry.lastModified) view.lastModified = entry.lastModified;
  return view;
}

/**
 * Write a value with a TTL derived from the associated URL (or an explicit
 * ttlMs). Overwrites silently. Optional `validators` ({etag,lastModified})
 * are stored so a later expired read can drive a conditional revalidation
 * request (If-None-Match / If-Modified-Since).
 */
export function cacheSet(key, value, urlOrTtl, validators) {
  if (!ENABLED) return;
  ensureDir();
  const ttl = typeof urlOrTtl === "number" ? urlOrTtl : ttlFor(urlOrTtl || key);
  const now = Date.now();
  const entry = {
    key,
    value,
    cachedAt: now,
    ttl,
    expiresAt: now + ttl,
  };
  if (validators && validators.etag) entry.etag = validators.etag;
  if (validators && validators.lastModified) entry.lastModified = validators.lastModified;
  try {
    fs.writeFileSync(fileFor(key), JSON.stringify(entry));
  } catch { /* non-fatal: cache is advisory */ }
}

/**
 * Delete a cached entry.
 */
export function cacheDelete(key) {
  try { fs.unlinkSync(fileFor(key)); } catch { /* ignore */ }
}

// Build a stable cache key for a (tool, args) pair.
// Query text is normalized (case, whitespace, stopwords, CJK width) so that
// near-identical queries ("Reciprocal Rank Fusion" vs "reciprocal rank
// fusion" vs " reciprocal  rank fusion ") share a cache entry — a cheap form
// of semantic cache reuse (RAGCache, ACM TOCS 2025, applies the same idea).
// Non-query args (url, num, engine, fetch_top_k, ...) pass through verbatim.
const STOPWORDS = new Set([
  "a", "an", "the", "of", "to", "in", "on", "for", "and", "or", "is", "are",
  "be", "with", "as", "by", "at", "from", "that", "this", "it",
]);

function normalizeQuery(q) {
  if (typeof q !== "string" || !q) return q;
  // Full-width ASCII (U+FF01–U+FF5E) -> half-width.
  let s = q.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  s = s.replace(/　/g, " "); // ideographic space -> ASCII space
  s = s.toLowerCase().replace(/\s+/g, " ").trim();
  // Drop stopwords only when the query is purely latin/digit words; never
  // touch CJK runs (stopword stripping there would mangle meaning).
  if (!/[^\x00-\x7f]/.test(s)) {
    s = s.split(" ").filter((w) => w && !STOPWORDS.has(w)).join(" ");
  }
  return s;
}

export function cacheKey(tool, args) {
  // Sort object keys so {a,b} and {b,a} collide. Normalize the "query" field
  // (and any nested query) so rephrasings collide.
  const normArgs = { ...(args || {}) };
  if (typeof normArgs.query === "string") normArgs.query = normalizeQuery(normArgs.query);
  const norm = JSON.stringify(normArgs, Object.keys(normArgs).sort());
  return `${tool}:${norm}`;
}

export { CACHE_DIR, ENABLED as CACHE_ENABLED, ttlFor, normalizeQuery };
