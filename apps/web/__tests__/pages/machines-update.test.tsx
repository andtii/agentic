/**
 * The daemon update card (#367) on mock data and its pure model: every state
 * the card draws from a `Machine.updateState()`, what its actions emit, the
 * "Update now" confirm naming the running turns, the Machines list's badges
 * and "Update all", and the Settings defaults.
 */
import type { MachineUpdateView } from '@agentic/platform';
import { DEFAULT_UPDATE_SETTINGS } from '@agentic/core';
import { MachinesView } from '../../src/pages/Machines';
import { SettingsView } from '../../src/pages/Settings';
import { UpdateCard } from '../../src/pages/machines/UpdateCard';
import { buildLabel, canSelfUpdate, cronLabel, draftOfPolicy, impactText, lastLine, needsReinstall, phaseSteps, policyLabel, policyOfDraft, progressPercent, reinstallCommand, restartWarning, rollbackTarget, runningLine, samePolicy, updatable, updateBadge, validatePolicy } from '../../src/pages/machines/update';
import { opsMachines, opsSettings, opsUpdate, opsUpdateStates, type OpsUpdateState } from '../../src/mock/ops';
import { buttonNamed, mountAt, text, tick } from './helpers';
import { mountRoute } from './mount';

const NOW = Date.parse('2026-09-17T14:20:04Z');
const view = (state: OpsUpdateState, extra: Partial<MachineUpdateView> = {}): MachineUpdateView => ({ ...opsUpdateStates[state].view, ...extra });

interface Emitted { request: ('drain' | 'now')[]; cancel: number; rollback: number; saves: unknown[] }

async function card(update: MachineUpdateView, props: { reinstall?: boolean; failure?: string } = {}) {
    const emitted: Emitted = { request: [], cancel: 0, rollback: 0, saves: [] };
    const root = await mountAt('/machines/alien01', (
        <UpdateCard
            update={update}
            name="alien01"
            os="windows"
            daemonVersion="0.1.0"
            origin="https://agentic.example"
            timeZone="Europe/Stockholm"
            defaults={DEFAULT_UPDATE_SETTINGS}
            turnLabel={(t) => `${t.agentId} · ${t.sessionId}`}
            now={NOW}
            reinstall={props.reinstall}
            failure={props.failure ?? null}
            onRequest={(mode: 'drain' | 'now') => { emitted.request.push(mode); }}
            onCancel={() => { emitted.cancel += 1; }}
            onRollback={() => { emitted.rollback += 1; }}
            onSaveUpdates={(c: unknown) => { emitted.saves.push(c); }}
        />
    ));
    await tick();
    return { root, emitted, section: root.querySelector<HTMLElement>('[data-update-card]')! };
}

const openPopup = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-scope="dialog"][data-part="popup"][data-state="open"]');
const change = (root: ParentNode, selector: string, value: string): void => {
    const el = root.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
};

