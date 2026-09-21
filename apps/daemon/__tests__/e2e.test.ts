/**
 * Acceptance (#19): against an in-process mock relay — pair, report two
 * environments, open a session with `mockAgent`, relay 100+ frames, restart
 * the relay mid-turn, and the replay is gapless. Every log line, stdout and
 * stderr line is captured: the machine token never appears in any of them.
 */
// @vitest-environment node
import type { Cursor } from '@agentic/core';
import { decodeDaemonFrame, DAEMON_PROTOCOL_VERSION as V, type DaemonFrame, type DaemonFrameOf, type DaemonFrameType, type PlatformFrame } from '@agentic/daemon-protocol';
import type { PlatformSeat } from '@agentic/daemon-protocol/testing';
import { mockAgent } from '@sigx/ai-agent/testing';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli';
import { credentialSecrets, loadCredentials } from '../src/credentials';
import type { Daemon } from '../src/daemon';
import { daemonPaths } from '../src/paths';
import { agentDriver } from './helpers/drivers';
import { startRelay, TEST_MACHINE, type Relay } from './helpers/relay';

type EventFrame = Extract<DaemonFrameOf<'session.frame'>['frame'], { kind: 'event' }>;

async function next(seat: PlatformSeat, ms = 5_000): Promise<DaemonFrame> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const raw = await Promise.race([seat.next(), new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('no frame from the daemon')), ms)))]).finally(() => clearTimeout(timer));
    const decoded = decodeDaemonFrame(raw as string);
    if (!decoded.ok) throw new Error(`invalid daemon frame: ${decoded.error.message}`);
    return decoded.frame;
}

async function expectFrame<T extends DaemonFrameType>(seat: PlatformSeat, t: T, ignore: readonly DaemonFrameType[] = ['heartbeat', 'telemetry']): Promise<DaemonFrameOf<T>> {
    for (;;) {
        const frame = await next(seat);
        if (frame.t === t) return frame as DaemonFrameOf<T>;
        if (!ignore.includes(frame.t)) throw new Error(`expected ${t}, got ${frame.t}`);
    }
}

const send = (seat: PlatformSeat, frame: PlatformFrame) => seat.send(frame);

