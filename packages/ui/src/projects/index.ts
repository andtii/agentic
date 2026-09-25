/**
 * Projects (#722): the parts the project pages share. Stubs with their final props (#725) — #726 fills
 * `ProjectSquare`, `StageTrack`, `ItemGlyph`, `SlotMarks` and `ChecksBar`, #745 `PullCard`, each in its own file,
 * so this barrel does not change.
 */
export { ProjectSquare } from './ProjectSquare.js';
export type { ProjectSquareProps } from './ProjectSquare.js';
export { StageTrack } from './StageTrack.js';
export type { StageTrackProps } from './StageTrack.js';
export { ItemGlyph } from './ItemGlyph.js';
export type { ItemGlyphProps, ItemGlyphState } from './ItemGlyph.js';
export { SlotMarks, PROJECT_FEATURE_SLOTS, usedSlots } from './SlotMarks.js';
export type { SlotMarksProps, ProjectFeatureSlot } from './SlotMarks.js';
export { ChecksBar } from './ChecksBar.js';
export type { ChecksBarProps } from './ChecksBar.js';
export { PullCard } from './PullCard.js';
export type { PullCardProps, PullCardSurface } from './PullCard.js';
