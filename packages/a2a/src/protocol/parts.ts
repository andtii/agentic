/** Prompt parts ↔ A2A parts: text, image, file and resource, each way. */

import type { PromptPart } from '@sigx/ai-agent';
import type { A2aPart } from './types.js';

export function toA2aParts(parts: readonly PromptPart[]): A2aPart[] {
    const out: A2aPart[] = [];
    for (const p of parts) {
        switch (p.type) {
            case 'text':
                out.push({ text: p.text });
                break;
            case 'image':
            case 'file': {
                const named = p.type === 'file' && p.filename ? { filename: p.filename } : {};
                if (p.data !== undefined) out.push({ raw: p.data, mediaType: p.mediaType, ...named });
                else if (p.url !== undefined) out.push({ url: p.url, mediaType: p.mediaType, ...named });
                break;
            }
            case 'resource': {
                const metadata = { uri: p.uri, ...(p.name ? { name: p.name } : {}) };
                const typed = p.mediaType ? { mediaType: p.mediaType } : {};
                if (p.text !== undefined) out.push({ text: p.text, ...typed, metadata });
                else out.push({ url: p.uri, ...typed, metadata });
                break;
            }
        }
    }
    return out;
}

/** A single A2A part as a prompt part; `undefined` for a data part (those are not prompt content). */
export function toPromptPart(part: A2aPart): PromptPart | undefined {
    // A resource travels as a text or url part with `metadata.uri` (see `toA2aParts`).
    const uri = part.metadata?.uri;
    if (typeof uri === 'string' && (part.text !== undefined || part.url !== undefined)) {
        const name = part.metadata?.name;
        return {
            type: 'resource',
            uri,
            ...(typeof name === 'string' ? { name } : {}),
            ...(part.mediaType ? { mediaType: part.mediaType } : {}),
            ...(part.text !== undefined ? { text: part.text } : {})
        };
    }
    if (part.text !== undefined) return { type: 'text', text: part.text };
    const mediaType = part.mediaType ?? 'application/octet-stream';
    const named = part.filename ? { filename: part.filename } : {};
    if (part.raw !== undefined) return mediaType.startsWith('image/') ? { type: 'image', mediaType, data: part.raw } : { type: 'file', mediaType, data: part.raw, ...named };
    if (part.url !== undefined) return mediaType.startsWith('image/') ? { type: 'image', mediaType, url: part.url } : { type: 'file', mediaType, url: part.url, ...named };
    return undefined;
}

export function toPromptParts(parts: readonly A2aPart[]): PromptPart[] {
    const out: PromptPart[] = [];
    for (const p of parts) {
        const mapped = toPromptPart(p);
        if (mapped) out.push(mapped);
    }
    return out;
}

/** The text of a part list — its text parts joined. */
export function partsText(parts: readonly A2aPart[]): string {
    let text = '';
    for (const p of parts) if (p.text !== undefined) text += p.text;
    return text;
}

/** The media types a `promptParts` level admits, for a card's `defaultInputModes`. */
export function inputModesFor(level: 'text' | 'text+image' | 'text+image+file'): string[] {
    if (level === 'text') return ['text/plain'];
    if (level === 'text+image') return ['text/plain', 'image/*'];
    return ['text/plain', 'image/*', '*/*'];
}

/** The `promptParts` level a card's `defaultInputModes` admits. */
export function promptPartsFor(modes: readonly string[] | undefined): 'text' | 'text+image' | 'text+image+file' {
    const list = modes ?? [];
    const any = list.some((m) => m === '*/*' || m === 'application/*' || m === 'application/octet-stream' || m === 'application/pdf');
    const image = list.some((m) => m.startsWith('image/'));
    if (any) return 'text+image+file';
    if (image) return 'text+image';
    return 'text';
}
