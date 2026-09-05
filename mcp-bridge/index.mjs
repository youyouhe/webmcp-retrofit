#!/usr/bin/env node
/**
 * webmcp-bridge — a GENERIC stdio MCP server that proxies whatever WebMCP
 * tools a page registers on `document.modelContext` (Chrome 150+) or
 * `navigator.modelContext` (Chrome 146–149).
 *
 *   MCP client ──stdio(JSON-RPC)── this server ──CDP── Chromium (--enable-features=WebMCP)
 *                                                       └── any WebMCP-capable page
 *
 * The bridge is page-agnostic: `tools/list` forwards the page's WebMCP
 * registry (name / title / description / JSON Schema / annotations) and
 * `tools/call` forwards to `document.modelContext.executeTool()`. It never
 * hardcodes a tool inventory — point it at any site that exposes WebMCP
 * tools and they appear natively in your MCP client.
 *
 * Configuration (env vars):
 *   WEBMCP_BROWSER_URL   CDP endpoint to attach to.
 *                        Default: http://127.0.0.1:9222
 *   WEBMCP_PAGE_URL      Substring that identifies the target page's URL
 *                        (e.g. "localhost:5173"), or "*" for the first open
 *                        page where document.modelContext exists.
 *                        Default: "*" (legacy alias: STORYFLOW_PAGE_URL)
 *   WEBMCP_SERVER_NAME   Server name reported over MCP.
 *                        Default: "webmcp-bridge"
 *   WEBMCP_PROTOCOL_TIMEOUT_MS  CDP 协议超时（puppeteer protocolTimeout）。
 *                        Default: 180000
 *   WEBMCP_TOOL_TIMEOUT_MS      tools/call 的响应上限（毫秒）。0 = 不设上限，
 *                        等到工具真正结束或 CDP 超时。注意：MCP 客户端（如
 *                        Claude Code）自带请求超时（默认 60s），桥这边给更长
 *                        只会让客户端先放弃；此值主要用来在客户端超时前主动
 *                        返回可读错误。无论是否超时，并发工具调用都会被串行化，
 *                        一个仍在后台执行的写不会与下一个调用交错。
 *                        Default: 0
 *
 * Prerequisites — a browser with WebMCP + CDP, e.g.:
 *   chromium --enable-features=WebMCP --remote-debugging-port=9222 \
 *            --user-data-dir=$HOME/webmcp-profile http://localhost:5173/
 * (StoryFlow ships a convenience launcher: scripts/webmcp-chromium.sh)
 *
 * Register (Claude Code):
 *   claude mcp add webmcp -- node /path/to/mcp-bridge/index.mjs
 */
import { createRequire } from 'node:module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import puppeteer from 'puppeteer-core';

const require = createRequire(import.meta.url);
const { version: SERVER_VERSION } = require('./package.json'); // 单一版本源：package.json

const BROWSER_URL = process.env.WEBMCP_BROWSER_URL || process.env.STORYFLOW_BROWSER_URL || 'http://127.0.0.1:9222';
const PAGE_MATCH = process.env.WEBMCP_PAGE_URL || process.env.STORYFLOW_PAGE_URL || '*';
const SERVER_NAME = process.env.WEBMCP_SERVER_NAME || 'webmcp-bridge';
const PROTOCOL_TIMEOUT_MS = Number(process.env.WEBMCP_PROTOCOL_TIMEOUT_MS) || 180_000;
const TOOL_TIMEOUT_MS = Number(process.env.WEBMCP_TOOL_TIMEOUT_MS) || 0;

const LAUNCH_HINT =
  'Launch a browser with WebMCP + CDP, e.g.: ' +
  'chromium --enable-features=WebMCP --remote-debugging-port=9222 <url>';

// ---- browser/page plumbing (lazy, self-healing) -----------------------------

let browser = null;
let connecting = null; // 并发 connect 去重：多个请求同时到达时只建一条 CDP 连接

const getBrowser = async () => {
  if (browser?.connected) return browser;
  if (connecting) return connecting;
  connecting = (async () => {
    const b = await puppeteer.connect({
      browserURL: BROWSER_URL,
      defaultViewport: null,
      protocolTimeout: PROTOCOL_TIMEOUT_MS,
    });
    browser = b;
    b.on('disconnected', () => { browser = null; });
    return b;
  })();
  try {
    return await connecting;
  } finally {
    connecting = null;
  }
};

