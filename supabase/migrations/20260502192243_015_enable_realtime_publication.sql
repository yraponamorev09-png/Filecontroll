/*
  # Enable Supabase Realtime for key tables

  1. Changes
    - Add `nodes`, `products`, `share_links`, `audit_log`, `data_blocks` tables to the `supabase_realtime` publication
    - This enables Supabase Realtime to broadcast INSERT/UPDATE/DELETE events for these tables
    - Required for the frontend's realtime subscriptions to work correctly

  2. Important Notes
    - Without this, the `subscribeToTable()` calls in the frontend receive NO events
    - Realtime is essential for collaborative features and auto-updating views
    - RLS policies still control which rows each user can see in realtime events
*/

ALTER PUBLICATION supabase_realtime ADD TABLE nodes;
ALTER PUBLICATION supabase_realtime ADD TABLE products;
ALTER PUBLICATION supabase_realtime ADD TABLE share_links;
ALTER PUBLICATION supabase_realtime ADD TABLE audit_log;
ALTER PUBLICATION supabase_realtime ADD TABLE data_blocks;
