/**
 * A file's header over the diff or the viewer (#563): the status tile, the
 * path with the file name in `text` 600 — as `dir/name` (Changes) or as
 * spaced breadcrumbs (Files) — facts such as `+n −n` or `82 lines · 2.1 KB`,
 * and the caller's actions (edited-by link, Open diff, copy path) on the right.
 */
import { component, type Define } from '@sigx/runtime-core';
import type { FileChangeStatus } from '@agentic/core';
import { agFileHeaderAnatomy } from './anatomy.js';
import { DiffCounts, StatusTile } from './parts.js';

const SCOPE = agFileHeaderAnatomy.scope;

export type FileHeaderProps =
    & Define.Prop<'path', string, true>
    & Define.Prop<'status', FileChangeStatus>
    /** `packages / ui / shell.css` instead of `packages/ui/shell.css`. */
    & Define.Prop<'breadcrumbs', boolean>
    & Define.Prop<'added', number>
    & Define.Prop<'removed', number>
    /** Plain facts after the path (`82 lines · 2.1 KB`). */
    & Define.Prop<'facts', string>
    & Define.Slot<'default'>;

export const FileHeader = component<FileHeaderProps>(({ props, slots }) => () => {
    const segments = props.path.split('/').filter(Boolean);
    const name = segments.pop() ?? props.path;
    const status = props.status ? <StatusTile status={props.status} /> : null;
    return (
        <div data-scope={SCOPE} data-part="root">
            {props.breadcrumbs ? null : status}
            <span data-scope={SCOPE} data-part="path" title={props.path}>
                {props.breadcrumbs
                    ? segments.map((s) => <>{s}<span data-scope={SCOPE} data-part="sep"> / </span></>)
                    : segments.length ? `${segments.join('/')}/` : null}
                <span data-scope={SCOPE} data-part="name">{name}</span>
            </span>
            {props.breadcrumbs ? status : null}
            {props.added || props.removed ? <DiffCounts added={props.added} removed={props.removed} /> : null}
            {props.facts ? <span data-scope={SCOPE} data-part="facts">{props.facts}</span> : null}
            <div data-scope={SCOPE} data-part="actions">{slots.default?.()}</div>
        </div>
    );
}, { name: 'FileHeader' });
