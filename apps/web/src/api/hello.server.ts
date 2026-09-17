import { serverFn } from '@sigx/server';

/**
 * A server module: this whole file only ever runs on the server. The client
 * build swaps it for typed fetch stubs, so anything imported here (database
 * clients, secrets, `node:` builtins) never reaches the browser.
 *
 * Every server function is a public endpoint. `allowAnonymous: true` is an
 * explicit choice — the runtime is fail-closed, so a function that declares
 * nothing refuses anonymous callers. Real apps configure `authenticate`
 * once and declare `authorize` where a function needs more.
 */
export const serverTime = serverFn({
    allowAnonymous: true,
    handler: async () => ({
        now: new Date().toISOString(),
        // Called in-process during SSR; over the wire from the browser.
        via: 'server function',
    }),
});
