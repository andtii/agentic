/**
 * "Needs you" over a `NeedsSource` (#40, OPS-02, CHT-09): two lists over one
 * source are two clients of the same record — an answer in one settles the
 * other; the card collapses to the decision another client made; a failed
 * answer says so and stays open; an input row answers through the same
 * `respond`; the live source's row mapping.
 */
import { describe, expect, it } from 'vitest';
import { component, signal } from 'sigx';
import type { SessionId } from '@agentic/core';
import type { InboxNotification, SessionRequestView } from '@agentic/platform';
import { ApprovalPrompt, type ApprovalDecision } from '@agentic/ui';
import { decisionOf, hrefOf, memoryNeedsSource, mockNeedsSource, NeedsYou, openRequestOf, rowOf, sortRows, type NeedsRow, type RequestView } from '../../src/pages/inbox';
import { buttonNamed, mountAt, setText, text, tick } from './helpers';

const S1 = 's_1' as SessionId;

const permissionView = (requestId = 'r_1'): SessionRequestView => ({
    sessionId: S1,
    agentId: 'agent_forge' as SessionRequestView['agentId'],
    chatId: 'c_1' as SessionRequestView['chatId'],
    rule: 'ask on destructive',
    request: { type: 'request', requestId, kind: 'permission', callId: 'call_1', toolName: 'Bash', message: 'git push', permissionKey: 'Bash:git push', sessionId: S1, epoch: 1, seq: 7 },
    input: { command: 'git push' },
    category: 'destructive'
});

const inputView = (requestId = 'r_2'): SessionRequestView => ({
    sessionId: S1,
    agentId: 'agent_scout' as SessionRequestView['agentId'],
    taskId: 't_2' as SessionRequestView['taskId'],
    request: { type: 'request', requestId, kind: 'input', message: 'Which one?', sessionId: S1, epoch: 1, seq: 9 }
});

const rows: NeedsRow[] = [
    { id: 'n_2', kind: 'input', title: 'Scout needs input', at: 2_000, ref: { sessionId: S1, requestId: 'r_2' } },
    { id: 'n_1', kind: 'approval', title: 'Forge asks for approval: Bash', at: 1_000, ref: { sessionId: S1, requestId: 'r_1' }, context: 'delegated by Atlas' }
];
const requests = (): Record<string, RequestView> => ({
    r_1: { view: permissionView(), requestedBy: { name: 'Forge', hue: 2 }, via: 'delegated by Atlas · task t_1 · depth 1' },
    r_2: { view: inputView(), requestedBy: { name: 'Scout', hue: 4 } }
});

const cards = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('[data-scope="ai-approval"][data-part="root"]')];
const items = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('[data-scope="ag-needs-item"][data-part="root"]')];

