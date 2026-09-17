/**
 * Chat test fixtures on the shared harness (`src/testing`): principals of one
 * workspace, the chat key, and a storage that records how big every save was.
 */
import type { ActorStorage } from '@sigx/actors';
import { actorKey, type AgentId, type Principal, type SessionId, type WorkspaceId } from '@agentic/core';
import { Chat, ChatPage } from '../../src/chat/index.js';
import { memoryStorage, testActorApp, type TestActorApp } from '../../src/testing/index.js';

export const WS = 'ws_test' as WorkspaceId;
export const A = 'agent_a' as AgentId;
export const B = 'agent_b' as AgentId;
export const C = 'agent_c' as AgentId;

export const chatKey = (id = 'c1'): string => actorKey(WS, 'chat', id);

export const user: Principal = { kind: 'user', userId: 'u1', workspaceId: WS };
export const agent = (agentId: AgentId, workspaceId: WorkspaceId = WS): Principal => ({
    kind: 'agent',
    workspaceId,
    agentId,
    sessionId: `session_${agentId}` as SessionId
});

export interface Write {
    readonly type: string;
    readonly key: string;
    /** Entries in the saved window (`-1` for records without one). */
    readonly entries: number;
}

/** `memoryStorage` that records every full save with the size of its window — what a post costs. */
export function countingStorage(): { storage: ActorStorage; writes: Write[] } {
    const inner = memoryStorage();
    const writes: Write[] = [];
    const storage: ActorStorage = {
        load: (type, key) => inner.load(type, key),
        clear: (type, key, etag) => inner.clear(type, key, etag),
        save(type, key, state, etag) {
            const window = (state as { window?: unknown }).window;
            writes.push({ type, key, entries: Array.isArray(window) ? window.length : -1 });
            return inner.save(type, key, state, etag);
        }
    };
    return { storage, writes };
}

/** A started app serving `Chat` and `ChatPage`. */
export async function startChatApp(storage?: ActorStorage): Promise<TestActorApp> {
    const app = testActorApp([Chat, ChatPage], storage ? { storage } : {});
    await app.start();
    return app;
}
