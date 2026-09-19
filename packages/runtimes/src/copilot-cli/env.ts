/**
 * The account half of a Copilot CLI child's environment (EXE-04/05). Copilot keeps its own login under
 * `COPILOT_HOME`, so an environment's runtime gets its profile there and none of the parent's token
 * variables. Without a profile dir the default `~/.copilot` applies.
 *
 * Not isolated by this: a profile with no Copilot login of its own falls back to `gh auth token`, and the
 * GitHub CLI reads its token from the OS keyring whatever its config dir — the machine's `gh` account. The
 * doctor reports that (`shared-login`); `agentic-daemon env login` gives the profile its own login, which
 * Copilot prefers.
 */

import type { LocalEnvironment } from '@agentic/core';
import { profileEnv } from '../harness/env.js';

/** Parent variables that could select another account. */
const ACCOUNT_VARIABLES = [/^COPILOT_HOME$/i, /^COPILOT_GITHUB_TOKEN$/i, /^GH_TOKEN$/i, /^GITHUB_TOKEN$/i, /^GH_ENTERPRISE_TOKEN$/i, /^GITHUB_ENTERPRISE_TOKEN$/i];

export function copilotAccountEnv(env: Pick<LocalEnvironment, 'profileDir'>, parent: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
    if (env.profileDir === undefined) return profileEnv(parent, { strip: [/^COPILOT_HOME$/i], set: {} });
    return profileEnv(parent, { strip: ACCOUNT_VARIABLES, set: { COPILOT_HOME: env.profileDir } });
}
