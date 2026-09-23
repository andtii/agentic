import { isBinaryText, parseSessionFileUri, sessionFileUri, workspaceCapabilities } from '../src/index';

describe('workspaceCapabilities (#559)', () => {
    it('shows neither view without a folder or without the files feature', () => {
        expect(workspaceCapabilities({ folder: false, features: ['files'] })).toEqual({ files: false });
        expect(workspaceCapabilities({ folder: true })).toEqual({ files: false });
        expect(workspaceCapabilities({ folder: true, features: ['update', 'log'] })).toEqual({ files: false });
    });

    it('shows Files for a folder, and Changes too when it is under version control', () => {
        expect(workspaceCapabilities({ folder: true, features: ['files'] })).toEqual({ files: true });
        expect(workspaceCapabilities({ folder: true, features: ['files'], vcs: { kind: 'worktree', branch: 'x' } })).toEqual({ files: true, vcs: 'git' });
        expect(workspaceCapabilities({ folder: true, features: ['files'], vcs: { vcs: 'hg' } })).toEqual({ files: true, vcs: 'hg' });
    });
});

describe('sessionFileUri (#559)', () => {
    it('round-trips a path and a line, encoding each segment', () => {
        const uri = sessionFileUri('ses_1', 'packages/ui/src/shell #1.css', 61);
        expect(uri).toBe('agentic-session://ses_1/packages/ui/src/shell%20%231.css#L61');
        expect(parseSessionFileUri(uri)).toEqual({ sessionId: 'ses_1', path: 'packages/ui/src/shell #1.css', line: 61 });
        expect(parseSessionFileUri(sessionFileUri('ses_1', '/a//b/'))).toEqual({ sessionId: 'ses_1', path: 'a/b' });
    });

    it('reads any other URI as null', () => {
        expect(parseSessionFileUri('file:///a/b')).toBeNull();
        expect(parseSessionFileUri('agentic-session://ses_1')).toBeNull();
        expect(parseSessionFileUri('agentic-session://ses_1/%E0%A4%A')).toBeNull();
    });
});

describe('isBinaryText (#559)', () => {
    it('treats NUL and the C0 controls JSON escapes six-fold as binary', () => {
        expect(isBinaryText('plain text\n')).toBe(false);
        expect(isBinaryText('tabs\tcr\r\nff\fbs\b')).toBe(false);
        expect(isBinaryText('\u0000')).toBe(true);
        expect(isBinaryText('esc \u001b[0m')).toBe(true);
        expect(isBinaryText('vt \u000b')).toBe(true);
        expect(isBinaryText('del \u007f and ünïcode')).toBe(false);
    });
});
