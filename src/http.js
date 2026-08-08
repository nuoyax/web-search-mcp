// HTTP layer with automatic proxy routing for CN vs international hosts.
// CN hosts (baidu/sogou/so/bing.cn/...) go direct; international hosts go
// through the 7890 proxy when PROXY_URL is set (default per CLAUDE.md).

import { request, Agent, ProxyAgent, interceptors } from "undici";

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Set PROXY_URL="" to force-disable proxying (e.g. when already on a VPN).
const PROXY_URL = process.env.PROXY_URL ?? "http://127.0.0.1:7890";

const DEFAULT_TIMEOUT_MS = 20_000;

// Hosts reached directly (CN networks / no proxy). Suffix match covers subdomains.
const DIRECT_HOSTS = [
  "cn",
  "baidu.com",
  "baiducontent.com",
  "sogou.com",
  "sogoucdn.com",
  "so.com",
  "haosou.com",
  "bing.com",
  "cn.bing.com",
  "cc.bingj.com",
  "sohu.com",
  "sina.com.cn",
  "163.com",
  "qq.com",
  "weibo.com",
  "zhihu.com",
  "douban.com",
  "taobao.com",
  "jd.com",
  "tianyancha.com",
  "aliyun.com",
  "aliyuncs.com",
  "tsinghua.edu.cn",
  "pku.edu.cn",
  "gov.cn",
];

export function isDirectHost(hostname) {
  const h = (hostname || "").toLowerCase();
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".local")) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  return DIRECT_HOSTS.some((d) => h === d || h.endsWith("." + d));
}

// undici v7: transparent gzip/br/deflate decompression via interceptor.
// Redirects are handled manually in httpGet (so we can re-route proxy/direct
// per hop), so we only attach the decompress interceptor here.
const DECOMPRESS_INTERCEPTOR = interceptors.decompress();
const AGENT_INTERCEPTORS = [DECOMPRESS_INTERCEPTOR];

// Lazy singletons — created only when first needed.
let _directAgent = null;
let _proxyAgent = null;
function directDispatcher() {
  if (!_directAgent) {
    _directAgent = new Agent({
      connect: { timeout: 10_000 },
      keepAliveTimeout: 10_000,
      keepAliveMaxTimeout: 30_000,
      interceptors: AGENT_INTERCEPTORS,
    });
  }
  return _directAgent;
}
function proxyDispatcher() {
  if (!PROXY_URL) return null;
  if (!_proxyAgent) {
    _proxyAgent = new ProxyAgent({
      uri: PROXY_URL,
      requestTls: { timeout: 10_000 },
      connect: { timeout: 10_000 },
      keepAliveTimeout: 10_000,
      interceptors: AGENT_INTERCEPTORS,
    });
  }
  return _proxyAgent;
}

// Decide CN-direct vs international-proxy for a URL.
function routeFor(url, opts = {}) {
  const parsed = new URL(url);
  const host = parsed.hostname;
  let useProxy;
  if (opts.forceProxy) useProxy = true;
  else if (opts.forceDirect) useProxy = false;
  else useProxy = !isDirectHost(host);
  const dispatcher = useProxy ? proxyDispatcher() : directDispatcher();
  return { parsed, dispatcher, useProxy };
}

// ---- Per-host politeness: token bucket + exponential backoff on retries ----
// Limits concurrency and request rate per hostname so we don't trip
// frequency-based anti-bot detection (consensus crawling-politeness policy,
// e.g. BUbiNG §3.3; Cho & Garcia-Molina, "Effective Web Crawling").
//
// One bucket per host: max `capacity` in-flight, refilled to capacity after
// `minIntervalMs` of host-idle. In practice we serialize per host (capacity=1)
// plus a small inter-request delay, which is the safest default for scraping.

const HOST_BUCKETS = new Map();

function hostKey(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return url; }
}

function acquireBucket(host) {
  let b = HOST_BUCKETS.get(host);
  if (!b) {
    b = {
      queue: [],
      active: 0,
      lastReqAt: 0,
    };
    HOST_BUCKETS.set(host, b);
  }
  return b;
}

// Default politeness: 1 concurrent req per host, ≥120ms between requests to
// the same host. Override per-call via opts.politeness.
const DEFAULT_MAX_CONCURRENCY = 1;
const DEFAULT_MIN_INTERVAL_MS = 120;

function waitForBucket(host, opts) {
  const b = acquireBucket(host);
  const maxConc = opts.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const minInterval = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;

  return new Promise((resolve) => {
    const tryAcquire = () => {
      const now = Date.now();
      const sinceLast = now - b.lastReqAt;
      const need = b.active >= maxConc ? false : sinceLast >= minInterval;
      if (need) {
        b.active++;
        b.lastReqAt = now;
        resolve();
      } else {
        // re-check when either a slot frees or the interval elapses.
        const waitMs = Math.max(0, minInterval - sinceLast);
        b.queue.push(tryAcquire);
        if (b.active < maxConc) {
          // idle waiting on interval; schedule a wake
          setTimeout(() => {
            const fn = b.queue.shift();
            if (fn) fn();
          }, waitMs);
        }
      }
    };
    tryAcquire();
  });
}

function releaseBucket(host) {
  const b = HOST_BUCKETS.get(host);
  if (!b) return;
  b.active = Math.max(0, b.active - 1);
  const next = b.queue.shift();
  if (next) next();
}