describe('the update model (#367)', () => {
    it('names the build, and a daemon without one by its version', () => {
        const b = { version: '0.2.0', commit: 'abcdef1234', protocol: 1, channel: 'stable', platform: 'win32-x64' };
        expect(buildLabel(b, '0.2.0')).toBe('daemon 0.2.0 · stable · abcdef1');
        expect(buildLabel(undefined, '0.1.0')).toBe('daemon 0.1.0');
        expect(runningLine({ build: b, channel: 'latest' })).toBe('Running 0.2.0 (latest, built abcdef1)');
        expect(runningLine({ channel: 'stable' }, '0.1.0')).toBe('Running 0.1.0');
        expect(canSelfUpdate({ build: b, features: ['update'] })).toBe(true);
        expect(canSelfUpdate({ build: b, features: [] })).toBe(false);
        expect(canSelfUpdate({ features: ['update'] })).toBe(false);
    });

    it('walks the phases, with the download as a percent', () => {
        expect(phaseSteps({}).map((s) => s.state)).toEqual(['todo', 'todo', 'todo', 'todo', 'todo']);
        expect(phaseSteps({ phase: 'staged' }).map((s) => s.state)).toEqual(['done', 'done', 'current', 'todo', 'todo']);
        expect(progressPercent({ bytes: 29, total: 48 })).toBe(60);
        expect(progressPercent({ bytes: 1, total: 0 })).toBeNull();
        expect(progressPercent(undefined)).toBeNull();
    });

    it('says what an update now interrupts: the running turns, and the live sessions that restart', () => {
        expect(impactText({ runningTurns: [{ sessionId: 's1' as never, agentId: 'a' }, { sessionId: 's2' as never, agentId: 'b' }], liveSessions: 3 }))
            .toBe('2 running turns will be interrupted and offered Resume. 3 live sessions restart: anything they started in the background (dev servers, watchers) stops; their conversations continue.');
        expect(impactText({ runningTurns: [], liveSessions: 1 })).toBe('No turn is running, so nothing is interrupted. 1 live session restarts: anything it started in the background (dev servers, watchers) stops; its conversation continues.');
        expect(impactText({ runningTurns: [], liveSessions: 0 })).toBe('No turn is running, so nothing is interrupted.');
    });

    it('reads the last outcome, offers a roll back only after an applied update, and warns about restarts inside the hour', () => {
        const at = Date.parse('2026-09-17T12:00:00Z');
        expect(lastLine({ from: '0.1.0', to: '0.2.0', outcome: 'applied', at }, 'UTC')).toBe('Updated to 0.2.0 at 17 Sep 12:00.');
        expect(lastLine({ from: '0.1.0', to: '0.2.0', outcome: 'rolled-back', at, error: 'no hello' }, 'UTC')).toBe('The update to 0.2.0 failed at 17 Sep 12:00: no hello. The previous version was restored.');
        expect(lastLine(undefined)).toBeNull();
        expect(rollbackTarget(view('applied'))).toBe('0.1.0');
        expect(rollbackTarget(view('rolled-back'))).toBeNull();
        expect(restartWarning({ restarts: 4, lastExit: { at: NOW - 60_000, reason: 'crashed', code: 1 } }, NOW, 'UTC')).toBe('The daemon restarted 4 times — last exit: crashed (code 1) at 17 Sep 14:19.');
        expect(restartWarning({ restarts: 2, lastExit: { at: NOW, reason: 'crashed' } }, NOW)).toBeNull();
        expect(restartWarning({ restarts: 5, lastExit: { at: NOW - 2 * 60 * 60_000, reason: 'crashed' } }, NOW)).toBeNull();
    });

    it('badges a machine by the most pressing thing, and "Update all" takes only machines that can go', () => {
        expect(updateBadge(view('available'))).toBe('available');
        expect(updateBadge(view('draining'))).toBe('draining');
        expect(updateBadge(view('requested'))).toBe('draining');
        expect(updateBadge(view('downloading'))).toBe('updating');
        expect(updateBadge(view('outdated'))).toBe('outdated');
        expect(updateBadge(view('current'))).toBeNull();
        expect(updatable(view('available'))).toBe(true);
        expect(updatable(view('available', { online: false }))).toBe(false);
        expect(updatable(view('downloading'))).toBe(false);
        expect(updatable(view('no-feature', { available: view('available').available }))).toBe(false);
    });

    it('builds a window policy from the form, checked as the platform checks it', () => {
        const draft = draftOfPolicy(null, null);
        expect(draft).toEqual({ channel: '', kind: '', cron: '0 3 * * *', hours: '2' });
        expect(policyOfDraft(draft, 'UTC')).toBeNull();
        expect(policyOfDraft({ ...draft, kind: 'window', hours: '1.5' }, 'Europe/Stockholm')).toEqual({ kind: 'window', cron: '0 3 * * *', tz: 'Europe/Stockholm', durationMs: 5_400_000 });
        expect(validatePolicy({ ...draft, kind: 'window', cron: '0 3 * *', hours: '0' })).toEqual({ cron: expect.any(String), hours: expect.any(String) });
        expect(policyOfDraft({ ...draft, kind: 'window', hours: '200' }, 'UTC')).toBeUndefined();
        expect(draftOfPolicy('latest', { kind: 'window', cron: '30 22 * * 1-5', tz: 'UTC', durationMs: 3_600_000 })).toEqual({ channel: 'latest', kind: 'window', cron: '30 22 * * 1-5', hours: '1' });
        expect(policyLabel({ kind: 'window', cron: '30 22 * * 1-5', tz: 'UTC', durationMs: 3_600_000 })).toBe('weekdays 22:30 for 1 h (UTC)');
        expect(cronLabel('0 3 * * *')).toBe('daily 03:00');
        expect(samePolicy({ kind: 'manual' }, { kind: 'manual' })).toBe(true);
        expect(samePolicy(null, { kind: 'manual' })).toBe(false);
    });

    it('spells the reinstall line per OS, without a pairing code, and spots the 409 that asks for it', () => {
        expect(reinstallCommand('https://a.test', 'windows')).toBe("irm 'https://a.test/install.ps1' | iex");
        expect(reinstallCommand('https://a.test', 'linux')).toBe("curl -fsSL 'https://a.test/install.sh' | sh");
        expect(needsReinstall(Object.assign(new Error('machine "m" runs a daemon that cannot update itself: reinstall once'), { status: 409 }))).toBe(true);
        expect(needsReinstall(Object.assign(new Error('machine "m" has an update pending (u1)'), { status: 409 }))).toBe(false);
    });
});

