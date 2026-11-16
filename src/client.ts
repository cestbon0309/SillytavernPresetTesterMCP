import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { paths, ensureDirs } from './paths.js';

interface DaemonState {
    pid: number;
    port: number;
    token: string;
}

function readState(): DaemonState | null {
    try {
        return JSON.parse(fs.readFileSync(paths.state, 'utf8'));
    } catch {
        return null;
    }
}

async function healthy(st: DaemonState): Promise<boolean> {
    try {
        const res = await fetch(`http://127.0.0.1:${st.port}/health`, { signal: AbortSignal.timeout(1500) });
        const j: any = await res.json();
        return j.ok && j.pid === st.pid;
    } catch {
        return false;
    }
}

export async function daemonRunning(): Promise<DaemonState | null> {
    const st = readState();
    if (st && await healthy(st)) return st;
    return null;
}

/** Start the daemon in the background if it is not running. */
export async function ensureDaemon(): Promise<DaemonState> {
    const existing = await daemonRunning();
    if (existing) return existing;
    ensureDirs();
    try { fs.unlinkSync(paths.state); } catch { /* ignore */ }
    const main = path.join(path.dirname(fileURLToPath(import.meta.url)), 'daemon', 'main.js');
    const out = fs.openSync(paths.daemonLog, 'a');
    const child = spawn(process.execPath, [main], {
        detached: true,
        stdio: ['ignore', out, out],
        windowsHide: true,
        env: process.env,
    });
    child.unref();
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
        const st = readState();
        if (st && await healthy(st)) return st;
        await new Promise(r => setTimeout(r, 200));
    }
    throw new Error(`Daemon did not come up. See ${paths.daemonLog}`);
}

export class RpcError extends Error {
    constructor(message: string, public internal = false) {
        super(message);
    }
}

export async function call(method: string, params: unknown = {}, { autoStart = true } = {}): Promise<any> {
    let st = await daemonRunning();
    if (!st) {
        if (!autoStart) throw new RpcError('Daemon is not running. Run "stpd start".');
        st = await ensureDaemon();
    }
    const res = await fetch(`http://127.0.0.1:${st.port}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-stpd-token': st.token },
        body: JSON.stringify({ method, params }),
    });
    const j: any = await res.json();
    if (!j.ok) throw new RpcError(j.error, j.internal);
    return j.result;
}
