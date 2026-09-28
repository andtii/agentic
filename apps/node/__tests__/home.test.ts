/** The Node host's data directory (#988): layout, first-run secrets, `.env` precedence. */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { homeDir, openHome, parseDotEnv } from '../src/home';

describe('openHome', () => {
    const dirs: string[] = [];
    afterEach(async () => {
        for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
    });
    const fresh = async (): Promise<string> => {
        const dir = await mkdtemp(join(tmpdir(), 'agentic-home-'));
        dirs.push(dir);
        return join(dir, 'home');
    };

    it('defaults to ~/.agentic, or $AGENTIC_HOME', () => {
        expect(homeDir({})).toBe(join(homedir(), '.agentic'));
        expect(homeDir({ AGENTIC_HOME: join(tmpdir(), 'x') })).toBe(join(tmpdir(), 'x'));
    });

    it('creates the layout and generates the two secrets once, owner-only', async () => {
        const dir = await fresh();
        const first = openHome({ dir, processEnv: {} });
        expect(first.generated).toEqual(['SESSION_SECRET', 'WORKSPACE_KEK']);
        for (const d of [first.files, first.logs]) expect(existsSync(d)).toBe(true);
        expect(first.database).toBe(join(dir, 'agentic.db'));
        expect(first.env.SESSION_SECRET!.length).toBeGreaterThanOrEqual(32);
        expect(Buffer.from(first.env.WORKSPACE_KEK!, 'base64')).toHaveLength(32);
        if (process.platform !== 'win32') expect(statSync(first.envFile).mode & 0o777).toBe(0o600);

        const second = openHome({ dir, processEnv: {} });
        expect(second.generated).toEqual([]);
        expect(second.env.SESSION_SECRET).toBe(first.env.SESSION_SECRET);
        expect(second.env.WORKSPACE_KEK).toBe(first.env.WORKSPACE_KEK);
    });

    it('keeps what .env has, lets the process env win, and defaults APP_ORIGIN to the port', async () => {
        const dir = await fresh();
        openHome({ dir, processEnv: {} });
        const envFile = join(dir, '.env');
        writeFileSync(envFile, `${readFileSync(envFile, 'utf8')}AGENTIC_DEV_LOGIN="from-the-file-0123"\nPORT=9000\n`);
        const home = openHome({ dir, processEnv: { AGENTIC_DEV_LOGIN: 'from-the-shell-0123' } });
        expect(home.env.AGENTIC_DEV_LOGIN).toBe('from-the-shell-0123');
        expect(home.port).toBe(9000);
        expect(home.env.APP_ORIGIN).toBe('http://localhost:9000');
        expect(openHome({ dir, processEnv: { APP_ORIGIN: 'https://agentic.example' } }).env.APP_ORIGIN).toBe('https://agentic.example');
    });

    it('parses KEY=value lines, comments and quotes', () => {
        expect(parseDotEnv('# c\n\nA=1\nB = "two words"\nC=\'x=y\'\nnot a line\n')).toEqual({ A: '1', B: 'two words', C: 'x=y' });
    });
});
