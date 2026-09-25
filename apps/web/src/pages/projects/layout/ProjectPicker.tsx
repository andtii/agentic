/**
 * The project picker (#728; HANDOFF "Navigation inside a project" → Switcher): a dialog to jump to another project.
 * A search field over the workspace's projects, the one used last (`lastProjectId`) first under Recent, every other
 * one under All projects, and `New project`. The field is a combobox over the list: ArrowDown / ArrowUp / Home / End
 * move the active option, Enter opens it, Escape closes the dialog.
 *
 * `ProjectLayout` mounts it with the project list (mock or live); the sidebar's switcher opens it through
 * `openProjectPicker()` (#727 draws the switcher).
 */
import { component, signal, type Define, type JSXElement } from 'sigx';
import { Dialog } from '@sigx/zero';
import { useRouter } from '@sigx/router';
import type { ProjectRecord } from '@agentic/core';
import { Icon } from '@agentic/ui';

/** Whether the picker is open: the switcher writes it, the dialog reads it. */
export const projectPicker = signal<{ open: boolean }>({ open: false });

export const openProjectPicker = (): void => {
    projectPicker.open = true;
};

export interface PickerSection {
    readonly label: string;
    readonly projects: readonly ProjectRecord[];
}

const matches = (p: ProjectRecord, q: string): boolean =>
    p.name.toLowerCase().includes(q) || (p.description ?? '').toLowerCase().includes(q) || p.id.toLowerCase().includes(q);

/**
 * The picker's list: without a query, the last-used project under Recent and the rest under All projects; with one,
 * the projects whose name, description or id contain it (the last-used first) under Matches. Empty sections drop.
 */
export function pickerSections(projects: readonly ProjectRecord[], lastProjectId: string | null, query: string): PickerSection[] {
    const q = query.trim().toLowerCase();
    const recent = projects.filter((p) => p.id === lastProjectId);
    const rest = projects.filter((p) => p.id !== lastProjectId);
    const sections: PickerSection[] = q
        ? [{ label: 'Matches', projects: [...recent, ...rest].filter((p) => matches(p, q)) }]
        : [{ label: 'Recent', projects: recent }, { label: 'All projects', projects: rest }];
    return sections.filter((s) => s.projects.length > 0);
}

/** The option index a key moves to in a list of `count`, or `null` when the key does not move it. */
export function pickerMove(key: string, active: number, count: number): number | null {
    if (count === 0) return null;
    switch (key) {
        case 'ArrowDown': return (active + 1) % count;
        case 'ArrowUp': return (active - 1 + count) % count;
        case 'Home': return 0;
        case 'End': return count - 1;
        default: return null;
    }
}

const optionId = (id: string): string => `project-picker-${id}`;

export type ProjectPickerProps =
    & Define.Prop<'projects', readonly ProjectRecord[], true>
    & Define.Prop<'lastProjectId', string | null>
    /** The project open now: marked in the list. */
    & Define.Prop<'currentId', string>;

export const ProjectPicker = component<ProjectPickerProps>(({ props }) => {
    const router = useRouter();
    const st = signal({ query: '', active: 0 });

    const flat = (): ProjectRecord[] => pickerSections(props.projects, props.lastProjectId ?? null, st.query).flatMap((s) => [...s.projects]);
    const close = (): void => {
        projectPicker.open = false;
    };
    const pick = (p: ProjectRecord): void => {
        close();
        void router.push(`/projects/${p.id}`);
    };
    const newProject = (): void => {
        close();
        void router.push('/projects/new');
    };
    const onOpenChange = (open: boolean): void => {
        if (open) {
            st.query = '';
            st.active = 0;
        }
    };
    const onKeyDown = (e: KeyboardEvent): void => {
        const list = flat();
        if (e.key === 'Enter') {
            const p = list[Math.min(st.active, list.length - 1)];
            if (p) {
                e.preventDefault();
                pick(p);
            }
            return;
        }
        const next = pickerMove(e.key, Math.min(st.active, Math.max(list.length - 1, 0)), list.length);
        if (next === null) return;
        e.preventDefault();
        st.active = next;
        if (typeof document !== 'undefined') document.getElementById(optionId(list[next]!.id))?.scrollIntoView?.({ block: 'nearest' });
    };

    return (): JSXElement => {
        const sections = pickerSections(props.projects, props.lastProjectId ?? null, st.query);
        const list = sections.flatMap((s) => [...s.projects]);
        const active = list[Math.min(st.active, list.length - 1)];
        let index = 0;
        return (
            <Dialog.Root model={() => projectPicker.open} modal onOpenChange={onOpenChange}>
                <Dialog.Popup>
                    <Dialog.Title>Switch project</Dialog.Title>
                    <div data-project-picker="">
                        <label data-project-picker-search="">
                            <Icon name="search" size={15} />
                            <input
                                type="search"
                                name="project-search"
                                placeholder="Find a project"
                                aria-label="Find a project"
                                role="combobox"
                                aria-expanded="true"
                                aria-controls="project-picker-list"
                                aria-autocomplete="list"
                                aria-activedescendant={active ? optionId(active.id) : undefined}
                                autofocus
                                value={st.query}
                                onInput={(e: Event) => { st.query = (e.target as HTMLInputElement).value; st.active = 0; }}
                                onKeyDown={onKeyDown}
                            />
                        </label>
                        <div id="project-picker-list" role="listbox" aria-label="Projects" data-project-picker-list="">
                            {sections.map((s) => (
                                <div key={s.label} role="group" aria-label={s.label} data-project-picker-group="">
                                    <p data-project-picker-heading="" aria-hidden="true">{s.label}</p>
                                    {s.projects.map((p) => {
                                        const i = index++;
                                        return (
                                            <div
                                                key={p.id}
                                                id={optionId(p.id)}
                                                role="option"
                                                aria-selected={active?.id === p.id ? 'true' : 'false'}
                                                data-project-option={p.id}
                                                data-active={active?.id === p.id ? '' : undefined}
                                                data-current={p.id === props.currentId ? '' : undefined}
                                                onMouseMove={() => { if (st.active !== i) st.active = i; }}
                                                onClick={() => pick(p)}
                                            >
                                                <span data-project-option-square="" aria-hidden="true" />
                                                <span data-project-option-name="">{p.name}</span>
                                                {p.id === props.currentId ? <span data-project-option-note="">current</span> : null}
                                            </div>
                                        );
                                    })}
                                </div>
                            ))}
                            {list.length === 0 ? <p data-project-picker-empty="" role="status">No project matches “{st.query.trim()}”.</p> : null}
                        </div>
                    </div>
                    <Dialog.Footer>
                        <button type="button" data-project-picker-new="" onClick={newProject}>
                            <Icon name="plus" size={15} />
                            <span>New project</span>
                        </button>
                    </Dialog.Footer>
                </Dialog.Popup>
            </Dialog.Root>
        );
    };
}, { name: 'ProjectPicker' });
