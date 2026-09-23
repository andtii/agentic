/**
 * The chat hooks of a session's Changes and Files views (#565): the pure
 * references (file tokens, code references, "View diff" per runtime, paths
 * relative to the folder), asking the session's agent in its chat, and the
 * mock workspace end to end — a question lands in the chat with its hunk,
 * "Mention in chat" puts `@file:` in the composer, the Edit card's "View
 * diff" opens that file's diff.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentId, ChatId, MessageId, PromptPart, TaskContract } from '@agentic/core';
import type { ChatSummary, IndexedEntry } from '@agentic/platform';
import { clearMockChatPosts, mockChatPosts } from '../../src/mock/chat-posts';
import { activationContract, lookupOver, mentionsIn, type AgentIdentity } from '../../src/pages/chat/live';
import { askInChat } from '../../src/pages/session/chat-hooks';
import { changesHref, filesHref, relativeToRoot, type LineQuestion } from '../../src/pages/session/files';
import { codeReferencePart, fileReferenceParts, fileToken, fileTokensIn, mentionHref, mentionOfQuery, questionParts, referenceLabel, resourceText, viewDiffLinks } from '../../src/pages/session/references';
import { all, mountRoute, tick } from './mount';

async function until(check: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
        if (check()) return;
        await tick();
    }
    throw new Error(`timed out waiting for ${what}`);
}

const question: LineQuestion = { path: 'packages/ui/src/shell/shell.css', ref: { side: 'original', line: 61 }, text: ' Does the drawer keep its focus trap? ', hunk: '@@ -55,9 +67,11 @@ .drawer\n-  display: flex;\n+  display: var(--drawer-display, flex);\n', scope: 'uncommitted' };

describe('references (#565)', () => {
    it('reads `@file:` tokens, each once, and never as an agent mention', () => {
        expect(fileToken('src/a.ts')).toBe('@file:src/a.ts');
        expect(fileTokensIn('@file:src/a.ts and @file:src/b.ts, again @file:src/a.ts; not x@file:c.ts')).toEqual(['src/a.ts', 'src/b.ts']);
        const file: AgentIdentity = { id: 'f1', name: 'file', role: '', hue: 1, environment: { machine: 'm', runtime: 'claude-code', account: 'a' }, configVersion: 1 };
        const members = [{ agentId: 'f1', status: 'idle' as const, history: { access: 'all' as const } }];
        expect(mentionsIn('@file:src/a.ts', members, lookupOver({ f1: file }))).toEqual([]);
        expect(mentionsIn('@file look', members, lookupOver({ f1: file }))).toEqual(['f1']);
        expect(fileReferenceParts('s1', 'see @file:src/a.ts')).toEqual([{ type: 'resource', uri: 'agentic-session://s1/src/a.ts' }]);
    });

    it('makes a question a text part and a bounded code reference, which reads as a labelled diff block', () => {
        const [text, ref] = questionParts('s1', question);
        expect(text).toEqual({ type: 'text', text: 'Does the drawer keep its focus trap?' });
        expect(ref).toEqual({ type: 'resource', uri: 'agentic-session://s1/packages/ui/src/shell/shell.css#L61', mediaType: 'text/x-diff', text: question.hunk });
        expect(referenceLabel((ref as { uri: string }).uri)).toBe('packages/ui/src/shell/shell.css:61');
        expect(resourceText(ref as Extract<PromptPart, { type: 'resource' }>)).toBe('`packages/ui/src/shell/shell.css:61`\n```diff\n@@ -55,9 +67,11 @@ .drawer\n-  display: flex;\n+  display: var(--drawer-display, flex);\n```');
        // A snippet holding a fence gets a longer one.
        expect(resourceText({ type: 'resource', uri: 'x', text: 'a ``` b' })).toBe('`x`\n````\na ``` b\n````');
        expect(resourceText({ type: 'resource', uri: 'agentic-session://s1/a.ts' })).toBe('`a.ts`');
        expect(codeReferencePart('s1', { ...question, hunk: 'x'.repeat(70_000) }).text!.length).toBe(64 * 1024);
    });

    it('round-trips a mention link', () => {
        const href = mentionHref('c1', 's1', 'src/a b.ts');
        expect(href).toBe('/chats/c1?file=agentic-session%3A%2F%2Fs1%2Fsrc%2Fa%2520b.ts');
        expect(mentionOfQuery(decodeURIComponent(href.split('?file=')[1]!))).toEqual({ sessionId: 's1', path: 'src/a b.ts' });
        expect(mentionOfQuery('https://example.com')).toBeNull();
        expect(mentionOfQuery(undefined)).toBeNull();
    });

    it('links a call to its diff only when its runtime says it wrote a file', () => {
        const edit = { name: 'Edit', input: { file_path: 'C:\\w\\src\\a.ts' } };
        expect(viewDiffLinks('claude-code', 's1', edit)).toEqual([{ label: 'View diff', href: changesHref('s1', { file: 'C:\\w\\src\\a.ts' }) }]);
        expect(viewDiffLinks('claude-code', 's1', { name: 'Read', input: { file_path: 'C:\\w\\src\\a.ts' } })).toEqual([]);
        expect(viewDiffLinks('anthropic-api', 's1', edit)).toEqual([]);
    });

    it('reads a path relative to the session folder, either separator, Windows case-insensitive', () => {
        expect(relativeToRoot('C:\\Dev\\app', 'C:\\Dev\\app\\src\\a.ts')).toBe('src/a.ts');
        expect(relativeToRoot('C:\\Dev\\app', 'c:/dev/APP/src/a.ts')).toBe('src/a.ts');
        expect(relativeToRoot('C:\\Dev\\app\\', 'C:\\Dev\\app')).toBe('');
        expect(relativeToRoot('C:\\Dev\\app', 'C:\\Dev\\app2\\a.ts')).toBeUndefined();
        expect(relativeToRoot('/work/app', '/work/app/src/a.ts')).toBe('src/a.ts');
        expect(relativeToRoot('/work/app', '/work/App/src/a.ts')).toBeUndefined();
        expect(relativeToRoot('/work/app', './src/a.ts')).toBe('src/a.ts');
        expect(relativeToRoot('', '/work/a.ts')).toBeUndefined();
    });
});

describe('asking the session agent (#565)', () => {
    const forge: AgentIdentity = { id: 'a2', name: 'Forge', role: '', hue: 2, environment: { machine: 'alien01', runtime: 'claude-code', account: 'work' }, configVersion: 1 };
    const lookup = lookupOver({ a2: forge });
    const summary: ChatSummary = { seq: 1, members: { a1: { since: 0, historyFrom: 0 }, a2: { since: 0, historyFrom: 0 } }, coordinator: 'a1' as AgentId, sessions: {} };
    const entries: IndexedEntry[] = [{ seq: 1, entry: { t: 'msg', id: 'm1' as MessageId, author: { kind: 'user' }, parts: [{ type: 'text', text: 'make the drawer collapse' }], at: 1, mentions: [] } }];

    it('posts the question with its hunk to the chat, addressed to the session agent alone, and the task reads the hunk', async () => {
        const posted: { parts: readonly PromptPart[]; mentions: readonly AgentId[] }[] = [];
        const contracts: TaskContract[] = [];
        await askInChat(
            {
                get: async () => summary,
                history: async () => ({ entries, next: null }),
                post: async (parts, mentions) => { posted.push({ parts, mentions }); return { messageId: 'm2' as MessageId, activated: mentions }; },
                createTask: async (_id, contract) => { contracts.push(contract); },
                run: async () => undefined,
                newTaskId: () => 't1' as never
            },
            { chatId: 'c1', sessionId: 's1', agentId: 'a2', question, lookup }
        );
        expect(posted).toEqual([{ parts: questionParts('s1', question), mentions: ['a2'] }]);
        expect(contracts).toHaveLength(1);
        expect(contracts[0]!.assignee).toBe('a2');
        expect(contracts[0]!.objective).toBe(`Does the drawer keep its focus trap?\n\n${resourceText(codeReferencePart('s1', question))}`);
    });

    it('refuses an agent that left the chat, posting nothing', async () => {
        let posted = 0;
        await expect(askInChat(
            { get: async () => ({ ...summary, members: { a1: summary.members.a1! } }), history: async () => ({ entries, next: null }), post: async () => { posted++; return { messageId: 'm2' as MessageId, activated: [] }; }, createTask: async () => undefined, run: async () => undefined, newTaskId: () => 't1' as never },
            { chatId: 'c1', sessionId: 's1', agentId: 'a2', question, lookup }
        )).rejects.toThrow('Forge is no longer in this chat');
        expect(posted).toBe(0);
    });

    it('a message of references alone reads as its snippets', () => {
        const c = activationContract('a2' as AgentId, 'c1' as ChatId, 'm2' as MessageId, '', [], lookup, undefined, [codeReferencePart('s1', question)]);
        expect(c.objective).toBe(resourceText(codeReferencePart('s1', question)));
    });
});

describe('the mock workspace end to end (#565)', () => {
    afterEach(() => clearMockChatPosts());

    it('a question asked in Changes lands in the chat with its hunk', async () => {
        const dom = await mountRoute(changesHref('s1', { file: 'packages/ui/src/shell/shell.css' }));
        await until(() => dom.querySelector('button[data-scope="ag-code"][data-part="num"]') !== null, 'the line numbers');
        dom.querySelector<HTMLButtonElement>('button[data-scope="ag-code"][data-part="num"]')!.click();
        await until(() => dom.querySelector('[data-scope="ag-line-composer"][data-part="root"]') !== null, 'the composer');
        const form = dom.querySelector<HTMLFormElement>('[data-scope="ag-line-composer"][data-part="root"]')!;
        const box = form.querySelector('textarea')!;
        box.value = 'Why this line?';
        box.dispatchEvent(new Event('input', { bubbles: true }));
        await tick();
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await until(() => mockChatPosts('c1').length === 1, 'the post');
        const [text, ref] = mockChatPosts('c1')[0]!.parts;
        expect(text).toEqual({ type: 'text', text: 'Why this line?' });
        expect(ref).toMatchObject({ type: 'resource', mediaType: 'text/x-diff' });
        expect((ref as { uri: string }).uri).toMatch(/^agentic-session:\/\/s1\/packages\/ui\/src\/shell\/shell\.css#L\d+$/);

        const chat = await mountRoute('/chats/c1');
        const bodies = all(chat, 'ai-message', 'root').map((m) => m.textContent ?? '');
        const last = bodies[bodies.length - 1]!;
        expect(last).toContain('Why this line?');
        expect(last).toContain('packages/ui/src/shell/shell.css:');
        expect(chat.querySelector('[data-scope="ai-message"] pre code')?.textContent ?? '').toContain('@@ ');
    });

    it('Mention in chat opens the chat with the file in the composer', async () => {
        const dom = await mountRoute(mentionHref('c1', 's1', 'packages/ui/src/shell/shell.css'));
        await until(() => (dom.querySelector('[data-chat-composer] textarea') as HTMLTextAreaElement | null)?.value !== '', 'the insert');
        expect((dom.querySelector('[data-chat-composer] textarea') as HTMLTextAreaElement).value).toBe('@file:packages/ui/src/shell/shell.css ');
    });

    it("the Edit card's View diff opens that file's diff, the absolute path read relative to the folder", async () => {
        const chat = await mountRoute('/chats/c1');
        const links = all(chat, 'ai-tool-call', 'link');
        expect(links.map((l) => l.textContent)).toEqual(['View diff']);
        const href = links[0]!.getAttribute('href')!;
        expect(href).toBe(changesHref('s1', { file: 'C:\\Dev\\agentic\\branches\\47-mobile-drawer\\packages\\ui\\src\\shell\\shell.css' }));
        const dom = await mountRoute(href);
        await until(() => dom.querySelector('[data-scope="ag-changes"][data-part="item"][aria-current]') !== null, 'the file');
        expect(dom.querySelector('[data-scope="ag-changes"][data-part="item"][aria-current] [data-part="name"]')!.textContent).toBe('shell.css');
        expect(filesHref('s1', 'x')).toBe('/sessions/s1/files?path=x');
    });

    it('a link to a file outside the session folder chooses nothing, in either view', async () => {
        const changes = await mountRoute(changesHref('s1', { file: 'C:\\Elsewhere\\shell.css' }));
        await until(() => changes.querySelector('[data-scope="ag-changes"][data-part="item"]') !== null, 'the list');
        await tick();
        expect(changes.querySelector('[data-scope="ag-changes"][data-part="item"][aria-current]')).toBeNull();
        expect(changes.textContent).toContain('Choose a file to see its diff.');
        const files = await mountRoute(filesHref('s1', 'C:\\Elsewhere\\shell.css'));
        await until(() => files.querySelector('[data-scope="ag-file-tree"][data-part="item"]') !== null, 'the tree');
        expect(files.textContent).toContain('Choose a file to read it.');
        expect(files.querySelector('[data-scope="ag-file-header"]')).toBeNull();
    });
});
