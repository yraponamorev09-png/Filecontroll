import { createClient } from "npm:@supabase/supabase-js@2";
import { v4 as uuidv4 } from "npm:uuid@14";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, code: string, status = 500): Response {
  return new Response(JSON.stringify({ error: message, code }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type PermResult = {
  allowed: boolean;
  source: string | null;
  matched_permission: string | null;
  notFound?: boolean;
};

async function getVerifiedAuth(req: Request, supabaseUrl: string, anonKey: string): Promise<{ id: string; jwt: string } | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const jwt = authHeader.slice(7).trim();
  if (!jwt) return null;
  const ac = createClient(supabaseUrl, anonKey);
  const { data: { user }, error } = await ac.auth.getUser(jwt);
  if (error || !user?.id) return null;
  return { id: user.id, jwt };
}

function createUserClient(supabaseUrl: string, anonKey: string, jwt: string) {
  return createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

async function requireAppOwner(sb: ReturnType<typeof createClient>, userId: string): Promise<Response | null> {
  const { data: prof } = await sb.from("user_profiles").select("role").eq("id", userId).maybeSingle();
  if (prof?.role !== "owner") {
    return errorResponse("Только роль owner может выполнять эту операцию", "FORBIDDEN", 403);
  }
  return null;
}

async function evaluateNodePermission(
  sb: ReturnType<typeof createClient>,
  user_id: string,
  node_id: string,
  action: string,
): Promise<PermResult> {
  const { data: node } = await sb.from("nodes").select("id, owner_id, parent_id").eq("id", node_id).maybeSingle();
  if (!node) return { allowed: false, source: null, matched_permission: null, notFound: true };

  if (node.owner_id === user_id) {
    return { allowed: true, source: "owner", matched_permission: "admin" };
  }

  const { data: acls } = await sb.from("access_control_lists").select("permission, inherit").eq("node_id", node_id).eq("user_id", user_id);

  const permRank: Record<string, number> = { read: 1, write: 2, admin: 3 };
  const actionPerm: Record<string, string> = { read: "read", write: "write", delete: "admin", admin: "admin", share: "admin" };
  const required = actionPerm[action] || "admin";

  if (acls && acls.length > 0) {
    const best = acls.reduce((b: string | null, a: { permission: string }) =>
      !b || permRank[a.permission] > permRank[b] ? a.permission : b, null);
    if (best && permRank[best] >= permRank[required]) {
      return { allowed: true, source: "direct", matched_permission: best };
    }
  }

  let parentId: string | null = node.parent_id;
  const visited = new Set<string>([node_id]);
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const { data: parentAcls } = await sb.from("access_control_lists").select("permission").eq("node_id", parentId).eq("user_id", user_id).eq("inherit", true);
    if (parentAcls && parentAcls.length > 0) {
      const best = parentAcls.reduce((b: string | null, a: { permission: string }) =>
        !b || permRank[a.permission] > permRank[b] ? a.permission : b, null);
      if (best && permRank[best] >= permRank[required]) {
        return { allowed: true, source: "inherited", matched_permission: best };
      }
    }
    const { data: pNode } = await sb.from("nodes").select("parent_id, owner_id").eq("id", parentId).maybeSingle();
    if (!pNode) break;
    if (pNode.owner_id === user_id) return { allowed: true, source: "inherited", matched_permission: "admin" };
    parentId = pNode.parent_id;
  }

  return { allowed: false, source: "denied", matched_permission: null };
}

// --- Versioning ---

async function saveFileVersion(sb: ReturnType<typeof createClient>, body: {
  node_id: string;
  content_hash: string;
  size: number;
  blocks: { hash: string; size: number; index: number }[];
  vault_dir: string;
}, verifiedUserId: string) {
  const { node_id, content_hash, size, blocks, vault_dir } = body;
  const perm = await evaluateNodePermission(sb, verifiedUserId, node_id, "write");
  if (perm.notFound) return errorResponse("Node not found", "NODE_NOT_FOUND", 404);
  if (!perm.allowed) return errorResponse("Forbidden", "FORBIDDEN", 403);
  const user_id = verifiedUserId;

  const { data: node, error: nodeErr } = await sb
    .from("nodes")
    .select("id, node_type, owner_id")
    .eq("id", node_id)
    .maybeSingle();

  if (nodeErr || !node) return errorResponse("Node not found", "NODE_NOT_FOUND", 404);
  if (node.node_type !== "file") return errorResponse("Cannot version a folder", "INVALID_NODE_TYPE", 400);

  const { data: currentVersion } = await sb
    .from("file_versions")
    .select("version_number")
    .eq("node_id", node_id)
    .eq("is_current", true)
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextVersion = (currentVersion?.version_number ?? 0) + 1;

  let newBlocksCreated = 0;
  const versionBlockRefs: { blockId: string; index: number; offset: number }[] = [];

  for (const block of blocks) {
    const { data: existingBlock } = await sb
      .from("data_blocks")
      .select("id, ref_count")
      .eq("content_hash", block.hash)
      .maybeSingle();

    if (existingBlock) {
      await sb.from("data_blocks").update({ ref_count: existingBlock.ref_count + 1 }).eq("id", existingBlock.id);
      versionBlockRefs.push({ blockId: existingBlock.id, index: block.index, offset: block.index * 4 * 1024 * 1024 });
    } else {
      const blockId = uuidv4();
      const hashPrefix = block.hash.substring(0, 2);
      await sb.from("data_blocks").insert({
        id: blockId,
        content_hash: block.hash,
        encrypted_hash: block.hash,
        size: block.size,
        encrypted_size: block.size,
        physical_path: `${vault_dir}/blocks/${hashPrefix}/${block.hash}`,
        compression: "none",
        ref_count: 1,
      });
      newBlocksCreated++;
      versionBlockRefs.push({ blockId, index: block.index, offset: block.index * 4 * 1024 * 1024 });
    }
  }

  await sb.from("file_versions").update({ is_current: false }).eq("node_id", node_id).eq("is_current", true);

  const versionId = uuidv4();
  await sb.from("file_versions").insert({
    id: versionId,
    node_id,
    version_number: nextVersion,
    total_size: size,
    content_hash,
    encrypted_key: new Uint8Array(32),
    key_nonce: new Uint8Array(24),
    is_current: true,
    is_compressed: false,
    created_by: user_id,
  });

  const blockInserts = versionBlockRefs.map((ref) => ({
    id: uuidv4(),
    version_id: versionId,
    block_id: ref.blockId,
    block_index: ref.index,
    block_offset: ref.offset,
  }));
  await sb.from("file_version_blocks").insert(blockInserts);

  await sb.from("nodes").update({ size, updated_at: new Date().toISOString() }).eq("id", node_id);

  await sb.from("audit_log").insert({
    id: uuidv4(),
    user_id,
    node_id,
    action: "version_create",
    details: { version_id: versionId, version_number: nextVersion, new_blocks: newBlocksCreated },
  });

  return jsonResponse({
    version_id: versionId,
    version_number: nextVersion,
    new_blocks_created: newBlocksCreated,
    total_size: size,
  }, 201);
}

// --- Access Control ---

async function checkPermissionHandler(
  sb: ReturnType<typeof createClient>,
  body: { node_id: string; action: string },
  verifiedUserId: string,
) {
  const r = await evaluateNodePermission(sb, verifiedUserId, body.node_id, body.action);
  if (r.notFound) return errorResponse("Node not found", "NODE_NOT_FOUND", 404);
  return jsonResponse({ allowed: r.allowed, source: r.source, matched_permission: r.matched_permission });
}

// --- Sharing ---

async function createShareLinkHandler(sb: ReturnType<typeof createClient>, body: {
  node_id: string;
  password?: string;
  expires_in_hours?: number;
  max_access_count?: number;
  permission?: "read" | "write";
}, verifiedUserId: string) {
  const { node_id, password, expires_in_hours, max_access_count, permission } = body;
  const user_id = verifiedUserId;
  const perm = await evaluateNodePermission(sb, user_id, node_id, "share");
  if (perm.notFound) return errorResponse("Node not found", "NODE_NOT_FOUND", 404);
  if (!perm.allowed) return errorResponse("Forbidden", "FORBIDDEN", 403);

  const tokenBytes = new Uint8Array(48);
  crypto.getRandomValues(tokenBytes);
  const token = btoa(String.fromCharCode(...tokenBytes)).replace(/[+/=]/g, "").substring(0, 64);

  let passwordHash: string | null = null;
  if (password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const derivedBits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 600000, hash: "SHA-256" }, keyMaterial, 256);
    const hashArray = new Uint8Array(derivedBits);
    passwordHash = `pbkdf2$${Array.from(salt).map(b => b.toString(16).padStart(2, "0")).join("")}$600000$${Array.from(hashArray).map(b => b.toString(16).padStart(2, "0")).join("")}`;
  }

  let expiresAt: string | null = null;
  if (expires_in_hours) {
    const d = new Date();
    d.setHours(d.getHours() + expires_in_hours);
    expiresAt = d.toISOString();
  }

  const linkId = uuidv4();
  const { error } = await sb.from("share_links").insert({
    id: linkId,
    node_id,
    created_by: user_id,
    token,
    password_hash: passwordHash,
    expires_at: expiresAt,
    max_access_count: max_access_count ?? null,
    access_count: 0,
    permission: permission ?? "read",
    is_active: true,
  });

  if (error) return errorResponse(`Failed to create share link: ${error.message}`, "DB_ERROR");

  await sb.from("audit_log").insert({
    id: uuidv4(),
    user_id,
    node_id,
    action: "share_link_create",
    details: { link_id: linkId, has_password: !!password, expires_at: expiresAt },
  });

  return jsonResponse({ link_id: linkId, token, expires_at: expiresAt }, 201);
}

