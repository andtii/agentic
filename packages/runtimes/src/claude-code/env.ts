/** The account half of a Claude Code child's environment, shared by sessions (`driver.ts`) and the quota probe (`quota.ts`). */

import type { LocalEnvironment } from '@agentic/core';

/**
 * Removes what could select another account — the parent's `CLAUDE_CONFIG_DIR` and every `ANTHROPIC_*`
 * variable — and sets this environment's config dir (or none: the default) (EXE-04/05). Extra variables
 * for `childEnv` / `claudeCode({ env })`: `undefined` removes a key.
 */
export function accountEnv(env: Pick<LocalEnvironment, 'profileDir'>, parent: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
    const extra: Record<string, string | undefined> = {};
    for (const key of Object.keys(parent)) if (/^ANTHROPIC_/i.test(key) || /^CLAUDE_CONFIG_DIR$/i.test(key)) extra[key] = undefined;
    extra.CLAUDE_CONFIG_DIR = env.profileDir;
    return extra;
}
