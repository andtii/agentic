import { Agents, presencePill } from '../../src/pages/Agents';
import { agentProfiles } from '../../src/mock/agents';
import { topbarFor } from '../../src/components/topbar';
import { mountAt, text } from './helpers';

describe('/agents roster', () => {
    it('renders one card link per agent with tile, role, pill, environment and the footer stats', async () => {
        const root = await mountAt('/agents', <Agents />);
        const profiles = agentProfiles();
        const cards = [...root.querySelectorAll<HTMLAnchorElement>('[data-page="agents"] a.agent-card')];
        expect(cards).toHaveLength(profiles.length);
        for (const [i, card] of cards.entries()) {
            const p = profiles[i]!;
            expect(card.getAttribute('href')).toBe(`/agents/${p.id}`);
            expect(text(card.querySelector('[data-agent-card-name]'))).toBe(p.config.name);
            expect(text(card.querySelector('[data-agent-card-role]'))).toBe(p.role);
            expect(card.querySelector('[data-scope="ag-agent-tile"]')?.getAttribute('data-hue')).toBe(String(p.hue));
            expect(text(card.querySelector('[data-scope="ag-pill"] [data-part="label"]'))).toBe(presencePill(p.presence).label ?? p.presence.toUpperCase());
            const stats = [...card.querySelectorAll('[data-agent-card-stats] dd')].map(text);
            expect(stats).toEqual([`v${p.agent.configVersion}`, String(p.memories.length), String(p.correctionsThisWeek)]);
            const dts = [...card.querySelectorAll('[data-agent-card-stats] dt')].map(text);
            expect(dts).toEqual(['config', 'memories', 'corrections / wk']);
        }
        // two equal columns: one list, the grid is CSS; the list is labelled
        expect(root.querySelector('[data-agent-grid]')?.getAttribute('aria-label')).toBe('Agents');
        expect(root.querySelector('[data-page-title]')?.textContent).toBe('Agents');
    });

    it('shows the environment line for agents with one and "No environment" in the warning tone for a claude-code agent without', async () => {
        const root = await mountAt('/agents', <Agents />);
        const withEnv = root.querySelector('[data-agent-card="a2"]')!;
        expect(withEnv.querySelector('[data-scope="ag-env-line"]')).not.toBeNull();
        expect(withEnv.querySelector('[data-scope="ag-env-line"]')?.getAttribute('title')).toBe('andy-desktop / claude-code / work');
        const without = root.querySelector('[data-agent-card="a3"]')!;
        expect(without.querySelector('[data-scope="ag-env-line"]')).toBeNull();
        const noenv = without.querySelector('[data-agent-card-noenv]')!;
        expect(text(noenv)).toBe('No environment');
        expect(noenv.getAttribute('data-tone')).toBe('needs-you');
    });

    it('registers New agent as its topbar action (#91) and has the delegation footer line', async () => {
        const root = await mountAt('/agents', <Agents />);
        // The action lives in the shell's topbar, never in an in-content head row.
        expect([...root.querySelectorAll('button')].find((b) => text(b) === 'New agent')).toBeUndefined();
        const actions = await mountAt('/agents', <div>{topbarFor({ name: 'agents', path: '/agents', params: {} })!.actions!()}</div>);
        const button = [...actions.querySelectorAll('button')].find((b) => text(b) === 'New agent')!;
        expect(button.getAttribute('data-intent')).toBe('primary');
        expect(text(root.querySelector('[data-agent-grid-footer]'))).toContain('Depth 3, concurrency 3');
    });
});
