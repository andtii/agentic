// Types for scripts/lib/zip.mjs.
export interface ZipEntry {
    readonly name: string;
    readonly data: Uint8Array;
    readonly mode?: number;
    readonly store?: boolean;
}
export function crc32(bytes: Uint8Array): number;
export function writeZip(file: string, entries: Iterable<ZipEntry>, options?: { readonly mtime?: Date }): { entries: number; bytes: number };
export function readZip(bytes: Uint8Array): ZipEntry[];
export function extractZip(file: string, dir: string): string[];
