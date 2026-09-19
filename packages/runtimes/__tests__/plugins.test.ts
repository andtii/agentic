import { DAEMON_HOSTED_CAPABILITY, USAGE_LIMITS_CAPABILITY, configDefaults, runtimeKindOf, pluginReadiness, validateConfig, type PluginManifest, type PluginState } from '@agentic/core';
import { DEFAULT_ANTHROPIC_MODEL } from '@sigx/ai-anthropic';
import { ANTHROPIC_API_KEY_SECRET, ANTHROPIC_MODEL_IDS, ANTHROPIC_PRICING, RUNTIME_PLUGINS, anthropicApiPlugin, claudeCodePlugin, copilotCliPlugin, codexCliPlugin } from '../src/index';

const NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;
const KINDS = ['runtime', 'connector', 'memory', 'learning', 'notification', 'trigger', 'a2a'];

/** What a catalogue manifest must satisfy: the shape the Registry's `assertPluginManifest` checks (restated — this package sits below `@agentic/platform` and cannot import it) plus this track's own rules, which the Registry does not enforce: a reason per permission, a `secret:<name>` scope per secret, defaults that validate, no stray config key. */
function expectRegistrable(m: PluginManifest): void {
    expect(m.id).toMatch(NAME_RE);
    expect(m.version).not.toBe('');
    expect(KINDS).toContain(m.kind);
    expect(m.name.trim()).not.toBe('');
    expect(typeof m.description).toBe('string');
    expect(m.capabilities.every((c) => typeof c === 'string')).toBe(true);
    for (const p of m.permissions) expect(p.reason.trim()).not.toBe('');
    expect(new Set(m.permissions.map((p) => p.scope)).size).toBe(m.permissions.length);
    // Every declared secret can be opened: it has its own `secret:<name>` scope (PLG-04).
    for (const s of m.secrets ?? []) {
        expect(s.name).toMatch(NAME_RE);
        expect(m.permissions.map((p) => p.scope)).toContain(`secret:${s.name}`);
    }
    // The schema's own defaults are a valid config.
    expect(validateConfig(m.config, configDefaults(m.config))).toMatchObject({ ok: true });
    // A schema that declares its properties refuses a stray key — a secret cannot land in config.
    expect(validateConfig(m.config, { ...configDefaults(m.config), apiKey: 'sk-ant-x' }).ok).toBe(false);
}

const granted = (manifest: PluginManifest): PluginState => ({
    manifest,
    enabled: true,
    config: configDefaults(manifest.config),
    grantedPermissions: manifest.permissions.map((p) => p.scope)
});

describe('runtime plugin manifests', () => {
    it.each(RUNTIME_PLUGINS.map((m) => [m.id, m] as const))('%s is registrable', (_id, m) => {
        expect(m.kind).toBe('runtime');
        expectRegistrable(m);
    });

    it('ids are the runtime ids — the Registry matches an agent by execution.runtime', () => {
        expect(RUNTIME_PLUGINS.map((m) => m.id)).toEqual(['anthropic-api', 'claude-code', 'copilot-cli', 'codex-cli']);
    });

    it('anthropic-api offers every priced model and defaults to the provider default', () => {
        const model = anthropicApiPlugin.config.properties!.defaultModel!;
        expect(model).toMatchObject({ type: 'string', default: DEFAULT_ANTHROPIC_MODEL });
        expect(ANTHROPIC_MODEL_IDS).toEqual(expect.arrayContaining(Object.keys(ANTHROPIC_PRICING)));
        expect(ANTHROPIC_MODEL_IDS).toContain(DEFAULT_ANTHROPIC_MODEL);
        expect(new Set(ANTHROPIC_MODEL_IDS).size).toBe(ANTHROPIC_MODEL_IDS.length);
        expect(validateConfig(anthropicApiPlugin.config, { defaultModel: 'gpt-4' }).ok).toBe(false);
    });

    it('anthropic-api needs its key and nothing else', () => {
        expect(anthropicApiPlugin.secrets).toEqual([expect.objectContaining({ name: ANTHROPIC_API_KEY_SECRET, required: true })]);
        expect(anthropicApiPlugin.permissions.map((p) => p.scope)).toEqual([`secret:${ANTHROPIC_API_KEY_SECRET}`]);
        const state = granted(anthropicApiPlugin);
        expect(pluginReadiness(state, { secretNames: [], environments: [], hasKek: true })).toMatchObject({ status: 'needs-secret', missing: [ANTHROPIC_API_KEY_SECRET] });
        expect(pluginReadiness(state, { secretNames: [ANTHROPIC_API_KEY_SECRET], environments: [], hasKek: true }).status).toBe('ready');
    });

    it('claude-code is daemon-hosted: ready once a machine offers an environment of it', () => {
        expect(claudeCodePlugin.capabilities).toContain(DAEMON_HOSTED_CAPABILITY);
        expect(claudeCodePlugin.secrets).toBeUndefined();
        const state = granted(claudeCodePlugin);
        expect(pluginReadiness(state, { secretNames: [], environments: [], hasKek: true }).status).toBe('needs-machine');
        expect(pluginReadiness(state, { secretNames: [], environments: [{ runtime: 'claude-code' }], hasKek: true }).status).toBe('ready');
    });

    it('copilot-cli is a daemon-hosted harness that reports usage limits: ready once a machine offers an environment of it', () => {
        expect(runtimeKindOf(copilotCliPlugin)).toBe('harness');
        expect(copilotCliPlugin.capabilities).toEqual(expect.arrayContaining([DAEMON_HOSTED_CAPABILITY, USAGE_LIMITS_CAPABILITY]));
        const state = granted(copilotCliPlugin);
        expect(pluginReadiness(state, { secretNames: [], environments: [{ runtime: 'claude-code' }], hasKek: true }).status).toBe('needs-machine');
        expect(pluginReadiness(state, { secretNames: [], environments: [{ runtime: 'copilot-cli' }], hasKek: true }).status).toBe('ready');
    });

    it('codex-cli is a daemon-hosted harness that reports usage limits', () => {
        expect(runtimeKindOf(codexCliPlugin)).toBe('harness');
        expect(codexCliPlugin.capabilities).toEqual(expect.arrayContaining([DAEMON_HOSTED_CAPABILITY, USAGE_LIMITS_CAPABILITY]));
        expect(codexCliPlugin.secrets).toBeUndefined();
        const state = granted(codexCliPlugin);
        expect(pluginReadiness(state, { secretNames: [], environments: [{ runtime: 'claude-code' }], hasKek: true }).status).toBe('needs-machine');
        expect(pluginReadiness(state, { secretNames: [], environments: [{ runtime: 'codex-cli' }], hasKek: true }).status).toBe('ready');
    });
});
