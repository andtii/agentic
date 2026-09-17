/**
 * Inbox round trip (append, list, ack) with a live read, the cap, the
 * workspace policy, and `push` recording delivery attempts instead of
 * throwing (issue #29 acceptance). Runs on the shared harness in
 * `src/testing`: `defineActorApp` over recording in-memory storage, the
 * principal bound per call through the real in-process pipeline.
 */
import type { WorkspaceId } from '@agentic/core';
import { statusOf, testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index.js';
import {
    Inbox,
    defineInbox,
    inboxKey,
    INBOX_CAP,
    initialInboxState,
    reduceInbox,
    type InboxNotification,
    type NotificationChannel
} from '../../src/notify/index.js';

const WS = 'u1' as WorkspaceId;
const KEY = inboxKey(WS);
const owner = userPrincipal('u1');

let app: TestActorApp | null = null;

async function start(defs: readonly Parameters<typeof testActorApp>[0][number][] = [Inbox]): Promise<TestActorApp> {
    app = testActorApp(defs);
    await app.start();
    return app;
}

const inboxOf = (a: TestActorApp) => a.as(owner).actor(Inbox, KEY);

afterEach(async () => {
    await app?.stop();
    app = null;
});

/** One iterator pulled on demand, so "mutate, then expect the next value" cannot race the seed read. */
function reader<T>(stream: AsyncIterable<unknown>) {
    const iterator = stream[Symbol.asyncIterator]();
    return {
        async next(what: string): Promise<T> {
            const r = await Promise.race([
                iterator.next(),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what}: nothing within 2s`)), 2000))
            ]);
            if (r.done) throw new Error(`${what}: the live read ended`);
            return r.value as T;
        },
        close: () => iterator.return?.()
    };
}

describe('Inbox actor', () => {
    it('round-trips append → list (newest first) → ack, and counts unread', async () => {
        const inbox = inboxOf(await start());
        const a = await inbox.append({ kind: 'reminder', title: 'Stand-up', ref: { kind: 'schedule', scheduleId: 'schedule_1' as never } });
        const b = await inbox.append({ kind: 'task-done', title: 'Report ready', body: 'PDF attached', ref: { kind: 'task', taskId: 'task_1' as never } });

        expect(a.id).toBe('n_1');
        expect(b.id).toBe('n_2');
        expect(a.read).toBe(false);
        expect(a.deliveries).toEqual([]);

        const rows = await inbox.list();
        expect(rows.map((n) => n.id)).toEqual(['n_2', 'n_1']);
        expect(rows[0]?.body).toBe('PDF attached');
        expect(await inbox.unread()).toBe(2);

        expect(await inbox.ack(['n_1'])).toBe(1);
        expect(await inbox.ack(['n_1'])).toBe(0); // idempotent, and no write
        expect((await inbox.list({ unreadOnly: true })).map((n) => n.id)).toEqual(['n_2']);
        expect(await inbox.unread()).toBe(1);

        expect(await inbox.ack('all')).toBe(1);
        expect(await inbox.list({ unreadOnly: true })).toEqual([]);
        expect((await inbox.list({ limit: 1 })).map((n) => n.id)).toEqual(['n_2']);

        // Every mutation saved inside its turn: 2 appends + 2 effective acks.
        expect(app!.saves.filter((s) => s.type === 'Inbox')).toHaveLength(4);
    });

    it('serves a live read: the unread list re-delivers after every mutating turn', async () => {
        const a = await start();
        const inbox = inboxOf(a);
        const ref = { type: Inbox.type, key: KEY };
        const live = reader<InboxNotification[]>(
            a.host.dispatchWatch!(ref, 'list', [{ unreadOnly: true }], { callChain: [], callId: 'test' }, { throttleMs: 0 })
        );

        expect(await live.next('seed')).toEqual([]);
        await inbox.append({ kind: 'approval', title: 'Approve deploy?' });
        expect((await live.next('after append')).map((n) => n.title)).toEqual(['Approve deploy?']);
        await inbox.ack('all');
        expect(await live.next('after ack')).toEqual([]);
        await live.close();
    });

    it('survives deactivation: the record is saved inside the turn', async () => {
        const a = await start();
        const inbox = inboxOf(a);
        await inbox.append({ kind: 'input', title: 'Which branch?' });
        await inbox.ack('all');
        await a.host.deactivate({ type: Inbox.type, key: KEY });
        const rows = await inbox.list();
        expect(rows).toHaveLength(1);
        expect(rows[0]?.read).toBe(true);
        // ids keep counting from the stored sequence, never reuse
        expect((await inbox.append({ kind: 'input', title: 'And now?' })).id).toBe('n_2');
    });

    it('keeps at most `cap` notifications, dropping the oldest', async () => {
        const inbox = inboxOf(await start([defineInbox({ cap: 3 })]));
        for (let i = 1; i <= 5; i++) await inbox.append({ kind: 'reminder', title: `r${i}` });
        expect((await inbox.list()).map((n) => n.title)).toEqual(['r5', 'r4', 'r3']);
        expect(await inbox.unread()).toBe(3);
        expect(INBOX_CAP).toBe(500);
    });

    it('admits only principals of the same workspace (401 anonymous, 403 elsewhere)', async () => {
        const a = await start();
        expect(await statusOf(a.as(userPrincipal('u2')).actor(Inbox, KEY).list())).toBe(403);
        expect(await statusOf(a.as(null).actor(Inbox, KEY).unread())).toBe(401);
        expect(await statusOf(inboxOf(a).unread())).toBeUndefined();
    });

    it('stores push subscriptions per endpoint', async () => {
        const inbox = inboxOf(await start());
        await inbox.subscribe({ endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' }, label: 'laptop' });
        await inbox.subscribe({ endpoint: 'https://push.example/1', keys: { p256dh: 'p2', auth: 'a2' } }); // replaces
        await inbox.subscribe({ endpoint: 'https://push.example/2', keys: { p256dh: 'q', auth: 'b' } });
        const subs = await inbox.subscriptions();
        expect(subs.map((s) => s.endpoint)).toEqual(['https://push.example/1', 'https://push.example/2']);
        expect(subs[0]?.keys.p256dh).toBe('p2');
        expect(await inbox.unsubscribe('https://push.example/1')).toBe(true);
        expect(await inbox.unsubscribe('https://push.example/1')).toBe(false);
        expect((await inbox.subscriptions()).map((s) => s.endpoint)).toEqual(['https://push.example/2']);
    });
});

describe('Inbox.push through channels', () => {
    const delivered: { channel: string; id: string; workspaceId: string; subscriptions: number }[] = [];
    const good: NotificationChannel = {
        id: 'good',
        async deliver(n, target) {
            delivered.push({ channel: 'good', id: n.id, workspaceId: target.workspaceId, subscriptions: target.subscriptions.length });
            return { ok: true };
        }
    };
    const refusing: NotificationChannel = { id: 'refusing', async deliver() { return { ok: false, error: 'HTTP 500' }; } };
    const throwing: NotificationChannel = { id: 'throwing', async deliver() { throw new Error('socket hang up'); } };
    const pruning: NotificationChannel = {
        id: 'pruning',
        async deliver(_n, target) {
            return { ok: true, expired: target.subscriptions.map((s) => s.endpoint).filter((e) => e.endsWith('/gone')) };
        }
    };

    beforeEach(() => {
        delivered.length = 0;
    });

    it('records one attempt per channel — failures included — and never throws', async () => {
        let t = 1_000;
        const a = await start([defineInbox({ channels: [good, refusing, throwing], now: () => t++ })]);
        const inbox = inboxOf(a);
        const n = await inbox.push({ kind: 'task-failed', title: 'Build broke' });

        expect(n.deliveries).toEqual([
            { channel: 'good', at: expect.any(Number), ok: true },
            { channel: 'refusing', at: expect.any(Number), ok: false, error: 'HTTP 500' },
            { channel: 'throwing', at: expect.any(Number), ok: false, error: 'socket hang up' }
        ]);
        // The attempts are on the durable record, not only on the return value —
        // and the record was durable BEFORE delivery started (two saves).
        expect((await inbox.list())[0]?.deliveries).toEqual(n.deliveries);
        expect(a.saves.filter((s) => s.type === 'Inbox')).toHaveLength(2);
        expect(delivered).toEqual([{ channel: 'good', id: 'n_1', workspaceId: 'u1', subscriptions: 0 }]);
    });

    it('hands channels the stored subscriptions and drops the ones they report expired', async () => {
        const inbox = inboxOf(await start([defineInbox({ channels: [good, pruning] })]));
        await inbox.subscribe({ endpoint: 'https://push.example/ok', keys: { p256dh: 'p', auth: 'a' } });
        await inbox.subscribe({ endpoint: 'https://push.example/gone', keys: { p256dh: 'p', auth: 'a' } });

        const n = await inbox.push({ kind: 'reminder', title: 'Lunch' });
        expect(n.deliveries.every((d) => d.ok)).toBe(true);
        expect(delivered[0]?.subscriptions).toBe(2);
        expect((await inbox.subscriptions()).map((s) => s.endpoint)).toEqual(['https://push.example/ok']);
    });

    it('with no channels `push` is `append`', async () => {
        const inbox = inboxOf(await start());
        const n = await inbox.push({ kind: 'reminder', title: 'Plain' });
        expect(n.deliveries).toEqual([]);
        expect(await inbox.unread()).toBe(1);
    });
});

describe('reduceInbox', () => {
    const note = (id: string): InboxNotification => ({ id, kind: 'reminder', title: id, at: 0, read: false, deliveries: [] });

    it('ignores a delivery report for a notification the cap already dropped', () => {
        const state = initialInboxState();
        reduceInbox(state, { type: 'append', notification: note('n_1') }, 1);
        reduceInbox(state, { type: 'append', notification: note('n_2') }, 1);
        reduceInbox(state, { type: 'delivered', id: 'n_1', attempts: [{ channel: 'x', at: 1, ok: true }] }, 1);
        expect(state.notifications.map((n) => n.id)).toEqual(['n_2']);
        expect(state.seq).toBe(2);
    });
});
