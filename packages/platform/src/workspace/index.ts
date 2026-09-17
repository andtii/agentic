/**
 * Workspace — the per-user root actor (architecture §4, §9; USR-01/02,
 * OPS-01/10). Keyed `ws:{userId}`; owns the index of everything in the
 * workspace, the settings, and the pairing codes machines register with.
 *
 * Its `authorize` chain is the one every other actor copies:
 * `[sameWorkspace, <who may call this actor>]`.
 *
 * Persistence is explicit and every mutation ends in `ctx.save()` inside the
 * turn — on Cloudflare `onDeactivate` never runs (architecture §3).
 */

import type { AgentId, ChatId, EnvironmentId, MachineId, RuntimeId, ScheduleId } from '@agentic/core';
import { createId } from '@agentic/core';
import { defineActor } from '@sigx/actors';
import { sameWorkspace, workspaceOwner, WORKSPACE_KEY_PREFIX } from '../auth/index.js';

export const WORKSPACE_STATE_VERSION = 1;

/** Pairing codes: 6 chars, 10 minutes, single use (architecture §9). */
export const PAIRING_CODE_LENGTH = 6;
export const PAIRING_CODE_TTL_MS = 10 * 60_000;
/** Unambiguous uppercase alphabet — no 0/O, 1/I. */
const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface NotificationPrefs {
    readonly inbox: boolean;
    readonly push: boolean;
}

/** Retention windows in days (OPS-10). */
export interface RetentionSettings {
    readonly sessionLogDays: number;
    readonly artifactDays: number;
}

export interface WorkspaceDefaults {
    readonly runtime: RuntimeId;
    readonly environmentId?: EnvironmentId;
    readonly model?: string;
}

export interface WorkspaceSettings {
    /** IANA time zone the workspace's schedules and digests use. */
    readonly timeZone: string;
    readonly notifications: NotificationPrefs;
    readonly defaults: WorkspaceDefaults;
    readonly retention: RetentionSettings;
}

export const DEFAULT_SETTINGS: WorkspaceSettings = {
    timeZone: 'UTC',
    notifications: { inbox: true, push: false },
    defaults: { runtime: 'anthropic-api' },
    retention: { sessionLogDays: 90, artifactDays: 30 }
};

export type MachineStatus = 'pending' | 'paired';

/** The Workspace's view of a machine; the Machine actor holds the rest. */
export interface MachineIndexEntry {
    readonly id: MachineId;
    readonly name: string;
    readonly status: MachineStatus;
    readonly registeredAt: number;
    readonly pairedAt?: number;
    /** Present only while `status === 'pending'`. */
    readonly pairing?: { readonly code: string; readonly expiresAt: number };
}

export interface WorkspaceState {
    v: number;
    /** The owning user; the key's `{userId}` segment. */
    owner: string;
    createdAt: number;
    agents: AgentId[];
    chats: ChatId[];
    machines: MachineIndexEntry[];
    schedules: ScheduleId[];
    settings: WorkspaceSettings;
}

/** What `get` returns: the state, detached from the actor. */
export type WorkspaceView = Readonly<WorkspaceState>;

export interface CreateAgentInput {
    readonly name: string;
}

export interface CreateChatInput {
    readonly title?: string;
}

export interface RegisterMachineInput {
    readonly name: string;
}

export interface RegisterMachineResult {
    readonly machineId: MachineId;
    readonly pairingCode: string;
    readonly expiresAt: number;
}

/** A one-level-deep partial for `updateSettings`. */
export interface SettingsPatch {
    readonly timeZone?: string;
    readonly notifications?: Partial<NotificationPrefs>;
    readonly defaults?: Partial<WorkspaceDefaults>;
    readonly retention?: Partial<RetentionSettings>;
}

/** The `{userId}` of a `ws:{userId}` key. */
export function ownerOfWorkspaceKey(key: string): string {
    return key.startsWith(WORKSPACE_KEY_PREFIX) ? key.slice(WORKSPACE_KEY_PREFIX.length) : key;
}

export function createPairingCode(): string {
    const bytes = new Uint8Array(PAIRING_CODE_LENGTH);
    crypto.getRandomValues(bytes);
    let out = '';
    for (const b of bytes) out += PAIRING_ALPHABET[b % PAIRING_ALPHABET.length];
    return out;
}

