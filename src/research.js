// deep_research: multi-engine fan-out → dedup → RRF rank → fetch top → markdown report.

import {
  ENGINES,
  ENGINE_LIST,
  defaultEngineOrder,
  resolveBaiduRedirects,
  faviconImg,
  sourcesLabel,
} from "./engines.js";
import { fetchUrl } from "./fetcher.js";
import { resultFingerprint, hamming64 } from "./simhash.js";
import { rerank, extractQueryTerms, authorityScore, chunkAndScore } from "./rerank.js";

const MAX_PARALLEL_FETCH = 4;

// RRF (Reciprocal Rank Fusion) constant. k=60 is the established default
// (Cormack et al. 2009; ranx.fuse, Carrara et al. CIKM 2022). Higher k
// dampens the advantage of top ranks, making fusion robust to engines that
// return very different result counts.
const RRF_K = 60;

// Fail-fast engine fan-out: resolve as soon as a quorum is met (enough
// engines succeeded OR one engine returned enough results), or a soft
// deadline elapses, or all tasks settle — whichever is first. Laggards still
// in flight at resolve time are NOT cancelled (cancellation would need an
// AbortSignal plumbed through httpGet→undici, out of scope); they settle in
// the background and are reported as "timed out" so they don't silently drop.
//
// Why: a dead/slow engine (e.g. DDG blocked from the egress IP, failing after
// the 25s timeout) used to gate the whole response behind Promise.allSettled.
// With raceToQuorum a fast engine (bing ~460ms) returning ≥minResults
// satisfies the quorum and the response goes out immediately; the laggard's
// eventual failure is logged, not awaited.
//
// Returns { ok, errors, dropped } — `dropped` are engines that hadn't
// settled by resolve time (reported separately so callers can mark them).
// `onSettle({status, value|reason, index})` fires for every task (including
// late-settling laggards after resolve) so callers can collect results in the
// background without awaiting the full set.
export async function raceToQuorum(tasks, { deadlineMs, minEngines, minResults, onSettle } = {}) {
  const ok = [];
  const errors = [];
  const dropped = [];
  const total = tasks.length;
  let resolved = false;
  let timer = null;

  return new Promise((resolve) => {
    const finish = () => {
      if (resolved) return;
      resolved = true;
      if (timer) { clearTimeout(timer); timer = null; }
      resolve({ ok, errors, dropped });
    };

    const checkQuorum = () => {
      if (resolved) return;
      const enoughEngines = ok.length >= minEngines;
      const enoughResults = ok.some((b) => b?.results?.length >= minResults);
      if (enoughEngines || enoughResults) finish();
    };

    // Soft deadline: resolve with whatever we have. Laggards keep running.
    if (deadlineMs) timer = setTimeout(finish, deadlineMs);

    tasks.forEach((task, i) => {
      Promise.resolve()
        .then(() => task())
        .then((value) => {
          if (resolved) {
            if (onSettle) onSettle({ status: "late-fulfilled", value, index: i });
            return;
          }
          ok.push(value);
          if (onSettle) onSettle({ status: "fulfilled", value, index: i });
          checkQuorum();
          // If everything has now settled, finish immediately (no point waiting
          // out the deadline with a complete result set).
          if (ok.length + errors.length >= total) finish();
        })
        .catch((err) => {
          if (resolved) {
            if (onSettle) onSettle({ status: "late-rejected", reason: err, index: i });
            return;
          }
          errors.push({ engine: `engine#${i}`, error: String(err?.message || err) });
          if (onSettle) onSettle({ status: "rejected", reason: err, index: i });
          if (ok.length + errors.length >= total) finish();
        });
    });
  });
}

