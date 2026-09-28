import { ANTHROPIC_API_PLUGIN_ID, CLAUDE_CODE_PLUGIN_ID, CODEX_CLI_PLUGIN_ID, COPILOT_CLI_PLUGIN_ID, normaliseStep, registerStepNormaliser, stepOutputText, STEP_TARGET_MAX } from '../src/index';

describe('normaliseStep: claude-code (#1055)', () => {
    it('Bash: the command is the target; a failure reads its exit code out of the error, a success exited 0', () => {
        expect(normaliseStep(CLAUDE_CODE_PLUGIN_ID, { name: 'Bash', category: 'execute', input: { command: 'pnpm test\n  --run', description: 'Run tests' }, error: 'Exit code 1\nFAIL src/a.test.ts\nError: expected 1' })).toEqual({ kind: 'command', target: 'pnpm test --run', exitCode: 1 });
        expect(normaliseStep(CLAUDE_CODE_PLUGIN_ID, { name: 'Bash', input: { command: 'ls' }, output: 'a\nb\n' })).toEqual({ kind: 'command', target: 'ls', exitCode: 0 });
        // A completed Bash exited 0, whatever its output prints.
        expect(normaliseStep(CLAUDE_CODE_PLUGIN_ID, { name: 'Bash', input: { command: 'node a.js' }, output: 'child failed: exit code 3' }).exitCode).toBe(0);
        // Still running: no exit code yet.
        expect(normaliseStep(CLAUDE_CODE_PLUGIN_ID, { name: 'Bash', input: { command: 'sleep 9' } })).toEqual({ kind: 'command', target: 'sleep 9' });
    });

    it('Read, Write and Edit: the path is the target; an edit says +a −b from its coding.diff, else from its input', () => {
        expect(normaliseStep(CLAUDE_CODE_PLUGIN_ID, { name: 'Read', category: 'read', input: { file_path: '/work/src/a.ts' }, output: '1\tx' })).toEqual({ kind: 'read', target: '/work/src/a.ts' });
        expect(normaliseStep(CLAUDE_CODE_PLUGIN_ID, { name: 'Edit', input: { file_path: '/work/a.ts', old_string: 'x', new_string: 'y' }, output: 'ok', diffs: [{ oldText: 'a\nb\nc', newText: 'a\nB\nC\nD\nc' }] })).toEqual({ kind: 'edit', target: '/work/a.ts', result: '+3 −1' });
        expect(normaliseStep(CLAUDE_CODE_PLUGIN_ID, { name: 'Edit', input: { file_path: '/work/a.ts', old_string: 'one\ntwo', new_string: 'one\n2\n3' }, output: 'ok' })).toEqual({ kind: 'edit', target: '/work/a.ts', result: '+2 −1' });
        expect(normaliseStep(CLAUDE_CODE_PLUGIN_ID, { name: 'MultiEdit', input: { file_path: '/work/a.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd\ne' }] }, output: 'ok' }).result).toBe('+3 −2');
        expect(normaliseStep(CLAUDE_CODE_PLUGIN_ID, { name: 'Write', input: { file_path: '/work/new.ts', content: 'a\nb\n' }, output: 'ok' })).toEqual({ kind: 'edit', target: '/work/new.ts', result: '+2 −0' });
        // A failed edit changed nothing.
        expect(normaliseStep(CLAUDE_CODE_PLUGIN_ID, { name: 'Edit', input: { file_path: '/work/a.ts', old_string: 'x', new_string: 'y' }, error: 'String to replace not found' })).toEqual({ kind: 'edit', target: '/work/a.ts' });
    });

    it('Grep and Glob: the pattern is the target, the result N matches', () => {
        expect(normaliseStep(CLAUDE_CODE_PLUGIN_ID, { name: 'Grep', input: { pattern: 'TODO', path: 'src' }, output: 'Found 3 files\nsrc/a.ts\nsrc/b.ts\nsrc/c.ts' })).toEqual({ kind: 'search', target: 'TODO', result: '3 matches' });
        expect(normaliseStep(CLAUDE_CODE_PLUGIN_ID, { name: 'Glob', input: { pattern: '**/*.md' }, output: 'README.md\n' })).toEqual({ kind: 'search', target: '**/*.md', result: '1 match' });
        expect(normaliseStep(CLAUDE_CODE_PLUGIN_ID, { name: 'Glob', input: { pattern: '*.x' }, output: 'No files found' }).result).toBe('0 matches');
    });

    it('another tool names what its input names, with the kind from its category', () => {
        expect(normaliseStep(CLAUDE_CODE_PLUGIN_ID, { name: 'WebFetch', category: 'fetch', input: { url: 'https://example.com', prompt: 'x' } })).toEqual({ kind: 'search', target: 'https://example.com' });
        expect(normaliseStep(CLAUDE_CODE_PLUGIN_ID, { name: 'TodoWrite', input: { todos: [] } })).toEqual({ kind: 'other', target: '' });
    });

    it('clips a long target to one line', () => {
        const step = normaliseStep(CLAUDE_CODE_PLUGIN_ID, { name: 'Bash', input: { command: `echo ${'x'.repeat(500)}` } });
        expect(step.target.length).toBe(STEP_TARGET_MAX);
        expect(step.target.endsWith('…')).toBe(true);
    });
});

