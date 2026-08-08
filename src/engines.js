// Search-engine adapters. Each returns an array of {title, url, snippet}.
// International engines (duckduckgo, google, bing intl) auto-route through
// the proxy; CN engines (baidu, sogou, so/360, bing-cn) go direct.

import * as cheerio from "cheerio";
import { httpGet } from "./http.js";

export const ENGINES = {
  duckduckgo: {
    name: "duckduckgo",
    label: "DuckDuckGo",
    international: true,
    search: searchDuckDuckGo,
  },
  bing: {
    name: "bing",
    label: "Bing (International)",
    international: true,
    search: searchBingIntl,
  },
  baidu: {
    name: "baidu",
    label: "百度",
    international: false,
    search: searchBaidu,
  },
  sogou: {
    name: "sogou",
    label: "搜狗",
    international: false,
    search: searchSogou,
  },
  so: {
    name: "so",
    label: "360搜索",
    international: false,
    search: searchSo,
  },
  bingcn: {
    name: "bingcn",
    label: "Bing 中国版",
    international: false,
    search: searchBingCN,
  },
};

export const ENGINE_LIST = Object.values(ENGINES);

function isCjk(query) {
  // If the query contains CJK characters, treat as CN-oriented.
  return /[一-鿿぀-ヿ가-힯]/.test(query);
}

// Pick a sensible default engine order based on the query language.
export function defaultEngineOrder(query) {
  const cjk = isCjk(query);
  if (cjk) return ["bingcn", "baidu", "so", "sogou", "duckduckgo", "bing"];
  return ["duckduckgo", "bing", "bingcn", "baidu"];
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
  const $ = cheerio.load(text);
  const out = [];
  // 百度 may serve a CAPTCHA interstitial when it suspects bots. Detect and bail.
  if (/wappass\.百度\.com\/static\/captcha|wappass\.baidu\.com\/static\/captcha/i.test(text)) {
    throw new Error("Baidu returned CAPTCHA interstitial (anti-spider)");
  }
  // 百度 results: .result / .c-container
  $(".result.c-container, .c-container").each((_, el) => {
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
    const { text, status } = await httpGet(baiduUrl, {
      forceDirect: true,
      maxRedirections: 0,
      timeoutMs: 10_000,
    });
    if (status >= 300 && status < 400) return baiduUrl; // no Location exposed here
    const m = /URL=['"]?(https?:\/\/[^'"\s<>]+)/i.exec(text);
    if (m) return m[1];
    const m2 = /window\.location\.replace\(["']?(https?:\/\/[^"')\s]+)/i.exec(text);
    if (m2) return m2[1];
    return baiduUrl;
  } catch {
    return baiduUrl;
  }
}

export { isCjk };
