/** The live chat's pure view model (#34): entries → rows, summaries, composition, addressing, activation, the session wire adapter. */
import { describe, it, expect } from 'vitest';
import type { AccountRef, AgentId, ChatId, MachineId, MessageId, ProjectId, TaskId } from '@agentic/core';
import type { ChatSummary, IndexedEntry } from '@agentic/platform';
import { createTranscript } from '@sigx/ai-agent';
import { WIRE_PROTOCOL_VERSION, type WireFrame, type WireReply } from '@sigx/ai-agent/wire';
import {
    activationContract,
    activationWorkdir,
    actorSessionTransport,
    attachmentPart,
    chatRow,
    chatTitle,
    chatTranscript,
    composeTranscript,
    entryLine,
    entryTranscript,
    identityOf,
    inFlightMessages,
    lookupOver,
    membersOf,
    mentionsIn,
    messageParts,
    runActivation,
    unknownAgent,
    visibleTo,
    type AgentIdentity,
    type SessionActorClient
} from '../../src/pages/chat/live';

const atlas: AgentIdentity = { id: 'a1', name: 'Atlas', role: 'Assistant', hue: 1, environment: { machine: 'platform', runtime: 'anthropic-api', account: 'byo-key' }, configVersion: 3 };
const forge: AgentIdentity = { id: 'a2', name: 'Forge', role: 'Builder', hue: 2, environment: { machine: 'alien01', runtime: 'claude-code', account: 'work' }, configVersion: 1 };
const lookup = lookupOver({ a1: atlas, a2: forge });

const summary: ChatSummary = { seq: 4, members: { a1: { since: 1000, historyFrom: 0 }, a2: { since: 3000, historyFrom: 2 } }, coordinator: 'a1' as AgentId, sessions: { a1: { sessionId: 's9' as never, since: 1000, seenSeq: 0 } } };
const entries: IndexedEntry[] = [
    { seq: 0, entry: { t: 'member', op: 'add', agentId: 'a1' as AgentId, historyAccess: 'all', at: 1000 } },
    { seq: 1, entry: { t: 'msg', id: 'm1' as MessageId, author: { kind: 'user' }, parts: [{ type: 'text', text: 'hi @Atlas' }], at: 2000, mentions: ['a1' as AgentId] } },
    { seq: 2, entry: { t: 'member', op: 'add', agentId: 'a2' as AgentId, historyAccess: 'from-now', at: 3000 } },
    { seq: 3, entry: { t: 'status', agentId: 'a1' as AgentId, kind: 'session-started', ref: 's9', at: 3500 } },
    { seq: 4, entry: { t: 'msg', id: 'm2' as MessageId, author: { kind: 'agent', agentId: 'a1' as AgentId, sessionId: 's9' as never }, parts: [{ type: 'text', text: 'hello' }, { type: 'image', mediaType: 'image/png' }], at: 4000, mentions: [], taskId: 't1' as never } }
];

describe('identities', () => {
    it('folds Agent.get() into an identity with a stable hue and a three-part environment (EXE-06)', () => {
        const view = { id: 'a7' as AgentId, workspaceId: 'u1' as never, configVersion: 2, memoryScope: 'agent:a7' as never, pendingProposals: 0, config: { name: 'Scout', description: 'Researches', role: '', instructions: '', skills: [], tools: [], connectors: [], approvalPolicy: [], memoryPolicy: { scope: 'agent:a7', shared: [], autoLearn: false }, execution: { runtime: 'claude-code', defaultEnvironmentId: 'env_lab', model: undefined, limits: {}, offlinePolicy: 'queue' }, collaborators: 'all' } } as never;
        const id = identityOf(view, 5);
        expect(id).toMatchObject({ id: 'a7', name: 'Scout', role: 'Researches', hue: 2, environment: { machine: 'env_lab', runtime: 'claude-code', account: 'machine' }, configVersion: 2 });
        expect(unknownAgent('zz')).toMatchObject({ name: 'zz', hue: 1 });
        expect(lookup('nobody').name).toBe('nobody');
    });

    it('an account-bound agent reads as its login on any machine (#414); a platform agent never carries an account', () => {
        const config = { name: 'Two', description: '', role: '', instructions: '', skills: [], tools: [], connectors: [], approvalPolicy: [], memoryPolicy: { scope: 'agent:a8', shared: [], autoLearn: false }, execution: { runtime: 'claude-code', account: { identity: 'me@work' } as AccountRef, limits: {}, offlinePolicy: 'queue' }, collaborators: 'all' };
        const viewOf = (c: typeof config) => ({ id: 'a8' as AgentId, workspaceId: 'u1' as never, configVersion: 1, memoryScope: 'agent:a8' as never, pendingProposals: 0, config: c }) as never;
        expect(identityOf(viewOf(config), 0)).toMatchObject({ environment: { machine: 'any machine', runtime: 'claude-code', account: 'me@work' }, account: { identity: 'me@work' } });
        expect(identityOf(viewOf(config), 0)).not.toHaveProperty('environmentId');
        expect(identityOf(viewOf({ ...config, execution: { ...config.execution, account: { label: 'claude-2' } } }), 0).environment.account).toBe('claude-2');
        expect(identityOf(viewOf({ ...config, execution: { runtime: 'anthropic-api', account: { identity: 'x' }, limits: {}, offlinePolicy: 'fail' } }), 0)).not.toHaveProperty('account');
    });
});

