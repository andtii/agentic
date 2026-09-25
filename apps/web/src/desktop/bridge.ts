/**
 * The desktop shell's side of the page (architecture §13, #845): a
 * `DesktopHost` when the page runs inside the Agentic desktop app, `null` in
 * a browser. Pages only ever see the interface, so a different shell can
 * replace Tauri later without touching them.
 *
 * Tauri injects `__TAURI_INTERNALS__` into the window it loads the server in;
 * the shell grants that origin exactly the commands below. No
 * `@tauri-apps/api` in the bundle — `invoke` is all this needs.
 */

/** A native notification: `url` is an in-app path the shell opens on click (`/chats/…`). */
export interface DesktopNotice {
    readonly title: string;
    readonly body?: string;
    readonly url?: string;
}

/** The daemon paired on this computer against this server (#846): ids only, never its token. */
export interface LocalMachine {
    readonly workspaceId: string;
    readonly machineId: string;
    readonly name: string;
}

export interface DesktopHost {
    notify(notice: DesktopNotice): Promise<void>;
    /** The tray / dock / taskbar badge; 0 clears it. */
    setBadge(count: number): Promise<void>;
    /** This computer's paired machine, or `null` when no daemon here is paired to this server. */
    localMachine(): Promise<LocalMachine | null>;
}

interface TauriInternals {
    invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
}

/** The host this page runs in, or `null` in a browser (and during SSR). */
export function desktopHost(g: typeof globalThis = globalThis): DesktopHost | null {
    const internals = (g as { __TAURI_INTERNALS__?: Partial<TauriInternals> }).__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== 'function') return null;
    const invoke = internals.invoke.bind(internals);
    return {
        notify: async (n) => {
            await invoke('notify', { title: n.title, body: n.body ?? null, url: n.url ?? null });
        },
        setBadge: async (count) => {
            await invoke('set_badge', { count: Math.max(0, Math.floor(count)) });
        },
        localMachine: async () => ((await invoke('local_machine')) as LocalMachine | null) ?? null
    };
}
