/**
 * Settings › Features (#736, PRJ-07; the ProjectFeatures board): what the project has on — one row each with its five
 * slot marks and a switch — the Add a feature catalogue (search, category chips, tiles; a tile whose `needs` the
 * project lacks shows the reason in place of `Add`), and the 400 px detail panel for the selected feature: what each
 * slot adds here, its settings (`SchemaForm` over `projectSettings`, `Start from` a preset) and `Remove from project`.
 * Every change is one `ProjectPatch` through `save` — `Workspace.upsertProject` live, a local merge on mock data.
 */
import { component, signal, watch, type Define } from 'sigx';
import { applyProjectFeaturePreset, type ProjectPatch, type ProjectRecord } from '@agentic/core';
import { Button, ErrorNote, FilterChips, ICON_NAMES, Icon, SchemaForm, SlotMarks, Switch, type IconName, type ProjectFeatureSlot, type SchemaFormApi } from '@agentic/ui';
import { SLOT_LEGEND, catalogueTiles, categoryChips, enabledEntries, featurePatch, hasSettings, needLabel, removePatch, slotLines, unmetNeeds, type FeatureEntry, type SlotLine } from './model';

export type FeaturesViewProps =
    & Define.Prop<'project', ProjectRecord, true>
    & Define.Prop<'entries', readonly FeatureEntry[], true>
    /** The catalogue read has not landed yet. */
    & Define.Prop<'loading', boolean>
    /** Write one patch; a refusal throws and its message is shown. */
    & Define.Prop<'save', (patch: ProjectPatch) => Promise<void>, true>;

const SLOT_ICONS: Readonly<Record<ProjectFeatureSlot, IconName>> = { section: 'menu', overviewCard: 'home', workStages: 'check', chatRefPrefixes: 'chats', tools: 'brain' };

/** Manifest icon names the kit spells differently. */
const ICON_ALIASES: Readonly<Record<string, IconName>> = { code: 'terminal', 'git-branch': 'branch', calendar: 'schedules' };

const iconOf = (entry: FeatureEntry): IconName => {
    const icon = entry.ui.section?.icon;
    if (!icon) return 'plugins';
    return (ICON_NAMES as readonly string[]).includes(icon) ? (icon as IconName) : (ICON_ALIASES[icon] ?? 'plugins');
};

/** The small picture beside a slot line: the sidebar item a section adds, the stage bars work stages make. */
const preview = (entry: FeatureEntry, line: SlotLine) => {
    if (line.slot === 'section' && entry.ui.section) {
        return (
            <span data-feature-slot-preview="section">
                <Icon name={iconOf(entry)} size={13} />
                <span>{entry.ui.section.label}</span>
            </span>
        );
    }
    if (line.slot === 'workStages' && entry.ui.workStages?.length) {
        return <span data-feature-slot-preview="stages" aria-hidden="true">{entry.ui.workStages.map((s, i) => <i data-stage={s} data-lit={i < 2 ? '' : undefined} />)}</span>;
    }
    return null;
};

