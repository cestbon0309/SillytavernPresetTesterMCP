import fs from 'node:fs';
import { paths, DEFAULT_ST_DIR } from './paths.js';

export interface StpdConfig {
    /** SillyTavern install dir. */
    stDir: string;
    /** SillyTavern git tag/branch used by `stpd setup`. */
    stVersion: string;
    /** Port the managed SillyTavern listens on (127.0.0.1 only). */
    stPort: number;
    /** Port of the stpd daemon RPC server (127.0.0.1 only). */
    daemonPort: number;
    /** Chrome DevTools Protocol port exposed for agents (127.0.0.1 only). */
    cdpPort: number;
    /** Run the browser with a visible window. */
    headed: boolean;
    /** Playwright browser channel: "" = bundled chromium, or "msedge" / "chrome". */
    browserChannel: string;
    /** Default timeout for a single generation, ms. */
    generationTimeoutMs: number;
}

export const DEFAULT_CONFIG: StpdConfig = {
    stDir: DEFAULT_ST_DIR,
    stVersion: '1.19.0',
    stPort: 8123,
    daemonPort: 8124,
    cdpPort: 9223,
    headed: false,
    browserChannel: '',
    generationTimeoutMs: 10 * 60 * 1000,
};

export function loadConfig(): StpdConfig {
    let user: Partial<StpdConfig> = {};
    if (fs.existsSync(paths.config)) {
        user = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
    }
    return { ...DEFAULT_CONFIG, ...user };
}

export function saveConfig(patch: Partial<StpdConfig>): StpdConfig {
    let current: Partial<StpdConfig> = {};
    if (fs.existsSync(paths.config)) {
        current = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
    }
    const next = { ...current, ...patch };
    fs.mkdirSync(paths.home, { recursive: true });
    fs.writeFileSync(paths.config, JSON.stringify(next, null, 2));
    return { ...DEFAULT_CONFIG, ...next };
}
