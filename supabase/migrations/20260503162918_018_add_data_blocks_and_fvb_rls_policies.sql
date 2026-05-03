/*
  # Add missing RLS INSERT/UPDATE/DELETE policies for data_blocks and file_version_blocks

  1. Problem
    - `data_blocks` has only SELECT and service-role policies. No INSERT policy for authenticated users.
    - `file_version_blocks` has only SELECT and service-role policies. No INSERT/UPDATE/DELETE policies for authenticated users.
    - When a user uploads a file, the client inserts into `nodes`, `file_versions`, `data_blocks`, and `file_version_blocks`.
    - Without INSERT policies on `data_blocks` and `file_version_blocks`, file uploads fail with RLS errors.

  2. Changes
    - Add INSERT policy on `data_blocks`: authenticated users can insert blocks
    - Add UPDATE policy on `data_blocks`: only service role can update (ref_count changes happen via RPC)
    - Add DELETE policy on `data_blocks`: only service role can delete (GC is admin operation)
    - Add INSERT policy on `file_version_blocks`: authenticated users can insert version-block links
    - Add DELETE policy on `file_version_blocks`: authenticated users can delete when purging versions

  3. Security Notes
    - data_blocks INSERT is safe because blocks are content-addressed and deduplicated
    - file_version_blocks INSERT is safe because it's a join table linking versions to blocks
    - DELETE on data_blocks is restricted to service role only (GC is a privileged operation)
    - UPDATE on data_blocks is restricted to service role only (ref_count changes are internal)
*/

-- data_blocks: allow authenticated users to insert new blocks
CREATE POLICY "Authenticated users can insert data blocks"
  ON data_blocks FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- data_blocks: only service role can update (ref_count changes)
CREATE POLICY "Service role can update data blocks"
  ON data_blocks FOR UPDATE
  TO authenticated
  USING (false)
  WITH CHECK (false);

-- data_blocks: only service role can delete (GC operation)
CREATE POLICY "Service role can delete data blocks"
  ON data_blocks FOR DELETE
  TO authenticated
  USING (false);

-- file_version_blocks: allow authenticated users to insert version-block links
CREATE POLICY "Authenticated users can insert version-block links"
  ON file_version_blocks FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- file_version_blocks: allow authenticated users to delete version-block links (when purging versions)
CREATE POLICY "Authenticated users can delete version-block links"
  ON file_version_blocks FOR DELETE
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM file_versions fv
    WHERE fv.id = file_version_blocks.version_id
    AND can_access_node(fv.node_id, ARRAY['write', 'admin'])
  ));
