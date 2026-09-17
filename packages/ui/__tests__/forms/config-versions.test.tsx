import type { AgentConfigVersion } from '@agentic/core';
import { ConfigVersions } from '@agentic/ui';
import { mount } from './helpers';

const versions: AgentConfigVersion[] = [
    { version: 1, at: Date.UTC(2026, 8, 1), by: 'andy', reason: 'created' },
    { version: 3, at: Date.UTC(2026, 8, 3), by: 'andy', reason: 'tightened limits' },
    { version: 2, at: Date.UTC(2026, 8, 2), by: 'claude', reason: 'added Bash' }
];

describe('ConfigVersions', () => {
    it('lists versions newest first with the current one marked and the rest revertable', () => {
        const reverted: number[] = [];
        const root = mount(<ConfigVersions versions={versions} onRevert={(v) => reverted.push(v)} />);
        expect(root.querySelector('caption')!.textContent).toBe('Configuration versions');
        const rows = [...root.querySelectorAll('tbody tr')];
        expect(rows.map((r) => r.querySelector('td')!.textContent)).toEqual(['v3', 'v2', 'v1']);
        expect(rows[0]!.getAttribute('data-selected')).toBe('');
        expect(rows[0]!.textContent).toContain('current');
        expect(rows[0]!.querySelector('button')).toBeNull();
        expect(rows[1]!.querySelector('time')!.getAttribute('datetime')).toBe('2026-09-02T00:00:00.000Z');

        rows[2]!.querySelector('button')!.click();
        expect(reverted).toEqual([1]);
    });

    it('honours an explicit current version and a time formatter', () => {
        const root = mount(<ConfigVersions versions={versions} current={2} formatAt={(at) => `t${at}`} />);
        const rows = [...root.querySelectorAll('tbody tr')];
        expect(rows[1]!.textContent).toContain('current');
        expect(rows[0]!.querySelector('button')!.textContent).toContain('Revert to v3');
        expect(rows[0]!.querySelector('time')!.textContent).toBe(`t${Date.UTC(2026, 8, 3)}`);
    });

    it('with an action each revert is a real form that posts the version', () => {
        const reverted: number[] = [];
        const root = mount(<ConfigVersions versions={versions} action="/agents/a/revert" onRevert={(v) => reverted.push(v)} />);
        const forms = [...root.querySelectorAll<HTMLFormElement>('form')];
        expect(forms).toHaveLength(2);
        expect(forms[0]!.getAttribute('action')).toBe('/agents/a/revert');
        expect(new FormData(forms[0]!).get('version')).toBe('2');
        forms[0]!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        expect(reverted).toEqual([2]);
    });
});
