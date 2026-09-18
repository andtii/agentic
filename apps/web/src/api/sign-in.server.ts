import { serverFn } from '@sigx/server';
import { currentSignInOptions, type SignInOptions } from '../auth/sign-in';

/**
 * The sign-in doors the shell may offer a signed-out visitor (#143):
 * GitHub when its OAuth app is configured, the dev login while
 * `AGENTIC_DEV_LOGIN` is set. Anonymous by design — it is what an
 * anonymous visitor needs to stop being one. In-process during SSR (the
 * document carries the answer), a fetch stub in the browser.
 */
export const signInOptions = serverFn({
    allowAnonymous: true,
    handler: async (): Promise<SignInOptions> => currentSignInOptions()
});