/** Same amount of work whatever the first mismatch is. */
function codesMatch(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

export const Workspace = defineActor({
    type: 'Workspace',
    authorize: [sameWorkspace, workspaceOwner],
    persistence: 'explicit',
    state: (key): WorkspaceState => ({
        v: WORKSPACE_STATE_VERSION,
        owner: ownerOfWorkspaceKey(key),
        createdAt: Date.now(),
        agents: [],
        chats: [],
        machines: [],
        schedules: [],
        settings: DEFAULT_SETTINGS
    }),
    methods: (ctx) => ({
        async get(): Promise<WorkspaceView> {
            return ctx.snapshot();
        },

        /** Records the id in the index; the Agent actor's config is written by the Agent lane. */
        async createAgent(input: CreateAgentInput): Promise<{ agentId: AgentId }> {
            if (!input.name.trim()) throw new Error('[Workspace] createAgent: name is required');
            const agentId = createId('agent') as AgentId;
            ctx.state.agents.push(agentId);
            await ctx.save();
            return { agentId };
        },

        async createChat(_input: CreateChatInput = {}): Promise<{ chatId: ChatId }> {
            const chatId = createId('chat') as ChatId;
            ctx.state.chats.push(chatId);
            await ctx.save();
            return { chatId };
        },

        /**
         * Register a machine that has not paired yet. The daemon presents the
         * code to `Machine.pair`, which redeems it here through a hop; the
         * machine token itself is minted by the auth lane, never stored here.
         */
        async registerMachinePending(input: RegisterMachineInput): Promise<RegisterMachineResult> {
            if (!input.name.trim()) throw new Error('[Workspace] registerMachinePending: name is required');
            const machineId = createId('machine') as MachineId;
            const now = Date.now();
            const pairing = { code: createPairingCode(), expiresAt: now + PAIRING_CODE_TTL_MS };
            ctx.state.machines.push({ id: machineId, name: input.name, status: 'pending', registeredAt: now, pairing });
            await ctx.save();
            return { machineId, pairingCode: pairing.code, expiresAt: pairing.expiresAt };
        },

        /**
         * Redeem a pairing code: single use, expiring. Returns the machine it
         * belonged to, or `null` for an unknown, used or expired code — the
         * caller cannot tell which, by design. An expired entry is dropped.
         */
        async claimPairing(code: string): Promise<{ machineId: MachineId } | null> {
            const now = Date.now();
            const i = ctx.state.machines.findIndex((m) => m.pairing !== undefined && codesMatch(m.pairing.code, code));
            if (i < 0) return null;
            const entry = ctx.state.machines[i]!;
            if (entry.pairing!.expiresAt <= now) {
                ctx.state.machines.splice(i, 1);
                await ctx.save();
                return null;
            }
            ctx.state.machines[i] = { id: entry.id, name: entry.name, status: 'paired', registeredAt: entry.registeredAt, pairedAt: now };
            await ctx.save();
            return { machineId: entry.id };
        },

        /** Every machine, without the pairing codes — those were shown once, at registration. */
        async listMachines(): Promise<readonly MachineIndexEntry[]> {
            return ctx.state.machines.map((m) => {
                const { pairing: _pairing, ...rest } = ctx.snapshot(m);
                return rest;
            });
        },

        async removeMachine(machineId: MachineId): Promise<boolean> {
            const i = ctx.state.machines.findIndex((m) => m.id === machineId);
            if (i < 0) return false;
            ctx.state.machines.splice(i, 1);
            await ctx.save();
            return true;
        },

        async updateSettings(patch: SettingsPatch): Promise<WorkspaceSettings> {
            const s = ctx.state.settings;
            ctx.state.settings = {
                timeZone: patch.timeZone ?? s.timeZone,
                notifications: { ...s.notifications, ...patch.notifications },
                defaults: { ...s.defaults, ...patch.defaults },
                retention: { ...s.retention, ...patch.retention }
            };
            await ctx.save();
            return ctx.snapshot(ctx.state.settings);
        },

        /** OPS-10: stream everything to R2 as NDJSON. v1 stub — starts the detached task. */
        async exportAll(): Promise<{ started: true }> {
            await ctx.tasks.start('exportAll');
            return { started: true };
        },

        /** OPS-10: cascade-delete every child actor. v1 stub — starts the detached task. */
        async deleteAll(): Promise<{ started: true }> {
            await ctx.tasks.start('deleteAll');
            return { started: true };
        }
    }),
    tasks: () => ({
        async exportAll(): Promise<void> {
            // Stub: the R2 export lands with the retention issue (OPS-10).
        },
        async deleteAll(): Promise<void> {
            // Stub: the cascade lands once the child actors exist (OPS-10).
        }
    })
});

export type WorkspaceActor = typeof Workspace;
