---
name: webmcp-retrofit
description: Retrofit an existing web app with WebMCP (document.modelContext) — capability inventory, state bridging, tool design, registration lifecycle, testing harness, and agent-side bridge configuration. Use when the user wants to add WebMCP support to any web application, design its tool surface, or debug WebMCP registration/execution.
---

# WebMCP 改造方法论（WebMCP Retrofit）

把一个现有 Web 应用改造成 AI agent 可直接操作。核心信条：**页面是给人看的导航，能力是给 agent 用的地图——工具的 execute 里调的是领域函数，不是 setState 模拟键盘**（准确说：不是合成 UI 事件）。

## 预检：标准状态自检（每次改造前必做 —— 标准仍在迭代）

WebMCP 是实验标准，下面的「已知状态快照」**会过期**。开始任何改造前，先花 10 分钟核对；事实漂移就先更新本 skill 再干活。

**已知状态快照**（核实于 2026-09-01）：
- API 入口：`document.modelContext`（早期草案为 `navigator.modelContext`，代码双探测）
- 注册：`registerTool(tool, { signal })`，AbortSignal 注销；`execute` 必须是 async
- Chrome 实现怪癖：`getTools()` 返回的 `inputSchema` 是 **JSON 字符串**而非对象
- 启用：Origin Trial 阶段，`--enable-features=WebMCP` 或 `chrome://flags/#enable-webmcp-testing`；安全上下文（localhost/HTTPS）必需，LAN IP 直连无 API
- 官方 MCP↔WebMCP 桥：**尚不存在**（仅 W3C Issue #25 设计讨论）→ 自建桥（本仓库 `mcp-bridge/`）是当前正解
- 规范仓库 webmachinelearning/webmcp 为纯规范文本，无参考实现

**核对清单**（按序，可用 WebSearch/WebFetch）：
1. 规范仓库的 `implementation-status.md` + 近 30 天 commits/issues——API 面有没有变
2. Chrome 文档 `developer.chrome.com/docs/ai/webmcp`——入口/签名/flag 是否漂移
3. chromestatus feature `5117755740913664`——Origin Trial / 正式发布进度
4. 搜「official WebMCP bridge / SDK」（webmcp-types、usewebmcp、官方桥）——**若官方桥落地，优先采用并考虑淘汰本仓库 mcp-bridge**
5. 消费端动态（ChatGPT 内置浏览器、chrome-devtools-mcp）的原生 WebMCP 支持

**自我进化规则**：任何一条与快照不符 → 当场更新本 skill 的快照与受影响章节 → 同步提交到 GitHub 仓库（`~/webmcp-retrofit`，或 `git pull` 后改再 push）→ 然后才开始改造。**skill 是活文档，不是刻在石头上的。**

## 0. 适配判断（先做，5 分钟）

| 应用形态 | 结论 |
|---|---|
| local-first / BYOK / 状态在浏览器（无后端） | WebMCP 是**唯一解**（没有 API 可包） |
| 有后端 + 用户在场协作（副驾驶场景） | WebMCP 叠层：页面工具借用户会话调自家 REST |
| 无人值守自动化（cron、浏览器关着跑） | WebMCP 做不到（工具随页面存活）→ REST + MCP server |
| 两者都要 | 两条通道并存 |

同屏性原理：工具 execute 走应用**自己的状态管线**（setState / store dispatch / React Query mutate），框架响应式自动刷新——与「用户敲键盘屏幕会变」同一条管线，零额外实时基建。严禁裸 fetch 绕过数据层（服务器变了屏幕不知道）。

## 1. 能力盘点

- 列**业务能力**，不列页面/按钮。判断句式：「用户会怎么*请求*这件事」（"加一场戏"）而非「这个按钮干什么」（"提交表单"）。
- 找能力层：领域函数是否已独立于 UI 处理器存在？若业务逻辑埋在 onClick 里，**先提取再包装**（这是改造中唯一可能的大重构）。
- 每个能力标注数据通路：客户端状态 / 数据层缓存 / REST。
- 上下文依赖的能力（向导第二步等）：显式参数化 > 前置条件守卫 > 动态注册（工具列表随导航抖动，最后手段）。

## 2. 状态桥接（execute 怎么拿到新鲜状态）

注册只发生一次，execute 必须永远看到当前状态：

| 模式 | 做法 | 适用 |
|---|---|---|
| latest-ref | accessor 每次渲染刷进 ref，execute 读 ref | React 有状态组件 |
| accessor 接缝 | 定义 `XxxWebMcpAccessor` 接口，工具层只依赖接口 | 任何框架；工具层可独立测试 |
| dispatch 直通 | execute 只 dispatch action | Redux/Zustand |

