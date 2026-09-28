/**
 * A live read survives its actor hibernating (#714, OPS-04): the Chat object is evicted with the page's socket
 * open — `evictDurableObject` hibernates its WebSockets rather than closing them — and a later post over HTTP
 * wakes it. The woken object holds no session for that socket (`closeOrphanedLiveSockets`), so it closes it
 * `1012`; the page redials, re-seeds, and the post arrives as a frame on the new socket.
 */
import type { ChatId, WorkspaceId } from '@agentic/core';
import { Chat, Workspace, workspaceKey, type IndexedEntry } from '@agentic/platform';
import type { ActorTransport } from '@sigx/actors/client';
import { durableObjectName } from '@sigx/actors-cloudflare';
import { socketTransport } from '@sigx/actors-ws/client';
import { SELF, env, evictDurableObject } from 'cloudflare:test';
import { chatKeyOf } from '../../src/actors/keys';
import { actorSocketPath, liveOverSockets, resilientConnect } from '../../src/actors/live-socket';
import { onWorkerd } from './host-kind';
import { overHttp, signIn } from './http';

const userId = 'gh_live_hibernate';
const WS = userId as WorkspaceId;
const ORIGIN = 'https://agentic.test';

/** One actor's socket over `SELF`, paced by the page's own `resilientConnect`. */
function socketOverSelf(cookie: string, dialled: string[]): (type: string, key: string) => ActorTransport {
    return (type, key) =>
        socketTransport({
            connect: resilientConnect(
                (handlers) => {
                    const path = actorSocketPath(type, key);
                    dialled.push(path);
                    let ws: WebSocket | undefined;
                    let closed = false;
                    void SELF.fetch(`${ORIGIN}${path}`, { headers: { upgrade: 'websocket', origin: ORIGIN, cookie } }).then(
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
                { baseMs: 50, capMs: 200, wakers: new Set() }
            ),
            retryMs: 0
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

const texts = (value: unknown): string[] =>
    (((value as { entries?: IndexedEntry[] } | undefined)?.entries ?? []) as IndexedEntry[]).flatMap((e) => (e.entry.t === 'msg' ? e.entry.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])) : []));

describe('worker: a live socket across hibernation', () => {
    // Hibernation is a Durable Object's: the Node host never evicts an actor a live socket holds (#995).
    it.skipIf(!onWorkerd)('hibernate with the socket open, wake on a state change, the frame arrives after a redial', async () => {
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

        await overHttp(Chat, chatKey, cookie).post('before the nap', []);
        await until(() => texts(values[values.length - 1]).includes('before the nap'), 'the first post');

        const namespace = (env as unknown as { ACTORS: DurableObjectNamespace }).ACTORS;
        await evictDurableObject(namespace.get(namespace.idFromName(durableObjectName({ type: 'Chat', key: chatKey }))), { webSockets: 'hibernate' });

        await overHttp(Chat, chatKey, cookie).post('after the nap', []);
        await until(() => texts(values[values.length - 1]).includes('after the nap'), 'the post after hibernation');
        expect(errors).toEqual([]);
        // One redial: the orphaned socket was closed by the woken object, and the page came back on its own.
        expect(dialled).toEqual([actorSocketPath('Chat', chatKey), actorSocketPath('Chat', chatKey)]);

        stop();
        await transport.close?.();
    });
});
