/**
 * `/chats/new?env=&path=&origin=` (#336): the deep link `agentic-daemon open` sends the browser to, on mock data.
 * The dialog opens on the prefill — the project whose git feature names the origin preselected, the folder offered
 * as that project's folder on an environment that has none — or, with no such project, on the choice between
 * "Just this chat" and "Create project from this folder", which lands on the project form prefilled. Without a
 * usable query it is the plain dialog. The query never re-fires: the URL is replaced.
 */
import { describe, it, expect } from 'vitest';
import type { ProjectRecord } from '@agentic/core';
import { AGENTIC_ORIGIN } from '../../src/mock/fs';
import { newChatRequest } from '../../src/pages/chat/head';
import { folderNameOf, newChatPrefillOf, newProjectLink, projectForOrigin } from '../../src/pages/chat/new-chat-prefill';
import { mockWorkdirEnvironments } from '../../src/pages/workdir/environments';
import { text } from './helpers';
import { mountRoute, page } from './mount';

const settle = async (): Promise<void> => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); };
const q = (params: Record<string, string>): string => Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
const select = (): HTMLSelectElement | null => document.querySelector<HTMLSelectElement>('select[name="chat-project"]');
const prefillBlock = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-new-chat-prefill]');
const button = (label: string): HTMLButtonElement => {
    const b = [...document.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.textContent?.trim() === label);
    if (!b) throw new Error(`no button "${label}"`);
    return b;
};
const labelOf = (id: string): string => mockWorkdirEnvironments.list().find((e) => e.id === id)!.label;

describe('/chats/new (mock)', () => {
    it('with an origin the "agentic" project names and an environment it has no folder on: preselected, and the folder offered as its folder there', async () => {
        const path = 'D:\\src\\agentic';
        const dom = await mountRoute(`/chats/new?${q({ env: 'env_nuclab_work', path, origin: 'git@github.com:andtii/agentic' })}`);
        await settle();
        expect(page(dom, 'chats')).not.toBeNull();
        expect(newChatRequest.open).toBe(true);
        expect(select()!.value).toBe('p_agentic');
        const block = prefillBlock()!;
        expect(block.getAttribute('data-prefill-project')).toBe('p_agentic');
        const save = block.querySelector<HTMLInputElement>('input[name="chat-save-folder"]')!;
        expect(save.checked).toBe(true);
        // Saved as the folder of the machine reporting the environment (#702).
        expect(text(block)).toBe(`Save ${path} as this project's folder on nuc-lab`);
        expect(block.querySelector('[data-new-chat-prefill-choice]')).toBeNull();
    });

    it('on an environment the project already has a folder on, the line says where the chat runs; the last used project is overridden by the origin', async () => {
        const dom = await mountRoute(`/chats/new?${q({ env: 'env_alien01_personal', path: 'C:\\Users\\andy\\src\\blog', origin: AGENTIC_ORIGIN })}`);
        await settle();
        expect(page(dom, 'chats')).not.toBeNull();
        expect(select()!.value).toBe('p_agentic');
        const block = prefillBlock()!;
        expect(block.querySelector('input[name="chat-save-folder"]')).toBeNull();
        expect(text(block)).toContain("the project's folder there is C:\\Users\\andy\\src\\agentic");
    });

    it('with an origin no project names: both choices, "Just this chat" first; "Create project from this folder" lands on the form prefilled', async () => {
        const path = '/home/andy/src/new-thing';
        const dom = await mountRoute(`/chats/new?${q({ env: 'env_alien01_work', path, origin: 'https://github.com/andtii/new-thing.git' })}`);
        await settle();
        // The last used project is not assumed for a folder of another repo.
        expect(select()!.value).toBe('');
        const block = prefillBlock()!;
        expect(block.hasAttribute('data-prefill-project')).toBe(false);
        expect(text(block.querySelector('[data-new-chat-prefill-choice] [data-scope="field"][data-part="label"]'))).toBe('This folder is not in a project yet');
        expect(text(block.querySelector('[data-new-chat-prefill-line]'))).toBe(`${path} on ${labelOf('env_alien01_work')}`);
        const radios = [...block.querySelectorAll<HTMLInputElement>('input[name="chat-prefill-mode"]')];
        expect(radios.map((r) => [r.value, r.checked])).toEqual([['chat', true], ['project', false]]);
        expect(button('Create chat')).toBeTruthy();
        radios[1]!.checked = true;
        radios[1]!.dispatchEvent(new Event('change', { bubbles: true }));
        await settle();
        button('Create project').click();
        await settle();
        // The form, on the folder: the name from the folder, the row on that environment, the origin as its badge.
        expect(page(dom, 'project')).not.toBeNull();
        expect(newChatRequest.open).toBe(false);
        expect(dom.querySelector<HTMLInputElement>('input[name="project-name"]')!.value).toBe('new-thing');
        // The row of the machine reporting that environment (#702).
        const row = dom.querySelector<HTMLElement>('[data-project-folder="alien01"]')!;
        expect(text(row.querySelector('[data-scope="ag-workdir"][data-part="chip"]'))).toContain('new-thing');
        expect(text(row.querySelector('[data-project-folder-meta] [data-scope="badge"][data-part="root"]'))).toBe('repo');
    });

    it('cancelling goes back to the list with the link replaced, and a link without a usable query is the plain dialog', async () => {
        const dom = await mountRoute(`/chats/new?${q({ env: 'env_alien01_work', path: 'C:\\Dev\\agentic\\main', origin: AGENTIC_ORIGIN })}`);
        await settle();
        expect(prefillBlock()).not.toBeNull();
        button('Cancel').click();
        await settle();
        expect(newChatRequest.open).toBe(false);
        expect(newChatRequest.prefill).toBeNull();
        expect(page(dom, 'chats')).not.toBeNull();
        expect(prefillBlock()).toBeNull();
        expect(dom.querySelector('[data-chat-list][data-wide]')).not.toBeNull();
    });

    it('without env and path the dialog opens plain', async () => {
        await mountRoute('/chats/new?origin=whatever');
        await settle();
        expect(newChatRequest.open).toBe(true);
        expect(newChatRequest.prefill).toBeNull();
        expect(prefillBlock()).toBeNull();
        // The plain opening: the last used project, as from the topbar.
        expect(select()!.value).toBe('p_agentic');
    });
});