写面从保守起步：**只读 → append-only 写 → 守卫式开放改/删**。复核语义用「返回草稿不直插 + 显式写入工具」两步制（对应页面的建议/接受流程）。

## 3. 工具设计规则

- 命名：`应用前缀_动词_对象`（`storyflow_append_blocks`），前缀即站内命名空间。
- **description 是 agent 能读到的全部文档**：参数语义、边界（"append-only, cannot delete"）、副作用、是否消耗 API 配额、错误时怎么办。
- inputSchema：显式参数，无隐式「当前页面」输入；封闭集用 enum；写上限（max 数量/长度）。
- annotations 如实标注：`readOnlyHint` / `destructiveHint`（产草稿不落库也算 readOnly）。
- 返回统一 `{ok:true,...}` / `{ok:false,error}` JSON；错误消息带**下一步指引**（"Block not found. Use xxx_get_blocks to list valid ids."）让 agent 自我恢复。

## 4. 注册与生命周期（踩过的坑都在这）

```js
const register = (accessorRef) => {
  if (typeof window === 'undefined') return () => {};
  const mc = document.modelContext ?? navigator.modelContext; // 双入口探测（草案 vs 现行 Chrome）
  if (!mc?.registerTool) return () => {};  // 必须 no-op 函数，绝不能返回 null！
  const controller = new AbortController();
  (async () => {
    for (const tool of tools) {
      if (controller.signal.aborted) return;      // StrictMode 双挂载竞态：静默退出
      try { await mc.registerTool(tool, { signal: controller.signal }); }
      catch (e) { if (controller.signal.aborted) return; console.warn(...); }
    }
  })();
  return () => controller.abort();
};
// React: useEffect(() => register(ref), [])  — 返回值必须是函数或 undefined
```

三条血泪规则：
1. effect 清理函数**永远不能是 null**（React dev 直接崩）。
2. 异步注册循环每步查 `signal.aborted`（StrictMode 挂载→卸载→再挂载，首轮必须静默放弃）。
3. **所有 hooks 放 early-return 之前**（组件会在 valid/error 状态间翻转，hooks 数量变化即崩）。

## 5. 测试夹具（无头验证）

```bash
# 带 flag 的浏览器 + CDP
chromium --enable-features=WebMCP --remote-debugging-port=9222 \
  --user-data-dir=$HOME/webmcp-profile http://localhost:PORT/
# 注意：无 DISPLAY 加 --headless=new --disable-gpu；
# snap 版 Chromium 的 profile 不能放 ~/.cache 等隐藏目录（沙箱禁写）
```

puppeteer-core attach `http://127.0.0.1:9222`，测试矩阵：
1. `typeof document.modelContext === 'object'`
2. `getTools()` 数量与命名
3. 读工具返回结构
4. **写工具 + 回读验证持久化**
5. 错误路径（无效参数、越界 index）返回可指引的 error
6. `take_screenshot` 视觉复核（可选）

安全上下文红线：**必须 localhost 或 HTTPS**——LAN IP（http://192.168.x.x）下 modelContext 不存在，代码应优雅降级不报错。

## 6. 消费端（agent 侧）

- 通用 stdio 桥：StoryFlow 仓库 `mcp-bridge/`（页面无关，代理任意 WebMCP 注册表）。
  `claude mcp add <站点别名> -e WEBMCP_PAGE_URL=localhost:PORT -- node /path/mcp-bridge/index.mjs`
- 已知兼容坑：Chrome `getTools()` 的 `inputSchema` 返回 **JSON 字符串**，桥里要归一化为对象。
- 每个 WebMCP 站点注册一个桥实例（`*` 模式多站点会抢错页）。
- 在项目 CLAUDE.md 写 agent 操作指南（启动脚本、调用模式、故障判断）。
- **两个世界陷阱**：agent 附着的浏览器 ≠ 用户眼前的浏览器，localStorage 各自独立。要让 agent 操作用户的真实数据，两者必须同一个浏览器实例。

## 7. 验收清单

- [ ] 工具 execute 调的是领域函数/数据层，无裸 fetch、无合成 UI 事件
- [ ] description 含边界与副作用；annotations 如实
- [ ] 写面最小（append-only 起步）；错误消息带下一步
- [ ] 注册：no-op 清理函数 / aborted 竞态守卫 / hooks 全在 early-return 前
- [ ] 无头测试六项全过；LAN IP 下优雅静默
- [ ] 消费端：桥注册 + CLAUDE.md 指南 + 浏览器世界对齐
