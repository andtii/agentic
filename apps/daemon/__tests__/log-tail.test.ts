/** `log.request` (#481): the tail of the daemon's own log — bounded, the end of the file, redacted, `no-log` without one. */
// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DAEMON_LOG_MAX_LINES } from '@agentic/core';
import { tailLog, TAIL_BYTES } from '../src/log-tail';

describe('tailLog', () => {
    let dir: string;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'agentic-log-tail-'));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });
    const file = () => join(dir, 'logs', 'daemon.log');
    const write = async (lines: readonly string[]) => {
        await mkdir(join(dir, 'logs'), { recursive: true });
        await writeFile(file(), lines.join('\n') + '\n');
    };

    it('answers the END of the log, exactly as many lines as asked, truncated when there were more', async () => {
        await write(Array.from({ length: 10 }, (_, i) => `{"msg":"line ${i + 1}"}`));
        expect(await tailLog(file(), 3)).toEqual({ result: { lines: ['{"msg":"line 8"}', '{"msg":"line 9"}', '{"msg":"line 10"}'], truncated: true } });
        expect(await tailLog(file(), 10)).toMatchObject({ result: { truncated: false } });
        expect((await tailLog(file(), 500)) as unknown as { result: { lines: string[] } }).toMatchObject({ result: { lines: expect.arrayContaining(['{"msg":"line 1"}']), truncated: false } });
        // At least one, at most the contract's cap.
        expect((await tailLog(file(), 0)) as unknown as { result: { lines: string[] } }).toMatchObject({ result: { lines: ['{"msg":"line 10"}'] } });
        expect(((await tailLog(file(), DAEMON_LOG_MAX_LINES + 100)) as unknown as { result: { lines: string[] } }).result.lines).toHaveLength(10);
    });

    it('redacts the token (and anything shaped like a bearer) on the way out, whatever wrote the line', async () => {
        const token = 'amt.ws_1.machine_1.' + 'x'.repeat(43);
        await write([`{"msg":"hello","token":"${token}"}`, 'plain line with the token ' + token]);
        const out = (await tailLog(file(), 5, [token])) as unknown as { result: { lines: string[] } };
        expect(out.result.lines.join('\n')).not.toContain(token);
        expect(out.result.lines).toHaveLength(2);
    });

    it('no file is no-log; an empty file is an empty tail; a CRLF log reads the same', async () => {
        expect(await tailLog(file(), 5)).toMatchObject({ error: { code: 'no-log' } });
        await mkdir(join(dir, 'logs'), { recursive: true });
        await writeFile(file(), '');
        expect(await tailLog(file(), 5)).toEqual({ result: { lines: [], truncated: false } });
        await writeFile(file(), 'a\r\nb\r\n');
        expect(await tailLog(file(), 5)).toEqual({ result: { lines: ['a', 'b'], truncated: false } });
    });

    it('reads at most TAIL_BYTES of a big log and never a cut line', async () => {
        const line = `{"msg":"${'y'.repeat(200)}"}`;
        const count = Math.ceil(TAIL_BYTES / (line.length + 1)) + 50;
        await write(Array.from({ length: count }, (_, i) => line.replace('"}', `","n":${i}"}`)));
        const out = (await tailLog(file(), 500)) as unknown as { result: { lines: string[]; truncated: boolean } };
        expect(out.result.truncated).toBe(true);
        expect(out.result.lines).toHaveLength(500);
        for (const l of out.result.lines) expect(l.startsWith('{"msg":"')).toBe(true);
        expect(out.result.lines.at(-1)).toContain(`"n":${count - 1}`);
    });
});
