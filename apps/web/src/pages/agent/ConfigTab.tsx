import { component, signal, type Define } from 'sigx';
import { Card } from '@sigx/zero-daisyui/components';
import { AGENT_FIELDS as F, AgentForm, Button, Label, Stack, TextField, VersionItem, type AgentFormRailProps, type FieldOption } from '@agentic/ui';
import type { AgentConfig, AgentConfigVersion } from '@agentic/core';
import { agents } from '../../mock/data';
import type { AgentProfile } from '../../mock/agents';
import type { AgentCatalog } from './catalog';
import { dateTime } from './format';

/** Where a save and a rollback go on the platform (#35): each resolves to the version the Agent actor recorded. */
export interface ConfigStore {
    save(config: AgentConfig, reason: string): Promise<AgentConfigVersion>;
    rollback(version: number): Promise<AgentConfigVersion>;
    /** The config the actor holds now — what the form restarts from after a rollback (#169). */
    config?(): Promise<AgentConfig>;
    /**
     * Review the proposed version (#153, LRN-08): accepting resolves to the
     * version the actor recorded and the config it now holds; rejecting to `null`.
     */
    review?(decision: 'accept' | 'reject'): Promise<{ readonly version: AgentConfigVersion; readonly config: AgentConfig } | null>;
}

export type ConfigTabProps =
    & Define.Prop<'profile', AgentProfile, true>
    /** Live mode: persist through the actor; absent, a submit appends a version locally (the mock page). */
    & Define.Prop<'store', ConfigStore>
    /** The collaborator options; default: the mock workspace's other agents. */
    & Define.Prop<'collaborators', readonly FieldOption[]>
    /** The environment picker's options (`execution.defaultEnvironmentId`, #144); default: the mock workspace's. */
    & Define.Prop<'environments', readonly FieldOption[]>
    /** The other pickers' options on the platform (`./catalog`); a list it leaves out keeps the design track's. */
    & Define.Prop<'catalog', AgentCatalog>;

const SKILLS = [{ value: 'sigx-actors' }, { value: 'zero-anatomy' }, { value: 'git-worktree' }, { value: 'web-research' }];
const TOOLS = [{ value: 'Read' }, { value: 'Edit' }, { value: 'Bash' }, { value: 'WebFetch' }, { value: 'memory.*' }, { value: 'memory.search' }, { value: 'task.report' }, { value: 'ask_user' }];
const CONNECTORS = [{ value: 'github', label: 'github (mcp)' }];
const ENVIRONMENTS = [
    { value: 'env_work', label: 'andy-desktop / claude-code / work' },
    { value: 'env_personal', label: 'andy-desktop / claude-code / personal' },
    { value: 'env_platform', label: 'platform / anthropic-api / byo-key' }
];
const SCOPES = [{ value: 'agentic-repo' }, { value: 'team' }];

/** "Changes apply to new sessions. 1 active session keeps v7." (AGT-07) */
export function applyLine(activeOnOlder: number, current: number): string {
    if (activeOnOlder === 0) return 'Changes apply to new sessions.';
    return `Changes apply to new sessions. ${activeOnOlder} active ${activeOnOlder === 1 ? 'session keeps' : 'sessions keep'} v${current}.`;
}

/**
 * Config: `AgentForm` in the sections layout, fluid form + 360 rail
 * (`docs/design/HANDOFF.md` → Agent config). The rail carries the save card
 * — only while the form is dirty — and the versions list: proposed
 * (NEEDS REVIEW), current, past (roll back). With a `store` (#35, the live
 * page) a submit and a rollback go through the Agent actor and the rail
 * shows the version it recorded; without one a submit appends a version
 * locally so the mock page behaves end to end.
 */
