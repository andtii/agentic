/**
 * `agentic-daemon policy show`
 * `agentic-daemon policy allow-root <dir>`
 * `agentic-daemon policy deny-root <dir>`
 * `agentic-daemon policy off`
 * `agentic-daemon policy lock | unlock`
 *
 * The policy for web-managed environments (#238, #355) as its owner edits it
 * on the machine. Since #355 the platform sets it too (`policy.request`,
 * `policy-web.ts`); a command here writes `source: "local"` and drops what
 * the web asked for, and `lock` makes the file local-only again — every
 * `policy.request` is refused until `unlock`. A running daemon watches
 * `policy.json`, so none of these needs a restart.
 */

import type { MachinePolicy } from '@agentic/core';
import type { SecureWriteOptions } from './credentials.js';
import type { DaemonPaths } from './paths.js';
import { allowRoot, denyRoot, loadPolicy, localEdit, POLICY_OFF, PolicyError, withLock, writePolicy } from './policy.js';

export interface PolicyCommandContext {
    readonly paths: DaemonPaths;
    readonly out: (text: string) => void;
    readonly err: (text: string) => void;
    readonly secure: SecureWriteOptions;
    readonly platform?: NodeJS.Platform;
}

export const POLICY_USAGE = `  agentic-daemon policy show
  agentic-daemon policy allow-root <dir>   (lets the web add environments inside <dir>; turns web management on)
  agentic-daemon policy deny-root <dir>
  agentic-daemon policy off                (the web manages nothing; allowed folders are forgotten)
  agentic-daemon policy lock               (the web may read the policy but not set it, until unlock)
  agentic-daemon policy unlock`;

export function describePolicy(policy: MachinePolicy): string {
    const source = policy.source === 'web' ? 'set from the web' : policy.source === 'local' ? 'set on this machine' : undefined;
    const lock = policy.locked ? 'locked: the web cannot set it (`agentic-daemon policy unlock`)' : undefined;
    const notes = [source, lock].filter((n): n is string => n !== undefined);
    const suffix = notes.length ? ` (${notes.join('; ')})` : '';
    if (!policy.webManaged || policy.allowedRoots.length === 0) return `web management: off — the platform cannot add, change or remove environments on this machine${suffix}`;
    return [`web management: on — the platform may add environments with working roots inside${suffix}:`, ...policy.allowedRoots.map((r, i) => `  ${r}${policy.requested?.[i] !== undefined && policy.requested[i] !== r ? ` (asked as ${policy.requested[i]})` : ''}`)].join('\n');
}

/** The policy on disk, for an edit: an invalid file is not silently replaced. */
async function current(c: PolicyCommandContext): Promise<MachinePolicy | undefined> {
    const loaded = await loadPolicy(c.paths.policyFile);
    if (loaded.ok) return loaded.policy;
    for (const e of loaded.errors) c.err(e);
    c.err(`${c.paths.policyFile} is invalid (and treated as off); fix it, or start over with \`agentic-daemon policy off\``);
    return undefined;
}

export async function policyCommand(sub: string | undefined, positional: readonly string[], c: PolicyCommandContext): Promise<number> {
    const own = { configDir: c.paths.configDir, stateDir: c.paths.stateDir };
    try {
        switch (sub) {
            case 'show': {
                const loaded = await loadPolicy(c.paths.policyFile);
                if (!loaded.ok) {
                    for (const e of loaded.errors) c.err(e);
                    c.out(`${describePolicy(POLICY_OFF)} (${c.paths.policyFile} is invalid)`);
                    return 1;
                }
                c.out(describePolicy(loaded.policy));
                return 0;
            }
            case 'allow-root':
            case 'deny-root': {
                const dir = positional[0];
                if (!dir) {
                    c.err(`policy ${sub} needs a folder\n\n${POLICY_USAGE}`);
                    return 2;
                }
                const policy = await current(c);
                if (!policy) return 1;
                const next = localEdit(sub === 'allow-root' ? await allowRoot(policy, dir, own, c.platform) : await denyRoot(policy, dir, c.platform));
                await writePolicy(c.paths.policyFile, next, c.secure);
                c.out(describePolicy(next));
                return 0;
            }
            case 'off': {
                // Starts over, a broken file included; only the lock survives.
                const loaded = await loadPolicy(c.paths.policyFile);
                const next = localEdit({ ...POLICY_OFF, ...(loaded.ok && loaded.policy.locked ? { locked: true } : {}) });
                await writePolicy(c.paths.policyFile, next, c.secure);
                c.out(describePolicy(next));
                return 0;
            }
            case 'lock':
            case 'unlock': {
                const policy = await current(c);
                if (!policy) return 1;
                const next = withLock(policy, sub === 'lock');
                await writePolicy(c.paths.policyFile, next, c.secure);
                c.out(describePolicy(next));
                return 0;
            }
            default:
                c.err(`${sub ? `unknown policy command "${sub}"` : 'policy needs a command'}\n\n${POLICY_USAGE}`);
                return 2;
        }
    } catch (e) {
        if (!(e instanceof PolicyError)) throw e;
        c.err(e.message);
        return 1;
    }
}
