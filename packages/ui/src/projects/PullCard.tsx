/**
 * `PullCard` — one pull request, the same card in a chat, on Home, in the task tree and in notifications: title,
 * number, stage, checks, blockers (#725 stub; #745 draws it). Props are final.
 */
import { component, type Define } from '@sigx/runtime-core';
import type { PullRequest } from '@agentic/core';

/** Where the card sits; each surface drops what it has no room for. */
export type PullCardSurface = 'chat' | 'home' | 'task' | 'notification';

export type PullCardProps =
    & Define.Prop<'pull', PullRequest, true>
    /** The PR page (`/projects/:id/work/pr:<n>`); without it the card does not link. */
    & Define.Prop<'href', string>
    & Define.Prop<'surface', PullCardSurface>
    & Define.Prop<'class', string>;

export const PullCard = component<PullCardProps>(({ props }) => () => {
    const label = `#${props.pull.number} ${props.pull.title}`;
    return (
        <div data-ag-project="pull-card" data-surface={props.surface ?? 'chat'} data-pull={String(props.pull.number)} class={props.class}>
            {props.href ? <a href={props.href}>{label}</a> : label}
        </div>
    );
}, { name: 'PullCard' });
