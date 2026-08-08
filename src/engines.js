// Search-engine adapters. Each returns an array of {title, url, snippet}.
// International engines (duckduckgo, google, bing intl) auto-route through
// the proxy; CN engines (baidu, sogou, so/360, bing-cn) go direct.

import * as cheerio from "cheerio";
import { httpGet, isHostCooling } from "./http.js";
import { curlFetchThrottled } from "./fetcher.js";
import { curlAvailable } from "./tlsbypass.js";

export const ENGINES = {
  duckduckgo: {
    name: "duckduckgo",
    label: "DuckDuckGo",
    international: true,
    favicon: "https://duckduckgo.com/favicon.ico",
    search: searchDuckDuckGo,
  },
  brave: {
    name: "brave",
    label: "Brave",
    international: true,
    favicon: "https://search.brave.com/static/favicon.ico",
    search: searchBrave,
  },
  wikipedia: {
    name: "wikipedia",
    label: "Wikipedia",
    international: true,
    favicon: "https://en.wikipedia.org/static/favicon/wikipedia.ico",
    search: searchWikipedia,
  },
  bing: {
    name: "bing",
    label: "Bing (International)",
    international: true,
    favicon: "https://www.bing.com/favicon.ico",
    search: searchBingIntl,
  },
  baidu: {
    name: "baidu",
    label: "百度",
    international: false,
    favicon: "https://www.baidu.com/favicon.ico",
    search: searchBaidu,
  },
  sogou: {
    name: "sogou",
    label: "搜狗",
    international: false,
    favicon: "https://www.sogou.com/favicon.ico",
    search: searchSogou,
  },
  so: {
    name: "so",
    label: "360搜索",
    international: false,
    favicon: "https://www.so.com/favicon.ico",
    search: searchSo,
  },
  bingcn: {
    name: "bingcn",
    label: "Bing 中国版",
    international: false,
    favicon: "https://cn.bing.com/favicon.ico",
    search: searchBingCN,
  },
};

export const ENGINE_LIST = Object.values(ENGINES);

// Render an engine favicon as inline markdown image, sized for inline display.
// Favicon ICOs are small; renders as a 1em icon in markdown viewers that
// respect the width attribute, and as raw `![label](url)` text in terminals
// (where images can't be displayed, so the label reads as the engine name).
export function faviconImg(name, label) {
  const e = ENGINES[name];
  if (!e || !e.favicon) return "";
  const alt = label || e.label || name;
  return `![${alt}](${e.favicon})`;
}

// Resolve a list of engine names to a compact "logo + label" string, e.g.
// "![DuckDuckGo](...) DuckDuckGo" or for multiple: "🦆DuckDuckGo, 百度".
// Used in [source: …] tags and the data-sources summary.
export function sourcesLabel(names) {
  const list = (names || []).filter(Boolean);
  if (!list.length) return "";
  return list
    .map((n) => {
      const e = ENGINES[n];
      const img = e?.favicon ? faviconImg(n, e.label) : "";
      return e ? `${img} ${e.label}` : n;
    })
    .join(", ");
}

function isCjk(query) {
  // If the query contains CJK characters, treat as CN-oriented.
  return /[一-鿿぀-ヿ가-힯]/.test(query);
}

// Pick a sensible default engine order based on the query language.
// Intl: lead with Brave + Wikipedia (free, currently reachable from the
// egress IP) then Bing; DuckDuckGo last as a best-effort fallback (it's
// currently IP-blocked from this host — fail-fast neutralizes its failure).
// CN: domestic engines first, Wikipedia (zh) tail for concept recall.
export function defaultEngineOrder(query) {
  const cjk = isCjk(query);
  if (cjk) return ["bingcn", "baidu", "so", "sogou", "wikipedia", "brave", "duckduckgo", "bing"];
  return ["brave", "wikipedia", "bing", "bingcn", "baidu", "duckduckgo"];
}

