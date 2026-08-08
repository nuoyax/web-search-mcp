// fetch_url: download a page, strip boilerplate, convert HTML to markdown.
// Falls back to TLS-impersonating curl_cffi when undici gets 403/blocked.

import * as cheerio from "cheerio";
import TurndownService from "turndown";
import { httpGet, waitForBucket, releaseBucket, coolHost } from "./http.js";
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
// Exported for unit testing of the density fallback (§7.2-F).
export function htmlToMarkdown(text, url, contentType, useProxy, maxChars) {
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
    "script, style, noscript, iframe, nav, footer, header[role=banner], aside, form, button, .ad, .ads, .advertisement, .sidebar, .related, .comments, .comment-list, .share, .social, [aria-hidden=true], .navbox, .vertical-navbox, #p-lang-btn, .vector-dropdown",
  ).remove();

  // Step 1 — try semantic content selectors (fast path). Most-specific first:
  // Wikipedia's Vector skin wraps the article + lang sidebar in <main id="content">,
  // so we drill into #bodyContent (article body only) before the wider main/#content.
  // Generic .content is last so it doesn't shadow better candidates.
  let root = $("#bodyContent, .mw-parser-output").first();
  if (!root.length) {
    root = $(
      "main, article, [role=main], #content, .post-content, .article-content, .entry-content, .content",
    ).first();
  }

  // Step 2 — density-based fallback (shallow text features, Spinkens & Leonhard
  // WSDM 2010 [10.1145/1718487.1718542]; node-characteristics density from
  // Nguyen 2017 [10.5626/jcse.2017.11.2.39]). When the selectors miss we score
  // each candidate block by text density (text chars vs tag overhead) and link
  // density (anchor text share), picking the best contiguous run. This avoids
  // dumping the whole <body> (nav/ad noise) into downstream SimHash/LLM.
  const target = root.length ? root : extractByDensity($, $("body"));

  let html = (target && target.length ? target.html() : null) || $("body").html() || text;

  let md = turndown.turndown(html);
  md = md.replace(/\n{3,}/g, "\n\n").trim();
  if (md.length > maxChars) md = md.slice(0, maxChars) + "\n\n...[truncated]";

  return { ok: true, url, contentType, useProxy, title, markdown: md };
}

// Density-based main-content extraction. Walks block children of the given
// root and scores each by text-to-tag ratio (TTR) — text chars vs outer-HTML
// length — penalising link-heavy blocks (menus, related-posts, comment lists).
//
// The naive "highest TTR" winner is always the deepest text leaf (a bare <p>
// has almost no tag overhead), which would drop the surrounding <h1>/<h2>
// headings and split articles into one paragraph. To prefer a *container* that
// holds the article's structure we score containers above leaves and, on a
// tie, pick the wider container. Leaves are only used when no container clears
// the threshold (e.g. legacy table layouts — HN — where content lives in <td>).
//
// Based on shallow-text-features boilerplate detection [WSDM 2010,
// 10.1145/1718487.1718542] and node-characteristic density estimation
// [JCSE 2017, 10.5626/jcse.2017.11.2.39]. O(n) over block count, no model.
const DENSITY_MIN_TEXT = 80; // ignore blocks with too little text to be "main"
const DENSITY_LINK_PENALTY = 0.5; // anchor-text chars subtracted at half weight
// Lower threshold for table cells: legacy table-layout pages (HN, forums) wrap
// each story row in a <td> with links, so absolute TTR is low (~0.18) even for
// the real content. Containers (div/article) keep the stricter 0.20 floor.
const DENSITY_THRESHOLD = 0.20;
const DENSITY_THRESHOLD_TD = 0.12;
// Containers hold structure (headings + paragraphs); preferred over leaves.
// `td`/`tr` included for legacy table-layout sites (HN, old forums) where the
// article body is wrapped in table cells rather than <article>/<div>.
const CONTAINER_SEL =
  "article, section, div, main, blockquote, td, tr, [role=main]";
// Leaf text blocks — used only when no container qualifies.
const LEAF_SEL = "p, li";

