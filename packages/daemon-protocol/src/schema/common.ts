/** Building blocks shared by both directions: ids, cursors, environments, capability reports. */

import { FS_LIST_MAX_ENTRIES, FS_LOCATE_MAX_MATCHES } from '@agentic/core';
import type { ApprovalRule, CapabilityReport, Cursor, EnvError, EnvironmentDescriptor, EnvironmentId, EnvironmentInput, EnvResult, FsError, FsOp, FsResult, MachineId, MachinePolicy, OpenSpec, OpenSpecConnector, OpenSpecPolicy, QuotaSnapshot, QuotaWindow, SessionId, ToolGrant } from '@agentic/core';
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

/**
 * What `env.request` may ask for (#236). Strict: a key the contract does not name — `profileDir` above all — fails the frame
 * instead of being stripped, so a profile directory can never ride along (decisions 2026-09-19 (c)).
 */
export const environmentInput: z.ZodType<EnvironmentInput> = z.strictObject({
    id: environmentId.optional(),
    name,
    runtime: name,
    cwdRoots: z.array(text.min(1)).min(1).max(LIMITS.list),
    concurrency: z.number().int().min(1).optional(),
    accountLabel: text.optional()
});

export const envResult: z.ZodType<EnvResult> = z.object({ environmentId });

export const envError: z.ZodType<EnvError> = z.object({
    code: z.enum(['policy-disabled', 'outside-allowed-roots', 'unknown-runtime', 'in-use', 'unknown-environment', 'invalid', 'io', 'timeout']),
    message: text
});

/** The machine-local policy a daemon reports in `hello` / `env`. */
export const machinePolicy: z.ZodType<MachinePolicy> = z.object({ webManaged: z.boolean(), allowedRoots: z.array(text.min(1)).max(LIMITS.list) });

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

/** A record of names (header or variable → secret name), bounded like any other list. */
const nameRecord = z.record(name, name).refine((r) => Object.keys(r).length <= LIMITS.list, { message: `at most ${LIMITS.list} entries` });

/** An MCP connector on the spec (#280): where it is and its secret NAMES — never a value. */
export const openSpecConnector: z.ZodType<OpenSpecConnector> = z.object({
    id: name,
    transport: z.enum(['streamable-http', 'stdio']),
    url: text.optional(),
    command: text.optional(),
    args: z.array(text).max(LIMITS.list).optional(),
    cwd: text.optional(),
    auth: z.object({ bearer: name.optional(), headers: nameRecord.optional(), env: nameRecord.optional() }).optional()
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
    connectors: z.array(openSpecConnector).max(LIMITS.list).optional(),
    resume: z.unknown().optional()
});

/**
 * What `fs.request` asks (#185, #331): list one folder, add a git worktree, or locate every checkout of an origin under
 * the roots. Paths are bounded text; the daemon decides what they mean.
 */
export const fsOp: z.ZodType<FsOp> = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('list'), path: text.min(1) }),
    z.object({ kind: z.literal('worktree'), repo: text.min(1), branch: name, base: name.optional(), path: text.min(1) }),
    z.object({ kind: z.literal('locate'), origin: text.min(1), depth: nonNegativeInt.optional() })
]);

/** A folder's git badge; `origin` is a remote URL, so bounded text rather than a name. */
const fsGitInfo = z.object({ kind: z.enum(['repo', 'worktree']), branch: name.optional(), head: name.optional(), origin: text.optional() });
const fsEntry = z.object({ name: text.min(1), path: text.min(1), git: fsGitInfo.optional() });

/**
 * What `fs.response` answers: a listing of at most `FS_LIST_MAX_ENTRIES` folders, the worktree that was added, or at most
 * `FS_LOCATE_MAX_MATCHES` checkouts of an origin.
 */
export const fsResult: z.ZodType<FsResult> = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('list'), path: text.min(1), parent: text.min(1).optional(), git: fsGitInfo.optional(), entries: z.array(fsEntry).max(FS_LIST_MAX_ENTRIES), truncated: z.boolean() }),
    z.object({ kind: z.literal('worktree'), path: text.min(1), branch: name }),
    z.object({ kind: z.literal('locate'), origin: text.min(1), matches: z.array(z.object({ path: text.min(1), git: fsGitInfo })).max(FS_LOCATE_MAX_MATCHES), truncated: z.boolean() })
]);

export const fsError: z.ZodType<FsError> = z.object({
    code: z.enum(['outside-roots', 'not-found', 'not-a-repo', 'branch-exists', 'invalid-branch', 'exists', 'timeout', 'unknown-environment', 'unsupported', 'internal']),
    message: text
});

const quotaStatus = z.enum(['ok', 'warning', 'exhausted', 'unknown']);

/** One provider limit window (#261); `utilization` is 0..1 or `null` when the provider gave no number. */
export const quotaWindow: z.ZodType<QuotaWindow> = z.object({
    id: name,
    label: text.min(1),
    period: z.enum(['minute', 'session', 'day', 'week', 'month', 'other']),
    scope: z.object({ model: name.optional() }).optional(),
    utilization: z.number().min(0).max(1).nullable(),
    used: z.number().min(0).optional(),
    limit: z.number().min(0).optional(),
    unit: z.enum(['percent', 'tokens', 'requests', 'usd', 'credits']),
    resetsAt: z.iso.datetime({ offset: true }).optional(),
    status: quotaStatus
});

/** A normalized quota snapshot — never credentials, never a profile directory (EXE-10). */
export const quotaSnapshot: z.ZodType<QuotaSnapshot> = z
    .object({
        sourceId: name,
        runtime: name,
        environmentId,
        plan: name.optional(),
        availability: z.enum(['reported', 'partial', 'not-reported']),
        reason: text.optional(),
        windows: z.array(quotaWindow).max(LIMITS.list),
        observedAt: nonNegativeInt,
        via: z.enum(['probe', 'stream', 'headers'])
    })
    // PLG-09: "not reported" is said, with its reason, and carries no numbers.
    .refine((s) => s.availability !== 'not-reported' || (s.windows.length === 0 && !!s.reason), { message: 'a not-reported snapshot has a reason and no windows', path: ['reason'] });
