import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../paths.js';
import type { StpdConfig } from '../config.js';
import { log, sleep } from './util.js';

/** Manages the isolated SillyTavern server process. */
export class StProcess {
    private child: ChildProcess | null = null;
    private exited = false;

    constructor(private cfg: StpdConfig) {}

    get url(): string {
        return `http://127.0.0.1:${this.cfg.stPort}`;
    }

    get running(): boolean {
        return !!this.child && !this.exited;
    }

    get pid(): number | undefined {
        return this.child?.pid;
    }

    async start(): Promise<void> {
        if (this.running) return;
        const serverJs = path.join(this.cfg.stDir, 'server.js');
        if (!fs.existsSync(serverJs)) {
            throw new Error(`SillyTavern not found at ${this.cfg.stDir}. Run "stpd setup" first.`);
        }
        if (!fs.existsSync(path.join(this.cfg.stDir, 'node_modules'))) {
            throw new Error(`SillyTavern dependencies are missing in ${this.cfg.stDir}. Run "stpd setup" first.`);
        }
        if (await this.isUp()) {
            throw new Error(`Port ${this.cfg.stPort} is already in use (another SillyTavern?). Change stPort in ${paths.config}.`);
        }

        const out = fs.openSync(paths.stLog, 'a');
        const args = [
            serverJs,
            '--configPath', paths.stConfig,
            '--dataRoot', paths.stData,
            '--port', String(this.cfg.stPort),
            '--listen', 'false',
            '--browserLaunchEnabled', 'false',
            '--enableIPv6', 'false',
            '--enableIPv4', 'true',
        ];
        log(`starting SillyTavern: node ${args.join(' ')}`);
        this.exited = false;
        this.child = spawn(process.execPath, args, {
            cwd: this.cfg.stDir,
            stdio: ['ignore', out, out],
            windowsHide: true,
            env: { ...process.env, NODE_ENV: 'production', FORCE_COLOR: '0' },
        });
        this.child.on('exit', (code) => {
            this.exited = true;
            log(`SillyTavern exited with code ${code}`);
        });

        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
            if (this.exited) {
                throw new Error(`SillyTavern exited during startup. See ${paths.stLog}`);
            }
            if (await this.isUp()) {
                log('SillyTavern is up');
                return;
            }
            await sleep(500);
        }
        throw new Error(`SillyTavern did not start within 120s. See ${paths.stLog}`);
    }

    async isUp(): Promise<boolean> {
        try {
            const res = await fetch(this.url + '/', { signal: AbortSignal.timeout(2000) });
            return res.status < 500;
        } catch {
            return false;
        }
    }

    async stop(): Promise<void> {
        if (!this.child || this.exited) return;
        const child = this.child;
        child.kill();
        const deadline = Date.now() + 10_000;
        while (!this.exited && Date.now() < deadline) await sleep(100);
        if (!this.exited && child.pid) {
            try { process.kill(child.pid, 'SIGKILL'); } catch { /* ignore */ }
        }
        this.child = null;
    }
}
