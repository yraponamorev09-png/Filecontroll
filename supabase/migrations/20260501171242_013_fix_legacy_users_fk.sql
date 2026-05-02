/*
  # Fix Legacy Users Table and Orphaned Records

  Strategy: Drop FKs first, then update IDs, then recreate FKs pointing to auth.users
*/

-- ============================================
-- STEP 1: Drop all FK constraints referencing public.users
-- ============================================

ALTER TABLE public.nodes DROP CONSTRAINT IF EXISTS nodes_owner_id_fkey;
ALTER TABLE public.file_versions DROP CONSTRAINT IF EXISTS file_versions_created_by_fkey;
ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_owner_id_fkey;
ALTER TABLE public.access_control_lists DROP CONSTRAINT IF EXISTS access_control_lists_user_id_fkey;
ALTER TABLE public.access_control_lists DROP CONSTRAINT IF EXISTS access_control_lists_granted_by_fkey;
ALTER TABLE public.share_links DROP CONSTRAINT IF EXISTS share_links_created_by_fkey;
ALTER TABLE public.audit_log DROP CONSTRAINT IF EXISTS audit_log_user_id_fkey;
ALTER TABLE public.version_comments DROP CONSTRAINT IF EXISTS version_comments_user_id_fkey;
ALTER TABLE public.server_config DROP CONSTRAINT IF EXISTS server_config_updated_by_fkey;
ALTER TABLE public.collab_sessions DROP CONSTRAINT IF EXISTS collab_sessions_user_id_fkey;
ALTER TABLE public.product_documents DROP CONSTRAINT IF EXISTS product_documents_created_by_fkey;
ALTER TABLE public.workflow_instances DROP CONSTRAINT IF EXISTS workflow_instances_assigned_to_fkey;
ALTER TABLE public.connection_config DROP CONSTRAINT IF EXISTS connection_config_updated_by_fkey;

-- ============================================
-- STEP 2: Update old user IDs to new auth.user IDs
-- ============================================

-- Map old admin (213cfa9a) -> new admin (3d41db61)
UPDATE public.users SET id = '3d41db61-1bd3-4094-8f66-919ca7f950ca'
WHERE id = '213cfa9a-6f2f-42c5-b1c8-3a7790faf860';

-- Map old 1212 user (a4f9f4e6) -> auditor (8c6406bd)
UPDATE public.users SET id = '8c6406bd-b2ab-4b11-bafa-561a55c2447b',
  username = 'auditor', role = 'auditor'
WHERE id = 'a4f9f4e6-b486-44e7-9269-c543e4d1cdae';

-- ============================================
-- STEP 3: Update all referencing columns to new IDs
-- ============================================

-- nodes.owner_id
UPDATE public.nodes SET owner_id = '3d41db61-1bd3-4094-8f66-919ca7f950ca'
WHERE owner_id = '213cfa9a-6f2f-42c5-b1c8-3a7790faf860';
UPDATE public.nodes SET owner_id = '8c6406bd-b2ab-4b11-bafa-561a55c2447b'
WHERE owner_id = 'a4f9f4e6-b486-44e7-9269-c543e4d1cdae';

-- products.owner_id
UPDATE public.products SET owner_id = '3d41db61-1bd3-4094-8f66-919ca7f950ca'
WHERE owner_id = '213cfa9a-6f2f-42c5-b1c8-3a7790faf860';
UPDATE public.products SET owner_id = '8c6406bd-b2ab-4b11-bafa-561a55c2447b'
WHERE owner_id = 'a4f9f4e6-b486-44e7-9269-c543e4d1cdae';

-- file_versions.created_by
UPDATE public.file_versions SET created_by = '3d41db61-1bd3-4094-8f66-919ca7f950ca'
WHERE created_by = '213cfa9a-6f2f-42c5-b1c8-3a7790faf860';
UPDATE public.file_versions SET created_by = '8c6406bd-b2ab-4b11-bafa-561a55c2447b'
WHERE created_by = 'a4f9f4e6-b486-44e7-9269-c543e4d1cdae';

-- access_control_lists.user_id
UPDATE public.access_control_lists SET user_id = '3d41db61-1bd3-4094-8f66-919ca7f950ca'
WHERE user_id = '213cfa9a-6f2f-42c5-b1c8-3a7790faf860';
UPDATE public.access_control_lists SET user_id = '8c6406bd-b2ab-4b11-bafa-561a55c2447b'
WHERE user_id = 'a4f9f4e6-b486-44e7-9269-c543e4d1cdae';

-- access_control_lists.granted_by
UPDATE public.access_control_lists SET granted_by = '3d41db61-1bd3-4094-8f66-919ca7f950ca'
WHERE granted_by = '213cfa9a-6f2f-42c5-b1c8-3a7790faf860';
UPDATE public.access_control_lists SET granted_by = '8c6406bd-b2ab-4b11-bafa-561a55c2447b'
WHERE granted_by = 'a4f9f4e6-b486-44e7-9269-c543e4d1cdae';

-- share_links.created_by
UPDATE public.share_links SET created_by = '3d41db61-1bd3-4094-8f66-919ca7f950ca'
WHERE created_by = '213cfa9a-6f2f-42c5-b1c8-3a7790faf860';
UPDATE public.share_links SET created_by = '8c6406bd-b2ab-4b11-bafa-561a55c2447b'
WHERE created_by = 'a4f9f4e6-b486-44e7-9269-c543e4d1cdae';

