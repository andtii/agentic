import { AGENT_FIELDS as F } from '@agentic/ui';
import { Agent } from '../../src/pages/Agent';
import { applyLine } from '../../src/pages/agent/ConfigTab';
import { agentProfile } from '../../src/mock/agents';
import { mountAt, setText, text, tick } from './helpers';

const configPage = () => mountAt('/agents/a2?tab=config', <Agent />);

describe('/agents/:id config tab', () => {
    it('renders the header, the four tabs, and lands on Config from ?tab=', async () => {
        const root = await configPage();
        expect(root.querySelector('[data-page="agent"]')?.getAttribute('data-agent')).toBe('a2');
        expect(text(root.querySelector('[data-agent-name]'))).toBe('Builder');
        expect(root.querySelector('[data-agent-header] [data-scope="avatar"][data-part="root"]')?.getAttribute('data-tile')).toBe('52');
        expect(root.querySelector('[data-agent-header] [data-scope="ag-env-line"]')?.getAttribute('title')).toBe('andy-desktop / claude-code / work');
        expect(text(root.querySelector('[data-agent-header] [data-scope="badge"][data-part="root"]'))).toBe('ACTIVE');
        const tabs = [...root.querySelectorAll('[role="tab"]')].map(text);
        expect(tabs).toEqual(['Overview', 'Config', 'Memory', 'Sessions']);
        const selected = root.querySelector('[role="tab"][aria-selected="true"]');
        expect(text(selected)).toBe('Config');
        expect(root.querySelector('[data-agent-config] form[data-form="agent"]')).not.toBeNull();
    });

    it('renders the form sections in the handoff order, each with a title-and-hint column beside its controls', async () => {
        const root = await configPage();
        const sections = [...root.querySelectorAll('form[data-layout="sections"] [data-part="section"]')];
        expect(sections.map((s) => s.getAttribute('data-section'))).toEqual(['identity', 'capabilities', 'approval', 'memory', 'execution', 'collaboration']);
        for (const s of sections) {
            expect(s.querySelector('[data-part="section-heading"]')).not.toBeNull();
            expect(text(s.querySelector('[data-part="section-hint"]'))).not.toBe('');
            expect(s.querySelector('[data-part="section-body"]')).not.toBeNull();
            // the legend still names the fieldset for assistive tech, hidden visually
            expect(s.querySelector('legend')?.hasAttribute('data-visually-hidden')).toBe(true);
        }
        // the default Save section is not rendered: the rail owns saving
        expect(root.querySelector('[data-section="save"]')).toBeNull();
        // approval policy as a segmented control per category, posting through the group's own hidden select
        const rows = [...root.querySelectorAll('[data-part="policy-row"]')];
        expect(rows).toHaveLength(5);
        const read = rows[0]!;
        expect(text(read.querySelector('[data-part="policy-label"] > span'))).toBe('Read');
        expect(read.querySelector('[aria-pressed="true"]')?.textContent).toBe('allow');
        expect(read.querySelector<HTMLSelectElement>(`select[name="${F.approval('read')}"]`)?.value).toBe('allow');
        const destructive = rows[4]!;
        expect(destructive.querySelector('[aria-pressed="true"]')?.textContent).toBe('ask');
        expect(destructive.querySelector('[aria-pressed="true"]')?.getAttribute('data-tone')).toBe('needs-you');
    });

    it('shows the save card only after an edit, and states how many active sessions keep the old version', async () => {
        const root = await configPage();
        expect(root.querySelector('[data-save-card]')).toBeNull();
        expect(text(root.querySelector('[data-apply-line]'))).toBe('Changes apply to new sessions. 1 active session keeps v11.');

        setText(root.querySelector<HTMLInputElement>(`input[name="${F.name}"]`)!, 'Builder 2');
        await tick();
        const card = root.querySelector('[data-save-card]');
        expect(card).not.toBeNull();
        expect(text(card!.querySelector('[data-save-title]'))).toBe('Unsaved changes');
        const save = [...card!.querySelectorAll('button')].find((b) => text(b).startsWith('Save as'))!;
        expect(text(save)).toBe('Save as v12');
        expect(save.getAttribute('type')).toBe('submit');
        // the reason field lives in the rail and still posts with the form
        const reason = card!.querySelector<HTMLInputElement>(`input[name="${F.reason}"]`)!;
        expect(reason.closest('form')).toBe(root.querySelector('form[data-form="agent"]'));

        // Reset clears the dirty state and the card
        [...card!.querySelectorAll('button')].find((b) => text(b) === 'Reset')!.click();
        await tick();
        expect(root.querySelector('[data-save-card]')).toBeNull();
        expect(root.querySelector<HTMLInputElement>(`input[name="${F.name}"]`)!.value).toBe('Builder');
    });

    it('saving with a reason creates the next version at the top of the rail', async () => {
        const root = await configPage();
        setText(root.querySelector<HTMLInputElement>(`input[name="${F.name}"]`)!, 'Builder 2');
        await tick();
        setText(root.querySelector<HTMLInputElement>(`input[name="${F.reason}"]`)!, 'Renamed');
        root.querySelector('form[data-form="agent"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await tick();
        const items = [...root.querySelectorAll('[data-versions-list] [data-scope="ag-version"][data-part="root"]')];
        // the new current version is v12 (the learning proposal keeps its own number until reviewed)
        const currentItem = items.find((li) => li.hasAttribute('data-mod-current'))!;
        expect(currentItem.getAttribute('data-version')).toBe('12');
        expect(text(currentItem.querySelector('[data-part="reason"]'))).toBe('Renamed');
        expect(root.querySelector('[data-save-card]')).toBeNull();
    });

    it('renders the versions rail with the three variants: proposed, current, past', async () => {
        const root = await configPage();
        const p = agentProfile('a2')!;
        const items = [...root.querySelectorAll('[data-versions-list] [data-scope="ag-version"][data-part="root"]')];
        expect(items).toHaveLength(p.versions.length + 1);
        const proposed = items[0]!;
        expect(proposed.getAttribute('data-version')).toBe('12');
        expect(proposed.getAttribute('data-tone')).toBe('needs-you');
        expect(text(proposed.querySelector('[data-scope="badge"][data-part="root"]'))).toBe('NEEDS REVIEW');
        expect([...proposed.querySelectorAll('button')].map(text)).toEqual(['Review', 'Dismiss']);
        const current = items[1]!;
        expect(current.hasAttribute('data-mod-current')).toBe(true);
        expect(text(current.querySelector('[data-scope="badge"][data-part="root"]'))).toBe('CURRENT');
        expect(current.querySelector('button')).toBeNull();
        const past = items[2]!;
        expect([...past.querySelectorAll('button')].map(text)).toEqual(['Roll back to v10']);

        // dismissing the proposal removes it
        [...proposed.querySelectorAll('button')].find((b) => text(b) === 'Dismiss')!.click();
        await tick();
        expect(root.querySelectorAll('[data-versions-list] [data-scope="ag-version"][data-part="root"]')).toHaveLength(p.versions.length);
    });

    it('every control on the config form has a visible label', async () => {
        const root = await configPage();
        const controls = [...root.querySelectorAll<HTMLElement>('form[data-form="agent"] input:not([type="hidden"]), form[data-form="agent"] textarea, form[data-form="agent"] select:not([data-part="hidden-input"]), form[data-form="agent"] [data-scope="select"][data-part="trigger"], form[data-form="agent"] [role="group"][aria-label]')];
        expect(controls.length).toBeGreaterThan(15);
        for (const el of controls) {
            const own = el.getAttribute('aria-label');
            const by = el.getAttribute('aria-labelledby');
            const forLabel = el.id ? root.querySelector(`label[for="${el.id}"]`) : null;
            const wrapped = el.closest('label');
            expect(!!(own || by || forLabel || wrapped), `${el.tagName} name=${el.getAttribute('name')} has a label`).toBe(true);
        }
    });

    it('applyLine states the AGT-07 rule', () => {
        expect(applyLine(0, 4)).toBe('Changes apply to new sessions.');
        expect(applyLine(1, 7)).toBe('Changes apply to new sessions. 1 active session keeps v7.');
        expect(applyLine(3, 7)).toBe('Changes apply to new sessions. 3 active sessions keep v7.');
    });
});
