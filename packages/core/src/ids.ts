/**
 * Branded ids. Every platform object is addressed by one of these; the brand
 * stops a `ChatId` from being passed where a `TaskId` is expected, at zero
 * runtime cost.
 */

declare const brand: unique symbol;
type Brand<T extends string> = string & { readonly [brand]: T };

export type WorkspaceId = Brand<'workspace'>;
export type AgentId = Brand<'agent'>;
export type ChatId = Brand<'chat'>;
export type TaskId = Brand<'task'>;
export type SessionId = Brand<'session'>;
export type MachineId = Brand<'machine'>;
export type EnvironmentId = Brand<'environment'>;
export type ScheduleId = Brand<'schedule'>;
export type MessageId = Brand<'message'>;
export type ProjectId = Brand<'project'>;

export type IdPrefix = 'ws' | 'agent' | 'chat' | 'task' | 'session' | 'machine' | 'env' | 'schedule' | 'msg' | 'project';

/**
 * A new id: `<prefix>_<22 url-safe chars>`. Uses `crypto.getRandomValues`,
 * available on Workers, browsers and Node 20+ — no `node:` import.
 */
export function createId(prefix: IdPrefix): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    let out = '';
    for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
    return `${prefix}_${out}`;
}

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The key an actor is addressed by: workspace-prefixed so `authorize` can check the prefix first. */
export function actorKey(workspace: WorkspaceId, kind: 'agent' | 'chat' | 'task' | 'session' | 'machine' | 'schedule' | 'memory', id: string): string {
    return `${workspace}:${kind}:${id}`;
}

/** The workspace an actor key belongs to, or `null` when the key is not workspace-prefixed. */
export function workspaceOfKey(key: string): WorkspaceId | null {
    const i = key.indexOf(':');
    return i > 0 ? (key.slice(0, i) as WorkspaceId) : null;
}
