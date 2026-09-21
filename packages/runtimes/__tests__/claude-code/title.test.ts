// @vitest-environment node
/** The title Claude Code gives a conversation, read from the tail of its transcript (#460). */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectSlug, readFileTail, readSessionTitle, titleFromTranscriptTail, transcriptPath, TITLE_TAIL_BYTES } from '../../src/claude-code/title';

const row = (r: object) => `${JSON.stringify(r)}\n`;
const CWD = 'C:\\src\\app';

describe('projectSlug / transcriptPath', () => {
    it('files a cwd the way the CLI does: every non-alphanumeric character is a dash', () => {
        expect(projectSlug('C:\\Dev\\agentic\\main')).toBe('C--Dev-agentic-main');
        expect(projectSlug('/home/andy/src/app.v2')).toBe('-home-andy-src-app-v2');
        expect(transcriptPath('C:\\profiles\\work\\', CWD, 'abc-123')).toBe('C:\\profiles\\work/projects/C--src-app/abc-123.jsonl');
    });

    it('gives up on a path the CLI would cut and hash', () => {
        expect(projectSlug(`/${'x'.repeat(200)}`)).toBeUndefined();
        expect(transcriptPath('/cfg', `/${'x'.repeat(200)}`, 's')).toBeUndefined();
    });
});

describe('titleFromTranscriptTail', () => {
    it('takes the newest ai-title row', () => {
        const text = row({ type: 'ai-title', aiTitle: 'First guess', sessionId: 's' }) + row({ type: 'user', message: {} }) + row({ type: 'ai-title', aiTitle: 'Chat list auto-generated titles', sessionId: 's' });
        expect(titleFromTranscriptTail(text)).toBe('Chat list auto-generated titles');
    });

    it('a custom title (/rename) wins over any ai-title, even a newer one', () => {
        const text = row({ type: 'custom-title', customTitle: 'Titles work', sessionId: 's' }) + row({ type: 'ai-title', aiTitle: 'Newer guess', sessionId: 's' });
        expect(titleFromTranscriptTail(text)).toBe('Titles work');
    });

    it('skips a cut first line, non-JSON rows, blank titles and whitespace', () => {
        const text = `Title":"cut off"}\n${row({ type: 'ai-title', aiTitle: '   ' })}not json\n${row({ type: 'ai-title', aiTitle: '  Two   words \n' })}`;
        expect(titleFromTranscriptTail(text)).toBe('Two words');
        expect(titleFromTranscriptTail('')).toBeUndefined();
        expect(titleFromTranscriptTail(row({ type: 'user', message: { content: '"ai-title"' } }))).toBeUndefined();
    });
});

describe('readSessionTitle', () => {
    let dir: string;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'agentic-title-'));
        await mkdir(join(dir, 'projects', 'C--src-app'), { recursive: true });
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('reads the title from the transcript under the config dir, and undefined before the CLI filed one', async () => {
        expect(await readSessionTitle({ configDir: dir, cwd: CWD, sessionId: 'sess' })).toBeUndefined();
        const path = transcriptPath(dir, CWD, 'sess')!;
        await writeFile(path, row({ type: 'user' }));
        expect(await readSessionTitle({ configDir: dir, cwd: CWD, sessionId: 'sess' })).toBeUndefined();
        await writeFile(path, row({ type: 'user' }) + row({ type: 'ai-title', aiTitle: 'Root folder check', sessionId: 'sess' }));
        expect(await readSessionTitle({ configDir: dir, cwd: CWD, sessionId: 'sess' })).toBe('Root folder check');
    });

    it('reads only the tail of a long transcript', async () => {
        const path = transcriptPath(dir, CWD, 'long')!;
        const filler = row({ type: 'assistant', message: { content: 'x'.repeat(1000) } });
        await writeFile(path, row({ type: 'ai-title', aiTitle: 'Old' }) + filler.repeat(Math.ceil(TITLE_TAIL_BYTES / filler.length) + 2) + row({ type: 'ai-title', aiTitle: 'New' }));
        expect((await readFileTail(path, TITLE_TAIL_BYTES))!.length).toBeLessThanOrEqual(TITLE_TAIL_BYTES);
        expect(await readSessionTitle({ configDir: dir, cwd: CWD, sessionId: 'long' })).toBe('New');
    });

    it('never throws: a tail reader that fails reads no title', async () => {
        expect(await readSessionTitle({ configDir: dir, cwd: '/w', sessionId: 's', readTail: async () => Promise.reject(new Error('EACCES')) })).toBeUndefined();
    });
});
