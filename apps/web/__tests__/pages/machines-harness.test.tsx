/**
 * "Runtimes on this machine" (#370) on mock data and its pure model: the
 * rows a `Machine.get()` makes, the Remove rule, what an update on one
 * runtime costs, the phases and outcomes, the card's actions and confirms,
 * the Machines list's pill, the runtime plugin page's machine list, and the
 * History and "Needs you" wording.
 */
import type { AuditEvent, HarnessResultView } from '@agentic/platform';
import { HarnessCard, type HarnessAsk } from '../../src/pages/machines/HarnessCard';
import { harnessErrorText, harnessImpactText, harnessRows, harnessSteps, harnessUpdates, newerThan, outcomeLine, pendingLine, refusalText, removeBlocked, runtimeMachineLine, runtimeOnMachine, versionLine, type HarnessSource } from '../../src/pages/machines/harness';
import { MACHINE_NOTICE } from '../../src/pages/machines/MachineNotice';
import { kindLabel, refOf, toneOf, HISTORY_KIND_FILTERS } from '../../src/pages/history/live';
import { opsHarness, opsHarnessesAvailable, opsHarnessStates } from '../../src/mock/ops';
import { buttonNamed, mountAt, text, tick } from './helpers';
import { mountRoute } from './mount';

const source = (extra: Partial<HarnessSource> = {}): HarnessSource => ({
    harnesses: opsHarness('alien01').harnesses,
    harnessesAvailable: opsHarnessesAvailable,
    environments: [
        { id: 'env_work' as never, name: 'work', runtime: 'claude-code' },
        { id: 'env_personal' as never, name: 'personal', runtime: 'claude-code' },
        { id: 'env_copilot' as never, name: 'copilot', runtime: 'copilot-cli' }
    ],
    activeSessions: [
        { sessionId: 's_run' as never, environmentId: 'env_work', agentId: 'forge', taskId: 't1' as never, running: { turnId: 'x', since: 0 } },
        { sessionId: 's_prompted' as never, environmentId: 'env_personal', agentId: 'lint' },
        { sessionId: 's_idle' as never, environmentId: 'env_personal', agentId: 'scout' }
    ],
    pending: [{ sessionId: 's_prompted' as never, command: { type: 'prompt' } }],
    ...extra
});

const request = (extra: Partial<HarnessResultView>): HarnessResultView => ({ requestId: 'harness_1', op: 'update', runtime: 'claude-code', mode: 'drain', status: 'pending', requestedAt: 0, from: '2.0.0', to: '2.1.0', ...extra });
const openPopup = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-scope="dialog"][data-part="popup"][data-state="open"]');
const change = (root: ParentNode, selector: string, value: string): void => {
    const el = root.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
};

