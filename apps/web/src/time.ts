/**
 * Times as the live pages print them (#150): in the workspace's zone
 * (`Workspace.settings.timeZone`), measured against the real clock. The mock
 * workspace keeps its own frozen clock and zone (`mock/workspace.ts`), so the
 * design track and Playwright render the same minute forever.
 *
 * A formatter is a value a page passes to its pure adapters — there is no
 * module-level "current zone": two server renders for two workspaces share
 * this module.
 */
import { useActorState } from '@sigx/actors/app';
import type { ActorDefs, ViewerState } from './actors/defs';
import { workspaceKeyOf } from './actors/keys';
import { dataMode } from './data-mode';
import { MOCK_NOW } from './mock/workspace';

/** What a workspace without a saved zone uses — the platform's `DEFAULT_SETTINGS.timeZone`. */
export const DEFAULT_ZONE = 'UTC';

export interface ZoneFormat {
    readonly zone: string;
    /** `14:02` */
    time(ms: number): string;
    /** `16 Sep 14:02` */
    dateTime(ms: number): string;
    /** A relative age (`14m`, `3h`) that becomes a date after 24 h (docs/design/HANDOFF.md → Edge cases, time zones). */
    age(ms: number, now: number): string;
}

const formats = new Map<string, ZoneFormat>();

function build(zone: string): ZoneFormat {
    const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false });
    const dateFmt = new Intl.DateTimeFormat('en-GB', { timeZone: zone, day: 'numeric', month: 'short' });
    const dateTimeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: zone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
    return {
        zone,
        time: (ms) => timeFmt.format(ms),
        dateTime: (ms) => dateTimeFmt.format(ms),
        age(ms, now) {
            const minutes = Math.round(Math.max(0, now - ms) / 60_000);
            if (minutes < 1) return 'now';
            if (minutes < 60) return `${minutes}m`;
            const hours = Math.floor(minutes / 60);
            if (hours < 24) return `${hours}h`;
            return dateFmt.format(ms);
        }
    };
}

/** The formatter of an IANA zone, built once per zone. A zone `Intl` does not know formats as `DEFAULT_ZONE`. */
export function zoneFormat(zone: string = DEFAULT_ZONE): ZoneFormat {
    let fmt = formats.get(zone);
    if (!fmt) {
        try {
            fmt = build(zone);
        } catch {
            // Never cached under its own name: the zone is whatever string a workspace saved, and the map outlives the request.
            return zoneFormat(DEFAULT_ZONE);
        }
        formats.set(zone, fmt);
    }
    return fmt;
}

/** The clock ages are measured against: the real one on the platform, the mock workspace's frozen one otherwise. */
export const clockNow = (): number => (dataMode() === 'live' ? Date.now() : MOCK_NOW);

/** The workspace's zone, read live — call in a component's setup; the getter is reactive. */
export function useWorkspaceZone(defs: ActorDefs, viewer: ViewerState): () => string {
    const workspace = useActorState(defs.Workspace, () => viewer.workspaceId && ([workspaceKeyOf(viewer.workspaceId), 'get'] as const), { live: true });
    return () => workspace.value?.settings.timeZone || DEFAULT_ZONE;
}
