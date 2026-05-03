import { v4 as uuidv4 } from 'uuid';
import { getSupabaseClient } from '../utils/db.js';
import { generateToken, hashPassword, verifyPassword } from '../utils/crypto.js';
import type { ShareLink, ShareLinkResult } from '../types/index.js';
import { VaultError, ShareLinkExpiredError, PermissionDeniedError } from '../types/index.js';
import { assertPermission } from './access.js';

/**
 * Create a secure share link for a node.
 *
 * Features:
 * - Cryptographic token (48 bytes, base64url encoded)
 * - Optional password protection (PBKDF2 hashed)
 * - Optional TTL (expires_at)
 * - Optional access limit (max_access_count)
 * - Permission scoping (read or write only)
 *
 * Only users with 'admin' or 'share' permission can create links.
 */
export async function createShareLink(
  userId: string,
  nodeId: string,
  options: {
    password?: string;
    expiresInHours?: number;
    maxAccessCount?: number;
    permission?: 'read' | 'write';
  } = {},
): Promise<ShareLinkResult> {
  const sb = getSupabaseClient();

  // Must have share/admin permission
  await assertPermission(userId, nodeId, 'share');

  const token = generateToken();
  let passwordHash: string | null = null;

  if (options.password) {
    const result = await hashPassword(options.password);
    // Store hash + salt together: salt$hash
    passwordHash = `${result.salt}$${result.hash}`;
  }

  let expiresAt: string | null = null;
  if (options.expiresInHours) {
    const d = new Date();
    d.setHours(d.getHours() + options.expiresInHours);
    expiresAt = d.toISOString();
  }

  const linkId = uuidv4();
  const { data, error } = await sb
    .from('share_links')
    .insert({
      id: linkId,
      node_id: nodeId,
      created_by: userId,
      token,
      password_hash: passwordHash,
      expires_at: expiresAt,
      max_access_count: options.maxAccessCount ?? null,
      access_count: 0,
      permission: options.permission ?? 'read',
      is_active: true,
    })
    .select()
    .single();

  if (error) throw new VaultError(`Failed to create share link: ${error.message}`, 'DB_ERROR');

  // Audit
  await sb.from('audit_log').insert({
    id: uuidv4(),
    user_id: userId,
    node_id: nodeId,
    action: 'share_link_create',
    details: {
      link_id: linkId,
      has_password: !!options.password,
      expires_at: expiresAt,
      max_access: options.maxAccessCount,
      permission: options.permission ?? 'read',
    },
  });

  return {
    link_id: linkId,
    token,
    expires_at: expiresAt,
  };
}

/**
 * Validate and consume a share link.
 * Checks: token exists, is active, not expired, not over access limit, password matches.
 * Increments access_count on success.
 */
export async function validateShareLink(
  token: string,
  password?: string,
): Promise<{ valid: boolean; nodeId: string; permission: 'read' | 'write'; reason?: string }> {
  const sb = getSupabaseClient();

  const { data: link, error } = await sb
    .from('share_links')
    .select('*')
    .eq('token', token)
    .maybeSingle();

  if (error) throw new VaultError(`Failed to fetch share link: ${error.message}`, 'DB_ERROR');
  if (!link) return { valid: false, nodeId: '', permission: 'read', reason: 'LINK_NOT_FOUND' };
  if (!link.is_active) return { valid: false, nodeId: link.node_id, permission: link.permission, reason: 'LINK_INACTIVE' };

  // Check expiration
  if (link.expires_at && new Date(link.expires_at) < new Date()) {
    // Auto-deactivate expired links
    await sb.from('share_links').update({ is_active: false }).eq('id', link.id);
    return { valid: false, nodeId: link.node_id, permission: link.permission, reason: 'LINK_EXPIRED' };
  }

  // Check access count
  if (link.max_access_count !== null && link.access_count >= link.max_access_count) {
    await sb.from('share_links').update({ is_active: false }).eq('id', link.id);
    return { valid: false, nodeId: link.node_id, permission: link.permission, reason: 'ACCESS_LIMIT_REACHED' };
  }

  // Check password
  if (link.password_hash) {
    if (!password) return { valid: false, nodeId: link.node_id, permission: link.permission, reason: 'PASSWORD_REQUIRED' };

    const [salt, storedHash] = link.password_hash.split('$');
    if (!await verifyPassword(password, storedHash, salt)) {
      return { valid: false, nodeId: link.node_id, permission: link.permission, reason: 'INVALID_PASSWORD' };
    }
  }

  // Increment access count
  await sb
    .from('share_links')
    .update({ access_count: link.access_count + 1 })
    .eq('id', link.id);

  // Audit
  await sb.from('audit_log').insert({
    id: uuidv4(),
    user_id: link.created_by,
    node_id: link.node_id,
    action: 'share_link_access',
    details: { link_id: link.id, access_count: link.access_count + 1 },
  });

  return { valid: true, nodeId: link.node_id, permission: link.permission };
}

/**
 * Revoke a share link.
 */
export async function revokeShareLink(
  userId: string,
  linkId: string,
): Promise<void> {
  const sb = getSupabaseClient();

  const { data: link, error: findErr } = await sb
    .from('share_links')
    .select('id, node_id, created_by')
    .eq('id', linkId)
    .maybeSingle();

  if (findErr) throw new VaultError(`Failed to find share link: ${findErr.message}`, 'DB_ERROR');
  if (!link) throw new VaultError('Share link not found', 'LINK_NOT_FOUND');

  // Only creator or node admin can revoke
  if (link.created_by !== userId) {
    await assertPermission(userId, link.node_id, 'admin');
  }

  const { error } = await sb
    .from('share_links')
    .update({ is_active: false })
    .eq('id', linkId);

  if (error) throw new VaultError(`Failed to revoke share link: ${error.message}`, 'DB_ERROR');

  await sb.from('audit_log').insert({
    id: uuidv4(),
    user_id: userId,
    node_id: link.node_id,
    action: 'share_link_revoke',
    details: { link_id: linkId },
  });
}

/**
 * List all active share links for a node.
 */
export async function listShareLinks(
  userId: string,
  nodeId: string,
): Promise<ShareLink[]> {
  const sb = getSupabaseClient();

  await assertPermission(userId, nodeId, 'read');

  const { data, error } = await sb
    .from('share_links')
    .select('*')
    .eq('node_id', nodeId)
    .eq('is_active', true)
    .order('created_at', { ascending: false });

  if (error) throw new VaultError(`Failed to list share links: ${error.message}`, 'DB_ERROR');
  return data as ShareLink[];
}
