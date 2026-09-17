import type { NavItem } from '@agentic/ui';

/** The primary navigation — one entry per top-level route (docs/architecture.md §10). */
export const NAV: readonly NavItem[] = [
    { href: '/', label: 'Inbox' },
    { href: '/agents', label: 'Agents' },
    { href: '/machines', label: 'Machines' },
    { href: '/schedules', label: 'Schedules' },
    { href: '/plugins', label: 'Plugins' },
    { href: '/settings', label: 'Settings' },
    { href: '/pair', label: 'Pair a machine' }
];
