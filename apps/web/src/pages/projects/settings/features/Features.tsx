/**
 * Settings › Features (#736): the page over its data. Live, the catalogue is `Registry.projectFeatures()` (#735) joined
 * with each manifest's settings schema from `Registry.overview()`, and every change is `Workspace.upsertProject`; the
 * layout's live `Workspace.projects()` read brings the record back. On mock data the catalogue is the board's
 * (`mock/projects/features.ts`) and a change merges into the page's copy of the project.
 */
import { component, signal } from 'sigx';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import type { ProjectPatch } from '@agentic/core';
import { useActorDefs, useViewer } from '../../../../actors/defs';
import { registryKeyOf, workspaceKeyOf } from '../../../../actors/keys';
import { dataMode } from '../../../../data-mode';
import { MOCK_FEATURE_CATALOGUE } from '../../../../mock/projects/features';
import { projectFeatureCatalogue } from '../../../../plugins/features';
import type { ProjectPageProps } from '../../layout/types';
import { FeaturesView } from './FeaturesView';
import { applyFeaturesPatch, featureEntriesOf } from './model';

const MockFeatures = component<ProjectPageProps>(({ props }) => {
    const st = signal({ features: props.project.features });
    const save = async (patch: ProjectPatch): Promise<void> => { st.features = applyFeaturesPatch(st.features, patch); };
    return () => <FeaturesView project={{ ...props.project, features: st.features }} entries={MOCK_FEATURE_CATALOGUE} save={save} />;
}, { name: 'MockProjectFeatures' });

const LiveFeatures = component<ProjectPageProps>(({ props }) => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const views = useActorState(defs.Registry, () => viewer.workspaceId && ([registryKeyOf(viewer.workspaceId), 'projectFeatures'] as const), { live: true });
    const overview = useActorState(defs.Registry, () => viewer.workspaceId && ([registryKeyOf(viewer.workspaceId), 'overview'] as const), { live: true });
    const save = async (patch: ProjectPatch): Promise<void> => {
        const ws = viewer.workspaceId;
        if (!ws) throw new Error('Sign in to change the project.');
        await actor(defs.Workspace, workspaceKeyOf(ws)).upsertProject(patch);
    };
    return () => (
        <FeaturesView
            project={props.project}
            entries={featureEntriesOf(views.value ?? [], overview.value?.plugins ?? [], projectFeatureCatalogue)}
            loading={views.loading}
            save={save}
        />
    );
}, { name: 'LiveProjectFeatures' });

/** Settings › Features: the enabled features, their slot marks, the add-a-feature catalogue and the detail panel. */
export const ProjectFeatures = component<ProjectPageProps>(({ props }) => () => (dataMode() === 'live'
    ? <LiveFeatures project={props.project} />
    : <MockFeatures project={props.project} />), { name: 'ProjectFeatures' });
