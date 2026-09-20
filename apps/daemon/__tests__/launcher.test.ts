/** The `agentic-daemon` command the installer writes, and how a new shell finds it (#354). */
// @vitest-environment node
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    describeLauncher,
    installLauncher,
    launcherPlan,
    launcherScript,
    onPathAlready,
    pathEntries,
    PROFILE_BEGIN,
    profileBlock,
    profileFileFor,
    removeLauncher,
    shQuote,
    userPathCommand,
    withoutProfileBlock,
    withProfileBlock
} from '../src/launcher';

const win = process.platform === 'win32';
const NODE = '/opt/node/bin/node';
const ENTRY = '/home/me/.agentic/daemon/bin/agentic-daemon.mjs';

describe('the launcher script', () => {
    it('execs the Node and the entry the install resolved, whatever is on PATH later', () => {
        const script = launcherScript(NODE, ENTRY, 'linux');
        expect(script.startsWith('#!/bin/sh\n')).toBe(true);
        expect(script).toContain(`exec "${NODE}" "${ENTRY}" "$@"`);
    });

    it('quotes a folder with a space, a quote or a $ so /bin/sh still starts it', () => {
        expect(shQuote('/Users/me/Code Projects/bin/node')).toBe('"/Users/me/Code Projects/bin/node"');
        expect(shQuote('/tmp/we"ird/$HOME/`x`')).toBe('"/tmp/we\\"ird/\\$HOME/\\`x\\`"');
        expect(launcherScript('/n o/node', ENTRY, 'darwin')).toContain('exec "/n o/node"');
    });

    it('is a CRLF .cmd on Windows that passes its arguments on and keeps the exit code', () => {
        const script = launcherScript('C:\\node\\node.exe', 'C:\\daemon\\bin\\agentic-daemon.mjs', 'win32');
        expect(script.split('\n').every((line) => line === '' || line.endsWith('\r'))).toBe(true);
        expect(script).toContain('"C:\\node\\node.exe" "C:\\daemon\\bin\\agentic-daemon.mjs" %*');
        expect(script).toContain('exit /b %ERRORLEVEL%');
        // The code page is the machine's: nothing outside ASCII goes in a .cmd.
        expect([...script].every((c) => c.codePointAt(0)! < 128)).toBe(true);
    });
});

describe('PATH', () => {
    it('reads entries the way the OS does — blanks, quotes and trailing separators do not count', () => {
        expect(pathEntries('/usr/bin:/home/me/.local/bin:', 'linux')).toEqual(['/usr/bin', '/home/me/.local/bin']);
        expect(pathEntries('C:\\bin;"C:\\Program Files\\node";', 'win32')).toEqual(['C:\\bin', 'C:\\Program Files\\node']);
        expect(pathEntries(undefined, 'linux')).toEqual([]);
    });

    it('matches a folder however it is spelled — case and separators only on Windows', () => {
        expect(onPathAlready('/home/me/.local/bin', '/usr/bin:/home/me/.local/bin/', 'linux')).toBe(true);
        expect(onPathAlready('/home/me/.local/bin', '/usr/bin:/home/me/.Local/bin', 'linux')).toBe(false);
        expect(onPathAlready('C:\\Users\\me\\bin', 'C:\\x;c:/users/me/bin\\', 'win32')).toBe(true);
    });
});

