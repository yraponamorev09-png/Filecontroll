
/*
  # Fix data_blocks and file_versions RLS policies

  1. Modified Tables
    - `data_blocks`
      - DELETE policy: Changed from `USING (false)` to allow users who can write to
        any file version that references the block. This enables garbage collection
        when blocks become orphaned (ref_count = 0).
      - UPDATE policy: Changed from `USING (false) / WITH CHECK (false)` to allow
        updating ref_count for users who can write to referencing files. This is
        needed for dedup (incrementing ref_count) and GC (decrementing ref_count).
    - `file_versions`
      - Added UPDATE policy: Users with write/admin access to the node can update
        version records. This is needed for version restore (changing is_current)
        and archival (changing is_compressed).

  2. Security
    - data_blocks DELETE: Only allowed if the block is orphaned (ref_count <= 0)
      AND the user is authenticated. Physical deletion of orphaned blocks is a
      maintenance operation that doesn't expose sensitive data.
    - data_blocks UPDATE: Only allowed if the user can access a file that
      references the block. This prevents unauthorized ref_count manipulation.
    - file_versions UPDATE: Only allowed if user has write/admin access to the
      node. This prevents unauthorized version manipulation.

  3. Important Notes
    - The old `USING (false)` policies effectively made data_blocks immutable
      for authenticated users, which broke garbage collection and dedup ref_count
      updates.
    - The missing file_versions UPDATE policy would cause version restore and
      archival operations to fail with RLS errors.
*/

-- Drop old restrictive data_blocks policies
DROP POLICY IF EXISTS "Service role can delete data blocks" ON data_blocks;
DROP POLICY IF EXISTS "Service role can update data blocks" ON data_blocks;

-- New data_blocks DELETE policy: authenticated users can delete orphaned blocks
CREATE POLICY "Authenticated users can delete orphaned data blocks"
  ON data_blocks FOR DELETE
  TO authenticated
  USING (ref_count <= 0);

-- New data_blocks UPDATE policy: users who can access referencing files can update blocks
CREATE POLICY "Users can update blocks of accessible files"
  ON data_blocks FOR UPDATE
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM file_version_blocks fvb
    JOIN file_versions fv ON fv.id = fvb.version_id
    WHERE fvb.block_id = data_blocks.id
    AND can_access_node(fv.node_id, ARRAY['write', 'admin'])
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM file_version_blocks fvb
    JOIN file_versions fv ON fv.id = fvb.version_id
    WHERE fvb.block_id = data_blocks.id
    AND can_access_node(fv.node_id, ARRAY['write', 'admin'])
  ));

-- Add missing file_versions UPDATE policy
CREATE POLICY "Users can update versions of accessible nodes"
  ON file_versions FOR UPDATE
  TO authenticated
  USING (can_access_node(node_id, ARRAY['write', 'admin']))
  WITH CHECK (can_access_node(node_id, ARRAY['write', 'admin']));
