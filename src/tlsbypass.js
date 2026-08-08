// curl_cffi bridge: TLS/JA3 + HTTP/2 fingerprint spoofing fallback.
//
// Node's undici uses a non-browser TLS ClientHello AND a non-browser HTTP/2
// settings frame. Modern anti-bot stacks (Cloudflare, Akamai) fingerprint
// BOTH — JA3/JA4 over the ClientHello and H2 settings over SETTINGS /
// WINDOW_UPDATE. curl_cffi's `impersonate: "chrome"` aligns the two jointly,
// which is why it succeeds where undici gets 403.
//
// To avoid a wasted "doomed undici probe" (a request that is certain to 403
// and that itself is a suspicious signal), hard-case hosts listed below go
// STRAIGHT to curl_cffi via needsImpersonation() — fetchUrl never tries
// undici on them first.
//
// Ref: "TLS Beyond the Browser" (ACM IMC 2019, 10.1145/3355369.3355601) —
// non-browser TLS clients are fingerprintable; H2 fingerprinting is the
// modern complement (Akamai H2 fingerprinting, industry consensus).

import { spawn } from "node:child_process";
import { PROXY_URL, isDirectHost } from "./http.js";

// Sites known to need TLS+H2 impersonation (403 / interstitial on plain
// undici). Add aggressively-protected hosts here to skip the doomed undici
// probe entirely. Plain undici is still the fast path for everything else.
const HARDCASE_HOSTS = [
  "docs.anthropic.com",
  "platform.claude.com",
  "anthropic.com",
];

export function needsImpersonation(url) {
  let host = "";
  try { host = new URL(url).hostname; } catch { return false; }
  return HARDCASE_HOSTS.some((h) => host === h || host.endsWith("." + h));
}

// Tiny Python script: GET a URL via curl_cffi with browser impersonation,
// print status + headers + body as a length-prefixed JSON blob on stdout.
const PY_SCRIPT = `
import sys, json
try:
    from curl_cffi import requests as r
except Exception as e:
    json.dump({"ok": False, "error": "curl_cffi unavailable: " + str(e)}, sys.stdout)
    sys.exit(0)

url, proxy, ua = sys.argv[1], sys.argv[2] or None, sys.argv[3]
try:
    kwargs = {"impersonate": "chrome", "timeout": 25, "allow_redirects": True}
    if proxy:
        kwargs["proxies"] = {"http": proxy, "https": proxy}
    if ua:
        kwargs["headers"] = {"User-Agent": ua}
    resp = r.get(url, **kwargs)
    out = {
        "ok": True,
        "status": resp.status_code,
        "url": str(resp.url),
        "text": resp.text,
        "headers": dict(resp.headers),
    }
except Exception as e:
    out = {"ok": False, "error": str(e)}
sys.stdout.write(json.dumps(out))
`;

function pythonBin() {
  // Prefer python, fall back to python3.
  return process.platform === "win32" ? "python" : "python3";
}

/**
 * Fetch a URL with TLS impersonation via curl_cffi.
 * Returns {ok, status, url, text, headers, impersonated:true}.
 */
export function curlFetch(url, opts = {}) {
  return new Promise((resolve) => {
    // Decide proxy the same way http.js does.
    let host = "";
    try { host = new URL(url).hostname; } catch { /* */ }
    const useProxy = opts.forceProxy ? true
      : opts.forceDirect ? false
      : !isDirectHost(host);
    const proxy = useProxy ? PROXY_URL : null;

    const args = ["-c", PY_SCRIPT, url, proxy || "", opts.userAgent || ""];
    const child = spawn(pythonBin(), args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    const to = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* */ }
      resolve({ ok: false, error: "curl_cffi timeout", impersonated: true });
    }, opts.timeoutMs ?? 30_000);
    child.on("close", () => {
      clearTimeout(to);
      try {
        const parsed = JSON.parse(out);
        resolve({ ...parsed, impersonated: true });
      } catch {
        resolve({ ok: false, error: err || `curl_cffi produced no JSON (out ${out.length}b)`, impersonated: true });
      }
    });
    child.on("error", (e) => {
      clearTimeout(to);
      resolve({ ok: false, error: String(e?.message || e), impersonated: true });
    });
  });
}

export function curlAvailable() {
  // Quick check: is curl_cffi importable? Cached after first call.
  if (curlAvailable._checked) return Promise.resolve(curlAvailable._ok);
  return new Promise((resolve) => {
    const child = spawn(pythonBin(), ["-c", "from curl_cffi import requests"], {
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    child.on("close", (code) => {
      curlAvailable._checked = true;
      curlAvailable._ok = code === 0;
      resolve(curlAvailable._ok);
    });
    child.on("error", () => {
      curlAvailable._checked = true;
      curlAvailable._ok = false;
      resolve(false);
    });
  });
}
