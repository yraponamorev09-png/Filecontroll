import { v4 as uuidv4 } from 'uuid';
import { getSupabaseClient } from '../utils/db.js';
import type { Node, FileVersion } from '../types/index.js';
import { VaultError } from '../types/index.js';

/**
 * Archival policy: move old/rarely-used file versions to compressed storage.
 *
 * Strategy:
 * - Versions older than `ageDays` that are not the current version get compressed.
 * - Files not accessed in `idleDays` get marked as archived.
 * - Archived files use zstd/lz4 compression on their data blocks.
 * - Accessing an archived file transparently decompresses it.
 *
 * This runs as a background maintenance task.
 */

export interface ArchivalPolicy {
  versionAgeDays: number;       // Compress non-current versions older than this
  fileIdleDays: number;          // Mark files as archived if not accessed in this many days
  compressionAlgorithm: 'zstd' | 'lz4';
  batchSize: number;            // Process this many items per run
}

const DEFAULT_POLICY: ArchivalPolicy = {
  versionAgeDays: 90,
  fileIdleDays: 180,
  compressionAlgorithm: 'zstd',
  batchSize: 100,
};

/**
 * Archive old file versions by marking them as compressed.
 * In production, this would also compress the physical data blocks on disk.
 */
export async function archiveOldVersions(
  policy: ArchivalPolicy = DEFAULT_POLICY,
  userId?: string,
): Promise<{ versionsArchived: number; filesArchived: number }> {
  const sb = getSupabaseClient();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - policy.versionAgeDays);

  // Find non-current, uncompressed versions older than cutoff
  const { data: oldVersions, error: findErr } = await sb
    .from('file_versions')
    .select('id, node_id, version_number, is_compressed, created_at')
    .eq('is_current', false)
    .eq('is_compressed', false)
    .lt('created_at', cutoffDate.toISOString())
    .limit(policy.batchSize);

  if (findErr) throw new VaultError(`Failed to find old versions: ${findErr.message}`, 'DB_ERROR');

  let versionsArchived = 0;
  if (oldVersions && oldVersions.length > 0) {
    const versionIds = oldVersions.map((v) => v.id);

    // Mark versions as compressed
    const { error: updateErr } = await sb
      .from('file_versions')
      .update({ is_compressed: true })
      .in('id', versionIds);

    if (updateErr) throw new VaultError(`Failed to archive versions: ${updateErr.message}`, 'DB_ERROR');

    // In production: compress the data blocks on disk
    // for (const version of oldVersions) {
    //   const blocks = await getVersionBlocks(version.id);
    //   for (const block of blocks) {
    //     await compressBlock(block, policy.compressionAlgorithm);
    //   }
    // }

    versionsArchived = versionIds.length;

    // Audit
    await sb.from('audit_log').insert({
      id: uuidv4(),
      user_id: userId || 'system',
      action: 'archive_versions',
      details: {
        count: versionsArchived,
        policy: policy.versionAgeDays,
        algorithm: policy.compressionAlgorithm,
      },
    });
  }

  // Find idle files to mark as archived
  const idleCutoff = new Date();
  idleCutoff.setDate(idleCutoff.getDate() - policy.fileIdleDays);

  const { data: idleFiles, error: idleErr } = await sb
    .from('nodes')
    .select('id, updated_at, is_archived')
    .eq('node_type', 'file')
    .eq('is_archived', false)
    .eq('is_deleted', false)
    .lt('updated_at', idleCutoff.toISOString())
    .limit(policy.batchSize);

  if (idleErr) throw new VaultError(`Failed to find idle files: ${idleErr.message}`, 'DB_ERROR');

  let filesArchived = 0;
  if (idleFiles && idleFiles.length > 0) {
    const fileIds = idleFiles.map((f) => f.id);

    const { error: archiveErr } = await sb
      .from('nodes')
      .update({ is_archived: true })
      .in('id', fileIds);

    if (archiveErr) throw new VaultError(`Failed to archive files: ${archiveErr.message}`, 'DB_ERROR');

    filesArchived = fileIds.length;

    await sb.from('audit_log').insert({
      id: uuidv4(),
      user_id: userId || 'system',
      action: 'archive_files',
      details: { count: filesArchived, idle_days: policy.fileIdleDays },
    });
  }

  return { versionsArchived, filesArchived };
}

