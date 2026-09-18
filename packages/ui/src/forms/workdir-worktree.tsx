/**
 * The inline "New worktree…" form of `WorkdirDialog` (#191): branch
 * (required, no spaces), base (defaults to the repo's current branch) and
 * the target path — pre-filled with core's `suggestWorktreePath` and
 * following the branch until the user edits it, then checked against the
 * environment's roots. Submitting hands a `WorkdirWorktreeRequest` up; the
 * host runs it and moves the picker to the result.
 *
 * No `<form>` and no `name`s: the dialog may sit inside a page's form, and
 * nothing here belongs in that post. Enter submits, as in a form.
 */

import { component, type Define } from '@sigx/runtime-core';
import { signal, watch } from '@sigx/reactivity';
import { Field, Input } from '@sigx/zero';
import { normalizePath, pathWithin, suggestWorktreePath, type FsError, type FsListResult } from '@agentic/core';
import { agWorkdirPickerAnatomy } from '../kit/anatomy.js';
import { Button } from '../kit/Button.js';
import { fsErrorText, type WorkdirEnvironment, type WorkdirWorktreeRequest } from './workdir-model.js';

const SCOPE = agWorkdirPickerAnatomy.scope;

export type WorkdirWorktreeFormProps =
    & Define.Prop<'environment', WorkdirEnvironment, true>
    /** The repo or worktree the new worktree branches from. */
    & Define.Prop<'listing', FsListResult, true>
    & Define.Prop<'creating', boolean>
    & Define.Prop<'error', FsError | string | null>
    & Define.Event<'submit', WorkdirWorktreeRequest>
    & Define.Event<'close', void>;

export const WorkdirWorktreeForm = component<WorkdirWorktreeFormProps>(({ props, emit }) => {
    const st = signal({ branch: '', base: props.listing.git?.branch ?? '', target: '', suggested: '', branchError: '', targetError: '' });

    // The target follows the branch while it still reads as the last suggestion; an edit detaches it.
    watch(
        () => [st.branch, props.listing.path, props.environment.os] as const,
        ([branch, repo, os]) => {
            const next = branch.trim() ? (suggestWorktreePath(repo, branch, os) ?? '') : '';
            if (st.target === st.suggested) st.target = next;
            st.suggested = next;
        }
    );

    const submit = (): void => {
        if (props.creating) return;
        const env = props.environment;
        const branch = st.branch.trim();
        const target = st.target.trim();
        st.branchError = !branch ? 'Enter a branch name' : /\s/.test(branch) ? 'A branch name has no spaces' : '';
        st.targetError = !target ? 'Enter where the worktree goes' : !pathWithin(target, env.roots, env.os) ? "The worktree must go inside this environment's working roots" : '';
        if (st.branchError || st.targetError) return;
        const base = st.base.trim();
        emit('submit', {
            environmentId: env.id,
            repo: props.listing.path,
            branch,
            ...(base ? { base } : {}),
            path: normalizePath(target, env.os) ?? target
        });
    };

    const onKeydown = (e: KeyboardEvent): void => {
        if (e.key !== 'Enter' || e.isComposing || (e.target as HTMLElement | null)?.tagName !== 'INPUT') return;
        e.preventDefault();
        submit();
    };

    return () => {
        const error = fsErrorText(props.error);
        return (
            <div data-scope={SCOPE} data-part="worktree" role="group" aria-label="New worktree" onKeydown={onKeydown}>
                <Field.Root invalid={!!st.branchError} required>
                    <Field.Label>Branch</Field.Label>
                    <Input.Root model={() => st.branch} required autocomplete="off">
                        <Input.Control>
                            <Input.Input placeholder="47-drawer" />
                        </Input.Control>
                    </Input.Root>
                    {st.branchError ? <Field.Error>{st.branchError}</Field.Error> : null}
                </Field.Root>
                <Field.Root>
                    <Field.Label>Base</Field.Label>
                    <Input.Root model={() => st.base} autocomplete="off">
                        <Input.Control>
                            <Input.Input placeholder="HEAD" />
                        </Input.Control>
                    </Input.Root>
                    <Field.Description>Where the branch starts; the current branch by default</Field.Description>
                </Field.Root>
                <Field.Root invalid={!!st.targetError}>
                    <Field.Label>Target path</Field.Label>
                    <Input.Root model={() => st.target} autocomplete="off">
                        <Input.Control>
                            <Input.Input />
                        </Input.Control>
                    </Input.Root>
                    {st.targetError ? <Field.Error>{st.targetError}</Field.Error> : null}
                </Field.Root>
                {error ? <p data-scope={SCOPE} data-part="notice" data-notice="error" role="alert">{error}</p> : null}
                <div data-scope={SCOPE} data-part="actions">
                    <Button intent="default" disabled={props.creating} onClick={() => emit('close')}>Discard</Button>
                    <Button intent="primary" icon="branch" loading={props.creating} onClick={submit}>Create worktree</Button>
                </div>
            </div>
        );
    };
}, { name: 'WorkdirWorktreeForm' });
