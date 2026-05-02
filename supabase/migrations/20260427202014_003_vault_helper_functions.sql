/*
  # Add helper functions and missing indexes

  1. New Functions
    - `decrement_block_ref_count(block_id UUID)`: Safely decrements a data_block's
      ref_count by 1. Used during purge operations to track when blocks become
      orphaned and eligible for garbage collection.

  2. New Indexes
    - `idx_nodes_parent_id`: Fast folder listing by parent
    - `idx_nodes_path`: Fast path-based lookups
    - `idx_nodes_owner_type`: Fast queries filtering by owner + node_type
    - `idx_file_versions_node_current`: Fast lookup of current version for a node
    - `idx_file_versions_node_version`: Unique constraint enforcement + fast version lookups
    - `idx_data_blocks_content_hash`: Fast dedup lookups by content hash
    - `idx_access_control_lists_node_user`: Fast ACL lookups by node + user
    - `idx_share_links_token`: Fast share link validation by token
    - `idx_audit_log_node`: Fast audit log queries by node
    - `idx_audit_log_user`: Fast audit log queries by user

  3. Unique Constraint
    - `file_versions_node_id_version_number`: Ensures (node_id, version_number) is unique
      for optimistic concurrency control

  4. Security
    - No RLS changes - all tables already have restrictive policies
*/

-- Helper function: decrement block ref count
CREATE OR REPLACE FUNCTION decrement_block_ref_count(block_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE data_blocks
  SET ref_count = GREATEST(ref_count - 1, 0)
  WHERE id = block_id;
END;
$$ LANGUAGE plpgsql;

-- Unique constraint for optimistic locking
CREATE UNIQUE INDEX IF NOT EXISTS file_versions_node_id_version_number
  ON file_versions (node_id, version_number);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_nodes_parent_id ON nodes (parent_id) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_nodes_path ON nodes (path) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_nodes_owner_type ON nodes (owner_id, node_type) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_file_versions_node_current ON file_versions (node_id, is_current) WHERE is_current = true;
CREATE INDEX IF NOT EXISTS idx_data_blocks_content_hash ON data_blocks (content_hash);
CREATE INDEX IF NOT EXISTS idx_access_control_lists_node_user ON access_control_lists (node_id, user_id);
CREATE INDEX IF NOT EXISTS idx_share_links_token ON share_links (token) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_audit_log_node ON audit_log (node_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log (user_id, created_at DESC);
