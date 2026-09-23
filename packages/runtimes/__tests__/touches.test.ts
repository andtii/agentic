import { CLAUDE_CODE_PLUGIN_ID, filesTouched, registerFileTouches } from '../src/index';

describe('filesTouched (#565)', () => {
    it('reads the file Claude Code editing tools name, in the input shapes the CLI sends', () => {
        expect(filesTouched(CLAUDE_CODE_PLUGIN_ID, { name: 'Edit', input: { file_path: 'C:\\Dev\\app\\shell.css', old_string: 'a', new_string: 'b' } })).toEqual([{ path: 'C:\\Dev\\app\\shell.css' }]);
        expect(filesTouched(CLAUDE_CODE_PLUGIN_ID, { name: 'MultiEdit', input: { file_path: '/work/a.ts', edits: [] } })).toEqual([{ path: '/work/a.ts' }]);
        expect(filesTouched(CLAUDE_CODE_PLUGIN_ID, { name: 'Write', input: { file_path: '/work/new.ts', content: 'x' } })).toEqual([{ path: '/work/new.ts' }]);
        expect(filesTouched(CLAUDE_CODE_PLUGIN_ID, { name: 'NotebookEdit', input: { notebook_path: '/work/n.ipynb', new_source: '' } })).toEqual([{ path: '/work/n.ipynb' }]);
    });

    it('reports nothing for a tool that does not write, a streaming call without input, or a blank path', () => {
        expect(filesTouched(CLAUDE_CODE_PLUGIN_ID, { name: 'Read', input: { file_path: '/work/a.ts' } })).toEqual([]);
        expect(filesTouched(CLAUDE_CODE_PLUGIN_ID, { name: 'Bash', input: { command: 'rm a.ts' } })).toEqual([]);
        expect(filesTouched(CLAUDE_CODE_PLUGIN_ID, { name: 'Edit' })).toEqual([]);
        expect(filesTouched(CLAUDE_CODE_PLUGIN_ID, { name: 'Edit', input: { file_path: ' ' } })).toEqual([]);
        expect(filesTouched(CLAUDE_CODE_PLUGIN_ID, { name: 'toString', input: {} })).toEqual([]);
    });

    it('knows nothing about a runtime without an extractor', () => {
        expect(filesTouched('anthropic-api', { name: 'Edit', input: { file_path: '/work/a.ts' } })).toEqual([]);
        expect(filesTouched(undefined, { name: 'Edit', input: { file_path: '/work/a.ts' } })).toEqual([]);
    });

    it('takes a runtime registered at run time, and restores what was there', () => {
        const restore = registerFileTouches('codex-cli', (call) => (call.name === 'apply_patch' ? [{ path: '/work/p.ts', line: 3 }] : []));
        expect(filesTouched('codex-cli', { name: 'apply_patch', input: {} })).toEqual([{ path: '/work/p.ts', line: 3 }]);
        restore();
        expect(filesTouched('codex-cli', { name: 'apply_patch', input: {} })).toEqual([]);

        const override = registerFileTouches(CLAUDE_CODE_PLUGIN_ID, () => [{ path: '/other' }]);
        expect(filesTouched(CLAUDE_CODE_PLUGIN_ID, { name: 'Read' })).toEqual([{ path: '/other' }]);
        override();
        expect(filesTouched(CLAUDE_CODE_PLUGIN_ID, { name: 'Edit', input: { file_path: '/work/a.ts' } })).toEqual([{ path: '/work/a.ts' }]);
    });
});
