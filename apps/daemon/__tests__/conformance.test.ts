/** `daemonConformance` against the real daemon: real WebSockets, NDJSON logs on disk, a scripted runtime. */
// @vitest-environment node
import type { EnvironmentDescriptor, EnvironmentId, LocalEnvironment, MachinePolicy, SessionId } from '@agentic/core';
import { daemonConformance, type ConformanceDaemon, type DaemonConformanceHarness } from '@agentic/daemon-protocol/testing';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemon } from '../src/daemon';
import { writeEnvironments } from '../src/env-store';
import { ndjsonEventLog } from '../src/event-log';
import { scriptedDriver } from './helpers/drivers';
import { startRelay, TEST_MACHINE } from './helpers/relay';

const toLocal = (d: EnvironmentDescriptor): LocalEnvironment => ({
    id: d.id,
    name: d.name,
    runtime: d.runtime,
    cwdRoots: d.cwdRoots,
    concurrency: d.concurrency.max,
    accountLabel: d.account.label
});

const harness: DaemonConformanceHarness = {
    features: ['env', 'gap', 'raw', 'fs', 'env-manage'],
    async start(script): Promise<ConformanceDaemon> {
        const dir = await mkdtemp(join(tmpdir(), 'agentic-daemon-conf-'));
        // The machine's own folders beside the one its owner allowed (#238): configuration, state, and the work.
        const paths = { configDir: join(dir, 'config'), stateDir: join(dir, 'state'), environmentsFile: join(dir, 'config', 'environments.json') };
        await mkdir(join(dir, 'work'), { recursive: true });
        const work = await realpath(join(dir, 'work'));
        const relay = await startRelay();
        const driver = scriptedDriver(script);
        const log = ndjsonEventLog(join(paths.stateDir, 'sessions'));
        const environments: LocalEnvironment[] = [{ id: 'env_scripted' as EnvironmentId, name: 'scripted', runtime: 'scripted', cwdRoots: [work], concurrency: 4 }];
        const secure = { run: async () => ({ code: 0, stderr: '' }) };
        await writeEnvironments(paths.environmentsFile, environments, secure);
        const policy: MachinePolicy = { webManaged: true, allowedRoots: [work] };
        const daemon = createDaemon({
            credentials: { url: relay.url, machineId: TEST_MACHINE, token: relay.token },
            environments,
            policy,
            manage: { paths, secure },
            drivers: [driver],
            eventLog: log,
            heartbeatMs: script.heartbeatMs,
            backoff: { initialMs: 5, maxMs: 20 }
        });
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
