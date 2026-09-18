/** The live chat's pure view model (#34): entries → rows, summaries, composition, addressing, activation, the session wire adapter. */
import { describe, it, expect } from 'vitest';
import type { AgentId, ChatId, MessageId } from '@agentic/core';
import type { ChatSummary, IndexedEntry } from '@agentic/platform';
import { createTranscript } from '@sigx/ai-agent';
import { WIRE_PROTOCOL_VERSION, type WireFrame, type WireReply } from '@sigx/ai-agent/wire';
import {
    activationContract,
    actorSessionTransport,
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
    runActivation,
    unknownAgent,
    visibleTo,
    type AgentIdentity,
    type SessionActorClient
} from '../../src/pages/chat/live';

const atlas: AgentIdentity = { id: 'a1', name: 'Atlas', role: 'Assistant', hue: 1, environment: { machine: 'platform', runtime: 'anthropic-api', account: 'byo-key' }, configVersion: 3 };
const forge: AgentIdentity = { id: 'a2', name: 'Forge', role: 'Builder', hue: 2, environment: { machine: 'alien01', runtime: 'claude-code', account: 'work' }, configVersion: 1 };
const lookup = lookupOver({ a1: atlas, a2: forge });

const summary: ChatSummary = { seq: 4, members: { a1: { since: 1000, historyFrom: 0 }, a2: { since: 3000, historyFrom: 2 } }, coordinator: 'a1' as AgentId, activeSessions: { a1: 's9' as never } };
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
});

describe('members and rows', () => {
    it('reads members with status, coordinator and history access from the summary', () => {
        expect(membersOf(summary)).toEqual([
            { agentId: 'a1', status: 'active', coordinator: true, history: { access: 'all' } },
            { agentId: 'a2', status: 'idle', history: { access: 'from', at: 3000 } }
        ]);
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
    it('turns messages and status entries into attributed rows, membership into none', () => {
        const t = entryTranscript(entries, lookup, 'Andii');
        expect(t.messages.map((m) => [m.id, m.role, m.actor ?? m.author])).toEqual([
            ['m1', 'user', 'Andii'],
            ['status:3', 'assistant', 'a1'],
            ['m2', 'assistant', 'a1']
        ]);
        expect(t.messages[1]!.parts).toEqual([{ type: 'text', id: 'status:3:0', text: '*started a session*' }]);
        expect(t.messages[2]!.parts.map((p) => (p as { text: string }).text)).toEqual(['hello', '[image]']);
        expect(t.authors.m1).toMatchObject({ name: 'Andii', person: true, time: { dateTime: new Date(2000).toISOString() } });
        expect(t.authors.m2).toMatchObject({ name: 'Atlas', hue: 1, environment: atlas.environment });
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
        expect(target.messages.map((m) => m.id)).toEqual(['m1', 'status:3', 'm2', 'x']);
        expect(target.state).toBe('running');
        expect(Object.keys(target.requests)).toEqual(['r1']);
        expect(authors.x).toMatchObject({ name: 'Atlas', hue: 1 });
        session.state = 'awaiting';
        composeTranscript(target, entryTranscript(entries, lookup), [{ sessionId: 's9', agentId: 'a1', transcript: session }], lookup);
        expect(target.state).toBe('awaiting');
        session.state = 'idle';
        composeTranscript(target, entryTranscript(entries, lookup), [{ sessionId: 's9', agentId: 'a1', transcript: session }], lookup);
        expect(target.messages.map((m) => m.id)).toEqual(['m1', 'status:3', 'm2']);
        expect(target.state).toBe('idle');
    });
});

describe('addressing and activation', () => {
    it('resolves @mentions by name or id, members only, case-insensitively', () => {
        const members = membersOf(summary);
        expect(mentionsIn('@atlas and @A2, not @scout', members, lookup)).toEqual(['a1', 'a2']);
        expect(mentionsIn('nothing', members, lookup)).toEqual([]);
    });

    it('builds the activation contract from what the agent may read (CHT-04)', () => {
        expect(visibleTo(entries, summary, 'a2').map((e) => e.seq)).toEqual([2, 3, 4]);
        expect(visibleTo(entries, summary, 'nobody')).toEqual([]);
        const c = activationContract('a2' as AgentId, 'c1' as ChatId, 'm3' as MessageId, 'do it', visibleTo(entries, summary, 'a2'), lookup);
        expect(c).toEqual({ objective: 'do it', origin: { kind: 'user', chatId: 'c1', messageId: 'm3' }, assignee: 'a2', context: [{ type: 'text', text: 'Chat so far:\nAtlas: hello [image]' }], constraints: {} });
        expect(activationContract('a2' as AgentId, 'c1' as ChatId, 'm3' as MessageId, 'do it', [], lookup).context).toEqual([]);
    });

    it('posts first, then one task per activated agent, each handed to the router', async () => {
        const calls: string[] = [];
        let n = 0;
        const result = await runActivation(
            {
                post: async (text, mentions) => {
                    calls.push(`post ${text} [${mentions.join(',')}]`);
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

describe('the session wire over the actor', () => {
    it('sends commands as the actor’s methods, treats a daemon’s pending as an ack, and streams a hello then the tail', async () => {
        const sent: string[] = [];
        const reply = (commandId: string): WireReply => ({ v: WIRE_PROTOCOL_VERSION, kind: 'ack', commandId });
        const client: SessionActorClient = {
            get: async () => ({ key: 'u1:session:s1', opened: true, spec: { agentId: 'a1' as AgentId, runtime: 'anthropic-api', config: {} as never }, status: 'running', head: { epoch: 1, seq: 2 }, openRequests: [], eventCount: 2, corrections: [], grants: [] }),
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
