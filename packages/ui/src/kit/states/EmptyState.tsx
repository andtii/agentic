/**
 * `EmptyState` on the `ag-empty` scope — the handoff's empty screens
 * (`docs/design/HANDOFF.md` → "Edge cases"): no empty tables, one card or
 * one line instead. `workspace` is the single "Create your first agent"
 * card with a primary button to `/agents`; `inbox` is "Nothing needs you."
 * in text-muted under the section's kept heading (`compact`: text only);
 * `machines` is the dashed "Pair a machine" card (`outline`); `chat` is the
 * activation hint the composer shows as its placeholder; `generic` is a
 * title and caption a page supplies.
 */
import { component, type Define } from '@sigx/runtime-core';
import { agEmptyAnatomy } from '../anatomy.js';
import { Icon, type IconName } from '../icons.js';

const SCOPE = agEmptyAnatomy.scope;

export const EMPTY_VARIANTS = ['workspace', 'inbox', 'machines', 'chat', 'generic'] as const;
export type EmptyVariant = (typeof EMPTY_VARIANTS)[number];

interface EmptySpec {
    readonly title?: string;
    readonly caption: string;
    readonly icon?: IconName;
    readonly action?: { label: string; href: string; intent: 'primary' | 'default' };
    /** Text only, no card chrome. */
    readonly compact?: boolean;
    /** Dashed card. */
    readonly outline?: boolean;
}

export const EMPTY_STATES: Record<EmptyVariant, EmptySpec> = {
    workspace: { title: 'Create your first agent', caption: 'An agent has an identity, memory, skills and permissions. Chats, tasks and schedules start from one.', icon: 'agents', action: { label: 'New agent', href: '/agents', intent: 'primary' } },
    inbox: { caption: 'Nothing needs you.', compact: true },
    machines: { title: 'Pair a machine', caption: 'Run Claude Code on your own machine through the daemon. The platform row above runs API agents without one.', icon: 'machines', action: { label: 'Pair a machine', href: '/pair', intent: 'default' }, outline: true },
    chat: { caption: 'Message the chat. @ to address an agent, otherwise the coordinator answers.', compact: true },
    generic: { caption: '' }
};

export type EmptyStateProps =
    & Define.Prop<'variant', EmptyVariant>
    & Define.Prop<'title', string>
    & Define.Prop<'caption', string>
    & Define.Prop<'icon', IconName>
    & Define.Prop<'class', string>
    /** Replaces the variant's default action. */
    & Define.Slot<'actions'>;

export const EmptyState = component<EmptyStateProps>(({ props, slots }) => () => {
    const variant = props.variant ?? 'generic';
    const spec = EMPTY_STATES[variant];
    const title = props.title ?? spec.title;
    const icon = props.icon ?? spec.icon;
    const actions = slots.actions
        ? slots.actions()
        : spec.action
            ? <a href={spec.action.href} data-scope="button" data-part="root" data-color={spec.action.intent === 'primary' ? 'primary' : 'neutral'} data-variant="solid" data-intent={spec.action.intent}><span>{spec.action.label}</span></a>
            : null;
    return (
        <div data-scope={SCOPE} data-part="root" data-empty={variant} data-mod-compact={spec.compact ? '' : undefined} data-mod-outline={spec.outline ? '' : undefined} class={props.class} role="status">
            {icon ? <span data-scope={SCOPE} data-part="icon"><Icon name={icon} size={20} /></span> : null}
            {title ? <span data-scope={SCOPE} data-part="title">{title}</span> : null}
            <p data-scope={SCOPE} data-part="caption">{props.caption ?? spec.caption}</p>
            {actions ? <div data-scope={SCOPE} data-part="actions">{actions}</div> : null}
        </div>
    );
}, { name: 'EmptyState' });
