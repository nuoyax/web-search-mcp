// fetch_url: download a page, strip boilerplate, convert HTML to markdown.

import * as cheerio from "cheerio";
import TurndownService from "turndown";
import { httpGet } from "./http.js";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "_",
});
turndown.remove(["script", "style", "noscript", "iframe", "svg", "nav", "footer", "form", "button"]);

/**
 * Fetch a URL and return cleaned-up markdown + metadata.
 * @param {string} url
 * @param {object} opts { maxChars?: number }
 */
export async function fetchUrl(url, opts = {}) {
  const maxChars = opts.maxChars ?? 16_000;
  const { text, status, contentType, useProxy } = await httpGet(url, {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    timeoutMs: 25_000,
    maxRedirections: 5,
  });

  if (status >= 400) {
    return { ok: false, status, url, error: `HTTP ${status}`, markdown: "" };
  }

  const ct = (contentType || "").toLowerCase();
  const isHtml = ct.includes("html") || /^\s*<!doctype html|<html/i.test(text);

  if (!isHtml) {
    // Non-HTML: return raw text, truncated.
    const body = text.length > maxChars ? text.slice(0, maxChars) + "\n...[truncated]" : text;
    return {
      ok: true,
      status,
      url,
      contentType,
      useProxy,
      title: "",
      markdown: body,
    };
  }

  const $ = cheerio.load(text);
  const title = $("title").first().text().trim() || $('meta[property="og:title"]').attr("content") || "";

  // Remove boilerplate.
  $(
    "script, style, noscript, iframe, nav, footer, header[role=banner], aside, form, button, .ad, .ads, .advertisement, .sidebar, .related, .comments, .comment-list, .share, .social, [aria-hidden=true]",
  ).remove();

  // Pick the densest content container if main/article exists, else body.
  const root = $("main, article, [role=main], .post-content, .article-content, .entry-content, .content").first();
  const target = root.length ? root : $("body");
  let html = target.html() || $("body").html() || text;

  let md = turndown.turndown(html);
  // Collapse excessive blank lines.
  md = md.replace(/\n{3,}/g, "\n\n").trim();
  if (md.length > maxChars) md = md.slice(0, maxChars) + "\n\n...[truncated]";

  return {
    ok: true,
    status,
    url,
    contentType,
    useProxy,
    title,
    markdown: md,
  };
}
