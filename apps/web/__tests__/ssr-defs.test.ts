// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MachineSocketPort } from '@agentic/platform';
import { defineActorApp } from '@sigx/actors/host';
import { createPlatform, hostDefs, platformDefs, type HostPorts } from '../src/platform.app';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

/** Value imports only: `import type …` and all-`type` braces vanish at build time. */
function valueImports(source: string): string[] {
    const out: string[] = [];
    const re = /^\s*(?:import|export)\s+(type\s+)?([^'";]*?)\s*from\s+'([^']+)'|^\s*import\s+'([^']+)'|import\(\s*'([^']+)'\s*\)/gm;
    for (let m = re.exec(source); m; m = re.exec(source)) {
        if (m[4] || m[5]) {
            out.push((m[4] ?? m[5])!);
            continue;
        }
        if (m[1]) continue;
        const clause = m[2] ?? '';
        const braces = /^\{([^}]*)\}$/.exec(clause.trim());
        if (braces && braces[1]!.split(',').map((s) => s.trim()).filter(Boolean).every((s) => s.startsWith('type '))) continue;
        out.push(m[3]!);
    }
    return out;
}

function resolveLocal(from: string, spec: string): string | undefined {
    const base = resolve(dirname(from), spec);
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts'), resolve(base, 'index.tsx')]) {
        if (/\.tsx?$/.test(candidate) && existsSync(candidate)) return candidate;
    }
    return undefined;
}

/** Every `apps/web/src` file `entry` reaches through value imports, plus the bare specifiers they name. */
function importGraph(entry: string): { files: Set<string>; packages: Set<string> } {
    const files = new Set<string>();
    const packages = new Set<string>();
    const queue = [entry];
    while (queue.length) {
        const file = queue.pop()!;
        if (files.has(file)) continue;
        files.add(file);
        for (const spec of valueImports(readFileSync(file, 'utf8'))) {
            if (!spec.startsWith('.')) {
                packages.add(spec);
                continue;
            }
            const next = resolveLocal(file, spec);
            if (next) queue.push(next);
        }
    }
    return { files, packages };
}

describe('SSR actor defs come from the host (#1017)', () => {
    it('the Node SSR entry reaches nothing of Cloudflare', () => {
        const { files, packages } = importGraph(resolve(SRC, 'entry.node.ts'));
        expect(files.has(resolve(SRC, 'entry-server.tsx'))).toBe(true);
        expect(files.has(resolve(SRC, 'actors.cloudflare.ts'))).toBe(false);
        expect([...packages].filter((p) => p === '@sigx/actors-cloudflare' || p.startsWith('cloudflare:'))).toEqual([]);
    });

    it('the shared SSR app imports no host wiring', () => {
        expect(valueImports(readFileSync(resolve(SRC, 'entry-server.tsx'), 'utf8'))).not.toContain('./actors.cloudflare');
    });

    it('hostDefs reads the running host’s own definitions, as platformDefs picks them from the registry', async () => {
        const sockets: MachineSocketPort = { send: () => true, close: () => {} };
        const ports: HostPorts = {
            secrets: { sessionSecret: () => undefined, workspaceKek: () => undefined, appOrigin: () => undefined },
            files: () => undefined,
            artifacts: { put: async () => {} } as never,
            workspaceStore: {} as never,
            daemonSockets: sockets,
            runWithHost: (_host, fn) => fn()
        };
        const actors = createPlatform(ports).actors();
        const host = await defineActorApp({ actors: [...actors] }).start();
        try {
            const fromHost = hostDefs(host);
            const fromRegistry = platformDefs(actors);
            expect(Object.keys(fromHost)).toEqual(Object.keys(fromRegistry));
            for (const key of Object.keys(fromRegistry) as (keyof typeof fromRegistry)[]) expect(fromHost[key]).toBe(fromRegistry[key]);
        } finally {
            await host.stop();
        }
    });

    it('hostDefs refuses a host missing a platform actor', async () => {
        const host = await defineActorApp({ actors: [] }).start();
        try {
            expect(() => hostDefs(host)).toThrow(/no `Workspace` actor/);
        } finally {
            await host.stop();
        }
    });
});
