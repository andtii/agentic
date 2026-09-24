/**
 * The small parts the Changes and Files views share (#563): the status
 * letter, `+n −n`, a keyboard hint, and the path helpers every list and
 * header uses. VCS-neutral: they read core's `FileChangeStatus`, not git.
 */
import { component, type Define } from '@sigx/runtime-core';
import { Kbd as ZeroKbd } from '@sigx/zero';
import type { FileChangeStatus } from '@agentic/core';
import { agDiffCountsAnatomy, agStatusTileAnatomy } from './anatomy.js';

/** The letter and tone each change status is drawn with. */
export const CHANGE_STATUS: Record<FileChangeStatus, { readonly letter: string; readonly tone: 'working' | 'live' | 'failed' | 'dim'; readonly label: string }> = {
    modified: { letter: 'M', tone: 'working', label: 'Modified' },
    added: { letter: 'A', tone: 'live', label: 'Added' },
    deleted: { letter: 'D', tone: 'failed', label: 'Deleted' },
    renamed: { letter: 'R', tone: 'working', label: 'Renamed' },
    untracked: { letter: '?', tone: 'dim', label: 'Untracked' }
};

/** The tree's 6 px dot: new files `live`, deleted `failed`, everything else `working` (changed). */
export function changeDotTone(status: FileChangeStatus): 'working' | 'live' | 'failed' {
    return status === 'added' || status === 'untracked' ? 'live' : status === 'deleted' ? 'failed' : 'working';
}

/** A `/`-separated path's folder and file name (`''` folder at the top). */
export function splitPath(path: string): { readonly dir: string; readonly name: string } {
    const i = path.lastIndexOf('/');
    return i < 0 ? { dir: '', name: path } : { dir: path.slice(0, i), name: path.slice(i + 1) };
}

/** Bytes as the viewer header writes them (binary units, one decimal): `812 B`, `2.1 KB`, `1.4 MB`. */
export function fileSizeText(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type StatusTileProps =
    & Define.Prop<'status', FileChangeStatus, true>
    & Define.Prop<'class', string>;

/** The 18 px status letter; its name ("Modified") is its accessible label. */
export const StatusTile = component<StatusTileProps>(({ props }) => () => {
    const s = CHANGE_STATUS[props.status];
    return <span data-scope={agStatusTileAnatomy.scope} data-part="root" data-tone={s.tone} role="img" aria-label={s.label} title={s.label} class={props.class}>{s.letter}</span>;
}, { name: 'StatusTile' });

export type DiffCountsProps =
    & Define.Prop<'added', number>
    & Define.Prop<'removed', number>;

/** `+n −n`; a side with nothing to count is left out (an added file shows only `+n`). */
export const DiffCounts = component<DiffCountsProps>(({ props }) => () => {
    const scope = agDiffCountsAnatomy.scope;
    const added = props.added ?? 0;
    const removed = props.removed ?? 0;
    if (!added && !removed) return null;
    return (
        <span data-scope={scope} data-part="root" aria-label={`${added} added, ${removed} removed`}>
            {added ? <span data-scope={scope} data-part="added" aria-hidden="true">+{added}</span> : null}
            {removed ? <span data-scope={scope} data-part="removed" aria-hidden="true">−{removed}</span> : null}
        </span>
    );
}, { name: 'DiffCounts' });

export type KbdProps = Define.Prop<'keys', string, true>;

/** A keyboard hint (`Ctrl P`): zero's `Kbd` (#587), with the keys as a prop. */
export const Kbd = component<KbdProps>(({ props }) => () => <ZeroKbd.Root>{props.keys}</ZeroKbd.Root>, { name: 'Kbd' });
