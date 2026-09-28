/**
 * `/sessions/:id?call=<callId>` on mock data (#1056): the page opens at one tool call — its row in the log
 * highlighted, its input and whole output shown unclipped — including a call past the log's tail, and says so
 * when the session holds no such call.
 */
import { describe, it, expect } from 'vitest';
import { callHref, callRowId, refHref } from '../../src/pages/session/call';
import { mountRoute } from './mount';

describe('the step link (#1056)', () => {
    it('builds the Session href from a call, and from a step’s `output.ref`', () => {
        expect(callHref('s1', 'c_test')).toBe('/sessions/s1?call=c_test');
        expect(callHref('s 1', 'c/1')).toBe('/sessions/s%201?call=c%2F1');
        expect(refHref('s1#c_test')).toBe('/sessions/s1?call=c_test');
        expect(refHref('s1#c#2')).toBe('/sessions/s1?call=c%232');
        expect(refHref('s1')).toBeUndefined();
        expect(refHref('#c1')).toBeUndefined();
        expect(refHref('s1#')).toBeUndefined();
        expect(callRowId('c_test')).toBe('call-c_test');
    });
});

describe('/sessions/:id?call= (mock)', () => {
    it('a call in the log: its rows carry the call, the first one its id and the highlight; the step shows input and output raw', async () => {
        const dom = await mountRoute('/sessions/s1?call=c_test');
        const focus = dom.querySelector('[data-call-focus]')!;
        expect(focus.getAttribute('data-status')).toBe('found');
        expect(focus.querySelector('[data-scope="ai-tool-call"][data-part="root"]')).not.toBeNull();
        expect(focus.querySelector('[data-call-input] pre')!.textContent).toContain('"command": "pnpm test packages/ui"');
        expect(focus.querySelector('[data-call-output] pre')!.textContent).toBe('42 passed · 0 failed · 3.1s');
        const row = dom.querySelector(`#${callRowId('c_test')}`)!;
        expect(row.getAttribute('data-kind')).toBe('tool-call');
        expect(row.hasAttribute('data-focus')).toBe(true);
        // Both of the call's rows are highlighted; only the first carries the id.
        expect(dom.querySelectorAll('[data-event][data-focus]')).toHaveLength(2);
        expect(dom.querySelectorAll('[data-event][data-call="c_edit"]:not([data-focus])')).toHaveLength(2);
        // Every row with a time shows it.
        expect([...dom.querySelectorAll('[data-event] [data-event-at] time')]).toHaveLength(7);
    });

    it('a call past the tail: no row in the log, the whole output unclipped', async () => {
        const dom = await mountRoute('/sessions/s1?call=c_build');
        const focus = dom.querySelector('[data-call-focus]')!;
        expect(focus.getAttribute('data-status')).toBe('found');
        expect(dom.querySelector(`#${callRowId('c_build')}`)).toBeNull();
        const out = focus.querySelector('[data-call-output] pre')!.textContent!;
        expect(out.split('\n')).toHaveLength(240);
        expect(out).toContain('build line 240');
    });

    it('a missing call says the session no longer holds it; no link, no focus', async () => {
        const dom = await mountRoute('/sessions/s1?call=c_gone');
        const focus = dom.querySelector('[data-call-focus]')!;
        expect(focus.getAttribute('data-status')).toBe('missing');
        expect(focus.querySelector('[data-call-missing]')!.textContent).toContain('no longer holds call c_gone');
        expect(dom.querySelectorAll('[data-event][data-focus]')).toHaveLength(0);
        // No `?call=`, no step panel.
        const plain = await mountRoute('/sessions/s1');
        expect(plain.querySelector('[data-call-focus]')).toBeNull();
    });
});
