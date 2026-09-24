/**
 * `ToolPolicyRow` — one tool a plugin adds, with its workspace-default
 * approval mode (`docs/design/plugins/HANDOFF-plugins.md` → "Plugin page",
 * board `PluginDetail`, Tools): the namespaced tool name in mono over its
 * description, and the kit `Segmented` allow / ask / deny, the selected
 * segment in live / needs-you / failed at 15 %.
 *
 * `pending` is a write in flight: the control is disabled and the row says
 * `aria-busy`. The model is written by the control; the page saves it.
 */
import { component, type Define } from '@sigx/runtime-core';
import type { ToolMode } from '@agentic/core';
import { Segmented, type SegmentedOption, type SegmentedProps } from '../kit/Segmented.js';

const MODES: readonly SegmentedOption[] = [
    { value: 'allow', label: 'allow', tone: 'live' },
    { value: 'ask', label: 'ask', tone: 'needs-you' },
    { value: 'deny', label: 'deny', tone: 'failed' }
];

export type ToolPolicyRowProps =
    & Define.Model<ToolMode>
    /** The namespaced tool name sessions see (`gmail__send-email`), or its display label. */
    & Define.Prop<'name', string, true>
    & Define.Prop<'description', string>
    & Define.Prop<'disabled', boolean>
    & Define.Prop<'pending', boolean>
    & Define.Prop<'class', string>
    & Define.Event<'valueChange', ToolMode>;

export const ToolPolicyRow = component<ToolPolicyRowProps>(({ props, emit }) => () => (
    <div data-tool-policy={props.name} aria-busy={props.pending ? 'true' : undefined} class={props.class} style={`display: flex; align-items: center; gap: var(--space-md); padding: 10px 0; border-block-end: var(--border) solid var(--ag-line)${props.pending ? '; opacity: 0.6' : ''}`}>
        <span style="display: flex; flex-direction: column; gap: 1px; flex-grow: 1; min-inline-size: 0">
            <span data-tool-policy-part="name" style="font-family: var(--font-mono); font-size: var(--text-sm); font-weight: var(--weight-semibold); overflow-wrap: anywhere">{props.name}</span>
            {props.description ? <span data-tool-policy-part="description" style="font-size: var(--text-sm); color: var(--ag-text-dim)">{props.description}</span> : null}
        </span>
        <Segmented model={props.model as SegmentedProps['model']} label={`Approval for ${props.name}`} options={MODES} disabled={props.disabled || props.pending} onValueChange={(v) => emit('valueChange', v as ToolMode)} />
    </div>
), { name: 'ToolPolicyRow' });
