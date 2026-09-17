/**
 * A minimal `text/event-stream` reader over a Web `ReadableStream` — the
 * Streamable HTTP transport answers a POST with either one JSON document or
 * an SSE stream of JSON-RPC messages, and this yields the `data` of each
 * event as it arrives. Edge-safe: TextDecoder and async iteration only.
 */

export interface SseEvent {
    readonly event?: string;
    readonly data: string;
    readonly id?: string;
}

/** Yields events until the stream ends or `signal` aborts (the reader is cancelled; the generator then simply ends). */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const onAbort = () => void reader.cancel().catch(() => {});
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    let buffer = '';
    let event: string | undefined;
    let id: string | undefined;
    let data: string[] = [];
    const flush = (): SseEvent | undefined => {
        if (data.length === 0) {
            event = undefined;
            return undefined;
        }
        const out: SseEvent = { data: data.join('\n'), ...(event !== undefined ? { event } : {}), ...(id !== undefined ? { id } : {}) };
        event = undefined;
        data = [];
        return out;
    };
    try {
        for (;;) {
            const { value, done } = await reader.read();
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
            // At EOF a last line without its newline still counts.
            if (done && buffer !== '' && !/[\r\n]$/.test(buffer)) buffer += '\n';
            let nl: number;
            while ((nl = buffer.search(/\r\n|\n|\r/)) !== -1) {
                const line = buffer.slice(0, nl);
                buffer = buffer.slice(nl + (buffer[nl] === '\r' && buffer[nl + 1] === '\n' ? 2 : 1));
                if (line === '') {
                    const e = flush();
                    if (e) yield e;
                    continue;
                }
                if (line.startsWith(':')) continue;
                const colon = line.indexOf(':');
                const field = colon === -1 ? line : line.slice(0, colon);
                let fieldValue = colon === -1 ? '' : line.slice(colon + 1);
                if (fieldValue.startsWith(' ')) fieldValue = fieldValue.slice(1);
                if (field === 'data') data.push(fieldValue);
                else if (field === 'event') event = fieldValue;
                else if (field === 'id') id = fieldValue;
            }
            if (done) {
                const e = flush();
                if (e) yield e;
                return;
            }
        }
    } finally {
        signal?.removeEventListener('abort', onAbort);
        await reader.cancel().catch(() => {});
    }
}
