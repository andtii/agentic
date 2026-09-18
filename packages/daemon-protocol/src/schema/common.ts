/** Building blocks shared by both directions: ids, cursors, environments, capability reports. */

import { FS_LIST_MAX_ENTRIES } from '@agentic/core';
import type { ApprovalRule, CapabilityReport, Cursor, EnvironmentDescriptor, EnvironmentId, FsError, FsOp, FsResult, MachineId, OpenSpec, OpenSpecPolicy, SessionId, ToolGrant } from '@agentic/core';
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

/** One `ApprovalRule` as the agent config keeps it (first-match over tools / categories / source). */
export const approvalRule: z.ZodType<ApprovalRule> = z.object({
    id: name,
    match: z.object({
        tools: z.array(name).max(LIMITS.list).optional(),
        categories: z.array(z.enum(['read', 'write', 'execute', 'network', 'destructive'])).max(LIMITS.list).optional(),
        source: z.enum(['client', 'native', 'mcp']).optional()
    }),
    outcome: z.enum(['allow', 'deny', 'ask']),
    scope: z.enum(['once', 'session']).optional()
});

export const toolGrant: z.ZodType<ToolGrant> = z.object({ name, mode: z.enum(['allow', 'ask', 'deny']).optional() });

/** The policy a session opens under (#121): the agent's rules and grants, the ancestors' constraints — every list bounded. */
export const openSpecPolicy: z.ZodType<OpenSpecPolicy> = z.object({
    rules: z.array(approvalRule).max(LIMITS.list),
    grants: z.array(toolGrant).max(LIMITS.list),
    constraints: z.array(approvalRule).max(LIMITS.list).optional()
});

export const openSpec: z.ZodType<OpenSpec> = z.object({
    agentId: name,
    cwd: text,
    system: z.string().max(LIMITS.system),
    model: name.optional(),
    maxTurns: z.number().int().min(1).optional(),
    maxBudgetUsd: z.number().min(0).optional(),
    tools: z.array(name).max(LIMITS.list),
    policy: openSpecPolicy.optional(),
    resume: z.unknown().optional()
});

/** What `fs.request` asks (#185): list one folder, or add a git worktree. Paths are bounded text; the daemon decides what they mean. */
export const fsOp: z.ZodType<FsOp> = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('list'), path: text.min(1) }),
    z.object({ kind: z.literal('worktree'), repo: text.min(1), branch: name, base: name.optional(), path: text.min(1) })
]);

const fsGitInfo = z.object({ kind: z.enum(['repo', 'worktree']), branch: name.optional(), head: name.optional() });
const fsEntry = z.object({ name: text.min(1), path: text.min(1), git: fsGitInfo.optional() });

/** What `fs.response` answers: a listing of at most `FS_LIST_MAX_ENTRIES` folders, or the worktree that was added. */
export const fsResult: z.ZodType<FsResult> = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('list'), path: text.min(1), parent: text.min(1).optional(), git: fsGitInfo.optional(), entries: z.array(fsEntry).max(FS_LIST_MAX_ENTRIES), truncated: z.boolean() }),
    z.object({ kind: z.literal('worktree'), path: text.min(1), branch: name })
]);

export const fsError: z.ZodType<FsError> = z.object({
    code: z.enum(['outside-roots', 'not-found', 'not-a-repo', 'branch-exists', 'invalid-branch', 'exists', 'timeout', 'unknown-environment', 'unsupported', 'internal']),
    message: text
});