describe('the harness model (#370)', () => {
    it('lists the reported runtimes with what the release offers, who runs on each and what runs now', () => {
        const rows = harnessRows(source());
        expect(rows.map((r) => [r.runtime, r.name, r.status, r.installed, r.available, r.update])).toEqual([
            ['claude-code', 'Claude Code', 'ready', '2.0.0', '2.1.0', true],
            ['codex-cli', 'Codex', 'ready', '0.46.0', '0.46.0', false],
            ['copilot-cli', 'Copilot CLI', 'missing', undefined, '1.0.14', false]
        ]);
        expect(rows[0]!.environments).toEqual(['work', 'personal']);
        // A turn running and a prompt out both count; an idle live session does not run, but restarts.
        expect(rows[0]!.running.map((t) => t.sessionId)).toEqual(['s_run', 's_prompted']);
        expect(rows[0]!.running[0]).toEqual({ sessionId: 's_run', taskId: 't1', agentId: 'forge' });
        expect(rows[0]!.liveSessions).toBe(3);
        expect(rows[1]!.running).toEqual([]);
        expect(harnessUpdates(source())).toBe(1);
        expect(harnessRows(source({ harnesses: undefined }))).toEqual([]);
    });

    it('compares versions, prints the version line, and says why Remove is off', () => {
        expect(newerThan('2.1.0', '2.0.9')).toBe(true);
        expect(newerThan('2.0.10', '2.0.9')).toBe(true);
        expect(newerThan('2.0.0', '2.0.0')).toBe(false);
        expect(newerThan('2.0.0', '2.0.0-beta.1')).toBe(true);
        expect(newerThan('1.9.0', '2.0.0')).toBe(false);
        // Prerelease identifiers in semver precedence: numeric ones numerically, below alphanumeric ones, a longer set above its prefix.
        expect(newerThan('2.0.0-beta.10', '2.0.0-beta.2')).toBe(true);
        expect(newerThan('2.0.0-beta.2', '2.0.0-beta.10')).toBe(false);
        expect(newerThan('2.0.0-alpha', '2.0.0-1')).toBe(true);
        expect(newerThan('2.0.0-beta.1', '2.0.0-beta')).toBe(true);
        expect(newerThan('2.0.0-rc.1', '2.0.0-beta.9')).toBe(true);
        expect(newerThan('2.0.0-beta.1', '2.0.0-beta.1')).toBe(false);
        const [cc, codex, copilot] = harnessRows(source());
        expect(versionLine(cc!)).toBe('2.0.0 · 2.1.0 available');
        expect(versionLine(codex!)).toBe('0.46.0');
        expect(versionLine(copilot!)).toBe('not installed · 1.0.14 available');
        expect(versionLine({ ...copilot!, installable: false })).toBe('not installed · 1.0.14 available (no build for this machine)');
        expect(removeBlocked(cc!)).toBe('Used by work, personal. Remove those environments first.');
        expect(removeBlocked(codex!)).toBeNull();
        expect(removeBlocked(copilot!)).toBe('Used by copilot. Remove that environment first.');
        expect(removeBlocked({ ...copilot!, environments: [] })).toBe('Not installed.');
    });

    it('says what an update costs on its runtime, drained or now', () => {
        const [cc, codex] = harnessRows(source());
        expect(harnessImpactText(cc!, 'now')).toBe('2 running turns on Claude Code will be interrupted and offered Resume. 3 live sessions restart: anything they started in the background stops; their conversations continue. Other runtimes keep running.');
        expect(harnessImpactText(cc!, 'drain')).toMatch(/^It waits for 2 running turns on Claude Code to end, for at most 10 minutes/);
        expect(harnessImpactText(codex!, 'drain')).toBe('No turn is running on Codex, so nothing is interrupted. Other runtimes keep running.');
    });

    it('walks the phases, and words the pending line and the outcome', () => {
        expect(harnessSteps({ op: 'update' }).map((s) => s.state)).toEqual(['todo', 'todo', 'todo', 'todo', 'todo']);
        expect(harnessSteps({ op: 'update', phase: 'draining' }).map((s) => s.state)).toEqual(['done', 'done', 'done', 'current', 'todo']);
        expect(harnessSteps({ op: 'remove', phase: 'applying' }).map((s) => [s.phase, s.state])).toEqual([['applying', 'current']]);
        expect(pendingLine(request({}))).toBe('Updating Claude Code to 2.1.0 (when its turns end). Asked — waiting for the daemon to report.');
        expect(pendingLine(request({ op: 'install', runtime: 'copilot-cli', to: '1.0.14', mode: 'now', phase: 'downloading' }))).toBe('Installing Copilot CLI 1.0.14 (now).');
        expect(pendingLine(request({ op: 'remove', runtime: 'codex-cli', phase: 'applying' }))).toBe('Removing Codex.');
        expect(outcomeLine(request({}))).toBeNull();
        expect(outcomeLine(request({ status: 'done' }))).toBe('Claude Code was updated to 2.1.0.');
        expect(outcomeLine(request({ status: 'done', op: 'install', runtime: 'copilot-cli', to: '1.0.14' }))).toBe('Copilot CLI 1.0.14 is installed.');
        expect(outcomeLine(request({ status: 'done', op: 'remove', runtime: 'codex-cli' }))).toBe('Codex was removed.');
        expect(outcomeLine(request({ status: 'error', error: { code: 'checksum', message: 'x' } }))).toBe('The update of Claude Code did not go through: the download did not match the release. Nothing was changed.');
        expect(harnessErrorText({ code: 'in-use', message: 'environment codex runs on codex-cli; remove it first' })).toBe('environment codex runs on codex-cli; remove it first');
        expect(harnessErrorText({ code: 'interrupted', message: '' })).toMatch(/restarted before it finished/);
        const refusal = Object.assign(new Error('in-use: environment codex on machine "m" runs on codex-cli; remove it first'), { status: 409 });
        expect(refusalText(refusal)).toBe('environment codex on machine "m" runs on codex-cli; remove it first');
        expect(refusalText(Object.assign(new Error('machine-offline: x'), { status: 503 }))).toMatch(/^The machine is offline/);
    });

    it('places a runtime on a machine for the plugin page: has it, lacks it, broken, or a daemon that predates harnesses', () => {
        const m = { machineId: 'alien01', name: 'alien01', online: true, ...opsHarness('alien01') };
        expect(runtimeOnMachine('claude-code', m)).toEqual({ machineId: 'alien01', name: 'alien01', online: true, state: 'has', version: '2.0.0', update: '2.1.0' });
        expect(runtimeOnMachine('codex-cli', m)).toMatchObject({ state: 'has', version: '0.46.0' });
        expect(runtimeOnMachine('codex-cli', m).update).toBeUndefined();
        expect(runtimeOnMachine('copilot-cli', m)).toMatchObject({ state: 'lacks' });
        expect(runtimeOnMachine('gemini-cli', m)).toMatchObject({ state: 'lacks' });
        expect(runtimeOnMachine('codex-cli', { ...m, ...opsHarnessStates.broken.view })).toMatchObject({ state: 'broken' });
        expect(runtimeOnMachine('claude-code', { machineId: 'nuc-lab', name: 'nuc-lab', online: false })).toMatchObject({ state: 'unknown' });
        expect(runtimeMachineLine(runtimeOnMachine('claude-code', { ...m, online: false }))).toBe('2.0.0 · 2.1.0 available · offline');
    });

    it('files harness.changed under Machines in History, and the notice links to the runtimes card', () => {
        const e = (data: Record<string, unknown>) => ({ key: 'k', seq: 1, kind: 'harness.changed', at: 0, by: 'user:u', summary: '', data: { machineId: 'alien01', runtime: 'claude-code', op: 'update', ...data } }) as unknown as AuditEvent;
        expect(HISTORY_KIND_FILTERS.find((f) => f.id === 'machines')!.kinds).toContain('harness.changed');
        expect(kindLabel(e({ outcome: 'done' }))).toBe('harness updated');
        expect(kindLabel(e({ outcome: 'done', op: 'install' }))).toBe('harness installed');
        expect(kindLabel(e({ outcome: 'failed', error: 'x' }))).toBe('harness failed');
        expect(toneOf(e({ outcome: 'done' }))).toBe('live');
        expect(toneOf(e({ outcome: 'timeout' }))).toBe('failed');
        expect(refOf(e({ outcome: 'done' }))).toEqual({ label: 'claude-code', href: '/machines/alien01#runtimes' });
        expect(MACHINE_NOTICE['harness-update-available']).toEqual({ label: 'RUNTIME UPDATE', tone: 'needs-you' });
    });
});

