/**
 * The "Limits" card (#270, part of #261; OPS-07): how close each account is
 * to its provider's limits — Claude Code's `/usage` per environment, the
 * platform runtime's honest "not reported". `LimitsSection` draws rows;
 * `LiveLimits` reads every paired machine's `Machine.get` live for them.
 * Informational only: nothing here moves work between accounts (EXE-12).
 */
import { component, effect, onUnmounted, signal, type Define, type JSXElement } from 'sigx';
import { useActorState } from '@sigx/actors/app';
import { Card } from '@sigx/zero';
import type { MachineView } from '@agentic/platform';
import { Label, QuotaPanel } from '@agentic/ui';
import { useActorDefs, useViewer } from '../../actors/defs';
import { machineKeyOf, workspaceKeyOf } from '../../actors/keys';
import { limitAccountsOf, type LimitAccount } from './limit-accounts';

export type LimitsSectionProps =
    & Define.Prop<'accounts', readonly LimitAccount[], true>
    /** One line per account: the window closest to its limit (Home's rail). */
    & Define.Prop<'compact', boolean>
    & Define.Prop<'loading', boolean>;

/** On `/usage` a card of its own (zero's `Card`); compact, inside Home's "Usage limits" panel, just the rows. */
export const LimitsSection = component<LimitsSectionProps>(({ props }) => () => {
    const busy = props.loading ? 'true' : undefined;
    const rows = [
        props.accounts.length === 0 && !props.loading ? <p data-panel-note>No accounts yet. Pair a machine and add an environment to see its limits.</p> : null,
        <div data-limits-grid>
            {props.accounts.map((a) => (
                <div data-limit-account={a.key}>
                    <QuotaPanel snapshot={a.snapshot} title={a.title} compact={props.compact} />
                    <span data-limit-caption>{a.caption}</span>
                </div>
            ))}
        </div>
    ];
    if (props.compact) {
        return <section data-usage-limits data-compact="" aria-label="Usage limits" aria-busy={busy}>{rows}</section>;
    }
    return (
        <Card.Root asChild data-usage-limits="" aria-label="Usage limits" aria-busy={busy}>
            {(part: Record<string, unknown>) => (
                <section {...part}>
                    <Card.Body data-card-body="">
                        <div data-label-row>
                            <Label>Limits · per account, as the provider reports them</Label>
                        </div>
                        {rows}
                    </Card.Body>
                </section>
            )}
        </Card.Root>
    );
});

/** Renderless: keeps one machine's record current (the `ChatWatch` pattern). */
const MachineQuotaWatch = component<{ id: string; workspaceId: string; onRead: (view: MachineView) => void }>(({ props }) => {
    const defs = useActorDefs();
    const view = useActorState(defs.Machine, () => [machineKeyOf(props.workspaceId, props.id), 'get'] as const, { live: true });
    const stop = effect(() => {
        if (view.value) props.onRead(view.value);
    });
    onUnmounted(stop);
    return (): JSXElement => null;
});

export const LiveLimits = component<Define.Prop<'compact', boolean>>(({ props }) => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const index = useActorState(defs.Workspace, () => viewer.workspaceId && ([workspaceKeyOf(viewer.workspaceId), 'listMachines'] as const), { live: true });
    const reads = signal<{ map: Record<string, MachineView> }>({ map: {} });
    return (): JSXElement => {
        const ws = viewer.workspaceId;
        const paired = (index.value ?? []).filter((m) => m.status === 'paired');
        const views = paired.map((m) => reads.map[m.id]).filter((v): v is MachineView => !!v);
        return (
            <>
                {ws ? paired.map((m) => <MachineQuotaWatch id={m.id} workspaceId={ws} onRead={(v) => { reads.map = { ...reads.map, [m.id]: v }; }} />) : null}
                <LimitsSection accounts={limitAccountsOf(views)} compact={props.compact} loading={index.loading || views.length < paired.length} />
            </>
        );
    };
});
