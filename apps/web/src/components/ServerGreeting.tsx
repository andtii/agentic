import { component, useData } from 'sigx';
import { serverTime } from '../api/hello.server';

/**
 * Reads a server function with `useData`. During SSR the call is direct
 * (no HTTP) and its result transfers with the page; in the browser the same
 * import is a fetch stub.
 */
export const ServerGreeting = component(() => {
    const info = useData(serverTime);
    return () => (
        <p class="muted">
            {info.value ? `Server time ${info.value.now} — ${info.value.via}` : 'Asking the server…'}
        </p>
    );
});
