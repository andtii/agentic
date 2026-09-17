/** The composer: autogrow `Textarea`, `@mention` popup, attachments stub, Send / Cancel — scope `ai-composer`. */
export { aiComposerAnatomy } from './anatomy.js';
export { Composer, Composer as AiComposer } from './Composer.js';
export type { ComposerProps, Attachment } from './Composer.js';
export { mentionAt, filterMentions, insertMention, rowsFor, MAX_MENTIONS } from './mentions.js';
export type { Mention, MentionQuery } from './mentions.js';
