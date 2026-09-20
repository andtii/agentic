/**
 * `WorkdirDialog` (#191) — a native "choose folder" dialog over a remote
 * machine, on a plain zero `Dialog` (a form, not an alert: #184 §3).
 *
 * Controlled: the host owns browsing. The dialog shows `environmentId` /
 * `path` / `listing` and asks for moves through `navigate`; it never
 * fetches and never assumes a move happened. Layout, top to bottom:
 *
 * - the environment strip — one button per environment, an unavailable one
 *   disabled with its reason in view;
 * - at the top level (`path === null`): Recent (this environment's) and Roots;
 * - in a folder: the breadcrumb (root first, "All roots" above it), the
 *   folder's own git badge, "Edit path" (typed or pasted, checked with core
 *   `pathWithin`) and "New worktree…" on a repo or worktree;
 * - the folder listbox: click or Enter drills in, ArrowUp/Down/Home/End
 *   move, Backspace goes up (to the top level from a root);
 * - the states: loading (skeleton, or the stale listing dimmed), empty,
 *   truncated, error (plain text per `FsErrorCode`);
 * - the footer: Cancel and "Use this folder" (`select`, then it closes).
 *
 * Nothing inside is a `<form>` or carries a `name`, so the dialog can sit
 * inside a page's form without posting into it.
 */

import { component, type Define } from '@sigx/runtime-core';
import { signal, watch } from '@sigx/reactivity';
import { Dialog, Field, Input } from '@sigx/zero';
import { createId } from '@sigx/zero/behaviors';
import { FS_LIST_MAX_ENTRIES, normalizePath, pathWithin, type EnvironmentId, type FsError, type FsGitInfo, type FsListResult, type WorkdirRef } from '@agentic/core';
import { agWorkdirPickerAnatomy } from '../kit/anatomy.js';
import { Button } from '../kit/Button.js';
import { Icon } from '../kit/icons.js';
import { QuotaBadge } from '../kit/QuotaMeter.js';
import { Tag } from '../kit/StatusPill.js';
import { TableSkeleton } from '../kit/states/Skeletons.js';
import { FS_ERROR_TEXT, fsErrorText, middleTruncate, samePath, workdirCrumbs, type WorkdirEnvironment, type WorkdirRecent, type WorkdirWorktreeRequest } from './workdir-model.js';
import { WorkdirWorktreeForm } from './workdir-worktree.js';

const SCOPE = agWorkdirPickerAnatomy.scope;

/** What `select` hands back: the folder, and its git badge when the listing showed one (#333: a project form keeps it). */
export interface WorkdirSelection extends WorkdirRef {
    readonly git?: FsGitInfo;
}

export type WorkdirDialogProps =
    /** Open. */
    & Define.Model<boolean>
    /** Default "Choose a working folder". */
    & Define.Prop<'title', string>
    & Define.Prop<'environments', readonly WorkdirEnvironment[], true>
    & Define.Prop<'recent', readonly WorkdirRecent[]>
    /** The environment being browsed (null = none chosen yet). */
    & Define.Prop<'environmentId', EnvironmentId | null>
    /** The folder being browsed; null = the environment's top level (Recent + Roots). */
    & Define.Prop<'path', string | null>
    /** The listing of `path` (may be stale while `loading`). */
    & Define.Prop<'listing', FsListResult | null>
    & Define.Prop<'loading', boolean>
    & Define.Prop<'error', FsError | string | null>
    /** A worktree request is in flight. */
    & Define.Prop<'creating', boolean>
    & Define.Prop<'worktreeError', FsError | string | null>
    & Define.Event<'navigate', { readonly environmentId: EnvironmentId; readonly path: string | null }>
    & Define.Event<'select', WorkdirSelection>
    & Define.Event<'createWorktree', WorkdirWorktreeRequest>
    & Define.Event<'cancel', void>;

/** A git badge's text: the kind, then the branch — or the short head when detached. */
export function gitBadgeText(git: FsGitInfo): string {
    return `${git.kind} · ${git.branch ?? (git.head ? `detached ${git.head}` : 'detached')}`;
}