// Run multiple engines concurrently, tolerating individual failures and
// resolving as soon as a quorum is met (fail-fast). Returns each engine's
// results WITHIN-engine rank (1-based) so callers can compute Reciprocal
// Rank Fusion across engines.
//
// `dropped` = engines still in flight when the quorum/deadline resolved;
// reported as "(timed out)" in the deep_research data-sources summary.
async function runEngines(query, engineKeys, numPerEngine, log) {
  const tasks = engineKeys.map((k) => {
    const e = ENGINES[k];
    const run = async () => {
      const results = await e.search(query, { num: numPerEngine });
      // Tag each result with its (1-based) rank within this engine.
      const ranked = results.map((r, i) => ({ ...r, rank: i + 1 }));
      return { engine: e.name, label: e.label, favicon: e.favicon, results: ranked };
    };
    return { name: e.name, label: e.label, run };
  });

  const { ok, errors, dropped } = await raceToQuorum(
    tasks.map((t) => t.run),
    {
      // deep_research is recall-oriented: collect every engine that returns
      // within the deadline rather than short-circuiting on the first strong
      // engine (that's web_search's job). minEngines=tasks.length +
      // minResults=Infinity means the ONLY early resolve is "all engines
      // settled" — otherwise we wait out the deadline and gather whatever came
      // back. Engines still in flight at the deadline (e.g. DDG's 25s timeout)
      // are reported as "timed out"; engines that throw (e.g. baidu CAPTCHA)
      // land in errors. Both are surfaced in the Data-sources summary.
      deadlineMs: 4_000,
      minEngines: tasks.length,
      minResults: Infinity,
      // Late settle: record laggard results so dropped engines that DO
      // eventually succeed still contribute to the report (best-effort).
      onSettle: (ev) => {
        if (ev.status === "late-fulfilled" && ev.value) {
          ok.push(ev.value);
          const idx = dropped.findIndex((d) => d.name === ev.value.engine);
          if (idx >= 0) dropped.splice(idx, 1);
        } else if (ev.status === "late-rejected") {
          const t = tasks[ev.index];
          if (t) {
            errors.push({ engine: t.name, error: String(ev.reason?.message || ev.reason) });
            const idx = dropped.findIndex((d) => d.name === t.name);
            if (idx >= 0) dropped.splice(idx, 1);
          }
        }
      },
    },
  );

  // Re-attribute errors that came back as "engine#i" placeholders to real names.
  for (const err of errors) {
    if (/^engine#\d+$/.test(err.engine)) {
      const idx = Number(err.engine.slice(7));
      if (tasks[idx]) err.engine = tasks[idx].name;
    }
  }

  // Engines that never settled (and never did via onSettle) → dropped/timed-out.
  const settledNames = new Set([
    ...ok.map((b) => b.engine),
    ...errors.map((e) => e.engine),
  ]);
  for (const t of tasks) {
    if (!settledNames.has(t.name)) {
      dropped.push({ engine: t.name, label: t.label, error: "timed out (slow engine)" });
    }
  }

  if (log) log(`engines ok=${ok.length} fail=${errors.length} dropped=${dropped.length}`);
  return { ok, errors, dropped };
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
  const { ok, errors, dropped } = await runEngines(query, engineKeys, numPerEngine, log);

  // Flatten + tag engine. Preserve within-engine rank from runEngines.
  const flat = [];
  for (const batch of ok) {
    for (const r of batch.results) {
      flat.push({ ...r, engine: batch.engine });
    }
  }
  log(`raw results=${flat.length}`);

  // Resolve 百度 redirect links in parallel before dedup/scoring so
  // cross-engine near-duplicates (e.g. a 百度 wrapped link and the same URL on
  // Bing) merge. Parallel (capped 4) — the per-host token bucket still paces
  // the actual HTTP, so this pipelines the await chain without raising the
  // request rate baidu sees.
  await resolveBaiduRedirects(flat);

  const deduped = dedupe(flat);
  log(`deduped=${deduped.length}`);

  // Rank via Reciprocal Rank Fusion across engines. As a tiebreaker, results
  // that match query terms in the title get a small boost — this only orders
  // results with near-equal RRF scores and never overrides cross-engine
  // consensus. (This first pass has no fetched bodies yet; the full rerank
  // with authority/recency/term-density runs after the top-K fetch.)
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
          publishedTime: f.publishedTime || null,
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

  // Second-pass rerank: now that we have fetched bodies + publish dates, layer
  // the authority / recency / term-density signals on top of RRF (mirrors how
  // Tavily/Perplexity apply authority + freshness reranks after retrieval).
  // The fetched map keys by normalized URL so the rerank can match a fetched
  // body back to its ranked entry. Results below the fetchTopK cutoff keep
  // their RRF-only score (no body fetched → no density/recency signal).
  const fetchedByUrl = new Map();
  for (const f of fetched) {
    if (f.ok && f.markdown) {
      try {
        const u = new URL(f.url);
        fetchedByUrl.set((u.hostname + u.pathname).replace(/\/+$/, "").toLowerCase(), f);
      } catch { /* keep */ }
    }
  }
  const reranked = rerank(ranked, query, { fetchedByUrl, queryTerms: extractQueryTerms(query) });
  log(`reranked (top score ${reranked[0]?.score?.toFixed(4) || "n/a"})`);

  // Compose report.
  const report = composeReport({
    query,
    engines: engineKeys,
    engineErrors: errors,
    engineDropped: dropped,
    ranked: reranked,
    fetched,
    queryTerms: extractQueryTerms(query),
  });

  return {
    query,
    engines: engineKeys,
    totalRaw: flat.length,
    totalDedup: deduped.length,
    fetchedCount: fetched.filter((f) => f.ok).length,
    errors,
    dropped,
    report,
  };
}

