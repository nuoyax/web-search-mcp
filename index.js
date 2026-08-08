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
  resolveBaiduRedirect,
} from "./src/engines.js";
import { fetchUrl } from "./src/fetcher.js";
import { deepResearch } from "./src/research.js";

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

    const settled = await Promise.allSettled(
      valid.map(async (k) => {
        const e = ENGINES[k];
        const results = await e.search(query, { num });
        // Resolve baidu redirects in results so links are usable.
        for (const r of results) {
          if (/baidu\.com\/link\?url=/.test(r.url)) {
            try { r.url = await resolveBaiduRedirect(r.url); } catch { /* keep */ }
          }
        }
        return { engine: k, label: e.label, results };
      }),
    );

    const out = [];
    const errs = [];
    settled.forEach((s, i) => {
      if (s.status === "fulfilled") out.push(s.value);
      else errs.push(`${valid[i]}: ${s.reason?.message || s.reason}`);
    });

    const text = formatSearchResults(query, out, errs);
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
  let idx = 1;
  for (const b of batches) {
    if (batches.length > 1) lines.push(`## ${b.label} (${b.results.length})`);
    for (const r of b.results) {
      lines.push(`${idx}. [${r.title || r.url}](${r.url})`);
      if (r.snippet) lines.push(`   ${r.snippet.replace(/\s+/g, " ").slice(0, 240)}`);
      idx++;
    }
    lines.push("");
  }
  if (errors.length) {
    lines.push("## Errors");
    errors.forEach((e) => lines.push("- " + e));
  }
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
      const result = await fetchUrl(url, { maxChars: max_chars });
      if (!result.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: `Fetch failed: ${result.error || "HTTP " + result.status} for ${url}` }],
        };
      }
      const header = [
        `# ${result.title || url}`,
        `URL: ${url}`,
        `Status: ${result.status} | Proxy: ${result.useProxy ? "yes" : "no (direct)"}`,
        "",
      ].join("\n");
      return {
        content: [{ type: "text", text: header + (result.markdown || "") }],
      };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: "text", text: `Fetch error for ${url}: ${e?.message || e}` }],
      };
    }
  },
);

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
      return { content: [{ type: "text", text: header + "\n" + result.report }] };
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
