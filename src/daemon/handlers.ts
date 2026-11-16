import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../paths.js';
import type { Runtime } from './runtime.js';
import { UserError, timestamp } from './util.js';

type Handler = (rt: Runtime, p: any) => Promise<any>;

/** Inline results bigger than this are written to a file and replaced by its path. */
const INLINE_LIMIT = 60_000;

function loadHistory(h: unknown): unknown[] | undefined {
    if (h === undefined || h === null) return undefined;
    if (Array.isArray(h)) return h;
    if (typeof h !== 'string') throw new UserError('history must be an array or a file path');
    const file = path.resolve(h);
    if (!fs.existsSync(file)) throw new UserError(`History file not found: ${file}`);
    const text = fs.readFileSync(file, 'utf8');
    if (file.endsWith('.jsonl')) {
        const lines = text.split(/\r?\n/).filter((l: string) => l.trim()).map((l: string) => JSON.parse(l));
        // SillyTavern chat files start with a metadata header line without "mes".
        return lines.filter((l: any) => typeof l.mes === 'string');
    }
    const data = JSON.parse(text);
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.messages)) return data.messages;
    throw new UserError('History JSON must be an array of {role, content} or {messages: [...]}');
}

async function withTimeout<T>(rt: Runtime, p: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(async () => {
            try {
                await rt.browser.requirePage().evaluate(() => (window as any).SillyTavern.getContext().stopGeneration());
            } catch { /* ignore */ }
            rej(new UserError(`${what} timed out after ${Math.round(ms / 1000)}s (generation stopped)`));
        }, ms);
    });
    try {
        return await Promise.race([p, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

async function status(rt: Runtime) {
    const page = rt.browser.running ? await rt.browser.op('status').catch((e: Error) => ({ error: e.message })) : null;
    let stVersion: string | undefined;
    try {
        stVersion = JSON.parse(fs.readFileSync(path.join(rt.cfg.stDir, 'package.json'), 'utf8')).version;
    } catch { /* ignore */ }
    return {
        daemon: { pid: process.pid, port: rt.cfg.daemonPort, home: paths.home },
        sillytavern: { running: rt.st.running, url: rt.st.url, version: stVersion, dir: rt.cfg.stDir, log: paths.stLog },
        browser: { running: rt.browser.running, headed: rt.cfg.headed, cdp: rt.browser.running ? await rt.browser.cdpInfo() : null },
        preset_source: rt.state.presetSource ?? null,
        page,
    };
}

async function importPreset(rt: Runtime, source: string, name?: string) {
    const local = await rt.fetchSource(source);
    let parsed: any;
    try {
        parsed = JSON.parse(fs.readFileSync(local, 'utf8'));
    } catch (e) {
        throw new UserError(`Preset is not valid JSON: ${(e as Error).message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new UserError('Preset JSON must be an object');
    if (!('prompts' in parsed) && !('prompt_order' in parsed) && !('temperature' in parsed)) {
        throw new UserError('This does not look like a Chat Completion preset (no prompts / prompt_order / temperature).');
    }
    const presetName = (name || path.basename(local).replace(/\.(json|settings)$/i, '')).replace(/[<>:"/\\|?*]/g, '_');
    // The UI importer derives the preset name from the file name.
    const dir = path.join(paths.tmp, `preset-${timestamp()}`);
    fs.mkdirSync(dir, { recursive: true });
    const staged = path.join(dir, `${presetName}.json`);
    fs.copyFileSync(local, staged);

    const page = rt.browser.requirePage();
    const armed = await rt.browser.op('armPresetImport');
    await page.evaluate(() => { (window as any).__stpd.autoPopup = 'ok'; });
    try {
        await page.setInputFiles('#openai_preset_import_file', staged);
        const result = await rt.browser.op('presetImported', { name: presetName, armed });
        const remembered = /^https?:\/\//i.test(source) ? source : path.resolve(source);
        rt.state.presetSource = { source: remembered, name: presetName };
        rt.saveState();
        return { imported: presetName, source: remembered, ...result };
    } finally {
        await page.evaluate(() => { (window as any).__stpd.autoPopup = null; }).catch(() => {});
    }
}

/** Run a generation op and shape the result for the agent (big payloads go to files). */
function logSize(file: string): number {
    try { return fs.statSync(file).size; } catch { return 0; }
}

/** Error lines SillyTavern's server logged since `from` (it keeps upstream API error bodies there). */
function stLogErrorsSince(from: number): string[] {
    try {
        const fd = fs.openSync(paths.stLog, 'r');
        const size = fs.fstatSync(fd).size;
        const len = Math.min(size - from, 2_000_000);
        if (len <= 0) { fs.closeSync(fd); return []; }
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, from);
        fs.closeSync(fd);
        return buf.toString('utf8').split(/\r?\n/).filter(l => /error|failed|exception/i.test(l)).slice(-20).map(l => l.slice(0, 1000));
    } catch {
        return [];
    }
}

async function runGeneration(rt: Runtime, opParams: any) {
    const logStart = logSize(paths.stLog);
    const raw: any = await withTimeout(rt, rt.browser.op('generate', opParams), rt.cfg.generationTimeoutMs, 'Generation');
    if (raw.failed?.length || raw.errors?.length) {
        raw.upstream_errors = stLogErrorsSince(logStart);
    }
    const stamp = timestamp();
    const requestFile = raw.request_body
        ? rt.writeOutput('request', tryParse(raw.request_body), path.join(paths.outputs, `${stamp}-request.json`))
        : null;
    const responsesFile = rt.writeOutput('responses', raw.raw_responses, path.join(paths.outputs, `${stamp}-responses.json`));
    const { request_body, raw_responses, ...rest } = raw;
    const out: any = { ...rest, request_file: requestFile, responses_file: responsesFile };
    const resultFile = rt.writeOutput('result', out, path.join(paths.outputs, `${stamp}-result.json`));
    out.result_file = resultFile;
    if (JSON.stringify(out).length > INLINE_LIMIT) {
        return {
            ...rest,
            results: out.results.map((r: any) => ({ ...r, text: r.text?.slice(0, 2000) + (r.text?.length > 2000 ? ' …[truncated, see result_file]' : '') })),
            request_file: requestFile,
            responses_file: responsesFile,
            result_file: resultFile,
            note: 'Output truncated inline; full replies are in result_file.',
        };
    }
    if (raw.succeeded === 0) {
        out.hint = 'No reply was produced. Check "failed"/"errors", and page_console(level="toast") for SillyTavern error toasts.';
    }
    return out;
}

function tryParse(s: unknown): unknown {
    if (typeof s !== 'string') return s;
    try { return JSON.parse(s); } catch { return s; }
}

function maybeToFile(rt: Runtime, kind: string, data: unknown, out?: string) {
    if (out) return { written: rt.writeOutput(kind, data, out) };
    if (JSON.stringify(data).length > INLINE_LIMIT) {
        return { written: rt.writeOutput(kind, data), note: 'Result too large to inline; written to file.' };
    }
    return data;
}

function extName(name: string): string {
    return name.replace(/^third-party\//, '');
}

export const handlers: Record<string, Handler> = {
    // lifecycle (start/stop handled specially in server.ts)
    async start(rt) {
        await rt.ensureStarted();
        return status(rt);
    },
    status,
    async restart(rt) {
        await rt.restart();
        return status(rt);
    },

    // connection
    async list_providers(rt) {
        return rt.browser.op('listProviders');
    },
    async set_endpoint(rt, p) {
        return rt.browser.op('setEndpoint', p);
    },
    async list_models(rt) {
        return rt.browser.op('listModels');
    },
    async set_model(rt, p) {
        return rt.browser.op('setModel', p);
    },

    // preset
    async set_preset(rt, p) {
        return importPreset(rt, p.source, p.name);
    },
    async reload_preset(rt) {
        const src = rt.state.presetSource;
        if (!src) throw new UserError('No preset source remembered. Call set_preset first.');
        return importPreset(rt, src.source, src.name);
    },
    async list_presets(rt) {
        return rt.browser.op('listPresets');
    },
    async get_preset(rt, p) {
        const r: any = await rt.browser.op('getPreset');
        if (p.out) return { name: r.name, written: rt.writeOutput('preset', r.preset, p.out) };
        return maybeToFile(rt, 'preset', r);
    },

    // character
    async import_character(rt, p) {
        const local = await rt.fetchSource(p.source);
        const before = await rt.browser.op('characterAvatars');
        const page = rt.browser.requirePage();
        await page.evaluate(() => { (window as any).__stpd.autoPopup = 'ok'; });
        try {
            await page.setInputFiles('#character_import_file', local);
            const added = await rt.browser.op('characterImported', { before });
            return { imported: added };
        } finally {
            await page.evaluate(() => { (window as any).__stpd.autoPopup = null; }).catch(() => {});
        }
    },
    async list_characters(rt) {
        return rt.browser.op('listCharacters');
    },

    // chats
    async list_chats(rt, p) {
        return rt.browser.op('listChats', p);
    },
    async get_chat(rt, p) {
        const r = await rt.browser.op('getChat', { character: p.character, chat: p.chat, last: p.last });
        return maybeToFile(rt, 'chat', r, p.out);
    },
    async new_chat(rt, p) {
        return rt.browser.op('newChat', { character: p.character, history: loadHistory(p.history) });
    },

    // generation
    async send_message(rt, p) {
        await rt.browser.op('prepare', {
            character: p.character, chat: p.chat, new_chat: p.new_chat, history: loadHistory(p.history),
        });
        return runGeneration(rt, { message: p.message, batch: p.batch ?? 1, type: 'normal' });
    },
    async regenerate(rt, p) {
        const info: any = await rt.browser.op('prepare', { character: p.character, chat: p.chat });
        const type = !info.last_is_user && info.length > 1 ? 'regenerate' : 'normal';
        return runGeneration(rt, { batch: p.batch ?? 1, type });
    },
    async inspect_prompt(rt, p) {
        const history = loadHistory(p.history);
        if (history) {
            // Use a throwaway in-memory history: prepare the character/chat, then swap messages temporarily.
            await rt.browser.op('prepare', { character: p.character, chat: p.chat });
            const r = await rt.browser.op('inspectWithHistory', { history, message: p.message });
            return maybeToFile(rt, 'prompt', r, p.out);
        }
        await rt.browser.op('prepare', { character: p.character, chat: p.chat });
        const r = await rt.browser.op('inspectPrompt', { message: p.message });
        return maybeToFile(rt, 'prompt', r, p.out);
    },
    async select_swipe(rt, p) {
        if (p.character || p.chat) await rt.browser.op('prepare', { character: p.character, chat: p.chat });
        return rt.browser.op('selectSwipe', { swipe_id: p.swipe_id });
    },

    // extensions
    async list_extensions(rt, p) {
        const list: any[] = await rt.browser.op('listExtensions');
        return p.third_party_only ? list.filter(e => e.type !== 'built-in') : list;
    },
    async install_extension(rt, p) {
        const r = await rt.browser.op('extensionRequest', { endpoint: 'install', body: { url: p.url, branch: p.branch, global: false } });
        await rt.browser.reload();
        return { installed: r, note: 'Page reloaded; the extension is now loaded.' };
    },
    async uninstall_extension(rt, p) {
        const name = extName(p.name);
        const r = await rt.browser.op('extensionRequest', { endpoint: 'delete', body: { extensionName: name, global: false } });
        await rt.browser.reload();
        return { result: r };
    },
    async update_extension(rt, p) {
        const name = extName(p.name);
        const r = await rt.browser.op('extensionRequest', { endpoint: 'update', body: { extensionName: name, global: false } });
        await rt.browser.reload();
        return { result: r };
    },
    async enable_extension(rt, p) {
        const name = p.name.includes('/') ? p.name : await resolveExtName(rt, p.name);
        await rt.browser.op('setExtensionEnabled', { name, enabled: true });
        await rt.browser.reload();
        return { name, enabled: true };
    },
    async disable_extension(rt, p) {
        const name = p.name.includes('/') ? p.name : await resolveExtName(rt, p.name);
        await rt.browser.op('setExtensionEnabled', { name, enabled: false });
        await rt.browser.reload();
        return { name, enabled: false };
    },
    async get_extension_settings(rt, p) {
        return maybeToFile(rt, 'ext-settings', await rt.browser.op('getExtensionSettings', p));
    },
    async set_extension_settings(rt, p) {
        const r = await rt.browser.op('setExtensionSettings', p);
        if (p.reload) await rt.browser.reload();
        return maybeToFile(rt, 'ext-settings', r);
    },

    // STscript
    async run_slash(rt, p) {
        return rt.browser.op('runSlash', p);
    },

    // browser
    async page_snapshot(rt, p) {
        const page = rt.browser.requirePage();
        const loc = page.locator(p.selector || 'body').first();
        const snap = await loc.ariaSnapshot({ mode: 'ai', depth: p.depth, timeout: 15_000 } as any);
        if (snap.length > INLINE_LIMIT) {
            return { written: rt.writeOutput('snapshot', snap, path.join(paths.outputs, `${timestamp()}-snapshot.yaml`)), note: 'Snapshot too large to inline; use selector/depth to scope it.' };
        }
        return snap;
    },
    async page_screenshot(rt, p) {
        const page = rt.browser.requirePage();
        const file = p.out ? path.resolve(p.out) : path.join(paths.outputs, `${timestamp()}-screenshot.png`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (p.selector) await page.locator(p.selector).first().screenshot({ path: file });
        else await page.screenshot({ path: file, fullPage: !!p.full_page });
        return { path: file };
    },
    async page_click(rt, p) {
        await locate(rt, p.target).click({ force: !!p.force, timeout: 10_000 });
        return { clicked: p.target };
    },
    async page_type(rt, p) {
        const loc = locate(rt, p.target);
        await loc.fill(p.text, { timeout: 10_000 });
        if (p.submit) await loc.press('Enter');
        return { typed: p.target };
    },
    async page_select(rt, p) {
        const loc = locate(rt, p.target);
        let selected: string[];
        try {
            selected = await loc.selectOption({ value: p.value }, { timeout: 5_000 });
        } catch {
            selected = await loc.selectOption({ label: p.value }, { timeout: 5_000 });
        }
        return { selected };
    },
    async page_press(rt, p) {
        await rt.browser.requirePage().keyboard.press(p.key);
        return { pressed: p.key };
    },
    async page_eval(rt, p) {
        const r = await rt.browser.op('eval', { code: p.code }, { autoPopup: null });
        return maybeToFile(rt, 'eval', r);
    },
    async page_reload(rt) {
        await rt.browser.reload();
        return { reloaded: true };
    },
    async page_console(rt, p) {
        let buf = rt.browser.consoleBuf;
        if (p.level === 'error') buf = buf.filter(e => e.level === 'error');
        else if (p.level === 'warning') buf = buf.filter(e => e.level === 'error' || e.level === 'warning');
        else if (p.level === 'toast') buf = buf.filter(e => e.level === 'toast');
        const out = buf.slice(-(p.limit ?? 100));
        if (p.clear) rt.browser.consoleBuf = [];
        return out;
    },
};

function locate(rt: Runtime, target: string) {
    const page = rt.browser.requirePage();
    if (/^e\d+$/.test(target)) return page.locator(`aria-ref=${target}`);
    return page.locator(target).first();
}

async function resolveExtName(rt: Runtime, name: string): Promise<string> {
    const list: any[] = await rt.browser.op('listExtensions');
    const hit = list.find(e => e.name === name || e.name === `third-party/${name}` || e.display_name === name);
    if (!hit) throw new UserError(`Extension not found: ${name}. Installed: ${list.map(e => e.name).join(', ')}`);
    return hit.name;
}
