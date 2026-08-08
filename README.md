# web-search MCP server

自建的 Web 搜索 MCP server。多引擎（国内 + 国际自动切换代理），三个工具：`web_search` / `fetch_url` / `deep_research`。

## 引擎

| 引擎 | 区域 | 路由 |
|------|------|------|
| duckduckgo | 国际 | 走代理 `127.0.0.1:7890` |
| bing | 国际 | 走代理 |
| bingcn (Bing 中国版) | 国内 | 直连 |
| baidu | 国内 | 直连 |
| sogou | 国内 | 直连（移动端 + 桌面端双 fallback，绕过反爬） |
| so (360) | 国内 | 直连 |

查询含中日韩字符 → 默认优先国内引擎；纯拉丁字符 → 默认优先国际引擎。`engine='all'` 时全部并发。

## 工具

- **web_search** `{query, num?, engine?}` — engine: `auto`(默认) | `all` | `duckduckgo|bing|bingcn|baidu|sogou|so`
- **fetch_url** `{url, max_chars?}` — 抓页面正文转 markdown，自动按域名判定代理/直连
- **deep_research** `{query, engines?, num_per_engine?, fetch_top_k?, fetch_chars?}` — 多引擎并发 → 去重排序 → 抓取正文 → 生成带引用的 markdown 报告

## 在 Claude Code 中接入

项目级（已生成 `.mcp.json`）：

```json
{
  "mcpServers": {
    "web-search": {
      "command": "node",
      "args": ["D:\\agents\\web_search\\index.js"],
      "env": { "PROXY_URL": "http://127.0.0.1:7890" }
    }
  }
}
```

或用户级，`claude mcp add`：

```bash
claude mcp add web-search -- node D:/agents/web_search/index.js
```

设 `PROXY_URL=""` 可禁用代理（如已开全局 VPN）。

## 运行 / 测试

```bash
npm install
node index.js            # 启动 MCP server（stdio）
node test-smoke.js       # 各引擎 + fetch 冒烟测试
```

## 依赖

- `@modelcontextprotocol/sdk` — MCP server SDK
- `undici` — HTTP（ProxyAgent + decompress interceptor，手动跟随 3xx 以便逐跳重新路由代理/直连）
- `cheerio` — HTML 解析
- `turndown` — HTML → markdown

## 说明 / 已知限制

- 所有网络请求 20-25s 超时，不会卡死。
- 百度偶尔触发验证码拦截（返回 CAPTCHA 页），此时该引擎报错，`deep_research` 自动用其他引擎兜底。
- Bing 国际版结果链接是 `bing.com/ck/a` 跳转 wrapper，从结果块的 `<cite>` 还原真实 URL。
- DuckDuckGo 用 `html.duckduckgo.com/html/` 免 key HTML 端点，需走代理。
