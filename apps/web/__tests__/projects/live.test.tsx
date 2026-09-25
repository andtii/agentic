/**
 * Projects on the live pages (#333): two paired machines (Windows, macOS)
 * each reporting one environment, a project with a folder on both, a chat
 * created in it through `createChatWith` — the chat page shows each
 * member's effective folder (the project's for its environment, marked
 * "from project") without any `setWorkdir`, the header carries the project
 * chip, and the list filters by project. The project pages list, create
 * and edit through the Workspace.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { projectFolderKey, type AgentId, type EnvironmentDescriptor, type EnvironmentId, type HostOs, type MachineId } from '@agentic/core';
import { DAEMON_PROTOCOL_VERSION } from '@agentic/daemon-protocol';
import { IN_MEMORY_CAPABILITIES, inMemoryEnvironment } from '@agentic/daemon-protocol/testing';
import { AgentActor, Chat, Workspace, agentKey, machineKey, workspaceKey } from '@agentic/platform';
import { clientDefs } from '../../src/actors/client';
import { chatKeyOf } from '../../src/actors/keys';
import { topbarFor } from '../../src/components/topbar';
import { chatHead } from '../../src/pages/chat/head';
import { createChatWith, folderMachineFor } from '../../src/pages/chat/LiveChats';
import { projectHead } from '../../src/pages/projects/head';
import { saveProjectWith } from '../../src/pages/projects/LiveProjects';
import { USER, WS, mountLive, owner, startLive, texts, tick, until, type LiveHarness } from '../pages/live-harness';

let h: LiveHarness;
beforeEach(async () => {
    h = await startLive();
});
afterEach(async () => {
    chatHead.value = null;
    projectHead.value = null;
    await h.stop();
});

const CLAUDE = { ...IN_MEMORY_CAPABILITIES, runtime: 'claude-code' };

/** Register + pair a machine and let its daemon say hello with one claude-code environment over `roots`. */
async function machineWith(name: string, os: HostOs, envId: string, roots: readonly string[]): Promise<{ machineId: MachineId; envId: EnvironmentId }> {
    const ws = h.app.as(owner).actor(Workspace, workspaceKey(WS));
    const { machineId, pairingCode } = await ws.registerMachinePending({ name });
    const daemon = h.app.as({ kind: 'machine', workspaceId: WS, machineId }).actor(h.Machine, machineKey(WS, machineId));
    await daemon.pair(pairingCode, { name, os, daemonVersion: '0.1.0-test' });
    const env: EnvironmentDescriptor = { ...inMemoryEnvironment(machineId, envId as EnvironmentId), name: 'work', runtime: 'claude-code', account: { label: 'work', authStatus: 'ok' }, cwdRoots: roots, isolation: 'config-dir' };
    await daemon.socketMessage(JSON.stringify({ v: DAEMON_PROTOCOL_VERSION, t: 'hello', machineId, daemonVersion: '0.1.0-test', os, environments: [env], capabilities: [CLAUDE], resume: {} }));
    return { machineId, envId: envId as EnvironmentId };
}

/** An agent on the claude-code runtime, defaulting to `envId`. */
async function daemonAgent(name: string, envId: EnvironmentId): Promise<AgentId> {
    const id = await h.agent(name, 'Builds things');
    await h.app.as(owner).actor(AgentActor, agentKey(WS, id)).update({ name, instructions: 'Be brief.', execution: { runtime: 'claude-code', defaultEnvironmentId: envId, offlinePolicy: 'queue' } }, 'environment');
    return id;
}

