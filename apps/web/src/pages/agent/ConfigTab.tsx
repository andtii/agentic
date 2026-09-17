import { component, signal, type Define } from 'sigx';
import { Card } from '@sigx/zero-daisyui/components';
import { AGENT_FIELDS as F, AgentForm, Button, Label, Stack, TextField, VersionItem, type AgentFormRailProps } from '@agentic/ui';
import type { AgentConfig, AgentConfigVersion } from '@agentic/core';
import { agents } from '../../mock/data';
import type { AgentProfile } from '../../mock/agents';
import { dateTime } from './format';

export type ConfigTabProps = Define.Prop<'profile', AgentProfile, true>;

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
 * (NEEDS REVIEW), current, past (roll back). Persistence is #35: a submit
 * appends a version locally so the page behaves end to end on mock data.
 */
export const ConfigTab = component<ConfigTabProps>(({ props }) => {
    const p = props.profile;
    const state = signal({
        config: p.config as AgentConfig,
        versions: [...p.versions] as AgentConfigVersion[],
        proposed: p.proposed as AgentConfigVersion | undefined,
        activeOnOlder: p.activeOnOlder
    });
    const current = () => state.versions[0]?.version ?? 1;

    const onSubmit = ({ reason }: { config: AgentConfig; reason: string }) => {
        state.versions = [{ version: current() + 1, at: Date.now(), by: 'Andy', reason: reason || 'Edited in the web UI' }, ...state.versions];
    };
    const rollback = (version: number) => {
        state.versions = [{ version: current() + 1, at: Date.now(), by: 'Andy', reason: `Rolled back to v${version}.` }, ...state.versions];
    };

    const rail = (form: AgentFormRailProps) => {
        const dirty = form.dirty();
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
                                    <Button intent="primary" type="submit">Save as v{current() + 1}</Button>
                                    <Button onClick={() => form.reset()}>Reset</Button>
                                </div>
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
                                {state.proposed ? (
                                    <VersionItem version={state.proposed} state="proposed" when={dateTime(state.proposed.at)}
                                        onReview={() => { state.proposed = undefined; }}
                                        onDismiss={() => { state.proposed = undefined; }} />
                                ) : null}
                                {state.versions.map((v, i) => (
                                    <VersionItem version={v} state={i === 0 ? 'current' : 'past'} when={dateTime(v.at)} onRollback={rollback} />
                                ))}
                            </ul>
                            <p data-apply-line="">{applyLine(state.activeOnOlder, current())}</p>
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
                skills={SKILLS}
                tools={TOOLS}
                connectors={CONNECTORS}
                environments={ENVIRONMENTS}
                memoryScopes={SCOPES}
                agents={agents.filter((a) => a.id !== p.id).map((a) => ({ value: a.id, label: a.name }))}
                onSubmit={onSubmit}
                slots={{ rail }}
            />
        </div>
    );
}, { name: 'ConfigTab' });