describe('the update card (#367)', () => {
    it('offers an available release: What’s new, Update when idle, Update now and Schedule', async () => {
        const { section, emitted } = await card(view('available'));
        expect(section.getAttribute('data-update-state')).toBe('available');
        expect(text(section.querySelector('[data-update-running]'))).toBe('Running 0.1.0 (stable, built a1b2c3d)');
        expect(text(section.querySelector('[data-update-version] span'))).toBe('0.2.0 available');
        expect(section.querySelector<HTMLAnchorElement>('[data-update-notes]')!.href).toBe('https://agentic.example/releases/daemon-v0.2.0');
        expect(text(section.querySelector('[data-update-follows]'))).toBe('Follows the workspace: stable, only when asked.');
        buttonNamed(section, 'Update when idle').click();
        expect(emitted.request).toEqual(['drain']);
        // Schedule switches the policy form to a window.
        expect(section.querySelector('[data-update-window]')).toBeNull();
        buttonNamed(section, 'Schedule…').click();
        await tick();
        expect(section.querySelector('input[name="machine-update-cron"]')).not.toBeNull();
    });

    it('confirms "Update now" by naming the running turns it interrupts, with links, and what the live sessions lose', async () => {
        const update = view('available', { impact: { runningTurns: [{ sessionId: 's_41ab' as never, agentId: 'lint' }, { sessionId: 's_41aa' as never, taskId: 't1' as never, agentId: 'forge' }], liveSessions: 3 } });
        const { section, emitted } = await card(update);
        buttonNamed(section, 'Update now').click();
        await tick();
        const popup = openPopup()!;
        expect(popup).not.toBeNull();
        expect(text(popup.querySelector('[data-scope="dialog"][data-part="description"]'))).toBe(impactText(update.impact));
        const links = [...popup.querySelectorAll<HTMLAnchorElement>('[data-update-turns] a')];
        expect(links.map((a) => [text(a), a.getAttribute('href')])).toEqual([['lint · s_41ab', '/sessions/s_41ab'], ['forge · s_41aa', '/tasks/t1']]);
        expect(emitted.request).toEqual([]);
        buttonNamed(popup, 'Interrupt 2 and update').click();
        await tick();
        expect(emitted.request).toEqual(['now']);
    });

    it('shows a pending update phase by phase: the download’s progress, the turns a drain waits for, Cancel', async () => {
        const downloading = await card(view('downloading'));
        expect(downloading.section.querySelector('[data-update-phase="downloading"]')!.getAttribute('data-state')).toBe('current');
        expect(downloading.section.querySelector<HTMLProgressElement>('[data-update-progress]')!.value).toBe(60);
        buttonNamed(downloading.section, 'Cancel update').click();
        expect(downloading.emitted.cancel).toBe(1);
        // No Update buttons while one is pending.
        expect(() => buttonNamed(downloading.section, 'Update when idle')).toThrow();

        const draining = await card(view('draining'));
        const phase = draining.section.querySelector('[data-update-phase="draining"]')!;
        expect(phase.getAttribute('data-state')).toBe('current');
        expect(text(phase.querySelector('[data-update-draining] > span'))).toBe('Waiting for 2 running turns:');
        expect([...phase.querySelectorAll('[data-update-turns] a')].map((a) => a.getAttribute('href'))).toEqual(['/sessions/s_41ab', '/tasks/t1']);
        expect([...draining.section.querySelectorAll('[data-update-phase]')].filter((p) => p.getAttribute('data-state') === 'done').map((p) => p.getAttribute('data-update-phase'))).toEqual(['downloading', 'verifying', 'staged']);
    });

    it('reports how the last update ended: rolled back (restored), failed with its error, applied with Roll back', async () => {
        const rolled = await card(view('rolled-back'));
        const line = rolled.section.querySelector('[data-update-last]')!;
        expect(line.getAttribute('data-tone')).toBe('failed');
        expect(text(line)).toContain('The previous version was restored.');
        expect(text(line)).toContain('the new build did not say hello within 60 s');

        const failed = await card(view('failed'));
        expect(text(failed.section.querySelector('[data-update-last]'))).toContain('sha256 mismatch');

        const applied = await card(view('applied'));
        expect(text(applied.section.querySelector('[data-update-last]'))).toMatch(/^Updated to 0\.2\.0 at /);
        buttonNamed(applied.section, 'Roll back to 0.1.0').click();
        expect(applied.emitted.rollback).toBe(1);
        expect(applied.section.getAttribute('data-update-state')).toBe('current');
    });

    it('a daemon that predates updates gets the installer line, not the actions; an outdated one the banner; a crash loop the warning', async () => {
        const old = await card(view('no-feature'));
        expect(old.section.getAttribute('data-update-state')).toBe('no-feature');
        expect(text(old.section.querySelector('[data-update-reinstall] [data-card-text]'))).toBe('This daemon predates updates — reinstall once with the one-line installer on alien01:');
        expect(text(old.section.querySelector('[data-update-reinstall] [data-command-well] code'))).toBe("irm 'https://agentic.example/install.ps1' | iex");
        expect(() => buttonNamed(old.section, 'Update when idle')).toThrow();

        const outdated = await card(view('outdated'));
        expect(outdated.section.getAttribute('data-tone')).toBe('failed');
        expect(text(outdated.section.querySelector('[data-update-banner]'))).toMatch(/^Update required/);
        expect(text(outdated.section.querySelector('[data-scope="ag-pill"][data-part="root"]'))).toBe('UPDATE REQUIRED');

        const looping = await card(view('crash-loop'));
        expect(text(looping.section.querySelector('[data-update-restarts]'))).toMatch(/^The daemon restarted 4 times — last exit: crashed \(code 1\)/);

        const refused = await card(view('available'), { reinstall: true });
        expect(refused.section.querySelectorAll('[data-update-reinstall]').length).toBe(1);
    });

    it('saves the machine’s own channel and a window policy; the workspace default is `null`', async () => {
        const { section, emitted } = await card(view('available'));
        const save = buttonNamed(section, 'Save update settings');
        expect(save.disabled).toBe(true);
        change(section, 'select[name="machine-update-channel"]', 'latest');
        change(section, 'select[name="machine-update-policy"]', 'window');
        await tick();
        change(section, 'input[name="machine-update-cron"]', '0 2 * * 0');
        change(section, 'input[name="machine-update-hours"]', '3');
        await tick();
        buttonNamed(section, 'Save update settings').click();
        expect(emitted.saves).toEqual([{ channel: 'latest', policy: { kind: 'window', cron: '0 2 * * 0', tz: 'Europe/Stockholm', durationMs: 3 * 3_600_000 } }]);

        const own = await card(view('current'));
        change(own.section, 'select[name="machine-update-channel"]', '');
        change(own.section, 'select[name="machine-update-policy"]', '');
        await tick();
        buttonNamed(own.section, 'Save update settings').click();
        expect(own.emitted.saves).toEqual([{ channel: null, policy: null }]);
    });
});

