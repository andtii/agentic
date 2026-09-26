/** The composer: addressing row, autosizing `Textarea`, `@mention` popup (zero `Combobox` trigger mode), attachments (picker, paste, drop), attach / Cancel / Send — scope `ai-composer`. */
export { aiComposerAnatomy } from './anatomy.js';
export { Composer, Composer as AiComposer, NOBODY_HINT, ATTACHMENT_STATE, appendToDraft } from './Composer.js';
export type { ComposerProps, ComposerInsert, Attachment, AttachmentStatus, Recipient } from './Composer.js';
export { filterMentions, MAX_MENTIONS } from './mentions.js';
export type { Mention } from './mentions.js';
export { SUGGEST_TRIGGER, suggestionsFor } from './refs.js';
export type { ComposerSuggestion, RefSource, RefSuggestion } from './refs.js';
export { prepareImage } from './prepareImage.js';
export type { PrepareImageOptions } from './prepareImage.js';
