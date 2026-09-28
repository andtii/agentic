/**
 * The Node host's durable `ActorStorage`: one SQLite file on `node:sqlite`
 * (Node >= 22.13), from `@sigx/actors-sqlite`.
 *
 * Why not `@sigx/actors/node`'s `fileStorage`: it rewrites a whole JSON file
 * per save and has no `appendText`, so every Session event (`ctx.append`)
 * would rewrite the transcript. `sqliteStorage` keeps a record as a state row
 * plus a log table (`{table}_log(type, key, seq, entry)`):
 *
 * - `save` / `saveText` / `clear` CAS on the etag (the row version) and
 *   truncate the record's log in the same `BEGIN IMMEDIATE` transaction;
 * - `appendText` bumps the version under the same CAS and inserts ONE log
 *   row — O(entry), never a rewrite of the state;
 * - `load` returns the state and the log entries in order;
 * - a `path` database runs in WAL mode with a 5 s `busy_timeout`.
 *
 * Reminders need nothing extra: `shardedReminders()` keeps its shard tables
 * as ordinary records through the host's storage (load + CAS save), so it
 * sits on this storage as-is.
 *
 * The contract is pinned in this repo by the shared `storageConformance`
 * suite (see `__tests__/storage-conformance.test.ts`).
 */
export { sqliteStorage, type SqliteStorage, type SqliteStorageOptions } from '@sigx/actors-sqlite';
