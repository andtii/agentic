/**
 * The question card: an input request answered in the shape its runtime
 * reads. A form (Claude Code's `AskUserQuestion`: one property per question,
 * `q1`, `q2`, …) answers with an object keyed by property — a bare string
 * reaches the CLI as "The user did not answer the questions." A request
 * without a form (the platform's `ask_user`) answers with the text. The card
 * sits on the tool call that asked, and a loose one at the end of the thread.
 */
import { describe, it, expect } from 'vitest';
import { component, signal } from '@sigx/runtime-core';
import { createTranscript } from '@sigx/ai-agent';
import type { Decision, OpenRequest, ToolPartState } from '@sigx/ai-agent/app';
import { expectAnatomy } from '@sigx/zero/testing';
import { QuestionPrompt, Thread, ToolCall, aiQuestionAnatomy, answerText, questionAnswers, questionFields, looseRequests } from '../src/thread';
import { mount, one, all, buttonNamed, tick } from './helpers';

/** What the claude-code adapter raises for `AskUserQuestion` with two questions, the second multi-select. */
const form: OpenRequest = {
    requestId: 'req_1',
    kind: 'input',
    callId: 'toolu_1',
    toolName: 'AskUserQuestion',
    message: 'Focus: What kind of improvement?\nScope: Which sizes?',
    options: [
        { id: 'q1:Clear the open bugs', label: 'Clear the open bugs', description: 'Work the phase-3 bugs.' },
        { id: 'q1:Land the demos', label: 'Land the demos', description: 'Drive #35 and #38.' },
        { id: 'q2:small', label: 'small' },
        { id: 'q2:large', label: 'large' }
    ],
    schema: {
        type: 'object',
        properties: {
            q1: { type: 'string', anyOf: [{ enum: ['Clear the open bugs', 'Land the demos'] }, { type: 'string' }], title: 'Focus', description: 'What kind of improvement?' },
            q2: { type: 'array', title: 'Scope', description: 'Which sizes?', items: { type: 'string', anyOf: [{ enum: ['small', 'large'] }, { type: 'string' }] } }
        },
        required: ['q1', 'q2'],
        additionalProperties: false
    },
    seq: 7
};

/** The platform's `ask_user`: a message and choices, no form. */
const plain: OpenRequest = { requestId: 'ask:c1', kind: 'input', callId: 'c1', toolName: 'ask_user', message: 'Tea or coffee?', options: [{ id: 'tea', label: 'tea' }, { id: 'coffee', label: 'coffee' }], seq: 3 };

function card(request: OpenRequest): { dom: HTMLDivElement; seen: [string, Decision][] } {
    const seen: [string, Decision][] = [];
    const dom = mount(<QuestionPrompt request={request} onRespond={(id, d) => seen.push([id, d])} requestedBy={{ name: 'Ada' }} />);
    return { dom, seen };
}

const typeInto = (el: HTMLTextAreaElement, value: string): void => {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
};

const option = (root: ParentNode, label: string): HTMLButtonElement => {
    const b = all(root, 'ai-question', 'option').find((el) => el.querySelector('strong')?.textContent === label);
    if (!b) throw new Error(`no option "${label}"`);
    return b as HTMLButtonElement;
};

describe('questionFields', () => {
    it('reads one question per form property: its header, its question, its choices with their descriptions, multi-select from an array', () => {
        expect(questionFields(form)).toEqual([
            { key: 'q1', label: 'Focus', prompt: 'What kind of improvement?', choices: [{ label: 'Clear the open bugs', hint: 'Work the phase-3 bugs.' }, { label: 'Land the demos', hint: 'Drive #35 and #38.' }], multi: false },
            { key: 'q2', label: 'Scope', prompt: 'Which sizes?', choices: [{ label: 'small' }, { label: 'large' }], multi: true }
        ]);
    });

    it('reads a request without a form as one question: its message and its options', () => {
        expect(questionFields(plain)).toEqual([{ prompt: 'Tea or coffee?', choices: [{ label: 'tea' }, { label: 'coffee' }], multi: false }]);
    });
});

describe('questionAnswers', () => {
    const fields = questionFields(form);

    it('keys a form\'s answers by property — a choice, free text over a choice, a multi-select as a list with the text joined', () => {
        expect(questionAnswers(fields, [['Land the demos'], ['small']], ['', ''])).toEqual({ q1: 'Land the demos', q2: ['small'] });
        expect(questionAnswers(fields, [['Land the demos'], ['small', 'large']], ['attachments first', 'tiny'])).toEqual({ q1: 'attachments first', q2: ['small', 'large', 'tiny'] });
    });

    it('leaves an unanswered question out, and is undefined while nothing is answered', () => {
        expect(questionAnswers(fields, [[], []], ['only this', ''])).toEqual({ q1: 'only this' });
        expect(questionAnswers(fields, [[], []], [' ', ''])).toBeUndefined();
    });

    it('answers a request without a form with the text itself', () => {
        const one = questionFields(plain);
        expect(questionAnswers(one, [['tea']], [''])).toBe('tea');
        expect(questionAnswers(one, [['tea']], ['green tea'])).toBe('green tea');
    });

    it('reads an answer back in one line', () => {
        expect(answerText({ q1: 'Land the demos', q2: ['small', 'large'] })).toBe('Land the demos · small, large');
        expect(answerText('tea')).toBe('tea');
    });
});

