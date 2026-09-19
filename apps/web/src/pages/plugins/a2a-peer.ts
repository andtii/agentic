/**
 * "Add A2A peer" (#246): the dialog's draft, what it refuses, and what it
 * stores — a `kind: runtime` plugin `a2a.<id>` (`a2aPeer`), registered on and
 * granted what it declares, plus its bearer token as the Registry secret
 * `a2a-<id>-token` when one is given. Pure: the page makes the calls.
 */
import { a2aPeer, a2aPeerIdFrom, a2aPeerTokenSecret, A2A_PEER_PREFIX } from '@agentic/a2a';
import type { PluginManifest } from '@agentic/core';

export interface A2aPeerDraft {
    readonly name: string;
    readonly cardUrl: string;
    /** Optional; goes to `setSecret` and nowhere else. */
    readonly token: string;
}

export interface A2aPeerDraftErrors {
    name?: string;
    cardUrl?: string;
}

export const EMPTY_PEER_DRAFT: A2aPeerDraft = { name: '', cardUrl: '', token: '' };

/** The runtime id a draft would get. */
export function peerRuntimeId(draft: A2aPeerDraft): string {
    return `${A2A_PEER_PREFIX}${a2aPeerIdFrom(draft.name)}`;
}

/** What stops the draft from being added; `taken` is every plugin id the workspace lists. */
export function peerDraftErrors(draft: A2aPeerDraft, taken: readonly string[]): A2aPeerDraftErrors {
    const errors: A2aPeerDraftErrors = {};
    const id = a2aPeerIdFrom(draft.name);
    if (!draft.name.trim()) errors.name = 'Give the peer a name.';
    else if (!id) errors.name = 'Use at least one letter or digit.';
    else if (taken.includes(`${A2A_PEER_PREFIX}${id}`)) errors.name = `There is already a peer called ${id}.`;
    const url = draft.cardUrl.trim();
    if (!url) errors.cardUrl = 'Paste the agent card URL, or the agent\'s base URL.';
    else {
        let parsed: URL | undefined;
        try {
            parsed = new URL(url);
        } catch {
            parsed = undefined;
        }
        if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) errors.cardUrl = 'That is not an http(s) URL.';
    }
    return errors;
}

/** What to store for a valid draft: the manifest, and the token under its secret name when there is one. */
export function peerSetup(draft: A2aPeerDraft): { readonly manifest: PluginManifest; readonly secret?: { readonly name: string; readonly value: string } } {
    const id = a2aPeerIdFrom(draft.name);
    const manifest = a2aPeer({ id, name: draft.name.trim(), cardUrl: draft.cardUrl.trim() });
    const token = draft.token.trim();
    return token ? { manifest, secret: { name: a2aPeerTokenSecret(id), value: token } } : { manifest };
}
