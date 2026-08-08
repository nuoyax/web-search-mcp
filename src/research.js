// deep_research: multi-engine fan-out → dedup → RRF rank → fetch top → markdown report.

import {
  ENGINES,
  ENGINE_LIST,
  defaultEngineOrder,
  resolveBaiduRedirect,
} from "./engines.js";
import { fetchUrl } from "./fetcher.js";
import { resultFingerprint, hamming64 } from "./simhash.js";

const MAX_PARALLEL_FETCH = 4;

// RRF (Reciprocal Rank Fusion) constant. k=60 is the established default
// (Cormack et al. 2009; ranx.fuse, Carrara et al. CIKM 2022). Higher k
// dampens the advantage of top ranks, making fusion robust to engines that
// return very different result counts.
const RRF_K = 60;

// Run multiple engines concurrently, tolerating individual failures.
// Returns each engine's results WITHIN-engine rank (1-based) so callers can
// compute Reciprocal Rank Fusion across engines.
async function runEngines(query, engineKeys, numPerEngine, log) {
  const engines = engineKeys
    .map((k) => ENGINES[k])
    .filter(Boolean);
  const settled = await Promise.allSettled(
    engines.map(async (e) => {
      const results = await e.search(query, { num: numPerEngine });
      // Tag each result with its (1-based) rank within this engine.
      const ranked = results.map((r, i) => ({ ...r, rank: i + 1 }));
      return { engine: e.name, label: e.label, results: ranked };
    }),
  );
  const ok = [];
  const errors = [];
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    if (s.status === "fulfilled") ok.push(s.value);
    else errors.push({ engine: engines[i].name, error: String(s.reason?.message || s.reason) });
  }
  if (log) log(`engines ok=${ok.length} fail=${errors.length}`);
  return { ok, errors };
}

function normUrl(u) {
  try {
    const url = new URL(u);
    // strip trailing slash + common tracking params
    let s = (url.hostname + url.pathname).replace(/\/+$/, "");
    return s.toLowerCase();
  } catch {
    return (u || "").toLowerCase();
  }
}

// Two-stage dedup: (1) exact normalized-URL merge, then (2) SimHash
// near-duplicate merge on title+snippet to collapse syndicated copies that
// live under different URLs. Threshold 3 bits is standard for short texts.
const SIMHASH_THRESHOLD = 3;

function dedupe(results) {
  // Stage 1: exact URL merge.
  const byUrl = new Map();
  for (const r of results) {
    const key = normUrl(r.url);
    if (!key) continue;
    const existing = byUrl.get(key);
    if (existing) {
      if ((r.snippet || "").length > (existing.snippet || "").length) {
        existing.snippet = r.snippet;
      }
      if (!existing.sources.includes(r.engine)) existing.sources.push(r.engine);
      // Track per-engine ranks for RRF.
      if (!existing.ranks[r.engine]) existing.ranks[r.engine] = r.rank;
      continue;
    }
    byUrl.set(key, { ...r, sources: [r.engine], ranks: { [r.engine]: r.rank } });
  }
  let deduped = [...byUrl.values()];

  // Stage 2: SimHash near-duplicate merge.
  for (const r of deduped) r.fp = resultFingerprint(r);
  const merged = [];
  const used = new Array(deduped.length).fill(false);
  for (let i = 0; i < deduped.length; i++) {
    if (used[i]) continue;
    const base = deduped[i];
    for (let j = i + 1; j < deduped.length; j++) {
      if (used[j]) continue;
      const cand = deduped[j];
      if (hamming64(base.fp, cand.fp) <= SIMHASH_THRESHOLD) {
        // Merge cand into base: keep longest snippet, union sources/ranks.
        if ((cand.snippet || "").length > (base.snippet || "").length) {
          base.snippet = cand.snippet;
        }
        for (const e of cand.sources) if (!base.sources.includes(e)) base.sources.push(e);
        for (const [eng, rk] of Object.entries(cand.ranks)) {
          if (!base.ranks[eng]) base.ranks[eng] = rk;
        }
        // Prefer the URL whose host looks like a primary source (no
        // aggregator path like /search, /link, /ck/a) — heuristic.
        if (looksAggregator(base.url) && !looksAggregator(cand.url)) {
          base.url = cand.url;
          base.title = cand.title || base.title;
        }
        used[j] = true;
      }
    }
    merged.push(base);
  }
  return merged;
}

