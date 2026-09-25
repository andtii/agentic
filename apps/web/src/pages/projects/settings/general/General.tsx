/**
 * Settings › General (#733): the project's name, description and square colour, saved on their own; and Delete
 * project. The other sections of the old project form are their own tabs (Members, Folders, Connectors, Features).
 */
import { component, signal, watch } from 'sigx';
import { PROJECT_COLORS, type ProjectColor, type ProjectPatch } from '@agentic/core';
import { Button, ConfirmDialog, SelectField, TextField, TextareaField } from '@agentic/ui';
import type { ProjectPageProps } from '../../layout/types';
import { projectDraftOf, validateProjectDraft } from '../../model';
import { useProjectRemove, useTabSave } from './sources';
import { TabFrame, tabPatchOf } from './TabFrame';

const COLOR_OPTIONS = [
    { value: '', label: 'Picked from the name' },
    ...PROJECT_COLORS.map((c) => ({ value: c, label: c[0]!.toUpperCase() + c.slice(1) }))
];

export const ProjectGeneral = component<ProjectPageProps>(({ props }) => {
    const save = useTabSave();
    const remove = useProjectRemove();
    const draftOf = () => ({ ...projectDraftOf(props.project), color: (props.project.color ?? '') as string, attempted: false, removing: false, removeError: '' });
    const st = signal(draftOf());
    watch(() => props.project.id, () => Object.assign(st, draftOf()));
    const patchNow = (): ProjectPatch => {
        const color: ProjectPatch['color'] = st.color ? (st.color as ProjectColor) : props.project.color ? null : undefined;
        return { ...tabPatchOf(st, props.project, ['name', 'description']), ...(color !== undefined ? { color } : {}) };
    };
    const submit = (): void => {
        st.attempted = true;
        if (Object.keys(validateProjectDraft(st)).length) return;
        void save.run(patchNow());
    };
    const confirmRemove = async (): Promise<void> => {
        st.removing = false;
        try {
            await remove(props.project.id);
        } catch (e) {
            st.removeError = e instanceof Error ? e.message : String(e);
        }
    };
    return () => {
        const errors = st.attempted ? validateProjectDraft(st) : {};
        return (
            <>
            <TabFrame
                tab="general"
                title="General"
                save={save}
                patch={patchNow()}
                error={st.removeError}
                onSubmit={submit}
                slots={{ actions: () => <Button intent="danger" icon="trash" disabled={save.state.busy} onClick={() => { st.removing = true; }}>Delete project</Button> }}
            >
                <div data-project-section="identity">
                    <TextField model={() => st.name} name="project-name" label="Name" required error={errors.name} />
                    <TextareaField model={() => st.description} name="project-description" label="Description" rows={2} description="What the project is, for the people and agents in it." />
                    <SelectField model={() => st.color} name="project-color" label="Colour" options={COLOR_OPTIONS} description="The project square's colour in the sidebar and on the cards." />
                </div>
            </TabFrame>
            <ConfirmDialog
                model={() => st.removing}
                title={`Delete ${props.project.name}?`}
                description="Chats, tasks and schedules that name it keep the id and show it as removed; nothing on any machine is touched."
                confirmLabel="Delete project"
                onConfirm={() => { void confirmRemove(); }}
                onCancel={() => { st.removing = false; }}
            />
            </>
        );
    };
}, { name: 'ProjectGeneral' });
