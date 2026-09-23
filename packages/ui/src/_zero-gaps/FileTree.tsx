/**
 * `FileTree` — a lazily loaded folder tree (#563, `Files` board, left 300 px).
 *
 * A zero gap: `@sigx/zero` has no Tree / TreeView part yet (andtii/zero-wip#494,
 * filed from #563). This is the smallest local version the Files view
 * needs — WAI-ARIA tree semantics, a roving tabindex, arrow-key navigation —
 * and should give way to zero's once it ships.
 *
 * Generic: it knows core's `FsTreeEntry` and a `load(path)` function, never
 * where the entries come from. Folders load on first expand; the ancestors of
 * `selected` are opened on mount so a deep link lands on its file.
 */
import { component, onMounted, signal, type Define, type JSXElement } from '@sigx/runtime-core';
import { watch } from '@sigx/reactivity';
import type { FileChangeStatus, FsTreeEntry } from '@agentic/core';
import { Icon } from '../kit/icons.js';
import { agFileTreeAnatomy } from '../code/anatomy.js';
import { changeDotTone } from '../code/parts.js';

const SCOPE = agFileTreeAnatomy.scope;

/** A folder's entries, or why it has none to show. */
export type FileTreeLoad = (path: string) => Promise<readonly FsTreeEntry[]>;

interface FolderState {
    entries?: readonly FsTreeEntry[];
    loading?: boolean;
    error?: string;
}

/** The folders on the way to `path` (`a/b/c.ts` → `a`, `a/b`). */
export function ancestorsOf(path: string): string[] {
    const parts = path.split('/').filter(Boolean);
    return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
}

export type FileTreeProps =
    & Define.Prop<'load', FileTreeLoad, true>
    /** The open file's path. */
    & Define.Prop<'selected', string>
    /** A file was chosen (click, Enter). */
    & Define.Prop<'onSelect', (entry: FsTreeEntry) => void, true>
    /** Override the change a row shows (default: the entry's own `change`). */
    & Define.Prop<'changeOf', (entry: FsTreeEntry) => FileChangeStatus | undefined>
    & Define.Prop<'label', string>
    /** Bump to drop every loaded folder and load again (a refresh). */
    & Define.Prop<'version', number>;

