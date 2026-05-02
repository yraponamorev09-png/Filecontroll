/*
  # PHASE 1: Authentication & Security Foundation

  1. New Tables
    - `user_profiles`: Links auth.users to app-level profile data
    - `user_sessions`: Track active sessions for revocation
    - `auth_rate_limits`: Rate limiting for auth endpoints

  2. Security
    - Replace all anon RLS policies with authenticated policies
    - Add owner-based policies using auth.uid()

  3. Helper Functions
    - get_current_user_id()
    - check_rate_limit()
    - cleanup_expired_sessions()
    - handle_new_user() trigger
*/

-- ============================================
-- USER PROFILES TABLE
-- ============================================

CREATE TABLE IF NOT EXISTS public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text UNIQUE NOT NULL,
  full_name text DEFAULT '',
  role text NOT NULL DEFAULT 'viewer',
  totp_secret text,
  totp_enabled boolean DEFAULT false,
  last_login_at timestamptz,
  login_attempts integer DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own profile"
  ON public.user_profiles FOR SELECT
  TO authenticated
  USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
  ON public.user_profiles FOR UPDATE
  TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

CREATE POLICY "Owners can read all profiles"
  ON public.user_profiles FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.role IN ('owner', 'auditor')
    )
  );

CREATE POLICY "Users can insert own profile"
  ON public.user_profiles FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = id);

CREATE POLICY "Service role full access on user_profiles"
  ON public.user_profiles FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================
-- USER SESSIONS TABLE
-- ============================================

CREATE TABLE IF NOT EXISTS public.user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_token_hash text NOT NULL,
  device_info text DEFAULT '',
  ip_address text DEFAULT '',
  is_active boolean DEFAULT true,
  expires_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.user_sessions ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON public.user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON public.user_sessions(session_token_hash);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON public.user_sessions(expires_at);

CREATE POLICY "Users can read own sessions"
  ON public.user_sessions FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own sessions"
  ON public.user_sessions FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Service role full access on user_sessions"
  ON public.user_sessions FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================
-- AUTH RATE LIMITS TABLE
-- ============================================

CREATE TABLE IF NOT EXISTS public.auth_rate_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier text NOT NULL,
  action text NOT NULL,
  attempt_count integer DEFAULT 1,
  window_start timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.auth_rate_limits ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_lookup
  ON public.auth_rate_limits(identifier, action, window_start);

CREATE POLICY "Service role full access on auth_rate_limits"
  ON public.auth_rate_limits FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================
-- HELPER FUNCTIONS
-- ============================================

