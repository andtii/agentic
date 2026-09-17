/**
 * The tool card, one snapshot per `UIToolState` — the seven states
 * `@sigx/ai` collapses a tool's lifecycle onto — plus the card's own rules:
 * the anatomy holds, the status text says the phase, an empty output opens
 * no box, and the approval prompt sits on the card whose call is waiting.
 */
import { describe, it, expect } from 'vitest';
import type { UIToolState } from '@sigx/ai';
import { createTranscript, toolState } from '@sigx/ai-agent';
import type { AgentState, AgentTranscript, Decision, OpenRequest, ToolPartState } from '@sigx/ai-agent/app';
import { expectAnatomy } from '@sigx/zero/testing';
import { ToolCall, aiToolCallAnatomy, aiApprovalAnatomy, toolCallState } from '../src/thread';
import { mount, one, all, buttonNamed, stableHtml } from './helpers';

const tool = (p: Partial<ToolPartState> = {}): ToolPartState => ({ type: 'tool', callId: 'c1', name: 'ToolSearch', status: 'completed', input: { query: 'select:Read' }, ...p });

/** A transcript with one open permission request bound to call `c1`. */
function awaiting(): { transcript: AgentTranscript; request: OpenRequest } {
    const transcript = createTranscript('s1');
    const request: OpenRequest = { requestId: 'r1', kind: 'permission', callId: 'c1', toolName: 'ToolSearch', message: 'Reads the tool list.', seq: 3 };
    transcript.requests[request.requestId] = request;
    return { transcript, request };
}

/**
 * The part that lands in each `UIToolState`, built from the reducer's own
 * vocabulary so the mapping under test is the real one (`toolState` says
 * which UI state a part is in; the card says how it looks).
 */
const PARTS: Record<UIToolState, () => { part: ToolPartState; transcript?: AgentTranscript }> = {
    streaming: () => ({ part: tool({ status: 'streaming', inputText: '{"query":"sel', input: { query: 'sel' }, output: undefined }) }),
    pending: () => ({ part: tool({ status: 'pending', output: undefined }) }),
    awaiting: () => {
        const { transcript } = awaiting();
        return { part: tool({ status: 'pending', requestId: 'r1', output: undefined }), transcript };
    },
    approved: () => ({ part: tool({ status: 'in_progress', output: undefined }) }),
    done: () => ({ part: tool({ output: '[{"id":"INC-41"}]' }) }),
    error: () => ({ part: tool({ status: 'failed', error: 'boom' }) }),
    denied: () => ({ part: tool({ status: 'denied', error: 'The operator denied this call.' }) })
};

describe('a snapshot per UIToolState', () => {
    for (const [state, make] of Object.entries(PARTS) as [UIToolState, (typeof PARTS)[UIToolState]][]) {
        it(`renders the ${state} card`, () => {
            const { part, transcript } = make();
            // The fixture really is in that UI state — otherwise the snapshot
            // would be named after a state it does not show. `approved` is the
            // one the agent reducer never reports: `toolState` collapses an
            // allowed, running call (`in_progress`, no open request) onto
            // `pending`, so the fixture is the running call itself.
            expect(toolState(part)).toBe(state === 'approved' ? 'pending' : state);
            const dom = mount(<ToolCall part={part} transcript={transcript} onRespond={() => {}} />);
            expectAnatomy(dom, aiToolCallAnatomy);
            expect(stableHtml(dom)).toMatchSnapshot();
        });
    }
});

describe('the governed data-state', () => {
    it.each([
        ['streaming', 'loading', 'writing arguments'],
        ['pending', 'loading', 'pending'],
        ['in_progress', 'active', 'running'],
        ['completed', 'complete', 'done'],
        ['failed', 'error', 'error'],
        ['cancelled', 'error', 'cancelled'],
        ['denied', 'closed', 'denied']
    ] as const)('%s → data-state=%s, status "%s"', (status, expected, label) => {
        const dom = mount(<ToolCall part={tool({ status, output: undefined })} />);
        expect(one(dom, 'ai-tool-call', 'root')!.getAttribute('data-state')).toBe(expected);
        expect(one(dom, 'ai-tool-call', 'status')!.textContent).toBe(label);
    });

    it('an open request on a pending call reads as awaiting approval', () => {
        const { transcript } = awaiting();
        const dom = mount(<ToolCall part={tool({ status: 'pending', requestId: 'r1', output: undefined })} transcript={transcript} onRespond={() => {}} />);
        expect(one(dom, 'ai-tool-call', 'root')!.getAttribute('data-state')).toBe('loading');
        expect(one(dom, 'ai-tool-call', 'status')!.textContent).toBe('awaiting approval');
        expect(toolCallState(tool({ status: 'pending' }), { awaiting: true }).label).toBe('awaiting approval');
    });
});

