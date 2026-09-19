/**
 * "Set up a runtime" on Home (#234): shown while no runtime plugin is ready,
 * one row per way to get there (`setupSteps`), gone the moment one is —
 * the Registry's `overview()` is a live read, so a key set on another page
 * or tab clears it without a reload. Nothing is drawn until both reads have
 * landed, so a runtime never flashes "needs a machine" while the machines load.
 */
import { component, type JSXElement } from 'sigx';
import { Link } from '@sigx/router';
import { useActorState } from '@sigx/actors/app';
import { Icon } from '@agentic/ui';
import { useActorDefs, useViewer } from '../../actors/defs';
import { workspaceKeyOf } from '../../actors/keys';
import { Panel } from '../../components/Panel';
import { useWorkspaceReadiness } from '../plugins/readiness';
import { setupSteps } from './setup';

export const SetupChecklist = component(() => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const readiness = useWorkspaceReadiness(defs, viewer);
    const ws = useActorState(defs.Workspace, () => viewer.workspaceId && ([workspaceKeyOf(viewer.workspaceId), 'get'] as const), { live: true });
    return (): JSXElement => {
        const overview = readiness.overview();
        const w = ws.value;
        if (!overview || !w || !readiness.facts()) return null;
        const steps = setupSteps({ plugins: overview.plugins, readiness: readiness.byId(), machines: w.machines });
        if (!steps?.length) return null;
        return (
            <div data-home-setup="">
                <Panel label="Set up a runtime" tone="needs-you">
                    <p data-panel-note>Agents need one runtime that is ready before they can start work. {steps.length > 1 ? 'Any one of these is enough.' : ''}</p>
                    <ol data-setup-steps="">
                        {steps.map((s) => (
                            <li data-setup-step={s.id}>
                                <Icon name={s.icon} size={15} />
                                <div data-setup-text="">
                                    <strong data-setup-title="">{s.title}</strong>
                                    <span data-setup-detail="">{s.detail}</span>
                                </div>
                                {s.href ? <Link to={s.href} data-setup-action="">{s.action ?? 'Open'}</Link> : null}
                            </li>
                        ))}
                    </ol>
                </Panel>
            </div>
        );
    };
}, { name: 'SetupChecklist' });
