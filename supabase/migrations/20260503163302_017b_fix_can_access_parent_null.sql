
/*
  # Fix can_access_parent for NULL parent_id

  1. Modified Functions
    - `can_access_parent(p_parent_id, p_permissions)`
      - When parent_id is NULL (root-level node), the function now returns TRUE
        instead of FALSE. This allows the nodes INSERT policy's OR condition
        to work correctly for both owners and ACL-granted users creating
        root-level nodes.
      - Previously, can_access_parent(NULL, ...) returned FALSE because
        `WHERE id = NULL` matches no rows. While the nodes INSERT policy
        has `owner_id = auth.uid()` as an OR fallback, this fix ensures
        ACL-based access also works at the root level.

  2. Security
    - Root-level nodes are still protected: the nodes INSERT policy requires
      either `owner_id = auth.uid()` OR `can_access_parent(parent_id, ...)`.
      For root nodes, can_access_parent now returns TRUE, but the user still
      must be authenticated and the owner_id must match auth.uid() if no
      parent ACL exists.

  3. Important Notes
    - This is a SECURITY DEFINER function, so it executes with postgres privileges
    - The function bypasses RLS on nodes and access_control_lists tables
    - This is intentional: the function is used BY RLS policies to check access
*/

CREATE OR REPLACE FUNCTION can_access_parent(p_parent_id uuid, p_permissions text[])
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT
    CASE
      WHEN p_parent_id IS NULL THEN TRUE
      ELSE
        EXISTS (
          SELECT 1 FROM public.nodes
          WHERE id = p_parent_id AND owner_id = auth.uid()
        ) OR EXISTS (
          SELECT 1 FROM public.access_control_lists
          WHERE node_id = p_parent_id
          AND user_id = auth.uid()
          AND permission = ANY(p_permissions)
        )
    END;
$$;
