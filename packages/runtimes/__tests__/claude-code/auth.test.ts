/** `readProfileAuth`: a profile's sign-in state from its config dir, without the CLI. */
import { readProfileAuth, type ProfileAuthDeps } from '../../src/claude-code/index';

const deps = (files: Record<string, string>, over: Partial<ProfileAuthDeps> = {}): ProfileAuthDeps => ({
    readText: async (p) => files[p],
    platform: 'win32',
    now: () => 1_000,
    ...over
});
const creds = (oauth: unknown) => JSON.stringify({ claudeAiOauth: oauth });

describe('readProfileAuth', () => {
    it('missing credentials → missing', async () => {
        await expect(readProfileAuth('C:/p', 'C:/p/.claude.json', deps({}))).resolves.toEqual({ authStatus: 'missing' });
    });

    it('a refresh token → ok, whatever the access token expiry; identity from the account file', async () => {
        const files = {
            'C:/p/.credentials.json': creds({ accessToken: 'a', refreshToken: 'r', expiresAt: 1 }),
            'C:/p/.claude.json': JSON.stringify({ oauthAccount: { emailAddress: 'me@example.com' } })
        };
        await expect(readProfileAuth('C:/p/', 'C:/p/.claude.json', deps(files))).resolves.toEqual({ authStatus: 'ok', identity: 'me@example.com' });
    });

    it('an access token without a refresh token → expired once past expiresAt', async () => {
        await expect(readProfileAuth('C:/p', 'C:/p/.claude.json', deps({ 'C:/p/.credentials.json': creds({ accessToken: 'a', expiresAt: 999 }) }))).resolves.toEqual({ authStatus: 'expired' });
        await expect(readProfileAuth('C:/p', 'C:/p/.claude.json', deps({ 'C:/p/.credentials.json': creds({ accessToken: 'a', expiresAt: 2_000 }) }))).resolves.toEqual({ authStatus: 'ok' });
    });

    it('unreadable or unexpected credentials → unknown', async () => {
        await expect(readProfileAuth('C:/p', 'C:/p/.claude.json', deps({ 'C:/p/.credentials.json': '{nope' }))).resolves.toEqual({ authStatus: 'unknown' });
        await expect(readProfileAuth('C:/p', 'C:/p/.claude.json', deps({ 'C:/p/.credentials.json': '{}' }))).resolves.toEqual({ authStatus: 'unknown' });
    });

    it('macOS keeps credentials in the Keychain → unknown, identity still read', async () => {
        const files = { '/p/.claude.json': JSON.stringify({ oauthAccount: { emailAddress: 'me@example.com' } }) };
        await expect(readProfileAuth('/p', '/p/.claude.json', deps(files, { platform: 'darwin' }))).resolves.toEqual({ authStatus: 'unknown', identity: 'me@example.com' });
    });
});