describe('members and rows', () => {
    it('reads members with status, coordinator and history access from the summary; a bound session says nothing about work (#398)', () => {
        expect(membersOf(summary)).toEqual([
            { agentId: 'a1', status: 'idle', coordinator: true, history: { access: 'all' } },
            { agentId: 'a2', status: 'idle', history: { access: 'from', at: 3000 } }
        ]);
        expect(membersOf(summary, new Set(), new Set(['a1'])).map((m) => m.status)).toEqual(['active', 'idle']);
        expect(chatTitle(membersOf(summary), lookup)).toBe('Atlas, Forge');
        expect(chatTitle([], lookup)).toBe('New chat');
        // A stored title wins over the members' names (#124); an absent one falls back.
        expect(chatTitle(membersOf(summary), lookup, 'Release plan')).toBe('Release plan');
        expect(chatTitle([], lookup, 'Release plan')).toBe('Release plan');
        expect(chatTitle(membersOf(summary), lookup, undefined)).toBe('Atlas, Forge');
    });

    it('lines every entry kind and builds a list row from the newest entry', () => {
        expect(entries.map((e) => entryLine(e.entry, lookup))).toEqual(['Atlas joined', 'You: hi @Atlas', 'Forge joined', 'Atlas started a session', 'Atlas: hello [image]']);
        expect(entryLine({ t: 'rename', title: 'Release plan', at: 5000 }, lookup)).toBe('Renamed to Release plan');
        expect(chatRow('c1', summary, entries.slice(-1), lookup)).toMatchObject({ id: 'c1', title: 'Atlas, Forge', lastLine: 'Atlas: hello [image]', updatedAt: 4000, unread: 0, waiting: false });
        expect(chatRow('c1', { ...summary, title: 'Release plan' }, entries.slice(-1), lookup).title).toBe('Release plan');
        expect(chatRow('c1', summary, [], lookup).lastLine).toBe('');
    });
});

