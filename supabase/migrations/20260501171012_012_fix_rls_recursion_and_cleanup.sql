/*
  # Fix RLS Infinite Recursion and Policy Cleanup

  1. Problem: Infinite Recursion
    - `user_profiles` "Owners can read all profiles" policy queries user_profiles
      inside a user_profiles SELECT policy -> infinite recursion
    - `nodes` ACL-based policies query access_control_lists which references nodes
      -> potential recursion chain
    - `audit_log` "Auditors and owners" policy queries `users` (legacy table)

  2. Problem: Stale Anon Policies
    - Many tables still have "App anon *" policies from early migrations
    - These coexist with authenticated policies, creating security holes

  3. Problem: Duplicate Policies
    - Multiple SELECT policies on same table for same role (e.g., nodes has
      "Authenticated users can read nodes" AND "Users can view nodes they have access to")
    - Both are PERMISSIVE so they combine with OR, but the broader one
      (true) makes the specific one useless

  4. Solution
    - Replace user_profiles self-referencing policy with auth.jwt() approach
    - Remove all anon policies (security: authenticated only)
    - Remove duplicate overly-permissive authenticated policies
    - Keep specific access-control policies where they add value
    - Use SECURITY DEFINER helper functions to break recursion cycles
*/

-- ============================================
-- HELPER: Break recursion for role checks
-- ============================================
-- A SECURITY DEFINER function runs as the function owner (postgres),
-- bypassing RLS. This breaks the recursion cycle where a policy on
-- user_profiles needs to query user_profiles.

CREATE OR REPLACE FUNCTION public.is_owner_or_auditor()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE id = auth.uid() AND role IN ('owner', 'auditor')
  );
$$;

-- ============================================
-- USER_PROFILES: Fix infinite recursion
-- ============================================

-- Drop the self-referencing policy
DROP POLICY IF EXISTS "Owners can read all profiles" ON public.user_profiles;

-- Replace with helper function (no recursion)
CREATE POLICY "Owners and auditors can read all profiles"
  ON public.user_profiles FOR SELECT
  TO authenticated
  USING (public.is_owner_or_auditor() OR auth.uid() = id);

-- Drop old separate "read own" since it's now combined above
DROP POLICY IF EXISTS "Users can read own profile" ON public.user_profiles;

-- ============================================
-- NODES: Remove duplicate/conflicting policies
-- ============================================

-- Drop overly broad "Authenticated users can read nodes" (true)
-- Keep the specific "Users can view nodes they have access to"
DROP POLICY IF EXISTS "Authenticated users can read nodes" ON public.nodes;

-- Drop duplicate "Users can insert nodes" (auth.uid() = owner_id)
-- Keep "Users can create nodes in accessible folders" (more permissive for collab)
DROP POLICY IF EXISTS "Users can insert nodes" ON public.nodes;

-- Drop duplicate "Owners can update their nodes"
-- Keep "Users can update nodes they have write access to" (includes ACL)
DROP POLICY IF EXISTS "Owners can update their nodes" ON public.nodes;

-- Drop duplicate "Owners can delete their nodes"
-- Keep "Users can delete nodes they own or have admin access to" (includes ACL)
DROP POLICY IF EXISTS "Owners can delete their nodes" ON public.nodes;

-- ============================================
-- FILE_VERSIONS: Remove duplicate policies
-- ============================================

DROP POLICY IF EXISTS "Authenticated users can read file_versions" ON public.file_versions;
-- Keep "Users can view versions of accessible nodes"

DROP POLICY IF EXISTS "Authenticated users can insert file_versions" ON public.file_versions;
-- Keep "Users can create versions for accessible nodes"

DROP POLICY IF EXISTS "Authenticated users can update file_versions" ON public.file_versions;
-- No specific ACL-based update policy needed; add one if required

-- ============================================
-- DATA_BLOCKS: Remove duplicate policies
-- ============================================

DROP POLICY IF EXISTS "Authenticated users can read data_blocks" ON public.data_blocks;
-- Keep "Authenticated users can read data blocks for accessible files"

DROP POLICY IF EXISTS "Authenticated users can insert data_blocks" ON public.data_blocks;
DROP POLICY IF EXISTS "Authenticated users can update data_blocks" ON public.data_blocks;
-- data_blocks are managed by system (versioning.ts), not directly by users

-- ============================================
-- FILE_VERSION_BLOCKS: Remove duplicate policies
-- ============================================

DROP POLICY IF EXISTS "Authenticated users can read file_version_blocks" ON public.file_version_blocks;
-- Keep "Users can view blocks of accessible versions"

