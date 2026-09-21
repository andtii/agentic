/** `daemonConformance` against the real daemon: real WebSockets, NDJSON logs on disk, a scripted runtime. */
// @vitest-environment node
import type { EnvironmentDescriptor, EnvironmentId, LocalEnvironment, MachinePolicy, SessionId } from '@agentic/core';
import { daemonConformance, type ConformanceDaemon, type DaemonConformanceHarness } from '@agentic/daemon-protocol/testing';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemon } from '../src/daemon';
import { writeEnvironments } from '../src/env-store';
import { ndjsonEventLog, type NdjsonEventLog } from '../src/event-log';
import { namingDriver } from './helpers/drivers';
import { startRelay, TEST_MACHINE } from './helpers/relay';

const toLocal = (d: EnvironmentDescriptor): LocalEnvironment => ({
    id: d.id,
    name: d.name,
    runtime: d.runtime,
    cwdRoots: d.cwdRoots,
    concurrency: d.concurrency.max,
    accountLabel: d.account.label
});

/** One hand-written checkout of this origin under the work root, so `fs-locate` proves a match (#331). */
const KNOWN_ORIGIN = 'https://github.com/andtii/agentic.git';

const harness: DaemonConformanceHarness = {
    // `session-ref` (#389): the scripted runtime names its session on the first prompt, so the daemon's `session.ref` is proven here too.
    // `history` (#397): answered from the NDJSON log on disk; `truncateLog` is the log's own `truncate`, so the gap case is real.
    // `resume` (#363): `restart` stops the daemon the way SIGTERM does and starts a new one over the same state dir, so the
    // wanted session is answered from the NDJSON log with code `restart` and re-opened from `spec.resume` on the next epoch.
    features: ['env', 'gap', 'raw', 'fs', 'env-manage', 'session-ref', 'history', 'resume'],
    knownOrigin: KNOWN_ORIGIN,
    async start(script): Promise<ConformanceDaemon> {
        const dir = await mkdtemp(join(tmpdir(), 'agentic-daemon-conf-'));
        // The machine's own folders beside the one its owner allowed (#238): configuration, state, and the work.
        const paths = { configDir: join(dir, 'config'), stateDir: join(dir, 'state'), environmentsFile: join(dir, 'config', 'environments.json') };
        await mkdir(join(dir, 'work', 'agentic', '.git'), { recursive: true });
        await writeFile(join(dir, 'work', 'agentic', '.git', 'HEAD'), 'ref: refs/heads/main\n');
        await writeFile(join(dir, 'work', 'agentic', '.git', 'config'), `[remote "origin"]\n\turl = ${KNOWN_ORIGIN}\n`);
        const work = await realpath(join(dir, 'work'));
        let relay = await startRelay();
        const driver = namingDriver(script);
        let log: NdjsonEventLog;
        const environments: LocalEnvironment[] = [{ id: 'env_scripted' as EnvironmentId, name: 'scripted', runtime: 'scripted', cwdRoots: [work], concurrency: 4 }];
        const secure = { run: async () => ({ code: 0, stderr: '' }) };
        await writeEnvironments(paths.environmentsFile, environments, secure);
        const policy: MachinePolicy = { webManaged: true, allowedRoots: [work] };
        // A new process each time: a fresh log handle over the same files.
        const create = () =>
            createDaemon({
                credentials: { url: relay.url, machineId: TEST_MACHINE, token: relay.token },
                environments,
                policy,
                manage: { paths, secure },
                drivers: [driver],
                eventLog: (log = ndjsonEventLog(join(paths.stateDir, 'sessions'))),
                heartbeatMs: script.heartbeatMs,
                backoff: { initialMs: 5, maxMs: 20 }
            });
        let daemon = create();
        let started = false;
        return {
            machineId: TEST_MACHINE as ConformanceDaemon['machineId'],
            environmentId: environments[0]!.id,
            async dial() {
                if (!started) {
                    started = true;
                    await daemon.start();
                }
                return relay.nextSeat();
            },
            async setEnvironments(next) {
                for (const d of next) driver.auth.set(d.id, d.account.authStatus);
                await daemon.setEnvironments(next.map(toLocal));
            },
            async setPolicy(next) {
                await daemon.setPolicy(next);
            },
            async truncateLog(sessionId: SessionId, keepFrom) {
                await log.truncate(sessionId, keepFrom);
            },
            async restart() {
                // The old process goes (closing its sessions with code `restart`) and a new one starts over the same dirs. A fresh
                // relay, so the suite's next dial is the new daemon's connection and never the old one's last redial.
                await daemon.stop({ reason: 'restart' });
                await relay.close();
                relay = await startRelay();
                daemon = create();
                started = false;
            },
            async stop() {
                await daemon.stop();
                await relay.close();
                await rm(dir, { recursive: true, force: true });
            }
        };
    }
};

describe('daemonConformance (agentic-daemon over WebSockets)', () => {
    for (const c of daemonConformance(harness, { reconnectDelayMs: 100 })) {
        it.skipIf(!!c.skip)(c.name, c.run, 20_000);
    }
});
