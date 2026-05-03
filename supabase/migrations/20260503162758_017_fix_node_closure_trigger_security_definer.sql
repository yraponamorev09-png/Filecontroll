/*
  # Fix node_closure trigger functions to use SECURITY DEFINER

  1. Problem
    - `insert_node_closure()` and `delete_node_closure()` are trigger functions on the `nodes` table
    - They insert/delete rows in `node_closure` to maintain the closure table for hierarchical queries
    - RLS is enabled on `node_closure` but has NO policies, so all operations are blocked for non-superusers
    - When an authenticated user inserts a node (e.g., creates a folder), the trigger fires
      and tries to INSERT into `node_closure`, but RLS blocks it because there are no policies
    - This causes "new row violates row-level security policy for table node_closure" error

  2. Fix
    - Make both functions SECURITY DEFINER so they execute as `postgres` (the function owner)
    - This allows the trigger to bypass RLS on `node_closure` when maintaining the closure table
    - This is safe because these functions are internal trigger functions that only maintain
      the hierarchical closure data — they don't expose any data to users

  3. Security Notes
    - SECURITY DEFINER is appropriate here because these are system-maintained trigger functions
    - The functions only insert/delete closure relationships based on the node being modified
    - No user-controlled input is passed to these functions beyond the NEW/OLD trigger rows
    - The closure table is a derived/index table, not a security boundary
*/

CREATE OR REPLACE FUNCTION insert_node_closure()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Self-reference
  INSERT INTO node_closure (ancestor_id, descendant_id, depth)
  VALUES (NEW.id, NEW.id, 0)
  ON CONFLICT DO NOTHING;

  -- If has parent, copy all ancestor relationships
  IF NEW.parent_id IS NOT NULL THEN
    INSERT INTO node_closure (ancestor_id, descendant_id, depth)
    SELECT c.ancestor_id, NEW.id, c.depth + 1
    FROM node_closure c
    WHERE c.descendant_id = NEW.parent_id
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION delete_node_closure()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  DELETE FROM node_closure WHERE descendant_id = OLD.id;
  RETURN OLD;
END;
$$;
