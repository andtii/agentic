/**
 * The operations routes on mock data (#90): each page renders the
 * handoff's structure, and the behaviours the artboards cannot show —
 * EXE-12 on Machines, the code expiring on Pair, the offline policy line
 * and the DST footer on Schedules, the dependents dialog on Plugins, the
 * hidden push column on Settings, day grouping on History, and `n/a` for
 * unreported cost on Usage (OPS-07).
 */
import { HistoryView, HISTORY_COLS, filterHistory } from '../../src/pages/History';
import { Machine } from '../../src/pages/Machine';
import { MachinesView as MachinesList } from '../../src/pages/Machines';
import { CODE_LIFETIME, PairView } from '../../src/pages/Pair';
import { PluginPageView } from '../../src/pages/Plugin';
import { PluginsView } from '../../src/pages/Plugins';
import { LAST_RUNTIME_WARNING, workspaceWideConsequence } from '../../src/pages/plugins/model';
import { SCHEDULES_COLS, SchedulesView } from '../../src/pages/Schedules';
import { SettingsView } from '../../src/pages/Settings';
import { USAGE_COLS, UsageView } from '../../src/pages/Usage';
import { SESSIONS_COLS } from '../../src/pages/machines/SessionsTable';
import { dstRule, opsHistory, opsMachines, opsPluginDependents, opsPlugins, opsSchedules, opsSettings, pairing, usageRows, money } from '../../src/mock/ops';
import { groupByDay } from '../../src/pages/ops/format';
import { buttonNamed, colWidths, mountAt, setText, tick } from './helpers';
import { mountRoute, texts } from './mount';

const offlineMachine = opsMachines.find(m => !m.online)!;

describe('/machines', () => {
    it('renders one group per machine, the platform row, and the EXE-12 line under the offline machine', async () => {
        const root = await mountAt('/machines', <MachinesList machines={opsMachines} />);
        expect(root.querySelector('[data-page="machines"]')).not.toBeNull();
        const groups = [...root.querySelectorAll('[data-machine-group]:not([data-platform])')];
        expect(groups.map(g => g.getAttribute('aria-label'))).toEqual(opsMachines.map(m => m.name));
        expect(root.querySelector('[data-machine-group][data-platform] [data-machine-name]')!.textContent).toBe('platform');
        // Five environment cards for alien01 — three Claude Code accounts, one Copilot CLI, one Codex.
        expect(groups[0]!.querySelectorAll('[data-scope="ag-env-card"][data-part="root"]').length).toBe(5);
        // The offline machine with queued work says the work stays put.
        const offline = root.querySelector(`[data-machine-group][aria-label="${offlineMachine.name}"]`)!;
        expect(offline.querySelector('[data-machine-queued]')!.textContent).toContain('will not move to another account or machine by itself');
        expect(groups[0]!.querySelector('[data-machine-queued]')).toBeNull();
        expect(root.querySelector('[data-scope="ag-empty"]')).toBeNull();
    });

    it('each environment card carries its account\'s limits (#270)', async () => {
        const root = await mountAt('/machines', <MachinesList machines={opsMachines} />);
        const work = root.querySelector('[data-scope="ag-env-card"][data-part="root"][aria-label="work"]')!;
        expect(work.querySelector('[data-scope="ag-env-card"][data-part="quota"] [data-window="seven_day"] [data-part="used"]')!.textContent).toBe('76% used');
    });

    it('with no machine shows the platform row plus the dashed "Pair a machine" card', async () => {
        const root = await mountAt('/machines', <MachinesList machines={[]} />);
        expect(root.querySelector('[data-machine-group][data-platform]')).not.toBeNull();
        const empty = root.querySelector('[data-scope="ag-empty"][data-part="root"]')!;
        expect(empty.getAttribute('data-empty')).toBe('machines');
        expect(empty.hasAttribute('data-mod-outline')).toBe(true);
    });
});