describe('Needs you: one record, many clients', () => {
    it('answering from a second tab resolves the request in the first: one decision, the row leaves both lists', async () => {
        const source = memoryNeedsSource({ rows, requests: requests(), now: () => 5_000 });
        const a = await mountAt('/', <NeedsYou source={source} />);
        const b = await mountAt('/', <NeedsYou source={source} />);
        expect(items(a).map((el) => el.getAttribute('data-kind'))).toEqual(['approval', 'input']);
        expect(items(b)).toHaveLength(2);
        expect(cards(a)).toHaveLength(1);
        expect(cards(a)[0]!.textContent).toContain('ask on destructive');
        expect(cards(a)[0]!.textContent).toContain('delegated by Atlas · task t_1 · depth 1');

        // Tab B decides; tab A never touched its buttons.
        buttonNamed(cards(b)[0]!, 'Allow once').click();
        await tick();
        await tick();
        expect(source.decisions).toEqual([{ ref: { sessionId: S1, requestId: 'r_1' }, decision: { type: 'permission', outcome: 'allow', scope: 'once' } }]);
        expect(cards(a)).toHaveLength(0);
        expect(cards(b)).toHaveLength(0);
        expect(items(a).map((el) => el.getAttribute('data-kind'))).toEqual(['input']);
        expect(items(b).map((el) => el.getAttribute('data-kind'))).toEqual(['input']);
        // The record itself carries the decision, whoever reads it next.
        expect(source.useRequest({ sessionId: S1, requestId: 'r_1' })().value?.view.resolved).toMatchObject({ outcome: 'allow', scope: 'once', by: 'client' });
    });

    it('"Allow for this session" answers with session scope, "Deny" with the operator message', async () => {
        const source = memoryNeedsSource({ rows, requests: requests() });
        const dom = await mountAt('/', <NeedsYou source={source} />);
        // The session answer carries its full name as the accessible name beside the phone's short label (#91).
        cards(dom)[0]!.querySelector<HTMLButtonElement>('button[aria-label="Allow for this session"]')!.click();
        await tick();
        await tick();
        expect(source.decisions.at(-1)?.decision).toEqual({ type: 'permission', outcome: 'allow', scope: 'session' });

        const denied = memoryNeedsSource({ rows, requests: requests() });
        const dom2 = await mountAt('/', <NeedsYou source={denied} />);
        buttonNamed(cards(dom2)[0]!, 'Deny').click();
        await tick();
        await tick();
        expect(denied.decisions.at(-1)?.decision).toMatchObject({ type: 'permission', outcome: 'deny', scope: 'once', message: expect.stringContaining('denied') });
    });

    it('a decision another client made collapses the card to its record', async () => {
        const st = signal({ decision: undefined as ApprovalDecision | undefined });
        const Card = component(() => () => <ApprovalPrompt request={openRequestOf(permissionView())} rule="ask on destructive" decision={st.decision} onRespond={() => undefined} />);
        const dom = await mountAt('/', <Card />);
        expect(dom.querySelectorAll('button')).toHaveLength(3);
        st.decision = decisionOf({ ...permissionView(), resolved: { type: 'request-resolved', requestId: 'r_1', outcome: 'allow', scope: 'session', by: 'client', at: 1, sessionId: S1, epoch: 1, seq: 8 } }, 'phone');
        await tick();
        expect(dom.querySelectorAll('button')).toHaveLength(0);
        expect(text(dom.querySelector('[data-scope="ai-approval"][data-part="record"]'))).toBe('Allowed for session by you from phone');
    });

    it('an answer that does not get through re-enables the card and says why; the row stays', async () => {
        const source = memoryNeedsSource({ rows, requests: requests(), onRespond: () => Promise.reject(new Error('session is closed')) });
        const dom = await mountAt('/', <NeedsYou source={source} />);
        buttonNamed(cards(dom)[0]!, 'Allow once').click();
        await tick();
        await tick();
        expect(source.decisions).toEqual([]);
        expect(cards(dom)).toHaveLength(1);
        expect(text(dom.querySelector('[data-scope="ai-approval"] [role="alert"]'))).toBe('Could not answer: session is closed');
        expect(buttonNamed(cards(dom)[0]!, 'Allow once').disabled).toBe(false);
    });

    it('an input row answers through the same respond, and leaves the list once answered', async () => {
        const source = memoryNeedsSource({ rows, requests: requests() });
        const dom = await mountAt('/', <NeedsYou source={source} />);
        const input = items(dom).find((el) => el.getAttribute('data-kind') === 'input')!;
        expect(text(input.querySelector('[data-needs-question]'))).toBe('Which one?');
        const answer = buttonNamed(input, 'Answer');
        expect(answer.disabled).toBe(true);
        setText(input.querySelector('textarea')!, 'the first');
        await tick();
        expect(buttonNamed(input, 'Answer').disabled).toBe(false);
        buttonNamed(input, 'Answer').click();
        await tick();
        await tick();
        expect(source.decisions).toEqual([{ ref: { sessionId: S1, requestId: 'r_2' }, decision: { type: 'input', answers: 'the first' } }]);
        expect(items(dom).map((el) => el.getAttribute('data-kind'))).toEqual(['approval']);
    });

    it('links each row to its chat, else its task, else its session', () => {
        expect(hrefOf(rows[1]!, permissionView())).toEqual({ to: '/chats/c_1', label: 'Open chat' });
        expect(hrefOf(rows[0]!, inputView())).toEqual({ to: '/tasks/t_2', label: 'Open task' });
        expect(hrefOf({ id: 'x', kind: 'approval', title: 'x', at: 0, ref: { sessionId: S1, requestId: 'r' } })).toEqual({ to: '/sessions/s_1', label: 'Open session' });
        expect(hrefOf({ id: 'x', kind: 'interrupted', title: 'x', at: 0, href: '/sessions/s_3', hrefLabel: 'Open session' })).toEqual({ to: '/sessions/s_3', label: 'Open session' });
    });
});

describe('the live source rows and the mock', () => {
    const notification = (over: Partial<InboxNotification>): InboxNotification => ({ id: 'n_1', kind: 'approval', title: 'x asks', at: 1, read: false, deliveries: [], ref: { kind: 'session', sessionId: S1, requestId: 'r_1' }, ...over });

    it('maps unread approval / input notifications with a session request ref, nothing else', () => {
        expect(rowOf(notification({ body: 'git push' }))).toEqual({ id: 'n_1', kind: 'approval', title: 'x asks', at: 1, ref: { sessionId: S1, requestId: 'r_1' }, context: 'git push' });
        expect(rowOf(notification({ kind: 'input' }))?.kind).toBe('input');
        expect(rowOf(notification({ read: true }))).toBeNull();
        expect(rowOf(notification({ kind: 'reminder' }))).toBeNull();
        expect(rowOf(notification({ ref: { kind: 'task', taskId: 't_1' as never } }))).toBeNull();
        expect(rowOf(notification({ ref: { kind: 'session', sessionId: S1 } }))).toBeNull();
    });

    it('sorts approvals first, then input, then interrupted, oldest first inside each kind', () => {
        const sorted = sortRows([
            { id: 'a', kind: 'interrupted', title: '', at: 1 },
            { id: 'b', kind: 'approval', title: '', at: 9 },
            { id: 'c', kind: 'input', title: '', at: 5 },
            { id: 'd', kind: 'approval', title: '', at: 3 }
        ]);
        expect(sorted.map((r) => r.id)).toEqual(['d', 'b', 'c', 'a']);
    });

    it('the mock workspace is the design track’s three items, answerable in memory', async () => {
        const source = mockNeedsSource();
        const dom = await mountAt('/', <NeedsYou source={source} />);
        expect(items(dom).map((el) => el.getAttribute('data-kind'))).toEqual(['approval', 'input', 'interrupted']);
        expect(cards(dom)[0]!.textContent).toContain('ask on destructive');
        expect([...dom.querySelectorAll('a[data-scope="button"]')].map((a) => a.textContent?.trim())).toEqual(['Open chat', 'Open task', 'Open session']);
        buttonNamed(cards(dom)[0]!, 'Allow once').click();
        await tick();
        await tick();
        expect(items(dom).map((el) => el.getAttribute('data-kind'))).toEqual(['input', 'interrupted']);
    });
});
