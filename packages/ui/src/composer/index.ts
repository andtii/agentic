/** The composer: addressing row, autogrow `Textarea`, `@mention` popup, attachments (picker, paste, drop), attach / Cancel / Send — scope `ai-composer`. */
export { aiComposerAnatomy } from './anatomy.js';
export { Composer, Composer as AiComposer, NOBODY_HINT, ATTACHMENT_STATE } from './Composer.js';
export type { ComposerProps, Attachment, AttachmentStatus, Recipient } from './Composer.js';
export { mentionAt, filterMentions, insertMention, rowsFor, MAX_MENTIONS } from './mentions.js';
export type { Mention, MentionQuery } from './mentions.js';
export { prepareImage } from './prepareImage.js';
export type { PrepareImageOptions } from './prepareImage.js';