describe('/machines and /machines/:id on mock data (#367)', () => {
    it('badges the machines, and "Update all" asks the ones that can go after naming them', async () => {
        const root = await mountAt('/machines', <MachinesView machines={opsMachines} />);
        await tick();
        const badge = (id: string) => root.querySelector(`[data-machine-group][data-machine="${id}"] .ag-update-badge`);
        expect(text(badge('alien01'))).toBe('UPDATE AVAILABLE');
        // nuc-lab predates updates and is offline: no badge, and not in "Update all".
        expect(badge('nuc-lab')).toBeNull();
        expect(text(root.querySelector('[data-update-all-text]'))).toBe('1 machine has a daemon update waiting.');
        buttonNamed(root, 'Update all machines').click();
        await tick();
        const popup = openPopup()!;
        expect([...popup.querySelectorAll('[data-confirm-dependents] li')].map((li) => text(li))).toEqual(['alien01 · 0.1.0 → 0.2.0']);
        buttonNamed(popup, 'Update 1 when idle').click();
        await tick();
        expect(text(root.querySelector('[data-update-result="alien01"]'))).toBe('alien01 asked to update when idle');
        expect(text(badge('alien01'))).toBe('DRAINING');
    });

    it('the mock Machine page carries the card under the header, the build in the caption, and a preview of every state', async () => {
        const root = await mountRoute('/machines/alien01');
        expect(text(root.querySelector('[data-machine-caption]'))).toContain('daemon 0.1.0 · stable · a1b2c3d');
        const section = root.querySelector<HTMLElement>('[data-update-card]')!;
        expect(section.getAttribute('data-update-state')).toBe('available');
        const options = [...section.querySelectorAll<HTMLOptionElement>('select[name="update-preview"] option')].map((o) => o.value).filter(Boolean);
        expect(options).toEqual(Object.keys(opsUpdateStates));
        change(section, 'select[name="update-preview"]', 'restarting');
        await tick();
        expect(root.querySelector('[data-update-phase="restarting"]')!.getAttribute('data-state')).toBe('current');
        // An action moves the mock the way the platform would.
        change(section, 'select[name="update-preview"]', 'available');
        await tick();
        buttonNamed(section, 'Update when idle').click();
        await tick();
        expect(root.querySelector('[data-update-card]')!.getAttribute('data-update-state')).toBe('pending');
        buttonNamed(root.querySelector('[data-update-card]')!, 'Cancel update').click();
        await tick();
        expect(text(root.querySelector('[data-update-last]'))).toMatch(/was cancelled/);
        // A cancel is not a failure: no alert, no failed tone.
        expect(root.querySelector('[data-update-last]')!.getAttribute('role')).toBeNull();
        expect(root.querySelector('[data-update-last]')!.getAttribute('data-tone')).toBeNull();
        expect(opsUpdate('nuc-lab').features).toEqual([]);
    });
});

