// Smoke test for the MCP server: lists tools and calls a few of them over stdio.
//   node test/mcp-smoke.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'dist', 'mcp.js')] });
const client = new Client({ name: 'smoke', version: '0.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`${tools.length} tools:`, tools.map(t => t.name).join(', '));
const send = tools.find(t => t.name === 'st_send_message');
console.log('st_send_message schema:', JSON.stringify(send.inputSchema).slice(0, 300));

const show = (r) => console.log(r.isError ? 'ERROR' : 'ok', r.content[0].text.slice(0, 400));
show(await client.callTool({ name: 'st_status', arguments: {} }));
show(await client.callTool({ name: 'st_send_message', arguments: { character: 'Seraphina', message: 'via MCP', batch: 2 } }));
show(await client.callTool({ name: 'st_set_model', arguments: {} }));
await client.close();
