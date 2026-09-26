/** Where a chat opens (#929): inside its project when it has one that still exists, else `/chats/:id`. */
import { describe, expect, it } from 'vitest';
import { chatHref, chatIdOfRoute, chatRedirect, globalChatHref, projectChatHref } from '../../src/pages/chat/href';

describe('chatHref (#929)', () => {
    it('opens a project’s chat inside the project', () => {
        expect(chatHref({ id: 'c4', projectId: 'p_agentic' })).toBe('/projects/p_agentic/chats/c4');
        expect(projectChatHref('p_agentic', 'c4')).toBe('/projects/p_agentic/chats/c4');
    });

    it('opens a chat in no project at /chats/:id', () => {
        expect(chatHref({ id: 'c1' })).toBe('/chats/c1');
        expect(chatHref({ id: 'c1', projectId: null })).toBe('/chats/c1');
        expect(chatHref({ id: 'c1', projectId: '' })).toBe('/chats/c1');
        expect(globalChatHref('c1')).toBe('/chats/c1');
    });

    it('falls back to /chats/:id when the chat’s project no longer exists', () => {
        const exists = (id: string) => id === 'p_agentic';
        expect(chatHref({ id: 'c9', projectId: 'p_gone' }, exists)).toBe('/chats/c9');
        expect(chatHref({ id: 'c4', projectId: 'p_agentic' }, exists)).toBe('/projects/p_agentic/chats/c4');
    });

    it('encodes ids that are not path-safe', () => {
        expect(chatHref({ id: 'a/b', projectId: 'p 1' })).toBe('/projects/p%201/chats/a%2Fb');
    });
});

describe('chatRedirect (#929)', () => {
    it('moves /chats/:id of a project’s chat into the project', () => {
        expect(chatRedirect('/chats/c4', { id: 'c4', projectId: 'p_agentic' })).toBe('/projects/p_agentic/chats/c4');
    });

    it('stays when the page is already at the chat’s address', () => {
        expect(chatRedirect('/projects/p_agentic/chats/c4', { id: 'c4', projectId: 'p_agentic' })).toBeNull();
        expect(chatRedirect('/projects/p_agentic/chats/c4/', { id: 'c4', projectId: 'p_agentic' })).toBeNull();
        expect(chatRedirect('/chats/c1', { id: 'c1' })).toBeNull();
    });

    it('follows a chat moved to another project, or out of one', () => {
        expect(chatRedirect('/projects/p_agentic/chats/c4', { id: 'c4', projectId: 'p_docs' })).toBe('/projects/p_docs/chats/c4');
        expect(chatRedirect('/projects/p_agentic/chats/c4', { id: 'c4', projectId: null })).toBe('/chats/c4');
        expect(chatRedirect('/projects/p_agentic/chats/c4', { id: 'c4', projectId: 'p_gone' }, () => false)).toBe('/chats/c4');
    });
});

describe('chatIdOfRoute (#929)', () => {
    it('reads the chat of either chat route, nothing on another', () => {
        expect(chatIdOfRoute({ name: 'chat', params: { id: 'c1' } })).toBe('c1');
        expect(chatIdOfRoute({ name: 'project-chat', params: { id: 'p_agentic', chatId: 'c4' } })).toBe('c4');
        expect(chatIdOfRoute({ name: 'project-chats', params: { id: 'p_agentic' } })).toBeUndefined();
    });
});
