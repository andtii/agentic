// @vitest-environment node
import { AuthProviderError, beginOAuth, completeOAuth, codeChallengeS256, githubAuthProvider, OAUTH_COOKIE, safeReturnTo, readCookie } from '../../src/index';

const SECRET = 'test-session-secret-that-is-long-enough';
const NOW = 1_800_000_000_000;
const redirectUri = 'https://app.test/auth/callback';

interface Seen {
    url: string;
    init?: RequestInit;
}

/** An offline GitHub: records requests, answers from a script. */
function fakeGitHub(script: { token?: unknown; tokenStatus?: number; user?: unknown; emails?: unknown; emailsStatus?: number }) {
    const seen: Seen[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        seen.push({ url, init });
        const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
        if (url === 'https://github.com/login/oauth/access_token') return json(script.token ?? { access_token: 'gho_x', token_type: 'bearer' }, script.tokenStatus ?? 200);
        if (url === 'https://api.github.com/user') return json(script.user ?? { id: 42, login: 'ada', name: 'Ada', email: null, avatar_url: 'https://a/ada.png' });
        if (url === 'https://api.github.com/user/emails') return json(script.emails ?? [{ email: 'ada@example.com', primary: true, verified: true }], script.emailsStatus ?? 200);
        return new Response('not found', { status: 404 });
    };
    return { seen, fetch };
}

