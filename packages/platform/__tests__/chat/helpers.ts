/**
 * Chat test fixtures on the shared harness (`src/testing`): principals of one
 * workspace, the chat key, and a storage that records how big every save was.
 */
import type { ActorStorage } from '@sigx/actors';
import { actorKey, type AgentId, type ChatFile, type ChatFileBody, type ChatFileStore, type ChatId, type Principal, type SessionId, type WorkspaceId } from '@agentic/core';
import { Chat, ChatPage, defineChatActor } from '../../src/chat/index.js';
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

/** A started app serving `Chat` (over `files` when given) and `ChatPage`. */
export async function startChatApp(storage?: ActorStorage, files?: ChatFileStore): Promise<TestActorApp> {
    const app = testActorApp([files ? defineChatActor({ files }) : Chat, ChatPage], storage ? { storage } : {});
    await app.start();
    return app;
}

/** An in-memory `ChatFileStore` (#203) that records `markPosted` / `deleteChat` and counts `get`s. */
export interface MemoryFileStore extends ChatFileStore {
    readonly bodies: Map<string, ChatFileBody>;
    readonly posted: string[];
    readonly deleted: string[];
    gets: number;
    /** Put a file's record and bytes straight in (what the web upload route's R2 write does). */
    add(workspaceId: WorkspaceId, file: ChatFile, bytes: Uint8Array | string): void;
    /** Make `markPosted` throw from now on. */
    failMarks: boolean;
}

export function memoryFileStore(): MemoryFileStore {
    const bodies = new Map<string, ChatFileBody>();
    const k = (ws: string, chatId: string, fileId: string) => `${ws}/${chatId}/${fileId}`;
    const store: MemoryFileStore = {
        bodies,
        posted: [],
        deleted: [],
        gets: 0,
        failMarks: false,
        add(workspaceId, file, bytes) {
            bodies.set(k(workspaceId, file.chatId, file.id), { file, bytes: typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes });
        },
        async put(workspaceId, file, body) {
            const bytes = body instanceof Uint8Array ? body : body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(await new Response(body).arrayBuffer());
            store.add(workspaceId, file, bytes);
        },
        async get(workspaceId, chatId, fileId) {
            store.gets++;
            return bodies.get(k(workspaceId, chatId, fileId)) ?? null;
        },
        async markPosted(workspaceId, chatId, fileId) {
            if (store.failMarks) throw new Error('store down');
            store.posted.push(k(workspaceId, chatId, fileId));
        },
        async deleteChat(workspaceId, chatId) {
            store.deleted.push(`${workspaceId}/${chatId}`);
            for (const key of bodies.keys()) if (key.startsWith(`${workspaceId}/${chatId}/`)) bodies.delete(key);
        },
        async sweepOrphans() {
            return 0;
        }
    };
    return store;
}

/** A `ChatFile` record of chat `chatId`. */
export const chatFile = (id: string, extra: Partial<ChatFile> = {}, chatId = 'c1'): ChatFile => ({ id, chatId: chatId as ChatId, name: `${id}.png`, mediaType: 'image/png', bytes: 3, at: 1_000, ...extra });
