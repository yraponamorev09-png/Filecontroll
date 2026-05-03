
/*
  # Fix decrement_block_ref_count RPC security and add GC helper

  1. Modified Functions
    - `decrement_block_ref_count(block_id uuid)`: Changed from INVOKER to
      SECURITY DEFINER. This RPC is called during purge operations to
      decrement ref_count on data_blocks. Since it runs as the caller,
      the UPDATE on data_blocks would fail with RLS unless the caller
      has write access to the referencing file. Making it SECURITY DEFINER
      allows the function to execute with postgres privileges, bypassing
      RLS for this maintenance operation.

  2. New Functions
    - `gc_orphaned_blocks()`: SECURITY DEFINER function that finds and
      deletes data_blocks with ref_count <= 0. This is a maintenance
      operation that should be callable by authenticated users without
      needing direct DELETE access on data_blocks. Returns the count
      of deleted blocks.

  3. Security
    - Both functions are SECURITY DEFINER, executing with postgres privileges.
    - decrement_block_ref_count only decrements, never below 0.
    - gc_orphaned_blocks only deletes blocks with ref_count <= 0, which
      are by definition orphaned and contain no sensitive data references.
*/

-- Fix: make decrement_block_ref_count SECURITY DEFINER
CREATE OR REPLACE FUNCTION decrement_block_ref_count(block_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE data_blocks
  SET ref_count = GREATEST(ref_count - 1, 0)
  WHERE id = block_id;
END;
$$;

-- New: GC helper that deletes orphaned blocks
CREATE OR REPLACE FUNCTION gc_orphaned_blocks()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM data_blocks WHERE ref_count <= 0;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;
