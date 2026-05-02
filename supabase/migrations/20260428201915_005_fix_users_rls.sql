/*
  # Fix RLS policies for users table - allow app access

  The frontend uses the anon key (no Supabase Auth) to access the database.
  Current policies require auth.uid() = id which blocks all anon access.

  Changes:
  1. Add SELECT policy for anon key (app needs to read users list)
  2. Add INSERT policy for anon key (app needs to create initial user)
  3. Add UPDATE policy for anon key (admin panel edits users)
  4. Add DELETE policy for anon key (admin panel deletes users)

  Security note: In production, replace these with proper auth-based policies.
  For this local-first DMS, the database is accessed from a trusted desktop app.
*/

-- Allow reading all users (needed for admin panel and user lookup)
CREATE POLICY "App can read users"
  ON users FOR SELECT
  TO anon
  USING (true);

-- Allow inserting users (needed for initial setup and admin panel)
CREATE POLICY "App can insert users"
  ON users FOR INSERT
  TO anon
  WITH CHECK (true);

-- Allow updating users (needed for admin panel)
CREATE POLICY "App can update users"
  ON users FOR UPDATE
  TO anon
  USING (true)
  WITH CHECK (true);

-- Allow deleting users (needed for admin panel)
CREATE POLICY "App can delete users"
  ON users FOR DELETE
  TO anon
  USING (true);
