import { describe, expect, it, vi } from 'vitest';
import type { InboxNotification } from '@agentic/platform';
import { desktopHost, noticeHref, noticeTracker } from '../src/desktop';

const n = (id: string, over: Partial<InboxNotification> = {}): InboxNotification => ({
    id,
    kind: 'task-done',
    title: `title ${id}`,
    at: 1,
    read: false,
    deliveries: [],
    ...over
}) as InboxNotification;

describe('desktopHost', () => {
    it('is null in a browser', () => {
        expect(desktopHost({} as typeof globalThis)).toBeNull();
        expect(desktopHost({ __TAURI_INTERNALS__: {} } as unknown as typeof globalThis)).toBeNull();
    });

    it('invokes the shell commands', async () => {
        const invoke = vi.fn(async () => undefined);
        const host = desktopHost({ __TAURI_INTERNALS__: { invoke } } as unknown as typeof globalThis)!;
        await host.notify({ title: 'Done', url: '/tasks/t1' });
        await host.setBadge(2.7);
        await host.setBadge(-1);
        expect(invoke.mock.calls).toEqual([
            ['notify', { title: 'Done', body: null, url: '/tasks/t1' }],
            ['set_badge', { count: 2 }],
            ['set_badge', { count: 0 }]
        ]);
    });
});

describe('noticeTracker', () => {
    it('never replays what the first read already held', () => {
        const t = noticeTracker();
        expect(t.next([n('a'), n('b')], true)).toEqual([]);
        expect(t.next([n('c'), n('a'), n('b')], true).map((x) => x.title)).toEqual(['title c']);
        expect(t.next([n('c'), n('a'), n('b')], true)).toEqual([]);
    });

    it('stays quiet while push is off, and does not catch up when it turns on', () => {
        const t = noticeTracker();
        t.next([], false);
        expect(t.next([n('a')], false)).toEqual([]);
        expect(t.next([n('a')], true)).toEqual([]);
        expect(t.next([n('b'), n('a')], true)).toHaveLength(1);
    });

    it('skips a notification already read elsewhere', () => {
        const t = noticeTracker();
        t.next([], true);
        expect(t.next([n('a', { read: true })], true)).toEqual([]);
    });

    it('carries the body and where a click lands', () => {
        const t = noticeTracker();
        t.next([], true);
        expect(t.next([n('a', { body: 'b', ref: { kind: 'chat', chatId: 'c1' } as InboxNotification['ref'] })], true)).toEqual([{ title: 'title a', body: 'b', url: '/chats/c1' }]);
    });
});

describe('noticeHref', () => {
    it('opens what the notification points at', () => {
        expect(noticeHref({ kind: 'approval', ref: { kind: 'session', sessionId: 's1', requestId: 'r' } as InboxNotification['ref'] })).toBe('/');
        expect(noticeHref({ kind: 'task-failed', ref: { kind: 'task', taskId: 't1' } as InboxNotification['ref'] })).toBe('/tasks/t1');
        expect(noticeHref({ kind: 'task-done', ref: { kind: 'session', sessionId: 's1' } as InboxNotification['ref'] })).toBe('/sessions/s1');
        expect(noticeHref({ kind: 'update-failed', ref: { kind: 'machine', machineId: 'm1' } as InboxNotification['ref'] })).toBe('/machines/m1');
        expect(noticeHref({ kind: 'reminder', ref: { kind: 'schedule', scheduleId: 'x' } as InboxNotification['ref'] })).toBe('/schedules');
        expect(noticeHref({ kind: 'reminder' })).toBe('/');
    });
});
