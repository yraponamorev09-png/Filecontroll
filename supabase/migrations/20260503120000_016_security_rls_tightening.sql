/*
  # Security: tighten RLS after audit

  - connection_config: no longer readable by every authenticated user (API keys / URLs).
  - backups / backup_snapshots: users see only their backups; owners/auditors see all.
  - file_integrity_checks: read own checks or staff; insert must set checked_by = auth.uid().
*/

-- CONNECTION_CONFIG: sensitive keys
DROP POLICY IF EXISTS "Authenticated users can read connection_config" ON public.connection_config;

CREATE POLICY "Owners and auditors can read connection_config"
  ON public.connection_config FOR SELECT TO authenticated
  USING (public.is_owner_or_auditor());

-- BACKUPS
DROP POLICY IF EXISTS "Authenticated users can read backups" ON public.backups;

CREATE POLICY "Users read own backups or staff read all"
  ON public.backups FOR SELECT TO authenticated
  USING (
    created_by = auth.uid()
    OR public.is_owner_or_auditor()
  );

-- BACKUP_SNAPSHOTS (follow parent backup visibility)
DROP POLICY IF EXISTS "Authenticated users can read backup_snapshots" ON public.backup_snapshots;

CREATE POLICY "Users read snapshots for accessible backups"
  ON public.backup_snapshots FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.backups b
      WHERE b.id = backup_snapshots.backup_id
      AND (b.created_by = auth.uid() OR public.is_owner_or_auditor())
    )
  );

-- FILE_INTEGRITY_CHECKS
DROP POLICY IF EXISTS "Authenticated users can read integrity checks" ON public.file_integrity_checks;
DROP POLICY IF EXISTS "Authenticated users can insert integrity checks" ON public.file_integrity_checks;

CREATE POLICY "Users read own integrity checks or staff"
  ON public.file_integrity_checks FOR SELECT TO authenticated
  USING (
    checked_by = auth.uid()
    OR public.is_owner_or_auditor()
  );

CREATE POLICY "Users insert integrity checks as self"
  ON public.file_integrity_checks FOR INSERT TO authenticated
  WITH CHECK (checked_by = auth.uid());
