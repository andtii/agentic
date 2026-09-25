/**
 * Live reads on the object-terminated socket inside workerd (#712): the
 * page's `liveOverSockets` router, with each actor's `socketTransport`
 * dialled through the Worker's `/_sigx/socket/{type}/{key}` upgrade — the
 * route that forwards to the actor's Durable Object, which accepts it with
 * the hibernation API. A post over HTTP reaches the subscriber as a pushed
 * value, and the upgrade is refused without a session.
 */
import type { ChatId, WorkspaceId } from '@agentic/core';
import { Chat, Workspace, workspaceKey, type IndexedEntry } from '@agentic/platform';
import type { ActorTransport } from '@sigx/actors/client';
import { socketTransport } from '@sigx/actors-ws/client';
import { SELF } from 'cloudflare:test';
import { chatKeyOf } from '../../src/actors/keys';
import { actorSocketPath, liveOverSockets } from '../../src/actors/live-socket';
import { overHttp, signIn } from './http';

const userId = 'gh_live_socket';
const WS = userId as WorkspaceId;
const ORIGIN = 'https://agentic.test';

/** One actor's socket over `SELF`: the upgrade carries the cookie, as the browser's same-origin WebSocket does. */
function socketOverSelf(cookie: string | null, dialled: string[]): (type: string, key: string) => ActorTransport {
    return (type, key) =>
        socketTransport({
            connect(handlers) {
                const path = actorSocketPath(type, key);
                dialled.push(path);
                let ws: WebSocket | undefined;
                let closed = false;
                void SELF.fetch(`${ORIGIN}${path}`, { headers: { upgrade: 'websocket', origin: ORIGIN, ...(cookie ? { cookie } : {}) } }).then(
                    (res) => {
                        ws = res.webSocket ?? undefined;
                        if (!ws || closed) return handlers.onClose();
                        ws.accept();
                        ws.addEventListener('message', (e) => handlers.onMessage(String(e.data)));
                        ws.addEventListener('close', () => handlers.onClose());
                        handlers.onOpen();
                    },
                    () => handlers.onClose()
                );
                return {
                    send: (m) => ws?.send(m),
                    close: () => {
                        closed = true;
                        ws?.close();
                    }
                };
            },
            retryMs: 50,
            maxRetryMs: 200
        });
}

async function until(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

const unusedCalls: ActorTransport = {
    name: 'unused',
    call: () => Promise.reject(new Error('calls are not under test')),
    stream: () => {
        throw new Error('streams are not under test');
    }
};

describe('worker: live reads on the object-terminated socket', () => {
    it('pushes a chat post to a subscriber on the per-actor socket', async () => {
        const cookie = await signIn(userId);
        const { chatId } = await overHttp(Workspace, workspaceKey(WS), cookie).createChat({});
        const chatKey = chatKeyOf(WS, chatId as ChatId);
        const dialled: string[] = [];
        const transport = liveOverSockets({ calls: unusedCalls, socketFor: socketOverSelf(cookie, dialled) });

        const values: unknown[] = [];
        const errors: Error[] = [];
        const stop = transport.live!().subscribe({ type: 'Chat', key: chatKey, method: 'history', args: [null, 50] }, (v) => values.push(v), (e) => errors.push(e));
        await until(() => values.length >= 1 || errors.length > 0, 'the first live value');
        expect(errors).toEqual([]);
        expect(dialled).toEqual([actorSocketPath('Chat', chatKey)]);

        await overHttp(Chat, chatKey, cookie).post('over the socket', []);
        const entries = (): IndexedEntry[] => ((values[values.length - 1] as { entries: IndexedEntry[] } | undefined)?.entries ?? []);
        await until(() => entries().some((e) => e.entry.t === 'msg' && e.entry.parts.some((p) => p.type === 'text' && p.text === 'over the socket')), 'the post on the live view');

        stop();
        await transport.close?.();
    });

    it('refuses a live read without a session', async () => {
        const cookie = await signIn(userId);
        const { chatId } = await overHttp(Workspace, workspaceKey(WS), cookie).createChat({});
        const transport = liveOverSockets({ calls: unusedCalls, socketFor: socketOverSelf(null, []) });
        const values: unknown[] = [];
        const errors: Error[] = [];
        const stop = transport.live!().subscribe({ type: 'Chat', key: chatKeyOf(WS, chatId as ChatId), method: 'history', args: [null, 50] }, (v) => values.push(v), (e) => errors.push(e));
        await until(() => errors.length > 0 || values.length > 0, 'the refusal');
        expect(values).toEqual([]);
        stop();
        await transport.close?.();
    });
});
