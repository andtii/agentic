import { describe, it, expect } from 'vitest';
import { loadSession } from '../../src/mock/workspace';
import { topbarFor } from '../../src/components/topbar';
import { mountRoute, page, texts } from './mount';

describe('/sessions/:id (Session)', () => {
    it('renders the header, the activity column and the rail', async () => {
        const dom = await mountRoute('/sessions/s1');
        expect(page(dom, 'session')).not.toBeNull();
        expect(dom.querySelector('[data-session-id]')!.textContent).toBe('Session s_41aa');
        expect(dom.querySelector('[data-session-head] [data-scope="ag-env-line"]')!.textContent).toBe('alien01/claude-code/work');
        expect(dom.querySelector('[data-session-main]')?.getAttribute('aria-label')).toBe('Session activity');
        expect(dom.querySelector('[data-session-rail]')?.getAttribute('aria-label')).toBe('Execution and capabilities');
    });

    it('shows the current tool call, the compact approval and the event log with the lost-events line and amber requests', async () => {
        const dom = await mountRoute('/sessions/s1');
        expect(dom.querySelector('[data-session-main] [data-scope="ai-tool-call"][data-part="root"]')).not.toBeNull();
        const approval = dom.querySelector('[data-session-main] [data-scope="ai-approval"][data-part="root"]')!;
        expect(approval.hasAttribute('data-mod-compact')).toBe(true);
        expect(approval.querySelector('[data-scope="ai-approval"][data-part="context"]')).toBeNull();
        const events = [...dom.querySelectorAll('[data-event]')];
        expect(events).toHaveLength(7);
        expect(events.at(-1)!.getAttribute('data-kind')).toBe('request');
        const log = dom.querySelector('[data-event-log]')!;
        expect(log.textContent).toContain('Events lost between seq 312 and 314');
        expect(log.closest('[data-panel]')!.querySelector('[data-panel-head]')!.textContent).toContain('LIVE');
    });

    it('lists every capability, and renders no control for an unsupported operation (AC-15)', async () => {
        const dom = await mountRoute('/sessions/s1');
        const rows = [...dom.querySelectorAll('[data-capability]')];
        expect(rows.map((r) => r.getAttribute('data-supported'))).toEqual(['true', 'true', 'true', 'true', 'false', 'false']);
        expect(texts([...dom.querySelectorAll('[data-capability][data-supported="false"] [data-capability-label]')])).toEqual(['Usage and cost', 'Live migration to another machine']);
        expect(texts([...dom.querySelectorAll('[data-capability][data-supported="false"] [data-capability-note]')])).toEqual(['not reported by provider', 'not supported']);
        // No usage figure and no migrate control anywhere on the page.
        expect(dom.textContent).not.toMatch(/\$\d/);
        expect(dom.textContent).not.toContain('Migrate');
    });

    it('offers Cancel turn only when the runtime can cancel, and never for a runtime that cannot steer', () => {
        const forge = topbarFor({ name: 'session', path: '/sessions/s1', params: { id: 's1' } });
        expect(forge?.crumb).toBe('s_41aa');
        expect(forge?.actions).toBeTypeOf('function');
        const s3 = loadSession('s3')!;
        expect(s3.capabilities.steer).toBe(false);
        expect(s3.interrupted).toBe(true);
    });

    it('marks an interrupted session with the named failure card and Resume, never auto-replaying', async () => {
        const dom = await mountRoute('/sessions/s3');
        const card = dom.querySelector('[data-scope="empty-state"][data-part="root"][data-failure]')!;
        expect(card.getAttribute('data-failure')).toBe('interrupted');
        expect(card.textContent).toContain('Resume');
        expect(card.textContent).toContain('Nothing was replayed');
    });

    it('lists session grants without a Revoke nobody handles: they end with the session (#154)', async () => {
        const dom = await mountRoute('/sessions/s1');
        expect(texts([...dom.querySelectorAll('[data-grant] > code')])).toEqual(['Bash  pnpm test *', 'Edit  packages/ui/**']);
        expect(dom.querySelectorAll('[data-grant] button')).toHaveLength(0);
        expect(dom.querySelector('[data-grants-note]')!.textContent).toBe('Grants end with the session.');
    });

    it('the design workspace keeps its tool duration', async () => {
        expect(loadSession('s1')!.current?.meta).toBe('3.4s');
        expect((await mountRoute('/sessions/s1')).querySelector('[data-session-main]')!.textContent).toContain('3.4s');
    });
});