// ---------- DuckDuckGo (HTML endpoint, no API key) ----------
async function searchDuckDuckGo(query, { num = 10 } = {}) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const { text, status } = await httpGet(url, {
    forceProxy: true,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    headers: { "Upgrade-Insecure-Requests": "1" },
    timeoutMs: 25_000,
  });
  if (status >= 400) throw new Error(`DuckDuckGo HTTP ${status}`);
  const $ = cheerio.load(text);
  const results = [];
  $(".result, .web-result, .results_links").each((_, el) => {
    if (results.length >= num) return false;
    const a = $(el).find(".result__a, a.result__a").first();
    const title = a.text().trim();
    let href = a.attr("href") || "";
    // DuckDuckGo wraps links in /l/?uddg=...
    const u = href.match(/uddg=([^&]+)/);
    if (u) href = decodeURIComponent(u[1]);
    const snippet = $(el).find(".result__snippet").text().trim();
    if (title && href) results.push({ title, url: href, snippet });
  });
  return results;
}

// ---------- Brave (curl_cffi, TLS-impersonated HTML) ----------
// Brave is the one free international HTML engine currently reachable from
// this host's egress IP (DuckDuckGo/Google/Startpage/Mojeek are all blocked
// or JS-walled from here). It returns ~20 results/page, but rate-limits
// aggressively (~5 req/min → 429). We handle that with:
//   1. A wide per-host minInterval (12s ≈ 5/min) via the token bucket.
//   2. A 60s circuit breaker — tlsbypass.curlFetch calls coolHost() on 429,
//      and we check isHostCooling() up front to short-circuit to a
//      "rate-limited" failure instead of firing a request certain to 429
//      (which would both waste a slot AND burn more of the rate budget).
//   3. fail-fast fan-out (raceToQuorum) demotes a rate-limited Brave to the
//      other engines (Wikipedia/Bing) for that query.
// Requires curl_cffi (falls back to a clear error if unavailable).
export async function searchBrave(query, { num = 10 } = {}) {
  const host = "search.brave.com";
  if (isHostCooling(host)) {
    throw new Error("Brave rate-limited (cooling down, try another engine)");
  }
  if (!(await curlAvailable())) {
    throw new Error("Brave needs curl_cffi (TLS impersonation) which is not installed");
  }
  const url = `https://${host}/search?q=${encodeURIComponent(query)}&source=web`;
  const res = await curlFetchThrottled(url, {
    timeoutMs: 20_000,
    minIntervalMs: 12_000, // ~5 req/min cap; the token bucket enforces this
    headers: {
      Referer: `https://${host}/`,
      "Accept-Language": isCjk(query) ? "zh-CN,zh;q=0.9,en;q=0.8" : "en-US,en;q=0.9",
    },
  });
  if (res.blocked) {
    throw new Error("Brave returned 429 (rate-limited); cooling 60s");
  }
  if (!res.ok || !res.text) {
    throw new Error(`Brave fetch failed: ${res.error || "no body"}`);
  }
  return parseBraveResults(res.text, num);
}

// Parse Brave SERP HTML into results. Pure (no network) so it's unit-testable
// against a fixture. Brave wraps each result in `<div class="snippet"
// data-pos="N" data-type="web">` with the first `<a href=EXTERNAL_URL>` holding
// the target link; its inner `.title` (or text) is the title, and
// `.snippet-description` is the blurb.
export function parseBraveResults(html, num) {
  const $ = cheerio.load(html);
  const out = [];
  $("div[data-pos][data-type='web'], div[data-pos]").each((_, el) => {
    if (out.length >= num) return false;
    const $el = $(el);
    // The first external <a> in the block is the result link; Brave's own
    // nav/anchor links are relative or brave.com — skip those.
    let a = null;
    let href = "";
    $el.find("a").each((__, anchor) => {
      const h = $(anchor).attr("href") || "";
      if (!href && /^https?:\/\//.test(h) && !/brave\.com/i.test(h)) {
        href = h;
        a = $(anchor);
        return false;
      }
      return true;
    });
    if (!href) return;
    const title = (a?.find(".title").text() || a?.text() || "").trim();
    const snippet = $el.find(".snippet-description, .snippet-content").first().text().trim().replace(/\s+/g, " ");
    if (title) out.push({ title, url: href, snippet });
  });
  return out;
}