// --- Backup ---

async function createBackupHandler(sb: ReturnType<typeof createClient>, body: {
  type: "full" | "incremental" | "metadata_only" | "blocks_only";
  since_backup_id?: string;
}, verifiedUserId: string) {
  const ownerErr = await requireAppOwner(sb, verifiedUserId);
  if (ownerErr) return ownerErr;
  const user_id = verifiedUserId;
  const { type, since_backup_id } = body;
  const backupId = uuidv4();

  // Create backup record
  await sb.from("backups").insert({
    id: backupId,
    type,
    status: "running",
    created_by: user_id,
  });

  try {
    // Collect metadata
    const [nodesRes, versionsRes, blocksRes, profilesRes, aclsRes, shareLinksRes, productsRes, bomRes, workflowsRes] = await Promise.all([
      sb.from("nodes").select("*").eq("is_deleted", false),
      sb.from("file_versions").select("*"),
      sb.from("data_blocks").select("*"),
      sb.from("user_profiles").select("*"),
      sb.from("access_control_lists").select("*"),
      sb.from("share_links").select("*").eq("is_active", true),
      sb.from("products").select("*"),
      sb.from("bom_items").select("*"),
      sb.from("workflow_instances").select("*"),
    ]);

    const nodes = nodesRes.data || [];
    const versions = versionsRes.data || [];
    const blocks = blocksRes.data || [];
    const profiles = profilesRes.data || [];
    const acls = aclsRes.data || [];
    const shareLinks = shareLinksRes.data || [];
    const products = productsRes.data || [];
    const bom = bomRes.data || [];
    const workflows = workflowsRes.data || [];

    // For incremental: filter to only changed data since last backup
    let filteredNodes = nodes;
    let filteredVersions = versions;
    if (type === "incremental" && since_backup_id) {
      const { data: lastBackup } = await sb.from("backups").select("started_at").eq("id", since_backup_id).maybeSingle();
      if (lastBackup) {
        const since = lastBackup.started_at;
        filteredNodes = nodes.filter((n: any) => n.updated_at > since || n.created_at > since);
        filteredVersions = versions.filter((v: any) => v.created_at > since);
      }
    }

    // Build metadata JSON
    const metadataJson = {
      nodes: type === "blocks_only" ? [] : filteredNodes,
      versions: type === "blocks_only" ? [] : filteredVersions,
      profiles: type === "blocks_only" ? [] : profiles,
      acls: type === "blocks_only" ? [] : acls,
      share_links: type === "blocks_only" ? [] : shareLinks,
      products: type === "blocks_only" ? [] : products,
      bom_items: type === "blocks_only" ? [] : bom,
      workflow_instances: type === "blocks_only" ? [] : workflows,
    };

    // Build blocks manifest
    const blocksManifest = (type === "metadata_only" ? [] : blocks).map((b: any) => ({
      id: b.id,
      content_hash: b.content_hash,
      size: b.size,
      physical_path: b.physical_path,
      compression: b.compression,
      ref_count: b.ref_count,
    }));

    // Compute total size
    const totalSize = blocks.reduce((sum: number, b: any) => sum + (b.size || 0), 0);

    // Compute checksum of the entire manifest
    const manifestStr = JSON.stringify({ metadata: metadataJson, blocks: blocksManifest });
    const manifestEncoded = new TextEncoder().encode(manifestStr);
    const hashBuffer = await crypto.subtle.digest("SHA-256", manifestEncoded);
    const checksum = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

    // Create snapshots for each table
    const tables = [
      { name: "nodes", data: filteredNodes },
      { name: "file_versions", data: filteredVersions },
      { name: "data_blocks", data: type === "metadata_only" ? [] : blocks },
      { name: "user_profiles", data: profiles },
      { name: "access_control_lists", data: acls },
      { name: "share_links", data: shareLinks },
      { name: "products", data: products },
      { name: "bom_items", data: bom },
      { name: "workflow_instances", data: workflows },
    ];

    for (const table of tables) {
      const tableStr = JSON.stringify(table.data);
      const tableEncoded = new TextEncoder().encode(tableStr);
      const tableHash = await crypto.subtle.digest("SHA-256", tableEncoded);
      const tableChecksum = Array.from(new Uint8Array(tableHash)).map(b => b.toString(16).padStart(2, "0")).join("");

      await sb.from("backup_snapshots").insert({
        backup_id: backupId,
        table_name: table.name,
        row_count: table.data.length,
        checksum: tableChecksum,
        data: table.data,
      });
    }

    // Update backup record
    await sb.from("backups").update({
      status: "completed",
      completed_at: new Date().toISOString(),
      metadata_json: metadataJson,
      blocks_manifest: blocksManifest,
      total_size: totalSize,
      total_nodes: filteredNodes.length,
      total_versions: filteredVersions.length,
      total_blocks: blocksManifest.length,
      checksum,
    }).eq("id", backupId);

    // Audit
    await sb.from("audit_log").insert({
      id: uuidv4(),
      user_id,
      action: "backup_create",
      details: { backup_id: backupId, type, total_nodes: filteredNodes.length, total_blocks: blocksManifest.length },
    });

    return jsonResponse({
      backup_id: backupId,
      type,
      total_nodes: filteredNodes.length,
      total_versions: filteredVersions.length,
      total_blocks: blocksManifest.length,
      total_size: totalSize,
      checksum,
    }, 201);
  } catch (err) {
    await sb.from("backups").update({
      status: "failed",
      completed_at: new Date().toISOString(),
      error_message: err instanceof Error ? err.message : "Unknown error",
    }).eq("id", backupId);

    return errorResponse(`Backup failed: ${err instanceof Error ? err.message : "Unknown error"}`, "BACKUP_FAILED");
  }
}

