import fs from 'node:fs';
import { paths } from '../paths.js';

export function log(msg: string): void {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try {
        fs.appendFileSync(paths.daemonLog, line);
    } catch {
        // ignore
    }
}

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Error that is reported to the client as-is (no stack). */
export class UserError extends Error {}

/** Serialise async operations so page-mutating calls never interleave. */
export class Mutex {
    private tail: Promise<unknown> = Promise.resolve();

    run<T>(fn: () => Promise<T>): Promise<T> {
        const result = this.tail.then(fn, fn);
        this.tail = result.catch(() => undefined);
        return result;
    }
}

export function timestamp(): string {
    return new Date().toISOString().replace(/[:.]/g, '-');
}
