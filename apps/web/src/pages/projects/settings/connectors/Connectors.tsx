/**
 * Settings › Connectors (#733): the connectors every session in the project gets on top of the agent's own, as chips
 * over the enabled connector plugins. Saved on its own as the `connectors` patch.
 */
import { component, signal, watch } from 'sigx';
import { ChipInput } from '@agentic/ui';
import type { ProjectPageProps } from '../../layout/types';
import { projectDraftOf } from '../../model';
import { useConnectorOptions, useTabSave } from '../general/sources';
import { TabFrame, tabPatchOf } from '../general/TabFrame';

export const ProjectConnectors = component<ProjectPageProps>(({ props }) => {
    const save = useTabSave();
    const options = useConnectorOptions();
    const st = signal(projectDraftOf(props.project));
    watch(() => props.project.id, () => Object.assign(st, projectDraftOf(props.project)));
    const patchNow = () => tabPatchOf(st, props.project, ['connectors']);
    return () => {
        const opts = options();
        return (
            <TabFrame
                tab="connectors"
                title="Connectors"
                hint="Every session in the project gets these, on top of the agent's own."
                save={save}
                patch={patchNow()}
                onSubmit={() => { void save.run(patchNow()); }}
            >
                {opts.length || st.connectors.length
                    ? <ChipInput model={() => st.connectors} name="project-connectors" options={opts} placeholder="Add a connector…" emptyText="None." />
                    : <p data-panel-note>No connector plugins are enabled. Add one under Plugins.</p>}
            </TabFrame>
        );
    };
}, { name: 'ProjectConnectors' });
