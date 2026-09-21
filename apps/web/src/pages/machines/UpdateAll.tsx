import { component, signal, type Define } from 'sigx';
import type { MachineUpdateView } from '@agentic/platform';
import { Button, ConfirmDialog } from '@agentic/ui';
import { updatable } from './update';

/** One machine as "Update all" sees it: its update state, `null` while it loads. */
export interface UpdateAllEntry {
    readonly id: string;
    readonly name: string;
    readonly update: MachineUpdateView | null;
}

/** What asking one machine came to. */
export interface UpdateAllResult {
    readonly id: string;
    readonly name: string;
    readonly ok: boolean;
    readonly text: string;
}

/**
 * "Update all machines" on `/machines` (#367): every online machine that
 * can update itself and has a release waiting is asked to update when idle
 * (`requestUpdate({ mode: 'drain' })`), after a confirm naming them; what
 * each one answered is listed under the button.
 */
export const UpdateAll = component<Define.Prop<'machines', readonly UpdateAllEntry[], true> & Define.Prop<'results', readonly UpdateAllResult[] | null> & Define.Prop<'busy', boolean> & Define.Event<'run', readonly UpdateAllEntry[]>>(({ props, emit }) => {
    const ui = signal({ confirming: false });
    return () => {
        const targets = props.machines.filter((m) => m.update !== null && updatable(m.update));
        const results = props.results ?? [];
        if (!targets.length && !results.length) return null;
        return (
            <section data-update-all aria-label="Machine updates">
                <div data-update-all-row>
                    <span data-update-all-text>
                        {targets.length
                            ? `${targets.length} ${targets.length === 1 ? 'machine has' : 'machines have'} a daemon update waiting.`
                            : 'Every machine that can update has been asked.'}
                    </span>
                    {targets.length ? <Button intent="primary" loading={props.busy} disabled={props.busy} onClick={() => { ui.confirming = true; }}>Update all machines</Button> : null}
                </div>
                {results.length ? (
                    <ul data-update-results>
                        {results.map((r) => <li data-update-result={r.id} data-ok={r.ok ? '' : undefined}><span data-update-result-name>{r.name}</span> <span>{r.text}</span></li>)}
                    </ul>
                ) : null}
                <ConfirmDialog
                    model={() => ui.confirming}
                    title={`Update ${targets.length} ${targets.length === 1 ? 'machine' : 'machines'}?`}
                    description="Each one updates when idle: running turns end first, then its daemon restarts on the new version. Live sessions restart with it; their conversations continue."
                    dependents={targets.map((m) => `${m.name} · ${m.update?.build?.version ?? '?'} → ${m.update?.available?.version ?? '?'}`)}
                    dependentsLabel={`Machines that update · ${targets.length}`}
                    confirmLabel={`Update ${targets.length} when idle`}
                    cancelLabel="Not now"
                    danger={false}
                    onCancel={() => { ui.confirming = false; }}
                    onConfirm={() => { ui.confirming = false; emit('run', targets); }}
                />
            </section>
        );
    };
});