// ---------- Wikipedia (free MediaWiki API, no key, no anti-bot) ----------
// Wikipedia's action=query&list=search API is completely free, requires no key,
// and (unlike every HTML search engine from this egress IP) has no anti-bot
// rate limiting — 8 rapid calls all returned 200 in testing. It's the stable
// backbone for international concept queries. Not a general web search
// (encyclopedic only), but zero-cost to include and raises recall for
// technical/conceptual/historical queries. Uses zh.wikipedia.org for CJK.
export async function searchWikipedia(query, { num = 10 } = {}) {
  const host = isCjk(query) ? "zh.wikipedia.org" : "en.wikipedia.org";
  const url =
    `https://${host}/w/api.php?action=query&list=search` +
    `&srsearch=${encodeURIComponent(query)}&srlimit=${num}&format=json`;
  const { text, status } = await httpGet(url, {
    forceProxy: true,
    accept: "application/json",
    timeoutMs: 20_000,
  });
  if (status >= 400) throw new Error(`Wikipedia HTTP ${status}`);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Wikipedia returned non-JSON response");
  }
  const search = data?.query?.search;
  if (!Array.isArray(search)) return [];
  const proto = `https://${host}`;
  const out = [];
  for (const r of search) {
    if (out.length >= num) break;
    const title = (r.title || "").trim();
    if (!title) continue;
    // MediaWiki title → canonical URL path (spaces → underscores, URL-encoded).
    const path = "/wiki/" + encodeURIComponent(title.replace(/ /g, "_"));
    // sr.snippet has <span class="searchmatch">…</span> highlights; strip them.
    const snippet = (r.snippet || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    out.push({ title, url: proto + path, snippet });
  }
  return out;
}

// ---------- Bing (international) ----------
async function searchBingIntl(query, { num = 10 } = {}) {
  const url =
    `https://www.bing.com/search?q=${encodeURIComponent(query)}` +
    `&count=${num}&setmkt=en-US&setlang=en-US&cc=US`;
  const { text, status } = await httpGet(url, {
    forceProxy: true,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    headers: {
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
    },
    timeoutMs: 25_000,
  });
  if (status >= 400) throw new Error(`Bing HTTP ${status}`);
  return parseBingResults(text, num);
}

// ---------- Bing 中国版 (direct) ----------
async function searchBingCN(query, { num = 10 } = {}) {
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${num}`;
  const { text, status } = await httpGet(url, {
    forceDirect: true,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    headers: {
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
    },
    timeoutMs: 25_000,
  });
  if (status >= 400) throw new Error(`BingCN HTTP ${status}`);
  return parseBingResults(text, num);
}

// Bing wraps result links in https://www.bing.com/ck/a?!...&u=<base64url-of-internal-path>
// The displayed <cite> holds the real, human-readable target URL — reconstruct it.
function citeToUrl(cite) {
  if (!cite) return "";
  // cite uses " › " as path separator and may show "host › path › ...".
  const parts = cite.split(/\s*[››]\s*/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return "";
  let host = parts[0];
  const path = parts.slice(1).join("/");
  // cite sometimes already includes the scheme.
  if (/^https?:\/\//.test(host)) return path ? host + "/" + path : host;
  return `https://${host}${path ? "/" + path : ""}`;
}

function parseBingResults(html, num) {
  const $ = cheerio.load(html);
  const out = [];
  $("#b_results > li.b_algo, li.b_algo").each((_, el) => {
    if (out.length >= num) return false;
    const a = $(el).find("h2 a").first();
    const title = a.text().trim();
    const href = a.attr("href") || "";
    const cite = $(el).find("cite").first().text().trim();
    // Prefer the reconstructed cite URL over Bing's ck/a redirect wrapper.
    const url = cite ? citeToUrl(cite) : href;
    const snippet = $(el)
      .find(".b_caption p, .b_lineclamp4, p")
      .first()
      .text()
      .trim()
      .replace(/\s+/g, " ");
    if (title && url) out.push({ title, url, snippet });
  });
  return out;
}

