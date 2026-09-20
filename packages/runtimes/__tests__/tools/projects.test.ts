/** The `projects` tool over a fake port (#334): schema, list, set, the guard on a chat already in a project, what the port sees. */
import { SchemaValidationError, type ToolContext } from '@sigx/ai';
import type { ChatId, ProjectId } from '@agentic/core';
import { platformTools, projectsTool, type ChatProject, type ProjectPort, type ProjectSummary, type ToolCall } from '../../src/index';
import { fakePorts } from '../anthropic/helpers';

const ctx = (id = 'call_1', signal = new AbortController().signal): ToolContext => ({ toolCallId: id, signal });

const AGENTIC: ProjectSummary = { id: 'project_agentic' as ProjectId, name: 'Agentic', description: 'The agent platform', environments: ['env_laptop' as never] };
const ZERO: ProjectSummary = { id: 'project_zero' as ProjectId, name: 'Zero', environments: [] };

/** A port over two projects and one chat whose project the test sets; every call is recorded with its `ToolCall`. */
function fakeProjectPort(initial: ChatProject | null = null) {
    const calls: { op: string; args: unknown; call: ToolCall }[] = [];
    let current: ChatProject | null = initial;
    const port: ProjectPort = {
        async list(call) {
            calls.push({ op: 'list', args: undefined, call });
            return [AGENTIC, ZERO];
        },
        async current(chatId, call) {
            calls.push({ op: 'current', args: chatId, call });
            return current;
        },
        async set(chatId, projectId, call) {
            calls.push({ op: 'set', args: { chatId, projectId }, call });
            if (projectId !== null && ![AGENTIC, ZERO].some((p) => p.id === projectId)) throw new Error(`Chat.setProject: no project ${projectId} in this workspace`);
            current = projectId === null ? null : { id: projectId, name: [AGENTIC, ZERO].find((p) => p.id === projectId)!.name };
        }
    };
    return { port, calls, get current() { return current; } };
}

describe('projects', () => {
    it('is on the roster after usage_limits, with a JSON Schema that names the actions and the force flag', () => {
        const tool = platformTools({ ...fakePorts(), projects: fakeProjectPort().port }).find((t) => t.name === 'projects')!;
        expect(tool.annotations).toEqual({ destructive: false, idempotent: true });
        const schema = JSON.stringify(tool.spec);
        expect(schema).toContain('"action"');
        expect(schema).toContain('"list"');
        expect(schema).toContain('"set"');
        expect(schema).toContain('"force"');
        expect(tool.description).toMatch(/ask_user/);
        expect(tool.description).toMatch(/never pick a folder on disk/);
        expect(tool.description).toMatch(/explicitly asked to switch/);
    });

    it('list returns the catalogue; the port sees the call id and signal', async () => {
        const fake = fakeProjectPort();
        const controller = new AbortController();
        const out = await projectsTool(fake.port).run({ action: 'list' }, ctx('call_9', controller.signal));
        expect(out).toEqual({ projects: [AGENTIC, ZERO] });
        expect(fake.calls).toHaveLength(1);
        expect(fake.calls[0]).toMatchObject({ op: 'list', call: { callId: 'call_9' } });
        expect(fake.calls[0]!.call.signal).toBe(controller.signal);
    });

    it('set puts a chat without a project in one, and answers the previous project (none)', async () => {
        const fake = fakeProjectPort();
        const out = await projectsTool(fake.port).run({ action: 'set', chatId: 'chat_1', projectId: 'project_agentic' }, ctx());
        expect(out).toEqual({ chatId: 'chat_1', projectId: 'project_agentic', previous: null });
        expect(fake.calls.map((c) => [c.op, c.args])).toEqual([
            ['current', 'chat_1'],
            ['set', { chatId: 'chat_1', projectId: 'project_agentic' }]
        ]);
        expect(fake.current).toEqual({ id: 'project_agentic', name: 'Agentic' });
    });

    it('the guard: a chat already in a project is left unchanged without force, named in the error; force switches it; the same project again is a no-op', async () => {
        const fake = fakeProjectPort({ id: 'project_agentic' as ProjectId, name: 'Agentic' });
        const tool = projectsTool(fake.port);
        await expect(tool.run({ action: 'set', chatId: 'chat_1', projectId: 'project_zero' }, ctx())).rejects.toThrow(/already in project "Agentic" \(project_agentic\).*force: true/);
        await expect(tool.run({ action: 'set', chatId: 'chat_1', projectId: null }, ctx())).rejects.toThrow(/already in project/);
        expect(fake.calls.filter((c) => c.op === 'set')).toEqual([]);
        expect(fake.current).toEqual({ id: 'project_agentic', name: 'Agentic' });
        // Already there: nothing to change, no set.
        await expect(tool.run({ action: 'set', chatId: 'chat_1', projectId: 'project_agentic' }, ctx())).resolves.toEqual({ chatId: 'chat_1', projectId: 'project_agentic', previous: { id: 'project_agentic', name: 'Agentic' } });
        expect(fake.calls.filter((c) => c.op === 'set')).toEqual([]);
        // The user asked for the switch.
        await expect(tool.run({ action: 'set', chatId: 'chat_1', projectId: 'project_zero', force: true }, ctx())).resolves.toEqual({ chatId: 'chat_1', projectId: 'project_zero', previous: { id: 'project_agentic', name: 'Agentic' } });
        expect(fake.current).toEqual({ id: 'project_zero', name: 'Zero' });
        await expect(tool.run({ action: 'set', chatId: 'chat_1', projectId: null, force: true }, ctx())).resolves.toEqual({ chatId: 'chat_1', projectId: null, previous: { id: 'project_zero', name: 'Zero' } });
        expect(fake.current).toBeNull();
    });

    it('a project the Workspace no longer names is still guarded, by id', async () => {
        const fake = fakeProjectPort({ id: 'project_gone' as ProjectId });
        await expect(projectsTool(fake.port).run({ action: 'set', chatId: 'chat_1' as ChatId, projectId: 'project_zero' }, ctx())).rejects.toThrow(/already in project project_gone/);
    });

    it('an unknown project is the port’s error, passed through', async () => {
        const fake = fakeProjectPort();
        await expect(projectsTool(fake.port).run({ action: 'set', chatId: 'chat_1', projectId: 'project_nope' }, ctx())).rejects.toThrow(/no project project_nope/);
    });

    it('rejects bad arguments before the port is called; set needs chatId and projectId', async () => {
        const fake = fakeProjectPort();
        const tool = projectsTool(fake.port);
        await expect(tool.run({ action: 'rename' }, ctx())).rejects.toBeInstanceOf(SchemaValidationError);
        await expect(tool.run({ action: 'set', projectId: 'project_agentic' }, ctx())).rejects.toBeInstanceOf(SchemaValidationError);
        await expect(tool.run({ action: 'set', chatId: 'chat_1' }, ctx())).rejects.toBeInstanceOf(SchemaValidationError);
        await expect(tool.run({ action: 'set', chatId: 'chat_1', projectId: '' }, ctx())).rejects.toBeInstanceOf(SchemaValidationError);
        expect(fake.calls).toEqual([]);
    });

    it('without a projects port the tool says so instead of succeeding silently', async () => {
        await expect(projectsTool(undefined).run({ action: 'list' }, ctx())).rejects.toThrow(/not available on this host/);
        expect(platformTools(fakePorts()).map((t) => t.name)).toContain('projects');
    });
});