// 双入口探测：Chrome 150+ 在 document，146–149 在 navigator（与 SKILL.md §4 一致）
const hasWebMCP = (page) =>
  page.evaluate(() => {
    const mc = document.modelContext ?? navigator.modelContext;
    return !!mc && typeof mc.getTools === 'function';
  });

/** Resolve the target page: URL-substring match, or (for "*") the first open
 *  page that actually exposes a usable modelContext. */
const getTargetPage = async () => {
  const b = await getBrowser();
  const pages = await b.pages();
  let page = null;
  if (PAGE_MATCH !== '*') {
    page = pages.find((p) => p.url().includes(PAGE_MATCH));
    if (!page) {
      throw new Error(
        `No page matching "${PAGE_MATCH}" is open in the browser at ${BROWSER_URL}. ` + LAUNCH_HINT
      );
    }
    if (!(await hasWebMCP(page))) {
      throw new Error(
        `The page matching "${PAGE_MATCH}" has no modelContext — the browser lacks ` +
          '--enable-features=WebMCP / an Origin-Trial token, or the page is not a secure ' +
          'context (use localhost/https, not a LAN IP). ' + LAUNCH_HINT
      );
    }
  } else {
    for (const p of pages) {
      try {
        if (await hasWebMCP(p)) { page = p; break; }
      } catch { /* devtools:// and chrome:// pages throw on evaluate — skip */ }
    }
    if (!page) {
      throw new Error(`No open page exposes modelContext via ${BROWSER_URL}. ` + LAUNCH_HINT);
    }
  }
  logBridgedPage(page);
  return page;
};

// 把"实际桥的是哪个页面/tab"打到 stderr —— agent 不该在不知道目标是谁时操作它。
let lastLoggedUrl = null;
function logBridgedPage(page) {
  const url = page.url();
  if (url !== lastLoggedUrl) {
    lastLoggedUrl = url;
    console.error(`[${SERVER_NAME}] bridged page: ${url}`);
  }
}

// ---- 页面内工具（modelContext 操作在页面上下文执行）----------------------------

/** 归一化 WebMCP 返回的 schema：当前 Chrome 把 inputSchema 当 JSON 字符串给，
 *  但这是实现细节，不该泄漏到桥的边界之外——在页面内就统一成对象/undefined。 */
const LIST_IN_PAGE = async () => {
  const mc = document.modelContext ?? navigator.modelContext;
  if (!mc || typeof mc.getTools !== 'function') return null;
  const list = await mc.getTools();
  return list.map((t) => {
    let schema = t.inputSchema;
    if (typeof schema === 'string') {
      try { schema = JSON.parse(schema); } catch { schema = null; }
    }
    const tool = { name: t.name };
    if (typeof t.description === 'string') tool.description = t.description;
    if (typeof t.title === 'string') tool.title = t.title;
    const ann = t.annotations && typeof t.annotations === 'object' ? t.annotations : null;
    if (ann) {
      const a = {};
      if (ann.readOnlyHint !== undefined) a.readOnlyHint = !!ann.readOnlyHint;
      if (ann.destructiveHint !== undefined) a.destructiveHint = !!ann.destructiveHint;
      if (ann.idempotentHint !== undefined) a.idempotentHint = !!ann.idempotentHint;
      if (ann.openWorldHint !== undefined) a.openWorldHint = !!ann.openWorldHint;
      if (Object.keys(a).length) tool.annotations = a;
    }
    if (schema && typeof schema === 'object') tool.inputSchema = schema;
    return tool;
  });
};

