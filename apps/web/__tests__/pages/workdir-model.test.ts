/** The folder picker's view model, the mock machine folders, "Start task" and the schedule spec (#193). */
import { describe, it, expect } from 'vitest';
import { FS_LIST_MAX_ENTRIES, type EnvironmentDescriptor, type EnvironmentId, type FsListResult } from '@agentic/core';
import { mockFsList, mockFsWorktree } from '../../src/mock/fs';
import { newScheduleSpec } from '../../src/pages/ops/live';
import type { EnvironmentEntry } from '../../src/pages/ops/environments';
import { titleOf, validateStartTask } from '../../src/pages/task/start';
import { mockWorkdirEnvironments } from '../../src/pages/workdir/environments';
import { DEFAULT_OS, requestError, startingPoint, unavailableReason, workdirEnvironmentOf } from '../../src/pages/workdir/model';

const WORK = 'env_alien01_work' as EnvironmentId;

const descriptor = (extra: Partial<EnvironmentDescriptor> = {}): EnvironmentDescriptor => ({
    id: 'env_a' as EnvironmentId,
    machineId: 'm1' as never,
    name: 'work',
    runtime: 'claude-code',
    account: { label: 'work', authStatus: 'ok' },
    cwdRoots: ['C:\\src'],
    concurrency: { max: 2, active: 0 },
    isolation: 'config-dir',
    ...extra
});

const entry = (extra: Partial<EnvironmentEntry> = {}): EnvironmentEntry => ({ id: 'env_a', machineId: 'm1', machineName: 'alien01', online: true, descriptor: descriptor(), line: { machine: 'alien01', runtime: 'claude-code', account: 'work' }, label: 'alien01 / claude-code / work', ...extra });

describe('workdir environments', () => {
    it('labels machine / environment and carries the roots and path rules', () => {
        expect(workdirEnvironmentOf(entry({ os: 'linux' }))).toEqual({ id: 'env_a', label: 'alien01 / work', os: 'linux', roots: ['C:\\src'] });
        // A machine that never said hello follows the lenient Windows rules.
        expect(workdirEnvironmentOf(entry()).os).toBe(DEFAULT_OS);
    });

    it('says why an environment cannot be browsed: machine first, then roots, then sign-in', () => {
        expect(unavailableReason(descriptor(), false)).toBe('Machine offline');
        expect(unavailableReason(descriptor({ cwdRoots: [] }), true)).toBe('No working roots configured');
        expect(unavailableReason(descriptor({ account: { label: 'x', authStatus: 'expired' } }), true)).toBe('Sign-in expired');
        expect(unavailableReason(descriptor({ account: { label: 'x', authStatus: 'missing' } }), true)).toBe('Not signed in');
        expect(unavailableReason(descriptor({ account: { label: 'x', authStatus: 'unknown' } }), true)).toBeUndefined();
        expect(unavailableReason(descriptor(), true)).toBeUndefined();
    });

    it('opens on the chosen folder, else the preferred environment, else the first browsable one', () => {
        const envs = mockWorkdirEnvironments.list();
        expect(startingPoint({ environmentId: WORK, path: 'C:\\Dev\\agentic' }, envs)).toEqual({ environmentId: WORK, path: 'C:\\Dev\\agentic' });
        expect(startingPoint(null, envs, 'env_alien01_personal' as EnvironmentId)).toEqual({ environmentId: 'env_alien01_personal', path: null });
        // An expired sign-in is not browsable: the preference falls through to the first environment that is.
        expect(startingPoint(null, envs, 'env_alien01_client_acme' as EnvironmentId)).toEqual({ environmentId: WORK, path: null });
        expect(startingPoint({ environmentId: 'env_gone' as EnvironmentId, path: 'X:\\' }, envs).environmentId).toBe(WORK);
        expect(startingPoint(null, [])).toEqual({ environmentId: null, path: null });
    });

    it('turns a refused actor call into an fs error the dialog can word', () => {
        expect(requestError(Object.assign(new Error('offline'), { status: 503 })).code).toBe('timeout');
        expect(requestError(Object.assign(new Error('no env'), { status: 404 })).code).toBe('unknown-environment');
        expect(requestError(Object.assign(new Error('owner only'), { status: 403 })).message).toBe('Only the workspace owner can do that');
        expect(requestError('boom')).toEqual({ code: 'internal', message: 'boom' });
    });

    it('the mock machines: ids agree with the workspace mock, the offline and expired ones are unavailable', () => {
        const envs = mockWorkdirEnvironments.list();
        expect(envs.map((e) => [e.id, e.unavailable ?? null])).toEqual([
            ['env_alien01_work', null],
            ['env_alien01_personal', null],
            ['env_alien01_client_acme', 'Sign-in expired'],
            ['env_alien01_copilot', null],
            ['env_alien01_codex', null],
            ['env_nuclab_work', 'Machine offline']
        ]);
        expect(mockWorkdirEnvironments.machineOf('env_nuclab_work')).toBe('nuc-lab');
    });
});

