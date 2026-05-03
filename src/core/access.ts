import { v4 as uuidv4 } from 'uuid';
import { getSupabaseClient } from '../utils/db.js';
import type { Action, Permission, PermissionCheckResult, AccessControlEntry, Node } from '../types/index.js';
import { NodeNotFoundError, PermissionDeniedError, VaultError } from '../types/index.js';

/**
 * Permission hierarchy: admin > write > read
 * Action mapping:
 *   read    -> requires 'read' or higher
 *   write   -> requires 'write' or higher
 *   delete  -> requires 'admin'
 *   admin   -> requires 'admin'
 *   share   -> requires 'admin'
 */
const PERMISSION_RANK: Record<Permission, number> = {
  read: 1,
  write: 2,
  admin: 3,
};

const ACTION_REQUIRED_PERMISSION: Record<Action, Permission> = {
  read: 'read',
  write: 'write',
  delete: 'admin',
  admin: 'admin',
  share: 'admin',
};

function satisfiesPermission(held: Permission, required: Permission): boolean {
  return PERMISSION_RANK[held] >= PERMISSION_RANK[required];
}

/**
 * Check if a user has permission to perform an action on a node.
 *
 * Resolution order:
 * 1. Owner check: node.owner_id === userId -> always allowed
 * 2. Direct ACL: explicit ACE on the node for this user
 * 3. Inherited ACL: walk up parent chain looking for inheritable ACEs
 * 4. Denied if nothing matches
 */
export async function checkPermission(
  userId: string,
  nodeId: string,
  requiredAction: Action,
): Promise<PermissionCheckResult> {
  const sb = getSupabaseClient();
  const requiredPermission = ACTION_REQUIRED_PERMISSION[requiredAction];

  // 1. Fetch the node
  const { data: node, error: nodeErr } = await sb
    .from('nodes')
    .select('id, owner_id, parent_id, node_type')
    .eq('id', nodeId)
    .maybeSingle();

  if (nodeErr) throw new VaultError(`Failed to fetch node: ${nodeErr.message}`, 'DB_ERROR');
  if (!node) throw new NodeNotFoundError(nodeId);

  // 2. Owner always has full access
  if (node.owner_id === userId) {
    return { allowed: true, source: 'owner', matched_permission: 'admin' };
  }

  // 3. Check direct ACL on this node
  const { data: directAcls, error: aclErr } = await sb
    .from('access_control_lists')
    .select('permission, inherit')
    .eq('node_id', nodeId)
    .eq('user_id', userId);

  if (aclErr) throw new VaultError(`Failed to fetch ACLs: ${aclErr.message}`, 'DB_ERROR');

  if (directAcls && directAcls.length > 0) {
    // Find the highest permission among direct ACEs
    const bestDirect = directAcls.reduce<Permission | null>((best, ace) => {
      if (!best || PERMISSION_RANK[ace.permission as Permission] > PERMISSION_RANK[best]) {
        return ace.permission as Permission;
      }
      return best;
    }, null);

    if (bestDirect && satisfiesPermission(bestDirect, requiredPermission)) {
      return { allowed: true, source: 'direct', matched_permission: bestDirect };
    }
  }

  // 4. Walk up parent chain for inherited permissions
  let currentParentId: string | null = node.parent_id;
  const visited = new Set<string>();
  visited.add(nodeId);

  while (currentParentId && !visited.has(currentParentId)) {
    visited.add(currentParentId);

    const { data: parentAcls, error: parentAclErr } = await sb
      .from('access_control_lists')
      .select('permission, inherit')
      .eq('node_id', currentParentId)
      .eq('user_id', userId)
      .eq('inherit', true);

    if (parentAclErr) throw new VaultError(`Failed to fetch parent ACLs: ${parentAclErr.message}`, 'DB_ERROR');

    if (parentAcls && parentAcls.length > 0) {
      const bestInherited = parentAcls.reduce<Permission | null>((best, ace) => {
        if (!best || PERMISSION_RANK[ace.permission as Permission] > PERMISSION_RANK[best]) {
          return ace.permission as Permission;
        }
        return best;
      }, null);

      if (bestInherited && satisfiesPermission(bestInherited, requiredPermission)) {
        return { allowed: true, source: 'inherited', matched_permission: bestInherited };
      }
    }

    // Move up to next parent
    const { data: parentNode, error: parentErr } = await sb
      .from('nodes')
      .select('parent_id, owner_id')
      .eq('id', currentParentId)
      .maybeSingle();

    if (parentErr || !parentNode) break;

    // If we reach an owner, they implicitly grant access
    if (parentNode.owner_id === userId) {
      return { allowed: true, source: 'inherited', matched_permission: 'admin' };
    }

    currentParentId = parentNode.parent_id;
  }

  return { allowed: false, source: 'denied', matched_permission: null };
}

