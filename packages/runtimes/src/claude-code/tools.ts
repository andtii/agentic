/**
 * Platform tools on the daemon: the same names, descriptions and input
 * schemas as the platform's own definitions, but `execute` bridges the call
 * to the platform (`tool.call` → `tool.result`) where the real port runs
 * under the agent principal (architecture §5b).
 */

import { defineTool, type AnyTool } from '@sigx/ai';
import type { MemoryPort, PlatformPorts, ChatPort, TaskPort } from '../tools/index.js';
import { isPlatformToolName, platformTools } from '../tools/index.js';
import type { PlatformToolCaller } from '@agentic/core';

const unreachable = (): never => {
    throw new Error('[claude-code] a bridged platform tool never runs its port on the daemon');
};

/** Ports that are never called: only the tool definitions are used. */
const DEFINITION_PORTS: PlatformPorts = {
    memory: { search: unreachable, remember: unreachable } satisfies MemoryPort,
    task: { delegate: unreachable, report: unreachable } satisfies TaskPort,
    chat: { post: unreachable, ask: unreachable } satisfies ChatPort
};

export interface BridgedTools {
    /** Client tools served to Claude Code over its MCP tool server, in the order asked. */
    readonly tools: readonly AnyTool[];
    /** Names the daemon has no definition for (connector tools, typos); never served. */
    readonly unknown: readonly string[];
}

export function bridgedPlatformTools(names: readonly string[], callTool: PlatformToolCaller): BridgedTools {
    const definitions = new Map(platformTools(DEFINITION_PORTS).map((t) => [t.name, t]));
    const tools: AnyTool[] = [];
    const unknown: string[] = [];
    for (const name of new Set(names)) {
        const def = isPlatformToolName(name) ? definitions.get(name) : undefined;
        if (!def) {
            unknown.push(name);
            continue;
        }
        tools.push(
            defineTool({
                name: def.name,
                description: def.description,
                input: def.input,
                ...(def.annotations ? { annotations: def.annotations } : {}),
                execute: (input) => callTool(def.name, input)
            })
        );
    }
    return { tools, unknown };
}
