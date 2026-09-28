/**
 * The Node host (#988): the platform's registry on ONE `@sigx/actors` host over
 * `sqliteStorage`, and the semantics that differ from a Durable Object —
 * `onDeactivate` runs, `callTimeoutMs` bounds a call, an overdue reminder
 * fires after a restart, a kill mid-turn keeps what the last turn saved — plus
 * the route order and the daemon upgrade check.
 *
 * Gated on `node:sqlite` (Node >= 22.13; CI's compat leg runs Node 20).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineActor, isActorError, type AnyActorDefinition } from '@sigx/actors';
import { resetServerAppStamp } from '../../web/src/platform.app';
import { fsBucket } from '../src/fs-bucket';
import type { NodeHost, NodeHostOptions } from '../src/host';

const nodeSqlite = await import('node:sqlite').then(
    (m) => m,
    () => null
);
const sqlite = nodeSqlite ? await import('@sigx/actors-sqlite') : null;
const { createNodeHost } = nodeSqlite ? await import('../src/host') : ({} as typeof import('../src/host'));

const SECRET = 's'.repeat(40);

/** What the probe actor's hooks saw, across hosts (module state outlives an activation). */
const seen = { deactivated: [] as string[], reminders: [] as string[], runs: [] as string[] };

const Probe = defineActor({
    type: 'node-probe',
    state: () => ({ n: 0 }),
    methods: (ctx) => ({
        async bump(): Promise<number> {
            ctx.state.n += 1;
            await ctx.save();
            return ctx.state.n;
        },
        async read(): Promise<number> {
            return ctx.state.n;
        },
        /** Bumps in memory and never returns — a turn the process dies in. */
        async hang(): Promise<void> {
            ctx.state.n += 100;
            await new Promise(() => undefined);
        },
        async sleep(ms: number): Promise<void> {
            await new Promise((done) => setTimeout(done, ms));
        },
        async work(): Promise<void> {
            await ctx.tasks.start('work', { from: ctx.key });
        },
        async remind(name: string, dueInMs: number): Promise<void> {
            await ctx.reminders.set(name, { due: dueInMs });
        }
    }),
    // A detached run that only ends when its activation does: the roster must re-adopt it after a crash.
    tasks: (ctx) => ({
        work: async (input: unknown) => {
            seen.runs.push(`${ctx.key}:${JSON.stringify(input)}`);
            await new Promise<void>((done) => ctx.abortSignal.addEventListener('abort', () => done(), { once: true }));
        }
    }),
    onReminder: async (ctx, name) => {
        seen.reminders.push(`${ctx.key}:${name}`);
    },
    onDeactivate: async (ctx, reason) => {
        seen.deactivated.push(`${ctx.key}:${reason}`);
    }
}) as AnyActorDefinition;

