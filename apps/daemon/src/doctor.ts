/**
 * `agentic-daemon doctor` (EXE-07, EXE-08): is this machine paired, are its
 * environments valid, does every environment have a driver, do its working
 * roots exist — and whatever each driver's own `doctor` finds (isolation,
 * auth per profile). The token is never printed.
 */

import type { DoctorFinding, DoctorReport, LocalEnvironment } from '@agentic/core';
import { stat } from 'node:fs/promises';
import { loadCredentials } from './credentials.js';
import type { DaemonDriver } from './daemon.js';
import { loadEnvironments } from './environments.js';
import type { DaemonPaths } from './paths.js';

export interface DoctorOptions {
    readonly paths: DaemonPaths;
    readonly drivers: readonly DaemonDriver[];
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
    if (loaded.environments.length === 0) error('no-environments', `no environments in ${options.paths.environmentsFile}`);

    const drivers = new Map(options.drivers.map((d) => [d.runtime, d]));
    const byRuntime = new Map<string, LocalEnvironment[]>();
    for (const env of loaded.environments) {
        if (!drivers.has(env.runtime)) error('no-driver', `environment ${env.name} uses runtime "${env.runtime}", which this daemon has no driver for`, [env.id]);
        else byRuntime.set(env.runtime, [...(byRuntime.get(env.runtime) ?? []), env]);
        for (const root of env.cwdRoots) {
            if (!(await isDirectory(root))) findings.push({ level: 'warn', code: 'cwd-root-missing', message: `environment ${env.name}: working root ${root} is not a directory`, environmentIds: [env.id] });
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