CREATE OR REPLACE FUNCTION public.get_current_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.check_rate_limit(
  p_identifier text,
  p_action text,
  p_max_attempts integer DEFAULT 5,
  p_window_seconds integer DEFAULT 300
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer;
  v_window_start timestamptz;
BEGIN
  v_window_start := now() - (p_window_seconds || ' seconds')::interval;

  SELECT COALESCE(SUM(attempt_count), 0) INTO v_count
  FROM public.auth_rate_limits
  WHERE identifier = p_identifier
    AND action = p_action
    AND window_start > v_window_start;

  DELETE FROM public.auth_rate_limits
  WHERE identifier = p_identifier
    AND action = p_action
    AND window_start <= v_window_start;

  IF v_count >= p_max_attempts THEN
    RETURN false;
  END IF;

  INSERT INTO public.auth_rate_limits (identifier, action, attempt_count, window_start)
  VALUES (p_identifier, p_action, 1, now());

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.cleanup_expired_sessions()
RETURNS integer
LANGUAGE sql
AS $$
  DELETE FROM public.user_sessions
  WHERE expires_at < now() OR is_active = false
  RETURNING 1;
$$;

-- ============================================
-- AUTO-CREATE PROFILE ON SIGNUP
-- ============================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.user_profiles (id, email, full_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'role', 'viewer')
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- ============================================
-- REPLACE ANON RLS WITH AUTHENTICATED RLS
-- ============================================

-- NODES
DROP POLICY IF EXISTS "Anon can read nodes" ON public.nodes;
DROP POLICY IF EXISTS "Anon can insert nodes" ON public.nodes;
DROP POLICY IF EXISTS "Anon can update nodes" ON public.nodes;
DROP POLICY IF EXISTS "Anon can delete nodes" ON public.nodes;

CREATE POLICY "Authenticated users can read nodes"
  ON public.nodes FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can insert nodes"
  ON public.nodes FOR INSERT TO authenticated WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "Owners can update their nodes"
  ON public.nodes FOR UPDATE TO authenticated USING (auth.uid() = owner_id) WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "Owners can delete their nodes"
  ON public.nodes FOR DELETE TO authenticated USING (auth.uid() = owner_id);
CREATE POLICY "Service role full access on nodes"
  ON public.nodes FOR ALL TO service_role USING (true) WITH CHECK (true);

-- FILE_VERSIONS
DROP POLICY IF EXISTS "Anon can read file_versions" ON public.file_versions;
DROP POLICY IF EXISTS "Anon can insert file_versions" ON public.file_versions;
DROP POLICY IF EXISTS "Anon can update file_versions" ON public.file_versions;
DROP POLICY IF EXISTS "Anon can delete file_versions" ON public.file_versions;

CREATE POLICY "Authenticated users can read file_versions"
  ON public.file_versions FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert file_versions"
  ON public.file_versions FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update file_versions"
  ON public.file_versions FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access on file_versions"
  ON public.file_versions FOR ALL TO service_role USING (true) WITH CHECK (true);

-- DATA_BLOCKS
DROP POLICY IF EXISTS "Anon can read data_blocks" ON public.data_blocks;
DROP POLICY IF EXISTS "Anon can insert data_blocks" ON public.data_blocks;
DROP POLICY IF EXISTS "Anon can update data_blocks" ON public.data_blocks;
DROP POLICY IF EXISTS "Anon can delete data_blocks" ON public.data_blocks;

CREATE POLICY "Authenticated users can read data_blocks"
  ON public.data_blocks FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert data_blocks"
  ON public.data_blocks FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update data_blocks"
  ON public.data_blocks FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access on data_blocks"
  ON public.data_blocks FOR ALL TO service_role USING (true) WITH CHECK (true);

-- FILE_VERSION_BLOCKS
DROP POLICY IF EXISTS "Anon can read file_version_blocks" ON public.file_version_blocks;
DROP POLICY IF EXISTS "Anon can insert file_version_blocks" ON public.file_version_blocks;
DROP POLICY IF EXISTS "Anon can update file_version_blocks" ON public.file_version_blocks;
DROP POLICY IF EXISTS "Anon can delete file_version_blocks" ON public.file_version_blocks;

CREATE POLICY "Authenticated users can read file_version_blocks"
  ON public.file_version_blocks FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert file_version_blocks"
  ON public.file_version_blocks FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Service role full access on file_version_blocks"
  ON public.file_version_blocks FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ACCESS_CONTROL_LISTS
DROP POLICY IF EXISTS "Anon can read access_control_lists" ON public.access_control_lists;
DROP POLICY IF EXISTS "Anon can insert access_control_lists" ON public.access_control_lists;
DROP POLICY IF EXISTS "Anon can update access_control_lists" ON public.access_control_lists;
DROP POLICY IF EXISTS "Anon can delete access_control_lists" ON public.access_control_lists;

CREATE POLICY "Authenticated users can read ACLs"
  ON public.access_control_lists FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert ACLs"
  ON public.access_control_lists FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update ACLs"
  ON public.access_control_lists FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete ACLs"
  ON public.access_control_lists FOR DELETE TO authenticated USING (true);
CREATE POLICY "Service role full access on access_control_lists"
  ON public.access_control_lists FOR ALL TO service_role USING (true) WITH CHECK (true);

-- SHARE_LINKS
DROP POLICY IF EXISTS "Anon can read share_links" ON public.share_links;
DROP POLICY IF EXISTS "Anon can insert share_links" ON public.share_links;
DROP POLICY IF EXISTS "Anon can update share_links" ON public.share_links;
DROP POLICY IF EXISTS "Anon can delete share_links" ON public.share_links;

CREATE POLICY "Authenticated users can read share_links"
  ON public.share_links FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert share_links"
  ON public.share_links FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update share_links"
  ON public.share_links FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete share_links"
  ON public.share_links FOR DELETE TO authenticated USING (true);
CREATE POLICY "Service role full access on share_links"
  ON public.share_links FOR ALL TO service_role USING (true) WITH CHECK (true);

-- AUDIT_LOG
DROP POLICY IF EXISTS "Anon can read audit_log" ON public.audit_log;
DROP POLICY IF EXISTS "Anon can insert audit_log" ON public.audit_log;
DROP POLICY IF EXISTS "Anon can update audit_log" ON public.audit_log;
DROP POLICY IF EXISTS "Anon can delete audit_log" ON public.audit_log;

CREATE POLICY "Authenticated users can read audit_log"
  ON public.audit_log FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert audit_log"
  ON public.audit_log FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Service role full access on audit_log"
  ON public.audit_log FOR ALL TO service_role USING (true) WITH CHECK (true);

-- NODE_CLOSURE
DROP POLICY IF EXISTS "Anon can read node_closure" ON public.node_closure;
DROP POLICY IF EXISTS "Anon can insert node_closure" ON public.node_closure;
DROP POLICY IF EXISTS "Anon can delete node_closure" ON public.node_closure;

CREATE POLICY "Authenticated users can read node_closure"
  ON public.node_closure FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert node_closure"
  ON public.node_closure FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can delete node_closure"
  ON public.node_closure FOR DELETE TO authenticated USING (true);

-- USERS (legacy)
DROP POLICY IF EXISTS "Anon can read users" ON public.users;
DROP POLICY IF EXISTS "Anon can insert users" ON public.users;
DROP POLICY IF EXISTS "Anon can update users" ON public.users;
DROP POLICY IF EXISTS "Anon can delete users" ON public.users;

CREATE POLICY "Authenticated users can read users"
  ON public.users FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role full access on users"
  ON public.users FOR ALL TO service_role USING (true) WITH CHECK (true);

-- VERSION_COMMENTS
DROP POLICY IF EXISTS "Anon can read version_comments" ON public.version_comments;
DROP POLICY IF EXISTS "Anon can insert version_comments" ON public.version_comments;
DROP POLICY IF EXISTS "Anon can update version_comments" ON public.version_comments;
DROP POLICY IF EXISTS "Anon can delete version_comments" ON public.version_comments;

CREATE POLICY "Authenticated users can read version_comments"
  ON public.version_comments FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert version_comments"
  ON public.version_comments FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Service role full access on version_comments"
  ON public.version_comments FOR ALL TO service_role USING (true) WITH CHECK (true);

-- SERVER_CONFIG
DROP POLICY IF EXISTS "Anon can read server_config" ON public.server_config;
DROP POLICY IF EXISTS "Anon can insert server_config" ON public.server_config;
DROP POLICY IF EXISTS "Anon can update server_config" ON public.server_config;
DROP POLICY IF EXISTS "Anon can delete server_config" ON public.server_config;

CREATE POLICY "Authenticated users can read server_config"
  ON public.server_config FOR SELECT TO authenticated USING (true);
CREATE POLICY "Owners can update server_config"
  ON public.server_config FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles up WHERE up.id = auth.uid() AND up.role = 'owner'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles up WHERE up.id = auth.uid() AND up.role = 'owner'));
