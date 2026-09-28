/**
 * Which host this run of the acceptance suite is on (#995): workerd (`test:workers`) or the Node host
 * (`test:node`). Only a test that asserts what a Durable Object alone has — its own `fetch`, hibernated
 * sockets — reads it.
 */
export const onWorkerd = typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';
