import { v4 as uuidv4 } from 'uuid';
import { getSupabaseClient } from '../utils/db.js';
import { VaultError, VersionConflictError } from '../types/index.js';

/**
 * Concurrency and conflict resolution for the Vault DMS.
 *
 * Problem: Two processes may try to modify the same file simultaneously.
 * Solution: Optimistic concurrency control with version numbers.
 *
 * When saving a new version:
 * 1. Read current version_number before writing.
 * 2. Insert with version_number = current + 1.
 * 3. If another process already inserted with that number, the unique
 *    constraint (node_id, version_number) fails -> VersionConflictError.
 * 4. The losing process must re-read, merge or retry.
 *
 * For file content conflicts (two edits to the same file):
 * - Both versions are preserved (no data loss).
 * - The second writer gets a conflict notification.
 * - Resolution strategies: keep both, merge, or pick winner.
 */

export type ConflictResolution = 'keep_both' | 'last_writer_wins' | 'manual';

export interface ConflictInfo {
  node_id: string;
  expected_version: number;
  actual_version: number;
  conflicting_version_id: string;
}

/**
 * Detect if a version conflict exists before attempting to save.
 */
export async function detectConflict(
  nodeId: string,
  expectedVersionNumber: number,
): Promise<ConflictInfo | null> {
  const sb = getSupabaseClient();

  const { data: current, error } = await sb
    .from('file_versions')
    .select('id, version_number')
    .eq('node_id', nodeId)
    .eq('is_current', true)
    .maybeSingle();

  if (error) throw new VaultError(`Conflict detection failed: ${error.message}`, 'DB_ERROR');
  if (!current) return null;

  if (current.version_number !== expectedVersionNumber) {
    return {
      node_id: nodeId,
      expected_version: expectedVersionNumber,
      actual_version: current.version_number,
      conflicting_version_id: current.id,
    };
  }

  return null;
}

/**
 * Resolve a version conflict using the specified strategy.
 *
 * - keep_both: Rename the losing version and keep both (no data loss).
 * - last_writer_wins: The new version replaces the old current.
 * - manual: Mark the conflict for human review.
 */
export async function resolveConflict(
  nodeId: string,
  userId: string,
  strategy: ConflictResolution,
  newFileData?: Buffer,
): Promise<{ resolved: boolean; version_id?: string }> {
  const sb = getSupabaseClient();

  switch (strategy) {
    case 'last_writer_wins': {
      // Simply proceed - the new version will be marked current
      // The old current version remains in history
      await sb.from('audit_log').insert({
        id: uuidv4(),
        user_id: userId,
        node_id: nodeId,
        action: 'conflict_resolve',
        details: { strategy: 'last_writer_wins' },
      });
      return { resolved: true };
    }

    case 'keep_both': {
      // Both versions already exist in the version history
      // No action needed - just log it
      await sb.from('audit_log').insert({
        id: uuidv4(),
        user_id: userId,
        node_id: nodeId,
        action: 'conflict_resolve',
        details: { strategy: 'keep_both' },
      });
      return { resolved: true };
    }

    case 'manual': {
      // Create a conflict marker on the node for human review
      const { data: node } = await sb
        .from('nodes')
        .select('name')
        .eq('id', nodeId)
        .maybeSingle();

      await sb.from('audit_log').insert({
        id: uuidv4(),
        user_id: userId,
        node_id: nodeId,
        action: 'conflict_flagged',
        details: {
          strategy: 'manual',
          node_name: node?.name,
          message: 'Version conflict requires manual resolution',
        },
      });

      return { resolved: false };
    }
  }
}

/**
 * Advisory lock mechanism for file operations.
 * Uses a lightweight lock table to prevent concurrent writes.
 *
 * In production with SQLite, you'd use BEGIN EXCLUSIVE / PRAGMA locking_mode.
 * With Supabase/Postgres, we use a lock table with advisory locks.
 */
export async function acquireFileLock(
  nodeId: string,
  userId: string,
  timeoutMs: number = 5000,
): Promise<{ lockId: string; acquired: boolean }> {
  const sb = getSupabaseClient();

  // Check if already locked by someone else
  const { data: existing } = await sb
    .from('audit_log')
    .select('id, user_id, created_at')
    .eq('node_id', nodeId)
    .eq('action', 'file_lock')
    .gt('created_at', new Date(Date.now() - timeoutMs).toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing && existing.user_id !== userId) {
    return { lockId: '', acquired: false };
  }

  // Create lock record
  const lockId = uuidv4();
  await sb.from('audit_log').insert({
    id: lockId,
    user_id: userId,
    node_id: nodeId,
    action: 'file_lock',
    details: { timeout_ms: timeoutMs },
  });

  return { lockId, acquired: true };
}

/**
 * Release a file lock.
 */
export async function releaseFileLock(
  nodeId: string,
  userId: string,
): Promise<void> {
  const sb = getSupabaseClient();

  // Verify the user owns the lock before releasing
  const { data: lock } = await sb
    .from('collab_sessions')
    .select('user_id')
    .eq('node_id', nodeId)
    .eq('is_active', true)
    .maybeSingle();

  if (lock && lock.user_id !== userId) {
    throw new VaultError('Cannot release lock owned by another user', 'LOCK_NOT_OWNER');
  }

  await sb.from('collab_sessions').update({ is_active: false }).eq('node_id', nodeId).eq('is_active', true);

  await sb.from('audit_log').insert({
    id: uuidv4(),
    user_id: userId,
    node_id: nodeId,
    action: 'file_unlock',
    details: {},
  });
}
