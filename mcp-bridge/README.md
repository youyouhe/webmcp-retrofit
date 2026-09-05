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
| `WEBMCP_PROTOCOL_TIMEOUT_MS` | `180000` | CDP 协议超时（毫秒） |
| `WEBMCP_TOOL_TIMEOUT_MS` | `0` | tools/call 响应上限（毫秒）；`0`=不设上限。超时只提前回客户端，真正的页面执行仍在队列里跑完，不会与下一个调用交错 |

## 说明
- 只读桥，不伪造工具清单；schema/annotations 由页面自身提供（`readOnlyHint`/`destructiveHint` 等会原样转发给 MCP 客户端）。
- 桥需要目标页**保持打开**（工具随页面存活）——适合人机协作，不适合无人值守 cron（那应走 REST/MCP server）。
- 兼容 Chrome 146–149（`navigator.modelContext`）与 150+（`document.modelContext`），双入口自动探测。
- 桥断开（MCP 客户端退出 / Ctrl-C）时只 `disconnect()` 自己那条 CDP 连接并退出，**不会关掉你手动开着的 Chrome**；无残留僵尸进程。
- 同一时刻页面上只有一个操作（tools/list 与 tools/call 串行），避免并发 evaluate 交错读写应用状态。

## 安全
- **CDP 9222 是无鉴权的**：任何能连到该端口的进程都能驱动整个浏览器（读 cookie、以你身份操作页面）。默认只监听 `127.0.0.1`——**不要**把 9222 暴露到非本机网卡。
- 跨机桥接（反向 SSH 隧道）时，能把 9222 端口转发出去的主机即拥有你浏览器的完全控制权，请只在信任的 agent 主机上这么做。
- `*` 自动发现会挑中"第一个暴露 WebMCP 的页面"——如果你同时开着多个站点，优先用 `WEBMCP_PAGE_URL` 钉死目标，避免 agent 操作错页面。桥每次解析到目标都会在 stderr 打印实际页面 URL，留意它。