describe('tool output', () => {
    it('opens no <pre> for a call that completed with an EMPTY output — the status says so instead', () => {
        const dom = mount(<ToolCall part={tool({ output: '' })} />);
        expect(one(dom, 'ai-tool-call', 'output')).toBeNull();
        expect(one(dom, 'ai-tool-call', 'status')!.textContent).toBe('done, no output');
    });

    it('says nothing about an output that is absent', () => {
        const dom = mount(<ToolCall part={tool({ status: 'in_progress', output: undefined })} />);
        expect(one(dom, 'ai-tool-call', 'output')).toBeNull();
        expect(one(dom, 'ai-tool-call', 'status')!.textContent).toBe('running');
    });

    it('renders a string output as is and a non-string as JSON, open by default', () => {
        const text = mount(<ToolCall part={tool({ output: 'a\nb' })} />);
        expect(one(text, 'ai-tool-call', 'output')!.querySelector('pre')!.textContent).toBe('a\nb');
        expect(one(text, 'ai-tool-call', 'output')!.getAttribute('data-state')).toBe('open');
        const json = mount(<ToolCall part={tool({ output: [{ id: 'INC-41' }] })} />);
        expect(one(json, 'ai-tool-call', 'output')!.querySelector('pre')!.textContent).toContain('"INC-41"');
    });

    it('folds the input away by default, and opens no input block for a call with no arguments', () => {
        const dom = mount(<ToolCall part={tool()} />);
        expect(one(dom, 'ai-tool-call', 'input')!.getAttribute('data-state')).toBe('closed');
        const bare = mount(<ToolCall part={tool({ input: undefined })} />);
        expect(one(bare, 'ai-tool-call', 'input')).toBeNull();
    });
});

describe('tool error', () => {
    it('opens no element for a blank error, and renders a real one', () => {
        expect(one(mount(<ToolCall part={tool({ status: 'failed', error: '  ' })} />), 'ai-tool-call', 'error')).toBeNull();
        expect(one(mount(<ToolCall part={tool({ status: 'failed', error: 'boom' })} />), 'ai-tool-call', 'error')!.textContent).toBe('boom');
    });
});

describe('the approval prompt on the card', () => {
    it('renders for the call that is waiting, and answers with the chosen scope', () => {
        const { transcript, request } = awaiting();
        const seen: [string, Decision][] = [];
        const dom = mount(<ToolCall part={tool({ status: 'pending', requestId: 'r1', output: undefined })} transcript={transcript} onRespond={(id, d) => seen.push([id, d])} />);
        expectAnatomy(dom, aiApprovalAnatomy);
        expect(one(dom, 'ai-approval', 'description')!.textContent).toBe('Reads the tool list.');
        buttonNamed(dom, 'Allow for session').click();
        expect(seen).toEqual([[request.requestId, { type: 'permission', outcome: 'allow', scope: 'session' }]]);
    });

    it('renders no prompt without a way to respond, and none once the request is resolved', () => {
        const { transcript } = awaiting();
        expect(one(mount(<ToolCall part={tool({ status: 'pending', requestId: 'r1' })} transcript={transcript} />), 'ai-approval', 'root')).toBeNull();
        delete transcript.requests['r1'];
        expect(one(mount(<ToolCall part={tool({ status: 'pending', requestId: 'r1' })} transcript={transcript} onRespond={() => {}} />), 'ai-approval', 'root')).toBeNull();
    });
});

describe('the sub-agent card', () => {
    function withAgent(agent: Partial<AgentState>): { part: ToolPartState; transcript: AgentTranscript } {
        const transcript = createTranscript('s1');
        const full: AgentState = { agentId: 'a1', callId: 'c1', depth: 1, seq: 1, status: 'completed', title: 'Triage', ...agent };
        transcript.agents[full.agentId] = full;
        transcript.messages.push({ id: 'm-sub', role: 'assistant', parentCallId: 'c1', parts: [{ type: 'text', id: 'p1', text: 'looked at INC-41' }] });
        return { part: tool({ agentId: full.agentId }), transcript };
    }

    it('hangs under the spawning call with its status on the governed set, and its work folded once done', () => {
        const { part, transcript } = withAgent({ summary: 'INC-41  first\nthen INC-42' });
        const dom = mount(<ToolCall part={part} transcript={transcript} />);
        const card = one(dom, 'ai-tool-call', 'agent')!;
        expect(card.getAttribute('data-state')).toBe('complete');
        expect(card.textContent).toContain('INC-41 first then INC-42');
        expect(card.querySelector('details')!.open).toBe(false);
        expect(all(dom, 'ai-message', 'root')).toHaveLength(1);
        expectAnatomy(dom, aiToolCallAnatomy);
    });

    it('offers Cancel only while it runs and only when the agent can be controlled', () => {
        const { part, transcript } = withAgent({ status: 'running' });
        const cancelled: string[] = [];
        const dom = mount(<ToolCall part={part} transcript={transcript} onCancelAgent={(id) => cancelled.push(id)} />);
        expect(one(dom, 'ai-tool-call', 'agent')!.getAttribute('data-state')).toBe('active');
        buttonNamed(dom, 'Cancel').click();
        expect(cancelled).toEqual(['a1']);
        const passive = mount(<ToolCall part={part} transcript={transcript} />);
        expect([...passive.querySelectorAll('button')].some((b) => b.textContent === 'Cancel')).toBe(false);
    });
});