describe('projects on the live pages (#333)', () => {
    it('a project with folders on two environments: the chat in it shows each member\u2019s folder from the project, the header chip and the list filter', { timeout: 20_000 }, async () => {
        const win = await machineWith('laptop', 'windows', 'env_win', ['C:\\Dev']);
        const mac = await machineWith('studio', 'darwin', 'env_mac', ['/Users/me/dev']);
        const forge = await daemonAgent('Forge', win.envId);
        const lint = await daemonAgent('Lint', mac.envId);
        const defs = clientDefs();
        // Saved the way the form saves: through the browser's own stub over the wire.
        const { id: projectId } = await saveProjectWith(defs, USER, {
            name: 'agentic',
            members: { agentIds: [forge, lint], coordinator: forge },
            folders: { [projectFolderKey(win.machineId)]: 'C:\\Dev\\agentic\\main', [projectFolderKey(mac.machineId)]: '/Users/me/dev/agentic' },
            connectors: [],
            features: {}
        });
        const chatId = await createChatWith(defs, USER, [forge, lint], forge, projectId);
        const summary = await h.app.as(owner).actor(Chat, chatKeyOf(USER, chatId)).get();
        expect(summary.project).toEqual({ id: projectId, name: 'agentic' });
        expect(Object.values(summary.members).every((m) => !m.workdir)).toBe(true);

        const dom = await mountLive(`/chats/${chatId}`, h);
        const chips = () => [...dom.querySelectorAll<HTMLElement>('[data-page="chat"] > [data-chat-context] [data-member-workdir]')];
        await until(() => chips().length === 2 && chips().every((c) => c.hasAttribute('data-inherited')), 'both members on the project folders');
        // Each member's own machine and the project's folder there — nobody touched a row; the row's title carries environment and path.
        const chipTitle = chips().map((c) => c.querySelector('[data-member-workdir-open]')!.getAttribute('title') ?? '');
        expect(chipTitle[0]).toContain('laptop / work');
        expect(chipTitle[0]).toContain('agentic');
        expect(chipTitle[1]).toContain('studio / work');
        expect(chipTitle[1]).toContain('agentic');
        expect(texts(dom.querySelectorAll('[data-page="chat"] > [data-chat-context] [data-member-workdir-from]'))).toEqual(['project', 'project']);
        expect(dom.querySelector('[data-page="chat"] > [data-chat-context] [data-member-workdir-clear]')).toBeNull();
        // The header carries the project chip, linking to its page.
        await until(() => chatHead.value?.project?.name === 'agentic', 'the head to carry the project');
        const subtitle = topbarFor({ name: 'chat', path: `/chats/${chatId}`, params: { id: chatId } })?.subtitle;
        expect(subtitle).toBeDefined();
        // The list column filters by project.
        const filter = dom.querySelector<HTMLElement>('[data-chat-project-filter] [data-scope="select"][data-part="root"]');
        expect(filter).not.toBeNull();
        expect(texts(filter!.querySelectorAll('[role="option"]')).map((t) => t.replace('✓', '').trim())).toEqual(['All projects', 'agentic']);
        expect(texts(filter!.querySelectorAll('[data-scope="select"][data-part="value"]'))).toEqual(['All projects']);
        expect(dom.querySelector('[data-chat-row][data-current]')).not.toBeNull();

        // An override for one member wins over the project and can be cleared back to it.
        await h.app.as(owner).actor(Chat, chatKeyOf(USER, chatId)).setWorkdir(forge, { environmentId: win.envId, path: 'C:\\Dev\\agentic\\branches\\x' });
        await until(() => chips()[0]?.hasAttribute('data-inherited') === false, 'the override to show');
        expect(chips()[0]!.querySelector('[data-member-workdir-clear]')).not.toBeNull();
        chips()[0]!.querySelector<HTMLButtonElement>('[data-member-workdir-clear]')!.click();
        await until(() => chips()[0]?.hasAttribute('data-inherited') === true, 'the project folder back');
    });

    it('/projects lists the project with a badge per machine; /projects/:id/settings/general edits it and publishes the crumb', { timeout: 20_000 }, async () => {
        const win = await machineWith('laptop', 'windows', 'env_win', ['C:\\Dev']);
        const forge = await daemonAgent('Forge', win.envId);
        const defs = clientDefs();
        const { id } = await saveProjectWith(defs, USER, { name: 'agentic', members: { agentIds: [forge], coordinator: null }, folders: { [projectFolderKey(win.machineId)]: 'C:\\Dev\\agentic\\main' } });
        const list = await mountLive('/projects', h);
        await until(() => list.querySelectorAll('[data-project-row]').length === 1, 'the project row');
        expect(texts(list.querySelectorAll('[data-project-row] .project-env'))).toEqual(['laptop']);
        expect(list.querySelectorAll('[data-project-row] [data-scope="avatar"][data-part="root"]').length).toBe(2); // Forge and the project's manager (#784)

        const edit = await mountLive(`/projects/${id}/settings/general`, h);
        await until(() => edit.querySelector<HTMLInputElement>('input[name="project-name"]')?.value === 'agentic', 'the form on the record');
        await until(() => projectHead.value?.name === 'agentic', 'the crumb');
        expect(topbarFor({ name: 'project', path: `/projects/${id}`, params: { id } })?.crumb).toBe('agentic');
        // The folder rows are their own tab (#733).
        const folders = await mountLive(`/projects/${id}/settings/folders`, h);
        await until(() => folders.querySelectorAll('[data-project-folder]').length === 1, 'the folder row');
        const rows = [...folders.querySelectorAll<HTMLElement>('[data-project-folder]')];
        expect(rows.map((r) => r.getAttribute('data-project-folder'))).toEqual([win.machineId]);
        expect(rows[0]!.querySelector('[data-scope="ag-workdir"][data-part="chip"]')!.textContent).toContain('agentic');
        // A refused save (a folder outside the roots) shows the actor's 400 inline and keeps the page.
        await expect(saveProjectWith(defs, USER, { id: id as never, folders: { [projectFolderKey(win.machineId)]: 'D:\\elsewhere' } })).rejects.toThrow(/outside the roots/);
        await tick();
    });

    it('a prefilled folder is saved on the chat\u2019s machine only when it reports the environment, else on the one that does (#702)', () => {
        const hosted = (machineId: string, environmentId: string) => machineId === 'win' && environmentId === 'env_claude';
        const machineOf = () => 'win';
        expect(folderMachineFor('env_claude', 'win', machineOf, hosted)).toBe('win');
        expect(folderMachineFor('env_claude', 'mac', machineOf, hosted)).toBe('win');
        expect(folderMachineFor('env_claude', null, machineOf, hosted)).toBe('win');
        expect(folderMachineFor('env_claude', null)).toBeUndefined();
    });
});
