/*
  # Fix Mutual RLS Recursion: nodes <-> access_control_lists

  1. Problem
    - nodes SELECT policy checks access_control_lists (can user access this node?)
    - access_control_lists SELECT policy checks nodes (is user the owner of the node?)
    - This creates infinite mutual recursion

  2. Solution
    - Create SECURITY DEFINER helper functions that bypass RLS
    - Replace direct table references in policies with these helpers
    - is_node_owner(node_id) -> checks if auth.uid() is the node owner
    - has_node_acl(node_id, permission) -> checks if user has ACL on node
*/

-- ============================================
-- HELPER: Check if current user owns a node
-- Bypasses RLS (SECURITY DEFINER) to break recursion
-- ============================================

CREATE OR REPLACE FUNCTION public.is_node_owner(p_node_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.nodes
    WHERE id = p_node_id AND owner_id = auth.uid()
  );
$$;

-- ============================================
-- HELPER: Check if current user has ACL on a node
-- Bypasses RLS (SECURITY DEFINER) to break recursion
-- ============================================

CREATE OR REPLACE FUNCTION public.has_node_acl(p_node_id uuid, p_permissions text[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.access_control_lists
    WHERE node_id = p_node_id
      AND user_id = auth.uid()
      AND permission = ANY(p_permissions)
  );
$$;

-- ============================================
-- HELPER: Check if user can access a node (owner OR has ACL)
-- ============================================

CREATE OR REPLACE FUNCTION public.can_access_node(p_node_id uuid, p_permissions text[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.nodes
    WHERE id = p_node_id AND owner_id = auth.uid()
  ) OR EXISTS (
    SELECT 1 FROM public.access_control_lists
    WHERE node_id = p_node_id
      AND user_id = auth.uid()
      AND permission = ANY(p_permissions)
  );
$$;

-- ============================================
-- HELPER: Check if user can access parent node (for INSERT)
-- ============================================

CREATE OR REPLACE FUNCTION public.can_access_parent(p_parent_id uuid, p_permissions text[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.nodes
    WHERE id = p_parent_id AND owner_id = auth.uid()
  ) OR EXISTS (
    SELECT 1 FROM public.access_control_lists
    WHERE node_id = p_parent_id
      AND user_id = auth.uid()
      AND permission = ANY(p_permissions)
  );
$$;

-- ============================================
-- HELPER: Check if user is node admin (for ACL management)
-- ============================================

CREATE OR REPLACE FUNCTION public.is_node_admin(p_node_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.nodes
    WHERE id = p_node_id AND owner_id = auth.uid()
  ) OR EXISTS (
    SELECT 1 FROM public.access_control_lists
    WHERE node_id = p_node_id
      AND user_id = auth.uid()
      AND permission = 'admin'
  );
$$;

-- ============================================
-- GRANT EXECUTE to authenticated users
-- ============================================

GRANT EXECUTE ON FUNCTION public.is_node_owner(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_node_acl(uuid, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_access_node(uuid, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_access_parent(uuid, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_node_admin(uuid) TO authenticated;

-- ============================================
-- NODES: Replace policies using helpers (no recursion)
-- ============================================

DROP POLICY IF EXISTS "Users can view nodes they have access to" ON public.nodes;
DROP POLICY IF EXISTS "Users can create nodes in accessible folders" ON public.nodes;
DROP POLICY IF EXISTS "Users can update nodes they have write access to" ON public.nodes;
DROP POLICY IF EXISTS "Users can delete nodes they own or have admin access to" ON public.nodes;

CREATE POLICY "Users can view nodes they have access to"
  ON public.nodes FOR SELECT
  TO authenticated
  USING (public.can_access_node(id, ARRAY['read','write','admin']));

CREATE POLICY "Users can create nodes in accessible folders"
  ON public.nodes FOR INSERT
  TO authenticated
  WITH CHECK (owner_id = auth.uid() OR public.can_access_parent(parent_id, ARRAY['write','admin']));

CREATE POLICY "Users can update nodes they have write access to"
  ON public.nodes FOR UPDATE
  TO authenticated
  USING (public.can_access_node(id, ARRAY['write','admin']))
  WITH CHECK (public.can_access_node(id, ARRAY['write','admin']));

CREATE POLICY "Users can delete nodes they own or have admin access to"
  ON public.nodes FOR DELETE
  TO authenticated
  USING (public.is_node_owner(id) OR public.has_node_acl(id, ARRAY['admin']));

-- ============================================
-- ACCESS_CONTROL_LISTS: Replace policies using helpers
-- ============================================

DROP POLICY IF EXISTS "Users can view ACLs on nodes they can access" ON public.access_control_lists;
DROP POLICY IF EXISTS "Node owners and admins can create ACLs" ON public.access_control_lists;
DROP POLICY IF EXISTS "Node owners and admins can update ACLs" ON public.access_control_lists;
DROP POLICY IF EXISTS "Node owners and admins can delete ACLs" ON public.access_control_lists;

CREATE POLICY "Users can view ACLs on nodes they can access"
  ON public.access_control_lists FOR SELECT
  TO authenticated
  USING (user_id = auth.uid() OR public.is_node_owner(node_id));

CREATE POLICY "Node owners and admins can create ACLs"
  ON public.access_control_lists FOR INSERT
  TO authenticated
  WITH CHECK (public.is_node_admin(node_id));

CREATE POLICY "Node owners and admins can update ACLs"
  ON public.access_control_lists FOR UPDATE
  TO authenticated
  USING (public.is_node_admin(node_id))
  WITH CHECK (public.is_node_admin(node_id));

CREATE POLICY "Node owners and admins can delete ACLs"
  ON public.access_control_lists FOR DELETE
  TO authenticated
  USING (public.is_node_admin(node_id));

-- ============================================
-- SHARE_LINKS: Fix policies that reference nodes
-- ============================================

DROP POLICY IF EXISTS "Users can view share links they created or for their nodes" ON public.share_links;
DROP POLICY IF EXISTS "Users can create share links for nodes they have admin access t" ON public.share_links;

CREATE POLICY "Users can view share links they created or for their nodes"
  ON public.share_links FOR SELECT
  TO authenticated
  USING (created_by = auth.uid() OR public.is_node_owner(node_id));

CREATE POLICY "Users can create share links for nodes they have admin access to"
  ON public.share_links FOR INSERT
  TO authenticated
  WITH CHECK (created_by = auth.uid() AND public.is_node_admin(node_id));

-- ============================================
-- FILE_VERSIONS: Fix policies that reference nodes
-- ============================================

DROP POLICY IF EXISTS "Users can view versions of accessible nodes" ON public.file_versions;
DROP POLICY IF EXISTS "Users can create versions for accessible nodes" ON public.file_versions;

CREATE POLICY "Users can view versions of accessible nodes"
  ON public.file_versions FOR SELECT
  TO authenticated
  USING (public.can_access_node(node_id, ARRAY['read','write','admin']));

CREATE POLICY "Users can create versions for accessible nodes"
  ON public.file_versions FOR INSERT
  TO authenticated
  WITH CHECK (public.can_access_node(node_id, ARRAY['write','admin']));

-- ============================================
-- DATA_BLOCKS: Fix policy that references nodes via joins
-- ============================================

DROP POLICY IF EXISTS "Authenticated users can read data blocks for accessible files" ON public.data_blocks;

CREATE POLICY "Authenticated users can read data blocks for accessible files"
  ON public.data_blocks FOR SELECT
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.file_version_blocks fvb
    JOIN public.file_versions fv ON fv.id = fvb.version_id
    WHERE fvb.block_id = data_blocks.id
      AND public.can_access_node(fv.node_id, ARRAY['read','write','admin'])
  ));

-- ============================================
-- FILE_VERSION_BLOCKS: Fix policy
-- ============================================

DROP POLICY IF EXISTS "Users can view blocks of accessible versions" ON public.file_version_blocks;

CREATE POLICY "Users can view blocks of accessible versions"
  ON public.file_version_blocks FOR SELECT
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.file_versions fv
    WHERE fv.id = file_version_blocks.version_id
      AND public.can_access_node(fv.node_id, ARRAY['read','write','admin'])
  ));

-- ============================================
-- NODE_CLOSURE: Fix policy
-- ============================================

DROP POLICY IF EXISTS "Users can read closure for accessible nodes" ON public.node_closure;

CREATE POLICY "Users can read closure for accessible nodes"
  ON public.node_closure FOR SELECT
  TO authenticated
  USING (public.can_access_node(ancestor_id, ARRAY['read','write','admin']));

-- ============================================
-- AUDIT_LOG: Fix policy that references nodes
-- ============================================

DROP POLICY IF EXISTS "Authenticated users can read audit_log" ON public.audit_log;

CREATE POLICY "Authenticated users can read audit_log"
  ON public.audit_log FOR SELECT
  TO authenticated
  USING (public.is_owner_or_auditor() OR (node_id IS NOT NULL AND public.is_node_owner(node_id)));
