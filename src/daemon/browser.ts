import fs from 'node:fs';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { paths } from '../paths.js';
import type { StpdConfig } from '../config.js';
import { log, UserError } from './util.js';

export interface ConsoleEntry {
    t: string;
    level: string;
    text: string;
}

/** Owns the (headless) browser and the single SillyTavern page. */
export class StBrowser {
    context: BrowserContext | null = null;
    page: Page | null = null;
    consoleBuf: ConsoleEntry[] = [];

    constructor(private cfg: StpdConfig, private stUrl: string) {}

    get cdpEndpoint(): string {
        return `http://127.0.0.1:${this.cfg.cdpPort}`;
    }

    get running(): boolean {
        return !!this.page && !this.page.isClosed();
    }

    async start(): Promise<void> {
        if (this.running) return;
        const launchOpts: Parameters<typeof chromium.launchPersistentContext>[1] = {
            headless: !this.cfg.headed,
            viewport: { width: 1400, height: 900 },
            args: [
                `--remote-debugging-port=${this.cfg.cdpPort}`,
                '--remote-debugging-address=127.0.0.1',
                '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding',
                '--disable-backgrounding-occluded-windows',
            ],
        };
        if (this.cfg.browserChannel) launchOpts.channel = this.cfg.browserChannel;
        log(`launching browser (headless=${!this.cfg.headed}, channel=${this.cfg.browserChannel || 'bundled'})`);
        try {
            this.context = await chromium.launchPersistentContext(paths.browserProfile, launchOpts);
        } catch (e) {
            const msg = String((e as Error).message || e);
            if (!this.cfg.browserChannel && /Executable doesn't exist|browserType.launch/i.test(msg)) {
                log('bundled chromium missing, falling back to msedge');
                this.context = await chromium.launchPersistentContext(paths.browserProfile, { ...launchOpts, channel: 'msedge' });
            } else {
                throw e;
            }
        }
        // Batch fan-out requests are issued from Node (shares the context's cookies) so they are not
        // throttled by Chrome's 6-connections-per-host limit.
        const ctx = this.context;
        await ctx.exposeBinding('__stpdNodeFetch', async (_source, url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
            try {
                const res = await ctx.request.fetch(url, {
                    method: init.method,
                    headers: init.headers,
                    data: init.body,
                    timeout: this.cfg.generationTimeoutMs,
                    failOnStatusCode: false,
                });
                return { status: res.status(), statusText: res.statusText(), headers: res.headersArray().map(h => [h.name, h.value]), text: await res.text() };
            } catch (e) {
                return { error: String((e as Error).message || e) };
            }
        });
        // Read the bridge at launch; page reloads re-run the same script.
        await this.context.addInitScript({ content: fs.readFileSync(paths.bridgeScript, 'utf8') });
        this.page = this.context.pages()[0] ?? await this.context.newPage();
        this.attachListeners(this.page);
        await this.load();
    }

    private attachListeners(page: Page): void {
        page.on('console', (m) => {
            const text = m.text();
            let level: string = m.type();
            if (text.startsWith('[stpd-toast:')) level = 'toast';
            this.push(level, text);
        });
        page.on('pageerror', (e) => this.push('error', `pageerror: ${e.message}`));
        page.on('dialog', (d) => {
            this.push('info', `native dialog (${d.type()}) auto-accepted: ${d.message()}`);
            d.accept().catch(() => {});
        });
        page.on('crash', () => this.push('error', 'page crashed'));
    }

    private push(level: string, text: string): void {
        this.consoleBuf.push({ t: new Date().toISOString(), level, text });
        if (this.consoleBuf.length > 2000) this.consoleBuf.splice(0, this.consoleBuf.length - 2000);
    }

    /** Navigate to SillyTavern and wait for APP_READY. */
    async load(): Promise<void> {
        const page = this.requirePage();
        await page.goto(this.stUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
        await this.waitReady();
    }

    async reload(): Promise<void> {
        const page = this.requirePage();
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 });
        await this.waitReady();
    }

    async waitReady(): Promise<void> {
        const page = this.requirePage();
        await page.waitForFunction(() => (window as any).__stpd?.ready === true, null, { timeout: 120_000, polling: 200 });
        // Let deferred init (extensions, settings load) settle.
        await page.waitForTimeout(500);
        await this.op('init');
        log('SillyTavern page ready');
    }

    requirePage(): Page {
        if (!this.page || this.page.isClosed()) throw new UserError('Browser page is not running. Call start.');
        return this.page;
    }

    /** Call window.__stpd.ops[name](params) inside the page. */
    async op<T = any>(name: string, params: any = {}, { autoPopup = 'ok' as 'ok' | 'cancel' | null } = {}): Promise<T> {
        const page = this.requirePage();
        const bufStart = this.consoleBuf.length;
        try {
            return await page.evaluate(async ([n, p, ap]) => {
                const s = (window as any).__stpd;
                const prev = s.autoPopup;
                s.autoPopup = ap;
                try {
                    return await s.ops[n](p);
                } catch (e: any) {
                    throw new Error((e?.stpdUser ? 'USER:' : '') + (e?.message || String(e)));
                } finally {
                    s.autoPopup = prev;
                }
            }, [name, params, autoPopup] as const) as T;
        } catch (e) {
            const msg = String((e as Error).message || e);
            const m = msg.match(/USER:(.*)/s);
            const base = (m ? m[1] : msg).split('\n    at ')[0].trim();
            // Surface SillyTavern error/warning toasts raised during this op.
            const toasts = this.consoleBuf.slice(bufStart)
                .filter(x => x.level === 'toast' && /^\[stpd-toast:(error|warning)\]/.test(x.text))
                .map(x => x.text.replace(/^\[stpd-toast:\w+\] /, ''));
            const full = toasts.length ? `${base}\nSillyTavern said: ${toasts.slice(-3).join(' | ')}` : base;
            if (m || toasts.length) throw new UserError(full);
            throw e;
        }
    }

    async stop(): Promise<void> {
        try {
            await this.context?.close();
        } catch {
            /* ignore */
        }
        this.context = null;
        this.page = null;
    }

    /** Is the CDP port reachable (for agents attaching their own Playwright/Puppeteer)? */
    async cdpInfo(): Promise<any> {
        try {
            const res = await fetch(this.cdpEndpoint + '/json/version', { signal: AbortSignal.timeout(2000) });
            const v: any = await res.json();
            return { http: this.cdpEndpoint, ws: v.webSocketDebuggerUrl };
        } catch {
            return null;
        }
    }
}

export function ensureBridgeExists(): void {
    if (!fs.existsSync(paths.bridgeScript)) throw new Error(`Missing ${paths.bridgeScript}`);
}
