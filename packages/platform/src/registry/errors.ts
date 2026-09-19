/** Errors the Registry raises; each carries a stable `code` for callers and the UI. */

import type { ConfigError } from '@agentic/core';

export type RegistryErrorCode =
    | 'plugin-disabled'
    | 'plugin-missing'
    | 'plugin-in-use'
    | 'bad-manifest'
    | 'bad-config'
    | 'builtin'
    | 'wrong-kind'
    | 'not-declared'
    | 'no-kek'
    | 'secret-missing'
    | 'secret-denied'
    | 'bad-name'
    | 'connector-missing';

export class RegistryError extends Error {
    override readonly name: string = 'RegistryError';
    constructor(
        readonly code: RegistryErrorCode,
        message: string
    ) {
        super(message);
    }
}

/** `requireEnabled` refused: the plugin is missing or disabled — new use is blocked (AC-13). */
export class PluginDisabledError extends RegistryError {
    override readonly name = 'PluginDisabledError';
    constructor(
        readonly pluginId: string,
        readonly state: 'disabled' | 'missing'
    ) {
        super(
            state === 'missing' ? 'plugin-missing' : 'plugin-disabled',
            `[registry] plugin "${pluginId}" is ${state === 'missing' ? 'not installed' : 'disabled'}`
        );
    }
}

/** `configure` / `register` refused: the config does not fit the manifest's schema. `errors` names every path. */
export class BadConfigError extends RegistryError {
    override readonly name = 'BadConfigError';
    constructor(
        readonly pluginId: string,
        readonly errors: readonly ConfigError[]
    ) {
        super('bad-config', `[registry] bad config for "${pluginId}": ${errors.map((e) => `${e.path || '(config)'}: ${e.message}`).join('; ')}`);
    }
}

export function isRegistryError(error: unknown, code?: RegistryErrorCode): error is RegistryError {
    return error instanceof RegistryError && (code === undefined || error.code === code);
}

export function isPluginDisabledError(error: unknown): error is PluginDisabledError {
    return error instanceof PluginDisabledError;
}