function extractByDensity($, $body) {
  if (!$body || !$body.length) return null;

  let bestContainer = null;
  let bestContainerScore = 0;
  let bestLeaf = null;
  let bestLeafScore = 0;

  // Pass 1: score containers. These hold structure (headings + paragraphs) so
  // they're preferred — winning here means we keep the <h1> with the <p>.
  // Also picks up table-cell content on legacy layouts.
  //
  // Tag-aware threshold: <td>/<tr> on legacy table layouts (HN, old forums)
  // carry more link overhead per cell, so they get a relaxed floor. div/article
  // etc. keep the strict threshold.
  $body.find(CONTAINER_SEL).each((_, el) => {
    const $el = $(el);
    const tag = el.tagName;
    const plain = ($el.text() || "").replace(/\s+/g, " ").trim();
    if (plain.length < DENSITY_MIN_TEXT) return;
    const outer = $el.html() || "";
    if (!outer.length) return;

    let anchorText = 0;
    $el.find("a").each((__, a) => {
      anchorText += ($(a).text() || "").length;
    });
    const adjustedText = plain.length - anchorText * DENSITY_LINK_PENALTY;
    const score = adjustedText / outer.length; // TTR-style density
    const threshold = tag === "td" || tag === "tr" ? DENSITY_THRESHOLD_TD : DENSITY_THRESHOLD;

    // Track the best *qualifying* container. A good content container has both
    // high density AND low link share (menu/related blocks are link-heavy).
    // We pick by density, but a block whose text is mostly anchor text is
    // disqualified regardless of score (catches mega-menus that happen to clear
    // the TTR floor because their anchor text is long).
    //
    // `td`/`tr` get a relaxed density floor (legacy table layouts) but a
    // *stricter* link-share cap, since link-list pages on table layouts
    // (HN stories, forum index) are almost entirely anchor text.
    const linkShare = anchorText / plain.length;
    const linkCap = tag === "td" || tag === "tr" ? 0.35 : 0.5;
    const isMenu = linkShare > linkCap; // mostly links ⇒ nav/menu/related
    if (score >= threshold && !isMenu) {
      if (!bestContainer || plain.length > bestContainer._plainLen) {
        bestContainerScore = score;
        bestContainer = $el;
        bestContainer._plainLen = plain.length;
      }
    }
  });

  // Pass 2: score leaf text blocks. Only relevant if no container cleared the
  // threshold — a page where the article is bare <p>/<li> with no wrapper.
  $body.find(LEAF_SEL).each((_, el) => {
    const $el = $(el);
    const plain = ($el.text() || "").replace(/\s+/g, " ").trim();
    if (plain.length < DENSITY_MIN_TEXT) return;
    const outer = $el.html() || "";
    if (!outer.length) return;

    let anchorText = 0;
    $el.find("a").each((__, a) => {
      anchorText += ($(a).text() || "").length;
    });
    const linkShare = anchorText / plain.length;
    const adjustedText = plain.length - anchorText * DENSITY_LINK_PENALTY;
    const score = adjustedText / outer.length;

    // Same menu guard as containers: a <p> that is 90% links is a nav blurb,
    // not article text.
    if (linkShare > 0.5) return;

    if (score > bestLeafScore) {
      bestLeafScore = score;
      bestLeaf = $el;
    }
  });

  // Prefer a container that cleared its tag-aware threshold (keeps headings);
  // fall back to a leaf only if no container qualified.
  if (bestContainer) {
    delete bestContainer._plainLen; // don't leak the stash into the node
    return bestContainer;
  }
  if (bestLeaf && bestLeafScore >= DENSITY_THRESHOLD) return bestLeaf;
  return null;
}

// Acquire the per-host token bucket around a curl_cffi call so the TLS
// fallback shares the SAME politeness as the undici path. Hard-case hosts
// (HARDCASE_HOSTS) are the most aggressively rate-limited — without this, the
// deep_research semaphore (concurrency 4) could fire 4 concurrent curl_cffi
// processes at one host and trip the very anti-bot signal we're avoiding.
// Exported so engine adapters (e.g. Brave, which speaks curl_cffi natively)
// can reuse the same per-host throttling.
export async function curlFetchThrottled(url, opts) {
  const host = hostKeyFor(url);
  await waitForBucket(host, opts);
  try {
    return await curlFetch(url, opts);
  } finally {
    releaseBucket(host);
  }
}

function hostKeyFor(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return url; }
}