const EXECUTE_IN_PAGE = async (toolName, argsJson) => {
  const mc = document.modelContext ?? navigator.modelContext;
  if (!mc || typeof mc.executeTool !== 'function') {
    return JSON.stringify({ ok: false, error: 'WebMCP unavailable on this page.' });
  }
  const tools = await mc.getTools();
  const t = tools.find((x) => x.name === toolName);
  if (!t) {
    return JSON.stringify({
      ok: false,
      error: `Unknown tool: ${toolName}. Re-list tools — the page registry may have changed.`,
    });
  }
  let argsObj = {};
  try { argsObj = JSON.parse(argsJson || '{}'); } catch { /* keep {} */ }
  try {
    // 实测(Chrome 152/155)：executeTool 第 2 参必须是“参数对象的 JSON 字符串”，
    // 传对象会报 “Failed to parse input arguments”。每次调用都重新 getTools()，
    // 因为页面工具注册可能在执行后刷新（复用旧 RegisteredTool 会 “Tool not found”）。
    const out = await mc.executeTool(t, JSON.stringify(argsObj));
    return typeof out === 'string' ? out : JSON.stringify(out);
  } catch (e) {
    // 若未来 Chrome 改回“接受对象”，对参数解析这一特定错误用对象重试一次。
    // 参数解析发生在真正执行之前，故重试不会造成工具二次执行。
    if (String(e?.message || e).includes('Failed to parse input arguments')) {
      const out = await mc.executeTool(t, argsObj);
      return typeof out === 'string' ? out : JSON.stringify(out);
    }
    throw e;
  }
};

// ---- 并发串行化 ---------------------------------------------------------------
// 同一个 page 上并发的 evaluate 会交错执行（读可能夹在两个写之间），对“读写同一份
// React/应用状态”的页面是真实风险。所有 tools/list 与 tools/call 都过这条队列，
// 保证任意时刻页面上只有一个操作在跑。

let queueChain = Promise.resolve();
function serial(work) {
  const run = queueChain.then(work);
  queueChain = run.then(() => {}, () => {}); // 链不断：上个失败不阻塞下个
  return run;
}

// 可选的 tools/call 响应上限。超时只提前回复客户端，队列仍等真正的 evaluate 结束
// 才放行下一个调用 —— 一个超时仍在后台跑的写不会与后续调用交错。
function withTimeout(promise, ms, label) {
  if (!ms) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${ms}ms`), { timedOut: true })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---- MCP server --------------------------------------------------------------

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const page = await getTargetPage();
  const tools = await serial(() => page.evaluate(LIST_IN_PAGE));
  if (!tools) throw new Error('WebMCP registry unreadable on the target page. ' + LAUNCH_HINT);
  return {
    tools: tools.map((t) => {
      // schema 解析失败不能静默降成“无参数”让 agent 空手去调——暴露空 schema 但打警告
      if (!t.inputSchema) {
        console.error(`[${SERVER_NAME}] tool ${t.name} has an unparsable inputSchema — exposing an empty schema`);
        t.inputSchema = { type: 'object', properties: {} };
      }
      return t;
    }),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  // settleClient 决定回给客户端的内容；后台的真实执行（runToCompletion）决定队列何时放行。
  let settleClient;
  const clientReply = new Promise((resolve) => { settleClient = resolve; });

  const runToCompletion = serial(async () => {
    let reply;
    try {
      const page = await getTargetPage();
      const text = await page.evaluate(EXECUTE_IN_PAGE, name, JSON.stringify(args ?? {}));
      reply = { content: [{ type: 'text', text }] };
    } catch (e) {
      reply = {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: String(e?.message || e) }) }],
        isError: true,
      };
    }
    settleClient(reply);
    return reply;
  });

  if (TOOL_TIMEOUT_MS) {
    // 提前回错误给客户端；runToCompletion 继续在队列里等真正结束。
    const early = withTimeout(clientReply, TOOL_TIMEOUT_MS, `tool ${name}`).catch((e) => ({
      content: [{
        type: 'text',
        text: JSON.stringify({
          ok: false,
          error: e.message + ' — the call may still be running in the page; the next tool call waits for it to finish.',
        }),
      }],
      isError: true,
    }));
    return early;
  }
  return runToCompletion;
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[${SERVER_NAME}] v${SERVER_VERSION} ready — proxying WebMCP tools via ${BROWSER_URL} (page: ${PAGE_MATCH})`);

// ---- 优雅退出 -----------------------------------------------------------------
// MCP 客户端断开 / Ctrl-C 后必须收掉 CDP 连接并退出，否则 WebSocket 会让 Node 事件
// 循环不空，进程挂成僵尸还占着 9222 的一个连接。注意是 disconnect 不是 close——
// 我们只是“放手”，不能把用户手动开着的 Chrome 一起关掉。

const shutdown = async () => {
  try {
    if (browser?.connected) await browser.disconnect();
  } catch { /* 已断开则忽略 */ }
  process.exit(0);
};

transport.onclose = () => { void shutdown(); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
