#!/usr/bin/env node
// web-search MCP server — stdio transport.
// Tools: web_search, fetch_url, deep_research.
// Auto-routes international engines/URLs through the 7890 proxy; CN hosts direct.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  ENGINES,
  ENGINE_LIST,
  defaultEngineOrder,
  resolveBaiduRedirects,
  faviconImg,
  sourcesLabel,
} from "./src/engines.js";
import { fetchUrl } from "./src/fetcher.js";
import { deepResearch, raceToQuorum } from "./src/research.js";
import { cacheGet, cacheGetStale, cacheSet, cacheKey, CACHE_ENABLED } from "./src/cache.js";

const log = (...args) => process.stderr.write("[web-search] " + args.join(" ") + "\n");

const server = new McpServer({
  name: "web-search",
  version: "1.0.0",
});

const ENGINE_NAMES = ENGINE_LIST.map((e) => e.name);

// ---- web_search ----
server.tool(
  "web_search",
  "Search the web across engines. Auto-selects CN or international engines based on the query language; international engines route through the configured proxy. Use engine='all' to fan out across every engine, or specify one (duckduckgo|bing|bingcn|baidu|sogou|so).",
  {
    query: z.string().min(1).describe("Search query"),
    num: z.number().int().min(1).max(30).default(8).describe("Max results (per engine)"),
    engine: z
      .string()
      .default("auto")
      .describe("Engine: auto | all | duckduckgo | bing | bingcn | baidu | sogou | so"),
  },
  async ({ query, num, engine }) => {
    let engineKeys;
    if (engine === "auto") engineKeys = defaultEngineOrder(query).slice(0, 2);
    else if (engine === "all") engineKeys = ENGINE_NAMES.slice();
    else engineKeys = [engine];

    const valid = engineKeys.filter((k) => ENGINES[k]);
    if (!valid.length) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown engine: ${engine}. Available: ${ENGINE_NAMES.join(", ")}` }],
      };
    }

    // Cache lookup. Key excludes nothing user-visible; results from a given
    // (query, num, engine) are stable enough to reuse across the TTL.
    const key = cacheKey("web_search", { query, num, engine });
    const cached = await cacheGet(key);
    if (cached) {
      const ageMin = Math.round(cached.age / 60000);
      log(`web_search cache HIT (age ${ageMin}min) for: ${query}`);
      return {
        content: [
          { type: "text", text: `_cached (age ${ageMin}min, ttl ${Math.round(cached.ttl / 60000)}min)_\n\n${cached.value}` },
        ],
      };
    }

    // Fail-fast fan-out: resolve as soon as a quorum of engines succeeds (or
    // one engine returns ≥ ceil(num/2) results), with a soft deadline so a
    // dead/slow engine (e.g. DDG blocked from the egress IP, timing out at
    // 25s) doesn't gate the fast engine (bing ~460ms). Laggards settle in the
    // background; their eventual failure is logged, not awaited.
    const tasks = valid.map((k) => {
      const e = ENGINES[k];
      const run = async () => {
        const results = await e.search(query, { num });
        // Resolve baidu redirect links in parallel so 8 wrapped links resolve
        // in ~1s (concurrency-capped) instead of ~3.4s serial. The per-host
        // token bucket still paces the actual HTTP — no extra anti-bot risk.
        await resolveBaiduRedirects(results);
        return { engine: k, label: e.label, favicon: e.favicon, results };
      };
      run.engineName = k;
      return { name: k, run };
    });

    const out = [];
    const errs = [];
    const pending = new Map(tasks.map((t) => [t.name, t]));

    await raceToQuorum(
      tasks.map((t) => t.run),
      {
        deadlineMs: 3_500,
        minEngines: Math.min(2, tasks.length),
        minResults: Math.max(1, Math.ceil(num / 2)),
        onSettle: (ev) => {
          const t = tasks[ev.index];
          if (!t) return;
          if (ev.status === "fulfilled" || ev.status === "late-fulfilled") {
            out.push(ev.value);
            pending.delete(t.name);
          } else {
            // rejected / late-rejected
            errs.push(`${t.name}: ${ev.reason?.message || ev.reason}`);
            pending.delete(t.name);
          }
        },
      },
    );

    // Engines still pending at resolve time are "timed out" — record them so
    // the user sees why an expected engine is missing.
    for (const t of pending.values()) {
      errs.push(`${t.name}: timed out (slow engine)`);
    }

    const text = formatSearchResults(query, out, errs);
    if (out.length) cacheSet(key, text, query); // fire-and-forget: don't block response on disk write
    return { content: [{ type: "text", text }] };
  },
);

function formatSearchResults(query, batches, errors) {
  const lines = [`# web_search: ${query}`, ""];
  if (!batches.length) {
    lines.push("_No results from any engine._");
    if (errors.length) lines.push("Errors:\n" + errors.map((e) => "- " + e).join("\n"));
    return lines.join("\n");
  }
  // Per-result source tag so the data origin of every link is explicit.
  let idx = 1;
  for (const b of batches) {
    if (batches.length > 1) {
      const img = b.favicon ? faviconImg(b.engine, b.label) : "";
      lines.push(`## ${img} ${b.label} (${b.results.length})`.trim());
    }
    for (const r of b.results) {
      // Inline favicon + label so each result shows its engine logo.
      const src = b.favicon ? ` ${faviconImg(b.engine, b.label)} [source: ${b.label}]` : ` [source: ${b.label}]`;
      lines.push(`${idx}. [${r.title || r.url}](${r.url})${src}`);
      if (r.snippet) lines.push(`   ${r.snippet.replace(/\s+/g, " ").slice(0, 240)}`);
      idx++;
    }
    lines.push("");
  }
  // Data-source summary: which engines contributed + counts.
  const totalResults = batches.reduce((n, b) => n + b.results.length, 0);
  lines.push(`## Data sources`);
  lines.push(`Retrieved from ${batches.length} engine(s), ${totalResults} result(s) total:`);
  for (const b of batches) {
    const img = b.favicon ? faviconImg(b.engine, b.label) + " " : "";
    lines.push(`- ${img}**${b.label}** — ${b.results.length} result(s)`);
  }
  if (errors.length) {
    lines.push("");
    lines.push(`## Errors`);
    errors.forEach((e) => lines.push("- " + e));
  }
  lines.push("");
  lines.push(`_Each result is tagged with its originating engine in \`[source: …]\`. Verify time-sensitive facts against the cited URL before relying on them._`);
  return lines.join("\n");
}

// ---- fetch_url ----
server.tool(
  "fetch_url",
  "Fetch a URL, strip boilerplate, and return the page content as markdown. International hosts auto-route through the configured proxy; CN hosts (baidu/bing.cn/so/...) go direct.",
  {
    url: z.string().url().describe("URL to fetch"),
    max_chars: z.number().int().min(500).max(50000).default(16000).describe("Max chars of markdown to return"),
  },
  async ({ url, max_chars }) => {
    try {
      // Cache fetched pages by URL (+max_chars) with site-aware TTL.
      const key = cacheKey("fetch_url", { url, max_chars });
      const fresh = await cacheGet(key);

      // Fresh hit: serve immediately.
      if (fresh) {
        const ageMin = Math.round(fresh.age / 60000);
        log(`fetch_url cache HIT (age ${ageMin}min) for: ${url}`);
        return {
          content: [
            { type: "text", text: `_cached (age ${ageMin}min, ttl ${Math.round(fresh.ttl / 60000)}min)_\n\n${fresh.value}` },
          ],
        };
      }

      // Stale-but-validators: drive a conditional revalidation
      // (If-None-Match / If-Modified-Since). On 304 we reuse the cached body
      // and refresh TTL; on a fresh 200 we replace the entry with new validators.
      const stale = await cacheGetStale(key);
      if (stale && stale.value && (stale.etag || stale.lastModified)) {
        const { title, useProxy, markdown, publishedTime } = parseCachedFetch(stale.value);
        const result = await fetchUrl(url, {
          maxChars: max_chars,
          validators: { etag: stale.etag, lastModified: stale.lastModified },
          cachedBody: { title, useProxy, markdown, publishedTime },
        });
        if (result.notModified) {
          const ageMin = Math.round(stale.age / 60000);
          log(`fetch_url 304 NOT MODIFIED (reuse body, age ${ageMin}min) for: ${url}`);
          // Body unchanged; refresh TTL + validators.
          cacheSet(key, stale.value, url, result.validators);
          const header = buildFetchHeader(title || url, url, "304 (revalidated)", useProxy, result.impersonated, publishedTime);
          return { content: [{ type: "text", text: header + markdown }] };
        }
        // Fresh 200 (or fallback) — replace cache + format normally.
        return finishFetch(result, url, key);
      }

      const result = await fetchUrl(url, { maxChars: max_chars });
      return finishFetch(result, url, key);
    } catch (e) {
      return {
        isError: true,
        content: [{ type: "text", text: `Fetch error for ${url}: ${e?.message || e}` }],
      };
    }
  },
);

// Build the fetch_url header block (title/URL/status/proxy/TLS/publishedTime).
// Shared by the fresh-fetch and 304-revalidated paths so the header format
// (including publishedTime) stays consistent and parseable by parseCachedFetch.
function buildFetchHeader(title, url, statusLine, useProxy, impersonated, publishedTime) {
  const tls = impersonated ? "impersonated (curl_cffi)" : "native (undici)";
  const parts = [
    `# ${title}`,
    `URL: ${url}`,
    `Status: ${statusLine} | Proxy: ${useProxy ? "yes" : "no (direct)"} | TLS: ${tls}`,
  ];
  if (publishedTime) parts.push(`Published: ${publishedTime}`);
  parts.push("", "_Data source: fetched directly from the URL above by this MCP server (no third-party search index involved)._", "");
  return parts.join("\n");
}

// Shared finish path: format + cache a (possibly failed) fetch result.
function finishFetch(result, url, key) {
  if (!result.ok) {
    return {
      isError: true,
      content: [{ type: "text", text: `Fetch failed: ${result.error || "HTTP " + result.status} for ${url}` }],
    };
  }
  const statusLine = `${result.status} | Proxy: ${result.useProxy ? "yes" : "no (direct)"} | TLS: ${result.impersonated ? "impersonated (curl_cffi)" : "native (undici)"}`.split(" | ");
  // Reuse buildFetchHeader for format consistency.
  const header = buildFetchHeader(
    result.title || url, url, result.status, result.useProxy, result.impersonated, result.publishedTime,
  );
  const text = header + (result.markdown || "");
  if (result.markdown) cacheSet(key, text, url, result.validators);
  return { content: [{ type: "text", text }] };
}

// Recover the title/useProxy/body/publishedTime from a cached fetch_url text
// blob. The cached blob is exactly what we return to the client (header +
// markdown), so we re-parse the prefix lines we wrote.
function parseCachedFetch(text) {
  const lines = (text || "").split("\n");
  let title = "";
  let useProxy = false;
  let publishedTime = null;
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("# ")) title = l.slice(2).trim();
    else if (l.startsWith("Status:") && /Proxy:\s*yes/.test(l)) useProxy = true;
    else if (l.startsWith("Published:")) publishedTime = l.slice("Published:".length).trim();
    if (l === "") { bodyStart = i + 1; break; }
  }
  const markdown = lines.slice(bodyStart).join("\n");
  return { title, useProxy, markdown, publishedTime };
}