CREATE POLICY "Service role full access on server_config"
  ON public.server_config FOR ALL TO service_role USING (true) WITH CHECK (true);

-- CONNECTION_CONFIG
DROP POLICY IF EXISTS "Anon can read connection_config" ON public.connection_config;
DROP POLICY IF EXISTS "Anon can insert connection_config" ON public.connection_config;
DROP POLICY IF EXISTS "Anon can update connection_config" ON public.connection_config;
DROP POLICY IF EXISTS "Anon can delete connection_config" ON public.connection_config;

CREATE POLICY "Authenticated users can read connection_config"
  ON public.connection_config FOR SELECT TO authenticated USING (true);
CREATE POLICY "Owners can update connection_config"
  ON public.connection_config FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles up WHERE up.id = auth.uid() AND up.role = 'owner'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles up WHERE up.id = auth.uid() AND up.role = 'owner'));
CREATE POLICY "Service role full access on connection_config"
  ON public.connection_config FOR ALL TO service_role USING (true) WITH CHECK (true);

-- FILE_EXTENSIONS
DROP POLICY IF EXISTS "Anon can read file_extensions" ON public.file_extensions;
DROP POLICY IF EXISTS "Anon can insert file_extensions" ON public.file_extensions;
DROP POLICY IF EXISTS "Anon can update file_extensions" ON public.file_extensions;
DROP POLICY IF EXISTS "Anon can delete file_extensions" ON public.file_extensions;