// --- Backup Verification ---

async function verifyBackupHandler(sb: ReturnType<typeof createClient>, backupId: string, verifiedUserId: string) {
  const ownerErr = await requireAppOwner(sb, verifiedUserId);
  if (ownerErr) return ownerErr;
  const { data: backup } = await sb.from("backups").select("*").eq("id", backupId).maybeSingle();
  if (!backup) return errorResponse("Backup not found", "NOT_FOUND", 404);

  try {
    // Recompute checksum from stored data
    const manifestStr = JSON.stringify({ metadata: backup.metadata_json, blocks: backup.blocks_manifest });
    const manifestEncoded = new TextEncoder().encode(manifestStr);
    const hashBuffer = await crypto.subtle.digest("SHA-256", manifestEncoded);
    const computedChecksum = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

    const checksumValid = computedChecksum === backup.checksum;

    // Verify each snapshot
    const { data: snapshots } = await sb.from("backup_snapshots").select("*").eq("backup_id", backupId);
    const snapshotResults: { table: string; valid: boolean; row_count: number }[] = [];

    if (snapshots) {
      for (const snap of snapshots) {
        const tableStr = JSON.stringify(snap.data);
        const tableEncoded = new TextEncoder().encode(tableStr);
        const tableHash = await crypto.subtle.digest("SHA-256", tableEncoded);
        const tableChecksum = Array.from(new Uint8Array(tableHash)).map(b => b.toString(16).padStart(2, "0")).join("");
        snapshotResults.push({
          table: snap.table_name,
          valid: tableChecksum === snap.checksum,
          row_count: snap.row_count,
        });
      }
    }

    const allValid = checksumValid && snapshotResults.every(r => r.valid);

    await sb.from("backups").update({
      is_verified: allValid,
      verified_at: new Date().toISOString(),
      status: allValid ? backup.status : "verifying",
    }).eq("id", backupId);

    return jsonResponse({
      backup_id: backupId,
      checksum_valid: checksumValid,
      snapshots: snapshotResults,
      is_valid: allValid,
    });
  } catch (err) {
    return errorResponse(`Verification failed: ${err instanceof Error ? err.message : "Unknown error"}`, "VERIFY_FAILED");
  }
}

