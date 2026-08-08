// Reranking signals — lightweight, no neural model, no paid API.
//
// Mainstream answer engines (Perplexity, Tavily, Exa) rerank fused results
// with a cross-encoder or learned weights — both unavailable to us (no paid
// API, no embedded model). Instead we layer cheap, deterministic signals on
// top of the existing Reciprocal Rank Fusion score:
//
//   final = RRF + authority + recency + termDensity
//
// Weights are deliberately small so RRF (multi-engine consensus) stays
// dominant; the signals break ties and lift, they don't override consensus.
// This mirrors how Tavily/Perplexity expose authority (domain allowlists)
// and freshness (recency filters) as rerank knobs.

// Authoritative domains / TLDs. A curated allowlist is the standard free
// authority signal (every answer engine upweights trusted sources). We add a
// small positive bump; aggregators (search/link redirects) get a small demote.
const AUTHORITY_HOSTS = new Set([
  "arxiv.org",
  "www.arxiv.org",
  "en.wikipedia.org",
  "zh.wikipedia.org",
  "wikipedia.org",
  "github.com",
  "developer.mozilla.org",
  "stackoverflow.com",
  "stackexchange.com",
  "www.nature.com",
  "www.science.org",
  "ieeexplore.ieee.org",
  "dl.acm.org",
  "doi.org",
  "www.w3.org",
  "developer.android.com",
  "developers.google.com",
  "learn.microsoft.com",
  "docs.python.org",
  "nodejs.org",
  "go.dev",
  "rust-lang.org",
  "reactjs.org",
  "vuejs.org",
  "kubernetes.io",
  "openai.com",
  "anthropic.com",
  "www.ibm.com",
  "www.cloudflare.com",
  "aws.amazon.com",
]);

// Aggregator path patterns (search-result redirects / wrappers). A result
// whose URL is a redirect wrapper is less authoritative than the real target.
const AGGREGATOR_RE = /\/(link|ck\/a|search|web|redirect)\b|baidu\.com\/link|bing\.com\/ck\/a|duckduckgo\.com\/l\//i;

/**
 * Authority score for a URL. +0.05 for an authoritative host/TLD, -0.02 for an
 * aggregator redirect URL. Returns 0 for neutral. Weight is small relative to
 * a single-engine RRF term (~0.016) so it breaks ties without dominating.
 */
export function authorityScore(url) {
  if (!url) return 0;
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { return 0; }
  let score = 0;
  if (AUTHORITY_HOSTS.has(host) || AUTHORITY_HOSTS.has(host.replace(/^www\./, ""))) score += 0.05;
  // TLD authority: .gov / .edu / .mil are institutional sources.
  if (/\.(gov|edu|mil)$/.test(host)) score += 0.05;
  if (AGGREGATOR_RE.test(url)) score -= 0.02;
  return score;
}

// Time-sensitive query detection. Recency should only boost when the query
// asks for something current — applying it to evergreen queries would
// penalize authoritative-but-old canonical references.
const TIME_SENSITIVE_RE = /\b(latest|newest|recent|current|today|now|2024|2025|2026|news|update|changes?|version)\b/i;

export function isTimeSensitiveQuery(query) {
  return TIME_SENSITIVE_RE.test(query || "");
}

/**
 * Recency score in [0.85, 1.0] from a publish date. Newer → closer to 1.0.
 * Returns 1.0 (neutral) when there's no date or the query isn't time-sensitive
 * — evergreen queries must not be penalized for old-but-canonical sources.
 * The 0.85 floor means an old source is still eligible, just slightly demoted
 * vs a fresh one, only when recency matters.
 */
export function recencyScore(publishedTime, query) {
  if (!isTimeSensitiveQuery(query)) return 1.0;
  if (!publishedTime) return 1.0; // unknown date → don't penalize
  const t = Date.parse(publishedTime);
  if (!Number.isFinite(t)) return 1.0;
  const days = (Date.now() - t) / 86_400_000;
  if (days < 0) return 1.0; // future-dated (clock skew) → don't boost absurdly
  // Half-life ~1 year: 1/(1+days/365). 1 day → 0.997, 30 days → 0.92,
  // 180 days → 0.67, 365 days → 0.5, capped at 0.85 floor.
  return Math.max(0.85, 1 / (1 + days / 365));
}

/**
 * Query-term density in a body of text. Counts how many query terms appear
 * and how often, normalized by length — a lexical relevance tiebreaker that
 * catches RRF misses (3 engines agree on a URL whose body is off-topic).
 * Returns a small number (~1e-3 scale) so it only breaks near-ties.
 */
export function termDensityScore(body, queryTerms) {
  if (!body || !queryTerms || !queryTerms.length) return 0;
  const b = body.toLowerCase();
  let hits = 0;
  for (const t of queryTerms) {
    if (!t) continue;
    const tl = t.toLowerCase();
    // Count non-overlapping occurrences.
    let from = 0;
    let idx;
    while ((idx = b.indexOf(tl, from)) >= 0) { hits++; from = idx + tl.length; }
  }
  // hits per ~1000 chars, scaled down to tiebreaker magnitude.
  const perK = hits / (b.length / 1000 || 1);
  return Math.min(perK, 20) * 1e-3;
}