describe('/machines/:id', () => {
    it('renders environments, the sessions table with its template, the doctor checklist and the revoke card', async () => {
        const root = await mountAt('/machines/alien01', <Machine />);
        expect(root.querySelector('[data-page="machine"]')).not.toBeNull();
        expect(root.querySelector('[data-machine-name]')!.textContent).toBe('alien01');
        expect(root.querySelectorAll('[data-scope="ag-env-card"][data-part="root"]').length).toBe(5);
        const table = root.querySelector('.ag-sessions')!;
        expect(colWidths(table)).toEqual(SESSIONS_COLS.split(' ').map(t => (t.endsWith('fr') ? 'auto' : t)));
        expect(table.querySelectorAll('tbody tr').length).toBe(2);
        // The fixture's daemon reports its load (#400): the caption, an over-limit session in amber, the alert, the cards.
        expect(root.querySelector('[data-machine-hero] [data-machine-load]')!.textContent).toBe('CPU 34\u00a0% · 23 GB of 34 GB in use');
        expect([...table.querySelectorAll('[data-session-load="memory"]')].map((c) => [c.textContent, c.getAttribute('data-tone')])).toEqual([
            ['2.6 GB', 'warning'],
            ['430 MB', null]
        ]);
        expect(root.querySelector('[data-machine-pressure]')!.textContent).toContain("Forge's session s_41aa and what it started hold 2.6 GB");
        expect([...root.querySelectorAll('[data-scope="ag-env-card"][data-part="load"]')].map((c) => c.textContent)).toEqual(['CPU 21\u00a0% · 2.6 GB', 'CPU 3\u00a0% · 430 MB', 'idle', 'load unknown', 'CPU 0\u00a0% · 101 MB']);
        expect(root.querySelectorAll('[data-doctor-check]').length).toBe(4);
        expect(root.querySelectorAll('[data-doctor-check][data-ok]').length).toBe(3);
        // The revoke card says disconnected, not failed.
        expect(root.querySelector('[data-card][data-tone="failed"]')!.textContent).toContain('disconnected, not failed');
        buttonNamed(root, 'Revoke alien01').click();
        await tick();
        // The open one: the page's other dialogs (#239) stay in the DOM closed.
        const popup = root.querySelector('[data-scope="dialog"][data-part="popup"][data-state="open"]')!;
        expect(popup.getAttribute('role')).toBe('alertdialog');
        expect(popup.textContent).toContain('disconnected, not failed');
        expect(buttonNamed(popup, 'Revoke and disconnect 2 sessions')).toBeTruthy();
    });

    it('shows the not-found card for an unknown id', async () => {
        const root = await mountAt('/machines/nope', <Machine />);
        expect(root.querySelector('[data-scope="ag-empty"]')!.textContent).toContain('No machine with id nope');
    });
});

describe('/pair', () => {
    it('renders six code cells and the countdown while the code is live', async () => {
        const root = await mountAt('/pair', <PairView code={pairing.code} expiresIn={521} install={pairing.install} grants={pairing.grants} />);
        expect(root.querySelector('h1[data-page-title]')!.hasAttribute('data-visually-hidden')).toBe(false);
        const cells = [...root.querySelectorAll('[data-code-cell]')];
        expect(cells.map(c => c.textContent).join('')).toBe(pairing.code);
        expect(root.querySelector('[data-code-cells]')!.hasAttribute('data-expired')).toBe(false);
        expect(root.querySelector('[data-code-status]')!.textContent).toContain('Waiting for the daemon');
        expect(root.querySelector('[data-code-status]')!.textContent).toContain('08:41');
        expect(root.querySelectorAll('[data-pair-step]').length).toBe(3);
    });

    it('at zero dims the cells and swaps the waiting line for "New code", which restarts at 10:00', async () => {
        const root = await mountAt('/pair', <PairView code={pairing.code} expiresIn={0} install={pairing.install} grants={pairing.grants} />);
        expect(root.querySelector('[data-code-cells]')!.hasAttribute('data-expired')).toBe(true);
        expect(root.querySelector('[data-code-status]')!.textContent).not.toContain('Waiting for the daemon');
        buttonNamed(root, 'New code').click();
        await tick();
        expect(root.querySelector('[data-code-cells]')!.hasAttribute('data-expired')).toBe(false);
        expect(root.querySelector('[data-code-status]')!.textContent).toContain(`${String(Math.floor(CODE_LIFETIME / 60)).padStart(2, '0')}:00`);
    });
});