CREATE POLICY "Authenticated users can read file_extensions"
  ON public.file_extensions FOR SELECT TO authenticated USING (true);
CREATE POLICY "Owners can manage file_extensions"
  ON public.file_extensions FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles up WHERE up.id = auth.uid() AND up.role = 'owner'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles up WHERE up.id = auth.uid() AND up.role = 'owner'));
CREATE POLICY "Service role full access on file_extensions"
  ON public.file_extensions FOR ALL TO service_role USING (true) WITH CHECK (true);

-- COLLAB_SESSIONS
DROP POLICY IF EXISTS "Anon can read collab_sessions" ON public.collab_sessions;
DROP POLICY IF EXISTS "Anon can insert collab_sessions" ON public.collab_sessions;
DROP POLICY IF EXISTS "Anon can update collab_sessions" ON public.collab_sessions;
DROP POLICY IF EXISTS "Anon can delete collab_sessions" ON public.collab_sessions;

CREATE POLICY "Authenticated users can read collab_sessions"
  ON public.collab_sessions FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert collab_sessions"
  ON public.collab_sessions FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update collab_sessions"
  ON public.collab_sessions FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete collab_sessions"
  ON public.collab_sessions FOR DELETE TO authenticated USING (true);

-- STORAGE_USAGE
DROP POLICY IF EXISTS "Anon can read storage_usage" ON public.storage_usage;
DROP POLICY IF EXISTS "Anon can insert storage_usage" ON public.storage_usage;
DROP POLICY IF EXISTS "Anon can update storage_usage" ON public.storage_usage;
DROP POLICY IF EXISTS "Anon can delete storage_usage" ON public.storage_usage;

CREATE POLICY "Authenticated users can read storage_usage"
  ON public.storage_usage FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role full access on storage_usage"
  ON public.storage_usage FOR ALL TO service_role USING (true) WITH CHECK (true);

-- PRODUCTS
DROP POLICY IF EXISTS "Anon can read products" ON public.products;
DROP POLICY IF EXISTS "Anon can insert products" ON public.products;
DROP POLICY IF EXISTS "Anon can update products" ON public.products;
DROP POLICY IF EXISTS "Anon can delete products" ON public.products;

CREATE POLICY "Authenticated users can read products"
  ON public.products FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert products"
  ON public.products FOR INSERT TO authenticated WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "Owners can update their products"
  ON public.products FOR UPDATE TO authenticated USING (auth.uid() = owner_id) WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "Owners can delete their products"
  ON public.products FOR DELETE TO authenticated USING (auth.uid() = owner_id);
CREATE POLICY "Service role full access on products"
  ON public.products FOR ALL TO service_role USING (true) WITH CHECK (true);

-- PRODUCT_DOCUMENTS
DROP POLICY IF EXISTS "Anon can read product_documents" ON public.product_documents;
DROP POLICY IF EXISTS "Anon can insert product_documents" ON public.product_documents;
DROP POLICY IF EXISTS "Anon can update product_documents" ON public.product_documents;
DROP POLICY IF EXISTS "Anon can delete product_documents" ON public.product_documents;