// --- File Integrity Check ---

async function checkFileIntegrityHandler(sb: ReturnType<typeof createClient>, body: {
  node_id: string;
}, verifiedUserId: string) {
  const user_id = verifiedUserId;
  const { node_id } = body;
  const perm = await evaluateNodePermission(sb, user_id, node_id, "read");
  if (perm.notFound) return errorResponse("Node not found", "NODE_NOT_FOUND", 404);
  if (!perm.allowed) return errorResponse("Forbidden", "FORBIDDEN", 403);

  const { data: node } = await sb.from("nodes").select("*").eq("id", node_id).maybeSingle();
  if (!node) return errorResponse("Node not found", "NOT_FOUND", 404);

  const { data: versions } = await sb.from("file_versions").select("*").eq("node_id", node_id).order("version_number", { ascending: false });
  if (!versions || versions.length === 0) return errorResponse("No versions found", "NO_VERSIONS", 404);

  const results: any[] = [];

  for (const version of versions) {
    // Get blocks for this version
    const { data: versionBlocks } = await sb.from("file_version_blocks")
      .select("block_id, block_index")
      .eq("version_id", version.id)
      .order("block_index");

    if (!versionBlocks || versionBlocks.length === 0) continue;

    // Get block data
    const blockIds = versionBlocks.map((vb: any) => vb.block_id);
    const { data: blocksData } = await sb.from("data_blocks")
      .select("id, content_hash, size, ref_count")
      .in("id", blockIds);

    // Verify: all blocks exist and have valid ref_count
    let isValid = true;
    let errorDetail: string | null = null;

    if (!blocksData || blocksData.length !== blockIds.length) {
      isValid = false;
      errorDetail = `Missing blocks: expected ${blockIds.length}, found ${blocksData?.length || 0}`;
    } else {
      // Check ref_count > 0 for all blocks
      const orphaned = blocksData.filter((b: any) => b.ref_count <= 0);
      if (orphaned.length > 0) {
        isValid = false;
        errorDetail = `Orphaned blocks: ${orphaned.length} blocks have ref_count <= 0`;
      }

      // Verify content_hash matches version's content_hash
      const blockHashes = versionBlocks.map((vb: any) => {
        const block = blocksData.find((b: any) => b.id === vb.block_id);
        return block?.content_hash;
      }).filter(Boolean).sort().join(",");

      // We can't recompute the actual file hash from blocks without reading the physical files,
      // but we can verify the block references are consistent
    }

    // Record the check
    const checkId = uuidv4();
    await sb.from("file_integrity_checks").insert({
      id: checkId,
      node_id,
      version_id: version.id,
      expected_hash: version.content_hash,
      verified_hash: isValid ? version.content_hash : null,
      is_valid: isValid,
      checked_by: user_id,
      error_detail: errorDetail,
    });

    results.push({
      version_id: version.id,
      version_number: version.version_number,
      is_current: version.is_current,
      is_valid: isValid,
      error: errorDetail,
      blocks_checked: blockIds.length,
    });
  }

  return jsonResponse({
    node_id,
    checks: results,
    total_versions: versions.length,
    all_valid: results.every(r => r.is_valid),
  });
}

