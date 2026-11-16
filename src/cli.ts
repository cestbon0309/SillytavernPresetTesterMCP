#!/usr/bin/env node
/**
 * stpd CLI.
 *   stpd <method> [key=value ...] [--json '{...}']
 * Values are parsed as JSON when possible (numbers, booleans, arrays), otherwise taken as strings.
 * key=@path reads the value from a file (as a string).
 * Output is JSON on stdout; errors go to stderr with exit code 1.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { METHOD_LIST, METHODS } from './methods.js';
import { call, daemonRunning, ensureDaemon, RpcError } from './client.js';
import { loadConfig, saveConfig, DEFAULT_CONFIG, type StpdConfig } from './config.js';
import { paths, ensureDirs, PROJECT_ROOT } from './paths.js';

class CliExit extends Error {}

function out(data: unknown): void {
    process.stdout.write((typeof data === 'string' ? data : JSON.stringify(data, null, 2)) + '\n');
}

function die(msg: string): never {
    process.stderr.write(`error: ${msg}\n`);
    process.exit(1);
}

function parseValue(raw: string): unknown {
    if (raw.startsWith('@')) {
        const file = path.resolve(raw.slice(1));
        if (!fs.existsSync(file)) die(`file not found: ${file}`);
        return fs.readFileSync(file, 'utf8');
    }
    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
}

function parseArgs(args: string[]): Record<string, unknown> {
    const params: Record<string, unknown> = {};
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--json') {
            Object.assign(params, JSON.parse(args[++i] ?? '{}'));
        } else if (a.startsWith('--')) {
            const [k, v] = a.slice(2).split(/=(.*)/s);
            params[k.replace(/-/g, '_')] = v === undefined ? true : parseValue(v);
        } else if (a.includes('=')) {
            const [k, v] = a.split(/=(.*)/s);
            params[k] = parseValue(v);
        } else {
            die(`unexpected argument "${a}" (use key=value)`);
        }
    }
    return params;
}

function describeParams(schema: z.ZodObject<any>): string[] {
    const js: any = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
    const req = new Set<string>(js.required ?? []);
    return Object.entries<any>(js.properties ?? {}).map(([k, v]) => {
        const type = v.type ?? (v.anyOf ? v.anyOf.map((x: any) => x.type).join('|') : v.enum ? v.enum.join('|') : 'any');
        const def = v.default !== undefined ? ` (default ${JSON.stringify(v.default)})` : '';
        return `    ${k}${req.has(k) ? '' : '?'}: ${type}${def}${v.description ? ` — ${v.description}` : ''}`;
    });
}

function help(method?: string): void {
    if (method && METHODS[method]) {
        const d = METHODS[method];
        out([`stpd ${d.name} — ${d.description}`, ...describeParams(d.params)].join('\n'));
        return;
    }
    const lines = [
        'stpd — SillyTavern preset workbench for agents',
        '',
        'Usage: stpd <method> [key=value ...] [--json \'{"key": ...}\']',
        '       values are JSON-parsed when possible; key=@file reads a file',
        '',
        'Local commands:',
        '  setup [version=1.19.0]     clone SillyTavern + install deps + browser',
        '  config [key=value ...]     show / change stpd config',
        '  start [headed=true]        start daemon + SillyTavern + browser (no-op if running)',
        '  logs [which=daemon|st] [lines=80]',
        '  help [method]',
        '',
    ];
    let group = '';
    for (const d of METHOD_LIST) {
        if (d.group !== group) {
            group = d.group;
            lines.push(`[${group}]`);
        }
        lines.push(`  ${d.name.padEnd(24)} ${d.description.split('. ')[0].slice(0, 110)}`);
    }
    lines.push('', 'Run "stpd help <method>" for parameters.');
    out(lines.join('\n'));
}

function run(cmd: string, args: string[], cwd: string): void {
    process.stderr.write(`$ ${cmd} ${args.join(' ')}  (in ${cwd})\n`);
    const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.status !== 0) die(`command failed: ${cmd} ${args.join(' ')}`);
}

function setup(params: Record<string, unknown>): void {
    const cfg = loadConfig();
    const version = String(params.version ?? cfg.stVersion);
    ensureDirs();
    if (!fs.existsSync(path.join(cfg.stDir, 'server.js'))) {
        fs.mkdirSync(path.dirname(cfg.stDir), { recursive: true });
        run('git', ['clone', '--depth', '1', '-b', version, 'https://github.com/SillyTavern/SillyTavern.git', cfg.stDir], PROJECT_ROOT);
    } else {
        process.stderr.write(`SillyTavern already present at ${cfg.stDir}\n`);
    }
    if (!fs.existsSync(path.join(cfg.stDir, 'node_modules'))) {
        run('npm', ['ci', '--no-audit', '--no-fund'], cfg.stDir);
    }
    run('npx', ['playwright', 'install', 'chromium'], PROJECT_ROOT);
    saveConfig({ stVersion: version });
    out({ ok: true, stDir: cfg.stDir, version });
}

function config(params: Record<string, unknown>): void {
    const keys = Object.keys(params);
    if (!keys.length) return out({ file: paths.config, ...loadConfig() });
    for (const k of keys) {
        if (!(k in DEFAULT_CONFIG)) die(`unknown config key "${k}". Keys: ${Object.keys(DEFAULT_CONFIG).join(', ')}`);
    }
    const next = saveConfig(params as Partial<StpdConfig>);
    out({ file: paths.config, ...next, note: 'Restart the daemon (stpd stop; stpd start) for changes to apply.' });
}

function logs(params: Record<string, unknown>): void {
    const file = params.which === 'st' ? paths.stLog : paths.daemonLog;
    if (!fs.existsSync(file)) return out(`(no log at ${file})`);
    const n = Number(params.lines ?? 80);
    out(fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(-n).join('\n'));
}

async function main(): Promise<void> {
    const [cmd, ...rest] = process.argv.slice(2);
    if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return help(rest[0]);
    const params = parseArgs(rest);

    if (cmd === 'setup') return setup(params);
    if (cmd === 'config') return config(params);
    if (cmd === 'logs') return logs(params);

    if (cmd === 'start') {
        if (params.headed !== undefined) {
            const running = await daemonRunning();
            const cfg = loadConfig();
            if (running && cfg.headed !== !!params.headed) die('Daemon already running with a different "headed" setting. Run "stpd stop" first.');
            saveConfig({ headed: !!params.headed });
        }
        await ensureDaemon();
        return out(await call('start'));
    }
    if (cmd === 'stop') {
        if (!(await daemonRunning())) return out({ stopped: true, note: 'daemon was not running' });
        return out(await call('stop'));
    }
    if (cmd === 'status' && !(await daemonRunning())) {
        return out({ daemon: null, note: 'Daemon is not running. Run "stpd start".' });
    }
    if (!METHODS[cmd]) die(`unknown command "${cmd}". Run "stpd help".`);
    out(await call(cmd, params));
}

main().catch((e) => {
    if (e instanceof CliExit) return;
    process.exitCode = 1;
    process.stderr.write(`error: ${e instanceof RpcError ? e.message : (e?.stack || String(e))}
`);
});
