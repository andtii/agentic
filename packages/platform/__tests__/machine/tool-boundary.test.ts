/**
 * The prompt-injection boundary of #237 (decisions 2026-09-19 (c)): an agent
 * must never be able to widen where agents may work. `Machine.putEnvironment` /
 * `removeEnvironment` are owner-only on the actor (see `actor.test.ts`); this
 * file checks that no tool surface reaches them either — the platform tools an
 * API agent calls, the daemon `tool.call` port, and the platform MCP server an
 * external client drives. A source scan, so a new caller fails here before it
 * ships, whatever it is named.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PLATFORM_TOOL_NAMES } from '@agentic/runtimes';

const packages = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return sources(path);
        return /\.tsx?$/.test(name) ? [path] : [];
    });
}

/**
 * A call that asks a machine to change its environments or its daemon (a mention in a comment is not one), or the frame
 * itself: the environment requests (#237), and the daemon's update, channel and policy and the harness requests (#365).
 */
const ENV_MUTATION = /\b(putEnvironment|removeEnvironment|envRequest|requestUpdate|cancelUpdate|setUpdatePolicy|setChannel|updateState)\s*\(|['"](env|update|harness)\.request['"]/;
/** A tool name that reads like one. */
const ENV_MUTATION_TOOL = /env(ironment)?s?_(put|add|create|set|update|remove|delete)|(put|add|create|set|update|remove|delete)_env(ironment)?|daemon|update_(machine|policy|channel)|machine_update|harness/i;

describe('environment and daemon management is on no tool surface (#237, #365)', () => {
    it('the platform tools an agent can call name no environment mutation', () => {
        for (const name of PLATFORM_TOOL_NAMES) expect(name).not.toMatch(ENV_MUTATION_TOOL);
    });

    it('the platform MCP server declares no environment mutation tool', () => {
        const tools = readFileSync(join(packages, 'mcp', 'src', 'server', 'tools.ts'), 'utf8');
        const names = [...tools.matchAll(/name: '([a-z_]+)'/g)].map((m) => m[1]!);
        expect(names.length).toBeGreaterThan(10); // the scan found the tool list
        for (const name of names) expect(name).not.toMatch(ENV_MUTATION_TOOL);
    });

    it('nothing outside the Machine actor asks a machine to change its environments: not the tool ports, not the MCP server, not a runtime', () => {
        const scanned = [join(packages, 'platform', 'src'), join(packages, 'runtimes', 'src'), join(packages, 'mcp', 'src')].flatMap(sources);
        const machineDir = join(packages, 'platform', 'src', 'machine') + sep;
        const callers = scanned.filter((file) => !file.startsWith(machineDir) && ENV_MUTATION.test(readFileSync(file, 'utf8')));
        expect(callers.map((f) => relative(packages, f))).toEqual([]);
        // The scan is live: the tool ports are in it.
        expect(scanned.some((f) => f.endsWith(join('routing', 'tools.ts')))).toBe(true);
        expect(scanned.some((f) => f.endsWith(join('routing', 'tool-call.ts')))).toBe(true);
    });
});