describe('/schedules', () => {
    it('renders the template, the policy line under the offline-bound row only, and the DST footer', async () => {
        const root = await mountAt('/schedules', <SchedulesView schedules={opsSchedules} dstRule={dstRule} />);
        const table = root.querySelector('.ag-schedules')!;
        expect(colWidths(table)).toEqual(SCHEDULES_COLS.split(' ').map(t => (t.endsWith('fr') ? 'auto' : t)));
        const rows = [...table.querySelectorAll('tbody tr')];
        expect(rows.length).toBe(opsSchedules.length);
        const withPolicy = rows.filter(r => r.querySelector('[data-policy-line]'));
        expect(withPolicy.length).toBe(1);
        expect(withPolicy[0]!.getAttribute('data-schedule')).toBe('sch_3');
        expect(withPolicy[0]!.querySelector('[data-policy-line]')!.textContent).toBe('nuc-lab is offline · policy: queue until it returns');
        // The paused row prints "paused" as its next run and its switch is off.
        const paused = rows.find(r => r.getAttribute('data-schedule') === 'sch_4')!;
        expect(paused.textContent).toContain('paused');
        expect(paused.querySelector<HTMLInputElement>('input[role="switch"]')!.checked).toBe(false);
        expect(rows[0]!.querySelector<HTMLInputElement>('input[role="switch"]')!.checked).toBe(true);
        expect(root.querySelector('[data-foot-note]')!.textContent).toContain('Across daylight saving');
        expect(root.querySelector('[data-foot-note]')!.textContent).toContain('Europe/Stockholm');
    });
});