describe('agentic-daemon end to end', () => {
    let dir: string;
    let relays: Relay[] = [];

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'agentic-daemon-e2e-'));
        relays = [];
    });
    afterEach(async () => {
        for (const r of relays) await r.close().catch(() => {});
        await rm(dir, { recursive: true, force: true });
    });

    it('pairs, reports two environments, relays 100+ frames and replays gaplessly across a relay restart', async () => {
        const captured: string[] = [];
        const capture = (line: string) => captured.push(line);
        const paths = daemonPaths({ env: { AGENTIC_DAEMON_HOME: dir } });

        // --- pair
        const relay = await startRelay();
        relays.push(relay);
        expect(await main(['pair', 'abc-234', '--url', relay.url, '--name', 'ci-box'], { paths, out: capture, err: capture, log: capture })).toBe(0);
        expect(relay.paired).toEqual(['ci-box']);
        const credentials = await loadCredentials(paths.credentialsFile);
        expect(credentials).toMatchObject({ url: relay.url, machineId: TEST_MACHINE, token: relay.token, name: 'ci-box' });

        // --- two environments
        await writeFile(
            paths.environmentsFile,
            JSON.stringify({
                environments: [
                    { id: 'env_work', name: 'Work', runtime: 'mock', profileDir: join(dir, 'work'), cwdRoots: [dir], concurrency: 2 },
                    { id: 'env_home', name: 'Home', runtime: 'mock', profileDir: join(dir, 'home'), cwdRoots: [dir] }
                ]
            })
        );

        // --- run
        const words = Array.from({ length: 160 }, (_, i) => `w${i}`).join(' ');
        const agent = mockAgent({ id: 'mock', respond: () => [{ text: words, chunkSize: 3, delayMs: 2 }] });
        let stop!: () => void;
        const until = new Promise<void>((r) => (stop = r));
        let daemon: Daemon | undefined;
        const running = main(['run', '--verbose'], {
            paths,
            drivers: [agentDriver('mock', agent)],
            out: capture,
            err: capture,
            log: capture,
            until,
            heartbeatMs: 50,
            backoff: { initialMs: 10, maxMs: 50 },
            onStarted: (d) => (daemon = d)
        });

        const seat = await relay.nextSeat();
        const hello = await expectFrame(seat, 'hello');
        expect(hello.machineId).toBe(TEST_MACHINE);
        expect(hello.environments.map((e) => [e.id, e.name, e.concurrency.max])).toEqual([
            ['env_work', 'Work', 2],
            ['env_home', 'Home', 1]
        ]);
        expect(hello.environments.every((e) => e.machineId === TEST_MACHINE && e.account.authStatus === 'ok')).toBe(true);
        expect(JSON.stringify(hello)).not.toContain('profileDir');
        expect(hello.capabilities.map((c) => c.runtime)).toEqual(['mock']);
        send(seat, { v: V, t: 'welcome', serverTime: Date.now(), wanted: {} });

        // --- open a session and prompt
        const sessionId = 'session_e2e' as DaemonFrameOf<'session.opened'>['sessionId'];
        send(seat, { v: V, t: 'session.open', sessionId, environmentId: 'env_work', spec: { agentId: 'agent_e2e', cwd: dir, system: 'You are a test.', tools: [] } });
        const opened = await expectFrame(seat, 'session.opened');
        expect(opened.capabilities.runtime).toBe('mock');
        send(seat, { v: V, t: 'session.command', sessionId, command: { v: 1, commandId: 'cmd_1', type: 'prompt', turnId: 'turn_1', input: [{ type: 'text', text: 'go' }] } });

        const events: EventFrame[] = [];
        let acked = false;
        let last: Cursor = opened.head;
        const collect = async (s: PlatformSeat, until: (e: EventFrame) => boolean) => {
            for (;;) {
                const frame = await next(s);
                if (frame.t === 'session.reply') {
                    expect(frame.reply).toMatchObject({ kind: 'ack', commandId: 'cmd_1' });
                    acked = true;
                    continue;
                }
                if (frame.t !== 'session.frame') continue;
                expect(frame.frame.kind).toBe('event');
                if (frame.frame.kind !== 'event') continue;
                const at = { epoch: frame.frame.epoch, seq: frame.frame.seq };
                // Gapless and never twice.
                expect(at.epoch === last.epoch ? at.seq === last.seq + 1 : at.seq === 1).toBe(true);
                last = at;
                events.push(frame.frame);
                if (until(frame.frame)) return;
            }
        };
        await collect(seat, () => events.length >= 40);
        expect(acked).toBe(true);

        // --- restart the relay mid-turn
        await relay.close();
        const restarted = await startRelay({ port: relay.port });
        relays.push(restarted);
        const seat2 = await restarted.nextSeat(10_000);
        const hello2 = await expectFrame(seat2, 'hello');
        const resume = hello2.resume[sessionId];
        expect(resume).toBeDefined();
        expect(resume!.epoch > last.epoch || (resume!.epoch === last.epoch && resume!.seq >= last.seq)).toBe(true);
        send(seat2, { v: V, t: 'welcome', serverTime: Date.now(), wanted: { [sessionId]: last } });
        await collect(seat2, (e) => e.event.type === 'turn-end');

        expect(events.length).toBeGreaterThanOrEqual(100);
        expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => events[0]!.seq + i));
        expect(events[events.length - 1]!.event.type).toBe('turn-end');
        expect(daemon!.activeSessions).toEqual([sessionId]);

        // --- stop
        send(seat2, { v: V, t: 'session.close', sessionId });
        expect((await expectFrame(seat2, 'session.closed', ['heartbeat', 'telemetry', 'session.frame'])).sessionId).toBe(sessionId);
        stop();
        expect(await running).toBe(0);

        // The NDJSON log on disk holds the whole turn (stop flushed it).
        const onDisk = (await readFile(join(paths.sessionsDir, `${sessionId}.ndjson`), 'utf8')).trim().split('\n');
        expect(onDisk.length).toBeGreaterThanOrEqual(events.length);

        // --- the token never reached a log
        const everything = captured.join('\n');
        expect(everything).toContain('platform: connected');
        for (const secret of credentialSecrets(credentials)) expect(everything).not.toContain(secret);
        const credentialsText = await readFile(paths.credentialsFile, 'utf8');
        expect(credentialsText).toContain(relay.token);
    }, 30_000);

    it('a SIGTERM closes each session with code restart; the next daemon answers wanted with restart and re-opens from spec.resume on the same log (#363)', async () => {
        const paths = daemonPaths({ env: { AGENTIC_DAEMON_HOME: dir } });
        const relay = await startRelay();
        relays.push(relay);
        await writeFile(paths.credentialsFile, JSON.stringify({ url: relay.url, workspaceId: 'ws_test', machineId: TEST_MACHINE, token: relay.token, name: 'box', pairedAt: 1 }));
        await writeFile(paths.environmentsFile, JSON.stringify([{ id: 'env_work', name: 'Work', runtime: 'mock', cwdRoots: [dir] }]));
        const agent = mockAgent({ id: 'mock', respond: () => [{ text: 'one two three', chunkSize: 4 }] });
        const sessionId = 'session_restart' as DaemonFrameOf<'session.opened'>['sessionId'];
        const run = () => {
            let end!: (how?: 'signal') => void;
            const until = new Promise<void | 'signal'>((r) => (end = r));
            const exited = main(['run'], { paths, drivers: [agentDriver('mock', agent)], log: () => {}, err: () => {}, out: () => {}, until, heartbeatMs: 1_000, backoff: { initialMs: 10, maxMs: 50 } });
            return { end, exited };
        };
        const turn = async (seat: PlatformSeat, n: number): Promise<Cursor[]> => {
            send(seat, { v: V, t: 'session.command', sessionId, command: { v: 1, commandId: `cmd_${n}`, type: 'prompt', turnId: `turn_${n}`, input: [{ type: 'text', text: 'go' }] } });
            const seen: Cursor[] = [];
            for (;;) {
                const frame = await next(seat);
                if (frame.t !== 'session.frame' || frame.frame.kind !== 'event') continue;
                seen.push({ epoch: frame.frame.epoch, seq: frame.frame.seq });
                if (frame.frame.event.type === 'turn-end') return seen;
            }
        };

        // --- the first daemon: a session with one turn, then SIGTERM
        const first = run();
        const seat = await relay.nextSeat();
        await expectFrame(seat, 'hello');
        send(seat, { v: V, t: 'welcome', serverTime: Date.now(), wanted: {} });
        send(seat, { v: V, t: 'session.open', sessionId, environmentId: 'env_work', spec: { agentId: 'agent_e2e', cwd: dir, system: 'You are a test.', tools: [] } });
        const opened = await expectFrame(seat, 'session.opened');
        const before = await turn(seat, 1);
        const head = before[before.length - 1]!;
        const closing = expectFrame(seat, 'session.closed', ['heartbeat', 'telemetry', 'session.frame', 'session.ref']);
        first.end('signal');
        expect(await closing).toMatchObject({ sessionId, code: 'restart' });
        expect(await first.exited).toBe(0);

        // --- the supervisor's next daemon over the same dirs
        const second = run();
        const seat2 = await relay.nextSeat();
        expect((await expectFrame(seat2, 'hello')).resume).toEqual({});
        // What the session logged after the platform's cursor (the runtime's closing `state`) is replayed first.
        send(seat2, { v: V, t: 'welcome', serverTime: Date.now(), wanted: { [sessionId]: head } });
        expect(await expectFrame(seat2, 'session.closed', ['heartbeat', 'telemetry', 'session.frame'])).toMatchObject({ sessionId, code: 'restart' });
        send(seat2, { v: V, t: 'session.open', sessionId, environmentId: 'env_work', spec: { agentId: 'agent_e2e', cwd: dir, system: 'You are a test.', tools: [], resume: opened.ref } });
        const reopened = await expectFrame(seat2, 'session.opened');
        // The same runtime conversation, on the next epoch; the head continues after the old one instead of going back to (0, 0).
        expect((reopened.ref as { id: string }).id).toBe((opened.ref as { id: string }).id);
        expect(reopened.head).toEqual({ epoch: head.epoch + 1, seq: 0 });
        const after = await turn(seat2, 2);
        expect(after[0]).toEqual({ epoch: head.epoch + 1, seq: 1 });
        second.end();
        expect(await second.exited).toBe(0);

        // One NDJSON log across both processes: the first epoch whole, then the second from its first event.
        const onDisk = (await readFile(join(paths.sessionsDir, `${sessionId}.ndjson`), 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as Cursor);
        const epochs = [head.epoch, head.epoch + 1].map((epoch) => onDisk.filter((e) => e.epoch === epoch).map((e) => e.seq));
        expect(onDisk.map((e) => e.epoch)).toEqual([...epochs[0]!.map(() => head.epoch), ...epochs[1]!.map(() => head.epoch + 1)]);
        for (const seqs of epochs) expect(seqs).toEqual(seqs.map((_, i) => i + 1));
        expect(epochs[0]!.slice(0, before.length)).toEqual(before.map((c) => c.seq));
        expect(epochs[1]!.slice(0, after.length)).toEqual(after.map((c) => c.seq));
    }, 30_000);

    it('a refused token is logged without the token and retried at the ceiling', async () => {
        const captured: string[] = [];
        const capture = (line: string) => captured.push(line);
        const paths = daemonPaths({ env: { AGENTIC_DAEMON_HOME: dir } });
        const relay = await startRelay({ token: `amt.ws_test.${TEST_MACHINE}.${'x'.repeat(43)}` });
        relays.push(relay);
        const stale = `amt.ws_test.${TEST_MACHINE}.${'y'.repeat(43)}`;
        await writeFile(paths.credentialsFile, JSON.stringify({ url: relay.url, workspaceId: 'ws_test', machineId: TEST_MACHINE, token: stale, name: 'box', pairedAt: 1 }));
        await writeFile(paths.environmentsFile, JSON.stringify([{ id: 'env_a', name: 'A', runtime: 'mock', cwdRoots: [dir] }]));
        let stop!: () => void;
        const until = new Promise<void>((r) => (stop = r));
        const running = main(['run'], { paths, drivers: [agentDriver('mock', mockAgent())], log: capture, err: capture, out: capture, until, backoff: { initialMs: 5, maxMs: 40 } });
        await vi.waitFor(() => expect(relay.refused).toBeGreaterThanOrEqual(2), { timeout: 5_000 });
        stop();
        expect(await running).toBe(0);
        const everything = captured.join('\n');
        expect(everything).toContain('the machine token was refused');
        expect(everything).not.toContain(stale);
        expect(everything).not.toContain('y'.repeat(43));
    });
});
