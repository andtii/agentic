/**
 * `EnvironmentLine` — `machine / runtime / account` in mono 12 with
 * `text-dim` slashes (`docs/design/HANDOFF.md` → "Components"). Where work
 * is attributed, one part alone is never enough (EXE-06): all three render
 * or the component refuses in development. It never wraps; when it cannot
 * fit, the machine segment goes last (`fit="drop-machine"` lets a container
 * hide it through `[data-fit]`).
 */
import { component, type Define } from '@sigx/runtime-core';
import { agEnvLineAnatomy } from './anatomy.js';
import type { Tone } from './vocabulary.js';

const SCOPE = agEnvLineAnatomy.scope;

export interface EnvironmentParts {
    readonly machine: string;
    readonly runtime: string;
    readonly account: string;
}

export type EnvironmentLineProps =
    & Define.Prop<'machine', string, true>
    & Define.Prop<'runtime', string, true>
    & Define.Prop<'account', string, true>
    /** `muted` (default), `dim` for captions, `live` (base-content) where it is the headline. */
    & Define.Prop<'tone', Tone>
    /** `drop-machine`: below 768 px the machine segment is hidden when the line would not fit (the `title` keeps all three). */
    & Define.Prop<'fit', 'drop-machine'>
    & Define.Prop<'class', string>;

export const EnvironmentLine = component<EnvironmentLineProps>(({ props }) => () => {
    if (__DEV__ && (!props.machine || !props.runtime || !props.account)) {
        throw new Error('[@agentic/ui] EnvironmentLine needs machine, runtime and account — never render one part alone where work is attributed (EXE-06)');
    }
    return (
        <span data-scope={SCOPE} data-part="root" data-tone={props.tone ?? 'muted'} data-fit={props.fit} class={props.class} title={`${props.machine} / ${props.runtime} / ${props.account}`}>
            <span data-scope={SCOPE} data-part="machine">{props.machine}</span>
            <span data-scope={SCOPE} data-part="sep" aria-hidden="true">/</span>
            <span data-scope={SCOPE} data-part="runtime">{props.runtime}</span>
            <span data-scope={SCOPE} data-part="sep" aria-hidden="true">/</span>
            <span data-scope={SCOPE} data-part="account">{props.account}</span>
        </span>
    );
}, { name: 'EnvironmentLine' });
