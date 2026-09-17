import { useData } from 'sigx';
import { whoami } from '../api/viewer.server';
import type { ViewerHook } from './defs';

/** The default `useViewer` hook: `whoami` through `useData` (SSR-seeded, hydrated without a refetch). */
export const viewerHook: ViewerHook = () => {
    const me = useData(whoami);
    return {
        get workspaceId() {
            return me.value?.workspaceId ?? null;
        },
        get pending() {
            return me.loading;
        }
    };
};