export const WorkdirDialog = component<WorkdirDialogProps>(({ props, emit }) => {
    const id = createId('ag-workdir');
    const st = signal({ active: 0, editing: false, draft: '', draftError: '', worktree: false });
    let editor: HTMLElement | null = null;
    let list: HTMLElement | null = null;
    // A close after `select` or Cancel is finished business; any other close (Escape, backdrop) is a cancel.
    let finished = false;

    watch(() => props.model?.value, (open) => {
        if (open) finished = false;
    });
    // A move resets the folder-local state: highlight, path editor, worktree form.
    watch(() => `${props.environmentId ?? ''}\n${props.path ?? ''}`, () => {
        st.active = 0;
        st.editing = false;
        st.draftError = '';
        st.worktree = false;
    });

    /** The folder on screen; an absent `path` is the top level. */
    const at = (): string | null => props.path ?? null;
    const env = (): WorkdirEnvironment | undefined => props.environments.find((e) => e.id === props.environmentId);
    const browsable = (): WorkdirEnvironment | undefined => {
        const e = env();
        return e && !e.unavailable ? e : undefined;
    };
    /** Whether `listing` is the one for `path` — a host may swap them in either order. */
    const listingOf = (l: FsListResult | null | undefined, path: string | null): l is FsListResult => {
        const e = env();
        return !!l && path !== null && (e ? samePath(l.path, path, e.os) : l.path === path);
    };
    /** The listing, when it is settled and for the folder on screen. */
    const current = (): FsListResult | null => {
        const l = props.listing ?? null;
        return listingOf(l, at()) && !props.loading ? l : null;
    };

    const close = (): void => {
        if (props.model) props.model.value = false;
    };
    const navigate = (path: string | null): void => {
        if (props.environmentId) emit('navigate', { environmentId: props.environmentId, path });
    };
    const up = (): void => {
        const path = at();
        if (path === null) return;
        const l = props.listing;
        if (listingOf(l, path)) return navigate(l.parent ?? null);
        const e = env();
        const crumbs = e ? workdirCrumbs(path, e) : [];
        navigate(crumbs.length > 1 ? crumbs[crumbs.length - 2]!.path : null);
    };
    const cancel = (): void => {
        finished = true;
        emit('cancel');
        close();
    };
    const select = (): void => {
        const l = current();
        if (!l || !props.environmentId || props.error) return;
        finished = true;
        emit('select', { environmentId: props.environmentId, path: l.path, ...(l.git ? { git: l.git } : {}) });
        close();
    };
    const onOpenChange = (open: boolean): void => {
        if (open) finished = false;
        else if (!finished) {
            finished = true;
            emit('cancel');
        }
    };

    const startEdit = (): void => {
        const e = env();
        st.draft = at() ?? e?.roots[0] ?? '';
        st.draftError = '';
        st.editing = true;
        setTimeout(() => editor?.querySelector('input')?.focus(), 0);
    };
    const go = (): void => {
        const e = browsable();
        if (!e) return;
        const value = st.draft.trim();
        if (!value) {
            st.draftError = 'Enter a folder path';
            return;
        }
        if (!pathWithin(value, e.roots, e.os)) {
            st.draftError = FS_ERROR_TEXT['outside-roots'];
            return;
        }
        st.editing = false;
        navigate(normalizePath(value, e.os) ?? value);
    };
    const onEditorKey = (e: KeyboardEvent): void => {
        if (e.key === 'Enter' && !e.isComposing) {
            e.preventDefault();
            go();
        } else if (e.key === 'Escape') {
            // Leave the editor, not the dialog.
            e.preventDefault();
            e.stopPropagation();
            st.editing = false;
        }
    };

    const optionId = (i: number): string => `${id}-o${i}`;
    const move = (to: number): void => {
        const count = props.listing?.entries.length ?? 0;
        if (!count) return;
        st.active = Math.max(0, Math.min(count - 1, to));
        (list?.children[st.active] as HTMLElement | undefined)?.scrollIntoView?.({ block: 'nearest' });
    };
    const onListKey = (e: KeyboardEvent): void => {
        const entries = props.listing?.entries ?? [];
        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                return move(st.active + 1);
            case 'ArrowUp':
                e.preventDefault();
                return move(st.active - 1);
            case 'Home':
                e.preventDefault();
                return move(0);
            case 'End':
                e.preventDefault();
                return move(entries.length - 1);
            case 'Enter': {
                e.preventDefault();
                const entry = entries[st.active];
                if (entry && !props.loading) navigate(entry.path);
                return;
            }
            case 'Backspace':
                e.preventDefault();
                return up();
            default:
                return;
        }
    };

    const strip = () => (
        <div data-scope={SCOPE} data-part="envs" role="group" aria-label="Environments">
            {props.environments.map((e) => (
                <button
                    key={e.id}
                    type="button"
                    data-scope={SCOPE}
                    data-part="env"
                    data-unavailable={e.unavailable ? '' : undefined}
                    aria-pressed={e.id === props.environmentId ? 'true' : 'false'}
                    disabled={!!e.unavailable}
                    onClick={() => emit('navigate', { environmentId: e.id, path: null })}
                >
                    <span data-scope={SCOPE} data-part="env-name">{e.label}</span>
                    <span data-scope={SCOPE} data-part="env-note">{e.unavailable ?? 'Available'}</span>
                    {e.quota !== undefined ? <QuotaBadge snapshot={e.quota} /> : null}
                </button>
            ))}
        </div>
    );

    const shortcuts = (heading: string, paths: readonly string[]) => (
        <section data-scope={SCOPE} data-part="section" aria-labelledby={`${id}-${heading}`}>
            <h3 data-scope={SCOPE} data-part="heading" id={`${id}-${heading}`}>{heading}</h3>
            <ul data-scope={SCOPE} data-part="shortcuts">
                {paths.map((path) => (
                    <li key={path}>
                        <button type="button" data-scope={SCOPE} data-part="shortcut" title={path} onClick={() => navigate(path)}>
                            <Icon name="folder" size={14} />
                            <span>{middleTruncate(path)}</span>
                        </button>
                    </li>
                ))}
            </ul>
        </section>
    );

    const bar = (e: WorkdirEnvironment) => {
        const path = at();
        const crumbs = path === null ? [] : workdirCrumbs(path, e);
        const git = current()?.git;
        if (st.editing) {
            return (
                <div data-scope={SCOPE} data-part="bar">
                    <div
                        data-scope={SCOPE}
                        data-part="editor"
                        onKeydown={onEditorKey}
                        ref={(el: HTMLElement | null) => {
                            editor = el;
                        }}
                    >
                        <Field.Root invalid={!!st.draftError}>
                            <Field.Label>Folder path</Field.Label>
                            <Input.Root model={() => st.draft} autocomplete="off">
                                <Input.Control>
                                    <Input.Input placeholder={e.roots[0]} />
                                </Input.Control>
                            </Input.Root>
                            {st.draftError ? <Field.Error>{st.draftError}</Field.Error> : null}
                        </Field.Root>
                        <Button intent="primary" onClick={go}>Go</Button>
                        <Button intent="default" onClick={() => (st.editing = false)}>Back</Button>
                    </div>
                </div>
            );
        }
        return (
            <div data-scope={SCOPE} data-part="bar">
                <nav data-scope={SCOPE} data-part="crumbs" aria-label="Folder path">
                    <ol>
                        <li>
                            <button type="button" data-scope={SCOPE} data-part="crumb" aria-current={path === null ? 'location' : undefined} onClick={() => navigate(null)}>
                                All roots
                            </button>
                        </li>
                        {crumbs.map((c, i) => (
                            <li key={c.path}>
                                <Icon name="chevron-right" size={14} />
                                <button
                                    type="button"
                                    data-scope={SCOPE}
                                    data-part="crumb"
                                    title={c.path}
                                    aria-current={i === crumbs.length - 1 ? 'location' : undefined}
                                    onClick={() => navigate(c.path)}
                                >
                                    {i === 0 ? middleTruncate(c.label, 32) : c.label}
                                </button>
                            </li>
                        ))}
                    </ol>
                </nav>
                {git ? <Tag>{gitBadgeText(git)}</Tag> : null}
                <Button intent="icon" icon="edit" label="Edit path" onClick={startEdit} />
                {git && !st.worktree ? <Button intent="default" icon="branch" onClick={() => (st.worktree = true)}>New worktree…</Button> : null}
            </div>
        );
    };

    const notice = (kind: string, text: string, action?: unknown) => (
        <p data-scope={SCOPE} data-part="notice" data-notice={kind} role={kind === 'error' ? 'alert' : 'status'}>
            <span>{text}</span>
            {action as never}
        </p>
    );

    const folder = (e: WorkdirEnvironment) => {
        const listing = props.listing ?? null;
        const error = fsErrorText(props.error);
        if (error) {
            return notice('error', error, <Button intent="default" onClick={() => navigate(at())}>Try again</Button>);
        }
        if (!listing) return props.loading ? <TableSkeleton rows={4} cols="1fr" label="Loading folders" /> : null;
        const entries = listing.entries;
        const stale = !!props.loading;
        const now = current();
        return (
            <>
                {st.worktree && now?.git ? (
                    <WorkdirWorktreeForm
                        environment={e}
                        listing={now}
                        creating={props.creating}
                        error={props.worktreeError ?? null}
                        onSubmit={(request) => emit('createWorktree', request)}
                        onClose={() => (st.worktree = false)}
                    />
                ) : null}
                {entries.length ? (
                    <ul
                        data-scope={SCOPE}
                        data-part="list"
                        role="listbox"
                        tabIndex={0}
                        aria-label={`Folders in ${listing.path}`}
                        aria-activedescendant={optionId(Math.min(st.active, entries.length - 1))}
                        aria-busy={stale ? 'true' : undefined}
                        data-stale={stale ? '' : undefined}
                        onKeydown={onListKey}
                        ref={(el: HTMLElement | null) => {
                            list = el;
                        }}
                    >
                        {entries.map((entry, i) => (
                            <li
                                key={entry.path}
                                id={optionId(i)}
                                data-scope={SCOPE}
                                data-part="item"
                                role="option"
                                aria-selected={i === st.active ? 'true' : 'false'}
                                title={entry.path}
                                onClick={() => {
                                    st.active = i;
                                    if (!props.loading) navigate(entry.path);
                                }}
                            >
                                <Icon name="folder" size={15} />
                                <span data-scope={SCOPE} data-part="name">{entry.name}</span>
                                {entry.git ? <Tag>{gitBadgeText(entry.git)}</Tag> : null}
                            </li>
                        ))}
                    </ul>
                ) : stale ? (
                    <TableSkeleton rows={4} cols="1fr" label="Loading folders" />
                ) : (
                    notice('empty', 'No subfolders')
                )}
                {listing.truncated && !stale ? notice('truncated', `Showing the first ${FS_LIST_MAX_ENTRIES} folders`) : null}
            </>
        );
    };

    const body = () => {
        const e = env();
        if (!e) return notice('hint', props.environments.length ? 'Choose an environment to browse its folders.' : 'No environment to browse. Pair a machine first.');
        if (e.unavailable) return notice('offline', `${e.label}: ${e.unavailable}. Its folders can be browsed once it is back.`);
        if (at() === null) {
            const recent = (props.recent ?? [])
                .filter((r) => r.environmentId === e.id)
                .slice()
                .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
                .map((r) => r.path);
            const error = fsErrorText(props.error);
            return (
                <>
                    {bar(e)}
                    {error ? notice('error', error) : null}
                    {recent.length ? shortcuts('Recent', recent) : null}
                    {shortcuts('Roots', e.roots)}
                </>
            );
        }
        return (
            <>
                {bar(e)}
                {folder(e)}
            </>
        );
    };

    return () => {
        const canSelect = !!current() && !!browsable() && !props.error;
        return (
            <Dialog.Root model={props.model} modal onOpenChange={onOpenChange}>
                <Dialog.Popup>
                    <Dialog.Title>{props.title ?? 'Choose a working folder'}</Dialog.Title>
                    <Dialog.Description>Where the agent's session runs. Only folders inside the environment's working roots can be chosen.</Dialog.Description>
                    <div data-scope={SCOPE} data-part="root" data-mod-loading={props.loading ? '' : undefined}>
                        {strip()}
                        {body()}
                    </div>
                    <Dialog.Footer>
                        <Button intent="default" onClick={cancel}>Cancel</Button>
                        <Button intent="primary" icon="check" disabled={!canSelect} onClick={select}>Use this folder</Button>
                    </Dialog.Footer>
                </Dialog.Popup>
            </Dialog.Root>
        );
    };
}, { name: 'WorkdirDialog' });