/**
 * Assert permission - throws if denied. Convenience wrapper.
 */
export async function assertPermission(
  userId: string,
  nodeId: string,
  requiredAction: Action,
): Promise<void> {
  const result = await checkPermission(userId, nodeId, requiredAction);
  if (!result.allowed) {
    throw new PermissionDeniedError(requiredAction, nodeId);
  }
}

/**
 * Grant a permission on a node to a user.
 * Only owners and admins can grant permissions.
 */
export async function grantPermission(
  granterId: string,
  targetUserId: string,
  nodeId: string,
  permission: Permission,
  inherit: boolean = true,
): Promise<AccessControlEntry> {
  const sb = getSupabaseClient();

  // Granter must have admin permission
  await assertPermission(granterId, nodeId, 'admin');

  // Upsert: if ACE already exists for this user+node, update it
  const { data: existing, error: findErr } = await sb
    .from('access_control_lists')
    .select('id')
    .eq('node_id', nodeId)
    .eq('user_id', targetUserId)
    .maybeSingle();

  if (findErr) throw new VaultError(`Failed to check existing ACE: ${findErr.message}`, 'DB_ERROR');

  if (existing) {
    const { data, error } = await sb
      .from('access_control_lists')
      .update({ permission, inherit })
      .eq('id', existing.id)
      .select()
      .single();

    if (error) throw new VaultError(`Failed to update ACE: ${error.message}`, 'DB_ERROR');

    await logAclChange(sb, granterId, nodeId, 'acl_update', targetUserId, permission);
    return data as AccessControlEntry;
  }

  const { data, error } = await sb
    .from('access_control_lists')
    .insert({
      node_id: nodeId,
      user_id: targetUserId,
      permission,
      inherit,
      granted_by: granterId,
    })
    .select()
    .single();

  if (error) throw new VaultError(`Failed to create ACE: ${error.message}`, 'DB_ERROR');

  await logAclChange(sb, granterId, nodeId, 'acl_grant', targetUserId, permission);
  return data as AccessControlEntry;
}

/**
 * Revoke a permission from a user on a node.
 */
export async function revokePermission(
  revokerId: string,
  targetUserId: string,
  nodeId: string,
): Promise<void> {
  const sb = getSupabaseClient();

  await assertPermission(revokerId, nodeId, 'admin');

  const { error } = await sb
    .from('access_control_lists')
    .delete()
    .eq('node_id', nodeId)
    .eq('user_id', targetUserId);

  if (error) throw new VaultError(`Failed to revoke ACE: ${error.message}`, 'DB_ERROR');

  await logAclChange(sb, revokerId, nodeId, 'acl_revoke', targetUserId, null);
}

/**
 * Get all permissions for a node, including inherited ones.
 */
export async function getEffectivePermissions(
  userId: string,
  nodeId: string,
): Promise<Record<Action, boolean>> {
  const actions: Action[] = ['read', 'write', 'delete', 'admin', 'share'];
  const result: Record<Action, boolean> = {} as Record<Action, boolean>;

  const check = await checkPermission(userId, nodeId, 'admin');
  if (check.allowed && check.matched_permission === 'admin') {
    // Admin has all permissions
    for (const a of actions) result[a] = true;
    return result;
  }

  for (const action of actions) {
    const r = await checkPermission(userId, nodeId, action);
    result[action] = r.allowed;
  }

  return result;
}

async function logAclChange(
  sb: ReturnType<typeof getSupabaseClient>,
  userId: string,
  nodeId: string,
  action: string,
  targetUserId: string,
  permission: Permission | null,
): Promise<void> {
  await sb.from('audit_log').insert({
    id: uuidv4(),
    user_id: userId,
    node_id: nodeId,
    action,
    details: { target_user_id: targetUserId, permission },
  });
}
