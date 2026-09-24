/**
 * `EmptyState` on zero's `EmptyState` — the handoff's empty screens
 * (`docs/design/HANDOFF.md` → "Edge cases"): no empty tables, one card or
 * one line instead. `workspace` is the single "Create your first agent"
 * card with a primary button to `/agents`; `inbox` is "Nothing needs you."
 * in text-muted under the section's kept heading (`compact`: text only);
 * `machines` is the dashed "Pair a machine" card (`outline`); `chat` is the
 * activation hint the composer shows as its placeholder; `generic` is a
 * title and caption a page supplies.
 *
 * The root is `role="status"` with the variant as `data-empty`; `compact`
 * and `outline` are the `data-mod-*` modifiers the design system's
 * empty-state patch draws. A default action is the kit `Button` as a link.
 */
import { component, type Define } from '@sigx/runtime-core';
import { EmptyState as ZeroEmptyState } from '@sigx/zero';
import { Button } from '../Button.js';
import { Icon, type IconName } from '../icons.js';

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
            ? <Button href={spec.action.href} intent={spec.action.intent}>{spec.action.label}</Button>
            : null;
    return (
        <ZeroEmptyState.Root role="status" data-empty={variant} mods={{ compact: !!spec.compact, outline: !!spec.outline }} class={props.class}>
            {icon ? <ZeroEmptyState.Icon><Icon name={icon} size={20} /></ZeroEmptyState.Icon> : null}
            {title ? <ZeroEmptyState.Title>{title}</ZeroEmptyState.Title> : null}
            <ZeroEmptyState.Description>{props.caption ?? spec.caption}</ZeroEmptyState.Description>
            {actions ? <ZeroEmptyState.Actions>{actions}</ZeroEmptyState.Actions> : null}
        </ZeroEmptyState.Root>
    );
}, { name: 'EmptyState' });
