/*
  # Fix node_closure RLS - add INSERT and DELETE policies for anon

  The insert_node_closure() trigger fires when inserting into nodes,
  which writes rows into node_closure. Without an INSERT policy for anon,
  all node inserts fail with RLS violation.

  Also adding DELETE policy since the delete_node_closure() trigger
  fires on node deletion.
*/

CREATE POLICY "App anon insert closure" ON node_closure FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "App anon delete closure" ON node_closure FOR DELETE TO anon USING (true);