// Sleep helper that tolerates falsy ms.
function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

// Parse a Retry-After header (seconds or HTTP-date). Returns ms or null.
function parseRetryAfter(value) {
  if (!value) return null;
  const n = Number(value);
  if (!Number.isNaN(n)) return n * 1000;
  const d = Date.parse(value);
  if (!Number.isNaN(d)) return Math.max(0, d - Date.now());
  return null;
}

// Statuses that signal "back off and retry" rather than a hard failure.
function isTransient(status) {
  return status === 429 || status === 503 || status === 502 || status === 504;
}

/**
 * Fetch a URL as text with auto proxy routing + redirect following +
 * per-host politeness (token bucket) + exponential backoff on transient
 * errors (429/5xx).
 * @returns {Promise<{status:number, headers:object, text:string, url:string, useProxy:boolean}>}
 */
export async function httpGet(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = opts.retries ?? 2;

  const headers = {
    "User-Agent": opts.userAgent ?? DEFAULT_UA,
    "Accept-Language":
      opts.acceptLanguage ?? "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
    Accept: opts.accept ?? "*/*",
    ...opts.headers,
  };
  if (opts.referer) headers.Referer = opts.referer;

  let currentUrl = url;
  let visited = new Set();
  let finalRes = null;
  const maxHops = opts.maxRedirections ?? 5;

  for (let hop = 0; hop <= maxHops; hop++) {
    const cur = new URL(currentUrl);
    const host = cur.hostname.toLowerCase();
    const { dispatcher, useProxy } = routeFor(currentUrl, opts);

    let res = null;
    let attempt = 0;
    // Retry loop with exponential backoff for transient statuses.
    while (true) {
      await waitForBucket(host, opts);
      try {
        res = await request(cur, {
          method: "GET",
          headers,
          dispatcher,
          headersTimeout: timeoutMs,
          bodyTimeout: timeoutMs,
        });
      } catch (e) {
        releaseBucket(host);
        // Network errors (timeout/reset) are transient too.
        if (attempt < maxRetries) {
          const backoff = 500 * Math.pow(2, attempt) + Math.floor(Math.random() * 150);
          await sleep(backoff);
          attempt++;
          continue;
        }
        throw e;
      }
      releaseBucket(host);

      if (isTransient(res.statusCode) && attempt < maxRetries) {
        // Drain before retrying.
        try { if (res.body) await res.body.dump(); } catch { /* ignore */ }
        const retryAfter = parseRetryAfter(res.headers?.["retry-after"]);
        const backoff = retryAfter ?? 500 * Math.pow(2, attempt) + Math.floor(Math.random() * 150);
        await sleep(backoff);
        attempt++;
        continue;
      }
      break;
    }

    const headerObj = {};
    for (const [k, v] of Object.entries(res.headers || {})) headerObj[k] = v;

    const status = res.statusCode;
    const location = headerObj.location;

    // Follow 3xx redirects manually so we can re-route proxy/direct per hop.
    if (
      location &&
      [300, 301, 302, 303, 307, 308].includes(status) &&
      hop < maxHops
    ) {
      // Drain body to free the connection.
      try { if (res.body) await res.body.dump(); } catch { /* ignore */ }
      const next = new URL(location, cur).href;
      if (visited.has(next)) {
        // redirect loop — stop here
        finalRes = { status, headers: headerObj, text: "", url: currentUrl, useProxy, contentType: headerObj["content-type"] || "" };
        break;
      }
      visited.add(next);
      currentUrl = next;
      continue;
    }

    let text = "";
    if (res.body) {
      const buf = await res.body.arrayBuffer();
      text = decodeBuffer(buf, headerObj["content-type"]);
    }
    finalRes = {
      status,
      headers: headerObj,
      text,
      url: currentUrl,
      useProxy,
      contentType: headerObj["content-type"] || "",
    };
    break;
  }

  if (!finalRes) {
    finalRes = { status: 0, headers: {}, text: "", url: currentUrl, useProxy: false, contentType: "" };
  }
  return finalRes;
}

// Best-effort decode: prefer declared charset, fall back to utf-8.
function decodeBuffer(buf, contentType) {
  const ab = buf instanceof ArrayBuffer ? buf : buf.buffer;
  const bytes = new Uint8Array(ab);
  let charset = "";
  if (contentType) {
    const m = /charset=([\w-]+)/i.exec(contentType);
    if (m) charset = m[1];
  }
  if (!charset) {
    // sniff <meta charset=...> from first 1KB
    const head = new TextDecoder("utf-8", { fatal: false }).decode(
      bytes.subarray(0, 1024),
    );
    const m = /charset=["']?([\w-]+)/i.exec(head);
    if (m) charset = m[1];
  }
  charset = (charset || "utf-8").toLowerCase();
  if (charset === "utf-8" || charset === "utf8") {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
  if (/gbk|gb2312|gb18030/.test(charset)) {
    try {
      // Node has built-in iconv-lite-like support via util? No — use TextDecoder.
      // TextDecoder supports 'gbk' in Node.
      return new TextDecoder("gbk", { fatal: false }).decode(bytes);
    } catch {
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    }
  }
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

export { DEFAULT_UA, PROXY_URL };