describe('/plugins', () => {
    const card = (root: ParentNode, id: string): HTMLElement => root.querySelector<HTMLElement>(`[data-scope="ag-plugin-card"][data-part="root"][data-plugin="${id}"]`)!;
    const readinessOf = (el: ParentNode): string | null => el.querySelector('[data-readiness]')?.getAttribute('data-readiness') ?? null;

    it('renders a card per plugin by kind, with readiness, granted scopes, dependents and the link to its page', async () => {
        const root = await mountAt('/plugins', <PluginsView plugins={opsPlugins} />);
        expect(root.querySelectorAll('[data-scope="ag-plugin-card"][data-part="root"]').length).toBe(opsPlugins.length);
        // The mock project feature (#333) groups under its own kind.
        expect([...root.querySelectorAll('[data-plugin-group]')].map(g => g.getAttribute('data-plugin-group'))).toEqual(['runtime:harness', 'runtime:model', 'connector', 'memory', 'learning', 'a2a', 'project-feature']);

        const claude = card(root, 'claude-code');
        expect(claude.getAttribute('aria-label')).toBe('Claude Code');
        // Runtimes by what they are (#313): the harness reports usage limits; the model runtime is labelled as one.
        expect([...claude.querySelectorAll('[data-part="tags"] [data-scope="ag-pill"] [data-part="label"]')].map(t => t.textContent)).toEqual(expect.arrayContaining(['harness runtime', 'usage limits']));
        expect(card(root, 'anthropic-api').querySelector('[data-part="tags"]')!.textContent).toContain('model runtime');
        expect(root.querySelector('[data-plugin-group="runtime:harness"] [data-plugin-group-note]')!.textContent).toContain('CLI or SDK');
        expect(claude.querySelector('[data-plugin-granted]')!.textContent).toContain('machine:*');
        expect(claude.querySelectorAll('[data-plugin-used] [data-scope="ag-agent-tile"][data-part="root"]').length).toBe(2);
        expect(claude.querySelector('[data-plugin-schedules]')!.textContent).toBe('1 schedule');
        // The mock workspace has a claude-code environment; its Anthropic key is not set yet.
        expect(readinessOf(claude)).toBe('ready');
        expect(readinessOf(card(root, 'anthropic-api'))).toBe('needs-secret');
        expect(card(root, 'anthropic-api').querySelector('a')!.getAttribute('href')).toBe('/plugins/anthropic-api');

        // The active memory plugin: used by everyone, nobody singled out.
        const memory = card(root, 'agentic.memory.default');
        expect(memory.hasAttribute('data-mod-selected')).toBe(true);
        expect(memory.querySelector('[data-workspace-wide]')!.textContent).toBe('Used by every agent');
        expect(card(root, 'agentic.memory.flat').hasAttribute('data-mod-selected')).toBe(false);

        const a2a = card(root, 'a2a');
        expect(a2a.textContent).toContain('No dependents');
        expect(readinessOf(a2a)).toBe('disabled');
        expect(a2a.querySelector<HTMLInputElement>('input[role="switch"]')!.checked).toBe(false);
    });

    it('turning off a plugin with dependents opens the dialog listing them; the switch holds until confirmed', async () => {
        // Without the other harnesses, so Claude Code is the last ready runtime.
        const root = await mountAt('/plugins', <PluginsView plugins={opsPlugins.filter((p) => p.manifest.id !== 'copilot-cli' && p.manifest.id !== 'codex-cli')} />);
        const claude = card(root, 'claude-code');
        const control = () => claude.querySelector<HTMLInputElement>('input[role="switch"]')!;
        expect(control().checked).toBe(true);
        control().click();
        await tick();
        const popup = root.querySelector('[data-scope="dialog"][data-part="popup"]')!;
        expect(popup.getAttribute('role')).toBe('alertdialog');
        expect(popup.textContent).toContain('Disable Claude Code?');
        expect(popup.textContent).toContain('Depends on it · 3');
        for (const name of ['Forge — runtime', 'Lint — runtime', 'Nightly dependency audit — schedule via Lint']) expect(popup.textContent).toContain(name);
        // It is the only runtime that is ready (the Anthropic key is not set): the dialog says so.
        expect(popup.textContent).toContain(LAST_RUNTIME_WARNING);
        const confirm = buttonNamed(popup, 'Disable Claude Code');
        // Still on while the dialog is open.
        expect(control().checked).toBe(true);
        confirm.click();
        await tick();
        expect(control().checked).toBe(false);
        expect(readinessOf(claude)).toBe('disabled');
    });

    it('the active memory plugin states the workspace-wide consequence instead of a list', async () => {
        const root = await mountAt('/plugins', <PluginsView plugins={opsPlugins} />);
        card(root, 'agentic.memory.default').querySelector<HTMLInputElement>('input[role="switch"]')!.click();
        await tick();
        const popup = root.querySelector('[data-scope="dialog"][data-part="popup"]')!;
        expect(popup.textContent).toContain(workspaceWideConsequence('memory'));
        expect(popup.querySelector('[data-confirm-dependents]')).toBeNull();
    });

    it('a plugin nobody depends on switches without a dialog', async () => {
        const root = await mountAt('/plugins', <PluginsView plugins={opsPlugins} />);
        const control = card(root, 'a2a').querySelector<HTMLInputElement>('input[role="switch"]')!;
        control.click();
        await tick();
        expect(root.querySelector('[data-scope="dialog"][data-part="popup"]')).toBeNull();
        expect(card(root, 'a2a').querySelector<HTMLInputElement>('input[role="switch"]')!.checked).toBe(true);
    });
});