function looksAggregator(url) {
  return /\/(link|ck\/a|search|web|redirect)\b|baidu\.com\/link|bing\.com\/ck\/a/i.test(url || "");
}

// Reciprocal Rank Fusion: score = Σ_engine 1 / (k + rank_in_engine).
// Robust without score normalization; standard for metasearch.
function rrfScore(r) {
  let score = 0;
  for (const rank of Object.values(r.ranks || {})) {
    score += 1 / (RRF_K + rank);
  }
  return score;
}

async function fetchWithLimit(url, maxChars, semaphore) {
  await semaphore.acquire();
  try {
    return await fetchUrl(url, { maxChars });
  } finally {
    semaphore.release();
  }
}

// Tiny semaphore for parallel fetch limiting.
function makeSemaphore(max) {
  let active = 0;
  const queue = [];
  return {
    acquire() {
      if (active < max) {
        active++;
        return Promise.resolve();
      }
      return new Promise((resolve) => queue.push(resolve));
    },
    release() {
      active--;
      const next = queue.shift();
      if (next) {
        active++;
        next();
      }
    },
  };
}

/**
 * @param {string} query
 * @param {object} opts { engines?: string[], numPerEngine?: number, fetchTopK?: number, fetchChars?: number, log? }
 * @returns {Promise<{query, summary, sources, fetched, errors, report}>}
 */
export async function deepResearch(query, opts = {}) {
  const log = opts.log || (() => {});
  const engineKeys = opts.engines && opts.engines.length
    ? opts.engines
    : defaultEngineOrder(query);
  const numPerEngine = opts.numPerEngine ?? 8;
  const fetchTopK = opts.fetchTopK ?? 4;
  const fetchChars = opts.fetchChars ?? 6_000;

  log(`query="${query}" engines=[${engineKeys.join(",")}]`);
  const { ok, errors } = await runEngines(query, engineKeys, numPerEngine, log);

  // Flatten + tag engine. Preserve within-engine rank from runEngines.
  const flat = [];
  for (const batch of ok) {
    for (const r of batch.results) {
      flat.push({ ...r, engine: batch.engine });
    }
  }
  log(`raw results=${flat.length}`);

  // Resolve 百度 redirect links before dedup/scoring so cross-engine
  // near-duplicates (e.g. a 百度 wrapped link and the same URL on Bing) merge.
  for (const r of flat) {
    if (/baidu\.com\/link\?url=/.test(r.url)) {
      try {
        r.url = await resolveBaiduRedirect(r.url);
      } catch {
        /* keep original */
      }
    }
  }

  const deduped = dedupe(flat);
  log(`deduped=${deduped.length}`);

  // Rank via Reciprocal Rank Fusion across engines. As a tiebreaker, results
  // that match query terms in the title get a small boost — this only orders
  // results with near-equal RRF scores and never overrides cross-engine
  // consensus.
  const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const ranked = deduped
    .map((r) => {
      const score = rrfScore(r);
      const title = (r.title || "").toLowerCase();
      const termBoost = queryTerms.reduce(
        (acc, t) => acc + (t && title.includes(t) ? 1e-4 : 0),
        0,
      );
      return { ...r, score: score + termBoost, rrf: score };
    })
    .sort((a, b) => b.score - a.score);

  const top = ranked.slice(0, fetchTopK);
  log(`fetching top ${top.length}...`);

  const semaphore = makeSemaphore(MAX_PARALLEL_FETCH);
  const fetched = [];
  await Promise.all(
    top.map(async (r) => {
      try {
        const f = await fetchWithLimit(r.url, fetchChars, semaphore);
        fetched.push({
          url: r.url,
          title: r.title,
          ok: f.ok,
          status: f.status,
          markdown: f.markdown || "",
          useProxy: f.useProxy,
          sources: r.sources,
        });
      } catch (e) {
        fetched.push({
          url: r.url,
          title: r.title,
          ok: false,
          status: 0,
          markdown: "",
          error: String(e?.message || e),
        });
      }
    }),
  );

  // Compose report.
  const report = composeReport({
    query,
    engines: engineKeys,
    engineErrors: errors,
    ranked,
    fetched,
  });

  return {
    query,
    engines: engineKeys,
    totalRaw: flat.length,
    totalDedup: deduped.length,
    fetchedCount: fetched.filter((f) => f.ok).length,
    errors,
    report,
  };
}

