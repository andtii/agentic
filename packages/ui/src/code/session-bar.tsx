/**
 * The bar under the topbar on every view of a session (#563): link tabs
 * (Transcript, Changes n, Files — which ones is the caller's call, from the
 * session's workspace capabilities), then who and where the session runs,
 * then the view's own controls in the default slot.
 */
import { component, type Define } from '@sigx/runtime-core';
import { AgentTile, type AgentHue } from '../kit/AgentTile.js';
import { Icon } from '../kit/icons.js';
import { agSessionBarAnatomy } from './anatomy.js';

const SCOPE = agSessionBarAnatomy.scope;

export interface SessionTab {
    readonly id: string;
    readonly label: string;
    readonly href: string;
    /** A count beside the label (changed files). */
    readonly count?: number;
    readonly current?: boolean;
}

export type SessionBarProps =
    & Define.Prop<'tabs', readonly SessionTab[], true>
    & Define.Prop<'agent', { readonly name: string; readonly hue?: AgentHue }>
    /** `machine / account`. */
    & Define.Prop<'env', string>
    & Define.Prop<'branch', string>
    /** Commits ahead of the base, and the base's name. */
    & Define.Prop<'ahead', { readonly count: number; readonly base: string }>
    /** A tab click without modifiers (the caller may `preventDefault` and route itself). */
    & Define.Prop<'onNavigate', (tab: SessionTab, event: MouseEvent) => void>
    & Define.Slot<'default'>;

export const SessionBar = component<SessionBarProps>(({ props, slots }) => () => {
    const hasContext = props.agent || props.env || props.branch || props.ahead;
    const controls = slots.default?.();
    const hasControls = Array.isArray(controls) ? controls.length > 0 : controls != null;
    return (
        <div data-scope={SCOPE} data-part="root">
            <nav data-scope={SCOPE} data-part="tabs" aria-label="Session views">
                {props.tabs.map((tab) => (
                    <a
                        data-scope={SCOPE}
                        data-part="tab"
                        href={tab.href}
                        aria-current={tab.current ? 'page' : undefined}
                        onClick={(e: MouseEvent) => {
                            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                            props.onNavigate?.(tab, e);
                        }}
                    >
                        {tab.label}
                        {tab.count !== undefined ? <span data-scope={SCOPE} data-part="count" aria-label={`, ${tab.count}`}>{tab.count}</span> : null}
                    </a>
                ))}
            </nav>
            {hasContext ? <span data-scope={SCOPE} data-part="divider" aria-hidden="true" /> : null}
            {hasContext ? (
                <div data-scope={SCOPE} data-part="context">
                    {props.agent ? <AgentTile name={props.agent.name} hue={props.agent.hue} size={24} labelled /> : null}
                    {props.env ? <span data-scope={SCOPE} data-part="env">{props.env}</span> : null}
                    {props.branch ? (
                        <span data-scope={SCOPE} data-part="branch" title={`Branch ${props.branch}`}>
                            <Icon name="branch" size={13} />
                            <span>{props.branch}</span>
                        </span>
                    ) : null}
                    {props.ahead && props.ahead.count > 0 ? <span data-scope={SCOPE} data-part="ahead">{props.ahead.count} ahead of {props.ahead.base}</span> : null}
                </div>
            ) : null}
            {hasControls ? <div data-scope={SCOPE} data-part="controls">{controls}</div> : null}
        </div>
    );
}, { name: 'SessionBar' });
