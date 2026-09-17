/** PairingDirectory — the global code → {workspace, machine} index behind the anonymous `POST /auth/pair` (architecture §9, USR-04). */
export { PairingDirectory, PAIRING_DIRECTORY_KEY, PAIRING_DIRECTORY_TYPE, normalizeDirectoryCode, type PairingDirectoryActor, type PairingDirectoryEntry, type PairingDirectoryState, type PairingTarget } from './directory.js';
