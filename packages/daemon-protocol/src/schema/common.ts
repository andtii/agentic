/** Building blocks shared by both directions: ids, cursors, environments, capability reports. */

import type { CapabilityReport, Cursor, EnvironmentDescriptor, EnvironmentId, MachineId, OpenSpec, SessionId } from '@agentic/core';
import { z } from 'zod';
import { LIMITS } from './limits.js';

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A branded id on the wire is a bounded, non-empty string. */
export const id = <T extends string>(): z.ZodType<T> => z.string().min(1).max(LIMITS.id).transform((s) => s as T);
export const name = z.string().min(1).max(LIMITS.id);
export const text = z.string().max(LIMITS.text);
export const nonNegativeInt = z.number().int().min(0);

export const machineId = id<MachineId>();
export const sessionId = id<SessionId>();
export const environmentId = id<EnvironmentId>();

export const cursor: z.ZodType<Cursor> = z.object({ epoch: nonNegativeInt, seq: nonNegativeInt });

/** `{ sessionId → cursor }` with a bounded number of keys. */
export const cursors: z.ZodType<Readonly<Record<string, Cursor>>> = z
    .record(z.string().min(1).max(LIMITS.id), cursor)
    .refine((r) => Object.keys(r).length <= LIMITS.list, { message: `at most ${LIMITS.list} cursors` });

export const os = z.enum(['windows', 'darwin', 'linux']);

const doctorFinding = z.object({
    level: z.enum(['error', 'warn', 'info']),
    code: name,
    message: text,
    environmentIds: z.array(environmentId).max(LIMITS.list).optional()
});

/** A runtime's verdict on one environment (EXE-07); a daemon that ran no `doctor` leaves it out. */
export const environmentVerdict = z.object({ ok: z.boolean(), findings: z.array(doctorFinding).max(LIMITS.list), checkedAt: nonNegativeInt });

export const environment: z.ZodType<EnvironmentDescriptor> = z.object({
    id: environmentId,
    machineId,
    name,
    runtime: name,
    account: z.object({
        label: text,
        authStatus: z.enum(['ok', 'missing', 'expired', 'unknown']),
        identity: text.optional()
    }),
    cwdRoots: z.array(text).max(LIMITS.list),
    concurrency: z.object({ max: nonNegativeInt, active: nonNegativeInt }),
    isolation: z.enum(['config-dir', 'profile', 'os-user', 'container', 'none']),
    doctor: environmentVerdict.optional()
});

export const environments = z.array(environment).max(LIMITS.list);

export const capabilityReport: z.ZodType<CapabilityReport> = z.object({
    runtime: name,
    supported: z.array(name).max(LIMITS.list),
    unsupported: z.array(z.object({ op: name, reason: text })).max(LIMITS.list),
    resume: z.union([z.literal('portable'), z.literal('local'), z.literal(false)]),
    cancel: z.boolean(),
    steer: z.boolean(),
    permissions: z.enum(['every-call', 'harness-filtered', 'none']),
    tools: z.enum(['native', 'mcp', 'none'])
});

export const openSpec: z.ZodType<OpenSpec> = z.object({
    agentId: name,
    cwd: text,
    system: z.string().max(LIMITS.system),
    model: name.optional(),
    maxTurns: z.number().int().min(1).optional(),
    maxBudgetUsd: z.number().min(0).optional(),
    tools: z.array(name).max(LIMITS.list),
    resume: z.unknown().optional()
});
