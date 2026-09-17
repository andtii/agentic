/**
 * The seams the A2A server sits on. No actors here: the platform hands the
 * handler a `SessionPort` (which agents are exposed, and the `AgentSession`
 * behind a context) and, optionally, a `TaskStore` to persist task snapshots.
 */

import type { AgentCapabilities, AgentSession } from '@sigx/ai-agent';
import type { A2aTask, AgentProvider, AgentSkill } from '../protocol/index.js';

/** One agent flagged `exposeA2A` — what its card is built from. */
export interface ExposedAgent {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    /** Card `version`; default `0.0.0`. */
    readonly version?: string;
    /** What the underlying agent accepts; decides `defaultInputModes`. Default `text`. */
    readonly promptParts?: AgentCapabilities['promptParts'];
    /** Explicit media types; win over `promptParts`. */
    readonly inputModes?: readonly string[];
    readonly outputModes?: readonly string[];
    /** Default: one `chat` skill named after the agent. */
    readonly skills?: readonly AgentSkill[];
    readonly provider?: AgentProvider;
    readonly documentationUrl?: string;
    readonly iconUrl?: string;
}

/** Sessions behind contexts. A contextId IS a session: the same id returns the same live session while it runs. */
export interface SessionPort {
    /** Every agent exposed over A2A. */
    agents(): Promise<readonly ExposedAgent[]> | readonly ExposedAgent[];
    /**
     * The session for `contextId` on `agentId` — opened on first use, the same one
     * afterwards (an `INPUT_REQUIRED` answer arrives in a later request). `request`
     * is the HTTP request, for the port's own auth and principal.
     */
    session(agentId: string, contextId: string, request: Request): Promise<AgentSession>;
    /** Gate every request; `false` answers 401. Default: open. */
    authorize?(request: Request): Promise<boolean> | boolean;
}

/** A task snapshot as the store keeps it. */
export interface TaskRecord {
    readonly agentId: string;
    readonly task: A2aTask;
    /** Epoch milliseconds of the last status change — `ListTasks` orders by it. */
    readonly updatedAt: number;
}

/** Where task snapshots live between requests. The default is in memory. */
export interface TaskStore {
    get(id: string): Promise<TaskRecord | undefined> | TaskRecord | undefined;
    put(record: TaskRecord): Promise<void> | void;
    list(): Promise<readonly TaskRecord[]> | readonly TaskRecord[];
}

export function memoryTaskStore(): TaskStore {
    const records = new Map<string, TaskRecord>();
    return {
        get: (id) => records.get(id),
        put: (record) => {
            records.set(record.task.id, record);
        },
        list: () => [...records.values()]
    };
}
