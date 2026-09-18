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
 *
 * `exportAll` / `deleteAll` (OPS-10) are detached tasks over the app-level
 * `ArtifactSink` / `WorkspaceStore` ports (`defineWorkspace({ sink, store })`);
 * the cascade itself lives in `cascade.ts`. The default `Workspace` has no
 * ports: its tasks record the failure in `ops` and change nothing.
 */

import type { AgentId, ChatId, EnvironmentId, MachineId, RuntimeId, ScheduleId, WorkspaceId } from '@agentic/core';
import { actorKey, createId } from '@agentic/core';
import { defineActor, type ActorPolicy } from '@sigx/actors';
import { sameWorkspace, workspaceOwner, WORKSPACE_KEY_PREFIX } from '../auth/index.js';
import { Chat } from '../chat/index.js';
import { PAIRING_DIRECTORY_KEY, PairingDirectory } from '../pairing/directory.js';
import { deleteWorkspace, exportWorkspace } from './cascade.js';
import type { ArtifactSink, WorkspaceStore } from './ports.js';

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

/** Retention windows in days (OPS-10, `docs/retention.md`). */
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

/** The last run of one OPS-10 task. `finishedAt` without `error` is success. */
export interface WorkspaceOpRecord {
    readonly startedAt: number;
    readonly finishedAt?: number;
    readonly error?: string;
    /** Export only: the `{ws}/{stamp}` prefix the files went under. */
    readonly prefix?: string;
    /** Export: files written; delete: records purged. */
    readonly count?: number;
}

