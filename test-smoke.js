// Quick functional smoke test — exercises each engine + fetch_url directly.
import { ENGINES, defaultEngineOrder } from "./src/engines.js";
import { fetchUrl } from "./src/fetcher.js";

const log = (...a) => console.log("[test]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function test() {
  const intlQuery = "anthropic claude api pricing";
  const cnQuery = "中国空间站 最新进展";

  log("defaultEngineOrder(intl):", defaultEngineOrder(intlQuery));
  log("defaultEngineOrder(cn):", defaultEngineOrder(cnQuery));

  // Test each engine with a short query.
  const tests = [
    ["duckduckgo", intlQuery, true],
    ["bing", intlQuery, true],
    ["bingcn", cnQuery, false],
    ["baidu", cnQuery, false],
    ["sogou", cnQuery, false],
    ["so", cnQuery, false],
  ];

  for (const [name, q, intl] of tests) {
    try {
      const t0 = Date.now();
      const r = await ENGINES[name].search(q, { num: 3 });
      const dt = Date.now() - t0;
      log(`${name} [${intl ? "intl/proxy" : "cn/direct"}] -> ${r.length} results (${dt}ms)`);
      r.slice(0, 2).forEach((x) => log("   ", x.title.slice(0, 60), "|", x.url.slice(0, 60)));
      if (r.length === 0) log("   ⚠️  zero results — selector may need adjustment");
    } catch (e) {
      log(`${name} ERROR:`, e?.message || e);
    }
    await sleep(400);
  }

  // Test fetch_url on an intl page (proxy) + a CN page (direct).
  log("\n--- fetch_url tests ---");
  try {
    const f1 = await fetchUrl("https://docs.anthropic.com/en/api/getting-started", { maxChars: 2000 });
    log("intl fetch ok:", f1.ok, "proxy:", f1.useProxy, "title:", (f1.title || "").slice(0, 60), "md.len:", (f1.markdown || "").length);
  } catch (e) { log("intl fetch ERROR:", e?.message); }
  try {
    const f2 = await fetchUrl("https://www.baidu.com", { maxChars: 1000 });
    log("cn fetch ok:", f2.ok, "proxy:", f2.useProxy, "title:", (f2.title || "").slice(0, 60), "md.len:", (f2.markdown || "").length);
  } catch (e) { log("cn fetch ERROR:", e?.message); }
}

test().catch((e) => { console.error("FATAL", e); process.exit(1); });
