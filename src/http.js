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

/**
 * Fetch a URL as text with auto proxy routing + redirect following.
 * @returns {Promise<{status:number, headers:object, text:string, url:string, useProxy:boolean}>}
 */
export async function httpGet(url, opts = {}) {
  const { parsed, dispatcher, useProxy } = routeFor(url, opts);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const headers = {
    "User-Agent": opts.userAgent ?? DEFAULT_UA,
    "Accept-Language":
      opts.acceptLanguage ?? "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
    Accept: opts.accept ?? "*/*",
    ...opts.headers,
  };
  if (opts.referer) headers.Referer = opts.referer;

  let currentUrl = parsed.href;
  let visited = new Set();
  let finalRes = null;
  const maxHops = opts.maxRedirections ?? 5;

  for (let hop = 0; hop <= maxHops; hop++) {
    const cur = new URL(currentUrl);
    const { dispatcher, useProxy } = routeFor(currentUrl, opts);
    const res = await request(cur, {
      method: "GET",
      headers,
      dispatcher,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });

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
