/** End-to-end smoke test of the bridge as a real MCP client would use it:
 *  spawns the stdio server and lists tools (should surface whatever the target
 *  page registers). If WEBMCP_TEST_TOOL is set, calls that tool and prints the
 *  raw result — page-agnostic, no hardcoded tool names.
 *
 * Run (a WebMCP browser must be up):
 *   node test-client.mjs
 *   WEBMCP_TEST_TOOL=storyflow_get_app_info node test-client.mjs
 *   WEBMCP_TEST_TOOL=storyflow_append_blocks \
 *     WEBMCP_TEST_ARGS='{"blocks":[{"type":"TRANSITION","content":"CUT TO:"}]}' \
 *     node test-client.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['index.mjs'],
});
const client = new Client({ name: 'bridge-test', version: '0.0.0' });
await client.connect(transport);

console.log('=== tools/list ===');
const { tools } = await client.listTools();
for (const t of tools) {
  const props = Object.keys(t.inputSchema?.properties ?? {});
  const hint = t.annotations?.readOnlyHint ? 'read-only'
    : t.annotations?.destructiveHint ? 'destructive' : 'rw';
  console.log(`- ${t.name}(${props.join(', ')}) [${hint}]`);
}
if (tools.length === 0) {
  console.error('No WebMCP tools on the target page.');
  process.exit(1);
}

const toolName = process.env.WEBMCP_TEST_TOOL;
if (toolName) {
  if (!tools.some((t) => t.name === toolName)) {
    console.error(`WEBMCP_TEST_TOOL=${toolName} is not in the registry above.`);
    process.exit(1);
  }
  let args = {};
  const rawArgs = process.env.WEBMCP_TEST_ARGS;
  if (rawArgs) {
    try { args = JSON.parse(rawArgs); }
    catch { console.error('WEBMCP_TEST_ARGS must be valid JSON.'); process.exit(1); }
  }
  console.log(`\n=== call ${toolName} ===`);
  const res = await client.callTool({ name: toolName, arguments: args });
  console.log(res.content?.[0]?.text ?? JSON.stringify(res));
}

await client.close();
console.log('\nBRIDGE TEST PASSED');