describe('the transcript', () => {
    it('turns messages and status entries into attributed rows — the session bookkeeping into none (#399), membership into none', () => {
        const ended: IndexedEntry = { seq: 5, entry: { t: 'status', agentId: 'a1' as AgentId, kind: 'session-ended', ref: 's9', at: 4500 } };
        const failed: IndexedEntry = { seq: 6, entry: { t: 'status', agentId: 'a1' as AgentId, kind: 'task-failed', ref: 't1' as TaskId, error: { code: 'turn-error', message: 'boom', recoverable: false }, at: 5000 } };
        const t = entryTranscript([...entries, ended, failed], lookup, 'Andii');
        // A session begins once per member and ends when someone means it to: neither is a row.
        expect(t.messages.map((m) => [m.id, m.role, m.actor ?? m.author])).toEqual([
            ['m1', 'user', 'Andii'],
            ['m2', 'assistant', 'a1'],
            ['status:6', 'assistant', 'a1']
        ]);
        expect(t.messages[1]!.parts.map((p) => (p as { text: string }).text)).toEqual(['hello', '[image]']);
        expect(t.messages[2]!.parts).toEqual([{ type: 'text', id: 'status:6:0', text: '*could not finish: turn-error — boom*' }]);
        expect(t.authors.m1).toMatchObject({ name: 'Andii', person: true, time: { dateTime: new Date(2000).toISOString() } });
        expect(t.authors.m2).toMatchObject({ name: 'Atlas', hue: 1, environment: atlas.environment });
        expect(t.authors['status:3']).toBeUndefined();
        expect(t.authors['status:5']).toBeUndefined();
    });

    it('takes a session’s assistant rows only while it is mid-turn, and composes state and requests in place', () => {
        const session = createTranscript('s9');
        session.state = 'running';
        session.turn = { turnId: 'T1' };
        session.messages.push(
            { id: 'u', role: 'user', turnId: 'T1', parts: [{ type: 'text', id: 'p0', text: 'objective' }] },
            { id: 'x', role: 'assistant', turnId: 'T1', parts: [{ type: 'text', id: 'p1', text: 'thinking…' }] },
            { id: 'old', role: 'assistant', turnId: 'T0', parts: [{ type: 'text', id: 'p2', text: 'earlier' }] }
        );
        session.requests.r1 = { requestId: 'r1', kind: 'permission', seq: 7, toolName: 'Bash' };
        expect(inFlightMessages(session).map((m) => m.id)).toEqual(['x']);
        const target = chatTranscript('chat');
        const authors = composeTranscript(target, entryTranscript(entries, lookup), [{ sessionId: 's9', agentId: 'a1', transcript: session }], lookup);
        expect(target.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'x']);
        expect(target.state).toBe('running');
        expect(Object.keys(target.requests)).toEqual(['r1']);
        expect(authors.x).toMatchObject({ name: 'Atlas', hue: 1 });
        session.state = 'awaiting';
        composeTranscript(target, entryTranscript(entries, lookup), [{ sessionId: 's9', agentId: 'a1', transcript: session }], lookup);
        expect(target.state).toBe('awaiting');
        session.state = 'idle';
        composeTranscript(target, entryTranscript(entries, lookup), [{ sessionId: 's9', agentId: 'a1', transcript: session }], lookup);
        expect(target.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
        expect(target.state).toBe('idle');
    });

    it('a running turn with nothing of its own to show marks no row as streaming — never the reply before it (#606)', () => {
        // A turn the runtime opened on its own after the member's last reply: input-less, no rows yet, maybe never.
        const session = createTranscript('s9');
        session.state = 'running';
        session.turn = { turnId: 'ghost' };
        const target = chatTranscript('chat');
        composeTranscript(target, entryTranscript(entries, lookup), [{ sessionId: 's9', agentId: 'a1', transcript: session }], lookup);
        // The last assistant row is the entry `m2`, a finished reply: the chat is not mid-turn on its account.
        expect(target.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
        expect(target.state).toBe('idle');
        // Once the turn shows something, that row is the one streaming.
        session.messages.push({ id: 'y', role: 'assistant', turnId: 'ghost', parts: [{ type: 'text', id: 'p1', text: 'a background task finished' }] });
        composeTranscript(target, entryTranscript(entries, lookup), [{ sessionId: 's9', agentId: 'a1', transcript: session }], lookup);
        expect(target.messages.at(-1)?.id).toBe('y');
        expect(target.state).toBe('running');
    });
});

describe('addressing and activation', () => {
    it('resolves @mentions by name or id, members only, case-insensitively', () => {
        const members = membersOf(summary);
        expect(mentionsIn('@atlas and @A2, not @scout', members, lookup)).toEqual(['a1', 'a2']);
        expect(mentionsIn('nothing', members, lookup)).toEqual([]);
    });

    it('resolves names with spaces, punctuation and @ as the picker inserts them, longest name first (#279)', () => {
        const people: Record<string, AgentIdentity> = {
            lead: { ...atlas, id: 'lead', name: 'Claude Code (andy@ekdahls.net)' },
            one: { ...atlas, id: 'one', name: 'Claude Code (claude@ekdahls.net)' },
            two: { ...atlas, id: 'two', name: 'Claude Code 2 (claude2@ekdahls.net' },
            short: { ...atlas, id: 'short', name: 'Claude' }
        };
        const find = lookupOver(people);
        const all = Object.keys(people).map((agentId) => ({ agentId, status: 'idle' as const, history: { access: 'all' as const } }));
        // Exactly what the picker inserts ("@" + label + space), then the question.
        expect(mentionsIn('@Claude Code 2 (claude2@ekdahls.net what did you respond?', all, find)).toEqual(['two']);
        expect(mentionsIn('@Claude Code (claude@ekdahls.net) and @claude code 2 (claude2@ekdahls.net, go', all, find)).toEqual(['one', 'two']);
        // A shorter name that is a prefix still resolves on its own, and only at a word end.
        expect(mentionsIn('@Claude please', all, find)).toEqual(['short']);
        expect(mentionsIn('@Claudette hi', all, find)).toEqual([]);
        // The @ inside a matched name is never read as a second mention; an email elsewhere is not a mention.
        expect(mentionsIn('mail andy@ekdahls.net', all, find)).toEqual([]);
        expect(mentionsIn('@two, @LEAD', all, find)).toEqual(['two', 'lead']);
    });

    it('builds the activation contract from what the agent may read (CHT-04)', () => {
        expect(visibleTo(entries, summary, 'a2').map((e) => e.seq)).toEqual([2, 3, 4]);
        expect(visibleTo(entries, summary, 'nobody')).toEqual([]);
        const c = activationContract('a2' as AgentId, 'c1' as ChatId, 'm3' as MessageId, 'do it', visibleTo(entries, summary, 'a2'), lookup);
        expect(c).toEqual({ objective: 'do it', origin: { kind: 'user', chatId: 'c1', messageId: 'm3' }, assignee: 'a2', context: [{ type: 'text', text: 'Chat so far:\nAtlas: hello [image]' }], constraints: {} });
        expect(activationContract('a2' as AgentId, 'c1' as ChatId, 'm3' as MessageId, 'do it', [], lookup).context).toEqual([]);
    });

    it("carries a member's working folder into its task, and shows the folder note by name (#193)", async () => {
        const workdir = { environmentId: 'env_work' as never, path: 'C:\\src\\app' };
        const withFolder: ChatSummary = { ...summary, members: { ...summary.members, a2: { ...summary.members.a2!, workdir } } };
        expect(membersOf(withFolder)[1]).toEqual({ agentId: 'a2', status: 'idle', history: { access: 'from', at: 3000 }, workdir });
        expect(activationContract('a2' as AgentId, 'c1' as ChatId, 'm3' as MessageId, 'do it', [], lookup, workdir)).toMatchObject({ environmentId: 'env_work', workdir: 'C:\\src\\app' });
        const contracts: unknown[] = [];
        await runActivation(
            { post: async () => ({ messageId: 'm9' as MessageId, activated: ['a1' as AgentId, 'a2' as AgentId] }), createTask: async (_id, contract) => { contracts.push(contract); }, run: async () => undefined, newTaskId: () => 't' as never },
            { chatId: 'c1' as ChatId, text: 'go', mentions: [], summary: withFolder, entries, lookup }
        );
        expect(contracts[0]).not.toHaveProperty('workdir');
        expect(contracts[1]).toMatchObject({ environmentId: 'env_work', workdir: 'C:\\src\\app' });
        for (const c of contracts) expect(c).not.toHaveProperty('projectId');

        // The chat's project rides into every task (#333), beside a member's own folder when it has one.
        expect(activationContract('a2' as AgentId, 'c1' as ChatId, 'm3' as MessageId, 'do it', [], lookup, undefined, [], 'p_1' as ProjectId)).toMatchObject({ projectId: 'p_1' });
        expect(activationContract('a2' as AgentId, 'c1' as ChatId, 'm3' as MessageId, 'do it', [], lookup, workdir, [], 'p_1' as ProjectId)).toMatchObject({ projectId: 'p_1', environmentId: 'env_work', workdir: 'C:\\src\\app' });
        const inProject: unknown[] = [];
        await runActivation(
            { post: async () => ({ messageId: 'm9' as MessageId, activated: ['a1' as AgentId, 'a2' as AgentId] }), createTask: async (_id, contract) => { inProject.push(contract); }, run: async () => undefined, newTaskId: () => 't' as never },
            { chatId: 'c1' as ChatId, text: 'go', mentions: [], summary: { ...withFolder, projectId: 'p_1' as ProjectId }, entries, lookup }
        );
        expect(inProject[0]).toMatchObject({ projectId: 'p_1' });
        expect(inProject[0]).not.toHaveProperty('workdir');
        expect(inProject[1]).toMatchObject({ projectId: 'p_1', workdir: 'C:\\src\\app' });
        expect(chatRow('c1', { ...withFolder, projectId: 'p_1' as ProjectId }, [], lookup).projectId).toBe('p_1');
        expect(chatRow('c1', withFolder, [], lookup)).not.toHaveProperty('projectId');

        // The chat's machine rides into every task (#414); a member's folder on an environment that machine does not report is left out.
        const pc = 'machine_pc' as MachineId;
        expect(activationContract('a2' as AgentId, 'c1' as ChatId, 'm3' as MessageId, 'do it', [], lookup, workdir, [], undefined, pc)).toMatchObject({ machineId: pc, environmentId: 'env_work', workdir: 'C:\\src\\app' });
        expect(activationWorkdir(withFolder.members.a2, pc, (m, e) => m === pc && e === 'env_work')).toEqual(workdir);
        expect(activationWorkdir(withFolder.members.a2, pc, () => false)).toBeUndefined();
        expect(activationWorkdir(withFolder.members.a2, undefined, () => false)).toEqual(workdir);
        expect(activationWorkdir(withFolder.members.a2, pc)).toEqual(workdir);
        const onMachine: unknown[] = [];
        await runActivation(
            { post: async () => ({ messageId: 'm9' as MessageId, activated: ['a1' as AgentId, 'a2' as AgentId] }), createTask: async (_id, contract) => { onMachine.push(contract); }, run: async () => undefined, newTaskId: () => 't' as never },
            { chatId: 'c1' as ChatId, text: 'go', mentions: [], summary: { ...withFolder, machineId: pc }, entries, lookup, hosted: () => false }
        );
        expect(onMachine[0]).toMatchObject({ machineId: pc });
        expect(onMachine[1]).toMatchObject({ machineId: pc });
        expect(onMachine[1]).not.toHaveProperty('workdir');
        expect(onMachine[1]).not.toHaveProperty('environmentId');

        const note = { seq: 5, entry: { t: 'msg', id: 'm5' as MessageId, author: { kind: 'user' }, parts: [{ type: 'text', text: 'Working folder for a2 → C:\\src\\app on env_work' }], at: 5000, mentions: [], workdir: { agentId: 'a2' as AgentId, ref: workdir } } } as IndexedEntry;
        const cleared = { seq: 6, entry: { ...note.entry, id: 'm6', workdir: { agentId: 'a2', ref: null } } } as IndexedEntry;
        expect(entryLine(note.entry, lookup)).toBe('Forge now works in C:\\src\\app (env_work)');
        expect(entryLine(cleared.entry, lookup)).toBe("Forge's working folder was cleared");
        const t = entryTranscript([note, cleared], lookup, 'Andii');
        expect(t.messages.map((m) => (m.parts[0] as { text: string }).text)).toEqual(['*Forge now works in C:\\src\\app (env_work)*', "*Forge's working folder was cleared*"]);
        expect(t.authors.m5).toMatchObject({ name: 'Andii', person: true });
    });

    it('posts first, then one task per activated agent, each handed to the router', async () => {
        const calls: string[] = [];
        let n = 0;
        const result = await runActivation(
            {
                post: async (parts, mentions) => {
                    calls.push(`post ${parts.map((p) => (p.type === 'text' ? p.text : p.type)).join('+')} [${mentions.join(',')}]`);
                    return { messageId: 'm9' as MessageId, activated: ['a1', 'a2'] as AgentId[] };
                },
                createTask: async (id, contract, owner) => calls.push(`create ${id} ${contract.assignee} by ${owner} origin ${contract.origin.kind}`),
                run: async (id) => calls.push(`run ${id}`),
                newTaskId: () => `t${++n}` as never
            },
            { chatId: 'c1' as ChatId, text: 'go', mentions: ['a2' as AgentId], summary, entries, lookup }
        );
        expect(result).toEqual({ messageId: 'm9', tasks: [{ agentId: 'a1', taskId: 't1' }, { agentId: 'a2', taskId: 't2' }] });
        expect(calls).toEqual(['post go [a2]', 'create t1 a1 by a1 origin user', 'run t1', 'create t2 a2 by a2 origin user', 'run t2']);
    });
});

describe('attachments (#207)', () => {
    const shot = 'agentic-file:c1/file_shot';
    const csv = 'agentic-file:c1/file_csv';
    const withFiles: IndexedEntry[] = [
        { seq: 0, entry: { t: 'member', op: 'add', agentId: 'a1' as AgentId, historyAccess: 'all', at: 1000 } },
        { seq: 1, entry: { t: 'msg', id: 'm1' as MessageId, author: { kind: 'user' }, parts: [{ type: 'text', text: 'see' }, { type: 'image', mediaType: 'image/png', url: shot }, { type: 'file', mediaType: 'text/csv', name: 'data.csv', url: csv }], at: 2000, mentions: [] } },
        { seq: 2, entry: { t: 'msg', id: 'm2' as MessageId, author: { kind: 'agent', agentId: 'a1' as AgentId, sessionId: 's9' as never }, parts: [{ type: 'text', text: 'again' }, { type: 'image', mediaType: 'image/png', url: shot }, { type: 'image', mediaType: 'image/png', data: 'iVBO' }], at: 3000, mentions: [] } }
    ];
    const allSummary: ChatSummary = { seq: 2, members: { a1: { since: 1000, historyFrom: 0 } }, coordinator: null, sessions: {} };

    it('entryLine renders attachments as named placeholders with their uri', () => {
        expect(entryLine(withFiles[1]!.entry, lookup)).toBe(`You: see [image ${shot}] [file "data.csv" ${csv}]`);
        // An inline image has no uri to name.
        expect(entryLine(withFiles[2]!.entry, lookup)).toBe(`Atlas: again [image ${shot}] [image]`);
    });

    it('entryTranscript keeps image and file parts and points chat files at the download route', () => {
        const t = entryTranscript(withFiles, lookup);
        expect(t.messages[0]!.parts).toEqual([
            { type: 'text', id: 'm1:0', text: 'see' },
            { type: 'image', mediaType: 'image/png', url: '/files/chats/c1/file_shot' },
            { type: 'file', mediaType: 'text/csv', url: '/files/chats/c1/file_csv', filename: 'data.csv' }
        ]);
        expect(t.messages[1]!.parts[2]).toEqual({ type: 'image', mediaType: 'image/png', data: 'iVBO' });
        // A url that is not a chat file is never loaded: it reads as its placeholder.
        const external: IndexedEntry = { seq: 3, entry: { t: 'msg', id: 'm3' as MessageId, author: { kind: 'user' }, parts: [{ type: 'image', mediaType: 'image/png', url: 'https://tracker.example/p.png' }], at: 4000, mentions: [] } };
        expect(entryTranscript([external], lookup).messages[0]!.parts).toEqual([{ type: 'text', id: 'm3:0', text: '[image https://tracker.example/p.png]' }]);
    });

    it('activationContract carries the chat-file parts of the context window and the trigger as reference parts, each once', () => {
        const trigger = [attachmentPart({ name: 'new.png', mediaType: 'image/png' }, 'agentic-file:c1/file_new'), attachmentPart({ name: 'data.csv', mediaType: 'text/csv' }, csv)];
        const c = activationContract('a1' as AgentId, 'c1' as ChatId, 'm4' as MessageId, 'what changed?', visibleTo(withFiles, allSummary, 'a1'), lookup, undefined, trigger);
        expect(c.objective).toBe('what changed?');
        expect(c.context).toEqual([
            { type: 'text', text: `Chat so far:\nYou: see [image ${shot}] [file "data.csv" ${csv}]\nAtlas: again [image ${shot}] [image]` },
            { type: 'image', mediaType: 'image/png', url: shot },
            { type: 'file', mediaType: 'text/csv', name: 'data.csv', url: csv },
            { type: 'image', mediaType: 'image/png', url: 'agentic-file:c1/file_new' }
        ]);
        // Attachments alone: the objective is their placeholders, never empty.
        expect(activationContract('a1' as AgentId, 'c1' as ChatId, 'm4' as MessageId, '', [], lookup, undefined, trigger.slice(0, 1)).objective).toBe('[image agentic-file:c1/file_new]');
    });

    it('runActivation posts the text then the attachments, and hands them to every task', async () => {
        const posted: unknown[] = [];
        const contracts: unknown[] = [];
        const part = attachmentPart({ name: 'data.csv', mediaType: 'text/csv' }, csv);
        await runActivation(
            {
                post: async (parts) => (posted.push(parts), { messageId: 'm9' as MessageId, activated: ['a1'] as AgentId[] }),
                createTask: async (_id, contract) => contracts.push(contract.context),
                run: async () => undefined,
                newTaskId: () => 't1' as never
            },
            { chatId: 'c1' as ChatId, text: '', attachments: [part], mentions: [], summary: allSummary, entries: [], lookup }
        );
        expect(posted).toEqual([[part]]);
        expect(contracts).toEqual([[part]]);
        expect(messageParts('hi', [part])).toEqual([{ type: 'text', text: 'hi' }, part]);
    });
});

describe('the session wire over the actor', () => {
    it('sends commands as the actor’s methods, treats a daemon’s pending as an ack, and streams a hello then the tail', async () => {
        const sent: string[] = [];
        const reply = (commandId: string): WireReply => ({ v: WIRE_PROTOCOL_VERSION, kind: 'ack', commandId });
        const client: SessionActorClient = {
            get: async () => ({ key: 'u1:session:s1', opened: true, spec: { agentId: 'a1' as AgentId, runtime: 'anthropic-api', config: {} as never }, status: 'running', head: { epoch: 1, seq: 2 }, openRequests: [], eventCount: 2, pages: 0, transcriptPages: 0, corrections: [], grants: [] }),
            prompt: async (input, turnId, _output, commandId) => (sent.push(`prompt ${turnId} ${commandId} ${JSON.stringify(input)}`), reply(commandId!)),
            respond: async (requestId, decision, commandId) => (sent.push(`respond ${requestId} ${(decision as { outcome: string }).outcome} ${commandId}`), { v: 1, kind: 'pending' as const, commandId: commandId! }),
            cancel: async (agentId, commandId) => (sent.push(`cancel ${agentId ?? '-'} ${commandId}`), reply(commandId!)),
            configure: async (patch, commandId) => (sent.push(`configure ${JSON.stringify(patch)} ${commandId}`), reply(commandId!)),
            close: async (commandId) => (sent.push(`close ${commandId}`), reply(commandId!)),
            tail: (from) => ({
                async *[Symbol.asyncIterator]() {
                    sent.push(`tail ${JSON.stringify(from)}`);
                    yield { type: 'turn-start', turnId: 'T', input: [], sessionId: 's1', epoch: 1, seq: 1 } as never;
                    yield { type: 'state', value: 'running', sessionId: 's1', epoch: 1, seq: 2 } as never;
                }
            })
        };
        const t = actorSessionTransport(client, 's1');
        expect(await t.send({ v: WIRE_PROTOCOL_VERSION, commandId: 'c1', type: 'prompt', turnId: 'T', input: [{ type: 'text', text: 'hi' }] })).toEqual(reply('c1'));
        expect(await t.send({ v: WIRE_PROTOCOL_VERSION, commandId: 'c2', type: 'respond', requestId: 'r1', decision: { type: 'permission', outcome: 'allow', scope: 'once' } })).toEqual(reply('c2'));
        expect(await t.send({ v: WIRE_PROTOCOL_VERSION, commandId: 'c3', type: 'cancel' })).toEqual(reply('c3'));
        expect(await t.send({ v: WIRE_PROTOCOL_VERSION, commandId: 'c4', type: 'close' })).toEqual(reply('c4'));
        const frames: WireFrame[] = [];
        for await (const f of t.events({ epoch: 0, seq: 0 })) frames.push(f);
        expect(frames.map((f) => f.kind)).toEqual(['hello', 'event', 'event']);
        expect(frames[0]).toMatchObject({ kind: 'hello', agentId: 'a1', sessionId: 's1', sessionRef: { agent: 'a1', v: 1, id: 's1' }, head: { epoch: 1, seq: 2 } });
        expect(frames[2]).toMatchObject({ kind: 'event', epoch: 1, seq: 2, event: { type: 'state', value: 'running' } });
        expect(sent).toEqual(['prompt T c1 [{"type":"text","text":"hi"}]', 'respond r1 allow c2', 'cancel - c3', 'close c4', 'tail {"epoch":0,"seq":0}']);
    });
});
