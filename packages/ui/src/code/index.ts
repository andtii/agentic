/**
 * Session files and changes (#563): the pluggable code surface (a renderer
 * seam with Monaco and plain renderers), the line diff behind the plain one,
 * and the parts the Changes and Files views are made of.
 */
export { codeAnatomies, agCodeAnatomy, agStatusTileAnatomy, agDiffCountsAnatomy, agChangesAnatomy, agFileTreeAnatomy, agFindAnatomy, agKbdAnatomy, agSessionBarAnatomy, agFileHeaderAnatomy, agLineComposerAnatomy } from './anatomy.js';
export { codeRecipes } from './recipes.js';
export { codeScopes } from './vocabulary.js';
export { codeCss } from './css.js';
export type { CodeRenderer, CodeViewerProps, CodeDiffProps, DiffMode, LineMark, LineMarkTone } from './types.js';
export { diffLines, splitLines, unifiedRows, splitRows, changedLines, hunkAt, MAX_EDITS, DIFF_CONTEXT } from './line-diff.js';
export type { DiffOp, DiffRow, SplitRow, DiffSide, LineRef } from './line-diff.js';
export { useCodeRenderer, CodeRendererProvider, CodeViewer, CodeDiff } from './renderer.js';
export type { CodeRendererProviderProps } from './renderer.js';
export { plainCodeRenderer, PlainViewer, PlainDiff } from './plain.js';
export { monacoCodeRenderer, MonacoViewer, MonacoDiff, loadMonacoEngine } from './monaco/index.js';
export { monacoTheme, withAlpha, MONACO_THEME, MONACO_FONT } from './monaco/theme.js';
export type { MonacoPalette } from './monaco/theme.js';
export { StatusTile, DiffCounts, Kbd, CHANGE_STATUS, changeDotTone, splitPath, fileSizeText } from './parts.js';
export type { StatusTileProps, DiffCountsProps, KbdProps } from './parts.js';
export { ChangesPanel, ChangeList, CommitList, commitTime } from './changes.js';
export type { ChangesPanelProps, ChangeListProps, CommitListProps, CommitAuthor } from './changes.js';
export { SessionBar } from './session-bar.js';
export type { SessionBarProps, SessionTab } from './session-bar.js';
export { FileHeader } from './file-header.js';
export type { FileHeaderProps } from './file-header.js';
export { LineComposer } from './line-composer.js';
export type { LineComposerProps } from './line-composer.js';
export { GoToFile, findPaths, matchScore, FIND_MAX_RESULTS } from './find.js';
export type { GoToFileProps } from './find.js';
export { FileTree, FileTreeLegend, ancestorsOf } from '../_zero-gaps/index.js';
export type { FileTreeProps, FileTreeLegendProps, FileTreeLoad } from '../_zero-gaps/index.js';

// `componentExportName(scope)` for every scope here — the fragment contract.
export { CodeViewer as AgCode } from './renderer.js';
export { StatusTile as AgStatusTile, DiffCounts as AgDiffCounts, Kbd as AgKbd } from './parts.js';
export { ChangesPanel as AgChanges } from './changes.js';
export { FileTree as AgFileTree } from '../_zero-gaps/index.js';
export { GoToFile as AgFind } from './find.js';
export { SessionBar as AgSessionBar } from './session-bar.js';
export { FileHeader as AgFileHeader } from './file-header.js';
export { LineComposer as AgLineComposer } from './line-composer.js';
