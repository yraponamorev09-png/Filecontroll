import { v4 as uuidv4 } from 'uuid';
import { getSupabaseClient } from '../utils/db.ts';
import { hashContent, splitIntoBlocks, BLOCK_SIZE } from '../utils/crypto.ts';
import type {
  Node,
  FileVersion,
  DataBlock,
  FileVersionBlock,
  SaveVersionResult,
} from '../types/index.ts';
import { NodeNotFoundError, VersionConflictError, VaultError } from '../types/index.ts';

const BLOCK_SIZE_BYTES = BLOCK_SIZE;

/**
 * Save a new version of a file with content-addressable deduplication.
 *
 * Strategy:
 * 1. Split file into fixed-size blocks (4MB).
 * 2. Hash each block (SHA3-256) and check if it already exists in data_blocks.
 * 3. For new blocks: write to disk at <vault_dir>/blocks/<hash_prefix>/<hash>, insert into data_blocks.
 * 4. For existing blocks: increment ref_count (dedup).
 * 5. Create file_version and file_version_blocks entries.
 * 6. Mark previous current version as non-current.
 *
 * Concurrency: Uses optimistic locking on version_number to detect conflicts.
 * If two processes try to save simultaneously, the second gets a VersionConflictError.
 */
export async function saveFileVersion(
  nodeId: string,
  fileData: Uint8Array,
  userId: string,
  vaultDir: string,
): Promise<SaveVersionResult> {
  const sb = getSupabaseClient();

  // 1. Verify node exists and is a file
  const { data: node, error: nodeErr } = await sb
    .from('nodes')
    .select('id, node_type, owner_id, name')
    .eq('id', nodeId)
    .maybeSingle();

  if (nodeErr) throw new VaultError(`Failed to fetch node: ${nodeErr.message}`, 'DB_ERROR');
  if (!node) throw new NodeNotFoundError(nodeId);
  if (node.node_type !== 'file') throw new VaultError('Cannot version a folder', 'INVALID_NODE_TYPE');

  // 2. Get current version number for optimistic locking
  const { data: currentVersion } = await sb
    .from('file_versions')
    .select('version_number')
    .eq('node_id', nodeId)
    .eq('is_current', true)
    .order('version_number', { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextVersion = (currentVersion?.version_number ?? 0) + 1;

  // 3. Split into blocks and hash
  const blocks = splitIntoBlocks(fileData);
  const contentHash = await hashContent(fileData);
  let newBlocksCreated = 0;

  // 4. Process each block - dedup via content hash
  const versionBlockRefs: { blockId: string; index: number; offset: number }[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const blockData = blocks[i];
    const blockHash = await hashContent(blockData);

    // Check if block already exists
    const { data: existingBlock } = await sb
      .from('data_blocks')
      .select('id, ref_count, content_hash')
      .eq('content_hash', blockHash)
      .maybeSingle();

    if (existingBlock) {
      // Dedup: increment ref count
      const { error: updateErr } = await sb
        .from('data_blocks')
        .update({ ref_count: existingBlock.ref_count + 1 })
        .eq('id', existingBlock.id);

      if (updateErr) throw new VaultError(`Failed to update ref_count: ${updateErr.message}`, 'DB_ERROR');

      versionBlockRefs.push({
        blockId: existingBlock.id,
        index: i,
        offset: i * BLOCK_SIZE_BYTES,
      });
    } else {
      // New block: write to disk and insert record
      const blockId = uuidv4();
      const hashPrefix = blockHash.substring(0, 2);
      const physicalPath = `${vaultDir}/blocks/${hashPrefix}/${blockHash}`;

      // In production, write encrypted block to disk here
      // await fs.writeFile(physicalPath, encryptBlock(blockData, key));

      const { error: insertErr } = await sb.from('data_blocks').insert({
        id: blockId,
        content_hash: blockHash,
        encrypted_hash: blockHash, // In production: hash of encrypted block
        size: blockData.length,
        encrypted_size: blockData.length, // In production: encrypted size
        physical_path: physicalPath,
        compression: 'none',
        ref_count: 1,
      });

      if (insertErr) throw new VaultError(`Failed to insert data_block: ${insertErr.message}`, 'DB_ERROR');

      newBlocksCreated++;
      versionBlockRefs.push({
        blockId,
        index: i,
        offset: i * BLOCK_SIZE_BYTES,
      });
    }
  }

  // 5. Mark previous current version as non-current
  const { error: unmarkErr } = await sb
    .from('file_versions')
    .update({ is_current: false })
    .eq('node_id', nodeId)
    .eq('is_current', true);

  if (unmarkErr) throw new VaultError(`Failed to unmark current version: ${unmarkErr.message}`, 'DB_ERROR');

  // 6. Create new file version
  const versionId = uuidv4();
  const { data: newVersion, error: versionErr } = await sb
    .from('file_versions')
    .insert({
      id: versionId,
      node_id: nodeId,
      version_number: nextVersion,
      total_size: fileData.length,
      content_hash: contentHash,
      encrypted_key: new Uint8Array(32), // In production: per-version encrypted key
      key_nonce: new Uint8Array(24),     // In production: random nonce
      is_current: true,
      is_compressed: false,
      created_by: userId,
    })
    .select()
    .single();

  if (versionErr) {
    // Optimistic lock conflict check
    if (versionErr.message?.includes('unique') || versionErr.message?.includes('duplicate')) {
      throw new VersionConflictError(nodeId, nextVersion);
    }
    throw new VaultError(`Failed to insert file_version: ${versionErr.message}`, 'DB_ERROR');
  }

  // 7. Create file_version_blocks join records
  const blockInserts = versionBlockRefs.map((ref) => ({
    id: uuidv4(),
    version_id: versionId,
    block_id: ref.blockId,
    block_index: ref.index,
    block_offset: ref.offset,
  }));

  const { error: blockJoinErr } = await sb.from('file_version_blocks').insert(blockInserts);

  if (blockJoinErr) throw new VaultError(`Failed to insert version blocks: ${blockJoinErr.message}`, 'DB_ERROR');

  // 8. Update node metadata
  const { error: nodeUpdateErr } = await sb
    .from('nodes')
    .update({
      size: fileData.length,
      updated_at: new Date().toISOString(),
    })
    .eq('id', nodeId);

  if (nodeUpdateErr) throw new VaultError(`Failed to update node: ${nodeUpdateErr.message}`, 'DB_ERROR');

  // 9. Log audit event
  await sb.from('audit_log').insert({
    id: uuidv4(),
    user_id: userId,
    node_id: nodeId,
    action: 'version_create',
    details: {
      version_id: versionId,
      version_number: nextVersion,
      content_hash: contentHash,
      new_blocks: newBlocksCreated,
      total_blocks: blocks.length,
      size: fileData.length,
    },
  });

  return {
    version_id: versionId,
    is_duplicate: false,
    new_blocks_created: newBlocksCreated,
    total_size: fileData.length,
  };
}

/**
 * Restore a file to a specific version by making it the current version.
 * Does not delete newer versions - they remain in history.
 */
export async function restoreFileVersion(
  nodeId: string,
  versionNumber: number,
  userId: string,
): Promise<string> {
  const sb = getSupabaseClient();

  const { data: targetVersion, error: findErr } = await sb
    .from('file_versions')
    .select('id, version_number, total_size')
    .eq('node_id', nodeId)
    .eq('version_number', versionNumber)
    .maybeSingle();

  if (findErr) throw new VaultError(`Failed to find version: ${findErr.message}`, 'DB_ERROR');
  if (!targetVersion) throw new VaultError(`Version ${versionNumber} not found`, 'VERSION_NOT_FOUND');

  // Unmark all current versions
  await sb.from('file_versions').update({ is_current: false }).eq('node_id', nodeId).eq('is_current', true);

  // Mark target as current
  await sb.from('file_versions').update({ is_current: true }).eq('id', targetVersion.id);

  // Update node size
  await sb.from('nodes').update({
    size: targetVersion.total_size,
    updated_at: new Date().toISOString(),
  }).eq('id', nodeId);

  // Audit
  await sb.from('audit_log').insert({
    id: uuidv4(),
    user_id: userId,
    node_id: nodeId,
    action: 'version_restore',
    details: { version_number: versionNumber, version_id: targetVersion.id },
  });

  return targetVersion.id;
}

/**
 * List all versions of a file, newest first.
 */
export async function listFileVersions(
  nodeId: string,
  limit: number = 50,
  offset: number = 0,
): Promise<FileVersion[]> {
  const sb = getSupabaseClient();

  const { data, error } = await sb
    .from('file_versions')
    .select('*')
    .eq('node_id', nodeId)
    .order('version_number', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw new VaultError(`Failed to list versions: ${error.message}`, 'DB_ERROR');
  return data as FileVersion[];
}

/**
 * Garbage collect orphaned data blocks with ref_count = 0.
 * Should be run as a background maintenance task.
 */
export async function garbageCollectBlocks(vaultDir: string): Promise<number> {
  const sb = getSupabaseClient();

  const { data, error } = await sb.rpc('gc_orphaned_blocks');

  if (error) throw new VaultError(`GC failed: ${error.message}`, 'DB_ERROR');

  // In production: delete physical files from disk
  // for (const block of orphans) {
  //   await fs.unlink(block.physical_path);
  // }

  return (data as number) ?? 0;
}
