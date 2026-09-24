/**
 * The worktree picker in the session bar (#622): the worktrees of the session folder's repository, the session's own
 * marked, any other one opened for a look through `?root=` on the same view. Read-only — the session itself stays in
 * its own folder (EXE-12). A worktree outside the working roots, or one whose folder is gone, is listed but disabled.
 */
import { component, signal, watch, type Define } from 'sigx';
import { useRouter } from '@sigx/router';
import type { FsWorktreeEntry } from '@agentic/core';
import { changesHref, displayRoot, filesHref, type SessionFiles, type SessionView } from './files';

/** An entry's label: the branch (or the short head when detached), `this session` for the session's own. */
export function worktreeLabel(w: FsWorktreeEntry): string {
    const name = w.branch ?? (w.head ? `detached ${w.head}` : displayRoot(w.path));
    const notes = [w.current ? 'this session' : '', w.outside ? 'outside the working roots' : '', w.prunable ? 'folder gone' : ''].filter(Boolean);
    return notes.length ? `${name} (${notes.join(', ')})` : name;
}

/** The entry the view shows: the one `?root=` names, else the session's own. */
export function shownWorktree(entries: readonly FsWorktreeEntry[], files: Pick<SessionFiles, 'root' | 'sessionRoot'>): FsWorktreeEntry | undefined {
    const fold = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    return files.sessionRoot !== undefined ? entries.find((w) => fold(w.path) === fold(files.root)) : entries.find((w) => w.current);
}

export type WorktreePickerProps = Define.Prop<'id', string, true> & Define.Prop<'current', SessionView, true> & Define.Prop<'files', SessionFiles, true>;

export const WorktreePicker = component<WorktreePickerProps>(({ props }) => {
    const router = useRouter();
    const st = signal({ entries: [] as FsWorktreeEntry[] });
    let ticket = 0;
    watch(
        () => (props.files.worktrees ? `${props.files.sessionRoot ?? props.files.root}|${props.files.online}` : ''),
        (key) => {
            const list = props.files.worktrees;
            const mine = ++ticket;
            if (!key || !list) return;
            void list()
                .then((a) => {
                    if (mine === ticket) st.entries = a.result ? [...a.result.entries] : [];
                })
                .catch(() => {
                    if (mine === ticket) st.entries = [];
                });
        },
        { immediate: true }
    );
    const go = (path: string): void => {
        const w = st.entries.find((e) => e.path === path);
        const root = w && !w.current ? w.path : undefined;
        void router.replace(props.current === 'files' ? filesHref(props.id, undefined, root) : changesHref(props.id, { root }));
    };
    return () => {
        // One worktree, or none known: nothing to switch between.
        if (st.entries.length < 2) return null;
        const shown = shownWorktree(st.entries, props.files);
        return (
            <label data-worktree-picker>
                <span data-worktree-picker-label>Worktree</span>
                <select data-scope="select" data-part="select" value={shown?.path ?? ''} onChange={(e: Event) => go((e.target as HTMLSelectElement).value)}>
                    {st.entries.map((w) => (
                        <option value={w.path} disabled={!!w.outside || !!w.prunable} title={displayRoot(w.path)}>
                            {worktreeLabel(w)}
                        </option>
                    ))}
                </select>
            </label>
        );
    };
});