describe('the plan', () => {
    const base = { node: NODE, entry: ENTRY, home: '/home/me' } as const;

    it('takes the home folder from the environment it is given, never the real one', () => {
        expect(launcherPlan({ platform: 'linux', env: { HOME: '/home/other' }, node: NODE, entry: ENTRY }).file).toBe('/home/other/.agentic/bin/agentic-daemon');
        expect(launcherPlan({ platform: 'win32', env: { USERPROFILE: 'D:\\me' }, node: NODE, entry: ENTRY }).file).toBe('D:\\me\\AppData\\Local\\agentic\\bin\\agentic-daemon.cmd');
    });

    it('puts the launcher under ~/.agentic/bin, or %LOCALAPPDATA% on Windows', () => {
        expect(launcherPlan({ ...base, platform: 'linux', env: {} }).file).toBe('/home/me/.agentic/bin/agentic-daemon');
        expect(launcherPlan({ ...base, platform: 'win32', home: 'C:\\Users\\me', env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' } }).file).toBe('C:\\Users\\me\\AppData\\Local\\agentic\\bin\\agentic-daemon.cmd');
    });

    it('changes nothing when its own folder is already on PATH', () => {
        const plan = launcherPlan({ ...base, platform: 'darwin', env: { PATH: '/usr/bin:/home/me/.agentic/bin' } });
        expect(plan.onPath).toBe('bin-dir');
        expect(plan.profileFile).toBeUndefined();
    });

    it('prefers linking into a folder the user already has on PATH over touching a profile', () => {
        const plan = launcherPlan({ ...base, platform: 'linux', env: { PATH: '/usr/bin:/home/me/.local/bin', SHELL: '/bin/zsh' } });
        expect(plan.onPath).toBe('link');
        expect(plan.link).toBe('/home/me/.local/bin/agentic-daemon');
    });

    it('falls back to the profile of the shell the user runs', () => {
        const zsh = launcherPlan({ ...base, platform: 'darwin', env: { PATH: '/usr/bin', SHELL: '/bin/zsh' } });
        expect(zsh.onPath).toBe('profile');
        expect(zsh.profileFile).toBe('/home/me/.zshrc');
        expect(zsh.profileBlock).toContain('export PATH="$HOME/.agentic/bin:$PATH"');
        expect(profileFileFor('/usr/local/bin/bash', '/home/me')).toBe('/home/me/.bashrc');
        expect(profileFileFor('/opt/homebrew/bin/fish', '/home/me')).toBe('/home/me/.config/fish/config.fish');
        expect(profileFileFor(undefined, '/home/me')).toBe('/home/me/.profile');
        expect(profileBlock('/home/me/.agentic/bin', '/home/me', '/home/me/.config/fish/config.fish')).toContain('set -gx PATH "$HOME/.agentic/bin" $PATH');
        // Outside the home folder the line cannot use $HOME.
        expect(profileBlock('/opt/agentic/bin', '/home/me', '/home/me/.zshrc')).toContain('export PATH="/opt/agentic/bin:$PATH"');
    });

    it('takes the Windows user PATH, and nothing at all with --no-profile', () => {
        const env = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', Path: 'C:\\Windows' };
        expect(launcherPlan({ ...base, platform: 'win32', home: 'C:\\Users\\me', env }).onPath).toBe('user-path');
        expect(launcherPlan({ ...base, platform: 'win32', home: 'C:\\Users\\me', env, profile: false }).onPath).toBe('manual');
        expect(launcherPlan({ ...base, platform: 'linux', env: { PATH: '/usr/bin' }, profile: false }).onPath).toBe('manual');
    });
});

describe('the profile block', () => {
    it('is appended once and rewritten in place on the next install', () => {
        const block = `${PROFILE_BEGIN}\nexport PATH="$HOME/.agentic/bin:$PATH"\n# <<< agentic-daemon <<<`;
        const once = withProfileBlock('export EDITOR=vi\n', block);
        expect(once).toBe(`export EDITOR=vi\n\n${block}\n`);
        const other = block.replace('.agentic/bin', '.agentic2/bin');
        expect(withProfileBlock(once, other)).toBe(`export EDITOR=vi\n\n${other}\n`);
        expect(withProfileBlock('', block)).toBe(`${block}\n`);
    });

    it('is removed with the blank line it brought, and an untouched file is left alone', () => {
        const block = `${PROFILE_BEGIN}\nexport PATH="$HOME/.agentic/bin:$PATH"\n# <<< agentic-daemon <<<`;
        expect(withoutProfileBlock(withProfileBlock('export EDITOR=vi\n', block))).toBe('export EDITOR=vi\n');
        expect(withoutProfileBlock('export EDITOR=vi\n')).toBe('export EDITOR=vi\n');
    });
});

describe('the Windows user PATH', () => {
    it('is edited through PowerShell, never setx (which truncates a long PATH), and is idempotent', () => {
        const { command, args } = userPathCommand('C:\\Users\\me\\AppData\\Local\\agentic\\bin', 'add');
        expect(command).toBe('powershell');
        const script = args.at(-1)!;
        expect(script).toContain("[Environment]::GetEnvironmentVariable('Path', 'User')");
        expect(script).toContain("[Environment]::SetEnvironmentVariable('Path', ($next -join ';'), 'User')");
        // The folder is filtered out before it is added back, so a second install changes nothing.
        expect(script).toContain('$next = @($kept + $dir)');
        expect(userPathCommand('C:\\x', 'remove').args.at(-1)).toContain('$next = $kept');
        expect(userPathCommand("C:\\it's\\bin", 'add').args.at(-1)).toContain("$dir = 'C:\\it''s\\bin'");
    });
});

describe.skipIf(win)('installing and removing (POSIX)', () => {
    let dir: string;
    let home: string;
    beforeEach(async () => {
        dir = await realpath(await mkdtemp(join(tmpdir(), 'agentic-launcher-')));
        home = join(dir, 'home');
        await mkdir(home, { recursive: true });
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('writes an executable launcher and links it into a folder on PATH', async () => {
        const localBin = join(home, '.local', 'bin');
        await mkdir(localBin, { recursive: true });
        const context = { platform: 'linux' as const, home, env: { PATH: `/usr/bin:${localBin}`, SHELL: '/bin/zsh' }, node: NODE, entry: ENTRY };

        const first = await installLauncher(context);
        const file = join(home, '.agentic', 'bin', 'agentic-daemon');
        expect(first.plan.file).toBe(file);
        expect(await readFile(file, 'utf8')).toContain(`exec "${NODE}" "${ENTRY}" "$@"`);
        expect((await stat(file)).mode & 0o111).toBeTruthy();
        expect(await readlink(join(localBin, 'agentic-daemon'))).toBe(file);
        // No profile was touched: the folder was already reachable.
        await expect(readFile(join(home, '.zshrc'), 'utf8')).rejects.toThrow();

        // Re-running it (an upgrade) repoints the launcher and leaves one link behind.
        const second = await installLauncher({ ...context, node: '/other/node' });
        expect(second.plan.onPath).toBe('link');
        expect(await readFile(file, 'utf8')).toContain('exec "/other/node"');
        expect(await readlink(join(localBin, 'agentic-daemon'))).toBe(file);

        const removed = await removeLauncher(context);
        expect(removed.notes.join('\n')).toContain(`removed ${file}`);
        await expect(stat(file)).rejects.toThrow();
        await expect(stat(join(localBin, 'agentic-daemon'))).rejects.toThrow();
    });

    it('adds a guarded block to the profile when nothing on PATH will do, and takes it back out', async () => {
        const context = { platform: 'linux' as const, home, env: { PATH: '/usr/bin', SHELL: '/bin/zsh' }, node: NODE, entry: ENTRY };
        const zshrc = join(home, '.zshrc');
        await writeFile(zshrc, 'export EDITOR=vi\n');

        const result = await installLauncher(context);
        expect(result.plan.onPath).toBe('profile');
        expect(result.needsNewShell).toBe(true);
        const after = await readFile(zshrc, 'utf8');
        expect(after).toContain('export EDITOR=vi');
        expect(after).toContain(`export PATH="$HOME/.agentic/bin:$PATH"`);

        // A second install does not add the block twice.
        await installLauncher(context);
        expect((await readFile(zshrc, 'utf8')).split(PROFILE_BEGIN).length - 1).toBe(1);

        await removeLauncher(context);
        expect(await readFile(zshrc, 'utf8')).toBe('export EDITOR=vi\n');
    });

    it('writes the launcher but changes no PATH with --no-profile, and says what to add', async () => {
        const context = { platform: 'linux' as const, home, env: { PATH: '/usr/bin', SHELL: '/bin/zsh' }, node: NODE, entry: ENTRY, profile: false };
        const result = await installLauncher(context);
        expect(result.plan.onPath).toBe('manual');
        expect(result.notes.join('\n')).toContain(`export PATH="${join(home, '.agentic', 'bin')}:$PATH"`);
        await expect(readFile(join(home, '.zshrc'), 'utf8')).rejects.toThrow();
        expect(await readFile(join(home, '.agentic', 'bin', 'agentic-daemon'), 'utf8')).toContain('exec ');
    });

    it('removing a launcher that was never installed is not an error', async () => {
        const result = await removeLauncher({ platform: 'linux', home, env: { PATH: '/usr/bin' }, node: NODE, entry: ENTRY });
        expect(result.notes.join('\n')).toContain('no launcher at');
    });
});

describe('launcher show', () => {
    it('says where the command is, what it runs and whether a shell finds it', () => {
        const plan = launcherPlan({ platform: 'linux', home: '/home/me', env: { PATH: '/usr/bin', SHELL: '/bin/zsh' }, node: NODE, entry: ENTRY });
        expect(describeLauncher(plan, { installed: false })).toContain('not installed');
        expect(describeLauncher(plan, { installed: true })).toContain('/home/me/.agentic/bin is not on PATH');
        expect(describeLauncher(plan, { installed: true })).toContain(`runs: ${NODE} ${ENTRY}`);
        const linked = launcherPlan({ platform: 'linux', home: '/home/me', env: { PATH: '/home/me/.local/bin' }, node: NODE, entry: ENTRY });
        expect(describeLauncher(linked, { installed: true, linked: true })).toContain('linked into /home/me/.local/bin');
    });
});
