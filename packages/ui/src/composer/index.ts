/** The composer: addressing row, autogrow `Textarea`, `@mention` popup, attachments stub, attach / Cancel / Send — scope `ai-composer`. */
export { aiComposerAnatomy } from './anatomy.js';
export { Composer, Composer as AiComposer, NOBODY_HINT } from './Composer.js';
export type { ComposerProps, Attachment, Recipient } from './Composer.js';
export { mentionAt, filterMentions, insertMention, rowsFor, MAX_MENTIONS } from './mentions.js';
export type { Mention, MentionQuery } from './mentions.js';
