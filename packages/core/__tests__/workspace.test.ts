import { DEFAULT_WORKSPACE_SETTINGS, NOTIFICATION_KINDS, type EnvironmentId, type WorkspaceDefaults, type WorkspaceSettings } from '../src/index';

describe('WorkspaceSettings', () => {
    it('defaults to UTC, the Inbox on, push off, the API runtime and the documented retention windows', () => {
        expect(DEFAULT_WORKSPACE_SETTINGS).toEqual({
            timeZone: 'UTC',
            notifications: { inbox: true, push: false },
            defaults: { runtime: 'anthropic-api' },
            retention: { sessionLogDays: 90, artifactDays: 30 }
        });
    });

    it('names no default environment until the user picks one', () => {
        expect('environmentId' in DEFAULT_WORKSPACE_SETTINGS.defaults).toBe(false);
    });

    it('carries a default environment and any runtime id', () => {
        const settings: WorkspaceSettings = { ...DEFAULT_WORKSPACE_SETTINGS, defaults: { runtime: 'claude-code', environmentId: 'env_work' as EnvironmentId } };
        expect(settings.defaults).toEqual({ runtime: 'claude-code', environmentId: 'env_work' });
    });

    it('leaves the model to the runtime', () => {
        // @ts-expect-error a model is the runtime plugin's default, never the workspace's (#227)
        const defaults: WorkspaceDefaults = { runtime: 'anthropic-api', model: 'claude-opus-5' };
        expect(defaults.runtime).toBe('anthropic-api');
    });

    it('keeps the Inbox notification kinds', () => {
        expect(NOTIFICATION_KINDS).toEqual(['reminder', 'task-done', 'task-failed', 'approval', 'input', 'update-available', 'update-applied', 'update-failed', 'daemon-crash-loop', 'harness-update-available', 'resource-pressure', 'machine-security']);
    });
});
