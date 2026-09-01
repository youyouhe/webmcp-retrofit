# WebMCP Retrofit Toolkit

把任意现有 Web 应用改造成 **AI agent 可直接操作**的完整工具包：一套经过实战验证的方法论（Claude Code Skill）+ 一个通用的 stdio MCP 桥 + 浏览器启动脚本。

> WebMCP（Web Model Context Protocol）是 W3C 孵化中的开放标准（OpenAI / Chrome 推动）：网页通过 `document.modelContext` 把自身能力注册为标准化工具，AI agent 打开页面即可发现并直接调用——从「模拟点击」进化到「直接调用」。

## Why — 为什么需要这套东西

WebMCP 的规范只定义了机制（`registerTool` 的形状），没告诉你怎么改造一个真实应用。踩过完整一遍坑（[StoryFlow](https://github.com/youyouhe/StoryFlow)，一个 local-first 剧本编辑器，从零到三层消费路径全通）之后沉淀下来的经验：

- **工具要包能力函数，不包 UI 事件** —— execute 里调 `generateContinuation()`，不是模拟 Alt+C
- **同屏性靠走应用的状态管线** —— 工具 → setState/store dispatch，框架响应式自动刷新，零额外实时基建
- **三个能让你当场白屏的注册陷阱** —— effect 清理返回 null、StrictMode 双挂载竞态、hooks 在 early-return 之后
- **Chrome 实现的兼容坑** —— `getTools()` 的 `inputSchema` 返回的是 JSON 字符串不是对象
- **两个浏览器世界** —— agent 附着的浏览器 ≠ 用户眼前的浏览器，数据世界完全隔离

这些不会出现在规范文档里，但会出现在你的 bug 列表里。

## What's Inside

```
SKILL.md                    方法论（预检 + 7 阶段 + 验收清单 + 踩坑实录，含标准状态快照与自我进化规则）
mcp-bridge/                 通用 stdio MCP 桥（页面无关）
  ├─ index.mjs              代理任意 WebMCP 页面的注册表 → tools/list 原生带 schema
  ├─ test-client.mjs        端到端回归测试
  └─ package.json
scripts/
  └─ webmcp-chromium.sh     带 --enable-features=WebMCP 的浏览器启动器
                            （CDP 9222 / snap 兼容 / 无显示自动 headless）
```

### 通用桥（mcp-bridge）

零硬编码工具清单——指着任何暴露 WebMCP 工具的页面，它的工具就原生出现在你的 MCP 客户端（Claude Code / Cursor / 任何 MCP client）里：

```bash
cd mcp-bridge && npm install

# 起一个带 WebMCP 的浏览器（打开你的应用页面）
../scripts/webmcp-chromium.sh http://localhost:5173/

# 注册桥（每个站点一个实例，-e 钉死目标页）
claude mcp add myapp -e WEBMCP_PAGE_URL=localhost:5173 -- node ./mcp-bridge/index.mjs
```

环境变量：`WEBMCP_BROWSER_URL`（默认 `http://127.0.0.1:9222`）、`WEBMCP_PAGE_URL`（URL 子串匹配，`*` 为自动发现）、`WEBMCP_SERVER_NAME`。

### 方法论 Skill

七阶段改造流程：

```
预检（标准自检+官方实现扫描）→ 0 适配判断 → 1 能力盘点 → 2 状态桥接 → 3 工具设计
→ 4 注册与生命周期 → 5 测试夹具 → 6 消费端 → 7 验收清单
```

安装为 Claude Code 个人 skill（所有项目可用）：

```bash
git clone https://github.com/youyouhe/webmcp-retrofit.git
mkdir -p ~/.claude/skills
cp -r webmcp-retrofit ~/.claude/skills/webmcp-retrofit
# 之后在任何项目里说「给这个应用做 WebMCP 改造」即可
```

## 快速判断：你的应用该不该用 WebMCP

| 应用形态 | 结论 |
|---|---|
| local-first / BYOK / 状态在浏览器 | **唯一解**（没有 API 可包） |
| 有后端 + 用户在场协作 | 叠层：页面工具借用户会话调 REST |
| 无人值守自动化（cron） | 做不到（工具随页面存活）→ REST + MCP server |

硬性红线：**页面必须在安全上下文**（localhost / HTTPS）——LAN IP 直连（`http://192.168.x.x`）下 `modelContext` 不存在。

## English Blurb

A battle-tested toolkit for retrofitting web apps with WebMCP: a 7-phase methodology (as a Claude Code skill) covering capability inventory, state bridging, tool design and registration pitfalls (StrictMode races, null cleanups, schema-string quirks), plus a generic stdio MCP bridge that proxies any page's WebMCP registry into native MCP tools. Extracted from the StoryFlow implementation.

## License

MIT
