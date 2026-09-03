# webmcp-retrofit-bridge

Generic **stdio MCP bridge**: whatever WebMCP tools a page registers on
`document.modelContext` appear natively in your MCP client (Claude Code / Cursor / …).
Page-agnostic — no hardcoded tool list. The bridge connects to a browser via
**CDP** and proxies the page's registry (`tools/list` / `tools/call`).

```
MCP client ──stdio── this server ──CDP(9222)── Chrome(WebMCP) ── any WebMCP page
```

## 1. 准备一个带 WebMCP + CDP 的浏览器

Chrome ≥ 146（`document.modelContext` 在 150+ 挂到 `document` 上）。

- 一次性：地址栏 `chrome://flags/#enable-webmcp-testing` → **Enabled** → Relaunch
- 用以下方式启动并**打开目标页**（务必先完全退出已开的 Chrome，否则新参数不生效）：
  - macOS
    `/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 <你的页面URL>`
  - Windows
    `"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 <你的页面URL>`
  - Linux
    `google-chrome --remote-debugging-port=9222 <你的页面URL>`

页面必须是安全上下文（`https://` 或 `localhost`）——LAN IP 直连不会有 `modelContext`。

## 2. 注册到 Claude Code

```bash
claude mcp add <名字> \
  -e WEBMCP_PAGE_URL=<目标页 URL 子串，如 https://connector.smartbid.site> \
  -- npx -y webmcp-retrofit-bridge
```

`WEBMCP_PAGE_URL` 可留空用 `*` 自动发现第一个暴露 WebMCP 的页面。其它环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `WEBMCP_BROWSER_URL` | `http://127.0.0.1:9222` | CDP 端点 |
| `WEBMCP_PAGE_URL` | `*` | 页面 URL 子串匹配；`*`=自动发现 |
| `WEBMCP_SERVER_NAME` | `webmcp-bridge` | MCP 服务器名 |

## 说明
- 只读桥，不伪造工具清单；schema 由页面自身提供。
- 桥需要目标页**保持打开**（工具随页面存活）——适合人机协作，不适合无人值守 cron（那应走 REST/MCP server）。