// Parse 百度 SERP HTML into results. Pure (no network) so it can be unit-tested
// against CAPTCHA fixtures without hitting the network. Shared by the desktop
// search path; throwing here surfaces engine failures (esp. CAPTCHA) so the
// caller's Promise.allSettled marks 百度 as failed instead of silently
// succeeding with 0 results (which would distort RRF/dedup/reports).
export function parseBaiduResults(text, num) {
  const $ = cheerio.load(text);

  // 百度 serves several CAPTCHA/safety-verification interstitials when it
  // suspects bots. All of them are 200 with a tiny body and 0 result nodes,
  // which used to look like "succeeded with 0 results" — silently misleading.
  // Detect and bail so the engine is reported as failed.
  //
  // Two-track detection to avoid false-positives on real SERPs:
  //  (a) wappass.baidu.com URL — only ever present on CAPTCHA pages, so a
  //      standalone match is authoritative.
  //  (b) The newer "百度安全验证" page — the string alone can appear in a real
  //      result snippet, so require ALL of: 0 result nodes AND a tiny body
  //      (<4KB). A real SERP — even one with 0 matches for an obscure query —
  //      is a full page (nav/footer/related) well over 10KB; only the
  //      interstitial is ~1.4KB.
  const isCaptcha =
    /wappass\.(baidu|百度)\.com\/static\/captcha/i.test(text) ||
    /百度安全验证|安全验证|wappass\.baidu\.com/i.test(text);
  const resultNodes = $(".result.c-container, .c-container");
  if (isCaptcha && (resultNodes.length === 0 || text.length < 4000)) {
    throw new Error("Baidu returned CAPTCHA/safety-verification interstitial (anti-spider)");
  }

  // 百度 results: .result / .c-container
  const out = [];
  resultNodes.each((_, el) => {
    if (out.length >= num) return false;
    const a = $(el).find("h3 a").first();
    const title = a.text().trim();
    let href = a.attr("href") || "";
    // Some 百度 results embed the real URL in data attr or mu; prefer those.
    const mu = $(el).attr("mu") || $(el).attr("data-url") || "";
    if (mu && /^https?:\/\//.test(mu)) href = mu;
    const snippet = $(el)
      .find(".c-abstract, [class*='content-right'], span.content-right_8Zs40")
      .first()
      .text()
      .trim()
      .replace(/\s+/g, " ");
    if (title && href) out.push({ title, url: href, snippet, needsBaiduRedirect: !mu });
  });
  return out;
}

// ---------- 百度 (direct) ----------
async function searchBaidu(query, { num = 10 } = {}) {
  const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=${num}`;
  const { text, status } = await httpGet(url, {
    forceDirect: true,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    headers: {
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Cache-Control": "max-age=0",
    },
    timeoutMs: 25_000,
  });
  if (status >= 400) throw new Error(`Baidu HTTP ${status}`);
  return parseBaiduResults(text, num);
}

// ---------- 搜狗 (direct) ----------
async function searchSogou(query, { num = 10 } = {}) {
  // Sogou's /web endpoint 302s to an anti-spider page for plain requests.
  // Try the mobile web endpoint first; if it redirects to anti-spider, fall
  // back to parsing the desktop endpoint via a direct fetch (still tolerates
  // a 302 — we just won't have results).
  const attempts = [
    {
      url: `https://m.sogou.com/web/searchList.jsp?keyword=${encodeURIComponent(query)}&page=1`,
      ua:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
        "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    },
    {
      url: `https://www.sogou.com/web?query=${encodeURIComponent(query)}&num=${num}`,
      ua:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    },
  ];
  let lastErr;
  for (const attempt of attempts) {
    try {
      const { text, status } = await httpGet(attempt.url, {
        forceDirect: true,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        userAgent: attempt.ua,
        headers: { "Upgrade-Insecure-Requests": "1" },
        timeoutMs: 25_000,
      });
      if (status >= 400) {
        lastErr = new Error(`Sogou HTTP ${status}`);
        continue;
      }
      if (/antispider|antip=web/i.test(text)) {
        lastErr = new Error("Sogou anti-spider interstitial");
        continue;
      }
      const $ = cheerio.load(text);
      const out = [];
      $(
        ".vrwrap, .results .vrwrap, .rb, .news-list li, .results li, li.vrwrap, .space-txt-link",
      ).each((_, el) => {
        if (out.length >= num) return false;
        const a = $(el).find("a").first();
        let title = a.text().trim();
        if (!title) title = $(el).find("h3, .vr-title, .vr-title a, .space-txt").text().trim();
        let href = a.attr("href") || "";
        if (href && href.startsWith("//")) href = "https:" + href;
        const snippet = $(el)
          .find(".str_info, .s-p, p, .ft, .news-text")
          .first()
          .text()
          .trim()
          .replace(/\s+/g, " ");
        if (title && href) out.push({ title, url: href, snippet });
      });
      if (out.length) return out;
      lastErr = new Error("Sogou returned 0 results (selector miss)");
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Sogou failed");
}

// ---------- 360 搜索 (direct) ----------
async function searchSo(query, { num = 10 } = {}) {
  const url = `https://www.so.com/s?q=${encodeURIComponent(query)}&pn=1&ps=${num}`;
  const { text, status } = await httpGet(url, {
    forceDirect: true,
    accept: "text/html,application/xhtml+xml",
    timeoutMs: 25_000,
  });
  if (status >= 400) throw new Error(`so.com HTTP ${status}`);
  const $ = cheerio.load(text);
  const out = [];
  $(".result, .res-list").each((_, el) => {
    if (out.length >= num) return false;
    const a = $(el).find("h3 a").first();
    const title = a.text().trim();
    const href = a.attr("href") || "";
    const snippet = $(el).find(".res-desc, p, .desc").first().text().trim().replace(/\s+/g, " ");
    if (title && href) out.push({ title, url: href, snippet });
  });
  return out;
}

// Resolve 百度 redirect link (baidu.com/link?url=...) to the real target.
export async function resolveBaiduRedirect(baiduUrl) {
  if (!/baidu\.com\/link\?url=/.test(baiduUrl)) return baiduUrl;
  try {
    // maxRedirections:0 → a 302 returns the Location header without following.
    // Prefer the Location header (authoritative) before falling back to regex
    // on the body (older mobile endpoints sometimes return a JS/meta refresh).
    const { text, status, headers } = await httpGet(baiduUrl, {
      forceDirect: true,
      maxRedirections: 0,
      timeoutMs: 10_000,
    });
    if (status >= 300 && status < 400 && headers?.location) {
      return headers.location;
    }
    if (status >= 300 && status < 400) return baiduUrl; // 3xx w/o Location
    const m = /URL=['"]?(https?:\/\/[^'"\s<>]+)/i.exec(text);
    if (m) return m[1];
    const m2 = /window\.location\.replace\(["']?(https?:\/\/[^"')\s]+)/i.exec(text);
    if (m2) return m2[1];
    return baiduUrl;
  } catch {
    return baiduUrl;
  }
}

// Resolve the baidu-wrapped links in a result batch in parallel. The per-host
// token bucket (http.js) still serializes the actual HTTP calls to baidu
// (1 concurrent + 120ms interval), so fanning out at the call site does NOT
// raise the request rate baidu sees — it just pipelines the await chain so 8
// redirects resolve in ~1s instead of ~3.4s serial. `resolver` is injectable
// for unit tests (defaults to resolveBaiduRedirect). Concurrency capped at 4
// to match deep_research's MAX_PARALLEL_FETCH; the bucket is the real guard.
export async function resolveBaiduRedirects(results, { concurrency = 4, resolver = resolveBaiduRedirect } = {}) {
  const wrapped = results.filter((r) => /baidu\.com\/link\?url=/.test(r.url));
  if (!wrapped.length) return results;

  // Tiny semaphore: gate promise creation so at most `concurrency` redirects
  // are in flight. Each redirect resolves independently (errors keep the
  // original wrapped url); we await all of them before returning.
  let active = 0;
  const waiters = [];
  const acquire = () =>
    active < concurrency
      ? (active++, Promise.resolve())
      : new Promise((r) => waiters.push(r));
  const release = () => {
    const next = waiters.shift();
    if (next) next();
    else active--;
  };

  await Promise.all(
    wrapped.map(async (r) => {
      await acquire();
      try {
        r.url = await resolver(r.url);
      } catch {
        /* keep original wrapped url */
      } finally {
        release();
      }
    }),
  );
  return results;
}

export { isCjk };