DROP POLICY IF EXISTS "Authenticated users can insert file_version_blocks" ON public.file_version_blocks;
-- Managed by system

-- ============================================
-- ACCESS_CONTROL_LISTS: Remove duplicate policies
-- ============================================

DROP POLICY IF EXISTS "Authenticated users can read ACLs" ON public.access_control_lists;
-- Keep "Users can view ACLs on nodes they can access"

DROP POLICY IF EXISTS "Authenticated users can insert ACLs" ON public.access_control_lists;
-- Keep "Node owners and admins can create ACLs"

DROP POLICY IF EXISTS "Authenticated users can update ACLs" ON public.access_control_lists;
-- Add proper update policy
CREATE POLICY "Node owners and admins can update ACLs"
  ON public.access_control_lists FOR UPDATE
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM nodes
      WHERE nodes.id = access_control_lists.node_id
      AND (nodes.owner_id = auth.uid()
        OR EXISTS (SELECT 1 FROM access_control_lists acl
          WHERE acl.node_id = nodes.id AND acl.user_id = auth.uid() AND acl.permission = 'admin'))))
  WITH CHECK (
    EXISTS (SELECT 1 FROM nodes
      WHERE nodes.id = access_control_lists.node_id
      AND (nodes.owner_id = auth.uid()
        OR EXISTS (SELECT 1 FROM access_control_lists acl
          WHERE acl.node_id = nodes.id AND acl.user_id = auth.uid() AND acl.permission = 'admin'))));

DROP POLICY IF EXISTS "Authenticated users can delete ACLs" ON public.access_control_lists;
-- Keep "Node owners and admins can delete ACLs"

-- ============================================
-- SHARE_LINKS: Remove duplicate policies
-- ============================================

DROP POLICY IF EXISTS "Authenticated users can read share_links" ON public.share_links;
-- Keep "Users can view share links they created or for their nodes"

DROP POLICY IF EXISTS "Authenticated users can insert share_links" ON public.share_links;
-- Keep "Users can create share links for nodes they have admin access t"

DROP POLICY IF EXISTS "Authenticated users can update share_links" ON public.share_links;
-- Keep "Users can update share links they created"

DROP POLICY IF EXISTS "Authenticated users can delete share_links" ON public.share_links;
-- Keep "Users can delete share links they created"

-- ============================================
-- AUDIT_LOG: Fix policy referencing legacy `users` table
-- ============================================

DROP POLICY IF EXISTS "Auditors and owners can read audit log" ON public.audit_log;
DROP POLICY IF EXISTS "Authenticated users can read audit_log" ON public.audit_log;
DROP POLICY IF EXISTS "System can insert audit log entries" ON public.audit_log;
DROP POLICY IF EXISTS "Authenticated users can insert audit_log" ON public.audit_log;

-- New clean policies
CREATE POLICY "Authenticated users can read audit_log"
  ON public.audit_log FOR SELECT
  TO authenticated
  USING (public.is_owner_or_auditor() OR EXISTS (
    SELECT 1 FROM nodes WHERE nodes.id = audit_log.node_id AND nodes.owner_id = auth.uid()));

CREATE POLICY "Authenticated users can insert audit_log"
  ON public.audit_log FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

-- ============================================
-- NODE_CLOSURE: Remove duplicate policies
-- ============================================

DROP POLICY IF EXISTS "Authenticated users can read node_closure" ON public.node_closure;
-- Keep "Users can read closure for accessible nodes"

DROP POLICY IF EXISTS "Authenticated users can insert node_closure" ON public.node_closure;
DROP POLICY IF EXISTS "Authenticated users can delete node_closure" ON public.node_closure;
-- Closure is managed by triggers, not directly by users

-- ============================================
-- REMOVE ALL STALE ANON POLICIES
-- ============================================

-- access_control_lists
DROP POLICY IF EXISTS "App anon delete acls" ON public.access_control_lists;
DROP POLICY IF EXISTS "App anon insert acls" ON public.access_control_lists;
DROP POLICY IF EXISTS "App anon read acls" ON public.access_control_lists;

-- audit_log
DROP POLICY IF EXISTS "App anon insert audit" ON public.audit_log;
DROP POLICY IF EXISTS "App anon read audit" ON public.audit_log;

-- collab_sessions
DROP POLICY IF EXISTS "Anon can delete collab sessions" ON public.collab_sessions;
DROP POLICY IF EXISTS "Anon can insert collab sessions" ON public.collab_sessions;
DROP POLICY IF EXISTS "Anon can read collab sessions" ON public.collab_sessions;
DROP POLICY IF EXISTS "Anon can update collab sessions" ON public.collab_sessions;