describe.skipIf(!nodeSqlite)('createNodeHost', () => {
    const cleanup: (() => Promise<void> | void)[] = [];
    afterEach(async () => {
        for (const fn of cleanup.splice(0).reverse()) await fn();
        seen.deactivated.length = 0;
        seen.reminders.length = 0;
        seen.runs.length = 0;
        resetServerAppStamp();
    });

    const home = async (): Promise<string> => {
        const dir = await mkdtemp(join(tmpdir(), 'agentic-node-host-'));
        cleanup.push(() => rm(dir, { recursive: true, force: true }));
        return dir;
    };

    /** A host on `<dir>/agentic.db`; `kill` drops it without a stop (the process died). */
    const start = async (dir: string, options: Partial<NodeHostOptions> = {}): Promise<{ node: NodeHost; stop(): Promise<void>; kill(): void }> => {
        const storage = sqlite!.sqliteStorage({ path: join(dir, 'agentic.db') });
        const node = await createNodeHost({
            storage,
            bucket: fsBucket(join(dir, 'files')),
            env: { SESSION_SECRET: SECRET, APP_ORIGIN: 'http://localhost:8787' },
            actors: (platform) => [...platform(), Probe],
            ...options
        });
        let done = false;
        const stop = async (): Promise<void> => {
            if (done) return;
            done = true;
            await node.stop({ timeoutMs: 2_000 });
            storage.close();
        };
        cleanup.push(stop);
        return {
            node,
            stop,
            kill() {
                // The process is gone: nothing drains, nothing flushes. Its timers must not fire into the next host.
                done = true;
                void node.stop({ timeoutMs: 1 }).catch(() => undefined);
                storage.close();
            }
        };
    };

    it('hosts the whole platform registry in one host', async () => {
        const { node } = await start(await home());
        const types = node.actors.map((d) => (d as { type: string }).type);
        for (const type of ['Workspace', 'Chat', 'session', 'machine', 'routing', 'Registry', 'node-probe']) expect(types).toContain(type);
    });

    it('runs onDeactivate on a stop, and the state is there after a restart', async () => {
        const dir = await home();
        const first = await start(dir);
        expect(await first.node.host.actor(Probe, 'a').bump()).toBe(1);
        await first.stop();
        expect(seen.deactivated).toEqual(['a:shutdown']);

        const second = await start(dir);
        expect(await second.node.host.actor(Probe, 'a').read()).toBe(1);
    });

    it('bounds a call by callTimeoutMs', async () => {
        const { node } = await start(await home(), { defaults: { callTimeoutMs: 50 } });
        const error = await node.host
            .actor(Probe, 'slow')
            .sleep(500)
            .then(() => null, (e: unknown) => e);
        expect(isActorError(error)).toBe(true);
        expect((error as { kind?: string }).kind).toBe('call-timeout');
    });

    it('keeps what the last turn saved when the process dies mid-turn', async () => {
        const dir = await home();
        const first = await start(dir);
        const probe = first.node.host.actor(Probe, 'k');
        await probe.bump();
        void probe.hang().catch(() => undefined);
        await new Promise((done) => setTimeout(done, 20));
        first.kill();

        const second = await start(dir);
        expect(await second.node.host.actor(Probe, 'k').read()).toBe(1);
    });

    it('fires a reminder that fell due while the process was down', async () => {
        const dir = await home();
        const first = await start(dir);
        await first.node.host.actor(Probe, 'r').remind('wake', 50);
        first.kill();
        await new Promise((done) => setTimeout(done, 100));
        expect(seen.reminders).toEqual([]);

        await start(dir, { defaults: { reminderTickMs: 20 } });
        await expect.poll(() => seen.reminders, { timeout: 3_000 }).toEqual(['r:wake']);
    });

    it('re-adopts a detached run the dead process left behind (rosterTaskLiveness)', async () => {
        const dir = await home();
        const first = await start(dir);
        await first.node.host.actor(Probe, 't').work();
        await expect.poll(() => seen.runs).toEqual(['t:{"from":"t"}']);
        first.kill();

        await start(dir, { defaults: { reminderTickMs: 20 } });
        await expect.poll(() => seen.runs, { timeout: 5_000 }).toEqual(['t:{"from":"t"}', 't:{"from":"t"}']);
    });

    it('serves the auth routes, the actor mount and the fallback in the Worker order', async () => {
        const fallback: string[] = [];
        const { node } = await start(await home(), {
            fallback: (request) => {
                fallback.push(new URL(request.url).pathname);
                return new Response('document', { status: 200 });
            }
        });
        const me = await node.fetch(new Request('http://localhost:8787/auth/me'));
        expect(me.status).toBe(401);
        const page = await node.fetch(new Request('http://localhost:8787/agents'));
        expect(await page.text()).toBe('document');
        expect(fallback).toEqual(['/agents']);
    });

    it('refuses a daemon upgrade whose token names no paired machine', async () => {
        const { node } = await start(await home());
        const malformed = await node.daemon.verify(new Request('http://localhost:8787/_agentic/daemon/m1', { headers: { upgrade: 'websocket', authorization: 'Bearer nope' } }));
        expect(malformed).toBeInstanceOf(Response);
        expect((malformed as Response).status).toBe(401);
    });

    it('answers the daemon keepalive itself, never the actor', async () => {
        const { node } = await start(await home());
        const who = { workspaceId: 'ws1', machineId: 'm1', key: 'ws1:machine:m1', token: 'amt.x' } as Parameters<NodeHost['daemon']['opened']>[0];
        const sent: string[] = [];
        const ws = { send: (text: string) => void sent.push(text), close: () => undefined };
        node.daemon.opened(who, ws);
        expect(node.daemonSockets.port.isConnected?.(who.key)).toBe(true);
        await node.daemon.message(who, ws, '{"p":1}');
        expect(sent).toEqual(['{"p":1}']);
        expect(node.daemonSockets.count(who.key)).toBe(1);
    });
});
