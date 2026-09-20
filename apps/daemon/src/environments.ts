/**
 * `environments.json` → `LocalEnvironment[]` (EXE-03/04). The file is either
 * an array or `{ "environments": [...] }`; every row is checked and every
 * problem reported at once, so `doctor` can show them all. A missing file is
 * zero environments (`missing: true`): a freshly paired machine has none yet
 * (#235) — `agentic-daemon env add` writes the first (`env-store.ts`).
 *
 * ```json
 * { "environments": [
 *   { "id": "env_work", "name": "Work", "runtime": "claude-code",
 *     "profileDir": "C:/Users/me/.claude-work", "cwdRoots": ["C:/src"], "concurrency": 2 }
 * ] }
 * ```
 *
 * `concurrency` is how many turns may run at once in the environment (default 1) — not how many sessions may be
 * open: a chat member's session stays open between messages and costs nothing until it is prompted (#394).
 */

import type { EnvironmentId, LocalEnvironment } from '@agentic/core';
import { readFile } from 'node:fs/promises';

export type EnvironmentsResult = { readonly ok: true; readonly environments: readonly LocalEnvironment[]; readonly missing?: true } | { readonly ok: false; readonly errors: readonly string[] };

const ID = /^[A-Za-z0-9_-]{1,256}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

export function parseEnvironments(value: unknown): EnvironmentsResult {
    const rows = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.environments) ? value.environments : undefined;
    if (!rows) return { ok: false, errors: ['environments.json must be an array or { "environments": [...] }'] };
    const errors: string[] = [];
    const out: LocalEnvironment[] = [];
    const seen = new Set<string>();
    rows.forEach((row, i) => {
        const at = `environments[${i}]`;
        if (!isRecord(row)) {
            errors.push(`${at} must be an object`);
            return;
        }
        const before = errors.length;
        if (typeof row.id !== 'string' || !ID.test(row.id)) errors.push(`${at}.id must be 1-256 characters of A-Z a-z 0-9 _ -`);
        else if (seen.has(row.id)) errors.push(`${at}.id "${row.id}" is used twice`);
        if (!isText(row.name, 256)) errors.push(`${at}.name is required`);
        if (!isText(row.runtime, 256)) errors.push(`${at}.runtime is required (e.g. "claude-code")`);
        if (row.profileDir !== undefined && !isText(row.profileDir)) errors.push(`${at}.profileDir must be a path`);
        if (!Array.isArray(row.cwdRoots) || row.cwdRoots.length === 0 || !row.cwdRoots.every((r) => isText(r))) errors.push(`${at}.cwdRoots must be a non-empty list of paths`);
        // One turn at a time per environment unless the row says more: a second prompt waits, a second session does not (#394).
        const concurrency = row.concurrency ?? 1;
        if (typeof concurrency !== 'number' || !Number.isInteger(concurrency) || concurrency < 1) errors.push(`${at}.concurrency must be a whole number ≥ 1`);
        if (row.accountLabel !== undefined && !isText(row.accountLabel, 256)) errors.push(`${at}.accountLabel must be text`);
        if (errors.length !== before) return;
        seen.add(row.id as string);
        out.push({
            id: row.id as EnvironmentId,
            name: row.name as string,
            runtime: row.runtime as string,
            ...(row.profileDir === undefined ? {} : { profileDir: row.profileDir as string }),
            cwdRoots: row.cwdRoots as string[],
            concurrency: concurrency as number,
            ...(row.accountLabel === undefined ? {} : { accountLabel: row.accountLabel as string })
        });
    });
    return errors.length ? { ok: false, errors } : { ok: true, environments: out };
}

export async function loadEnvironments(file: string): Promise<EnvironmentsResult> {
    let text: string;
    try {
        text = await readFile(file, 'utf8');
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, environments: [], missing: true };
        throw e;
    }
    try {
        return parseEnvironments(JSON.parse(text));
    } catch (e) {
        return { ok: false, errors: [`${file} is not JSON: ${(e as Error).message}`] };
    }
}
