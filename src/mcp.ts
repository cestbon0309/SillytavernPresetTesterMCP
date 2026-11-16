#!/usr/bin/env node
/**
 * MCP server (stdio). Every daemon method becomes a tool named "st_<method>".
 * The daemon is started automatically on the first call.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { METHOD_LIST } from './methods.js';
import { call, RpcError } from './client.js';

const server = new McpServer({ name: 'stpd', version: '0.1.0' }, {
    instructions: [
        'Tools to test and debug SillyTavern Chat Completion presets against a real (isolated) SillyTavern instance.',
        'Typical loop: st_set_endpoint -> st_set_model -> st_set_preset -> st_import_character -> st_send_message(batch=N) -> read replies -> edit preset file -> st_reload_preset -> st_regenerate(batch=N).',
        'st_inspect_prompt shows the exact assembled prompt without calling the model.',
        'For anything not covered, use st_page_eval / st_run_slash / st_page_snapshot+st_page_click, or attach to the CDP endpoint from st_status.',
    ].join(' '),
});

for (const def of METHOD_LIST) {
    server.registerTool(
        `st_${def.name}`,
        { description: def.description, inputSchema: def.params.shape },
        async (args: any) => {
            try {
                const result = await call(def.name, args ?? {});
                const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
                return { content: [{ type: 'text' as const, text }] };
            } catch (e: any) {
                const msg = e instanceof RpcError ? e.message : (e?.message || String(e));
                return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
            }
        },
    );
}

await server.connect(new StdioServerTransport());