describe('new-chat prefill (pure)', () => {
    it('reads env, path and an optional origin; ignores a malformed query', () => {
        expect(newChatPrefillOf({ env: 'e', path: 'C:\\x', origin: 'o' })).toEqual({ environmentId: 'e', path: 'C:\\x', origin: 'o' });
        expect(newChatPrefillOf({ env: 'e', path: 'C:\\x' })).toEqual({ environmentId: 'e', path: 'C:\\x' });
        expect(newChatPrefillOf({ env: ['e', 'f'], path: ['p'], origin: '' })).toEqual({ environmentId: 'e', path: 'p' });
        expect(newChatPrefillOf({ env: 'e' })).toBeUndefined();
        expect(newChatPrefillOf({ path: ' ' , env: 'e' })).toBeUndefined();
        expect(newChatPrefillOf({})).toBeUndefined();
    });

    it('matches a project by the origin its git feature names, in any spelling of the same repo', () => {
        const projects: { readonly id: string; readonly features?: ProjectRecord['features'] }[] = [
            { id: 'a', features: { 'agentic.feature.git': { origin: 'https://github.com/andtii/agentic.git' } } },
            { id: 'b', features: { git: { origin: 'git@github.com:andtii/blog.git' } } },
            { id: 'c', features: {} }
        ];
        expect(projectForOrigin(projects, 'ssh://git@GitHub.com/andtii/agentic/')?.id).toBe('a');
        expect(projectForOrigin(projects, 'https://github.com/andtii/blog')?.id).toBe('b');
        expect(projectForOrigin(projects, 'https://github.com/andtii/other')).toBeUndefined();
        expect(projectForOrigin(projects, undefined)).toBeUndefined();
        expect(projectForOrigin([{ id: 'd' }] as typeof projects, 'https://github.com/andtii/agentic')).toBeUndefined();
    });

    it('names a project after the folder and links to the form with everything encoded', () => {
        expect(folderNameOf('C:\\Dev\\agentic\\main\\')).toBe('main');
        expect(folderNameOf('/home/andy/src/blog')).toBe('blog');
        expect(folderNameOf('C:\\')).toBe('C:');
        expect(newProjectLink({ environmentId: 'env_work', path: 'C:\\Dev\\my app', origin: 'git@github.com:andtii/app.git' })).toBe(
            '/projects/new?name=my%20app&env=env_work&path=C%3A%5CDev%5Cmy%20app&origin=git%40github.com%3Aandtii%2Fapp.git'
        );
        expect(newProjectLink({ environmentId: 'e', path: '/srv/x' })).toBe('/projects/new?name=x&env=e&path=%2Fsrv%2Fx');
    });
});
