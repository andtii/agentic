/**
 * A refused project move (#947): `Chat.setProject` answers 409 when the project the chat leaves cannot release it
 * (#936); the Review and move dialog shows why and "Move anyway" retries the chats left with `{ force: true }`.
 */
import { describe, it, expect } from 'vitest';
import type { ProjectRecord } from '@agentic/core';
import { ChatsView } from '../../src/pages/projects/chats/ChatsView';
import { MoveRefused, moveChats, refusalOf, type MoveOptions } from '../../src/pages/projects/chats/move';
import type { ProjectChatRow } from '../../src/pages/projects/chats/groups';
import { buttonNamed, mountAt, tick } from '../pages/helpers';

const refusal = (message: string): Error => Object.assign(new Error(message), { status: 409 });
const SERVER = 'Chat.setProject: the project this chat is in could not release it — the worktree has uncommitted changes. Move anyway with { force: true }';

describe('refusalOf (#947)', () => {
    it('reads a 409 as the reason, without the method prefix or the API hint', () => {
        expect(refusalOf(refusal(SERVER))).toBe('The project this chat is in could not release it — the worktree has uncommitted changes.');
        expect(refusalOf(refusal('Chat.setProject: the project this chat is in could not release it — the release did not finish within 30 s. Move anyway with { force: true }')))
            .toBe('The project this chat is in could not release it — the release did not finish within 30 s.');
    });

    it('is null for anything but a 409', () => {
        expect(refusalOf(new Error(SERVER))).toBeNull();
        expect(refusalOf(Object.assign(new Error('nope'), { status: 400 }))).toBeNull();
        expect(refusalOf('boom')).toBeNull();
    });
});

describe('moveChats (#947)', () => {
    it('stops at a refusal with the chats not moved yet, and moves them with force on retry', async () => {
        const calls: [string, MoveOptions | undefined][] = [];
        const moved: string[] = [];
        const setProject = async (id: string, options?: MoveOptions): Promise<void> => {
            calls.push([id, options]);
            if (id === 'b' && !options?.force) throw refusal(SERVER);
        };
        const err = await moveChats(['a', 'b', 'c'], setProject, (id) => moved.push(id)).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(MoveRefused);
        expect((err as MoveRefused).chatIds).toEqual(['b', 'c']);
        expect((err as MoveRefused).reason).toContain('uncommitted changes');
        expect(moved).toEqual(['a']);
        await moveChats((err as MoveRefused).chatIds, setProject, (id) => moved.push(id), { force: true });
        expect(moved).toEqual(['a', 'b', 'c']);
        expect(calls).toEqual([['a', undefined], ['b', undefined], ['b', { force: true }], ['c', { force: true }]]);
    });

    it('rethrows any other error as it is', async () => {
        const boom = new Error('network down');
        await expect(moveChats(['a'], async () => { throw boom; }, () => {})).rejects.toBe(boom);
    });
});

const project = { id: 'p1', name: 'agentic', folders: {}, members: { agentIds: [], coordinator: null }, features: {} } as unknown as ProjectRecord;
const row = (id: string, title: string): ProjectChatRow => ({ id, title, lastLine: '', agentIds: [], waiting: false, working: false, updatedAt: 0, work: [] });

describe('Review and move with a refused move (#947)', () => {
    it('shows the reason in the dialog, and Move anyway retries with force and closes it', async () => {
        const calls: [readonly string[], MoveOptions | undefined][] = [];
        const onMove = async (ids: readonly string[], options?: MoveOptions): Promise<void> => {
            calls.push([ids, options]);
            if (!options?.force) throw new MoveRefused(ids, 'The project this chat is in could not release it — the worktree has uncommitted changes.');
        };
        const dom = await mountAt('/projects/p1/chats', (
            <ChatsView project={project} chats={[row('c1', 'agentic nav')]} projects={[{ id: 'p1', name: 'agentic' }]}
                lookup={(id) => ({ name: id, hue: 0 }) as never} you="You" age={() => ''} onMove={onMove} />
        ));
        await tick();
        buttonNamed(dom, 'Review and move').click();
        await tick();
        expect(document.querySelector('[data-project-chats-refused]')).toBeNull();
        document.querySelector('[data-project-chats-move]')!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await tick();
        await tick();
        const refused = document.querySelector('[data-project-chats-refused]')!;
        expect(refused).not.toBeNull();
        expect(refused.textContent).toContain('uncommitted changes');
        expect(document.querySelector('[data-project-chats-move]')).not.toBeNull();
        buttonNamed(refused, 'Move anyway').click();
        await tick();
        await tick();
        expect(calls).toEqual([[['c1'], undefined], [['c1'], { force: true }]]);
        expect(document.querySelector('[data-project-chats-move]')).toBeNull();
        expect(document.querySelector('[data-project-chats-refused]')).toBeNull();
    });
});
