/**
 * Desktop notifications and the badge (#845), mounted once by the app shell.
 * In a browser `desktopHost()` is `null` and this does nothing; in the desktop
 * app it reads the Inbox and the workspace settings live and hands new
 * notifications and the "Needs you" count to the shell.
 */
import { effect } from 'sigx';
import { useActorState } from '@sigx/actors/app';
import { useActorDefs, useViewer } from '../actors/defs';
import { inboxKeyOf, workspaceKeyOf } from '../actors/keys';
import { desktopHost } from './bridge';
import { noticeTracker } from './notices';

export { desktopHost, type DesktopHost, type DesktopNotice, type LocalMachine } from './bridge';
export { isThisComputer, offerPairing, type ThisComputer } from './machine';
export { noticeHref, noticeOf, noticeTracker, type NoticeTracker } from './notices';

/** Call in the app shell's setup; `badge` is the count the nav's Home badge shows. */
export function useDesktopNotifications(badge: () => number): void {
    if (typeof window === 'undefined') return;
    const host = desktopHost();
    if (!host) return;
    const defs = useActorDefs();
    const viewer = useViewer()();
    const list = useActorState(defs.Inbox, () => viewer.workspaceId && ([inboxKeyOf(viewer.workspaceId), 'list'] as const), { live: true });
    const workspace = useActorState(defs.Workspace, () => viewer.workspaceId && ([workspaceKeyOf(viewer.workspaceId), 'get'] as const), { live: true });
    // One tracker per workspace: switching workspaces without a reload takes the new one's first read as seen too.
    let tracker = noticeTracker();
    let trackedWorkspace = viewer.workspaceId;
    effect(() => {
        const notifications = list.value;
        const settings = workspace.value?.settings;
        if (viewer.workspaceId !== trackedWorkspace) {
            trackedWorkspace = viewer.workspaceId;
            tracker = noticeTracker();
        }
        if (!notifications || !settings) return;
        for (const notice of tracker.next(notifications, settings.notifications.push)) void host.notify(notice).catch(() => {});
    });
    effect(() => {
        void host.setBadge(badge()).catch(() => {});
    });
}
