/**
 * The operations routes on mock data (#90): each page renders the
 * handoff's structure, and the behaviours the artboards cannot show —
 * EXE-12 on Machines, the code expiring on Pair, the offline policy line
 * and the DST footer on Schedules, the
 * hidden push column on Settings, day grouping on History, and `n/a` for
 * unreported cost on Usage (OPS-07).
 */
import { HistoryView, HISTORY_COLS, filterHistory } from '../../src/pages/History';
import { Machine } from '../../src/pages/Machine';
import { MachinesView as MachinesList } from '../../src/pages/Machines';
import { CODE_LIFETIME, PairView } from '../../src/pages/Pair';
import { SCHEDULES_COLS, SchedulesView } from '../../src/pages/Schedules';
import { SettingsView } from '../../src/pages/Settings';
import { USAGE_COLS, UsageView } from '../../src/pages/Usage';
import { SESSIONS_COLS } from '../../src/pages/machines/SessionsTable';
import { dstRule, opsHistory, opsMachines, opsSchedules, opsSettings, pairing, usageRows, money } from '../../src/mock/ops';
import { groupByDay } from '../../src/pages/ops/format';
import { buttonNamed, colWidths, mountAt, tick } from './helpers';

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
        expect(root.querySelector('[data-scope="empty-state"][data-part="root"]')).toBeNull();
    });

    it('each environment card carries its account\'s limits (#270)', async () => {
        const root = await mountAt('/machines', <MachinesList machines={opsMachines} />);
        const work = root.querySelector('[data-scope="ag-env-card"][data-part="root"][aria-label="work"]')!;
        expect(work.querySelector('[data-scope="ag-env-card"][data-part="quota"] [data-window="seven_day"] [data-part="used"]')!.textContent).toBe('76% used');
    });

    it('with no machine shows the platform row plus the dashed "Pair a machine" card', async () => {
        const root = await mountAt('/machines', <MachinesList machines={[]} />);
        expect(root.querySelector('[data-machine-group][data-platform]')).not.toBeNull();
        const empty = root.querySelector('[data-scope="empty-state"][data-part="root"]')!;
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
        expect(root.querySelector('[data-scope="empty-state"][data-part="root"]')!.textContent).toContain('No machine with id nope');
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
        expect(root.querySelector('[data-api-key] [data-scope="badge"][data-part="root"]')!.textContent).toBe('KEY OK');
        // Every field has a label.
        // A zero Select posts through an aria-hidden `<select>`; its labelled control is the trigger.
        for (const input of root.querySelectorAll<HTMLInputElement>('input:not([type="checkbox"]), select:not([data-part="hidden-input"]), [data-scope="select"][data-part="trigger"]')) {
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
        expect(table.querySelector('[data-history-row][data-kind="approval-asked"] [data-scope="badge"][data-part="root"]')!.getAttribute('data-tone')).toBe('needs-you');
        expect(table.querySelector('[data-history-row][data-kind="interrupted"] [data-scope="badge"][data-part="root"]')!.getAttribute('data-tone')).toBe('failed');
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
        expect(forge.querySelector('[data-scope="badge"][data-part="root"]')!.textContent).toBe('NOT REPORTED');
        expect(forge.querySelector('[data-scope="badge"][data-part="root"]')!.getAttribute('data-variant')).toBe('outline');
        const scout = table.querySelector('[data-usage-row="scout"]')!;
        expect(scout.querySelector('[data-cost]')!.textContent).toBe('~$6.52');
        expect(scout.querySelector('[data-scope="badge"][data-part="root"]')!.textContent).toBe('PARTLY ESTIMATED');
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
