import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../paths.js';
import type { StpdConfig } from '../config.js';
import { StProcess } from './st-process.js';
import { StBrowser } from './browser.js';
import { log, Mutex, UserError, timestamp } from './util.js';

interface RuntimeState {
    presetSource?: { source: string; name: string };
}

/** Everything the daemon owns: SillyTavern process, browser, persistent bits of state. */
export class Runtime {
    st: StProcess;
    browser: StBrowser;
    lock = new Mutex();
    private statePath = path.join(paths.home, 'runtime.json');
    state: RuntimeState;

    constructor(public cfg: StpdConfig) {
        this.st = new StProcess(cfg);
        this.browser = new StBrowser(cfg, this.st.url);
        this.state = fs.existsSync(this.statePath) ? JSON.parse(fs.readFileSync(this.statePath, 'utf8')) : {};
    }

    saveState(): void {
        fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
    }

    async start(): Promise<void> {
        await this.st.start();
        await this.browser.start();
    }

    async ensureStarted(): Promise<void> {
        if (!this.st.running) await this.st.start();
        if (!this.browser.running) await this.browser.start();
    }

    async restart(): Promise<void> {
        await this.browser.stop();
        await this.st.stop();
        await this.start();
    }

    async shutdown(): Promise<void> {
        log('shutting down');
        await this.browser.stop();
        await this.st.stop();
    }

    /** Write a JSON payload to outputs/ and return the path. */
    writeOutput(kind: string, data: unknown, explicitPath?: string): string {
        const file = explicitPath ? path.resolve(explicitPath) : path.join(paths.outputs, `${timestamp()}-${kind}.json`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
        return file;
    }

    /** Resolve a local path or download an http(s) URL into tmp/, returning a local path. */
    async fetchSource(source: string, fileName?: string): Promise<string> {
        if (/^https?:\/\//i.test(source)) {
            const res = await fetch(source, { signal: AbortSignal.timeout(60_000) });
            if (!res.ok) throw new UserError(`Download failed (${res.status}) for ${source}`);
            const buf = Buffer.from(await res.arrayBuffer());
            let name = fileName || decodeURIComponent(new URL(source).pathname.split('/').pop() || 'download');
            name = name.replace(/[<>:"/\\|?*]/g, '_');
            const dir = path.join(paths.tmp, `dl-${timestamp()}`);
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, name);
            fs.writeFileSync(file, buf);
            return file;
        }
        const file = path.resolve(source);
        if (!fs.existsSync(file)) throw new UserError(`File not found: ${file}`);
        return file;
    }
}
