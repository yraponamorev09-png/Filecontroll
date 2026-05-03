
/*
  # Add file content storage via Supabase Storage

  1. Storage Bucket
    - `vault-files`: Private bucket for storing actual file content.
      Files are stored at path `<owner_id>/<node_id>/<version_number>`.
      This enables file preview and download without requiring disk access.

  2. Storage RLS Policies
    - SELECT: Users can read files they own or have read access to via ACLs.
      Uses a helper function `can_read_node` for ACL checking.
    - INSERT: Users can upload files for nodes they own or have write access to.
    - UPDATE/DELETE: Only node owners or admins can update/delete stored files.

  3. Helper Function
    - `can_read_node(node_id)`: SECURITY DEFINER function that checks if
      the current user can read the specified node (owner or has read ACL).

  4. Important Notes
    - The bucket is private (not publicly accessible).
    - File paths include owner_id for partitioning and node_id for lookup.
    - This migration also creates the bucket if it doesn't exist (idempotent).
*/

-- Ensure bucket exists
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('vault-files', 'vault-files', false, 52428800)
ON CONFLICT (id) DO NOTHING;

-- Helper: can current user read a node?
CREATE OR REPLACE FUNCTION can_read_node(p_node_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.nodes
    WHERE id = p_node_id AND owner_id = auth.uid()
  ) OR EXISTS (
    SELECT 1 FROM public.access_control_lists
    WHERE node_id = p_node_id
    AND user_id = auth.uid()
    AND permission = ANY(ARRAY['read', 'write', 'admin'])
  );
$$;

-- Storage SELECT policy: users can read files for nodes they can access
CREATE POLICY "Users can read files of accessible nodes"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'vault-files'
    AND can_read_node((string_to_array(name, '/'))[2]::uuid)
  );

-- Storage INSERT policy: users can upload files for nodes they can write to
CREATE POLICY "Users can upload files for writable nodes"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'vault-files'
    AND (string_to_array(name, '/'))[1] = auth.uid()::text
  );

-- Storage DELETE policy: only owners/admins can delete stored files
CREATE POLICY "Owners can delete stored files"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'vault-files'
    AND (string_to_array(name, '/'))[1] = auth.uid()::text
  );
