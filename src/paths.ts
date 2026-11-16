import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Project root (one level above dist/ or src/). */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Runtime home: holds ST config/data, logs, daemon state, outputs. Override with STPD_HOME. */
export const HOME = path.resolve(process.env.STPD_HOME || path.join(PROJECT_ROOT, '.stpd'));

export const paths = {
    home: HOME,
    config: path.join(HOME, 'stpd.json'),
    state: path.join(HOME, 'daemon.json'),
    logs: path.join(HOME, 'logs'),
    daemonLog: path.join(HOME, 'logs', 'daemon.log'),
    stLog: path.join(HOME, 'logs', 'sillytavern.log'),
    stConfig: path.join(HOME, 'st-config.yaml'),
    stData: path.join(HOME, 'st-data'),
    outputs: path.join(HOME, 'outputs'),
    tmp: path.join(HOME, 'tmp'),
    browserProfile: path.join(HOME, 'browser-profile'),
    bridgeScript: path.join(PROJECT_ROOT, 'assets', 'bridge.js'),
};

export function ensureDirs(): void {
    for (const dir of [paths.home, paths.logs, paths.stData, paths.outputs, paths.tmp]) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

/** Default SillyTavern install location (managed by `stpd setup`). */
export const DEFAULT_ST_DIR = path.join(PROJECT_ROOT, 'vendor', 'SillyTavern');
