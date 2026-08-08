// deep_research: multi-engine fan-out → dedup → rank → fetch top → markdown report.

import {
  ENGINES,
  ENGINE_LIST,
  defaultEngineOrder,
  resolveBaiduRedirect,
} from "./engines.js";
import { fetchUrl } from "./fetcher.js";

const MAX_PARALLEL_FETCH = 4;

// Run multiple engines concurrently, tolerating individual failures.
async function runEngines(query, engineKeys, numPerEngine, log) {
  const engines = engineKeys
    .map((k) => ENGINES[k])
    .filter(Boolean);
  const settled = await Promise.allSettled(
    engines.map(async (e) => {
      const results = await e.search(query, { num: numPerEngine });
      return { engine: e.name, label: e.label, results };
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

function dedupe(results) {
  const seen = new Map();
  for (const r of results) {
    const key = normUrl(r.url);
    if (!key) continue;
    const existing = seen.get(key);
    if (existing) {
      // Merge: keep longest snippet, accumulate engine sources.
      if ((r.snippet || "").length > (existing.snippet || "").length) {
        existing.snippet = r.snippet;
      }
      if (!existing.sources.includes(r.engine)) existing.sources.push(r.engine);
      continue;
    }
    seen.set(key, { ...r, sources: [r.engine] });
  }
  return [...seen.values()];
}

// Simple relevance score: query term coverage in title/snippet + multi-engine.
function scoreResult(r, queryTerms) {
  const title = (r.title || "").toLowerCase();
  const snippet = (r.snippet || "").toLowerCase();
  let score = 0;
  for (const t of queryTerms) {
    if (!t) continue;
    if (title.includes(t)) score += 3;
    if (snippet.includes(t)) score += 1;
  }
  score += r.sources.length * 2; // appeared in multiple engines
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

  // Flatten + tag engine.
  const flat = [];
  for (const batch of ok) {
    for (const r of batch.results) {
      flat.push({ ...r, engine: batch.engine });
    }
  }
  log(`raw results=${flat.length}`);

  const deduped = dedupe(flat);
  log(`deduped=${deduped.length}`);

  // Resolve 百度 redirect links before scoring/fetch.
  for (const r of deduped) {
    if (/baidu\.com\/link\?url=/.test(r.url)) {
      try {
        r.url = await resolveBaiduRedirect(r.url);
      } catch {
        /* keep original */
      }
    }
  }

  const queryTerms = query.toLowerCase().split(/\s+/);
  const ranked = deduped
    .map((r) => ({ ...r, score: scoreResult(r, queryTerms) }))
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
      synthesized.push(excerpt + ` [${f.title || f.url}](${f.url})`);
    }
  }
  if (synthesized.length) {
    lines.push(synthesized.join("\n\n"));
  } else {
    lines.push("_No full-text sources could be fetched; see the result list below._");
  }
  lines.push("");

  // All results list.
  lines.push("## Sources");
  ranked.slice(0, 15).forEach((r, i) => {
    const src = r.sources ? ` [${r.sources.join(",")}]` : "";
    lines.push(`${i + 1}. [${r.title || r.url}](${r.url})${src}`);
    if (r.snippet) lines.push(`   ${r.snippet.replace(/\n+/g, " ").slice(0, 240)}`);
  });
  lines.push("");

  // Detailed fetched content (truncated).
  lines.push("## Fetched content");
  for (const f of fetched.filter((x) => x.ok && x.markdown)) {
    lines.push(`### ${f.title || f.url}`);
    lines.push(`URL: ${f.url}`);
    lines.push("");
    const body = f.markdown.slice(0, 2500);
    lines.push(body);
    lines.push("");
  }

  return lines.join("\n");
}