describe('/plugins/:id', () => {
    const plugin = (id: string) => opsPlugins.find(p => p.manifest.id === id)!;
    const dependents = (id: string) => opsPluginDependents.find(d => d.pluginId === id);
    const secretInput = (root: ParentNode, name: string): HTMLInputElement => root.querySelector<HTMLInputElement>(`[data-secret="${name}"] input`)!;

    it('the route renders the plugin, and an unknown id says so', async () => {
        const root = await mountRoute('/plugins/agentic.memory.default');
        expect(root.querySelector('[data-plugin-detail]')!.getAttribute('data-plugin')).toBe('agentic.memory.default');
        expect(root.querySelector('[data-plugin-action="activate"]')!.textContent).toContain('This is the memory plugin the workspace runs.');
        expect(root.querySelector('[data-plugin-panel="config"]')!.textContent).toContain('Nothing to configure.');
        // Built in: no Remove.
        expect(root.querySelector('[data-plugin-action="remove"]')).toBeNull();

        const missing = await mountRoute('/plugins/nope');
        expect(missing.textContent).toContain('No plugin with id nope');
    });

    it('settings on the schema form, permissions with their reasons, and a key that is write-only', async () => {
        const root = await mountAt('/plugins/anthropic-api', <PluginPageView plugin={plugin('anthropic-api')} dependents={dependents('anthropic-api')} />);
        expect(root.querySelector('[data-readiness]')!.getAttribute('data-readiness')).toBe('needs-secret');
        expect(root.querySelector<HTMLSelectElement>('select')!.value).toBe('claude-opus-5');
        const row = root.querySelector('[data-permission="secret:anthropic-api-key"]')!;
        expect(row.hasAttribute('data-granted')).toBe(true);
        expect(row.querySelector('[data-permission-reason]')!.textContent).toBe('Calls the Anthropic API with your key when a session starts, and once or twice per chat to title it.');
        expect(texts([...root.querySelectorAll('[data-dependent-via]')])).toEqual(['runtime', 'runtime', 'fallback']);

        // The field hydrates enabled; the value leaves through `save` once and the page keeps the NAME only.
        await tick();
        const SECRET = 'sk-ant-mock-0123456789';
        setText(secretInput(root, 'anthropic-api-key'), SECRET);
        await tick();
        root.querySelector<HTMLFormElement>('[data-secret="anthropic-api-key"] form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await tick();
        expect(root.querySelector('[data-secret="anthropic-api-key"]')!.hasAttribute('data-set')).toBe(true);
        expect(root.querySelector('[data-readiness]')!.getAttribute('data-readiness')).toBe('ready');
        expect(root.innerHTML).not.toContain(SECRET);
        expect(root.querySelector('[data-secret="anthropic-api-key"] input')).toBeNull();

        // Revoking the scope it declared takes it out of service again.
        buttonNamed(row, 'Revoke').click();
        await tick();
        expect(root.querySelector('[data-readiness]')!.getAttribute('data-readiness')).toBe('needs-grant');
    });

    it('a memory plugin that is not the active one can be made active; a connector can be removed', async () => {
        const flat = await mountAt('/plugins/agentic.memory.flat', <PluginPageView plugin={plugin('agentic.memory.flat')} dependents={dependents('agentic.memory.flat')} />);
        buttonNamed(flat, 'Make active').click();
        await tick();
        expect(flat.querySelector('[data-plugin-action="activate"]')!.textContent).toContain('This is the memory plugin the workspace runs.');
        expect(flat.querySelector('[data-plugin-action="activate"] button')).toBeNull();

        const github = await mountAt('/plugins/github-mcp', <PluginPageView plugin={plugin('github-mcp')} dependents={dependents('github-mcp')} />);
        expect(buttonNamed(github, 'Remove')).not.toBeNull();
        expect(github.querySelector('[data-secret="github-token"]')!.hasAttribute('data-set')).toBe(true);
    });
});

describe('/settings', () => {
    const view = (pushAvailable: boolean) => (
        <SettingsView
            timeZone={opsSettings.timeZone}
            timeZones={opsSettings.timeZones}
            defaultEnvironment={opsSettings.defaultEnvironment}
            environmentOptions={opsSettings.environmentOptions}
            pushAvailable={pushAvailable}
            notifications={opsSettings.notifications}
            apiKeys={opsSettings.apiKeys}
            budgets={opsSettings.budgets}
            retention={opsSettings.retention}
        />
    );

    it('renders the sections with the matrix, masked keys, budgets, retention and the data actions', async () => {
        const root = await mountAt('/settings', view(true));
        expect([...root.querySelectorAll('[data-settings-section]')].map(s => s.getAttribute('aria-label'))).toEqual(['Time', 'Notifications', 'API keys', 'Machine updates', 'Budgets', 'Retention', 'Your data']);
        const matrix = root.querySelector('[data-notify-matrix]')!;
        expect([...matrix.querySelectorAll('thead th')].map(th => th.textContent?.trim())).toEqual(['Event', 'Inbox', 'Push']);
        expect(matrix.querySelectorAll('tbody tr').length).toBe(4);
        expect(matrix.querySelectorAll('tbody input[role="switch"]').length).toBe(8);
        expect(root.querySelector('[data-api-masked]')!.textContent).toBe('sk-ant-…9f2c');
        expect(root.querySelector('[data-api-key] [data-scope="ag-pill"] [data-part="label"]')!.textContent).toBe('KEY OK');
        // Every field has a label.
        for (const input of root.querySelectorAll<HTMLInputElement>('input:not([type="checkbox"]), select')) {
            const label = input.id ? root.querySelector(`label[for="${input.id}"]`) : null;
            expect(label || input.getAttribute('aria-label') || input.closest('label'), input.getAttribute('name') ?? input.outerHTML).toBeTruthy();
        }
        expect(buttonNamed(root, 'Delete workspace')).toBeTruthy();
    });

    it('hides the push column when push is unavailable', async () => {
        const root = await mountAt('/settings', view(false));
        const matrix = root.querySelector('[data-notify-matrix]')!;
        expect([...matrix.querySelectorAll('thead th')].map(th => th.textContent?.trim())).toEqual(['Event', 'Inbox']);
        expect(matrix.querySelectorAll('tbody input[role="switch"]').length).toBe(4);
        expect(matrix.textContent).not.toContain('Push');
    });
});

describe('/history', () => {
    it('groups by day, newest first, with the template and the kind tags', async () => {
        const root = await mountAt('/history', <HistoryView entries={opsHistory} />);
        const table = root.querySelector('.ag-history')!;
        expect(colWidths(table)).toEqual(HISTORY_COLS.split(' ').map(t => (t.endsWith('fr') ? 'auto' : t)));
        const days = [...table.querySelectorAll('[data-day-row]')].map(r => r.getAttribute('data-day-row'));
        expect(days).toEqual(['2026-09-17', '2026-09-16']);
        const times = [...table.querySelectorAll('[data-history-row] code')].map(c => c.textContent);
        expect(times.slice(0, 3)).toEqual(['14:20:03', '14:09:40', '14:02:12']);
        expect(table.querySelector('[data-day-row] [data-day-label]')!.textContent).toBe('Thursday 17 September');
        expect(table.querySelector('[data-history-row][data-kind="approval-asked"] [data-scope="ag-pill"]')!.getAttribute('data-tone')).toBe('needs-you');
        expect(table.querySelector('[data-history-row][data-kind="interrupted"] [data-scope="ag-pill"]')!.getAttribute('data-tone')).toBe('failed');
        expect(table.querySelectorAll('[data-history-row]').length).toBe(opsHistory.length);
    });

    it('filters by kind with pressed chips', async () => {
        const root = await mountAt('/history', <HistoryView entries={opsHistory} />);
        const chips = [...root.querySelectorAll<HTMLButtonElement>('[data-filter-chip]')];
        expect(chips.map(c => c.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false', 'false', 'false', 'false']);
        chips.find(c => c.textContent === 'Approvals')!.click();
        await tick();
        const rows = [...root.querySelectorAll('[data-history-row]')];
        expect(rows.length).toBe(filterHistory(opsHistory, 'approvals').length);
        expect(rows.every(r => ['approval', 'approval-asked'].includes(r.getAttribute('data-kind')!))).toBe(true);
        expect(root.querySelector('[data-filter-chip][aria-pressed="true"]')!.textContent).toBe('Approvals');
    });

    it('groupByDay orders days and keeps newest first inside a day', () => {
        const groups = groupByDay([{ at: '2026-09-16T09:00:00' }, { at: '2026-09-17T14:00:00' }, { at: '2026-09-17T09:00:00' }]);
        expect(groups.map(g => g.day)).toEqual(['2026-09-17', '2026-09-16']);
        expect(groups[0]!.items.map(i => i.at)).toEqual(['2026-09-17T14:00:00', '2026-09-17T09:00:00']);
    });
});

describe('/usage', () => {
    it('prints n/a and NOT REPORTED for unreported cost, ~ for estimates, and never a 0', async () => {
        const root = await mountAt('/usage', <UsageView rows={usageRows} />);
        const table = root.querySelector('.ag-usage')!;
        expect(colWidths(table)).toEqual(USAGE_COLS.split(' ').map(t => (t.endsWith('fr') ? 'auto' : t)));
        const forge = table.querySelector('[data-usage-row="forge"]')!;
        expect(forge.querySelector('[data-cost]')!.textContent).toBe('n/a');
        expect(forge.querySelector('[data-scope="ag-pill"] [data-part="label"]')!.textContent).toBe('NOT REPORTED');
        expect(forge.querySelector('[data-scope="ag-pill"]')!.hasAttribute('data-mod-hollow')).toBe(true);
        const scout = table.querySelector('[data-usage-row="scout"]')!;
        expect(scout.querySelector('[data-cost]')!.textContent).toBe('~$6.52');
        expect(scout.querySelector('[data-scope="ag-pill"] [data-part="label"]')!.textContent).toBe('PARTLY ESTIMATED');
        for (const cost of table.querySelectorAll('[data-cost]')) expect(cost.textContent).not.toMatch(/^\$?0(\.00)?$/);
        expect(root.querySelectorAll('[data-stat]').length).toBe(4);
        expect(root.querySelectorAll('[data-bar]').length).toBe(17);
    });

    it('lists every account\'s provider limits above the stats: the /usage windows, stale offline data, and why anthropic-api reports none (#270, OPS-07)', async () => {
        const root = await mountAt('/usage', <UsageView rows={usageRows} />);
        const limits = root.querySelector('[data-usage-limits]')!;
        expect(limits.compareDocumentPosition(root.querySelector('[data-usage-stats]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        const work = limits.querySelector('[data-limit-account="env_alien01_work"]')!;
        expect([...work.querySelectorAll('[data-scope="ag-quota"][data-part="label"]')].map(l => l.textContent)).toEqual(['Current session', 'Current week (all models)', 'Current week (Fable)']);
        expect([...work.querySelectorAll('[data-scope="ag-quota"][data-part="used"]')].map(l => l.textContent)).toEqual(['19% used', '76% used', '100% used']);
        expect(work.querySelector('[data-window="seven_day:fable"]')!.getAttribute('data-tone')).toBe('failed');
        expect(limits.querySelector('[data-limit-account="env_nuclab_work"] [data-scope="ag-quota-panel"]')!.hasAttribute('data-mod-stale')).toBe(true);
        expect(limits.querySelector('[data-limit-account="env_alien01_client_acme"]')!.textContent).toContain('No usage reported yet');
        expect(limits.querySelector('[data-limit-account="platform"]')!.textContent).toContain('Not reported by provider — The Anthropic API has per-minute rate limits');
    });

    it('switches the table by task and by turn', async () => {
        const root = await mountAt('/usage', <UsageView rows={usageRows} />);
        const byTask = [...root.querySelectorAll<HTMLButtonElement>('[data-scope="toggle-group"] button')].find(b => b.textContent === 'By task')!;
        byTask.click();
        await tick();
        expect(root.querySelector('.ag-usage thead th')!.textContent?.trim()).toBe('Task');
        expect(root.querySelectorAll('.ag-usage [data-usage-row]').length).toBe(usageRows.task.length);
        expect(byTask.getAttribute('aria-pressed')).toBe('true');
    });

    it('money follows OPS-07', () => {
        expect(money(null, 'not-reported')).toBe('n/a');
        expect(money(0, 'not-reported')).toBe('n/a');
        expect(money(6.52, 'partly-estimated')).toBe('~$6.52');
        expect(money(11.9, 'reported')).toBe('$11.90');
    });
});
