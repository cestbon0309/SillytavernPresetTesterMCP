/**
 * Single source of truth for every operation the daemon exposes.
 * The daemon validates params with these schemas, the MCP server turns them into tools,
 * and the CLI generates its help text from them.
 */
import { z } from 'zod';

export interface MethodDef {
    name: string;
    group: string;
    description: string;
    params: z.ZodObject<any>;
}

const characterParam = z.string().describe('Character name or avatar file name (e.g. "Seraphina" or "Seraphina.png").');
const chatParam = z.string().describe('Chat file name without extension, as returned by list_chats / send_message.');

const historyMessage = z.object({
    role: z.enum(['user', 'assistant', 'system']),
    content: z.string(),
    name: z.string().optional(),
});
const historyParam = z.union([z.array(historyMessage), z.string()]).describe(
    'Chat history to start from. Either an array of {role, content} or a path to a .json ([{role, content}]) / .jsonl (SillyTavern chat export) file. Replaces the whole chat, including the greeting.',
);

const defs: MethodDef[] = [
    // ---------- lifecycle ----------
    {
        name: 'start', group: 'lifecycle',
        description: 'Start the daemon, SillyTavern and the headless browser. Does nothing if already running. Returns status.',
        params: z.object({}),
    },
    {
        name: 'status', group: 'lifecycle',
        description: 'Show daemon / SillyTavern / browser status, current connection, model, preset, character and chat, plus the CDP endpoint.',
        params: z.object({}),
    },
    {
        name: 'stop', group: 'lifecycle',
        description: 'Stop the browser, SillyTavern and the daemon.',
        params: z.object({}),
    },
    {
        name: 'restart', group: 'lifecycle',
        description: 'Restart SillyTavern and reload the browser page (e.g. after installing server-side files).',
        params: z.object({}),
    },

    // ---------- connection ----------
    {
        name: 'list_providers', group: 'connection',
        description: 'List Chat Completion providers accepted by set_endpoint (SillyTavern chat_completion_source values).',
        params: z.object({}),
    },
    {
        name: 'set_endpoint', group: 'connection',
        description: 'Select a Chat Completion provider, optionally set its base URL (custom/OpenAI-compatible etc.) and API key, then connect. The key is stored only in the isolated SillyTavern secrets and is never echoed back.',
        params: z.object({
            provider: z.string().describe('Provider id, e.g. openai, claude, openrouter, makersuite (Gemini), deepseek, custom (any OpenAI-compatible endpoint). See list_providers.'),
            url: z.string().optional().describe('Base URL, required for "custom" (e.g. https://api.example.com/v1).'),
            api_key: z.string().optional().describe('API key / credential for this provider.'),
        }),
    },
    {
        name: 'list_models', group: 'connection',
        description: 'List models offered by the currently connected provider (as SillyTavern sees them).',
        params: z.object({}),
    },
    {
        name: 'set_model', group: 'connection',
        description: 'Set the model for the current provider.',
        params: z.object({ model: z.string() }),
    },

    // ---------- preset ----------
    {
        name: 'set_preset', group: 'preset',
        description: 'Import a Chat Completion preset JSON (local path or http(s) URL) into SillyTavern and select it. The source is remembered for reload_preset. Preset-embedded regex scripts are imported and allowed automatically.',
        params: z.object({
            source: z.string().describe('Local file path or http(s) URL of the preset JSON.'),
            name: z.string().optional().describe('Preset name inside SillyTavern. Defaults to the file name.'),
        }),
    },
    {
        name: 'reload_preset', group: 'preset',
        description: 'Re-import the preset from the source given to set_preset (use after editing the preset file).',
        params: z.object({}),
    },
    {
        name: 'list_presets', group: 'preset',
        description: 'List Chat Completion presets known to SillyTavern and which one is selected.',
        params: z.object({}),
    },
    {
        name: 'get_preset', group: 'preset',
        description: 'Return the currently active Chat Completion settings as a preset JSON (what SillyTavern would export). Optionally write it to a file.',
        params: z.object({
            out: z.string().optional().describe('If set, write the preset JSON to this path instead of returning it inline.'),
        }),
    },

    // ---------- character ----------
    {
        name: 'import_character', group: 'character',
        description: 'Import a character card (.png / .json / .charx / .yaml; local path or http(s) URL). Embedded lorebooks are imported too.',
        params: z.object({
            source: z.string().describe('Local file path or http(s) URL.'),
        }),
    },
    {
        name: 'list_characters', group: 'character',
        description: 'List characters (name, avatar file, chat count).',
        params: z.object({}),
    },

    // ---------- chats ----------
    {
        name: 'list_chats', group: 'chat',
        description: 'List chat files of a character.',
        params: z.object({ character: characterParam }),
    },
    {
        name: 'get_chat', group: 'chat',
        description: 'Return messages of a chat (default: the current chat). Each message includes all swipes.',
        params: z.object({
            character: characterParam.optional(),
            chat: chatParam.optional(),
            last: z.number().int().positive().optional().describe('Only return the last N messages.'),
            out: z.string().optional().describe('If set, write the chat JSON to this path instead of returning it inline.'),
        }),
    },
    {
        name: 'new_chat', group: 'chat',
        description: 'Start a new chat with a character (starts with the greeting, or with the given history).',
        params: z.object({ character: characterParam, history: historyParam.optional() }),
    },

    // ---------- generation ----------
    {
        name: 'send_message', group: 'generation',
        description: [
            'Send a user message and generate the character reply through the real SillyTavern pipeline (preset, macros, world info, regex, extensions).',
            'batch>1 fires N requests with the byte-identical request body in parallel (controlled variable: only model sampling differs); the replies are stored as swipes of one message.',
            'Returns each reply (after SillyTavern post-processing), its reasoning, finish reason, token usage and latency. The exact request body is saved to a file whose path is returned.',
        ].join(' '),
        params: z.object({
            character: characterParam,
            message: z.string().optional().describe('User message. Omit to just generate the next character turn for the current chat state.'),
            chat: chatParam.optional().describe('Existing chat to continue. Omit (and no history) to continue the character\'s current chat; use new_chat=true for a fresh one.'),
            new_chat: z.boolean().optional().describe('Start a fresh chat (greeting only) before sending.'),
            history: historyParam.optional(),
            batch: z.number().int().min(1).max(32).default(1).describe('Number of replies generated simultaneously from the identical prompt.'),
        }),
    },
    {
        name: 'regenerate', group: 'generation',
        description: 'Delete the last character reply in the chat (if any) and generate it again with batch replies. Ideal after reload_preset to re-test the same context.',
        params: z.object({
            character: characterParam,
            chat: chatParam.optional(),
            batch: z.number().int().min(1).max(32).default(1),
        }),
    },
    {
        name: 'inspect_prompt', group: 'generation',
        description: 'Assemble the prompt exactly as the next generation would send it, without calling the model. Returns the final messages, a per-section breakdown (prompt-manager identifiers) with token counts, and the full request body.',
        params: z.object({
            character: characterParam,
            message: z.string().optional().describe('Pretend this user message was sent (not saved to the chat).'),
            chat: chatParam.optional(),
            history: historyParam.optional().describe('Use this history (temporarily, not saved).'),
            out: z.string().optional().describe('Write the full result JSON to this path.'),
        }),
    },
    {
        name: 'select_swipe', group: 'generation',
        description: 'Choose which swipe of the last character message is kept as the canonical reply (affects following generations).',
        params: z.object({
            character: characterParam.optional(),
            chat: chatParam.optional(),
            swipe_id: z.number().int().min(0),
        }),
    },

    // ---------- extensions ----------
    {
        name: 'list_extensions', group: 'extension',
        description: 'List installed extensions (built-in and third-party) with enabled state and version.',
        params: z.object({ third_party_only: z.boolean().optional() }),
    },
    {
        name: 'install_extension', group: 'extension',
        description: 'Install a third-party extension from a git URL, then reload the page so it is loaded.',
        params: z.object({
            url: z.string().describe('Git repository URL (https).'),
            branch: z.string().optional(),
        }),
    },
    {
        name: 'uninstall_extension', group: 'extension',
        description: 'Delete a third-party extension and reload the page.',
        params: z.object({ name: z.string().describe('Extension folder name, e.g. "third-party/MyExt" or "MyExt".') }),
    },
    {
        name: 'update_extension', group: 'extension',
        description: 'git pull a third-party extension and reload the page.',
        params: z.object({ name: z.string() }),
    },
    {
        name: 'enable_extension', group: 'extension',
        description: 'Enable an extension and reload the page.',
        params: z.object({ name: z.string() }),
    },
    {
        name: 'disable_extension', group: 'extension',
        description: 'Disable an extension and reload the page.',
        params: z.object({ name: z.string() }),
    },
    {
        name: 'get_extension_settings', group: 'extension',
        description: 'Read extension_settings[key] (the settings object an extension stores). Omit key to list available keys.',
        params: z.object({ key: z.string().optional() }),
    },
    {
        name: 'set_extension_settings', group: 'extension',
        description: 'Write extension_settings[key] and save. merge=true (default) deep-merges into the existing object; false replaces it. Some extensions only pick up changes after reload=true.',
        params: z.object({
            key: z.string(),
            settings: z.any().describe('JSON value to write.'),
            merge: z.boolean().default(true),
            reload: z.boolean().default(false),
        }),
    },

    // ---------- STscript ----------
    {
        name: 'run_slash', group: 'misc',
        description: 'Run a SillyTavern STscript / slash command pipeline (e.g. "/echo hi | /getvar x") and return the pipe result.',
        params: z.object({ command: z.string() }),
    },

    // ---------- browser ----------
    {
        name: 'page_snapshot', group: 'browser',
        description: 'Accessibility snapshot of the SillyTavern page with element refs ([ref=eN]) usable by page_click/page_type. Use selector to scope (the full page is large).',
        params: z.object({
            selector: z.string().optional().describe('CSS selector to scope the snapshot (default: body).'),
            depth: z.number().int().positive().optional(),
        }),
    },
    {
        name: 'page_screenshot', group: 'browser',
        description: 'Screenshot the page or an element. Returns the PNG file path.',
        params: z.object({
            selector: z.string().optional(),
            full_page: z.boolean().optional(),
            out: z.string().optional().describe('Output path (default: under .stpd/outputs).'),
        }),
    },
    {
        name: 'page_click', group: 'browser',
        description: 'Click an element by snapshot ref (e.g. "e12") or CSS selector.',
        params: z.object({
            target: z.string().describe('Snapshot ref ("e12") or CSS selector.'),
            force: z.boolean().optional().describe('Skip actionability checks (hidden/covered elements).'),
        }),
    },
    {
        name: 'page_type', group: 'browser',
        description: 'Fill an input/textarea by snapshot ref or CSS selector. submit=true presses Enter afterwards.',
        params: z.object({
            target: z.string(),
            text: z.string(),
            submit: z.boolean().optional(),
        }),
    },
    {
        name: 'page_select', group: 'browser',
        description: 'Select an <option> (by value or label) in a <select> by snapshot ref or CSS selector.',
        params: z.object({ target: z.string(), value: z.string() }),
    },
    {
        name: 'page_press', group: 'browser',
        description: 'Press a key or chord on the page (e.g. "Escape", "Control+Enter").',
        params: z.object({ key: z.string() }),
    },
    {
        name: 'page_eval', group: 'browser',
        description: 'Evaluate JavaScript in the SillyTavern page and return the (JSON-serialisable) result. The code is the body of an async function: use `return`. `ctx` = SillyTavern.getContext(), `st(path)` = dynamic import of a SillyTavern module (e.g. await st("/scripts/openai.js")).',
        params: z.object({ code: z.string() }),
    },
    {
        name: 'page_reload', group: 'browser',
        description: 'Reload the SillyTavern page and wait until it is ready.',
        params: z.object({}),
    },
    {
        name: 'page_console', group: 'browser',
        description: 'Return recent browser console messages, page errors and SillyTavern toasts.',
        params: z.object({
            limit: z.number().int().positive().default(100),
            level: z.enum(['all', 'error', 'warning', 'toast']).default('all'),
            clear: z.boolean().optional().describe('Clear the buffer after reading.'),
        }),
    },
];

export const METHODS: Record<string, MethodDef> = Object.fromEntries(defs.map(d => [d.name, d]));
export const METHOD_LIST = defs;