export const ConfigTab = component<ConfigTabProps>(({ props }) => {
    const p = props.profile;
    const state = signal({
        config: p.config as AgentConfig,
        versions: [...p.versions] as AgentConfigVersion[],
        proposed: p.proposed as AgentConfigVersion | undefined,
        activeOnOlder: p.activeOnOlder
    });
    const ui = signal({ busy: false, error: '' });
    const current = () => state.versions[0]?.version ?? 1;
    const prepend = (v: AgentConfigVersion) => { state.versions = [v, ...state.versions]; };
    const persist = async (run: () => Promise<AgentConfigVersion>): Promise<void> => {
        ui.busy = true;
        ui.error = '';
        try {
            prepend(await run());
        } catch (e) {
            ui.error = e instanceof Error ? e.message : String(e);
        } finally {
            ui.busy = false;
        }
    };

    const onSubmit = ({ config, reason }: { config: AgentConfig; reason: string }) => {
        const store = props.store;
        if (store) void persist(() => store.save(config, reason || 'Edited in the web UI'));
        else prepend({ version: current() + 1, at: Date.now(), by: 'Andy', reason: reason || 'Edited in the web UI' });
    };
    const rollback = (version: number, form: AgentFormRailProps) => {
        const store = props.store;
        if (store) {
            void persist(async () => {
                const recorded = await store.rollback(version);
                // The draft still holds the config rolled away from: a later save would write it back.
                const config = await store.config?.();
                if (config) {
                    state.config = config;
                    form.reset();
                }
                return recorded;
            });
        } else prepend({ version: current() + 1, at: Date.now(), by: 'Andy', reason: `Rolled back to v${version}.` });
    };

    // On the platform the proposal is the actor's (it leaves the profile once reviewed); the mock page keeps its own.
    const proposed = (): AgentConfigVersion | undefined => (props.store?.review ? props.profile.proposed : state.proposed);
    const review = async (decision: 'accept' | 'reject', form: AgentFormRailProps): Promise<void> => {
        const run = props.store?.review;
        if (!run) {
            state.proposed = undefined;
            return;
        }
        ui.busy = true;
        ui.error = '';
        try {
            const accepted = await run(decision);
            if (accepted) {
                // The accepted patch changed the instructions: the form restarts from the config the actor holds.
                state.config = accepted.config;
                prepend(accepted.version);
                form.reset();
            }
        } catch (e) {
            ui.error = e instanceof Error ? e.message : String(e);
        } finally {
            ui.busy = false;
        }
    };

    const rail = (form: AgentFormRailProps) => {
        const dirty = form.dirty();
        const pending = proposed();
        return (
            <div data-agent-rail="">
            <Stack gap="lg">
                {dirty ? (
                    <div data-save-card="">
                    <Card>
                        <Card.Body>
                            <Stack gap="md">
                                <span data-save-title=""><span data-save-dot="" aria-hidden="true" />Unsaved changes</span>
                                <TextField model={() => form.draft.reason} name={F.reason} label="Reason for this version" />
                                <div data-save-actions="">
                                    <Button intent="primary" type="submit" disabled={ui.busy}>Save as v{current() + 1}</Button>
                                    <Button onClick={() => form.reset()}>Reset</Button>
                                </div>
                                {ui.error ? <p data-save-error="" role="alert">{ui.error}</p> : null}
                            </Stack>
                        </Card.Body>
                    </Card>
                    </div>
                ) : null}
                <div data-versions-card="">
                <Card>
                    <Card.Body>
                        <Stack gap="md">
                            <Label>Versions</Label>
                            <ul data-versions-list="">
                                {pending ? (
                                    <VersionItem version={pending} state="proposed" when={dateTime(pending.at)}
                                        onReview={() => { void review('accept', form); }}
                                        onDismiss={() => { void review('reject', form); }} />
                                ) : null}
                                {state.versions.map((v, i) => (
                                    <VersionItem version={v} state={i === 0 ? 'current' : 'past'} when={dateTime(v.at)} onRollback={(version: number) => rollback(version, form)} />
                                ))}
                            </ul>
                            <p data-apply-line="">{applyLine(props.store ? props.profile.activeOnOlder : state.activeOnOlder, current())}</p>
                        </Stack>
                    </Card.Body>
                </Card>
                </div>
            </Stack>
            </div>
        );
    };

    return () => (
        <div data-agent-config="">
            <AgentForm
                model={() => state.config}
                layout="sections"
                approvalControl="segmented"
                skills={props.catalog?.skills ?? SKILLS}
                tools={props.catalog?.tools ?? TOOLS}
                connectors={props.catalog?.connectors ?? CONNECTORS}
                environments={props.environments ?? props.catalog?.environments ?? ENVIRONMENTS}
                memoryScopes={props.catalog?.memoryScopes ?? SCOPES}
                agents={props.collaborators ?? agents.filter((a) => a.id !== p.id).map((a) => ({ value: a.id, label: a.name }))}
                onSubmit={onSubmit}
                slots={{ rail }}
            />
        </div>
    );
}, { name: 'ConfigTab' });