CREATE POLICY "Authenticated users can read product_documents"
  ON public.product_documents FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert product_documents"
  ON public.product_documents FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update product_documents"
  ON public.product_documents FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete product_documents"
  ON public.product_documents FOR DELETE TO authenticated USING (true);
CREATE POLICY "Service role full access on product_documents"
  ON public.product_documents FOR ALL TO service_role USING (true) WITH CHECK (true);

-- BOM_ITEMS
DROP POLICY IF EXISTS "Anon can read bom_items" ON public.bom_items;
DROP POLICY IF EXISTS "Anon can insert bom_items" ON public.bom_items;
DROP POLICY IF EXISTS "Anon can update bom_items" ON public.bom_items;
DROP POLICY IF EXISTS "Anon can delete bom_items" ON public.bom_items;

CREATE POLICY "Authenticated users can read bom_items"
  ON public.bom_items FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert bom_items"
  ON public.bom_items FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update bom_items"
  ON public.bom_items FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete bom_items"
  ON public.bom_items FOR DELETE TO authenticated USING (true);
CREATE POLICY "Service role full access on bom_items"
  ON public.bom_items FOR ALL TO service_role USING (true) WITH CHECK (true);

-- WORKFLOW_STAGES
DROP POLICY IF EXISTS "Anon can read workflow_stages" ON public.workflow_stages;
DROP POLICY IF EXISTS "Anon can insert workflow_stages" ON public.workflow_stages;
DROP POLICY IF EXISTS "Anon can update workflow_stages" ON public.workflow_stages;
DROP POLICY IF EXISTS "Anon can delete workflow_stages" ON public.workflow_stages;

CREATE POLICY "Authenticated users can read workflow_stages"
  ON public.workflow_stages FOR SELECT TO authenticated USING (true);
CREATE POLICY "Owners can manage workflow_stages"
  ON public.workflow_stages FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles up WHERE up.id = auth.uid() AND up.role = 'owner'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles up WHERE up.id = auth.uid() AND up.role = 'owner'));
CREATE POLICY "Service role full access on workflow_stages"
  ON public.workflow_stages FOR ALL TO service_role USING (true) WITH CHECK (true);

-- WORKFLOW_INSTANCES
DROP POLICY IF EXISTS "Anon can read workflow_instances" ON public.workflow_instances;
DROP POLICY IF EXISTS "Anon can insert workflow_instances" ON public.workflow_instances;
DROP POLICY IF EXISTS "Anon can update workflow_instances" ON public.workflow_instances;
DROP POLICY IF EXISTS "Anon can delete workflow_instances" ON public.workflow_instances;

CREATE POLICY "Authenticated users can read workflow_instances"
  ON public.workflow_instances FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert workflow_instances"
  ON public.workflow_instances FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update workflow_instances"
  ON public.workflow_instances FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete workflow_instances"
  ON public.workflow_instances FOR DELETE TO authenticated USING (true);
CREATE POLICY "Service role full access on workflow_instances"
  ON public.workflow_instances FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================
-- MIGRATE EXISTING USERS TO AUTH
-- ============================================

DO $$
DECLARE
  u RECORD;
BEGIN
  FOR u IN SELECT * FROM public.users LOOP
    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = u.id) THEN
      INSERT INTO auth.users (
        id, instance_id, aud, role, email,
        encrypted_password, email_confirmed_at,
        created_at, updated_at
      ) VALUES (
        u.id,
        '00000000-0000-0000-0000-000000000000',
        'authenticated',
        'authenticated',
        COALESCE(u.username, 'admin') || '@vault-plm.local',
        crypt('changeme', gen_salt('bf')),
        now(),
        u.created_at,
        COALESCE(u.updated_at, now())
      );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.user_profiles WHERE id = u.id) THEN
      INSERT INTO public.user_profiles (id, email, full_name, role, created_at, updated_at)
      VALUES (
        u.id,
        COALESCE(u.username, 'admin') || '@vault-plm.local',
        COALESCE(u.username, 'admin'),
        COALESCE(u.role, 'owner'),
        u.created_at,
        COALESCE(u.updated_at, now())
      );
    END IF;
  END LOOP;
END $$;
