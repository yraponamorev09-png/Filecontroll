// Core domain types for the Vault DMS

export type NodeType = 'file' | 'folder';
export type Permission = 'read' | 'write' | 'admin';
export type UserRole = 'owner' | 'editor' | 'viewer' | 'auditor';
export type CompressionType = 'none' | 'zstd' | 'lz4';
export type Action = 'read' | 'write' | 'delete' | 'admin' | 'share';

export interface User {
  id: string;
  username: string;
  password_hash: string;
  role: UserRole;
  public_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface Node {
  id: string;
  parent_id: string | null;
  owner_id: string;
  name: string;
  node_type: NodeType;
  path: string;
  mime_type: string | null;
  size: number;
  is_archived: boolean;
  is_deleted: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface FileVersion {
  id: string;
  node_id: string;
  version_number: number;
  total_size: number;
  content_hash: string;
  encrypted_key: Uint8Array;
  key_nonce: Uint8Array;
  is_current: boolean;
  is_compressed: boolean;
  created_at: string;
  created_by: string;
}

export interface DataBlock {
  id: string;
  content_hash: string;
  encrypted_hash: string;
  size: number;
  encrypted_size: number;
  physical_path: string;
  compression: CompressionType;
  ref_count: number;
  created_at: string;
}

export interface FileVersionBlock {
  id: string;
  version_id: string;
  block_id: string;
  block_index: number;
  block_offset: number;
}

export interface AccessControlEntry {
  id: string;
  node_id: string;
  user_id: string;
  permission: Permission;
  inherit: boolean;
  granted_by: string;
  created_at: string;
}

export interface ShareLink {
  id: string;
  node_id: string;
  created_by: string;
  token: string;
  password_hash: string | null;
  expires_at: string | null;
  max_access_count: number | null;
  access_count: number;
  permission: 'read' | 'write';
  is_active: boolean;
  created_at: string;
}

export interface AuditLogEntry {
  id: string;
  user_id: string;
  node_id: string | null;
  action: string;
  details: Record<string, unknown>;
  ip_address: string | null;
  created_at: string;
}

export interface SaveVersionResult {
  version_id: string;
  is_duplicate: boolean;
  new_blocks_created: number;
  total_size: number;
}

export interface PermissionCheckResult {
  allowed: boolean;
  source: 'direct' | 'inherited' | 'owner' | 'denied';
  matched_permission: Permission | null;
}

export interface ShareLinkResult {
  link_id: string;
  token: string;
  expires_at: string | null;
}

export class VaultError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 500,
  ) {
    super(message);
    this.name = 'VaultError';
  }
}

export class PermissionDeniedError extends VaultError {
  constructor(action: Action, nodeId: string) {
    super(`Permission denied: ${action} on node ${nodeId}`, 'PERMISSION_DENIED', 403);
  }
}

export class NodeNotFoundError extends VaultError {
  constructor(nodeId: string) {
    super(`Node not found: ${nodeId}`, 'NODE_NOT_FOUND', 404);
  }
}

export class VersionConflictError extends VaultError {
  constructor(nodeId: string, version: number) {
    super(`Version conflict on node ${nodeId} at version ${version}`, 'VERSION_CONFLICT', 409);
  }
}

export class ShareLinkExpiredError extends VaultError {
  constructor(linkId: string) {
    super(`Share link expired: ${linkId}`, 'SHARE_LINK_EXPIRED', 410);
  }
}
