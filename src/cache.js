// Disk-backed JSON KV cache for search results and fetched pages.
// Frequency-aware TTL per the incremental-crawling literature: high-churn
// sites (news) expire fast, stable docs stay cached long.
//
// Ref: "Design of a Priority Based Frequency Regulated Incremental Crawler"
// (2010) — refresh interval scaled by page change frequency.

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
  // FNV-1a 64 of key -> hex; keeps filenames short and filesystem-safe.
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < key.length; i++) {
    h ^= BigInt(key.charCodeAt(i) & 0xff);
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
 * @returns {{value:any, age:number, ttl:number, expiresAt:number}|null}
 */
export function cacheGet(key) {
  if (!ENABLED) return null;
  const file = fileFor(key);
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return null; }
  let entry;
  try { entry = JSON.parse(raw); } catch { return null; }
  if (!entry || typeof entry !== "object") return null;
  const now = Date.now();
  if (entry.expiresAt && now >= entry.expiresAt) return null; // expired
  return { value: entry.value, age: now - entry.cachedAt, ttl: entry.ttl, expiresAt: entry.expiresAt };
}

/**
 * Write a value with a TTL derived from the associated URL (or an explicit
 * ttlMs). Overwrites silently.
 */
export function cacheSet(key, value, urlOrTtl) {
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
export function cacheKey(tool, args) {
  // Sort object keys so {a,b} and {b,a} collide.
  const norm = JSON.stringify(args, Object.keys(args || {}).sort());
  return `${tool}:${norm}`;
}

export { CACHE_DIR, ENABLED as CACHE_ENABLED, ttlFor };
