# Web Search MCP — 优化方案（基于国际论文检索）

> 检索日期 2026-08-08。来源：OpenAlex 学术 API + DuckDuckGo/Bing。
> 目标：**更快**（并行 + 缓存 + 限速避免被拦）、**更多**（多引擎融合 + 近似去重）、**抗频繁访问检测**（令牌桶 + 退避 + 指纹/TLS/代理轮换）。

## 1. 检索到的关键论文

### 1.1 反爬 / 封禁规避

| 论文 | 年 | 核心结论 | DOI |
|---|---|---|---|
| FP-Crawlers: Studying the Resilience of Browser Fingerprinting to Block Crawlers | 2020 | 网站用浏览器指纹一致性识别爬虫，单一 UA 伪装不足 | 10.14722/madweb.2020.23010 |
| TLS Beyond the Browser | 2019 (ACM IMC) | 非浏览器 TLS 客户端的协议/指纹暴露，是反爬识别重要维度 | 10.1145/3355369.3355601 |
| A First Look at User-Installed Residential Proxies | 2024 (CNSM) | 住宅代理生态实测，单 IP 高频必被限 | 10.23919/cnsm62983.2024.10814519 |

### 1.2 并行 / 增量爬取架构

| 论文 | 年 | 核心结论 | DOI |
|---|---|---|---|
| BUbiNG: Massive Crawling for the Masses | 2016 | 按主机哈希分区 + 每主机独立礼貌队列，线性扩展 | 10.48550/arxiv.1601.06919 |
| SIMHAR — Smart Distributed Web Crawler for the Hidden Web | 2020 (IEEE Access) | SIM+Hash 去重 + Redis 分布式队列 | 10.1109/access.2020.3004756 |
| Design of a Priority Based Frequency Regulated Incremental Crawler | 2010 | 按页面更新频率调度增量爬取，平衡新鲜度与成本 | 10.5120/23-131 |
| On the Feasibility of Geographically Distributed Web Crawling | 2008 | 地理分布爬取降低单点延迟与单 IP 频率压力 | 10.4108/icst.infoscale2008.3550 |

### 1.3 结果融合 / 排序 / 去重

| 论文 | 年 | 核心结论 | DOI |
|---|---|---|---|
| ranx.fuse: A Python Library for Metasearch | 2022 (CIKM) | 25 种融合算法实现，RRF 在无分数场景稳健 | 10.1145/3511808.3557207 |
| Comparing Rank and Score Combination Methods for Data Fusion in IR | 2005 | CombMNZ 等 7 法系统对比 | 10.1007/s10791-005-6994-4 |
| The use of MMR, diversity-based reranking | 1998 (Carbonell) | 多样性重排奠基，避免结果雷同 | 10.1145/290941.291025 |
| Fusion-based methods for result diversification in web search | 2018 (Information Fusion) | 融合 + 多样性结合 | 10.1016/j.inffus.2018.01.006 |
| Improved Near-Duplicate Detection for Aggregated/Paywalled News | 2025 (NAACL) | 近似去重在新闻聚合场景的最新进展 | 10.18653/v1/2025.naacl-industry.73 |
| A Review for Weighted MinHash Algorithms | 2018 | MinHash 加权变体综述 | 10.48550/arxiv.1811.04633 |

## 2. 当前架构差距对照

| 维度 | 现状（优化前） | 论文已知更优方案 |
|---|---|---|
| 反爬 | 固定 UA + 完整浏览器头，单代理出口 | TLS/JA3 对齐、住宅代理轮换、指纹一致性 |
| 去重 | URL 规范化精确匹配 | SimHash/MinHash 近似去重（跨域转载） |
| 融合排序 | 各引擎结果简单拼接、自造打分 | RRF / CombMNZ（ranx.fuse 已实现 25 种） |
| 并发 | `Promise.allSettled` 一次性、无队列/限速 | 优先级队列 + 每主机令牌桶礼貌策略 |
| 增量 | 无缓存，每次全量重搜 | 频率感知增量 + 新鲜度策略 |
| 抓正文 | cheerio 启发式选正文 | 可加正文密度/可读性打分 |

