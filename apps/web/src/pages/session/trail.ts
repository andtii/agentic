/**
 * The breadcrumb of a session's views (#564, `Changes` / `Files` boards):
 * Agents › <agent> › Sessions › <ref> › Changes. The agent's page lists its
 * sessions (`?tab=sessions`); the ref links back to the Transcript.
 */
import type { Crumb } from '../../crumbs';
import type { MockSessionView } from '../../mock/workspace';
import { transcriptHref } from './files';

export function sessionTrail(id: string, v: Pick<MockSessionView, 'ref' | 'agentId'>, agentName: string | undefined, view?: string): Crumb[] {
    const agent = `/agents/${encodeURIComponent(v.agentId)}`;
    const trail: Crumb[] = [
        { label: 'Agents', href: '/agents' },
        { label: agentName ?? v.agentId, href: agent },
        { label: 'Sessions', href: `${agent}?tab=sessions` },
        { label: v.ref, href: transcriptHref(id), ...(view ? {} : { current: true }) }
    ];
    if (view) trail.push({ label: view, href: `${transcriptHref(id)}/${view.toLowerCase()}`, current: true });
    return trail;
}