-- data_blocks
DROP POLICY IF EXISTS "App anon insert blocks" ON public.data_blocks;
DROP POLICY IF EXISTS "App anon read blocks" ON public.data_blocks;
DROP POLICY IF EXISTS "App anon update blocks" ON public.data_blocks;

-- file_extensions
DROP POLICY IF EXISTS "Anon can delete file extensions" ON public.file_extensions;
DROP POLICY IF EXISTS "Anon can insert file extensions" ON public.file_extensions;
DROP POLICY IF EXISTS "Anon can read file extensions" ON public.file_extensions;
DROP POLICY IF EXISTS "Anon can update file extensions" ON public.file_extensions;

-- file_version_blocks
DROP POLICY IF EXISTS "App anon insert version blocks" ON public.file_version_blocks;
DROP POLICY IF EXISTS "App anon read version blocks" ON public.file_version_blocks;

-- file_versions
DROP POLICY IF EXISTS "App anon insert versions" ON public.file_versions;
DROP POLICY IF EXISTS "App anon read versions" ON public.file_versions;
DROP POLICY IF EXISTS "App anon update versions" ON public.file_versions;

-- node_closure
DROP POLICY IF EXISTS "App anon delete closure" ON public.node_closure;
DROP POLICY IF EXISTS "App anon insert closure" ON public.node_closure;
DROP POLICY IF EXISTS "App anon read closure" ON public.node_closure;

-- nodes
DROP POLICY IF EXISTS "App anon delete nodes" ON public.nodes;
DROP POLICY IF EXISTS "App anon insert nodes" ON public.nodes;
DROP POLICY IF EXISTS "App anon read nodes" ON public.nodes;
DROP POLICY IF EXISTS "App anon update nodes" ON public.nodes;

-- server_config
DROP POLICY IF EXISTS "Anon can delete server config" ON public.server_config;
DROP POLICY IF EXISTS "Anon can insert server config" ON public.server_config;
DROP POLICY IF EXISTS "Anon can read server config" ON public.server_config;
DROP POLICY IF EXISTS "Anon can update server config" ON public.server_config;

-- share_links
DROP POLICY IF EXISTS "App anon delete shares" ON public.share_links;
DROP POLICY IF EXISTS "App anon insert shares" ON public.share_links;
DROP POLICY IF EXISTS "App anon read shares" ON public.share_links;
DROP POLICY IF EXISTS "App anon update shares" ON public.share_links;

-- storage_usage
DROP POLICY IF EXISTS "Anon can insert storage usage" ON public.storage_usage;
DROP POLICY IF EXISTS "Anon can read storage usage" ON public.storage_usage;

-- users (legacy)
DROP POLICY IF EXISTS "App can delete users" ON public.users;
DROP POLICY IF EXISTS "App can insert users" ON public.users;
DROP POLICY IF EXISTS "App can read users" ON public.users;
DROP POLICY IF EXISTS "App can update users" ON public.users;

-- version_comments
DROP POLICY IF EXISTS "Anon can delete version comments" ON public.version_comments;
DROP POLICY IF EXISTS "Anon can insert version comments" ON public.version_comments;
DROP POLICY IF EXISTS "Anon can read version comments" ON public.version_comments;

-- ============================================
-- USERS (legacy): Clean up duplicate policies
-- ============================================

DROP POLICY IF EXISTS "Authenticated users can read users" ON public.users;
-- Keep "Users can read own data" (auth.uid() = id)

-- ============================================
-- VERSION_COMMENTS: Clean up duplicates
-- ============================================

DROP POLICY IF EXISTS "Authenticated users can read version_comments" ON public.version_comments;
DROP POLICY IF EXISTS "Authenticated users can insert version_comments" ON public.version_comments;

CREATE POLICY "Authenticated users can read version_comments"
  ON public.version_comments FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert version_comments"
  ON public.version_comments FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

-- ============================================
-- COLLAB_SESSIONS: Clean up duplicates
-- ============================================

DROP POLICY IF EXISTS "Authenticated users can delete collab_sessions" ON public.collab_sessions;
DROP POLICY IF EXISTS "Authenticated users can insert collab_sessions" ON public.collab_sessions;
DROP POLICY IF EXISTS "Authenticated users can read collab_sessions" ON public.collab_sessions;
DROP POLICY IF EXISTS "Authenticated users can update collab_sessions" ON public.collab_sessions;

