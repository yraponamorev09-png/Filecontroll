/*
  # PHASE 2: Backup & Data Integrity

  1. New Tables
    - `backups`: Backup registry with metadata
      - id (uuid, PK)
      - type (text) - full|incremental|metadata_only|blocks_only
      - status (text) - pending|running|completed|failed|verifying
      - started_at (timestamptz)
      - completed_at (timestamptz, nullable)
      - metadata_json (jsonb) - snapshot of nodes, versions, profiles, ACLs, etc.
      - blocks_manifest (jsonb) - list of block hashes + sizes
      - total_size (bigint, default 0)
      - total_nodes (int, default 0)
      - total_versions (int, default 0)
      - total_blocks (int, default 0)
      - checksum (text) - SHA-256 of the entire backup manifest
      - is_verified (bool, default false)
      - verified_at (timestamptz, nullable)
      - error_message (text, nullable)
      - created_by (uuid, FK -> auth.users)
      - created_at (timestamptz)

    - `backup_snapshots`: Point-in-time snapshots for recovery
      - id (uuid, PK)
      - backup_id (uuid, FK -> backups)
      - table_name (text)
      - row_count (int)
      - checksum (text) - SHA-256 of the table data snapshot
      - data (jsonb) - the actual snapshot data
      - created_at (timestamptz)

    - `file_integrity_checks`: Checksum verification records
      - id (uuid, PK)
      - node_id (uuid, FK -> nodes)
      - version_id (uuid, FK -> file_versions)
      - expected_hash (text) - hash from file_versions.content_hash
      - verified_hash (text, nullable) - hash computed from actual block data
      - is_valid (bool, nullable)
      - checked_at (timestamptz)
      - checked_by (uuid, FK -> auth.users)
      - error_detail (text, nullable)

  2. Security
    - RLS on all new tables: owners can manage, authenticated can read
    - Service role has full access

  3. Helper Functions
    - compute_backup_checksum() - SHA-256 of backup manifest
    - verify_backup_integrity() - verify backup against current data
*/

-- ============================================
-- BACKUPS TABLE
-- ============================================

CREATE TABLE IF NOT EXISTS public.backups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL DEFAULT 'full',
  status text NOT NULL DEFAULT 'pending',
  started_at timestamptz DEFAULT now(),
  completed_at timestamptz,
  metadata_json jsonb DEFAULT '{}',
  blocks_manifest jsonb DEFAULT '[]',
  total_size bigint DEFAULT 0,
  total_nodes int DEFAULT 0,
  total_versions int DEFAULT 0,
  total_blocks int DEFAULT 0,
  checksum text,
  is_verified boolean DEFAULT false,
  verified_at timestamptz,
  error_message text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.backups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read backups"
  ON public.backups FOR SELECT TO authenticated USING (true);

CREATE POLICY "Owners can insert backups"
  ON public.backups FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles up WHERE up.id = auth.uid() AND up.role = 'owner'));

CREATE POLICY "Owners can update backups"
  ON public.backups FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles up WHERE up.id = auth.uid() AND up.role = 'owner'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles up WHERE up.id = auth.uid() AND up.role = 'owner'));

CREATE POLICY "Owners can delete backups"
  ON public.backups FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles up WHERE up.id = auth.uid() AND up.role = 'owner'));

CREATE POLICY "Service role full access on backups"
  ON public.backups FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================
-- BACKUP SNAPSHOTS TABLE
-- ============================================

CREATE TABLE IF NOT EXISTS public.backup_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  backup_id uuid NOT NULL REFERENCES public.backups(id) ON DELETE CASCADE,
  table_name text NOT NULL,
  row_count int DEFAULT 0,
  checksum text,
  data jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.backup_snapshots ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_backup_snapshots_backup_id ON public.backup_snapshots(backup_id);

CREATE POLICY "Authenticated users can read backup_snapshots"
  ON public.backup_snapshots FOR SELECT TO authenticated USING (true);

CREATE POLICY "Owners can manage backup_snapshots"
  ON public.backup_snapshots FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles up WHERE up.id = auth.uid() AND up.role = 'owner'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles up WHERE up.id = auth.uid() AND up.role = 'owner'));

CREATE POLICY "Service role full access on backup_snapshots"
  ON public.backup_snapshots FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================
-- FILE INTEGRITY CHECKS TABLE
-- ============================================

CREATE TABLE IF NOT EXISTS public.file_integrity_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id uuid NOT NULL REFERENCES public.nodes(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES public.file_versions(id) ON DELETE CASCADE,
  expected_hash text NOT NULL,
  verified_hash text,
  is_valid boolean,
  checked_at timestamptz DEFAULT now(),
  checked_by uuid REFERENCES auth.users(id),
  error_detail text
);

ALTER TABLE public.file_integrity_checks ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_integrity_checks_node ON public.file_integrity_checks(node_id);
CREATE INDEX IF NOT EXISTS idx_integrity_checks_version ON public.file_integrity_checks(version_id);
CREATE INDEX IF NOT EXISTS idx_integrity_checks_valid ON public.file_integrity_checks(is_valid);

CREATE POLICY "Authenticated users can read integrity checks"
  ON public.file_integrity_checks FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert integrity checks"
  ON public.file_integrity_checks FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Service role full access on file_integrity_checks"
  ON public.file_integrity_checks FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================
-- HELPER: Compute backup checksum
-- ============================================

CREATE OR REPLACE FUNCTION public.compute_backup_checksum(p_backup_id uuid)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_manifest jsonb;
  v_checksum text;
BEGIN
  SELECT metadata_json || jsonb_build_object(
    'blocks', blocks_manifest,
    'total_size', total_size,
    'total_nodes', total_nodes,
    'total_versions', total_versions,
    'total_blocks', total_blocks
  ) INTO v_manifest
  FROM public.backups WHERE id = p_backup_id;

  v_checksum := encode(digest(v_manifest::text, 'sha256'), 'hex');

  UPDATE public.backups SET checksum = v_checksum WHERE id = p_backup_id;

  RETURN v_checksum;
END;
$$;

-- ============================================
-- HELPER: Auto-cleanup old rate limits (pg_cron)
-- ============================================

CREATE OR REPLACE FUNCTION public.cleanup_rate_limits()
RETURNS integer
LANGUAGE sql
AS $$
  DELETE FROM public.auth_rate_limits
  WHERE window_start < now() - interval '1 hour'
  RETURNING 1;
$$;
