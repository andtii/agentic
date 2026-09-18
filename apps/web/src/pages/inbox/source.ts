/**
 * Where "Needs you" reads from and how it answers (OPS-02, CHT-09, #40).
 *
 * The rows are the workspace Inbox's unread `approval` / `input`
 * notifications, each carrying a `ref` to the session and the request, plus
 * the work an eviction cut short (OPS-05): the router's `interrupted`
 * routes, resumed from the row (#151). The card behind a row is the
 * Session's own `request(id)` view — the question, the call's input, the
 * rule that asked, and the decision once any client made one — so two open
 * tabs, the chat and the phone all render the same record and one answer
 * settles it everywhere: the Session marks the notification read and the
 * live list drops the row.
 *
 * Two sources implement it: `liveNeedsSource` over the actors
 * (`useActorState` live reads, `Session.respond`) and `memoryNeedsSource`
 * for the mock workspace and the tests. `useNeedsSource` (`./index.ts`)
 * resolves the one a page renders — the mock unless the entry provides the
 * live one.
 */
import type { SessionRequestView } from '@agentic/platform';
import type { Decision } from '@sigx/ai-agent';
import type { ApprovalRequester, EnvironmentParts } from '@agentic/ui';

export type NeedsKind = 'approval' | 'input' | 'interrupted';

/** The session and the request an inbox notification points at. */
export interface RequestRef {
    readonly sessionId: string;
    readonly requestId: string;
}

/** One row of "Needs you". */
export interface NeedsRow {
    readonly id: string;
    readonly kind: NeedsKind;
    readonly title: string;
    readonly at: number;
    /** Behind an `approval` / `input` row: what the card reads and answers. */
    readonly ref?: RequestRef;
    /** Who needs you, when the row knows it before the card does (the mock). */
    readonly agent?: ApprovalRequester;
    /** A context line the row carries itself (`delegated by Atlas`); the card's own context follows it. */
    readonly context?: string;
    readonly environment?: EnvironmentParts;
    /** Where the row leads besides the session: `Open chat`, `Open task`. */
    readonly href?: string;
    readonly hrefLabel?: string;
    /** An `interrupted` row's action (`Resume`). */
    readonly primary?: { readonly label: string };
    /** Behind an `interrupted` row: the task the router resumes. */
    readonly taskId?: string;
}

/** The card's data: the Session's record plus how the page names the requester. */
export interface RequestView {
    readonly view: SessionRequestView;
    readonly requestedBy?: ApprovalRequester;
    readonly environment?: EnvironmentParts;
    /** How the request got here — `delegated by Atlas · task t_8f2c · depth 1`. */
    readonly via?: string;
}

/** A row's request as the component sees it: loading, the view, `null` for a request the session does not know, or an error. */
export interface RequestState {
    readonly loading: boolean;
    readonly value: RequestView | null;
    readonly error: Error | null;
}

export interface NeedsSource {
    /** Called in the list's setup: a reactive getter of the rows, in any order (the list sorts). */
    useRows(): () => readonly NeedsRow[];
    /** Called in a row's setup: a reactive getter of the request behind its `ref`. */
    useRequest(ref: RequestRef): () => RequestState;
    /** `Session.respond` — one decision per request; rejects when the answer did not get through. */
    respond(ref: RequestRef, decision: Decision): Promise<void>;
    /** `Routing.resume` for an `interrupted` row — the row leaves once the route runs again; rejects when it did not get through. */
    resume?(row: NeedsRow): Promise<void>;
    /** A relative age in the workspace zone. */
    age(at: number): string;
}

const KIND_ORDER: Record<NeedsKind, number> = { approval: 0, input: 1, interrupted: 2 };

/** Approvals first, then input, then interrupted; oldest first inside each kind (`docs/design/HANDOFF.md` → Home). */
export function sortRows(rows: readonly NeedsRow[]): NeedsRow[] {
    return [...rows].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.at - b.at);
}