describe('/settings on mock data (#367)', () => {
    it('sets the workspace’s machine update defaults: a channel and a policy, no "workspace default" option', async () => {
        const root = await mountAt('/settings', (
            <SettingsView
                timeZone={opsSettings.timeZone}
                timeZones={opsSettings.timeZones}
                defaultEnvironment={opsSettings.defaultEnvironment}
                environmentOptions={opsSettings.environmentOptions}
                pushAvailable
                notifications={opsSettings.notifications}
                apiKeys={opsSettings.apiKeys}
                budgets={opsSettings.budgets}
                retention={opsSettings.retention}
            />
        ));
        await tick();
        const section = root.querySelector<HTMLElement>('[data-settings-section][aria-label="Machine updates"]')!;
        expect([...section.querySelectorAll<HTMLOptionElement>('select[name="workspace-update-channel"] option')].map((o) => o.value).filter(Boolean)).toEqual(['stable', 'latest']);
        expect([...section.querySelectorAll<HTMLOptionElement>('select[name="workspace-update-policy"] option')].map((o) => o.value).filter(Boolean)).toEqual(['manual', 'auto-when-idle', 'window']);
        change(section, 'select[name="workspace-update-policy"]', 'auto-when-idle');
        await tick();
        buttonNamed(section, 'Save update settings').click();
        await tick();
        expect(text(section.querySelector('[data-update-defaults-status]'))).toBe('Saved.');
    });
});
