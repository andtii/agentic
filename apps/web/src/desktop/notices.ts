/**
 * Which Inbox notifications become desktop notifications (#845). Pure, so the
 * rules are tested without a webview:
 *
 * - Only notifications that arrive while the app is open: the first list the
 *   page reads is taken as already seen, so starting the app never replays
 *   the Inbox.
 * - Only unread ones — one read elsewhere in the meantime stays quiet.
 * - Only while the workspace's push switch is on (`notifications.push`,
 *   decisions 2026-09-25 #302): the desktop app is an outbound channel like
 *   Web Push, and `push: false` means no outbound channel at all.
 */
import type { InboxNotification } from '@agentic/platform';
import type { DesktopNotice } from './bridge';
import { chatHref } from '../pages/chat/href';

/** Where clicking a notification lands: an answer is given on Home's "Needs you", anything else opens what it points at. */
export function noticeHref(n: Pick<InboxNotification, 'kind' | 'ref'>): string {
    if (n.kind === 'approval' || n.kind === 'input') return '/';
    switch (n.ref?.kind) {
        case 'chat': return chatHref({ id: n.ref.chatId });
        case 'task': return `/tasks/${n.ref.taskId}`;
        case 'session': return `/sessions/${n.ref.sessionId}`;
        case 'machine': return `/machines/${n.ref.machineId}`;
        case 'schedule': return '/schedules';
        default: return '/';
    }
}

export function noticeOf(n: InboxNotification): DesktopNotice {
    return { title: n.title, ...(n.body ? { body: n.body } : {}), url: noticeHref(n) };
}

export interface NoticeTracker {
    /** The notices to show for this read of the Inbox list. */
    next(list: readonly InboxNotification[], push: boolean): DesktopNotice[];
}

export function noticeTracker(): NoticeTracker {
    let seen: Set<string> | null = null;
    return {
        next(list, push) {
            if (seen === null) {
                seen = new Set(list.map((n) => n.id));
                return [];
            }
            const fresh = list.filter((n) => !seen!.has(n.id));
            for (const n of fresh) seen.add(n.id);
            if (!push) return [];
            return fresh.filter((n) => !n.read).map(noticeOf);
        }
    };
}