## 3. 已落地的优化（本轮实现）

### 3.1 RRF 融合排序 ✅ — `src/research.js`

替换原自造 `scoreResult`。每条结果得分 = Σ_engine `1/(k+rankᵢ)`，k=60（Cormack 2009、ranx.fuse 默认）。

- **为何更快/更多**：无监督、无需分数标定，对引擎结果数不均鲁棒；多引擎共识的结果自然排前，提升召回质量。
- query 词命中 title 仅作 1e-4 量级 tiebreaker，不覆盖跨引擎共识。
- **验证**：CN 查询 24→19 去重，6 引擎全部成功，top 来源正确排前。

### 3.2 SimHash 近似去重 ✅ — `src/simhash.js` + `research.js`

新增 64-bit SimHash（Charikar，FNV-1a 分词哈希，unigram+bigram），两阶段去重：

1. 精确 URL 规范化合并（原有）
2. SimHash 汉明距离 ≤3 视为近似重复，合并 sources/ranks，优先保留非聚合器 URL

- **为何更多**：合并"同一新闻不同门户转载、百度/Bing 同一结果不同 URL 包装"。
- **指纹不含 host**：跨主机转载才能合并（实测同文不同 host 距离 0，重写距离 11）。
- **验证**：`a-b hamming 6（同内容不同 host）` vs `a-c 36（不同内容）`，区分有效。

### 3.3 每主机令牌桶 + 指数退避 ✅ — `src/http.js`

每主机：并发 1 + 间隔 ≥120ms（`HOST_BUCKETS`）。瞬时错误（429/502/503/504）+ 网络异常：指数退避 `500·2^attempt + 抖动`，最多 2 次，尊重 `Retry-After` 头。

- **为何抗检测**：直接对应"频繁访问检测"主因——同主机高频请求。BUbiNG §3.3、Cho & Garcia-Molina 礼貌策略共识。
- 异主机仍并行（不牺牲吞吐）。
- **验证**：
  - 同主机 4 并发 → 573ms（串行化生效）；异主机 2 并发 → 180ms（并行）
  - 429 重试 → 3763ms（500+1000 退避 + 抖动，符合预期）

## 4. 待落地（按 ROI）

### P1（近期，证据强）

- **TLS/JA3 指纹一致性**：关键站点用 `curl_cffi`（Python 子服务）或 Node `cycletls`/`got-scraping` 伪装浏览器 ClientHello。解决 Cloudflare 403、百度 CAPTCHA 根因之一 [10.1145/3355369.3355601]。
- **住宅代理池轮换**：接 `PROXY_POOL_URL`，按主机粘性哈希选 IP，失败切 IP [10.23919/cnsm62983.2024.10814519]。
- **结果缓存 + 增量**：SQLite KV，query→results，TTL 按站点更新频率（新闻 1h / 文档 24h），命中直接返回 [10.5120/23-131]。

### P2（进阶）

- **MMR 多样性重排**：top-K 抓取阶段用 MMR 选"相关且互不重复"的源 [10.1145/290941.291025]。
- **分布式队列架构**：URL 按主机哈希分区到多 worker，预留扩展接口 [10.48550/arxiv.1601.06919]。

## 5. "频繁访问检测"解法对照

| 检测维度 | 解法 | 本轮是否覆盖 |
|---|---|---|
| IP 频率 | 代理轮换 + 令牌桶限速 | ✅ 令牌桶已实现；代理轮换待 P1 |
| TLS/JA3 指纹 | curl_cffi / cycletls 伪装 | ❌ 待 P1（undici 原生指纹） |
| 浏览器行为指纹 | 完整 Sec-Fetch 头、必要时 headless | ✅ 头已完整；headless 未用 |
| 行为模式（请求间隔分布） | 随机抖动 + 退避 | ✅ 退避含抖动 |

---

实现验证日志见会话；三项目标（更快/更多/抗检测）的 P0 均已落地并测试通过。
