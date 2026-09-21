/**
 * `agentic-daemon doctor` (EXE-07, EXE-08): is this machine paired, are its
 * environments valid, does every environment have a driver, do its working
 * roots exist — and whatever each driver's own `doctor` finds (isolation,
 * auth per profile). The token is never printed. With the harness store
 * (#369) a row per runtime says which harness it runs; a runtime with none
 * gets a hint when its upstream CLI is on `PATH` — which the daemon never uses.
 */

import type { DoctorFinding, DoctorReport, LocalEnvironment } from '@agentic/core';
import { stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { loadCredentials } from './credentials.js';
import type { DaemonDriver } from './daemon.js';
import { loadEnvironments } from './environments.js';
import { BUILTIN_HARNESSES, type HarnessStore } from './harness.js';
import type { DaemonPaths } from './paths.js';

export interface DoctorOptions {
    readonly paths: DaemonPaths;
    readonly drivers: readonly DaemonDriver[];
    /** The harness store (#369): one row per driver's runtime. */
    readonly harnesses?: HarnessStore;
    /** Where a command is on `PATH` — the hint for a missing harness. Default: a walk of `PATH` (and `PATHEXT` on Windows). */
    readonly which?: (command: string) => Promise<string | undefined>;
}

/** The first `command` on `PATH`, as a shell would find it. */
export async function whichOnPath(command: string, env: Readonly<Record<string, string | undefined>> = process.env, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
    const exts = platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
    for (const dir of (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter)) {
        if (!dir) continue;
        for (const ext of exts) {
            const candidate = join(dir, command + ext.toLowerCase());
            if (await stat(candidate).then((s) => s.isFile(), () => false)) return candidate;
        }
    }
    return undefined;
}

async function isDirectory(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isDirectory();
    } catch {
        return false;
    }
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
    const findings: DoctorFinding[] = [];
    const error = (code: string, message: string, environmentIds?: LocalEnvironment['id'][]) => findings.push({ level: 'error', code, message, ...(environmentIds ? { environmentIds } : {}) });

    try {
        const credentials = await loadCredentials(options.paths.credentialsFile);
        if (!credentials) error('not-paired', `not paired — run \`agentic-daemon pair <code> --url <platform>\` (looked in ${options.paths.credentialsFile})`);
        else findings.push({ level: 'info', code: 'paired', message: `paired as machine ${credentials.machineId} of workspace ${credentials.workspaceId} at ${credentials.url}` });
    } catch (e) {
        error('credentials-unreadable', (e as Error).message);
    }

    const loaded = await loadEnvironments(options.paths.environmentsFile);
    if (!loaded.ok) {
        for (const message of loaded.errors) error('environments-invalid', message);
        return { ok: false, findings };
    }
    // Not an error (#235): the daemon runs and reports none; it just cannot host a session yet.
    if (loaded.environments.length === 0) findings.push({ level: 'warn', code: 'no-environments', message: `${loaded.missing ? `no environments yet (${options.paths.environmentsFile} does not exist)` : `no environments in ${options.paths.environmentsFile}`} — add one with \`agentic-daemon env add --name <name> --root <dir>\`` });

    const drivers = new Map(options.drivers.map((d) => [d.runtime, d]));
    const byRuntime = new Map<string, LocalEnvironment[]>();
    for (const env of loaded.environments) {
        if (!drivers.has(env.runtime)) error('no-driver', `environment ${env.name} uses runtime "${env.runtime}", which this daemon has no driver for`, [env.id]);
        else byRuntime.set(env.runtime, [...(byRuntime.get(env.runtime) ?? []), env]);
        // Local only: the verdict a driver reports to the platform names no path (#274), so the operator here gets them.
        findings.push({ level: 'info', code: 'profile-dir', message: `environment ${env.name} (${env.id}): ${env.profileDir === undefined ? 'no profile of its own — the runtime’s default' : `profile ${env.profileDir}`}`, environmentIds: [env.id] });
        for (const root of env.cwdRoots) {
            if (!(await isDirectory(root))) findings.push({ level: 'warn', code: 'cwd-root-missing', message: `environment ${env.name}: working root ${root} is not a directory`, environmentIds: [env.id] });
        }
    }
    if (options.harnesses) {
        const failures = options.harnesses.failures();
        for (const runtime of drivers.keys()) {
            const state = options.harnesses.state(runtime);
            const install = `\`agentic-daemon harness install ${runtime}\``;
            if (state.status === 'ready') {
                const { location } = state;
                findings.push({ level: 'info', code: 'harness', message: `harness ${runtime} ${location.version}: ${location.source === 'store' ? location.binary : `${location.binary} (the daemon's own node_modules)`}` });
                continue;
            }
            if (state.status === 'broken') findings.push({ level: 'error', code: 'harness-broken', message: `harness ${runtime} is broken: ${state.problem} — reinstall it with ${install}` });
            else findings.push({ level: 'warn', code: 'harness-missing', message: `no ${runtime} harness in ${options.harnesses.root} — install it with ${install}` });
            // What the daemon's install on start (#369) last hit; it tries again on the next start.
            const failed = failures[runtime];
            if (failed) findings.push({ level: 'warn', code: 'harness-install-failed', message: `installing the ${runtime} harness failed at ${new Date(failed.at).toISOString()}: ${failed.message} — the daemon tries again when it starts, or run ${install}` });
            const command = BUILTIN_HARNESSES[runtime]?.command;
            const onPath = command ? await (options.which ?? whichOnPath)(command) : undefined;
            if (onPath) findings.push({ level: 'info', code: 'harness-on-path', message: `${onPath} is on PATH, but the daemon runs only an installed harness — ${install}` });
        }
    }
    for (const [runtime, envs] of byRuntime) {
        try {
            findings.push(...(await drivers.get(runtime)!.doctor(envs)).findings);
        } catch (e) {
            error('driver-doctor-failed', `the ${runtime} driver's checks failed: ${(e as Error).message}`, envs.map((env) => env.id));
        }
    }
    return { ok: !findings.some((f) => f.level === 'error'), findings };
}

export function formatDoctorReport(report: DoctorReport): string {
    const mark = { error: '✗', warn: '!', info: '✓' } as const;
    const lines = report.findings.map((f) => `${mark[f.level]} ${f.message}`);
    lines.push(report.ok ? 'doctor: ok' : 'doctor: problems found');
    return lines.join('\n');
}