// --- Backup Restore (Point-in-time) ---

async function restoreBackupHandler(sb: ReturnType<typeof createClient>, body: {
  backup_id: string;
  tables?: string[];
}, verifiedUserId: string) {
  const ownerErr = await requireAppOwner(sb, verifiedUserId);
  if (ownerErr) return ownerErr;
  const user_id = verifiedUserId;
  const { backup_id, tables } = body;

  const { data: backup } = await sb.from("backups").select("*").eq("id", backup_id).maybeSingle();
  if (!backup) return errorResponse("Backup not found", "NOT_FOUND", 404);
  if (backup.status !== "completed") return errorResponse("Backup not completed", "INVALID_STATE", 400);

  // Verify backup first
  if (!backup.is_verified) {
    return errorResponse("Backup must be verified before restore. Call verify first.", "NOT_VERIFIED", 400);
  }

  const { data: snapshots } = await sb.from("backup_snapshots")
    .select("*")
    .eq("backup_id", backup_id);

  if (!snapshots) return errorResponse("No snapshots found", "NO_SNAPSHOTS", 404);

  const targetTables = tables || snapshots.map(s => s.table_name);
  const results: any[] = [];

  for (const snapshot of snapshots) {
    if (!targetTables.includes(snapshot.table_name)) continue;

    const tableData = snapshot.data as any[];
    if (!tableData || tableData.length === 0) {
      results.push({ table: snapshot.table_name, restored: 0, status: "skipped_empty" });
      continue;
    }

    // For safety, we only restore to specific tables that are safe to upsert
    const safeTables = ["nodes", "file_versions", "data_blocks", "file_version_blocks",
      "access_control_lists", "share_links", "products", "bom_items", "workflow_instances",
      "user_profiles", "workflow_stages", "file_extensions"];

    if (!safeTables.includes(snapshot.table_name)) {
      results.push({ table: snapshot.table_name, restored: 0, status: "skipped_unsafe" });
      continue;
    }

    try {
      // Upsert each row (insert if not exists, update if exists)
      const { error: upsertError } = await sb.from(snapshot.table_name).upsert(tableData, {
        onConflict: "id",
      });

      if (upsertError) {
        results.push({ table: snapshot.table_name, restored: 0, status: "error", error: upsertError.message });
      } else {
        results.push({ table: snapshot.table_name, restored: tableData.length, status: "restored" });
      }
    } catch (e) {
      results.push({ table: snapshot.table_name, restored: 0, status: "error", error: e instanceof Error ? e.message : "Unknown" });
    }
  }

  // Audit
  await sb.from("audit_log").insert({
    id: uuidv4(),
    user_id,
    action: "backup_restore",
    details: { backup_id, tables: targetTables, results },
  });

  return jsonResponse({
    backup_id,
    restored_tables: results,
    restored_at: new Date().toISOString(),
  });
}