// ---- deep_research ----
server.tool(
  "deep_research",
  "Multi-engine deep research: fan out across engines (auto-selects CN vs international), dedupe + rank results, fetch the top pages, and synthesize a cited markdown report. Use for thorough, multi-source research.",
  {
    query: z.string().min(1).describe("Research question / query"),
    engines: z
      .array(z.string())
      .optional()
      .describe("Engines to use; omit for auto-selection based on query language"),
    num_per_engine: z.number().int().min(1).max(20).default(8),
    fetch_top_k: z.number().int().min(0).max(10).default(4),
    fetch_chars: z.number().int().min(1000).max(20000).default(6000),
  },
  async (args) => {
    try {
      // Cache the synthesized report (cheap to serve; expensive to rebuild).
      const key = cacheKey("deep_research", {
        query: args.query,
        engines: args.engines,
        num_per_engine: args.num_per_engine,
        fetch_top_k: args.fetch_top_k,
        fetch_chars: args.fetch_chars,
      });
      const cached = await cacheGet(key);
      if (cached) {
        const ageMin = Math.round(cached.age / 60000);
        log(`deep_research cache HIT (age ${ageMin}min) for: ${args.query}`);
        return {
          content: [
            { type: "text", text: `_cached (age ${ageMin}min, ttl ${Math.round(cached.ttl / 60000)}min)_\n\n${cached.value}` },
          ],
        };
      }
      const result = await deepResearch(args.query, {
        engines: args.engines,
        numPerEngine: args.num_per_engine,
        fetchTopK: args.fetch_top_k,
        fetchChars: args.fetch_chars,
        log,
      });
      const header = [
        `Query: ${result.query}`,
        `Engines: ${result.engines.join(", ")}`,
        `Raw: ${result.totalRaw} | Dedup: ${result.totalDedup} | Fetched OK: ${result.fetchedCount}`,
        result.errors.length ? `Engine errors: ${result.errors.map((e) => e.engine).join(", ")}` : "",
        "",
      ].filter(Boolean).join("\n");
      const text = header + "\n" + result.report;
      cacheSet(key, text, args.query);
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: "text", text: `deep_research error: ${e?.message || e}` }],
      };
    }
  },
);

// ---- main ----
async function main() {
  log("starting (proxy default: http://127.0.0.1:7890, set PROXY_URL= to override / disable)");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Keep alive — transport handles messages.
}

main().catch((e) => {
  log("fatal:", e?.stack || e);
  process.exit(1);
});
