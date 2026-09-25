/**
 * The Inbox honours the workspace's notification prefs (#302, OPS-04):
 * `WorkspaceSettings.notifications.push` decides whether `Inbox.push` reaches
 * any outbound channel, `notifications.inbox` whether a notification counts
 * as unread. Over `defineInbox` with a capturing channel and a real Workspace.
 */
import type { WorkspaceId } from '@agentic/core';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index.js';
import { workspaceKey } from '../../src/auth/index.js';
import { defineWorkspace } from '../../src/workspace/index.js';
import { defineRegistry } from '../../src/registry/index.js';
import { PREFS_CHANNEL, defineInbox, inboxKey, type InboxNotification, type NotificationChannel } from '../../src/notify/index.js';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');

let app: TestActorApp | null = null;

afterEach(async () => {
    await app?.stop();
    app = null;
});

const captured: InboxNotification[] = [];
const capture: NotificationChannel = {
    id: 'capture',
    async deliver(n) {
        captured.push(n);
        return { ok: true };
    }
};

beforeEach(() => {
    captured.length = 0;
});

async function setup(options: Parameters<typeof defineInbox>[0] = {}) {
    const Workspace = defineWorkspace();
    const Inbox = defineInbox({ channels: [capture], workspace: () => Workspace, ...options });
    app = testActorApp([Workspace, Inbox]);
    await app.start();
    const as = app.as(owner);
    return { inbox: as.actor(Inbox, inboxKey(WS)), workspace: as.actor(Workspace, workspaceKey(WS)) };
}

describe('Inbox.push and notifications.push', () => {
    it('push on: the notification reaches the channel, as it does without prefs', async () => {
        const { inbox, workspace } = await setup();
        await workspace.updateSettings({ notifications: { push: true } });
        const n = await inbox.push({ kind: 'task-done', title: 'Report ready' });
        expect(captured.map((c) => c.title)).toEqual(['Report ready']);
        expect(n.deliveries.map((d) => [d.channel, d.ok])).toEqual([['capture', true]]);
    });

    it('push off (the default): no channel is reached and no attempt is recorded', async () => {
        const { inbox } = await setup();
        const n = await inbox.push({ kind: 'task-done', title: 'Report ready' });
        expect(captured).toEqual([]);
        expect(n.deliveries).toEqual([]);
        const rows = await inbox.list();
        expect(rows.map((r) => r.title)).toEqual(['Report ready']);
        expect(rows[0]?.deliveries).toEqual([]);
    });

    it('push off: the notification plugins are skipped without asking the Registry', async () => {
        const Missing = defineRegistry({ catalogue: [] }); // never hosted: a hop would fail and be recorded
        const { inbox, workspace } = await setup({ registry: () => Missing, channelPlugins: {} });
        await workspace.updateSettings({ notifications: { push: false } });
        const n = await inbox.push({ kind: 'reminder', title: 'Stand-up' });
        expect(captured).toEqual([]);
        expect(n.deliveries).toEqual([]);
    });

    it('follows the switch from one push to the next', async () => {
        const { inbox, workspace } = await setup();
        await workspace.updateSettings({ notifications: { push: true } });
        await inbox.push({ kind: 'reminder', title: 'one' });
        await workspace.updateSettings({ notifications: { push: false } });
        await inbox.push({ kind: 'reminder', title: 'two' });
        await workspace.updateSettings({ notifications: { push: true } });
        await inbox.push({ kind: 'reminder', title: 'three' });
        expect(captured.map((c) => c.title)).toEqual(['one', 'three']);
    });

    it('prefs that cannot be read: nothing is delivered, and the failure is recorded', async () => {
        const Unhosted = defineWorkspace();
        const Inbox = defineInbox({ channels: [capture], workspace: () => Unhosted });
        app = testActorApp([Inbox]);
        await app.start();
        const n = await app.as(owner).actor(Inbox, inboxKey(WS)).push({ kind: 'reminder', title: 'Stand-up' });
        expect(captured).toEqual([]);
        expect(n.deliveries.map((d) => [d.channel, d.ok])).toEqual([[PREFS_CHANNEL, false]]);
        expect(n.deliveries[0]!.error).toMatch(/notification settings could not be read/);
        expect(n.muted).toBeUndefined();
    });
});

describe('Inbox and notifications.inbox', () => {
    it('inbox off: still recorded and listed, not counted unread', async () => {
        const { inbox, workspace } = await setup();
        await workspace.updateSettings({ notifications: { inbox: false } });
        const a = await inbox.append({ kind: 'approval', title: 'Approve deploy?', ref: { kind: 'session', sessionId: 's1' as never, requestId: 'r1' } });
        const b = await inbox.push({ kind: 'reminder', title: 'Lunch' });
        expect(a.muted).toBe(true);
        expect(b.muted).toBe(true);
        expect(a.read).toBe(false); // Needs you still lists an open request
        expect((await inbox.list({ unreadOnly: true })).map((n) => n.id)).toEqual([b.id, a.id]);
        expect(await inbox.unread()).toBe(0);

        await workspace.updateSettings({ notifications: { inbox: true } });
        const c = await inbox.append({ kind: 'reminder', title: 'Tea' });
        expect(c.muted).toBeUndefined();
        expect(await inbox.unread()).toBe(1);
    });
});