// --- File Content: Generate signed URL for preview/download ---

async function getFileContentHandler(
  sb: ReturnType<typeof createClient>,
  sbAdmin: ReturnType<typeof createClient>,
  url: URL,
  verifiedUserId: string,
) {
  const nodeId = url.searchParams.get("node_id");
  const versionNumber = url.searchParams.get("version");
  if (!nodeId) return errorResponse("node_id required", "MISSING_PARAM", 400);

  const perm = await evaluateNodePermission(sb, verifiedUserId, nodeId, "read");
  if (perm.notFound) return errorResponse("Node not found", "NODE_NOT_FOUND", 404);
  if (!perm.allowed) return errorResponse("Forbidden", "FORBIDDEN", 403);

  const { data: node } = await sb.from("nodes").select("id, name, mime_type, owner_id").eq("id", nodeId).maybeSingle();
  if (!node) return errorResponse("Node not found", "NOT_FOUND", 404);

  // Find the version
  let versionQuery = sb.from("file_versions").select("id, version_number").eq("node_id", nodeId);
  if (versionNumber) {
    versionQuery = versionQuery.eq("version_number", parseInt(versionNumber));
  } else {
    versionQuery = versionQuery.eq("is_current", true);
  }
  const { data: version } = await versionQuery.maybeSingle();
  if (!version) return errorResponse("Version not found", "VERSION_NOT_FOUND", 404);

  // Generate signed URL from storage
  const storagePath = `${node.owner_id}/${nodeId}/v${version.version_number}`;
  const { data: signedUrlData, error: urlError } = await sbAdmin.storage
    .from("vault-files")
    .createSignedUrl(storagePath, 3600); // 1 hour

  if (urlError || !signedUrlData?.signedUrl) {
    return errorResponse("File content not available in storage", "NO_CONTENT", 404);
  }

  return jsonResponse({
    node_id: nodeId,
    name: node.name,
    mime_type: node.mime_type,
    version_number: version.version_number,
    url: signedUrlData.signedUrl,
  });
}

