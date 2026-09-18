/**
 * A minimal zip writer and reader on `node:zlib` — enough for the daemon
 * installer (`package.mjs`) and the test that unpacks it, with no dependency
 * and the same behaviour on Windows and Linux.
 *
 * Supported: methods 0 (stored) and 8 (deflate), UTF-8 names, unix mode in
 * the external attributes. Not supported: ZIP64 (an entry ≥ 4 GiB or more
 * than 65 535 entries throws), encryption, data descriptors on write.
 */

import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const EOCD = 0x06054b50;
const UTF8_FLAG = 0x0800;
const MAX32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;
/** Above this size (the Claude Code executable) deflate runs at its fastest level: half the size in a few seconds. */
const FAST_ABOVE = 64 * 1024 * 1024;

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

/** @param {Uint8Array} bytes */
export function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

/** @param {Date} date */
function dosDateTime(date) {
    const year = Math.max(1980, date.getFullYear());
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, date: day };
}

/**
 * @typedef {{ name: string; data: Uint8Array; mode?: number; store?: boolean }} ZipEntry
 *   `name` uses `/` separators and no leading slash; `mode` is a unix file mode (default 0o644).
 */

/**
 * Write `entries` to a zip file at `file`, streaming one entry at a time so
 * a large binary is never held twice.
 *
 * @param {string} file
 * @param {Iterable<ZipEntry>} entries
 * @param {{ mtime?: Date }} [options]
 * @returns {{ entries: number; bytes: number }}
 */
export function writeZip(file, entries, options = {}) {
    const { time, date } = dosDateTime(options.mtime ?? new Date());
    mkdirSync(dirname(file), { recursive: true });
    const fd = openSync(file, 'w');
    /** @type {Buffer[]} */
    const central = [];
    let offset = 0;
    let count = 0;
    try {
        for (const entry of entries) {
            if (entry.name.startsWith('/') || entry.name.includes('\\')) throw new Error(`zip: entry name must be a relative posix path: ${entry.name}`);
            if (++count > MAX_ENTRIES) throw new Error('zip: more than 65535 entries needs ZIP64, which this writer does not produce');
            const name = Buffer.from(entry.name, 'utf8');
            const raw = Buffer.from(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength);
            const store = entry.store ?? false;
            const deflated = store ? raw : deflateRawSync(raw, raw.length > FAST_ABOVE ? { level: 1 } : {});
            const data = !store && deflated.length < raw.length ? deflated : raw;
            const method = data === raw ? 0 : 8;
            if (raw.length > MAX32 || data.length > MAX32) throw new Error(`zip: ${entry.name} is ≥ 4 GiB and needs ZIP64, which this writer does not produce`);
            const crc = crc32(raw);
            const mode = entry.mode ?? 0o644;

            const local = Buffer.alloc(30 + name.length);
            local.writeUInt32LE(LOCAL, 0);
            local.writeUInt16LE(20, 4);
            local.writeUInt16LE(UTF8_FLAG, 6);
            local.writeUInt16LE(method, 8);
            local.writeUInt16LE(time, 10);
            local.writeUInt16LE(date, 12);
            local.writeUInt32LE(crc, 14);
            local.writeUInt32LE(data.length, 18);
            local.writeUInt32LE(raw.length, 22);
            local.writeUInt16LE(name.length, 26);
            local.writeUInt16LE(0, 28);
            name.copy(local, 30);
            writeSync(fd, local);
            writeSync(fd, data);

            const cd = Buffer.alloc(46 + name.length);
            cd.writeUInt32LE(CENTRAL, 0);
            cd.writeUInt16LE(0x0314, 4); // made by: unix, spec 2.0 — carries the mode in the external attributes
            cd.writeUInt16LE(20, 6);
            cd.writeUInt16LE(UTF8_FLAG, 8);
            cd.writeUInt16LE(method, 10);
            cd.writeUInt16LE(time, 12);
            cd.writeUInt16LE(date, 14);
            cd.writeUInt32LE(crc, 16);
            cd.writeUInt32LE(data.length, 20);
            cd.writeUInt32LE(raw.length, 24);
            cd.writeUInt16LE(name.length, 28);
            cd.writeUInt16LE(0, 30);
            cd.writeUInt16LE(0, 32);
            cd.writeUInt16LE(0, 34);
            cd.writeUInt16LE(0, 36);
            cd.writeUInt32LE(((0o100000 | (mode & 0o7777)) << 16) >>> 0, 38);
            cd.writeUInt32LE(offset, 42);
            name.copy(cd, 46);
            central.push(cd);
            offset += local.length + data.length;
            if (offset > MAX32) throw new Error('zip: archive ≥ 4 GiB needs ZIP64, which this writer does not produce');
        }
        const cdStart = offset;
        let cdSize = 0;
        for (const cd of central) {
            writeSync(fd, cd);
            cdSize += cd.length;
        }
        const eocd = Buffer.alloc(22);
        eocd.writeUInt32LE(EOCD, 0);
        eocd.writeUInt16LE(0, 4);
        eocd.writeUInt16LE(0, 6);
        eocd.writeUInt16LE(central.length, 8);
        eocd.writeUInt16LE(central.length, 10);
        eocd.writeUInt32LE(cdSize, 12);
        eocd.writeUInt32LE(cdStart, 16);
        eocd.writeUInt16LE(0, 20);
        writeSync(fd, eocd);
        return { entries: central.length, bytes: cdStart + cdSize + eocd.length };
    } finally {
        closeSync(fd);
    }
}