export interface WorkspaceOps {
    export?: WorkspaceOpRecord;
    delete?: WorkspaceOpRecord;
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
    /** OPS-10 task log; absent on records written before it existed. */
    ops?: WorkspaceOps;
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

export interface WorkspaceOptions {
    /** Where `exportAll` writes (R2 on Cloudflare). */
    readonly sink?: ArtifactSink;
    /** How `deleteAll` reaches child records (the actor storage). */
    readonly store?: WorkspaceStore;
    readonly now?: () => number;
    /** Override the policy chain. Default `[sameWorkspace, workspaceOwner]`. */
    readonly authorize?: ActorPolicy | readonly ActorPolicy[];
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

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function defineWorkspace(options: WorkspaceOptions = {}) {
    // Resolved per call, not captured: tests replace `Date.now` after this module loaded.
    const now = options.now ?? (() => Date.now());
    const authorize: ActorPolicy | readonly ActorPolicy[] = options.authorize ?? [sameWorkspace, workspaceOwner];
    const cascade = { ...(options.sink ? { sink: options.sink } : {}), ...(options.store ? { store: options.store } : {}), now };

    return defineActor({
        type: 'Workspace',
        authorize,
        persistence: 'explicit',
        methodReentrancy: { get: 'always' },
        state: (key): WorkspaceState => ({
            v: WORKSPACE_STATE_VERSION,
            owner: ownerOfWorkspaceKey(key),
            createdAt: now(),
            agents: [],
            chats: [],
            machines: [],
            schedules: [],
            settings: DEFAULT_SETTINGS,
            ops: {}
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

            /**
             * Records the id in the index and, when a title is given, writes it to
             * the Chat actor over a hop (#124) — the chat's own `rename` entry, so
             * `Chat.get().title` carries it. The index entry is saved first: a
             * hop that fails leaves an untitled chat, never an orphan title.
             */
            async createChat(input: CreateChatInput = {}): Promise<{ chatId: ChatId }> {
                const chatId = createId('chat') as ChatId;
                ctx.state.chats.push(chatId);
                await ctx.save();
                const title = input.title?.trim();
                if (title) await ctx.actor(Chat, actorKey(ownerOfWorkspaceKey(ctx.key) as WorkspaceId, 'chat', chatId)).rename(title);
                return { chatId };
            },

            /** Allocates and indexes a schedule id; the caller then `create`s the Schedule actor under it. */
            async createSchedule(): Promise<{ scheduleId: ScheduleId }> {
                const scheduleId = createId('schedule') as ScheduleId;
                ctx.state.schedules.push(scheduleId);
                await ctx.save();
                return { scheduleId };
            },

            async removeSchedule(scheduleId: ScheduleId): Promise<boolean> {
                const i = ctx.state.schedules.indexOf(scheduleId);
                if (i < 0) return false;
                ctx.state.schedules.splice(i, 1);
                await ctx.save();
                return true;
            },

            /**
             * Register a machine that has not paired yet. The daemon presents the
             * code to `POST /auth/pair`, which finds the workspace through the
             * global `PairingDirectory` (filed here over a hop, #37) and calls
             * `Machine.pair`, which redeems the code here through another hop;
             * the machine token itself is minted by the auth lane, never stored here.
             */
            async registerMachinePending(input: RegisterMachineInput): Promise<RegisterMachineResult> {
                if (!input.name.trim()) throw new Error('[Workspace] registerMachinePending: name is required');
                const machineId = createId('machine') as MachineId;
                const at = now();
                const pairing = { code: createPairingCode(), expiresAt: at + PAIRING_CODE_TTL_MS };
                // The directory is the door; this record is the proof. Filed first: a directory entry without a record is a
                // harmless 401 that expires, a record without a directory entry would be a code nobody can present.
                await ctx.actor(PairingDirectory, PAIRING_DIRECTORY_KEY).register(pairing.code, { workspaceId: ownerOfWorkspaceKey(ctx.key) as WorkspaceId, machineId, expiresAt: pairing.expiresAt });
                ctx.state.machines.push({ id: machineId, name: input.name, status: 'pending', registeredAt: at, pairing });
                await ctx.save();
                return { machineId, pairingCode: pairing.code, expiresAt: pairing.expiresAt };
            },

            /**
             * Redeem a pairing code: single use, expiring. Returns the machine it
             * belonged to, or `null` for an unknown, used or expired code — the
             * caller cannot tell which, by design. An expired entry is dropped.
             */
            async claimPairing(code: string): Promise<{ machineId: MachineId } | null> {
                const at = now();
                const i = ctx.state.machines.findIndex((m) => m.pairing !== undefined && codesMatch(m.pairing.code, code));
                if (i < 0) return null;
                const entry = ctx.state.machines[i]!;
                if (entry.pairing!.expiresAt <= at) {
                    ctx.state.machines.splice(i, 1);
                    await ctx.save();
                    return null;
                }
                ctx.state.machines[i] = { id: entry.id, name: entry.name, status: 'paired', registeredAt: entry.registeredAt, pairedAt: at };
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

            /** OPS-10: write everything as NDJSON through the `ArtifactSink`. Progress lands in `get().ops.export`. */
            async exportAll(): Promise<{ started: true }> {
                ctx.state.ops = { ...ctx.state.ops, export: { startedAt: now() } };
                await ctx.save();
                await ctx.tasks.start('exportAll');
                return { started: true };
            },

            /** OPS-10: purge every child record, then this one. `get()` afterwards is a fresh workspace. */
            async deleteAll(): Promise<{ started: true }> {
                ctx.state.ops = { ...ctx.state.ops, delete: { startedAt: now() } };
                await ctx.save();
                await ctx.tasks.start('deleteAll');
                return { started: true };
            }
        }),
        tasks: (ctx) => ({
            async exportAll(): Promise<void> {
                const startedAt = (await ctx.turn((c) => c.snapshot())).ops?.export?.startedAt ?? now();
                let record: WorkspaceOpRecord;
                try {
                    const report = await exportWorkspace(ctx, cascade);
                    record = { startedAt, finishedAt: now(), prefix: report.prefix, count: report.files.length };
                } catch (error) {
                    record = { startedAt, finishedAt: now(), error: errorText(error) };
                }
                await ctx.turn(async (c) => {
                    c.state.ops = { ...c.state.ops, export: record };
                    await c.save();
                });
            },
            async deleteAll(): Promise<void> {
                const startedAt = (await ctx.turn((c) => c.snapshot())).ops?.delete?.startedAt ?? now();
                try {
                    await deleteWorkspace(ctx, cascade);
                    // Success leaves nothing to write to: the record is gone.
                } catch (error) {
                    await ctx.turn(async (c) => {
                        c.state.ops = { ...c.state.ops, delete: { startedAt, finishedAt: now(), error: errorText(error) } };
                        await c.save();
                    });
                }
            }
        })
    });
}

/** The Workspace with no ports: everything but the OPS-10 tasks. The app registers `defineWorkspace({ sink, store })`. */
export const Workspace = defineWorkspace();

export type WorkspaceActor = ReturnType<typeof defineWorkspace>;

export type { ActorRecordRef, ArtifactSink, WorkspaceStore } from './ports.js';
export { childRecords, deleteWorkspace, exportWorkspace, type CascadeOptions, type DeleteReport, type ExportReport } from './cascade.js';
