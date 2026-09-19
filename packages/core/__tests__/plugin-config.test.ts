import {
    configDefaults,
    isSingleSlot,
    pluginReadiness,
    SINGLE_SLOT_KINDS,
    validateConfig,
    type ConfigSchema,
    type PluginManifest,
    type PluginReadinessFacts,
    type PluginState
} from '../src/index';

const SCHEMA: ConfigSchema = {
    type: 'object',
    properties: {
        model: { type: 'string', enum: ['small', 'large'], default: 'small', title: 'Model' },
        endpoint: { type: 'string', format: 'uri' },
        label: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 8 },
        ratio: { type: 'number' },
        auto: { type: 'boolean', default: true },
        tags: { type: 'array', items: { type: 'string' }, default: ['a'] },
        modes: { type: 'array', items: { type: 'string', enum: ['read', 'write'] } },
        headers: { type: 'object', additionalProperties: { type: 'string' }, default: { accept: 'json' } }
    },
    required: ['endpoint']
};

const errorsOf = (schema: ConfigSchema, value: unknown): string[] => {
    const r = validateConfig(schema, value);
    return r.ok ? [] : r.errors.map((e) => `${e.path}: ${e.message}`);
};

describe('validateConfig', () => {
    it.each<[string, Record<string, unknown>]>([
        ['the required key alone', { endpoint: 'https://x.example/mcp' }],
        ['an enum member', { endpoint: 'https://x.example', model: 'large' }],
        ['numbers inside their bounds', { endpoint: 'https://x.example', limit: 50, ratio: 0.5 }],
        ['a boolean', { endpoint: 'https://x.example', auto: false }],
        ['string lists', { endpoint: 'https://x.example', tags: [], modes: ['read', 'write'] }],
        ['a string map', { endpoint: 'https://x.example', headers: { a: 'b' } }]
    ])('accepts %s', (_, value) => {
        expect(validateConfig(SCHEMA, value)).toEqual({ ok: true, value });
    });

    it.each<[string, Record<string, unknown>, string]>([
        ['a missing required key', {}, 'endpoint: is required'],
        ['a non-string', { endpoint: 1 }, 'endpoint: must be a string'],
        ['a relative url', { endpoint: '/mcp' }, 'endpoint: must be an absolute URL'],
        ['a value outside the enum', { endpoint: 'https://x.example', model: 'huge' }, 'model: must be one of small, large'],
        ['a fraction for an integer', { endpoint: 'https://x.example', limit: 1.5 }, 'limit: must be a whole number'],
        ['a number under the minimum', { endpoint: 'https://x.example', limit: 0 }, 'limit: must be at least 1'],
        ['a number over the maximum', { endpoint: 'https://x.example', limit: 51 }, 'limit: must be at most 50'],
        ['NaN', { endpoint: 'https://x.example', ratio: Number.NaN }, 'ratio: must be a number'],
        ['a string for a boolean', { endpoint: 'https://x.example', auto: 'yes' }, 'auto: must be true or false'],
        ['a list with a non-string', { endpoint: 'https://x.example', tags: ['a', 1] }, 'tags: must be a list of strings'],
        ['a list item outside the enum', { endpoint: 'https://x.example', modes: ['read', 'admin'] }, 'modes: "admin" is not one of read, write'],
        ['a map with a non-string value', { endpoint: 'https://x.example', headers: { a: 1 } }, 'headers: must be a map of strings'],
        ['an array for a map', { endpoint: 'https://x.example', headers: ['a'] }, 'headers: must be a map of strings'],
        ['an unknown key', { endpoint: 'https://x.example', apiKey: 'sk-secret' }, 'apiKey: is not a setting of this plugin']
    ])('rejects %s', (_, value, expected) => {
        expect(errorsOf(SCHEMA, value)).toEqual([expected]);
    });

    it('reports every problem at once', () => {
        expect(errorsOf(SCHEMA, { limit: 'x', stray: 1 })).toEqual(['limit: must be a number', 'stray: is not a setting of this plugin', 'endpoint: is required']);
    });

    it.each([null, undefined, 'x', 3, []])('rejects a config that is not an object: %j', (value) => {
        expect(errorsOf(SCHEMA, value)).toEqual([': must be an object']);
    });

    it('treats undefined as absent and drops it from the value', () => {
        expect(validateConfig(SCHEMA, { endpoint: 'https://x.example', label: undefined })).toEqual({ ok: true, value: { endpoint: 'https://x.example' } });
        expect(errorsOf(SCHEMA, { endpoint: undefined })).toEqual(['endpoint: is required']);
    });

    it('does not fill defaults in', () => {
        const r = validateConfig(SCHEMA, { endpoint: 'https://x.example' });
        expect(r.ok && r.value).toEqual({ endpoint: 'https://x.example' });
    });

    it('keeps unknown keys when the schema allows them', () => {
        const open: ConfigSchema = { ...SCHEMA, additionalProperties: true };
        expect(validateConfig(open, { endpoint: 'https://x.example', extra: 1 })).toEqual({ ok: true, value: { endpoint: 'https://x.example', extra: 1 } });
    });

    it.each<[string, ConfigSchema]>([
        ['{ type: object }', { type: 'object' }],
        ['{}', {}]
    ])('a bare schema %s constrains nothing', (_, schema) => {
        expect(validateConfig(schema, { anything: { goes: true } })).toEqual({ ok: true, value: { anything: { goes: true } } });
    });

    it('a bare schema that closes itself accepts only the empty config', () => {
        const closed: ConfigSchema = { type: 'object', additionalProperties: false };
        expect(validateConfig(closed, {})).toEqual({ ok: true, value: {} });
        expect(errorsOf(closed, { a: 1 })).toEqual(['a: is not a setting of this plugin']);
    });

    it('is not fooled by inherited keys', () => {
        expect(errorsOf(SCHEMA, { endpoint: 'https://x.example', toString: 'x' })).toEqual(['toString: is not a setting of this plugin']);
    });
});

