import type { DeliveryAttempt, DeliveryTarget, InboxNotification, NotificationChannel } from './types.js';

export interface DeliveryReport {
    readonly attempts: readonly DeliveryAttempt[];
    /** Endpoints every channel agreed are gone. */
    readonly expired: readonly string[];
}

/**
 * Run every channel once for one notification. Channels run concurrently;
 * a rejection or a `{ ok: false }` becomes a recorded attempt, never a throw
 * (OPS-04: failures are shown, not lost).
 */
export async function deliverAll(
    channels: readonly NotificationChannel[],
    notification: InboxNotification,
    target: DeliveryTarget,
    now: () => number = Date.now
): Promise<DeliveryReport> {
    const expired: string[] = [];
    const attempts = await Promise.all(
        channels.map(async (channel): Promise<DeliveryAttempt> => {
            try {
                const result = await channel.deliver(notification, target);
                if (result.expired) expired.push(...result.expired);
                return result.ok
                    ? { channel: channel.id, at: now(), ok: true }
                    : { channel: channel.id, at: now(), ok: false, error: result.error ?? 'delivery failed' };
            } catch (error) {
                return { channel: channel.id, at: now(), ok: false, error: describe(error) };
            }
        })
    );
    return { attempts, expired };
}

function describe(error: unknown): string {
    if (error instanceof Error) return error.message;
    return typeof error === 'string' ? error : 'delivery threw';
}