export const FileTree = component<FileTreeProps>(({ props }) => {
    const st = signal({ folders: {} as Record<string, FolderState>, open: {} as Record<string, boolean>, focus: '' });

    const loadFolder = (path: string): void => {
        const folder = st.folders[path];
        if (folder?.entries || folder?.loading) return;
        st.folders[path] = { loading: true };
        props.load(path).then(
            (entries) => { st.folders[path] = { entries }; },
            (error: unknown) => { st.folders[path] = { error: error instanceof Error ? error.message : String(error) }; }
        );
    };
    const openTo = (path: string | undefined): void => {
        loadFolder('');
        for (const dir of ancestorsOf(path ?? '')) {
            st.open[dir] = true;
            loadFolder(dir);
        }
    };
    onMounted(() => openTo(props.selected));
    watch(() => props.selected, (path) => openTo(path));
    watch(() => props.version, () => {
        st.folders = {};
        loadFolder('');
        for (const dir of Object.keys(st.open)) if (st.open[dir]) loadFolder(dir);
    });

    const toggle = (path: string, open = !st.open[path]): void => {
        st.open[path] = open;
        if (open) loadFolder(path);
    };

    /** The visible rows, depth-first, for keyboard movement. */
    const visible = (): Array<{ entry: FsTreeEntry; level: number; parent: string }> => {
        const out: Array<{ entry: FsTreeEntry; level: number; parent: string }> = [];
        const walk = (dir: string, level: number): void => {
            for (const entry of st.folders[dir]?.entries ?? []) {
                out.push({ entry, level, parent: dir });
                if (entry.type === 'dir' && st.open[entry.path]) walk(entry.path, level + 1);
            }
        };
        walk('', 0);
        return out;
    };

    const focusRow = (root: HTMLElement | null, path: string): void => {
        st.focus = path;
        // Matched by value, not a selector: a path may hold any character a selector would need escaped.
        queueMicrotask(() => [...(root?.querySelectorAll<HTMLElement>('[data-part="item"]') ?? [])].find((el) => el.dataset['path'] === path)?.focus());
    };

    let rootEl: HTMLElement | null = null;
    const onKeyDown = (e: KeyboardEvent): void => {
        const rows = visible();
        const at = rows.findIndex((r) => r.entry.path === (st.focus || props.selected));
        const row = rows[at];
        const go = (i: number): void => {
            const target = rows[Math.max(0, Math.min(rows.length - 1, i))];
            if (target) focusRow(rootEl, target.entry.path);
        };
        switch (e.key) {
            case 'ArrowDown': go(at + 1); break;
            case 'ArrowUp': go(at - 1); break;
            case 'Home': go(0); break;
            case 'End': go(rows.length - 1); break;
            case 'ArrowRight':
                if (row?.entry.type === 'dir') {
                    if (!st.open[row.entry.path]) toggle(row.entry.path, true);
                    else go(at + 1);
                }
                break;
            case 'ArrowLeft':
                if (row?.entry.type === 'dir' && st.open[row.entry.path]) toggle(row.entry.path, false);
                else if (row?.parent) focusRow(rootEl, row.parent);
                break;
            case 'Enter':
            case ' ':
                if (!row) return;
                if (row.entry.type === 'dir') toggle(row.entry.path);
                else props.onSelect(row.entry);
                break;
            default:
                return;
        }
        e.preventDefault();
    };

    const renderFolder = (dir: string, level: number): JSXElement[] => {
        const folder = st.folders[dir];
        if (!folder || folder.loading) return [<p data-scope={SCOPE} data-part="status" style={`--ag-level: ${level}`} role="none">Loading…</p>];
        if (folder.error) return [<p data-scope={SCOPE} data-part="status" style={`--ag-level: ${level}`} role="none">{folder.error}</p>];
        return (folder.entries ?? []).map((entry) => {
            const isDir = entry.type === 'dir';
            const open = isDir && !!st.open[entry.path];
            const change = props.changeOf ? props.changeOf(entry) : entry.change;
            const selected = entry.path === props.selected;
            const focusable = entry.path === (st.focus || props.selected) || (!st.focus && !props.selected && level === 0 && entry === folder.entries![0]);
            return (
                <div role="none">
                    <div
                        data-scope={SCOPE}
                        data-part="item"
                        data-type={isDir ? 'dir' : 'file'}
                        data-path={entry.path}
                        role="treeitem"
                        aria-level={level + 1}
                        aria-expanded={isDir ? (open ? 'true' : 'false') : undefined}
                        aria-selected={selected ? 'true' : 'false'}
                        tabIndex={focusable ? 0 : -1}
                        style={`--ag-level: ${level}`}
                        title={entry.path}
                        onClick={() => {
                            st.focus = entry.path;
                            if (isDir) toggle(entry.path);
                            else props.onSelect(entry);
                        }}
                    >
                        <span data-scope={SCOPE} data-part="toggle" aria-hidden="true">{isDir ? <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} /> : null}</span>
                        <span data-scope={SCOPE} data-part="icon" aria-hidden="true"><Icon name={isDir ? 'folder' : 'file'} size={14} /></span>
                        <span data-scope={SCOPE} data-part="name">{entry.name}</span>
                        {change ? <span data-scope={SCOPE} data-part="dot" data-tone={changeDotTone(change)} role="img" aria-label={change} /> : null}
                    </div>
                    {open ? <div data-scope={SCOPE} data-part="group" role="group">{renderFolder(entry.path, level + 1)}</div> : null}
                </div>
            );
        });
    };

    return () => (
        <div data-scope={SCOPE} data-part="root" role="tree" aria-label={props.label ?? 'Files'} ref={(el: HTMLElement) => { rootEl = el; }} onKeyDown={onKeyDown}>
            {renderFolder('', 0)}
        </div>
    );
}, { name: 'FileTree' });

export type FileTreeLegendProps =
    /** The folder listing left out ignored files (`.gitignore hidden`). */
    & Define.Prop<'ignoredHidden', boolean>
    & Define.Prop<'ignoreLabel', string>;

/** The tree's foot: what the dots mean, and whether ignored files are hidden. */
export const FileTreeLegend = component<FileTreeLegendProps>(({ props }) => () => (
    <div data-scope={SCOPE} data-part="legend">
        <span data-scope={SCOPE} data-part="dot" data-tone="working" aria-hidden="true" />
        <span>changed</span>
        <span data-scope={SCOPE} data-part="dot" data-tone="live" aria-hidden="true" />
        <span>added</span>
        <span data-spacer="" />
        {props.ignoredHidden ? <span data-mono="">{props.ignoreLabel ?? '.gitignore hidden'}</span> : null}
    </div>
), { name: 'FileTreeLegend' });