describe('configDefaults', () => {
    it('collects every declared default, copying lists and maps', () => {
        const defaults = configDefaults(SCHEMA);
        expect(defaults).toEqual({ model: 'small', limit: 8, auto: true, tags: ['a'], headers: { accept: 'json' } });
        expect(defaults.tags).not.toBe(SCHEMA.properties!.tags!.default);
        expect(defaults.headers).not.toBe(SCHEMA.properties!.headers!.default);
    });

    it('is empty for a bare schema', () => {
        expect(configDefaults({ type: 'object' })).toEqual({});
        expect(configDefaults({})).toEqual({});
    });

    it('the defaults of a schema without required keys validate', () => {
        const schema: ConfigSchema = { type: 'object', properties: SCHEMA.properties! };
        expect(validateConfig(schema, configDefaults(schema)).ok).toBe(true);
    });
});

describe('single-slot kinds', () => {
    it('memory and learning run one plugin at a time', () => {
        expect(SINGLE_SLOT_KINDS).toEqual(['memory', 'learning']);
        expect(isSingleSlot('memory')).toBe(true);
        expect(isSingleSlot('learning')).toBe(true);
        expect(isSingleSlot('runtime')).toBe(false);
        expect(isSingleSlot('connector')).toBe(false);
    });
});

describe('pluginReadiness', () => {
    const api: PluginManifest = {
        id: 'anthropic-api',
        version: '1.0.0',
        kind: 'runtime',
        name: 'Anthropic API',
        description: '',
        capabilities: [],
        config: { type: 'object', properties: { defaultModel: { type: 'string', enum: ['a', 'b'], default: 'a' } }, additionalProperties: false },
        secrets: [
            { name: 'anthropic-api-key', title: 'API key', description: '', required: true },
            { name: 'anthropic-admin-key', title: 'Admin key', description: '', required: false }
        ],
        permissions: [{ scope: 'secret:anthropic-api-key', reason: 'Call the API' }],
        compat: { platform: '*', core: '*' }
    };
    const daemon: PluginManifest = {
        id: 'claude-code',
        version: '1.0.0',
        kind: 'runtime',
        name: 'Claude Code',
        description: '',
        capabilities: ['daemon-hosted'],
        config: { type: 'object' },
        permissions: [{ scope: 'machine:m1', reason: 'Run sessions' }],
        compat: { platform: '*', core: '*' }
    };
    const state = (manifest: PluginManifest, patch: Partial<PluginState> = {}): PluginState => ({
        manifest,
        enabled: true,
        config: {},
        grantedPermissions: manifest.permissions.map((p) => p.scope),
        ...patch
    });
    const facts = (patch: Partial<PluginReadinessFacts> = {}): PluginReadinessFacts => ({ secretNames: ['anthropic-api-key'], environments: [], hasKek: true, ...patch });

    it.each<[string, PluginState, PluginReadinessFacts, ReturnType<typeof pluginReadiness>]>([
        ['ready', state(api), facts(), { status: 'ready' }],
        ['ready on schema defaults alone, optional secret unset', state(api, { config: {} }), facts(), { status: 'ready' }],
        ['disabled wins over everything', state(api, { enabled: false, config: { defaultModel: 'zzz' } }), facts({ secretNames: [] }), { status: 'disabled' }],
        ['needs-config names the bad keys', state(api, { config: { defaultModel: 'zzz', stray: 1 } }), facts(), { status: 'needs-config', missing: ['defaultModel', 'stray'] }],
        ['needs-secret names the required secrets not set', state(api), facts({ secretNames: [] }), { status: 'needs-secret', missing: ['anthropic-api-key'] }],
        ['no-kek when the secret could not be stored at all', state(api), facts({ secretNames: [], hasKek: false }), { status: 'no-kek', missing: ['anthropic-api-key'] }],
        ['needs-grant names the declared scopes not granted', state(api, { grantedPermissions: [] }), facts(), { status: 'needs-grant', missing: ['secret:anthropic-api-key'] }],
        ['a family grant covers the scope', state(api, { grantedPermissions: ['secret:*'] }), facts(), { status: 'ready' }],
        ['needs-machine without an environment of the runtime', state(daemon), facts({ environments: [{ runtime: 'anthropic-api' }] }), { status: 'needs-machine', missing: ['claude-code'] }],
        ['a daemon-hosted runtime with an environment is ready', state(daemon, { grantedPermissions: ['machine:*'] }), facts({ environments: [{ runtime: 'claude-code' }] }), { status: 'ready' }]
    ])('%s', (_, s, f, expected) => {
        expect(pluginReadiness(s, f)).toEqual(expected);
    });

    it('a plugin without secrets is untouched by a missing KEK', () => {
        expect(pluginReadiness(state(daemon), facts({ hasKek: false, environments: [{ runtime: 'claude-code' }] }))).toEqual({ status: 'ready' });
    });

    it('only a runtime that says it is daemon-hosted needs a machine', () => {
        expect(pluginReadiness(state({ ...daemon, kind: 'connector' }), facts())).toEqual({ status: 'ready' });
    });
});