async function card(props: { rows?: ReturnType<typeof harnessRows>; current?: HarnessResultView | null; able?: boolean; online?: boolean; failure?: { runtime: string; text: string } } = {}) {
    const asked: HarnessAsk[] = [];
    const root = await mountAt('/machines/alien01', (
        <HarnessCard
            rows={props.rows ?? harnessRows(source())}
            name="alien01"
            os="windows"
            origin="https://agentic.example"
            online={props.online ?? true}
            able={props.able ?? true}
            current={props.current ?? null}
            failure={props.failure ?? null}
            onRequest={(a: HarnessAsk) => { asked.push(a); }}
        />
    ));
    await tick();
    return { root, asked, section: root.querySelector<HTMLElement>('[data-harness-card]')! };
}

const rowEl = (root: ParentNode, runtime: string) => root.querySelector<HTMLElement>(`[data-harness-row="${runtime}"]`)!;

describe('the runtimes card (#370)', () => {
    it('lists each runtime with its status, versions and environments; Install goes out at once', async () => {
        const { section, asked } = await card();
        expect([...section.querySelectorAll('[data-harness-row]')].map((r) => r.getAttribute('data-harness-row'))).toEqual(['claude-code', 'codex-cli', 'copilot-cli']);
        const cc = rowEl(section, 'claude-code');
        expect(text(cc.querySelector('[data-harness-name]'))).toBe('Claude Code');
        expect(text(cc.querySelector('[data-harness-version]'))).toBe('2.0.0 · 2.1.0 available');
        expect(text(cc.querySelector('[data-harness-envs]'))).toBe('Used by work, personal');
        expect(text(rowEl(section, 'copilot-cli').querySelector('[data-harness-head]'))).toContain('NOT INSTALLED');
        buttonNamed(rowEl(section, 'copilot-cli'), 'Install').click();
        expect(asked).toEqual([{ op: 'install', runtime: 'copilot-cli', mode: 'drain' }]);
    });

    it('turns Remove off, with the reason, while an environment runs on the runtime', async () => {
        const { section } = await card();
        const remove = buttonNamed(rowEl(section, 'claude-code'), 'Remove…');
        expect(remove.disabled).toBe(true);
        expect(text(rowEl(section, 'claude-code').querySelector('[data-harness-remove-reason]'))).toBe('Used by work, personal. Remove those environments first.');
        // Codex: nobody runs on it in this source — Remove asks first.
        expect(buttonNamed(rowEl(section, 'codex-cli'), 'Remove…').disabled).toBe(false);
    });

    it('confirms Update by naming the turns it interrupts on that runtime, and sends the chosen mode', async () => {
        const { section, asked } = await card();
        buttonNamed(rowEl(section, 'claude-code'), 'Update…').click();
        await tick();
        const popup = openPopup()!;
        expect(text(popup.querySelector('[data-scope="dialog"][data-part="title"]'))).toBe('Update Claude Code on alien01 to 2.1.0?');
        expect(text(popup.querySelector('[data-scope="dialog"][data-part="description"]'))).toMatch(/^It waits for 2 running turns on Claude Code to end/);
        expect([...popup.querySelectorAll('[data-update-turn]')].map((li) => li.getAttribute('data-update-turn'))).toEqual(['s_run', 's_prompted']);
        expect(popup.querySelector<HTMLAnchorElement>('[data-update-turn="s_run"] a')!.getAttribute('href')).toBe('/tasks/t1');
        change(popup, 'select[name="harness-mode"]', 'now');
        await tick();
        expect(text(popup.querySelector('[data-scope="dialog"][data-part="description"]'))).toMatch(/^2 running turns on Claude Code will be interrupted and offered Resume/);
        buttonNamed(popup, 'Interrupt 2 and update').click();
        await tick();
        expect(asked).toEqual([{ op: 'update', runtime: 'claude-code', mode: 'now' }]);
    });

    it('follows a pending request phase by phase on its row, with every action waiting; then its outcome', async () => {
        const pending = await card({ current: request({ phase: 'draining' }) });
        const cc = rowEl(pending.section, 'claude-code');
        expect(text(cc.querySelector('[data-harness-pending] [data-card-text]'))).toBe('Updating Claude Code to 2.1.0 (when its turns end).');
        expect(cc.querySelector('[data-update-phase="draining"]')!.getAttribute('data-phase-state')).toBe('current');
        expect(cc.querySelector('[data-update-phase="verifying"]')!.getAttribute('data-phase-state')).toBe('done');
        expect(text(cc.querySelector('[data-update-draining]'))).toContain('Waiting for 2 running turns on Claude Code');
        expect(buttonNamed(rowEl(pending.section, 'copilot-cli'), 'Install').disabled).toBe(true);
        expect(rowEl(pending.section, 'codex-cli').querySelector('[data-harness-pending]')).toBeNull();

        const failed = await card({ current: request({ status: 'error', phase: 'failed', error: { code: 'download-failed', message: 'HTTP 404' } }) });
        const outcome = rowEl(failed.section, 'claude-code').querySelector('[data-harness-outcome]')!;
        expect(outcome.getAttribute('role')).toBe('alert');
        expect(text(outcome)).toBe('The update of Claude Code did not go through: the download failed (HTTP 404). Nothing was changed.');
        expect(buttonNamed(rowEl(failed.section, 'copilot-cli'), 'Install').disabled).toBe(false);
    });

    it('a daemon without the harness feature gets the installer line; an offline one waits; a refusal lands on its row', async () => {
        const old = await card({ able: false });
        expect(old.section.querySelector('[data-harness-list]')).toBeNull();
        expect(text(old.section.querySelector('[data-update-reinstall] [data-command-well] code'))).toBe("irm 'https://agentic.example/install.ps1' | iex");
        const offline = await card({ online: false });
        expect(text(offline.section.querySelector('[data-env-note]'))).toMatch(/offline/);
        expect(buttonNamed(rowEl(offline.section, 'copilot-cli'), 'Install').disabled).toBe(true);
        const refused = await card({ failure: { runtime: 'codex-cli', text: 'environment codex runs on codex-cli; remove it first' } });
        expect(text(rowEl(refused.section, 'codex-cli').querySelector('[data-harness-error]'))).toBe('environment codex runs on codex-cli; remove it first');
    });
});

