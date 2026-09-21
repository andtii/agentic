/**
 * Accounts across machines (#414): the same login on two machines is one
 * account. An account is never stored — it is derived from the environments
 * that report it: the runtime plus the identity the runtime's `inspect` read
 * from the profile (an email, for Claude Code), or the environment's account
 * label when no identity is reported yet. An agent binds to an account
 * (`ExecutionDefaults.account`); a chat or a task names the machine; the
 * router resolves `(machine, account) → environment` once per task, the way
 * a project's folder is resolved for the environment the work landed on.
 */

import type { RuntimeId } from './agent.js';
import type { AuthStatus, EnvironmentDescriptor } from './environment.js';
import type { EnvironmentId, MachineId } from './ids.js';

/**
 * How an agent names its account: the identity the runtime reports (preferred,
 * matched case-insensitively), or the label its environments carry (`accountLabel`,
 * else the environment's name — matched exactly). At least one is set. An
 * identity never matches a label: a label-bound agent stops matching an
 * environment once it reports an identity, and the config says so.
 */
export interface AccountRef {
    readonly identity?: string;
    readonly label?: string;
}

/** `<runtime>|id:<identity, lower-cased>` or `<runtime>|label:<label>` — the grouping key of an account directory. */
export type AccountKey = string;

/** One account as the directory lists it: where it is signed in, across machines. */
export interface AccountEntry {
    readonly key: AccountKey;
    readonly runtime: RuntimeId;
    readonly ref: AccountRef;
    /** The first reporting environment's label. */
    readonly label: string;
    readonly identity?: string;
    readonly environments: readonly { readonly machineId: MachineId; readonly environmentId: EnvironmentId; readonly authStatus: AuthStatus }[];
}

type EnvAccount = Pick<EnvironmentDescriptor, 'account'>;
type EnvKeyed = Pick<EnvironmentDescriptor, 'runtime' | 'account'>;

/** The ref an environment answers to: its identity when the runtime reported one, else its label. */
export function accountRefOf(env: EnvAccount): AccountRef {
    const identity = env.account.identity?.trim();
    return identity ? { identity } : { label: env.account.label };
}

/**
 * The key of `ref` on `runtime`; an identity wins over a label. Throws on an empty ref, and on a
 * runtime id that contains the separator (`RuntimeId` is open, and `parseAccountKey` splits at
 * the first `|`) — contract errors, never user input.
 */
export function accountKeyFor(runtime: RuntimeId, ref: AccountRef): AccountKey {
    if (runtime === '' || runtime.includes('|')) throw new Error(`accountKeyFor: runtime id "${runtime}" cannot be keyed`);
    const identity = ref.identity?.trim();
    if (identity) return `${runtime}|id:${identity.toLowerCase()}`;
    if (ref.label !== undefined && ref.label !== '') return `${runtime}|label:${ref.label}`;
    throw new Error('accountKeyFor: an account ref needs an identity or a label');
}

export function accountKeyOf(env: EnvKeyed): AccountKey {
    return accountKeyFor(env.runtime, accountRefOf(env));
}

/** The runtime and ref a key was built from; `null` for anything that is not a key. The identity comes back lower-cased. */
export function parseAccountKey(key: AccountKey): { readonly runtime: RuntimeId; readonly ref: AccountRef } | null {
    const bar = key.indexOf('|');
    if (bar <= 0) return null;
    const runtime = key.slice(0, bar) as RuntimeId;
    const rest = key.slice(bar + 1);
    if (rest.startsWith('id:') && rest.length > 3) return { runtime, ref: { identity: rest.slice(3) } };
    if (rest.startsWith('label:') && rest.length > 6) return { runtime, ref: { label: rest.slice(6) } };
    return null;
}

/** Whether two refs name one account: identities case-insensitively, labels exactly, never an identity against a label. */
export function sameAccount(a: AccountRef, b: AccountRef): boolean {
    const ai = a.identity?.trim();
    const bi = b.identity?.trim();
    if (ai && bi) return ai.toLowerCase() === bi.toLowerCase();
    if (ai || bi) return false;
    return a.label !== undefined && a.label !== '' && a.label === b.label;
}

/**
 * The environments of `runtime` that answer to `ref`, the signed-in ones first
 * and then by name — the order the router takes the first of.
 */
export function environmentsForAccount<E extends EnvKeyed & Pick<EnvironmentDescriptor, 'name'>>(envs: readonly E[], runtime: RuntimeId, ref: AccountRef): E[] {
    const rank = (e: E): number => (e.account.authStatus === 'ok' ? 0 : 1);
    return envs
        .filter((e) => e.runtime === runtime && sameAccount(accountRefOf(e), ref))
        .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/**
 * The accounts a set of machines report, grouped by key in the order given
 * (machines, then each machine's environments). Two machines that both report
 * `env_work` for different logins are two accounts; the same login on both is
 * one account with two environments.
 */
export function accountDirectory(machines: readonly { readonly machineId: MachineId; readonly environments: readonly Pick<EnvironmentDescriptor, 'id' | 'runtime' | 'account'>[] }[]): AccountEntry[] {
    const byKey = new Map<AccountKey, { entry: Omit<AccountEntry, 'environments'>; environments: AccountEntry['environments'][number][] }>();
    for (const m of machines) {
        for (const env of m.environments) {
            const key = accountKeyOf(env);
            let found = byKey.get(key);
            if (!found) {
                const identity = env.account.identity?.trim();
                found = { entry: { key, runtime: env.runtime, ref: accountRefOf(env), label: env.account.label, ...(identity ? { identity } : {}) }, environments: [] };
                byKey.set(key, found);
            }
            found.environments.push({ machineId: m.machineId, environmentId: env.id, authStatus: env.account.authStatus });
        }
    }
    return [...byKey.values()].map(({ entry, environments }) => ({ ...entry, environments }));
}
