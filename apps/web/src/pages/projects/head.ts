import { signal } from 'sigx';

/**
 * What the live project page tells the shell (#333), keyed by project id like `chat/head.ts`: the breadcrumb label
 * comes from the Workspace's project record, which only the page reads. Inside a project (#725) `ProjectLayout` also
 * says which features are on and whether it has a manager, so the sidebar can draw the project's menu.
 */
export interface ProjectHead {
    readonly id: string;
    readonly name: string;
    /** The enabled project feature ids. */
    readonly features?: readonly string[];
    /** The project has a coordinator (its manager): the menu shows Requests. */
    readonly manager?: boolean;
}

export const projectHead = signal<{ value: ProjectHead | null }>({ value: null });