describe('/machines/:id, /machines and /plugins/:id on mock data (#370)', () => {
    it('the mock Machine page carries the runtimes card with a preview of every state, and an Install goes pending', async () => {
        const root = await mountRoute('/machines/alien01');
        const section = root.querySelector<HTMLElement>('[data-harness-card]')!;
        expect(section.id).toBe('runtimes');
        expect([...section.querySelectorAll('[data-harness-row]')].map((r) => r.getAttribute('data-harness-row'))).toEqual(['claude-code', 'codex-cli', 'copilot-cli']);
        const options = [...section.querySelectorAll<HTMLOptionElement>('select[name="harness-preview"] option')].map((o) => o.value).filter(Boolean);
        expect(options).toEqual(Object.keys(opsHarnessStates));
        buttonNamed(rowEl(section, 'copilot-cli'), 'Install').click();
        await tick();
        expect(rowEl(root, 'copilot-cli').querySelector('[data-update-phase="downloading"]')!.getAttribute('data-phase-state')).toBe('current');
        change(section, 'select[name="harness-preview"]', 'no-feature');
        await tick();
        expect(root.querySelector('[data-harness-card] [data-update-reinstall]')).not.toBeNull();
    });

    it('the Machines list pills a machine with a runtime update', async () => {
        const root = await mountRoute('/machines');
        expect(text(root.querySelector('[data-machine-group][data-machine="alien01"] .ag-harness-badge'))).toBe('1 RUNTIME UPDATE');
        expect(root.querySelector('[data-machine-group][data-machine="nuc-lab"] .ag-harness-badge')).toBeNull();
    });

    it('a harness runtime’s plugin page lists the machines that have it or lack it, linking to their runtimes card', async () => {
        const root = await mountRoute('/plugins/copilot-cli');
        const section = root.querySelector<HTMLElement>('[data-runtime-machines]')!;
        expect([...section.querySelectorAll('[data-runtime-machine]')].map((li) => [li.getAttribute('data-runtime-machine'), li.getAttribute('data-state')])).toEqual([['alien01', 'lacks'], ['nuc-lab', 'unknown']]);
        expect(section.querySelector<HTMLAnchorElement>('[data-runtime-machine="alien01"] a')!.getAttribute('href')).toBe('/machines/alien01#runtimes');
        const cc = await mountRoute('/plugins/claude-code');
        expect(text(cc.querySelector('[data-runtime-machine="alien01"] [data-runtime-machine-version]'))).toBe('2.0.0 · 2.1.0 available');
        // A newer build waits: Update goes to the machine's runtimes card, where it is applied (#600); none without one.
        expect(cc.querySelector<HTMLAnchorElement>('[data-runtime-machine="alien01"] [data-runtime-machine-update] a')!.getAttribute('href')).toBe('/machines/alien01#runtimes');
        expect(section.querySelector('[data-runtime-machine-update]')).toBeNull();
        // Installed: the next step is an environment on it (#527); lacking it, there is none to add yet.
        expect(cc.querySelector<HTMLAnchorElement>('[data-runtime-machine="alien01"] [data-runtime-machine-env] a')!.getAttribute('href')).toBe('/machines/alien01#environments');
        expect(section.querySelector('[data-runtime-machine="alien01"] [data-runtime-machine-env]')).toBeNull();
        const api = await mountRoute('/plugins/anthropic-api');
        expect(api.querySelector('[data-runtime-machines]')).toBeNull();
    });
});
