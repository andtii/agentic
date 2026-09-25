/**
 * The frame the General, Members, Folders and Connectors tabs share (#733): the tab's heading and hint, its fields,
 * then its own Save — each tab saves only its part of the project — with the refusal inline and "Saved" once it lands.
 */
import { component, type Define } from 'sigx';
import type { ProjectPatch, ProjectRecord } from '@agentic/core';
import { Button, ErrorNote } from '@agentic/ui';
import { projectPatchOf, type ProjectDraft } from '../../model';
import type { TabSave } from './sources';

/** The part of the whole-form patch (`projectPatchOf`) a tab owns, always with the project's id. */
export function tabPatchOf(draft: ProjectDraft, project: ProjectRecord, keys: readonly (keyof ProjectPatch)[]): ProjectPatch {
    const full = projectPatchOf(draft, project) as Record<string, unknown>;
    const out: Record<string, unknown> = { id: project.id };
    for (const key of keys) if (Object.hasOwn(full, key)) out[key] = full[key];
    return out as ProjectPatch;
}

export type TabFrameProps =
    & Define.Prop<'tab', string, true>
    & Define.Prop<'title', string, true>
    & Define.Prop<'hint', string>
    & Define.Prop<'save', TabSave, true>
    /** What Save would send now: "Saved" shows while it is what last landed. */
    & Define.Prop<'patch', ProjectPatch | null, true>
    /** A problem of the tab's own that keeps the save back (a required name). */
    & Define.Prop<'error', string>
    & Define.Event<'submit'>
    /** Actions after Save (Delete project). */
    & Define.Slot<'actions'>
    & Define.Slot<'default'>;

export const TabFrame = component<TabFrameProps>(({ props, slots, emit }) => () => {
    const s = props.save.state;
    const error = s.error || props.error;
    return (
        <section aria-label={props.title} data-settings-tab={props.tab} data-project-settings="">
            <h2>{props.title}</h2>
            {props.hint ? <p data-project-hint>{props.hint}</p> : null}
            {slots.default?.()}
            {error ? <ErrorNote data-project-error="">{error}</ErrorNote> : null}
            <div data-project-actions>
                <Button intent="primary" loading={s.busy} onClick={() => emit('submit')}>Save</Button>
                {s.saved && props.patch && s.saved === JSON.stringify(props.patch) && !error ? <span data-project-saved role="status">Saved.</span> : null}
                {slots.actions?.()}
            </div>
        </section>
    );
}, { name: 'ProjectSettingsTabFrame' });