describe('githubAuthProvider', () => {
    it('builds the authorize URL with state and an S256 challenge', async () => {
        const provider = githubAuthProvider({ clientId: 'cid', clientSecret: 'sec' });
        const url = new URL(provider.authorizationUrl({ redirectUri, state: 'st', codeChallenge: 'ch' }));
        expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
        expect(Object.fromEntries(url.searchParams)).toEqual({
            client_id: 'cid',
            redirect_uri: redirectUri,
            scope: 'read:user user:email',
            state: 'st',
            allow_signup: 'false',
            code_challenge: 'ch',
            code_challenge_method: 'S256'
        });
        expect(provider.pkce).toBe(true);
        expect(githubAuthProvider({ clientId: 'cid', clientSecret: 'sec', pkce: false }).pkce).toBe(false);
    });

    it('exchanges the code, reads the profile and the primary verified email', async () => {
        const gh = fakeGitHub({});
        const provider = githubAuthProvider({ clientId: 'cid', clientSecret: 'sec', fetch: gh.fetch });
        const identity = await provider.exchangeCode({ code: 'c0de', redirectUri, codeVerifier: 'ver' });
        expect(identity).toEqual({ provider: 'github', subject: '42', login: 'ada', name: 'Ada', email: 'ada@example.com', avatarUrl: 'https://a/ada.png' });
        const token = gh.seen[0]!.init!;
        expect(token.method).toBe('POST');
        expect(Object.fromEntries(new URLSearchParams(token.body as string))).toEqual({ client_id: 'cid', client_secret: 'sec', code: 'c0de', redirect_uri: redirectUri, code_verifier: 'ver' });
        expect((token.headers as Record<string, string>).accept).toBe('application/json');
        const user = gh.seen[1]!.init!;
        expect((user.headers as Record<string, string>).authorization).toBe('Bearer gho_x');
        expect((user.headers as Record<string, string>)['user-agent']).toBe('agentic');
        expect(gh.seen.map((s) => s.url)).toEqual(['https://github.com/login/oauth/access_token', 'https://api.github.com/user', 'https://api.github.com/user/emails']);
    });

    it('reports exchange and profile failures as AuthProviderError, and survives a missing email', async () => {
        const denied = githubAuthProvider({ clientId: 'cid', clientSecret: 'sec', fetch: fakeGitHub({ token: { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' } }).fetch });
        await expect(denied.exchangeCode({ code: 'x', redirectUri })).rejects.toMatchObject({ name: 'AuthProviderError', code: 'exchange_failed', message: /incorrect or expired/ });
        const down = githubAuthProvider({ clientId: 'cid', clientSecret: 'sec', fetch: fakeGitHub({ tokenStatus: 503 }).fetch });
        await expect(down.exchangeCode({ code: 'x', redirectUri })).rejects.toBeInstanceOf(AuthProviderError);
        const noEmail = githubAuthProvider({ clientId: 'cid', clientSecret: 'sec', fetch: fakeGitHub({ emailsStatus: 403 }).fetch });
        await expect(noEmail.exchangeCode({ code: 'x', redirectUri })).resolves.toEqual({ provider: 'github', subject: '42', login: 'ada', name: 'Ada', avatarUrl: 'https://a/ada.png' });
        const network = githubAuthProvider({
            clientId: 'cid',
            clientSecret: 'sec',
            fetch: async () => {
                throw new TypeError('fetch failed');
            }
        });
        await expect(network.exchangeCode({ code: 'x', redirectUri })).rejects.toMatchObject({ code: 'network' });
    });
});

describe('beginOAuth / completeOAuth', () => {
    const provider = (fetch: typeof globalThis.fetch) => githubAuthProvider({ clientId: 'cid', clientSecret: 'sec', fetch });

    /** Simulate the browser: keep the transient cookie, come back with the provider's redirect. */
    async function roundTrip(query: Record<string, string> | ((state: string) => Record<string, string>), options: { now?: number; cookie?: string | null } = {}) {
        const gh = fakeGitHub({});
        const p = provider(gh.fetch);
        const begun = await beginOAuth(p, { secret: SECRET, redirectUri, returnTo: '/agents', now: NOW });
        const location = new URL(begun.location);
        const state = location.searchParams.get('state')!;
        const cookieValue = readCookie(begun.setCookie.split(';')[0]!, OAUTH_COOKIE)!;
        const params = typeof query === 'function' ? query(state) : query;
        const cookie = options.cookie === null ? undefined : (options.cookie ?? `${OAUTH_COOKIE}=${encodeURIComponent(cookieValue)}`);
        const request = new Request(`${redirectUri}?${new URLSearchParams(params)}`, { headers: cookie ? { cookie } : {} });
        const result = await completeOAuth(p, request, { secret: SECRET, redirectUri, now: options.now ?? NOW + 1000 });
        return { begun, location, state, result, gh };
    }

    it('happy path: state matches, PKCE verifier reaches the exchange, identity and returnTo come back', async () => {
        const { begun, location, result, gh } = await roundTrip((state) => ({ code: 'c0de', state }));
        expect(begun.setCookie).toMatch(new RegExp(`^${OAUTH_COOKIE}=.+; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax$`));
        const challenge = location.searchParams.get('code_challenge')!;
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.identity.subject).toBe('42');
        expect(result.returnTo).toBe('/agents');
        expect(result.clearCookie).toMatch(/Max-Age=0/);
        const verifier = new URLSearchParams(gh.seen[0]!.init?.body as string).get('code_verifier')!;
        expect(await codeChallengeS256(verifier)).toBe(challenge);
    });

    it('refuses a mismatched or missing state, a missing transient, an expired transient, and a provider denial', async () => {
        expect((await roundTrip({ code: 'c0de', state: 'forged' })).result).toMatchObject({ ok: false, reason: 'state_mismatch' });
        expect((await roundTrip({ code: 'c0de' })).result).toMatchObject({ ok: false, reason: 'state_mismatch' });
        expect((await roundTrip((s) => ({ code: 'c0de', state: s }), { cookie: null })).result).toMatchObject({ ok: false, reason: 'missing_transient' });
        expect((await roundTrip((s) => ({ code: 'c0de', state: s }), { now: NOW + 11 * 60_000 })).result).toMatchObject({ ok: false, reason: 'missing_transient' });
        expect((await roundTrip((s) => ({ error: 'access_denied', state: s }))).result).toMatchObject({ ok: false, reason: 'provider_denied' });
        expect((await roundTrip((s) => ({ state: s }))).result).toMatchObject({ ok: false, reason: 'missing_code' });
    });

    it('reports a failed exchange without throwing', async () => {
        const p = provider(fakeGitHub({ tokenStatus: 500 }).fetch);
        const begun = await beginOAuth(p, { secret: SECRET, redirectUri, now: NOW });
        const state = new URL(begun.location).searchParams.get('state')!;
        const cookie = begun.setCookie.split(';')[0]!;
        const result = await completeOAuth(p, new Request(`${redirectUri}?code=x&state=${state}`, { headers: { cookie } }), { secret: SECRET, redirectUri, now: NOW });
        expect(result).toMatchObject({ ok: false, reason: 'exchange_failed' });
        if (!result.ok) expect(result.error).toBeInstanceOf(AuthProviderError);
    });

    it('sends no challenge for a provider without PKCE', async () => {
        const p = { ...provider(fakeGitHub({}).fetch), pkce: false };
        const begun = await beginOAuth(p, { secret: SECRET, redirectUri, now: NOW });
        expect(new URL(begun.location).searchParams.has('code_challenge')).toBe(false);
    });

    it('safeReturnTo keeps only same-origin paths', () => {
        expect(safeReturnTo('/chats/1')).toBe('/chats/1');
        expect(safeReturnTo('//evil.test')).toBe('/');
        expect(safeReturnTo('https://evil.test')).toBe('/');
        expect(safeReturnTo('/\\evil.test')).toBe('/');
        expect(safeReturnTo(null)).toBe('/');
    });
});