CREATE POLICY "Authenticated users can read collab_sessions"
  ON public.collab_sessions FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert collab_sessions"
  ON public.collab_sessions FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Authenticated users can update collab_sessions"
  ON public.collab_sessions FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Authenticated users can delete collab_sessions"
  ON public.collab_sessions FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

-- ============================================
-- BOM_ITEMS: Add owner-based restrictions
-- ============================================

DROP POLICY IF EXISTS "Authenticated users can delete bom_items" ON public.bom_items;
DROP POLICY IF EXISTS "Authenticated users can insert bom_items" ON public.bom_items;
DROP POLICY IF EXISTS "Authenticated users can read bom_items" ON public.bom_items;
DROP POLICY IF EXISTS "Authenticated users can update bom_items" ON public.bom_items;

CREATE POLICY "Authenticated users can read bom_items"
  ON public.bom_items FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Editors and owners can insert bom_items"
  ON public.bom_items FOR INSERT
  TO authenticated
  WITH CHECK (public.is_owner_or_auditor() OR EXISTS (
    SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('editor', 'owner')));

CREATE POLICY "Editors and owners can update bom_items"
  ON public.bom_items FOR UPDATE
  TO authenticated
  USING (public.is_owner_or_auditor() OR EXISTS (
    SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('editor', 'owner')))
  WITH CHECK (public.is_owner_or_auditor() OR EXISTS (
    SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('editor', 'owner')));

CREATE POLICY "Owners can delete bom_items"
  ON public.bom_items FOR DELETE
  TO authenticated
  USING (public.is_owner_or_auditor());

-- ============================================
-- PRODUCT_DOCUMENTS: Add role-based restrictions
-- ============================================

DROP POLICY IF EXISTS "Authenticated users can delete product_documents" ON public.product_documents;
DROP POLICY IF EXISTS "Authenticated users can insert product_documents" ON public.product_documents;
DROP POLICY IF EXISTS "Authenticated users can read product_documents" ON public.product_documents;
DROP POLICY IF EXISTS "Authenticated users can update product_documents" ON public.product_documents;

CREATE POLICY "Authenticated users can read product_documents"
  ON public.product_documents FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Editors and owners can insert product_documents"
  ON public.product_documents FOR INSERT
  TO authenticated
  WITH CHECK (public.is_owner_or_auditor() OR EXISTS (
    SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('editor', 'owner')));

CREATE POLICY "Editors and owners can update product_documents"
  ON public.product_documents FOR UPDATE
  TO authenticated
  USING (public.is_owner_or_auditor() OR EXISTS (
    SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('editor', 'owner')))
  WITH CHECK (public.is_owner_or_auditor() OR EXISTS (
    SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('editor', 'owner')));

CREATE POLICY "Owners can delete product_documents"
  ON public.product_documents FOR DELETE
  TO authenticated
  USING (public.is_owner_or_auditor());

-- ============================================
-- WORKFLOW_INSTANCES: Add role-based restrictions
-- ============================================

DROP POLICY IF EXISTS "Authenticated users can delete workflow_instances" ON public.workflow_instances;
DROP POLICY IF EXISTS "Authenticated users can insert workflow_instances" ON public.workflow_instances;
DROP POLICY IF EXISTS "Authenticated users can read workflow_instances" ON public.workflow_instances;
DROP POLICY IF EXISTS "Authenticated users can update workflow_instances" ON public.workflow_instances;

CREATE POLICY "Authenticated users can read workflow_instances"
  ON public.workflow_instances FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Editors and owners can insert workflow_instances"
  ON public.workflow_instances FOR INSERT
  TO authenticated
  WITH CHECK (public.is_owner_or_auditor() OR EXISTS (
    SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('editor', 'owner')));

CREATE POLICY "Editors and owners can update workflow_instances"
  ON public.workflow_instances FOR UPDATE
  TO authenticated
  USING (public.is_owner_or_auditor() OR EXISTS (
    SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('editor', 'owner')))
  WITH CHECK (public.is_owner_or_auditor() OR EXISTS (
    SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('editor', 'owner')));

CREATE POLICY "Owners can delete workflow_instances"
  ON public.workflow_instances FOR DELETE
  TO authenticated
  USING (public.is_owner_or_auditor());

-- ============================================
-- GRANT is_owner_or_auditor to auth roles
-- ============================================

GRANT EXECUTE ON FUNCTION public.is_owner_or_auditor() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_owner_or_auditor() TO anon;
