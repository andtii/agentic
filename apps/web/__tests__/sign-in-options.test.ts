/**
 * The local owner's doors in the sign-in options (#1016): a Node host reports the passphrase login once claimed, or
 * that it is unclaimed; the Cloudflare entry records only GitHub / dev login, so both stay false there.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { currentSignInOptions, localLoginHref, LOCAL_LOGIN_PATH, setSignInOptions } from '../src/auth/sign-in';

describe('sign-in options: the local passphrase door', () => {
    afterEach(() => setSignInOptions({ github: false, devLogin: false }));

    it('Cloudflare records GitHub / dev login only: the local doors stay closed', () => {
        setSignInOptions({ github: true, devLogin: true, localPassphrase: true, localUnclaimed: true });
        setSignInOptions({ github: true, devLogin: false });
        expect(currentSignInOptions()).toEqual({ github: true, devLogin: false, localPassphrase: false, localUnclaimed: false });
    });

    it('a claimed node opens the passphrase login; an unclaimed one says so', () => {
        setSignInOptions({ github: false, devLogin: false, localPassphrase: true });
        expect(currentSignInOptions()).toMatchObject({ localPassphrase: true, localUnclaimed: false });
        setSignInOptions({ github: false, devLogin: false, localUnclaimed: true });
        expect(currentSignInOptions()).toMatchObject({ localPassphrase: false, localUnclaimed: true });
    });

    it('the passphrase link carries returnTo', () => {
        expect(localLoginHref('/')).toBe(LOCAL_LOGIN_PATH);
        expect(localLoginHref('')).toBe(LOCAL_LOGIN_PATH);
        expect(localLoginHref('/projects/p1?tab=work')).toBe('/auth/local-login?returnTo=%2Fprojects%2Fp1%3Ftab%3Dwork');
    });
});