export const FeaturesView = component<FeaturesViewProps>(({ props }) => {
    const st = signal({
        selected: '',
        query: '',
        category: 'all',
        busy: false,
        error: '',
        preset: '',
        /** The switches, by feature id: in step with the project's features. */
        on: {} as Record<string, boolean>
    });
    /** Each settings form by feature id: switching features mounts another, and the old one's ref clears only its own. */
    const forms: Record<string, SchemaFormApi | null> = {};

    watch(
        () => props.project.features,
        (features) => { st.on = Object.fromEntries(Object.keys(features).map((id) => [id, true])); },
        { immediate: true }
    );

    const on = (): FeatureEntry[] => enabledEntries(props.entries, props.project);
    const isOn = (id: string): boolean => Object.hasOwn(props.project.features, id);
    /** The panel's feature: the one picked, else the first on. */
    const selected = (): FeatureEntry | undefined => {
        const id = st.selected;
        return (id ? on().find((e) => e.id === id) ?? props.entries.find((e) => e.id === id) : undefined) ?? on()[0];
    };

    const run = async (patch: ProjectPatch): Promise<boolean> => {
        if (st.busy) return false;
        st.busy = true;
        st.error = '';
        try {
            await props.save(patch);
            return true;
        } catch (e) {
            st.error = e instanceof Error ? e.message : String(e);
            // A refused write leaves the switches where the project is.
            st.on = Object.fromEntries(Object.keys(props.project.features).map((id) => [id, true]));
            return false;
        } finally {
            st.busy = false;
        }
    };
    const add = async (entry: FeatureEntry): Promise<void> => {
        if (await run(featurePatch(props.project, entry.id, {}))) {
            st.selected = entry.id;
            st.preset = '';
        }
    };
    const remove = async (entry: FeatureEntry): Promise<void> => {
        if (await run(removePatch(props.project, entry.id)) && st.selected === entry.id) st.selected = '';
    };
    const toggle = (entry: FeatureEntry, next: boolean): void => {
        void (next ? add(entry) : remove(entry));
    };
    const pickPreset = (entry: FeatureEntry, id: string): void => {
        st.preset = id;
        const preset = entry.presets.find((p) => p.id === id);
        const form = forms[entry.id];
        if (preset && form) form.load(applyProjectFeaturePreset(form.value(), preset));
    };
    const select = (id: string): void => {
        if (st.selected !== id) st.preset = '';
        st.selected = id;
    };

    const row = (entry: FeatureEntry) => (
        <li data-feature-row={entry.id} data-selected={selected()?.id === entry.id ? '' : undefined}>
            <button type="button" data-feature-open="" aria-pressed={selected()?.id === entry.id ? 'true' : 'false'} onClick={() => select(entry.id)}>
                <span data-feature-icon=""><Icon name={iconOf(entry)} size={16} /></span>
                <span data-feature-text="">
                    <strong data-feature-name="">{entry.name}</strong>
                    <span data-feature-description="">{entry.description}</span>
                </span>
            </button>
            <SlotMarks ui={entry.ui} instructions={entry.instructions} />
            <Switch model={[st.on, entry.id]} label={`${entry.name} on in this project`} hideLabel name={`feature-${entry.id}-on`} disabled={st.busy} onCheckedChange={(v: boolean) => toggle(entry, v)} />
        </li>
    );

    const tile = (entry: FeatureEntry) => {
        const unmet = unmetNeeds(entry, props.project);
        const reason = !entry.enabled ? 'OFF IN WORKSPACE' : unmet.length ? needLabel(unmet[0]!) : '';
        return (
            <li data-feature-tile={entry.id} data-unmet={reason ? '' : undefined} data-selected={st.selected === entry.id ? '' : undefined}>
                <div data-feature-tile-head="">
                    <button type="button" data-feature-open="" onClick={() => select(entry.id)}>
                        <span data-feature-icon=""><Icon name={iconOf(entry)} size={15} /></span>
                        <strong data-feature-name="">{entry.name}</strong>
                    </button>
                    {reason
                        ? <span data-feature-needs="">{reason}</span>
                        : <Button intent="default" disabled={st.busy} label={`Add ${entry.name}`} onClick={() => void add(entry)}>Add</Button>}
                </div>
                <p data-feature-description="">{entry.description}</p>
            </li>
        );
    };

    const detail = (entry: FeatureEntry) => {
        const enabled = isOn(entry.id);
        const unmet = unmetNeeds(entry, props.project);
        return (
            <aside data-feature-detail={entry.id} aria-label={`${entry.name} in this project`}>
                <header data-feature-detail-head="">
                    <span data-feature-icon=""><Icon name={iconOf(entry)} size={18} /></span>
                    <div>
                        <h3>{entry.name}</h3>
                        <span data-feature-meta="">project-feature · {entry.id.split('.').pop()} {entry.version}</span>
                    </div>
                    {enabled
                        ? <Switch model={[st.on, entry.id]} label={`${entry.name} on in this project`} hideLabel name={`feature-${entry.id}-detail-on`} disabled={st.busy} onCheckedChange={(v: boolean) => toggle(entry, v)} />
                        : null}
                </header>
                <h4 data-feature-kicker="">What it adds here</h4>
                {slotLines(entry).length ? (
                    <ul data-feature-slots="">
                        {slotLines(entry).map((line) => (
                            <li data-feature-slot={line.slot}>
                                <Icon name={SLOT_ICONS[line.slot]} size={14} />
                                <div>
                                    <strong>{line.title}</strong>
                                    <p>{line.text}</p>
                                    {preview(entry, line)}
                                </div>
                            </li>
                        ))}
                    </ul>
                ) : <p data-panel-note="">Nothing in the sidebar, overview, work or chats: it works behind the scenes.</p>}
                {enabled ? (
                    <div data-feature-settings="">
                        <h4 data-feature-kicker="">Settings</h4>
                        {entry.presets.length ? (
                            <label data-feature-preset="">
                                <span>Start from</span>
                                <select name={`feature-${entry.id}-preset`} disabled={st.busy} value={st.preset} onChange={(e: Event) => pickPreset(entry, (e.target as HTMLSelectElement).value)}>
                                    <option value="">Choose a preset…</option>
                                    {entry.presets.map((p) => <option value={p.id} selected={st.preset === p.id}>{p.label}</option>)}
                                </select>
                            </label>
                        ) : null}
                        {hasSettings(entry.projectSettings) ? (
                            <>
                                <SchemaForm
                                    key={entry.id}
                                    ref={(api: SchemaFormApi | null) => { forms[entry.id] = api; }}
                                    schema={entry.projectSettings}
                                    value={props.project.features[entry.id] ?? {}}
                                    name={`feature-${entry.id}`}
                                    disabled={st.busy}
                                    hideActions
                                    onSubmit={(settings: Record<string, unknown>) => void run(featurePatch(props.project, entry.id, settings))}
                                />
                                <Button intent="primary" loading={st.busy} onClick={() => forms[entry.id]?.submit()}>Save settings</Button>
                            </>
                        ) : <p data-panel-note="">No settings.</p>}
                        <div data-feature-remove="">
                            <Button intent="danger" icon="trash" disabled={st.busy} onClick={() => void remove(entry)}>Remove from project</Button>
                            <span>Items are kept for 30 days</span>
                        </div>
                    </div>
                ) : (
                    <div data-feature-settings="">
                        {unmet.length
                            ? <p data-feature-needs="">{needLabel(unmet[0]!)}: add one in Settings › Folders first.</p>
                            : entry.enabled
                                ? <Button intent="primary" icon="plus" disabled={st.busy} onClick={() => void add(entry)}>Add to project</Button>
                                : <p data-panel-note="">Turned off in the workspace: turn it on under Plugins first.</p>}
                    </div>
                )}
            </aside>
        );
    };

    return () => {
        const enabled = on();
        const tiles = catalogueTiles(props.entries, props.project, { query: st.query, category: st.category });
        const current = selected();
        return (
            <section aria-label="Features" data-settings-tab="" data-project-features-page="">
                <header data-features-intro="">
                    <h2>Features</h2>
                    <p>Features plug into this project. Each one can add a section to the sidebar, a card on the overview, stages for work, context in chats, and know-how for agents.</p>
                </header>
                {st.error ? <ErrorNote data-features-error="">{st.error}</ErrorNote> : null}
                <div data-features-grid="">
                    <div data-features-main="">
                        <div data-features-on-head="">
                            <h3>On in this project <span data-count="">{enabled.length}</span></h3>
                            <span data-features-legend="">
                                <span data-features-legend-kicker="">Plugs into</span>
                                {SLOT_LEGEND.map((l) => <span data-slot={l.slot}><Icon name={SLOT_ICONS[l.slot]} size={12} />{l.label}</span>)}
                            </span>
                        </div>
                        {enabled.length
                            ? <ul data-features-on="">{enabled.map(row)}</ul>
                            : <p data-panel-note="">No features on yet: add one below.</p>}

                        <div data-features-add-head="">
                            <h3>Add a feature</h3>
                            <label data-features-search="">
                                <Icon name="search" size={14} />
                                <input type="search" name="feature-search" placeholder="Search features" aria-label="Search features" value={st.query} onInput={(e: Event) => { st.query = (e.target as HTMLInputElement).value; }} />
                            </label>
                        </div>
                        <FilterChips model={[st, 'category']} label="Feature categories" options={categoryChips(props.entries)} />
                        {props.loading && !props.entries.length
                            ? <p data-panel-note="">Loading…</p>
                            : tiles.length
                                ? <ul data-features-catalogue="">{tiles.map(tile)}</ul>
                                : <p data-panel-note="">{st.query || st.category !== 'all' ? 'No feature matches.' : 'Every feature is on.'}</p>}
                    </div>
                    {current ? detail(current) : null}
                </div>
            </section>
        );
    };
}, { name: 'FeaturesView' });
