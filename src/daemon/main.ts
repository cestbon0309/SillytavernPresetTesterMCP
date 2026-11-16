/**
 * stpd daemon: owns SillyTavern + the browser, serves JSON RPC on 127.0.0.1.
 *   POST /rpc  {method, params}  ->  {ok: true, result} | {ok: false, error}
 * Requests carry the token from daemon.json (x-stpd-token) so other local processes can't drive it blindly.
 */
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { loadConfig } from '../config.js';
import { ensureDirs, paths } from '../paths.js';
import { METHODS } from '../methods.js';
import { Runtime } from './runtime.js';
import { handlers } from './handlers.js';
import { log, UserError } from './util.js';

ensureDirs();
const cfg = loadConfig();
const rt = new Runtime(cfg);
const token = crypto.randomBytes(16).toString('hex');
let startupError: string | null = null;
let starting: Promise<void> | null = null;

// Methods that don't need SillyTavern/browser to be up.
const NO_START = new Set(['status', 'stop']);
// Methods that don't take the page lock (read-only / safe to run concurrently).
const NO_LOCK = new Set(['status', 'page_console', 'page_screenshot', 'page_snapshot']);

function ensureStarted(): Promise<void> {
    if (rt.st.running && rt.browser.running) return Promise.resolve();
    if (!starting) {
        starting = rt.ensureStarted()
            .then(() => { startupError = null; })
            .catch((e) => { startupError = String(e?.message || e); log(`startup failed: ${e?.stack || e}`); throw e; })
            .finally(() => { starting = null; });
    }
    return starting;
}

async function dispatch(method: string, params: any): Promise<any> {
    const def = METHODS[method];
    if (!def) throw new UserError(`Unknown method "${method}". Run "stpd help" for the list.`);
    const parsed = def.params.safeParse(params ?? {});
    if (!parsed.success) {
        throw new UserError(`Invalid params for ${method}: ${parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
    }
    const p = parsed.data;

    if (method === 'stop') {
        setTimeout(async () => {
            await rt.shutdown();
            server.close();
            try { fs.unlinkSync(paths.state); } catch { /* ignore */ }
            process.exit(0);
        }, 50);
        return { stopping: true };
    }
    if (!NO_START.has(method)) await ensureStarted();

    const handler = handlers[method];
    if (!handler) throw new UserError(`Method ${method} is not implemented`);
    const run = () => handler(rt, p);
    return NO_LOCK.has(method) ? run() : rt.lock.run(run);
}

const server = http.createServer(async (req, res) => {
    const send = (code: number, body: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/health') {
        return send(200, { ok: true, pid: process.pid, startupError });
    }
    if (req.method !== 'POST' || req.url !== '/rpc') return send(404, { ok: false, error: 'not found' });
    if (req.headers['x-stpd-token'] !== token) return send(401, { ok: false, error: 'bad token' });

    let body = '';
    req.setEncoding('utf8');
    for await (const chunk of req) body += chunk;
    let method = '';
    try {
        const msg = JSON.parse(body || '{}');
        method = msg.method;
        const started = Date.now();
        const result = await dispatch(msg.method, msg.params);
        log(`${method} ok (${Date.now() - started}ms)`);
        send(200, { ok: true, result });
    } catch (e: any) {
        const userErr = e instanceof UserError;
        log(`${method} failed: ${e?.stack || e}`);
        send(200, { ok: false, error: userErr ? e.message : `${e?.message || e}`, internal: !userErr });
    }
});

server.listen(cfg.daemonPort, '127.0.0.1', () => {
    fs.writeFileSync(paths.state, JSON.stringify({ pid: process.pid, port: cfg.daemonPort, token, started: new Date().toISOString() }, null, 2));
    log(`daemon listening on 127.0.0.1:${cfg.daemonPort} (pid ${process.pid})`);
    // Boot SillyTavern + browser right away; clients wait via ensureStarted().
    ensureStarted().catch(() => { /* reported via startupError / next call */ });
});
server.on('error', (e) => {
    log(`daemon server error: ${e}`);
    process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
        await rt.shutdown();
        try { fs.unlinkSync(paths.state); } catch { /* ignore */ }
        process.exit(0);
    });
}
process.on('unhandledRejection', (e) => log(`unhandledRejection: ${(e as any)?.stack || e}`));
