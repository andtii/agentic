/**
 * Mock data for /projects/links (#765) — imported only by its own page; nothing shared re-exports it. Open is the
 * board (docs/design/projects/boards/Links.dc.html): agentic 0.5 waits on agentic#16, which waits on signalx#14;
 * zero-wip waits on two SignalX items.
 */
import type { LinkActor, LinksData } from '../../pages/projects/links/model';

const ATLAS: LinkActor = { name: 'Atlas', hue: 1 };
const NOVA: LinkActor = { name: 'Nova', hue: 4 };
const FORGE: LinkActor = { name: 'Forge', hue: 2 };
const LINT: LinkActor = { name: 'Lint', hue: 3 };
const YOU: LinkActor = { name: 'Andii', person: true, monogram: 'AN' };

const LANES = [
    { projectId: 'p_agentic', name: 'agentic', manager: ATLAS },
    { projectId: 'p_signalx', name: 'SignalX', manager: NOVA },
    { projectId: 'p_zero', name: 'zero-wip', manager: ATLAS }
] as const;

export const MOCK_PROJECT_LINKS: LinksData = {
    open: {
        lanes: LANES,
        items: [
            { ref: 'signalx#14', projectId: 'p_signalx', state: 'claimed', title: 'batch() keeps updates on throw', meta: 'PR #88 · checks running', owner: FORGE, after: [], step: { text: 'Forge is fixing it; PR #88 checks running', tone: 'working' } },
            { ref: 'agentic#16', projectId: 'p_agentic', state: 'blocked', title: 'Bump SignalX once batch() is fixed', meta: 'waits on signalx#14', owner: FORGE, after: ['signalx#14'], step: { text: 'starts when #14 merges, first in Forge’s queue' } },
            { ref: 'agentic 0.5', projectId: 'p_agentic', state: 'blocked', title: 'Release: tag and publish', meta: 'waits on #16 and 4 more', owner: YOU, after: ['agentic#16'], milestone: true, step: { text: 'plus 4 items inside agentic, 2 of them yours', tone: 'needs-you' } },
            { ref: 'signalx#13', projectId: 'p_signalx', state: 'ready', title: 'Export the Signal type from root', meta: 'asked by zero-wip · queued 2', owner: FORGE, after: [] },
            { ref: 'zero-wip#7', projectId: 'p_zero', state: 'blocked', title: 'Adopt the fixed batch()', meta: 'waits on signalx#14', owner: LINT, after: ['signalx#14'] },
            { ref: 'zero-wip#8', projectId: 'p_zero', state: 'blocked', title: 'Use Signal type in props', meta: 'waits on signalx#13', owner: LINT, after: ['signalx#13'] }
        ]
    },
    done: {
        lanes: LANES,
        items: [
            { ref: 'signalx#9', projectId: 'p_signalx', state: 'done', title: 'Stable effect ordering', meta: 'merged · PR #71', owner: FORGE, after: [] },
            { ref: 'agentic#11', projectId: 'p_agentic', state: 'done', title: 'Adopt stable effect ordering', meta: 'waited on signalx#9', owner: FORGE, after: ['signalx#9'] },
            { ref: 'agentic 0.4', projectId: 'p_agentic', state: 'done', title: 'Release: tag and publish', meta: 'shipped', owner: YOU, after: ['agentic#11'], milestone: true },
            { ref: 'zero-wip#3', projectId: 'p_zero', state: 'done', title: 'Drop the effect workaround', meta: 'waited on signalx#9', owner: LINT, after: ['signalx#9'] }
        ]
    }
};