/**
 * Rerank a list of ranked results (each with an `rrf` score) by adding the
 * authority / recency / term-density signals. Mutates copies, not inputs.
 *
 * @param {Array<{rrf:number, url:string, title?:string, snippet?:string, markdown?:string, publishedTime?:string}>} ranked
 * @param {string} query
 * @param {Object} opts { fetchedByUrl?: Map<string,{markdown,publishedTime}>, queryTerms?: string[] }
 * @returns {Array} sorted desc by final score, each carrying `score`, `rrf`, `authority`, `recency`, `termDensity`.
 */
export function rerank(ranked, query, opts = {}) {
  const queryTerms = opts.queryTerms || extractQueryTerms(query);
  const fetchedByUrl = opts.fetchedByUrl || new Map();
  return ranked
    .map((r) => {
      const auth = authorityScore(r.url);
      const fetched = fetchedByUrl.get(normalizeUrlKey(r.url));
      const publishedTime = r.publishedTime || fetched?.publishedTime;
      const rec = recencyScore(publishedTime, query);
      const body = fetched?.markdown || r.snippet || "";
      const dens = termDensityScore(body, queryTerms);
      const score = (r.rrf || 0) + auth + (r.rrf || 0) * (rec - 1) + dens;
      return { ...r, authority: auth, recency: rec, termDensity: dens, score, publishedTime };
    })
    .sort((a, b) => b.score - a.score);
}

// Lowercase hostname+path for matching fetched content back to ranked results.
function normalizeUrlKey(u) {
  try {
    const url = new URL(u);
    return (url.hostname + url.pathname).replace(/\/+$/, "").toLowerCase();
  } catch {
    return (u || "").toLowerCase();
  }
}

// Query terms for density matching: lowercase, alnum tokens, length > 1,
// minus a tiny stopword set so "the transformer attention" doesn't match
// every "the" on the page.
const DENSITY_STOPWORDS = new Set(["the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "is", "are", "be", "with", "as", "by", "at", "from", "that", "this", "it", "how", "what", "why", "when"]);
export function extractQueryTerms(query) {
  if (!query) return [];
  const words = (query.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(/\s+/).filter(Boolean));
  return words.filter((w) => w.length > 1 && !DENSITY_STOPWORDS.has(w));
}

// ---- Passage-level chunking + scoring (Tavily chunks_per_source style) ----
// Mainstream answer engines return reranked passage chunks per source (Tavily
// `chunks_per_source`, Exa `highlights`) so the model can cite a specific
// passage rather than the whole page. We split fetched markdown into
// paragraph-ish chunks, score each by query-term density, and return the top-K
// with `[n]` markers the model can cite as `[1]`, `[2]`.

const CHUNK_MIN = 120;     // skip chunks too short to carry meaning
const CHUNK_MAX = 800;     // merge adjacent small paragraphs up to this size

/**
 * Split fetched markdown into passage chunks for citation. Splits on blank
 * lines, then merges tiny fragments up to CHUNK_MAX so a 1-line paragraph
 * isn't its own chunk. Drops link-dense / nav fragments (anchor runs, footer
 * link lists) so a chunk carries prose, not a nav bar — the density rerank
 * would otherwise surface YouTube's footer link list as the "most relevant"
 * passage. Returns chunks (trimmed, non-empty, prose-bearing).
 */
export function chunkMarkdown(markdown) {
  if (!markdown) return [];
  const raw = markdown.split(/\n{2,}/).map((s) => s.replace(/^\s+|\s+$/g, "")).filter(Boolean);
  // Keep only prose paragraphs: min length AND low link share (drop nav/footer).
  const meaningful = raw.filter((s) => {
    const stripped = s.replace(/[#>*_`\-]/g, "").trim();
    return stripped.length >= CHUNK_MIN && probeLinkShare(s) <= 0.3;
  });
  if (!meaningful.length) return [];
  // Merge tiny adjacent fragments up to CHUNK_MAX.
  const merged = [];
  for (const frag of meaningful) {
    const last = merged[merged.length - 1];
    if (last && last.length < CHUNK_MAX && (last + "\n\n" + frag).length <= CHUNK_MAX) {
      merged[merged.length - 1] = last + "\n\n" + frag;
    } else {
      merged.push(frag);
    }
  }
  return merged.filter((s) => s.length >= CHUNK_MIN && probeLinkShare(s) <= 0.3);
}

// Fraction of a fragment's chars that are inside markdown link targets
// `(...)` of `[text](url)`. High share ⇒ nav/footer link list, not prose.
function probeLinkShare(s) {
  const total = s.length || 1;
  let linkChars = 0;
  for (const m of s.matchAll(/\[[^\]]*\]\(([^)]*)\)/g)) {
    linkChars += (m[1] || "").length;
  }
  return linkChars / total;
}

/**
 * Score each chunk by query-term density and return the top-K, each tagged
 * with its 1-based `[n]` index (matching the report's numbering so the model
 * can cite `[1]`, `[2]`, …). Mirrors Tavily's reranked chunks_per_source.
 *
 * @returns {Array<{index:number, text:string, score:number}>}
 */
export function chunkAndScore(markdown, queryTerms, topK = 3) {
  const chunks = chunkMarkdown(markdown);
  if (!chunks.length) return [];
  const scored = chunks.map((text, i) => ({
    index: i + 1,
    text,
    score: termDensityScore(text, queryTerms),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
