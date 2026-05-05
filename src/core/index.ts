export { saveFileVersion, restoreFileVersion, listFileVersions, garbageCollectBlocks } from './versioning.ts';
export { checkPermission, assertPermission, grantPermission, revokePermission, getEffectivePermissions } from './access.ts';
export { createShareLink, validateShareLink, revokeShareLink, listShareLinks } from './sharing.ts';
export { archiveOldVersions, unarchiveFile, softDeleteNode, purgeDeletedNodes } from './archival.ts';
export { detectConflict, resolveConflict, acquireFileLock, releaseFileLock } from './conflict.ts';
