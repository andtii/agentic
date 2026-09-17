import { describe, it, expect } from 'vitest';
import type { Decision, OpenRequest } from '@sigx/ai-agent/app';
import { expectAnatomy } from '@sigx/zero/testing';
import { ApprovalPrompt, DENY_MESSAGE, aiApprovalAnatomy } from '../src/thread';
import { mount, one, buttonNamed } from './helpers';

const request: OpenRequest = { requestId: 'r1', kind: 'permission', toolName: 'Bash', message: 'Runs `git status`.', seq: 1 };

function prompt(): { dom: HTMLDivElement; seen: [string, Decision][] } {
    const seen: [string, Decision][] = [];
    const dom = mount(<ApprovalPrompt request={request} onRespond={(id, d) => seen.push([id, d])} />);
    return { dom, seen };
}

describe('the approval prompt', () => {
    it('names the tool and the reason, and holds the anatomy', () => {
        const { dom } = prompt();
        expect(one(dom, 'ai-approval', 'title')!.textContent).toBe('Allow Bash?');
        expect(one(dom, 'ai-approval', 'description')!.textContent).toBe('Runs `git status`.');
        expectAnatomy(dom, aiApprovalAnatomy);
        // The buttons are zero's: the design system's button recipe paints them.
        expect(dom.querySelectorAll('[data-scope="button"][data-part="root"]')).toHaveLength(4);
    });

    it.each([
        ['Allow once', { type: 'permission', outcome: 'allow', scope: 'once' }],
        ['Allow for session', { type: 'permission', outcome: 'allow', scope: 'session' }],
        ['Deny once', { type: 'permission', outcome: 'deny', scope: 'once', message: DENY_MESSAGE }],
        ['Deny for session', { type: 'permission', outcome: 'deny', scope: 'session', message: DENY_MESSAGE }]
    ] as const)('"%s" responds with the chosen scope', (label, decision) => {
        const { dom, seen } = prompt();
        buttonNamed(dom, label).click();
        expect(seen).toEqual([['r1', decision]]);
    });

    it('opens no description for a request with no message', () => {
        const dom = mount(<ApprovalPrompt request={{ ...request, message: '  ' }} onRespond={() => {}} toolName="Read" />);
        expect(one(dom, 'ai-approval', 'description')).toBeNull();
    });
});