describe('mock machine folders', () => {
    const list = (path: string) => mockFsList(WORK, path) as FsListResult;

    it('lists a root with git badges and no parent, case-insensitively', () => {
        const root = list('c:/dev');
        expect(root.path).toBe('C:\\Dev');
        expect(root.parent).toBeUndefined();
        expect(root.entries.map((e) => e.name)).toEqual(['agentic', 'agentic-ui-handoff', 'sigx']);
        expect(root.entries.find((e) => e.name === 'sigx')?.git).toEqual({ kind: 'repo', branch: 'main' });
        const branches = list('C:\\Dev\\agentic\\branches');
        expect(branches.parent).toBe('C:\\Dev\\agentic');
        expect(branches.entries[0]).toMatchObject({ name: '186-workdir-contract', path: 'C:\\Dev\\agentic\\branches\\186-workdir-contract', git: { kind: 'worktree' } });
        expect(list('C:\\Dev\\agentic\\main').git).toEqual({ kind: 'repo', branch: 'main' });
    });

    it('truncates a big folder and refuses what a daemon would', () => {
        const runs = list('D:\\scratch\\runs');
        expect(runs.entries).toHaveLength(FS_LIST_MAX_ENTRIES);
        expect(runs.truncated).toBe(true);
        expect(mockFsList(WORK, 'C:\\Windows')).toMatchObject({ code: 'outside-roots' });
        expect(mockFsList(WORK, 'C:\\Dev\\nope')).toMatchObject({ code: 'not-found' });
        expect(mockFsList('env_nuclab_work', 'C:\\work')).toMatchObject({ code: 'timeout' });
        expect(mockFsList('env_x', 'C:\\')).toMatchObject({ code: 'unknown-environment' });
    });

    it('adds a worktree beside the others, once', () => {
        const repo = 'C:\\Dev\\agentic\\main';
        const path = 'C:\\Dev\\agentic\\branches\\200-mock-test';
        expect(mockFsWorktree(WORK, repo, '200-mock-test', path)).toEqual({ kind: 'worktree', path, branch: '200-mock-test' });
        expect(list('C:\\Dev\\agentic\\branches').entries.map((e) => e.name)).toContain('200-mock-test');
        expect(mockFsWorktree(WORK, repo, '200-mock-test', path)).toMatchObject({ code: 'exists' });
        expect(mockFsWorktree(WORK, 'C:\\Dev\\agentic-ui-handoff', 'x', 'C:\\Dev\\x')).toMatchObject({ code: 'not-a-repo' });
        expect(mockFsWorktree(WORK, repo, 'bad name', 'C:\\Dev\\agentic\\branches\\y')).toMatchObject({ code: 'invalid-branch' });
    });
});

describe('start task', () => {
    it('asks for an agent and an objective', () => {
        expect(validateStartTask({ agentId: '', objective: ' ', workdir: null })).toEqual({ agentId: 'Pick the agent that does it.', objective: 'Say what it should do.' });
        expect(validateStartTask({ agentId: 'forge', objective: 'Fix the drawer', workdir: null })).toEqual({});
    });

    it('titles the chat by the objective’s first line, at most 60 characters', () => {
        expect(titleOf('  Fix the drawer\nand the tests ')).toBe('Fix the drawer');
        expect(titleOf('x'.repeat(80))).toHaveLength(60);
        expect(titleOf('x'.repeat(80)).endsWith('…')).toBe(true);
    });
});

describe('new schedule spec', () => {
    const base = { kind: 'agent-task' as const, title: 'Nightly', at: '', cron: '0 2 * * *', agentId: 'forge', prompt: 'audit' };
    it('carries the folder with its environment, and drops it without one', () => {
        expect(newScheduleSpec({ ...base, environmentId: 'env_a', workdir: ' C:\\src\\app ' }, 'UTC')).toMatchObject({ environmentId: 'env_a', workdir: 'C:\\src\\app' });
        expect(newScheduleSpec({ ...base, environmentId: '', workdir: 'C:\\src\\app' }, 'UTC')).not.toHaveProperty('workdir');
        expect(newScheduleSpec({ ...base, environmentId: 'env_a' }, 'UTC')).not.toHaveProperty('workdir');
    });
});