describe('normaliseStep: codex-cli (#1055)', () => {
    it('shell takes its exit code from {exitCode, output}', () => {
        expect(normaliseStep(CODEX_CLI_PLUGIN_ID, { name: 'shell', category: 'execute', input: { command: 'cargo test', cwd: '/w' }, output: { exitCode: 101, output: 'error[E0425]: cannot find value' }, error: 'exited with 101' })).toEqual({ kind: 'command', target: 'cargo test', exitCode: 101 });
        expect(normaliseStep(CODEX_CLI_PLUGIN_ID, { name: 'shell', category: 'execute', input: { command: 'ls' }, output: { exitCode: 0, output: 'a' } })).toEqual({ kind: 'command', target: 'ls', exitCode: 0 });
    });

    it('apply_patch names its files; web_search its query', () => {
        expect(normaliseStep(CODEX_CLI_PLUGIN_ID, { name: 'apply_patch', category: 'edit', input: { changes: [{ path: 'a.rs', kind: 'update' }, { path: 'b.rs', kind: 'add' }] } })).toEqual({ kind: 'edit', target: 'a.rs, b.rs', result: '2 files' });
        expect(normaliseStep(CODEX_CLI_PLUGIN_ID, { name: 'web_search', category: 'fetch', input: { query: 'rust lifetimes' } })).toEqual({ kind: 'search', target: 'rust lifetimes' });
    });
});

describe('normaliseStep: copilot-cli and the fallback (#1055)', () => {
    it('copilot-cli: the kind from categoryOf over the name', () => {
        expect(normaliseStep(COPILOT_CLI_PLUGIN_ID, { name: 'bash', input: { command: 'npm test' } })).toEqual({ kind: 'command', target: 'npm test' });
        expect(normaliseStep(COPILOT_CLI_PLUGIN_ID, { name: 'view', input: { path: 'src/a.ts' } }).target).toBe('src/a.ts');
    });

    it('anthropic-api (no normaliser): the kind from stepKindOf, no target — the Session fills it', () => {
        expect(normaliseStep(ANTHROPIC_API_PLUGIN_ID, { name: 'memory_search', category: 'search', input: { query: 'tea' } })).toEqual({ kind: 'search', target: '' });
        expect(normaliseStep(undefined, { name: 'whatever' })).toEqual({ kind: 'other', target: '' });
    });

    it('delegate, plan_assign and plan_handoff are delegate steps on any runtime, with who and the task or item', () => {
        expect(normaliseStep(ANTHROPIC_API_PLUGIN_ID, { name: 'delegate', input: { assignee: 'agent_bob', objective: 'fix it' }, output: { taskId: 'task_9', status: 'completed' } })).toEqual({ kind: 'delegate', target: 'agent_bob', delegate: { to: 'agent_bob', taskId: 'task_9' } });
        // Through Claude Code the platform tools come as MCP names, their result as text.
        expect(normaliseStep(CLAUDE_CODE_PLUGIN_ID, { name: 'mcp__agentic__delegate', input: { assignee: 'agent_bob', objective: 'x' }, output: '{"taskId":"task_3","status":"running"}' }).delegate).toEqual({ to: 'agent_bob', taskId: 'task_3' });
        expect(normaliseStep(CLAUDE_CODE_PLUGIN_ID, { name: 'mcp__agentic__plan_assign', input: { item: 11, to: '@lint' } })).toEqual({ kind: 'delegate', target: 'lint', delegate: { to: 'lint', item: '11' } });
        expect(normaliseStep(CODEX_CLI_PLUGIN_ID, { name: 'plan_handoff', input: { item: 4, to: 'qa', note: 'done' } }).delegate).toEqual({ to: 'qa', item: '4' });
        // A handoff back to whoever assigned it names no one.
        expect(normaliseStep(CODEX_CLI_PLUGIN_ID, { name: 'plan_handoff', input: { item: 4, note: 'done' } })).toEqual({ kind: 'delegate', target: '' });
    });

    it('registerStepNormaliser adds a runtime and restores what was there', () => {
        const restore = registerStepNormaliser('test-rt', (call) => ({ kind: 'read', target: `T:${call.name}` }));
        expect(normaliseStep('test-rt', { name: 'x' })).toEqual({ kind: 'read', target: 'T:x' });
        restore();
        expect(normaliseStep('test-rt', { name: 'x' })).toEqual({ kind: 'other', target: '' });
    });
});

describe('stepOutputText (#1055)', () => {
    it('reads a string, a {output} and content blocks, else JSON', () => {
        expect(stepOutputText('x')).toBe('x');
        expect(stepOutputText({ exitCode: 1, output: 'boom' })).toBe('boom');
        expect(stepOutputText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb');
        expect(stepOutputText({ a: 1 })).toBe('{"a":1}');
        expect(stepOutputText(undefined)).toBe('');
    });
});