/**
 * Fetch a URL and return cleaned-up markdown + metadata.
 * Strategy: undici first (fast, native). On 403/blocked, or for sites known
 * to require browser TLS fingerprinting, retry via curl_cffi impersonation.
 *
 * Conditional revalidation: pass {cachedBody, validators} in opts. When the
 * cached entry is stale the caller sends the stored ETag/Last-Modified; if
 * the origin returns 304 we reuse `cachedBody` and report notModified=true so
 * the cache entry can be refreshed (TTL bumped) without re-parsing.
 *
 * @param {string} url
 * @param {object} opts { maxChars?: number, validators?: {etag,lastModified}, cachedBody?: {title,markdown,useProxy} }
 */
export async function fetchUrl(url, opts = {}) {
  const maxChars = opts.maxChars ?? 16_000;
  const { validators } = opts;

  // Fast path: undici unless this host is known to need impersonation.
  if (!needsImpersonation(url)) {
    try {
      const { text, status, contentType, useProxy, notModified, headers } = await httpGet(url, {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        timeoutMs: 25_000,
        maxRedirections: 5,
        validators,
      });

      // 304 Not Modified: cached representation is still valid. Reuse the
      // cached body and surface validators so the caller can refresh TTL.
      if (notModified && opts.cachedBody) {
        const cb = opts.cachedBody;
        const markdown = cb.markdown.length > maxChars
          ? cb.markdown.slice(0, maxChars) + "\n\n...[truncated]"
          : cb.markdown;
        return {
          ok: true,
          status: 304,
          url,
          title: cb.title || "",
          markdown,
          useProxy: cb.useProxy ?? false,
          notModified: true,
          validators: pickValidators(headers),
        };
      }

      if (status < 400) {
        const md = htmlToMarkdown(text, url, contentType, useProxy, maxChars);
        return { status, ...md, notModified: false, validators: pickValidators(headers) };
      }

      // 403 / 429 → try impersonation fallback (if available).
      if ((status === 403 || status === 429) && (await curlAvailable())) {
        const imp = await curlFetchThrottled(url, opts);
        if (imp.ok && imp.status != null && imp.status < 400) {
          return { status: imp.status, impersonated: true, ...htmlToMarkdown(imp.text, url, imp.headers?.["content-type"] || "text/html", true, maxChars), notModified: false, validators: pickValidators(imp.headers) };
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
        const imp = await curlFetchThrottled(url, opts);
        if (imp.ok && imp.status < 400) {
          return { status: imp.status, impersonated: true, ...htmlToMarkdown(imp.text, url, imp.headers?.["content-type"] || "text/html", true, maxChars), notModified: false, validators: pickValidators(imp.headers) };
        }
      }
      throw e;
    }
  }

  // Known hard-case host: go straight to curl_cffi.
  if (await curlAvailable()) {
    const imp = await curlFetchThrottled(url, opts);
    if (imp.ok && imp.status < 400) {
      // curl_cffi returns 304 only if it followed a conditional request; we
      // don't pass validators to curl_cffi, so treat any success as a fresh 200.
      return { status: imp.status, impersonated: true, ...htmlToMarkdown(imp.text, url, imp.headers?.["content-type"] || "text/html", true, maxChars), notModified: false, validators: pickValidators(imp.headers) };
    }
    return { ok: false, status: imp.status || 0, url, error: imp.error || "curl_cffi failed", markdown: "" };
  }

  // curl_cffi not installed: best-effort undici attempt anyway.
  const { text, status, contentType, useProxy, headers } = await httpGet(url, {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    timeoutMs: 25_000,
    maxRedirections: 5,
    validators,
  });
  if (status >= 400) return { ok: false, status, url, error: `HTTP ${status} (curl_cffi not installed for impersonation)`, markdown: "" };
  const md = htmlToMarkdown(text, url, contentType, useProxy, maxChars);
  return { status, ...md, notModified: status === 304, validators: pickValidators(headers) };
}

// Extract cacheable validators from a response's headers. We store ETag and
// Last-Modified so a later expired read can revalidate cheaply (304 reuse).
function pickValidators(headers) {
  if (!headers) return undefined;
  const get = (k) => {
    const v = headers[k] ?? headers[k.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };
  const etag = get("etag");
  const lastModified = get("last-modified");
  const v = {};
  if (etag) v.etag = etag;
  if (lastModified) v.lastModified = lastModified;
  return Object.keys(v).length ? v : undefined;
}