-- audit_log.user_id
UPDATE public.audit_log SET user_id = '3d41db61-1bd3-4094-8f66-919ca7f950ca'
WHERE user_id = '213cfa9a-6f2f-42c5-b1c8-3a7790faf860';
UPDATE public.audit_log SET user_id = '8c6406bd-b2ab-4b11-bafa-561a55c2447b'
WHERE user_id = 'a4f9f4e6-b486-44e7-9269-c543e4d1cdae';

-- version_comments.user_id
UPDATE public.version_comments SET user_id = '3d41db61-1bd3-4094-8f66-919ca7f950ca'
WHERE user_id = '213cfa9a-6f2f-42c5-b1c8-3a7790faf860';
UPDATE public.version_comments SET user_id = '8c6406bd-b2ab-4b11-bafa-561a55c2447b'
WHERE user_id = 'a4f9f4e6-b486-44e7-9269-c543e4d1cdae';

-- server_config.updated_by
UPDATE public.server_config SET updated_by = '3d41db61-1bd3-4094-8f66-919ca7f950ca'
WHERE updated_by = '213cfa9a-6f2f-42c5-b1c8-3a7790faf860';
UPDATE public.server_config SET updated_by = '8c6406bd-b2ab-4b11-bafa-561a55c2447b'
WHERE updated_by = 'a4f9f4e6-b486-44e7-9269-c543e4d1cdae';

-- collab_sessions.user_id
UPDATE public.collab_sessions SET user_id = '3d41db61-1bd3-4094-8f66-919ca7f950ca'
WHERE user_id = '213cfa9a-6f2f-42c5-b1c8-3a7790faf860';
UPDATE public.collab_sessions SET user_id = '8c6406bd-b2ab-4b11-bafa-561a55c2447b'
WHERE user_id = 'a4f9f4e6-b486-44e7-9269-c543e4d1cdae';

-- product_documents.created_by
UPDATE public.product_documents SET created_by = '3d41db61-1bd3-4094-8f66-919ca7f950ca'
WHERE created_by = '213cfa9a-6f2f-42c5-b1c8-3a7790faf860';
UPDATE public.product_documents SET created_by = '8c6406bd-b2ab-4b11-bafa-561a55c2447b'
WHERE created_by = 'a4f9f4e6-b486-44e7-9269-c543e4d1cdae';

-- workflow_instances.assigned_to
UPDATE public.workflow_instances SET assigned_to = '3d41db61-1bd3-4094-8f66-919ca7f950ca'
WHERE assigned_to = '213cfa9a-6f2f-42c5-b1c8-3a7790faf860';
UPDATE public.workflow_instances SET assigned_to = '8c6406bd-b2ab-4b11-bafa-561a55c2447b'
WHERE assigned_to = 'a4f9f4e6-b486-44e7-9269-c543e4d1cdae';

-- connection_config.updated_by
UPDATE public.connection_config SET updated_by = '3d41db61-1bd3-4094-8f66-919ca7f950ca'
WHERE updated_by = '213cfa9a-6f2f-42c5-b1c8-3a7790faf860';
UPDATE public.connection_config SET updated_by = '8c6406bd-b2ab-4b11-bafa-561a55c2447b'
WHERE updated_by = 'a4f9f4e6-b486-44e7-9269-c543e4d1cdae';

-- ============================================
-- STEP 4: Add remaining auth users to public.users
-- ============================================

INSERT INTO public.users (id, username, password_hash, role, created_at, updated_at)
SELECT 
  u.id,
  split_part(u.email, '@', 1),
  '$argon2id$migrated',
  COALESCE(up.role, 'viewer'),
  u.created_at,
  COALESCE(u.updated_at, u.created_at)
FROM auth.users u
LEFT JOIN public.user_profiles up ON up.id = u.id
WHERE NOT EXISTS (SELECT 1 FROM public.users pu WHERE pu.id = u.id)
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- STEP 5: Recreate FK constraints referencing auth.users
-- ============================================

ALTER TABLE public.nodes ADD CONSTRAINT nodes_owner_id_fkey
  FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.file_versions ADD CONSTRAINT file_versions_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.products ADD CONSTRAINT products_owner_id_fkey
  FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.access_control_lists ADD CONSTRAINT access_control_lists_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.access_control_lists ADD CONSTRAINT access_control_lists_granted_by_fkey
  FOREIGN KEY (granted_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.share_links ADD CONSTRAINT share_links_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.audit_log ADD CONSTRAINT audit_log_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.version_comments ADD CONSTRAINT version_comments_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.server_config ADD CONSTRAINT server_config_updated_by_fkey
  FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.collab_sessions ADD CONSTRAINT collab_sessions_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.product_documents ADD CONSTRAINT product_documents_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.workflow_instances ADD CONSTRAINT workflow_instances_assigned_to_fkey
  FOREIGN KEY (assigned_to) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.connection_config ADD CONSTRAINT connection_config_updated_by_fkey
  FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL;

-- ============================================
-- STEP 6: Clean up stale users from public.users
-- ============================================

DELETE FROM public.users WHERE id NOT IN (SELECT id FROM auth.users);
