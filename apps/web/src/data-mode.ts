/**
 * Where the core-flow pages read from (#34).
 *
 * `mock` is the design track's workspace (`src/mock/workspace.ts`): the
 * artboards' sample data, deterministic, what the Playwright specs under
 * `e2e/` drive against the Vite dev server — which hosts no actors.
 * `live` is the platform: actor reads through `useActorState`, sessions
 * tailed through `connectSession`, the composer posting to `Chat.post`.
 *
 * Resolution: `VITE_AGENTIC_DATA` when set, else `mock` in dev (and under
 * vitest) and `live` in a production build (the Cloudflare Worker, where
 * the actor mount and the socket exist). Tests flip it with `setDataMode`.
 */
import { signal } from 'sigx';

export type DataMode = 'mock' | 'live';

const env = (import.meta as { env?: Record<string, string | boolean | undefined> }).env ?? {};

function initial(): DataMode {
    const explicit = env.VITE_AGENTIC_DATA;
    if (explicit === 'mock' || explicit === 'live') return explicit;
    return env.DEV ? 'mock' : 'live';
}

const mode = signal({ value: initial() });

/** The current data source; reactive, so a page switching it re-renders. */
export const dataMode = (): DataMode => mode.value;

/** Test seam (and the one knob a dev build has to look at real actors). */
export function setDataMode(next: DataMode): void {
    mode.value = next;
}
