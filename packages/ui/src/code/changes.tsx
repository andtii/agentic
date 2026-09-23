/**
 * The Changes list column (#563, `Changes` board, left 300 px): a panel of
 * groups — the changed files (`Uncommitted` with totals) and the commits on
 * the branch (`On this branch` vs the base) — with the read-only note at the
 * foot. Links, not handlers: each file row is an `<a href>` the caller
 * builds, so the router (or no JavaScript at all) opens it.
 */
import { component, type Define } from '@sigx/runtime-core';
import type { ChangeCommit, ChangedFile } from '@agentic/core';
import { AgentTile, type AgentHue } from '../kit/AgentTile.js';
import { Icon } from '../kit/icons.js';
import { agChangesAnatomy } from './anatomy.js';
import { DiffCounts, StatusTile, splitPath } from './parts.js';

const SCOPE = agChangesAnatomy.scope;

export type ChangesPanelProps =
    /** The foot note ("Read-only. Files stay on <machine>; …"). */
    & Define.Prop<'note', string>
    & Define.Prop<'class', string>
    & Define.Slot<'default'>;

/** The column: groups 16 px apart, the note pinned to the foot. */
export const ChangesPanel = component<ChangesPanelProps>(({ props, slots }) => () => (
    <div data-scope={SCOPE} data-part="root" class={props.class}>
        {slots.default?.()}
        {props.note ? (
            <p data-scope={SCOPE} data-part="note"><Icon name="shield" size={14} />{props.note}</p>
        ) : null}
    </div>
), { name: 'ChangesPanel' });

export type ChangeListProps =
    & Define.Prop<'files', readonly ChangedFile[], true>
    & Define.Prop<'label', string>
    /** The open file's path: its row carries `aria-current`. */
    & Define.Prop<'current', string>
    /** Each row's link. */
    & Define.Prop<'href', (file: ChangedFile) => string, true>
    /** Called on a plain left click (the caller may `preventDefault` and route itself). */
    & Define.Prop<'onOpen', (file: ChangedFile, event: MouseEvent) => void>
    /** Shown instead of rows when nothing changed. */
    & Define.Prop<'empty', string>
    /** Leave out the heading totals. */
    & Define.Prop<'noTotals', boolean>;

/** A group of changed files: status tile, name over its folder (truncated from the start), `+n −n`. */
export const ChangeList = component<ChangeListProps>(({ props }) => () => {
    const added = props.files.reduce((n, f) => n + (f.added ?? 0), 0);
    const removed = props.files.reduce((n, f) => n + (f.removed ?? 0), 0);
    const label = props.label ?? 'Uncommitted';
    return (
        <section data-scope={SCOPE} data-part="group" aria-label={label}>
            <div data-scope={SCOPE} data-part="heading">
                <h3 data-scope={SCOPE} data-part="label">{label}</h3>
                {props.noTotals ? null : <DiffCounts added={added} removed={removed} />}
            </div>
            {props.files.length === 0 && props.empty ? <p data-scope={SCOPE} data-part="empty">{props.empty}</p> : null}
            {props.files.map((file) => {
                const { dir, name } = splitPath(file.path);
                const current = props.current === file.path;
                return (
                    <a
                        data-scope={SCOPE}
                        data-part="item"
                        data-deleted={file.status === 'deleted' ? '' : undefined}
                        href={props.href(file)}
                        aria-current={current ? 'true' : undefined}
                        title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                        onClick={(e: MouseEvent) => {
                            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                            props.onOpen?.(file, e);
                        }}
                    >
                        <StatusTile status={file.status} />
                        <span data-scope={SCOPE} data-part="body">
                            <span data-scope={SCOPE} data-part="name">{name}</span>
                            {/* rtl truncates from the start; the marks keep a leading `.` or `/` where it belongs */}
                            {dir ? <span data-scope={SCOPE} data-part="folder">{`\u200E${dir}\u200E`}</span> : null}
                        </span>
                        {file.binary ? null : <DiffCounts added={file.added} removed={file.removed} />}
                    </a>
                );
            })}
        </section>
    );
}, { name: 'ChangeList' });

/** Who a commit is drawn as: an agent tile, when the caller knows the author. */
export interface CommitAuthor {
    readonly name: string;
    readonly hue?: AgentHue;
    readonly person?: boolean;
}

/** `14:06`, in the viewer's zone — callers with a workspace zone pass their own. */
export function commitTime(at: number): string {
    const d = new Date(at);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export type CommitListProps =
    & Define.Prop<'commits', readonly ChangeCommit[], true>
    & Define.Prop<'label', string>
    /** The base the branch is compared with ("vs main"). */
    & Define.Prop<'base', string>
    & Define.Prop<'author', (commit: ChangeCommit) => CommitAuthor | undefined>
    & Define.Prop<'formatTime', (at: number) => string>
    & Define.Prop<'empty', string>;

/** The commits on the branch: message, short id · time, the author's tile. */
export const CommitList = component<CommitListProps>(({ props }) => () => {
    const label = props.label ?? 'On this branch';
    const time = props.formatTime ?? commitTime;
    return (
        <section data-scope={SCOPE} data-part="group" aria-label={label}>
            <div data-scope={SCOPE} data-part="heading">
                <h3 data-scope={SCOPE} data-part="label">{label}</h3>
                {props.base ? <span data-scope={SCOPE} data-part="aside">vs {props.base}</span> : null}
            </div>
            {props.commits.length === 0 && props.empty ? <p data-scope={SCOPE} data-part="empty">{props.empty}</p> : null}
            {props.commits.map((c) => {
                const author = props.author?.(c);
                return (
                    <div data-scope={SCOPE} data-part="commit" title={`${c.short} ${c.subject} — ${c.author}`}>
                        <Icon name="commit" size={14} />
                        <span data-scope={SCOPE} data-part="meta">
                            <span data-scope={SCOPE} data-part="subject">{c.subject}</span>
                            <span>{c.short} · {time(c.at)}</span>
                        </span>
                        {author ? <AgentTile name={author.name} hue={author.hue} person={author.person} size={18} labelled /> : null}
                    </div>
                );
            })}
        </section>
    );
}, { name: 'CommitList' });