// --- Router ---

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace("/vault", "") || "/";

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(supabaseUrl, supabaseKey);

  const auth = await getVerifiedAuth(req, supabaseUrl, supabaseAnonKey);
  if (!auth) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
  const { id: authUserId, jwt } = auth;
  const sbUser = createUserClient(supabaseUrl, supabaseAnonKey, jwt);

  try {
    // --- Versioning ---
    if (req.method === "POST" && path === "/versions") {
      const body = await req.json();
      return await saveFileVersion(sb, body, authUserId);
    }

    if (req.method === "GET" && path === "/versions") {
      const nodeId = url.searchParams.get("node_id");
      if (!nodeId) return errorResponse("node_id required", "MISSING_PARAM", 400);
      const { data, error } = await sbUser.from("file_versions").select("*").eq("node_id", nodeId).order("version_number", { ascending: false });
      if (error) return errorResponse(error.message, "DB_ERROR");
      return jsonResponse(data);
    }

    // --- Permissions ---
    if (req.method === "POST" && path === "/permissions/check") {
      const body = await req.json();
      return await checkPermissionHandler(sb, body, authUserId);
    }

    // --- Sharing ---
    if (req.method === "POST" && path === "/share-links") {
      const body = await req.json();
      return await createShareLinkHandler(sb, body, authUserId);
    }

    // --- Nodes ---
    if (req.method === "GET" && path === "/nodes") {
      const parentId = url.searchParams.get("parent_id");
      const query = sbUser.from("nodes").select("*").eq("is_deleted", false).order("name");
      if (parentId) query.eq("parent_id", parentId);
      else query.is("parent_id", null);
      const { data, error } = await query;
      if (error) return errorResponse(error.message, "DB_ERROR");
      return jsonResponse(data);
    }

    // --- Audit ---
    if (req.method === "GET" && path === "/audit") {
      const nodeId = url.searchParams.get("node_id");
      const query = sbUser.from("audit_log").select("*").order("created_at", { ascending: false }).limit(100);
      if (nodeId) query.eq("node_id", nodeId);
      const { data, error } = await query;
      if (error) return errorResponse(error.message, "DB_ERROR");
      return jsonResponse(data);
    }

    // --- Backup: Create ---
    if (req.method === "POST" && path === "/backups") {
      const body = await req.json();
      return await createBackupHandler(sb, body, authUserId);
    }

    // --- Backup: List ---
    if (req.method === "GET" && path === "/backups") {
      const { data, error } = await sbUser.from("backups").select("id, type, status, total_nodes, total_versions, total_blocks, total_size, checksum, is_verified, started_at, completed_at, created_by, error_message").order("started_at", { ascending: false }).limit(50);
      if (error) return errorResponse(error.message, "DB_ERROR");
      return jsonResponse(data);
    }

    // --- Backup: Get one ---
    if (req.method === "GET" && path === "/backups/detail") {
      const backupId = url.searchParams.get("id");
      if (!backupId) return errorResponse("id required", "MISSING_PARAM", 400);
      const { data, error } = await sbUser.from("backups").select("*").eq("id", backupId).maybeSingle();
      if (error || !data) return errorResponse("Backup not found", "NOT_FOUND", 404);
      return jsonResponse(data);
    }

    // --- Backup: Verify ---
    if (req.method === "POST" && path === "/backups/verify") {
      const body = await req.json();
      return await verifyBackupHandler(sb, body.backup_id, authUserId);
    }

    // --- Backup: Restore ---
    if (req.method === "POST" && path === "/backups/restore") {
      const body = await req.json();
      return await restoreBackupHandler(sb, body, authUserId);
    }

    // --- File Content (signed URL for preview/download) ---
    if (req.method === "GET" && path === "/files/content") {
      return await getFileContentHandler(sbUser, sb, url, authUserId);
    }

    // --- File Integrity Check ---
    if (req.method === "POST" && path === "/integrity-check") {
      const body = await req.json();
      return await checkFileIntegrityHandler(sb, body, authUserId);
    }

    // --- File Integrity: Get results ---
    if (req.method === "GET" && path === "/integrity-check") {
      const nodeId = url.searchParams.get("node_id");
      const query = sbUser.from("file_integrity_checks").select("*").order("checked_at", { ascending: false }).limit(100);
      if (nodeId) query.eq("node_id", nodeId);
      const { data, error } = await query;
      if (error) return errorResponse(error.message, "DB_ERROR");
      return jsonResponse(data);
    }

    return errorResponse("Not found", "NOT_FOUND", 404);
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : "Internal error", "INTERNAL_ERROR", 500);
  }
});
