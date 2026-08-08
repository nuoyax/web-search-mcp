// fetch_url: download a page, strip boilerplate, convert HTML to markdown.
// Falls back to TLS-impersonating curl_cffi when undici gets 403/blocked.

import * as cheerio from "cheerio";
import TurndownService from "turndown";
import { httpGet } from "./http.js";
import { curlFetch, curlAvailable, needsImpersonation } from "./tlsbypass.js";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "_",
});
turndown.remove(["script", "style", "noscript", "iframe", "svg", "nav", "footer", "form", "button"]);

// Parse HTML into {title, markdown}; shared between the undici and curl_cffi
// code paths so both go through identical boilerplate stripping.
function htmlToMarkdown(text, url, contentType, useProxy, maxChars) {
  const ct = (contentType || "").toLowerCase();
  const isHtml = ct.includes("html") || /^\s*<!doctype html|<html/i.test(text);

  if (!isHtml) {
    const body = text.length > maxChars ? text.slice(0, maxChars) + "\n...[truncated]" : text;
    return { ok: true, url, contentType, useProxy, title: "", markdown: body };
  }

  const $ = cheerio.load(text);
  const title = $("title").first().text().trim() || $('meta[property="og:title"]').attr("content") || "";

  // Remove boilerplate.
  $(
    "script, style, noscript, iframe, nav, footer, header[role=banner], aside, form, button, .ad, .ads, .advertisement, .sidebar, .related, .comments, .comment-list, .share, .social, [aria-hidden=true]",
  ).remove();

  const root = $("main, article, [role=main], .post-content, .article-content, .entry-content, .content").first();
  const target = root.length ? root : $("body");
  let html = target.html() || $("body").html() || text;

  let md = turndown.turndown(html);
  md = md.replace(/\n{3,}/g, "\n\n").trim();
  if (md.length > maxChars) md = md.slice(0, maxChars) + "\n\n...[truncated]";

  return { ok: true, url, contentType, useProxy, title, markdown: md };
}

/**
 * Fetch a URL and return cleaned-up markdown + metadata.
 * Strategy: undici first (fast, native). On 403/blocked, or for sites known
 * to require browser TLS fingerprinting, retry via curl_cffi impersonation.
 * @param {string} url
 * @param {object} opts { maxChars?: number }
 */
export async function fetchUrl(url, opts = {}) {
  const maxChars = opts.maxChars ?? 16_000;

  // Fast path: undici unless this host is known to need impersonation.
  if (!needsImpersonation(url)) {
    try {
      const { text, status, contentType, useProxy } = await httpGet(url, {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        timeoutMs: 25_000,
        maxRedirections: 5,
      });

      if (status < 400) {
        return { status, ...htmlToMarkdown(text, url, contentType, useProxy, maxChars) };
      }

      // 403 / 429 → try impersonation fallback (if available).
      if ((status === 403 || status === 429) && (await curlAvailable())) {
        const imp = await curlFetch(url, opts);
        if (imp.ok && imp.status != null && imp.status < 400) {
          return { status: imp.status, impersonated: true, ...htmlToMarkdown(imp.text, url, imp.headers?.["content-type"] || "text/html", true, maxChars) };
        }
        // curl_cffi also got blocked — report the impersonated status so the
        // caller sees the real (non-undici) response code, not "HTTP 403" from undici.
        if (imp.ok && imp.status != null) {
          return { ok: false, status: imp.status, impersonated: true, url, error: `HTTP ${imp.status} (even with TLS impersonation)`, markdown: "" };
        }
      }

      return { ok: false, status, url, error: `HTTP ${status}`, markdown: "" };
    } catch (e) {
      // Network error — also try impersonation fallback before giving up.
      if (await curlAvailable()) {
        const imp = await curlFetch(url, opts);
        if (imp.ok && imp.status < 400) {
          return { status: imp.status, impersonated: true, ...htmlToMarkdown(imp.text, url, imp.headers?.["content-type"] || "text/html", true, maxChars) };
        }
      }
      throw e;
    }
  }

  // Known hard-case host: go straight to curl_cffi.
  if (await curlAvailable()) {
    const imp = await curlFetch(url, opts);
    if (imp.ok && imp.status < 400) {
      return { status: imp.status, impersonated: true, ...htmlToMarkdown(imp.text, url, imp.headers?.["content-type"] || "text/html", true, maxChars) };
    }
    return { ok: false, status: imp.status || 0, url, error: imp.error || "curl_cffi failed", markdown: "" };
  }

  // curl_cffi not installed: best-effort undici attempt anyway.
  const { text, status, contentType, useProxy } = await httpGet(url, {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    timeoutMs: 25_000,
    maxRedirections: 5,
  });
  if (status >= 400) return { ok: false, status, url, error: `HTTP ${status} (curl_cffi not installed for impersonation)`, markdown: "" };
  return { status, ...htmlToMarkdown(text, url, contentType, useProxy, maxChars) };
}