function composeReport({ query, engines, engineErrors, ranked, fetched }) {
  const lines = [];
  lines.push(`# Deep Research: ${query}`);
  lines.push("");
  lines.push(`_Engines: ${engines.join(", ")}_`);
  if (engineErrors.length) {
    lines.push(`_Failed engines: ${engineErrors.map((e) => e.engine).join(", ")}_`);
  }
  lines.push("");

  // Synthesis: pull first 1-2 sentences from each fetched source, cite.
  lines.push("## Summary");
  const synthesized = [];
  for (const f of fetched.filter((x) => x.ok && x.markdown)) {
    // Extract first non-heading paragraph(s) of meaningful length.
    const paras = f.markdown
      .split(/\n{2,}/)
      .map((p) => p.replace(/^#+\s.*$/, "").trim())
      .filter((p) => p.length > 60);
    const excerpt = paras.slice(0, 2).join(" ").slice(0, 500);
    if (excerpt) {
      // Cite with the source title + URL so the data origin is explicit.
      synthesized.push(excerpt + ` — [${f.title || f.url}](${f.url})`);
    }
  }
  if (synthesized.length) {
    lines.push(synthesized.join("\n\n"));
  } else {
    lines.push("_No full-text sources could be fetched; see the result list below._");
  }
  lines.push("");

  // All results list. Each item tagged with its originating engine(s).
  lines.push("## Sources");
  ranked.slice(0, 15).forEach((r, i) => {
    const src = r.sources && r.sources.length ? ` [source: ${r.sources.join(", ")}]` : "";
    lines.push(`${i + 1}. [${r.title || r.url}](${r.url})${src}`);
    if (r.snippet) lines.push(`   ${r.snippet.replace(/\n+/g, " ").slice(0, 240)}`);
  });
  lines.push("");

  // Detailed fetched content (truncated). Each block labeled with its source.
  lines.push("## Fetched content");
  for (const f of fetched.filter((x) => x.ok && x.markdown)) {
    const srcLabel = f.sources && f.sources.length ? ` (source: ${f.sources.join(", ")})` : "";
    lines.push(`### ${f.title || f.url}${srcLabel}`);
    lines.push(`URL: ${f.url}`);
    lines.push("");
    const body = f.markdown.slice(0, 2500);
    lines.push(body);
    lines.push("");
  }

  // Data-source summary so the origin of the synthesized answer is explicit.
  lines.push("## Data sources");
  lines.push(`Retrieved from ${engines.length} engine(s)${engineErrors.length ? ` (${engineErrors.length} failed)` : ""}.`);
  lines.push("");
  // Engine -> result count (from ranked sources) + fetch status.
  const byEngine = new Map();
  for (const r of ranked) {
    for (const e of r.sources || []) {
      byEngine.set(e, (byEngine.get(e) || 0) + 1);
    }
  }
  for (const eng of engines) {
    const cnt = byEngine.get(eng) ?? 0;
    const failed = engineErrors.some((e) => e.engine === eng);
    lines.push(`- **${eng}** — ${cnt} result(s)${failed ? " (failed)" : ""}`);
  }
  const fetchedOk = fetched.filter((f) => f.ok).length;
  lines.push("");
  lines.push(`Full text fetched for ${fetchedOk}/${fetched.length} top result(s). Every cited source above is tagged with its originating engine.`);
  lines.push("");

  return lines.join("\n");
}
