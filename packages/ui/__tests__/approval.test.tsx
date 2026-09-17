/**
 * The approval card (`docs/design/HANDOFF.md` → "Approvals"): the header,
 * the request well, the context rows a `compact` card drops, the three
 * decisions and what each sends, the spinner between click and ack, and
 * the one-line record a decision collapses to.
 */
import { describe, it, expect } from 'vitest';
import type { Decision, OpenRequest } from '@sigx/ai-agent/app';
import { expectAnatomy } from '@sigx/zero/testing';
import { ApprovalPrompt, DENY_MESSAGE, aiApprovalAnatomy, decisionText } from '../src/thread';
import { mount, one, all, buttonNamed, tick } from './helpers';

const request: OpenRequest = { requestId: 'r1', kind: 'permission', toolName: 'Bash', message: 'Runs `git status`.', seq: 1 };

function prompt(): { dom: HTMLDivElement; seen: [string, Decision][] } {
    const seen: [string, Decision][] = [];
    const dom = mount(<ApprovalPrompt request={request} onRespond={(id, d) => seen.push([id, d])} input={{ command: 'git push origin 47-mobile-drawer' }} rule="ask on destructive" />);
    return { dom, seen };
}

const buttons = (root: ParentNode) => [...root.querySelectorAll<HTMLButtonElement>('[data-scope="button"][data-part="root"]')];

describe('the approval card', () => {
    it('says approval is needed, shows the rule, the tool and its input verbatim, and the reason; holds the anatomy', () => {
        const { dom } = prompt();
        expect(one(dom, 'ai-approval', 'title')!.textContent).toBe('Approval needed');
        expect(one(dom, 'ai-approval', 'rule')!.textContent).toBe('rule: ask on destructive');
        expect(one(dom, 'ai-approval', 'request')!.textContent).toBe('Bashcommand: git push origin 47-mobile-drawer');
        expect(one(dom, 'ai-approval', 'description')!.textContent).toBe('Runs `git status`.');
        expect(one(dom, 'ai-approval', 'header')!.querySelector('svg')).not.toBeNull();
        expectAnatomy(dom, aiApprovalAnatomy);
        // Three decisions, painted by the design system's button recipe with the handoff's intents.
        expect(buttons(dom).map((b) => [b.textContent, b.getAttribute('data-intent')])).toEqual([
            ['Allow once', 'wait'],
            ['Allow for this session', 'default'],
            ['Deny', 'danger']
        ]);
    });

    it.each([
        ['Allow once', { type: 'permission', outcome: 'allow', scope: 'once' }],
        ['Allow for this session', { type: 'permission', outcome: 'allow', scope: 'session' }],
        ['Deny', { type: 'permission', outcome: 'deny', scope: 'once', message: DENY_MESSAGE }]
    ] as const)('"%s" responds with the chosen scope', (label, decision) => {
        const { dom, seen } = prompt();
        buttonNamed(dom, label).click();
        expect(seen).toEqual([['r1', decision]]);
    });

    it('disables every button and spins the chosen one between the click and the ack, and sends once', async () => {
        const { dom, seen } = prompt();
        buttonNamed(dom, 'Allow once').click();
        await tick();
        expect(buttons(dom).every((b) => b.disabled)).toBe(true);
        expect(buttonNamed(dom, 'Allow once').getAttribute('aria-busy')).toBe('true');
        expect(buttonNamed(dom, 'Deny').hasAttribute('aria-busy')).toBe(false);
        buttonNamed(dom, 'Deny').click();
        expect(seen).toHaveLength(1);
    });

    it('opens no description for a request with no message, and no rule without one', () => {
        const dom = mount(<ApprovalPrompt request={{ ...request, message: '  ', toolName: undefined }} onRespond={() => {}} toolName="Read" />);
        expect(one(dom, 'ai-approval', 'description')).toBeNull();
        expect(one(dom, 'ai-approval', 'rule')).toBeNull();
        expect(one(dom, 'ai-approval', 'request')!.textContent).toBe('Read');
    });

    it('renders the context rows — requested by, runs on, via — with a 96 px label column, and announces the request assertively', () => {
        const dom = mount(
            <ApprovalPrompt
                request={request}
                onRespond={() => {}}
                requestedBy={{ name: 'Forge', hue: 2 }}
                environment={{ machine: 'alien01', runtime: 'claude-code', account: 'work' }}
                via="delegated by Atlas · task t_8f2c · depth 1"
            />
        );
        const context = one(dom, 'ai-approval', 'context')!;
        expect([...context.querySelectorAll('dt')].map((dt) => dt.textContent)).toEqual(['Requested by', 'Runs on', 'Via']);
        expect(context.querySelector('[data-scope="ag-agent-tile"]')).not.toBeNull();
        expect(context.querySelector('[data-scope="ag-env-line"]')!.textContent).toBe('alien01/claude-code/work');
        expect(context.textContent).toContain('delegated by Atlas');
        const root = one(dom, 'ai-approval', 'root')!;
        expect(root.getAttribute('aria-label')).toBe('Approval needed from Forge: Bash');
        expect(root.getAttribute('aria-live')).toBe('assertive');
        expectAnatomy(dom, aiApprovalAnatomy);
    });

    it('`compact` drops the context rows and carries the modifier', () => {
        const dom = mount(<ApprovalPrompt request={request} onRespond={() => {}} requestedBy={{ name: 'Forge' }} compact />);
        expect(one(dom, 'ai-approval', 'context')).toBeNull();
        expect(one(dom, 'ai-approval', 'root')!.hasAttribute('data-mod-compact')).toBe(true);
        expect(all(dom, 'ai-approval', 'actions')).toHaveLength(1);
    });

    it('collapses to the one-line record once a decision arrives, buttons gone', () => {
        const dom = mount(<ApprovalPrompt request={request} onRespond={() => {}} decision={{ outcome: 'allow', scope: 'session', by: 'Andii', from: 'phone' }} />);
        expect(one(dom, 'ai-approval', 'record')!.textContent).toBe('Allowed for session by Andii from phone');
        expect(one(dom, 'ai-approval', 'actions')).toBeNull();
        expect(one(dom, 'ai-approval', 'title')!.textContent).toBe('Approval');
        expect(one(dom, 'ai-approval', 'root')!.hasAttribute('aria-live')).toBe(false);
        expect(decisionText({ outcome: 'deny', scope: 'once' })).toBe('Denied');
        expect(decisionText({ outcome: 'allow', scope: 'once', by: 'policy' })).toBe('Allowed once by policy');
    });
});
