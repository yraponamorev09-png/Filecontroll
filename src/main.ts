/**
 * Vault DMS - Enterprise Local Document Management System
 *
 * Architecture Overview:
 *
 * STACK: TypeScript + Supabase (PostgreSQL)
 * - TypeScript for type safety and rapid development
 * - Supabase/PostgreSQL for ACID-compliant metadata storage
 * - Content-Addressable Storage (CAS) for file data on local disk
 *
 * STORAGE STRATEGY: Content-Addressable Storage (CAS) / Blob Store
 * - Files are split into 4MB blocks
 * - Each block is stored by its SHA3-256 hash: <vault>/blocks/<hash_prefix>/<hash>
 * - Deduplication: identical blocks across files/versions share the same physical storage
 * - ref_count tracks how many file_version_blocks reference each data_block
 * - Garbage collection removes blocks with ref_count = 0
 *
 * SECURITY MODEL: Encryption at Rest with Per-Version Keys
 * - Each file version gets a unique data encryption key (DEK)
 * - DEKs are encrypted with a master key derived from the user's password (PBKDF2)
 * - Master key is never stored on disk - derived at runtime from password
 * - Even if the disk is stolen, data is unreadable without the master key
 * - Data blocks are encrypted before writing to disk
 * - Key hierarchy: User Password -> Master Key (scrypt) -> Per-Version DEK (random) -> AES-256-GCM
 *
 * VERSIONING: Full history with efficient storage
 * - Every save creates a new file_version record
 * - Block-level dedup means only changed blocks consume new space
 * - Time-machine style: restore any version instantly
 * - Old versions can be compressed (zstd/lz4) by the archival system
 *
 * ACCESS CONTROL: RBAC + ACL with inheritance
 * - Roles: owner, editor, viewer, auditor
 * - ACLs: per-node permissions (read, write, admin) with inheritance
 * - Permission resolution: owner > direct ACE > inherited ACE > denied
 *
 * CONCURRENCY: Optimistic locking
 * - Version numbers provide natural conflict detection
 * - Unique constraint on (node_id, version_number) prevents lost updates
 * - Advisory locks for long-running operations
 * - Conflict resolution strategies: keep_both, last_writer_wins, manual
 */

import { saveFileVersion, checkPermission, createShareLink, archiveOldVersions } from './core/index.js';

async function demo() {
  console.log('Vault DMS initialized');
  console.log('Available operations:');
  console.log('  - saveFileVersion(nodeId, fileData, userId, vaultDir)');
  console.log('  - checkPermission(userId, nodeId, action)');
  console.log('  - createShareLink(userId, nodeId, options)');
  console.log('  - archiveOldVersions(policy)');
  console.log('');
  console.log('See src/core/ for full implementation:');
  console.log('  versioning.ts - Version control with CAS dedup');
  console.log('  access.ts    - RBAC + ACL with inheritance');
  console.log('  sharing.ts   - Secure share links with password + TTL');
  console.log('  archival.ts  - Lifecycle management and compression');
  console.log('  conflict.ts  - Concurrency control and conflict resolution');
}

demo().catch(console.error);
