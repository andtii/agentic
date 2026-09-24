/**
 * The session bar on all three session views (#564, `Changes` / `Files`
 * boards): Transcript, Changes n and Files tabs — Changes only for a folder
 * under version control, Files only for a folder the machine can serve — then
 * the agent, `machine / account`, the branch and how far it is ahead of its
 * base, then — on Changes and Files — the worktree picker (#622) and the view's own controls (the default slot).
 */
import { component, type Define } from 'sigx';
import { useRouter } from '@sigx/router';
import type { ChangeSet } from '@agentic/core';
import { SessionBar, type AgentHue, type SessionTab } from '@agentic/ui';
import { changesHref, filesHref, rootQuery, transcriptHref, type SessionFiles, type SessionView } from './files';
import { WorktreePicker } from './worktrees';

/** The tabs a session gets: Changes needs a VCS (unknown counts as yes until a `changes` answer says no). */
export function sessionTabs(id: string, files: SessionFiles | null, current: SessionView, changes?: ChangeSet): SessionTab[] {
    // Another worktree open for a look (#622) stays open across Changes and Files; the Transcript is the session's own.
    const root = files ? rootQuery(files) : undefined;
    const tabs: SessionTab[] = [{ id: 'transcript', label: 'Transcript', href: transcriptHref(id), current: current === 'transcript' }];
    if (files?.files && files.vcs !== false) tabs.push({ id: 'changes', label: 'Changes', href: changesHref(id, { root }), current: current === 'changes', ...(changes && changes.scope === 'uncommitted' ? { count: changes.files.length } : {}) });
    if (files?.files) tabs.push({ id: 'files', label: 'Files', href: filesHref(id, undefined, root), current: current === 'files' });
    return tabs;
}

export type SessionFilesBarProps =
    & Define.Prop<'id', string, true>
    & Define.Prop<'current', SessionView, true>
    & Define.Prop<'files', SessionFiles | null>
    & Define.Prop<'agent', { readonly name: string; readonly hue?: AgentHue }>
    /** `alien01 / work`. */
    & Define.Prop<'env', string>
    /** The uncommitted changes: the Changes count, the branch and "n ahead of base". */
    & Define.Prop<'changes', ChangeSet>
    & Define.Slot<'default'>;

export const SessionFilesBar = component<SessionFilesBarProps>(({ props, slots }) => {
    const router = useRouter();
    return () => {
        const c = props.changes;
        return (
            <SessionBar
                tabs={sessionTabs(props.id, props.files ?? null, props.current, c)}
                {...(props.agent ? { agent: props.agent } : {})}
                {...(props.env ? { env: props.env } : {})}
                {...(c?.branch ? { branch: c.branch } : {})}
                {...(c?.ahead !== undefined && c.base ? { ahead: { count: c.ahead, base: c.base } } : {})}
                onNavigate={(tab, e) => {
                    e.preventDefault();
                    void router.push(tab.href);
                }}
            >
                {props.files?.worktrees && props.current !== 'transcript' ? <WorktreePicker id={props.id} current={props.current} files={props.files} /> : null}
                {slots.default?.()}
            </SessionBar>
        );
    };
});

/** `alien01 / work` — the machine and the account the session runs as. */
export const envLineOf = (env: { readonly machine: string; readonly account: string }): string => `${env.machine} / ${env.account}`;
