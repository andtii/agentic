/**
 * Settings › Members (#733): who a chat in the project starts with, on the New chat member cards; the coordinator —
 * the project's manager, who owns the Plan and takes requests; and per member a role ("Developer") and a working limit
 * (how many plan items at once, `MEMBER_LIMIT_DEFAULT` when unset). Saved on its own as the `members` patch.
 */
import { component, signal, watch } from 'sigx';
import { MEMBER_LIMIT_DEFAULT, MEMBER_LIMIT_MAX, type AgentId, type ProjectMembers as MembersRecord, type ProjectRecord } from '@agentic/core';
import { NumberField, TextField } from '@agentic/ui';
import { MemberPicker } from '../../../chat/MemberPicker';
import type { ProjectPageProps } from '../../layout/types';
import { useMembersSource, useTabSave } from '../general/sources';
import { TabFrame } from '../general/TabFrame';

interface MembersDraft {
    picked: string[];
    coordinator: string;
    roles: Record<string, string>;
    limits: Record<string, number | null>;
}

const draftOf = (p: ProjectRecord): MembersDraft => ({
    picked: [...p.members.agentIds],
    coordinator: p.members.coordinator ?? '',
    roles: Object.fromEntries(Object.entries(p.members.roles ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string')),
    limits: Object.fromEntries(Object.entries(p.members.limits ?? {}).filter((e): e is [string, number] => typeof e[1] === 'number'))
});

/** The `members` patch: the roster in pick order, the coordinator when still a member, and the roles and limits of members only. */
export function membersPatchOf(d: MembersDraft): MembersRecord {
    const picked = [...new Set(d.picked)];
    const roles: Record<string, string> = {};
    const limits: Record<string, number> = {};
    for (const id of picked) {
        const role = d.roles[id]?.trim();
        if (role) roles[id] = role;
        const limit = d.limits[id];
        if (typeof limit === 'number' && Number.isInteger(limit) && limit >= 1) limits[id] = Math.min(limit, MEMBER_LIMIT_MAX);
    }
    return {
        agentIds: picked as AgentId[],
        coordinator: (picked.includes(d.coordinator) ? d.coordinator : null) as AgentId | null,
        roles: roles as MembersRecord['roles'],
        limits: limits as MembersRecord['limits']
    };
}

export const ProjectMembers = component<ProjectPageProps>(({ props }) => {
    const save = useTabSave();
    const source = useMembersSource();
    const st = signal<MembersDraft>(draftOf(props.project));
    watch(() => props.project.id, () => Object.assign(st, draftOf(props.project)));
    const patchNow = () => ({ id: props.project.id, members: membersPatchOf(st) });
    return () => {
        const agents = source.agents();
        const nameOf = (id: string): string => agents.find((a) => a.id === id)?.name ?? id;
        return (
            <TabFrame
                tab="members"
                title="Members"
                hint="Who a chat in this project starts with. The New chat picker preselects them; they stay editable there. The coordinator is the project's manager: it owns the plan and takes requests."
                save={save}
                patch={patchNow()}
                onSubmit={() => { void save.run(patchNow()); }}
            >
                <MemberPicker
                    agents={agents}
                    environments={source.environments()}
                    picked={st.picked}
                    coordinator={st.coordinator}
                    onToggle={(e) => {
                        st.picked = e.on ? [...new Set([...st.picked, e.id])] : st.picked.filter((p) => p !== e.id);
                        if (!e.on && st.coordinator === e.id) st.coordinator = '';
                       
                    }}
                    onPickCoordinator={(id) => { st.coordinator = id; }}
                />
                {st.coordinator && st.picked.includes(st.coordinator) ? (
                    <p data-project-hint data-project-coordinator={st.coordinator}>{nameOf(st.coordinator)} is the project manager. <button type="button" data-link-button onClick={() => { st.coordinator = ''; }}>No project manager</button></p>
                ) : null}
                {st.picked.length ? (
                    <ul data-project-member-roles aria-label="Roles and working limits">
                        {st.picked.map((id) => (
                            <li key={id} data-project-member={id}>
                                <span data-project-member-name>{nameOf(id)}{id === st.coordinator ? ' · project manager' : ''}</span>
                                <TextField model={[st.roles, id]} name={`member-role-${id}`} label="Role" placeholder="Developer" />
                                <NumberField model={[st.limits, id]} name={`member-limit-${id}`} label="Working limit" min={1} max={MEMBER_LIMIT_MAX} step={1} placeholder={String(MEMBER_LIMIT_DEFAULT)} description="Plan items at once." />
                            </li>
                        ))}
                    </ul>
                ) : <p data-panel-note>No members yet: pick the agents a chat here starts with.</p>}
            </TabFrame>
        );
    };
}, { name: 'ProjectMembers' });
