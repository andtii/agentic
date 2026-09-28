// @vitest-environment node
import { readFileSync } from 'node:fs';
import type { MachineSocketPort } from '@agentic/platform';
import { createPlatform, machineDefinition, platformDefs, type HostPorts } from '../src/platform.app';
import { identifyDaemon } from '../src/daemon';

const fakeHost = (over: Partial<HostPorts> = {}): HostPorts => {
    const sent: string[] = [];
    const sockets: MachineSocketPort = { send: (_key, text) => (sent.push(text), true), close: () => {} };
    return {
        secrets: { sessionSecret: () => undefined, workspaceKek: () => undefined, appOrigin: () => undefined },
        files: () => undefined,
        artifacts: { put: async () => {} } as never,
        workspaceStore: {} as never,
        daemonSockets: sockets,
        runWithHost: (_host, fn) => fn(),
        ...over
    };
};

describe('platform.app — the host-neutral wiring (#987)', () => {
    it('imports nothing Cloudflare', () => {
        const source = readFileSync(new URL('../src/platform.app.ts', import.meta.url), 'utf8');
        const imports = source.split('\n').filter((line) => /^\s*(import|export)\b.*\bfrom\s+'/.test(line));
        expect(imports.length).toBeGreaterThan(0);
        for (const line of imports) expect(line).not.toMatch(/'(@sigx\/actors-cloudflare|cloudflare:[^']*)'/);
    });

    it('builds the whole registry over any host’s ports', () => {
        const platform = createPlatform(fakeHost());
        const actors = platform.actors();
        expect(machineDefinition(actors)).toBeDefined();
        expect(Object.keys(platformDefs(actors))).toContain('Workspace');
        expect(platform.defaultPorts.files).toBe(platform.files);
    });

    it('takes the store and sink from the host, and refuses secrets without a KEK', async () => {
        const host = fakeHost();
        const { defaultPorts } = createPlatform(host);
        expect(defaultPorts.store).toBe(host.workspaceStore);
        expect(defaultPorts.sink).toBe(host.artifacts);
        await expect(async () => (defaultPorts.kek as () => Promise<CryptoKey>)()).rejects.toMatchObject({ code: 'no-kek' });
    });
});

describe('identifyDaemon — the host-neutral upgrade check (#987)', () => {
    const upgrade = (path: string): Request => new Request(`https://agentic.test${path}`);

    it('refuses a non-daemon path and a plain request before any host is read', () => {
        expect((identifyDaemon(upgrade('/elsewhere')) as Response).status).toBe(404);
        expect((identifyDaemon(new Request('https://agentic.test/_agentic/daemon/m1')) as Response).status).toBe(426);
    });
});
