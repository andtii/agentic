import type { NavGroup } from '@agentic/ui';
import { inbox } from './mock/data';

/** The inbox kinds that need a person — the Home badge counts them (docs/design/HANDOFF.md → nav badge). */
export const NEEDS_YOU_KINDS: ReadonlySet<string> = new Set(['approval', 'input', 'interrupted']);

/** The Home badge: open inbox items of a kind in `NEEDS_YOU_KINDS`. */
export const needsYouCount = (): number => inbox.filter(item => NEEDS_YOU_KINDS.has(item.kind)).length;

/**
 * The sidebar navigation in its two groups (`docs/design/HANDOFF.md` →
 * "Layout and shell"; routes per docs/architecture.md §10). `/pair` is
 * reached from Machines, not the nav.
 */
export const NAV_GROUPS = (): readonly NavGroup[] => [
    {
        label: 'Primary',
        items: [
            { href: '/', label: 'Home', badge: needsYouCount() },
            { href: '/chats', label: 'Chats' },
            { href: '/agents', label: 'Agents' },
            { href: '/machines', label: 'Machines' },
            { href: '/schedules', label: 'Schedules' }
        ]
    },
    {
        label: 'Workspace',
        items: [
            { href: '/history', label: 'History' },
            { href: '/usage', label: 'Usage' },
            { href: '/plugins', label: 'Plugins' },
            { href: '/settings', label: 'Settings' }
        ]
    }
];

/** Every nav entry, flat — what the route test checks against the route table. */
export const NAV = NAV_GROUPS().flatMap(group => group.items);

/** Topbar breadcrumb roots per route name; detail routes append their id until their page issue lands. */
export const CRUMBS: Record<string, { label: string; href: string }> = {
    home: { label: 'Home', href: '/' },
    chats: { label: 'Chats', href: '/chats' },
    chat: { label: 'Chats', href: '/chats' },
    agents: { label: 'Agents', href: '/agents' },
    agent: { label: 'Agents', href: '/agents' },
    tasks: { label: 'Tasks', href: '/tasks' },
    task: { label: 'Tasks', href: '/tasks' },
    session: { label: 'Sessions', href: '/' },
    machines: { label: 'Machines', href: '/machines' },
    machine: { label: 'Machines', href: '/machines' },
    pair: { label: 'Machines', href: '/machines' },
    schedules: { label: 'Schedules', href: '/schedules' },
    plugins: { label: 'Plugins', href: '/plugins' },
    settings: { label: 'Settings', href: '/settings' },
    history: { label: 'History', href: '/history' },
    usage: { label: 'Usage', href: '/usage' }
};
