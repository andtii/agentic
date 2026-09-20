import { signal } from 'sigx';

/**
 * What the live project page tells the topbar (#333), keyed by project id
 * like `chat/head.ts`: the breadcrumb label comes from the Workspace's
 * project record, which only the page reads.
 */
export const projectHead = signal<{ value: { id: string; name: string } | null }>({ value: null });