/**
 * Read every entry of a zip buffer. Directory entries (names ending in `/`)
 * come back with empty data. The CRC of every entry is verified.
 *
 * @param {Uint8Array} bytes
 * @returns {ZipEntry[]}
 */
export function readZip(bytes) {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
        if (buf.readUInt32LE(i) === EOCD) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new Error('zip: no end-of-central-directory record');
    const count = buf.readUInt16LE(eocd + 10);
    let pos = buf.readUInt32LE(eocd + 16);
    /** @type {ZipEntry[]} */
    const entries = [];
    for (let n = 0; n < count; n++) {
        if (buf.readUInt32LE(pos) !== CENTRAL) throw new Error(`zip: bad central directory entry at ${pos}`);
        const method = buf.readUInt16LE(pos + 10);
        const crc = buf.readUInt32LE(pos + 16);
        const compressed = buf.readUInt32LE(pos + 20);
        const size = buf.readUInt32LE(pos + 24);
        const nameLength = buf.readUInt16LE(pos + 28);
        const extraLength = buf.readUInt16LE(pos + 30);
        const commentLength = buf.readUInt16LE(pos + 32);
        const mode = (buf.readUInt32LE(pos + 38) >>> 16) & 0o7777;
        const local = buf.readUInt32LE(pos + 42);
        const name = buf.toString('utf8', pos + 46, pos + 46 + nameLength);
        pos += 46 + nameLength + extraLength + commentLength;

        if (buf.readUInt32LE(local) !== LOCAL) throw new Error(`zip: bad local header for ${name}`);
        const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const data = buf.subarray(dataStart, dataStart + compressed);
        let raw;
        if (method === 0) raw = data;
        else if (method === 8) raw = inflateRawSync(data);
        else throw new Error(`zip: ${name} uses unsupported method ${method}`);
        if (raw.length !== size) throw new Error(`zip: ${name} size mismatch`);
        if (crc32(raw) !== crc) throw new Error(`zip: ${name} CRC mismatch`);
        entries.push({ name, data: raw, mode });
    }
    return entries;
}

/**
 * Unpack `file` under `dir`. Entry names are resolved against `dir` and an
 * entry that would land outside it (`../`, absolute) is refused.
 *
 * @param {string} file
 * @param {string} dir
 * @returns {string[]} the files written, relative posix paths
 */
export function extractZip(file, dir) {
    const root = resolve(dir);
    const written = [];
    for (const entry of readZip(readFileSync(file))) {
        const target = resolve(root, entry.name);
        if (target !== root && !target.startsWith(root + sep)) throw new Error(`zip: entry escapes the target directory: ${entry.name}`);
        if (entry.name.endsWith('/')) {
            mkdirSync(target, { recursive: true });
            continue;
        }
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, entry.data, { mode: entry.mode || 0o644 });
        written.push(entry.name);
    }
    return written;
}
