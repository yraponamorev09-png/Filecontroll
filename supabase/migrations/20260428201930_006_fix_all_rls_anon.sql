/*
  # Fix RLS policies for all tables - allow anon access

  The Vault DMS frontend uses the Supabase anon key (no Auth).
  All existing policies require authenticated role which blocks access.

  This migration adds permissive policies for the anon role on all tables.
  In a production deployment with Supabase Auth, these would be replaced
  with proper auth.uid()-based policies.

  Tables affected:
  - nodes (SELECT, INSERT, UPDATE, DELETE)
  - file_versions (SELECT, INSERT, UPDATE)
  - data_blocks (SELECT, INSERT, UPDATE)
  - file_version_blocks (SELECT, INSERT)
  - access_control_lists (SELECT, INSERT, DELETE)
  - share_links (SELECT, INSERT, UPDATE, DELETE)
  - audit_log (SELECT, INSERT)
  - node_closure (SELECT)
*/

-- nodes
CREATE POLICY "App anon read nodes" ON nodes FOR SELECT TO anon USING (true);
CREATE POLICY "App anon insert nodes" ON nodes FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "App anon update nodes" ON nodes FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "App anon delete nodes" ON nodes FOR DELETE TO anon USING (true);

-- file_versions
CREATE POLICY "App anon read versions" ON file_versions FOR SELECT TO anon USING (true);
CREATE POLICY "App anon insert versions" ON file_versions FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "App anon update versions" ON file_versions FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- data_blocks
CREATE POLICY "App anon read blocks" ON data_blocks FOR SELECT TO anon USING (true);
CREATE POLICY "App anon insert blocks" ON data_blocks FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "App anon update blocks" ON data_blocks FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- file_version_blocks
CREATE POLICY "App anon read version blocks" ON file_version_blocks FOR SELECT TO anon USING (true);
CREATE POLICY "App anon insert version blocks" ON file_version_blocks FOR INSERT TO anon WITH CHECK (true);

-- access_control_lists
CREATE POLICY "App anon read acls" ON access_control_lists FOR SELECT TO anon USING (true);
CREATE POLICY "App anon insert acls" ON access_control_lists FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "App anon delete acls" ON access_control_lists FOR DELETE TO anon USING (true);

-- share_links
CREATE POLICY "App anon read shares" ON share_links FOR SELECT TO anon USING (true);
CREATE POLICY "App anon insert shares" ON share_links FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "App anon update shares" ON share_links FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "App anon delete shares" ON share_links FOR DELETE TO anon USING (true);

-- audit_log
CREATE POLICY "App anon read audit" ON audit_log FOR SELECT TO anon USING (true);
CREATE POLICY "App anon insert audit" ON audit_log FOR INSERT TO anon WITH CHECK (true);

-- node_closure
CREATE POLICY "App anon read closure" ON node_closure FOR SELECT TO anon USING (true);