describe('the question card', () => {
    it('shows who asks, each question with its header, its choices and an answer box; holds the anatomy', () => {
        const { dom } = card(form);
        expectAnatomy(dom, aiQuestionAnatomy);
        expect(one(dom, 'ai-question', 'title')!.textContent).toBe('Ada asks');
        expect(all(dom, 'ai-question', 'label').map((el) => el.textContent)).toEqual(['Focus', 'Scope']);
        expect(all(dom, 'ai-question', 'prompt').map((el) => el.textContent)).toEqual(['What kind of improvement?', 'Which sizes?']);
        expect(all(dom, 'ai-question', 'option').map((el) => el.querySelector('strong')!.textContent)).toEqual(['Clear the open bugs', 'Land the demos', 'small', 'large']);
        expect(all(dom, 'ai-question', 'hint').map((el) => el.textContent)).toEqual(['Work the phase-3 bugs.', 'Drive #35 and #38.']);
        expect(all(dom, 'ai-question', 'other')).toHaveLength(2);
        expect(buttonNamed(dom, 'Answer').disabled).toBe(true);
    });

    it('a single choice toggles like a radio, a multi-select like checkboxes', async () => {
        const { dom } = card(form);
        option(dom, 'Clear the open bugs').click();
        await tick();
        option(dom, 'Land the demos').click();
        await tick();
        expect(option(dom, 'Clear the open bugs').getAttribute('data-state')).toBe('off');
        expect(option(dom, 'Land the demos').getAttribute('data-state')).toBe('on');
        option(dom, 'small').click();
        await tick();
        option(dom, 'large').click();
        await tick();
        expect(['small', 'large'].map((l) => option(dom, l).getAttribute('aria-checked'))).toEqual(['true', 'true']);
    });

    it('answers a form keyed by question — never a bare string the runtime would drop', async () => {
        const { dom, seen } = card(form);
        option(dom, 'Land the demos').click();
        await tick();
        typeInto(all(dom, 'ai-question', 'other')[1] as HTMLTextAreaElement, 'medium');
        await tick();
        buttonNamed(dom, 'Answer').click();
        expect(seen).toEqual([['req_1', { type: 'input', answers: { q1: 'Land the demos', q2: ['medium'] } }]]);
    });

    it('answers a request without a form with the typed text', async () => {
        const { dom, seen } = card(plain);
        typeInto(one(dom, 'ai-question', 'other') as HTMLTextAreaElement, 'I cannot attach files');
        await tick();
        buttonNamed(dom, 'Answer').click();
        expect(seen).toEqual([['ask:c1', { type: 'input', answers: 'I cannot attach files' }]]);
    });

    it('disables between the click and the ack, sends once, and says why when the answer did not get through', async () => {
        let reject: (e: Error) => void = () => undefined;
        const calls: Decision[] = [];
        const dom = mount(<QuestionPrompt request={plain} onRespond={(_, d) => { calls.push(d); return new Promise((_r, j) => { reject = j; }); }} />);
        option(dom, 'tea').click();
        await tick();
        buttonNamed(dom, 'Answer').click();
        await tick();
        expect(buttonNamed(dom, 'Answer').getAttribute('aria-busy')).toBe('true');
        buttonNamed(dom, 'Answer').click();
        expect(calls).toHaveLength(1);
        reject(new Error('session is closed'));
        await tick();
        await tick();
        expect(one(dom, 'ai-question', 'error')!.textContent).toBe('Could not answer: session is closed');
        expect(buttonNamed(dom, 'Answer').disabled).toBe(false);
    });

    it('collapses to the record once the answer is known, whichever client gave it', async () => {
        const st = signal({ answered: undefined as unknown });
        const Card = component(() => () => <QuestionPrompt request={form} answered={st.answered} onRespond={() => undefined} />);
        const dom = mount(<Card />);
        expect(all(dom, 'ai-question', 'question')).toHaveLength(2);
        st.answered = { q1: 'Clear the open bugs', q2: ['small'] };
        await tick();
        expect(all(dom, 'ai-question', 'question')).toHaveLength(0);
        expect(one(dom, 'ai-question', 'record')!.textContent).toBe('Answered: Clear the open bugs · small');
    });
});

describe('the question card in the thread', () => {
    const askPart = (): ToolPartState => ({ type: 'tool', callId: 'toolu_1', name: 'AskUserQuestion', status: 'pending', input: { questions: [] }, requestId: 'req_1' });

    it('sits on the tool call that asked, and answers through the thread\'s respond', async () => {
        const transcript = createTranscript('s1');
        transcript.requests[form.requestId] = form;
        const seen: [string, Decision][] = [];
        const dom = mount(<ToolCall part={askPart()} transcript={transcript} onRespond={(id, d) => seen.push([id, d])} />);
        expect(one(dom, 'ai-question', 'root')).not.toBeNull();
        expect(one(dom, 'ai-approval', 'root')).toBeNull();
        option(dom, 'Clear the open bugs').click();
        await tick();
        buttonNamed(dom, 'Answer').click();
        expect(seen).toEqual([['req_1', { type: 'input', answers: { q1: 'Clear the open bugs' } }]]);
    });

    it('renders none without a way to respond, and none once the request is resolved', () => {
        const transcript = createTranscript('s1');
        transcript.requests[form.requestId] = form;
        expect(one(mount(<ToolCall part={askPart()} transcript={transcript} />), 'ai-question', 'root')).toBeNull();
        delete transcript.requests[form.requestId];
        expect(one(mount(<ToolCall part={askPart()} transcript={transcript} onRespond={() => {}} />), 'ai-question', 'root')).toBeNull();
    });

    it('an input request with no call of its own is a loose card at the end of the thread', () => {
        const transcript = createTranscript('s1');
        const loose: OpenRequest = { requestId: 'r_loose', kind: 'input', message: 'Which colour?', seq: 2 };
        transcript.requests[loose.requestId] = loose;
        expect(looseRequests(transcript)).toEqual([loose]);
        const dom = mount(<Thread transcript={transcript} onRespond={() => {}} />);
        expect(one(dom, 'ai-question', 'prompt')!.textContent).toBe('Which colour?');
    });
});