/**
 * Restore an archived file (transparent decompression on access).
 */
export async function unarchiveFile(nodeId: string): Promise<void> {
  const sb = getSupabaseClient();

  const { error } = await sb
    .from('nodes')
    .update({
      is_archived: false,
      updated_at: new Date().toISOString(),
    })
    .eq('id', nodeId)
    .eq('is_archived', true);

  if (error) throw new VaultError(`Failed to unarchive file: ${error.message}`, 'DB_ERROR');

  // In production: decompress data blocks on disk
}

/**
 * Soft-delete a node (move to trash). Hard delete requires separate admin operation.
 */
export async function softDeleteNode(nodeId: string, userId: string): Promise<void> {
  const sb = getSupabaseClient();

  const { error } = await sb
    .from('nodes')
    .update({
      is_deleted: true,
      deleted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', nodeId);

  if (error) throw new VaultError(`Failed to soft-delete node: ${error.message}`, 'DB_ERROR');

  await sb.from('audit_log').insert({
    id: uuidv4(),
    user_id: userId,
    node_id: nodeId,
    action: 'node_soft_delete',
    details: {},
  });
}

/**
 * Permanently purge soft-deleted nodes older than the given retention period.
 * Also decrements data_block ref_counts and garbage collects orphaned blocks.
 */
export async function purgeDeletedNodes(
  retentionDays: number = 30,
  batchSize: number = 50,
): Promise<number> {
  const sb = getSupabaseClient();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);

  const { data: expired, error: findErr } = await sb
    .from('nodes')
    .select('id')
    .eq('is_deleted', true)
    .lt('deleted_at', cutoff.toISOString())
    .limit(batchSize);

  if (findErr) throw new VaultError(`Failed to find expired nodes: ${findErr.message}`, 'DB_ERROR');
  if (!expired || expired.length === 0) return 0;

  const nodeIds = expired.map((n) => n.id);

  // Decrement ref_counts for all blocks used by these nodes' versions
  for (const nodeId of nodeIds) {
    const { data: versions } = await sb
      .from('file_versions')
      .select('id')
      .eq('node_id', nodeId);

    if (versions) {
      for (const version of versions) {
        const { data: versionBlocks } = await sb
          .from('file_version_blocks')
          .select('block_id')
          .eq('version_id', version.id);

        if (versionBlocks) {
          for (const vb of versionBlocks) {
            await sb.rpc('decrement_block_ref_count', { block_id: vb.block_id });
          }
        }
      }
    }
  }

  // Delete file_version_blocks, file_versions, acls, share_links for these nodes
  for (const nodeId of nodeIds) {
    const versionIds = (await sb.from('file_versions').select('id').eq('node_id', nodeId)).data?.map((v) => v.id) ?? [];
    if (versionIds.length > 0) {
      await sb.from('file_version_blocks').delete().in('version_id', versionIds);
    }
    await sb.from('file_versions').delete().eq('node_id', nodeId);
    await sb.from('access_control_lists').delete().eq('node_id', nodeId);
    await sb.from('share_links').delete().eq('node_id', nodeId);
    await sb.from('audit_log').delete().eq('node_id', nodeId);
  }

  // Finally, delete the nodes themselves
  const { error: deleteErr } = await sb.from('nodes').delete().in('id', nodeIds);
  if (deleteErr) throw new VaultError(`Failed to purge nodes: ${deleteErr.message}`, 'DB_ERROR');

  return nodeIds.length;
}