function composeReport({ query, engines, engineErrors, engineDropped, ranked, fetched, queryTerms }) {
  const lines = [];
  lines.push(`# Deep Research: ${query}`);
  lines.push("");
  lines.push(`_Engines: ${engines.join(", ")}_`);
  if (engineErrors.length) {
    lines.push(`_Failed engines: ${engineErrors.map((e) => e.engine).join(", ")}_`);
  }
  if (engineDropped && engineDropped.length) {
    lines.push(`_Timed out engines: ${engineDropped.map((e) => e.engine).join(", ")}_`);
  }
  lines.push("");
  // Explain the rerank so the caller understands why sources are ordered as
  // they are: RRF consensus + authority/recency/term-density signals.
  lines.push("_Ranking: Reciprocal Rank Fusion (k=60) across engines, then authority / recency / passage-term-density rerank. Fetched passages are numbered `[n]` for citation._");
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
    const src = r.sources && r.sources.length ? ` ${sourcesLabel(r.sources)} [source: ${r.sources.join(", ")}]` : "";
    lines.push(`${i + 1}. [${r.title || r.url}](${r.url})${src}`);
    if (r.snippet) lines.push(`   ${r.snippet.replace(/\n+/g, " ").slice(0, 240)}`);
  });
  lines.push("");

  // Detailed fetched content as reranked passage chunks (Tavily
  // chunks_per_source style). Each source shows its top-K most query-relevant
  // passages, numbered `[n]` so the model can cite a specific passage rather
  // than the whole page. Falls back to a truncated body if chunking yields
  // nothing (e.g. very short fetches).
  lines.push("## Fetched content");
  for (const f of fetched.filter((x) => x.ok && x.markdown)) {
    const srcLabel = f.sources && f.sources.length ? ` ${sourcesLabel(f.sources)} (source: ${f.sources.join(", ")})` : "";
    lines.push(`### ${f.title || f.url}${srcLabel}`);
    lines.push(`URL: ${f.url}`);
    if (f.publishedTime) lines.push(`Published: ${f.publishedTime}`);
    lines.push("");
    const chunks = chunkAndScore(f.markdown, queryTerms || [], 3);
    if (chunks.length) {
      for (const c of chunks) {
        lines.push(`[${c.index}] ${c.text}`);
        lines.push("");
      }
    } else {
      // Fallback: no chunkable passages — show a truncated body.
      lines.push(f.markdown.slice(0, 2500));
      lines.push("");
    }
  }

  // Data-source summary so the origin of the synthesized answer is explicit.
  lines.push("## Data sources");
  const droppedCount = engineDropped?.length ?? 0;
  lines.push(
    `Retrieved from ${engines.length} engine(s)` +
      `${engineErrors.length ? ` (${engineErrors.length} failed)` : ""}` +
      `${droppedCount ? ` (${droppedCount} timed out)` : ""}.`,
  );
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
    const timedOut = engineDropped?.some((e) => e.engine === eng);
    const img = faviconImg(eng, ENGINES[eng]?.label || eng);
    const prefix = img ? `${img} ` : "";
    const label = ENGINES[eng]?.label || eng;
    const tag = failed ? " (failed)" : timedOut ? " (timed out)" : "";
    lines.push(`- ${prefix}**${label}** — ${cnt} result(s)${tag}`);
  }
  const fetchedOk = fetched.filter((f) => f.ok).length;
  lines.push("");
  lines.push(`Full text fetched for ${fetchedOk}/${fetched.length} top result(s). Every cited source above is tagged with its originating engine.`);
  lines.push("");

  return lines.join("\n");
}
