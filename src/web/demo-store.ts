import { v4 as uuidv4 } from 'uuid';

type Row = Record<string, any>;
type Filter = (row: Row) => boolean;

type DemoTable =
  | 'nodes'
  | 'file_versions'
  | 'data_blocks'
  | 'file_version_blocks'
  | 'audit_log'
  | 'user_profiles'
  | 'share_links'
  | 'access_control_lists'
  | 'version_comments'
  | 'file_integrity_checks'
  | 'products'
  | 'server_config'
  | 'connection_config'
  | 'file_extensions'
  | 'bom_items';

interface DemoDb {
  nodes: Row[];
  file_versions: Row[];
  data_blocks: Row[];
  file_version_blocks: Row[];
  audit_log: Row[];
  user_profiles: Row[];
  share_links: Row[];
  access_control_lists: Row[];
  version_comments: Row[];
  file_integrity_checks: Row[];
  products: Row[];
  server_config: Row[];
  connection_config: Row[];
  file_extensions: Row[];
  bom_items: Row[];
}

const STORAGE_KEY = 'vault-demo-db-v1';
const DEMO_USER = {
  id: 'demo-user',
  email: 'demo@vault.local',
  full_name: 'Demo User',
  role: 'owner',
};

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function createSeedDb(): DemoDb {
  const uid = DEMO_USER.id;
  const docsId = uuidv4();
  const projectsId = uuidv4();
  const archiveId = uuidv4();
  const mechId = uuidv4();
  const elecId = uuidv4();

  const fileA = uuidv4();
  const fileB = uuidv4();
  const fileC = uuidv4();
  const fileD = uuidv4();
  const trashFile = uuidv4();
  const archivedFile = uuidv4();

  const versionA1 = uuidv4();
  const versionA2 = uuidv4();
  const versionB1 = uuidv4();
  const versionC1 = uuidv4();
  const versionD1 = uuidv4();
  const versionTrash = uuidv4();
  const versionArchived = uuidv4();

  const hashA = 'a'.repeat(64);
  const hashB = 'b'.repeat(64);
  const hashC = 'c'.repeat(64);
  const hashD = 'd'.repeat(64);
  const hashTrash = 'e'.repeat(64);
  const hashArchived = 'f'.repeat(64);

  return {
    nodes: [
      { id: docsId, parent_id: null, owner_id: uid, name: 'Документы', node_type: 'folder', path: '/Документы', size: 0, is_deleted: false, is_archived: false, created_at: '2025-03-01T09:00:00Z', updated_at: '2025-03-01T09:00:00Z' },
      { id: projectsId, parent_id: null, owner_id: uid, name: 'Проекты', node_type: 'folder', path: '/Проекты', size: 0, is_deleted: false, is_archived: false, created_at: '2025-03-01T09:05:00Z', updated_at: '2025-03-01T09:05:00Z' },
      { id: archiveId, parent_id: null, owner_id: uid, name: 'Архив', node_type: 'folder', path: '/Архив', size: 0, is_deleted: false, is_archived: true, created_at: '2025-03-01T09:10:00Z', updated_at: '2025-04-01T09:10:00Z' },
      { id: mechId, parent_id: docsId, owner_id: uid, name: 'Механика', node_type: 'folder', path: '/Документы/Механика', size: 0, is_deleted: false, is_archived: false, created_at: '2025-03-01T09:15:00Z', updated_at: '2025-03-01T09:15:00Z' },
      { id: elecId, parent_id: docsId, owner_id: uid, name: 'Электрика', node_type: 'folder', path: '/Документы/Электрика', size: 0, is_deleted: false, is_archived: false, created_at: '2025-03-01T09:16:00Z', updated_at: '2025-03-01T09:16:00Z' },
      { id: fileA, parent_id: mechId, owner_id: uid, name: 'Сборка.pdf', node_type: 'file', path: '/Документы/Механика/Сборка.pdf', mime_type: 'application/pdf', size: 248320, is_deleted: false, is_archived: false, created_at: '2025-03-03T12:00:00Z', updated_at: '2025-03-03T12:00:00Z' },
      { id: fileB, parent_id: mechId, owner_id: uid, name: 'ТЗ.md', node_type: 'file', path: '/Документы/Механика/ТЗ.md', mime_type: 'text/markdown', size: 4288, is_deleted: false, is_archived: false, created_at: '2025-03-04T08:30:00Z', updated_at: '2025-03-04T08:30:00Z' },
      { id: fileC, parent_id: elecId, owner_id: uid, name: 'Схема.svg', node_type: 'file', path: '/Документы/Электрика/Схема.svg', mime_type: 'image/svg+xml', size: 35200, is_deleted: false, is_archived: false, created_at: '2025-03-05T10:20:00Z', updated_at: '2025-03-05T10:20:00Z' },
      { id: fileD, parent_id: projectsId, owner_id: uid, name: 'Отчет.csv', node_type: 'file', path: '/Проекты/Отчет.csv', mime_type: 'text/csv', size: 18344, is_deleted: false, is_archived: false, created_at: '2025-03-06T14:10:00Z', updated_at: '2025-03-06T14:10:00Z' },
      { id: trashFile, parent_id: projectsId, owner_id: uid, name: 'Старый_черновик.txt', node_type: 'file', path: '/Проекты/Старый_черновик.txt', mime_type: 'text/plain', size: 1112, is_deleted: true, deleted_at: '2025-04-03T14:10:00Z', is_archived: false, created_at: '2025-03-07T08:00:00Z', updated_at: '2025-04-03T14:10:00Z' },
      { id: archivedFile, parent_id: docsId, owner_id: uid, name: 'Регламент.docx', node_type: 'file', path: '/Документы/Регламент.docx', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 84240, is_deleted: false, is_archived: true, created_at: '2025-03-08T09:45:00Z', updated_at: '2025-04-10T09:45:00Z' },
    ],
    file_versions: [
      { id: versionA1, node_id: fileA, version_number: 1, total_size: 224000, content_hash: hashA, encrypted_key: [], key_nonce: [], is_current: false, is_compressed: false, created_by: uid, created_at: '2025-03-03T12:00:00Z', comment: 'Первая версия' },
      { id: versionA2, node_id: fileA, version_number: 2, total_size: 248320, content_hash: hashB, encrypted_key: [], key_nonce: [], is_current: true, is_compressed: false, created_by: uid, created_at: '2025-03-03T13:30:00Z', comment: 'Актуализировано' },
      { id: versionB1, node_id: fileB, version_number: 1, total_size: 4288, content_hash: hashC, encrypted_key: [], key_nonce: [], is_current: true, is_compressed: false, created_by: uid, created_at: '2025-03-04T08:30:00Z', comment: 'Исходный черновик' },
      { id: versionC1, node_id: fileC, version_number: 1, total_size: 35200, content_hash: hashD, encrypted_key: [], key_nonce: [], is_current: true, is_compressed: false, created_by: uid, created_at: '2025-03-05T10:20:00Z', comment: 'Схема' },
      { id: versionD1, node_id: fileD, version_number: 1, total_size: 18344, content_hash: hashD, encrypted_key: [], key_nonce: [], is_current: true, is_compressed: false, created_by: uid, created_at: '2025-03-06T14:10:00Z', comment: 'Загрузка отчета' },
      { id: versionTrash, node_id: trashFile, version_number: 1, total_size: 1112, content_hash: hashTrash, encrypted_key: [], key_nonce: [], is_current: true, is_compressed: false, created_by: uid, created_at: '2025-03-07T08:00:00Z', comment: 'Черновик' },
      { id: versionArchived, node_id: archivedFile, version_number: 1, total_size: 84240, content_hash: hashArchived, encrypted_key: [], key_nonce: [], is_current: true, is_compressed: false, created_by: uid, created_at: '2025-03-08T09:45:00Z', comment: 'Архивная копия' },
    ],
    data_blocks: [
      { id: uuidv4(), content_hash: hashA, encrypted_hash: hashA, size: 224000, encrypted_size: 224016, physical_path: `/vault/blocks/${hashA.slice(0, 2)}/${hashA}`, compression: 'none', ref_count: 1, created_at: '2025-03-03T12:00:00Z' },
      { id: uuidv4(), content_hash: hashB, encrypted_hash: hashB, size: 248320, encrypted_size: 248336, physical_path: `/vault/blocks/${hashB.slice(0, 2)}/${hashB}`, compression: 'none', ref_count: 1, created_at: '2025-03-03T13:30:00Z' },
      { id: uuidv4(), content_hash: hashC, encrypted_hash: hashC, size: 4288, encrypted_size: 4304, physical_path: `/vault/blocks/${hashC.slice(0, 2)}/${hashC}`, compression: 'none', ref_count: 1, created_at: '2025-03-04T08:30:00Z' },
      { id: uuidv4(), content_hash: hashD, encrypted_hash: hashD, size: 35200, encrypted_size: 35216, physical_path: `/vault/blocks/${hashD.slice(0, 2)}/${hashD}`, compression: 'none', ref_count: 2, created_at: '2025-03-05T10:20:00Z' },
      { id: uuidv4(), content_hash: hashTrash, encrypted_hash: hashTrash, size: 1112, encrypted_size: 1128, physical_path: `/vault/blocks/${hashTrash.slice(0, 2)}/${hashTrash}`, compression: 'none', ref_count: 1, created_at: '2025-03-07T08:00:00Z' },
      { id: uuidv4(), content_hash: hashArchived, encrypted_hash: hashArchived, size: 84240, encrypted_size: 84256, physical_path: `/vault/blocks/${hashArchived.slice(0, 2)}/${hashArchived}`, compression: 'none', ref_count: 1, created_at: '2025-03-08T09:45:00Z' },
    ],
    file_version_blocks: [
      { id: uuidv4(), version_id: versionA1, block_id: 'block-a', block_index: 0, block_offset: 0 },
      { id: uuidv4(), version_id: versionA2, block_id: 'block-b', block_index: 0, block_offset: 0 },
      { id: uuidv4(), version_id: versionB1, block_id: 'block-c', block_index: 0, block_offset: 0 },
      { id: uuidv4(), version_id: versionC1, block_id: 'block-d', block_index: 0, block_offset: 0 },
      { id: uuidv4(), version_id: versionD1, block_id: 'block-d', block_index: 0, block_offset: 0 },
      { id: uuidv4(), version_id: versionTrash, block_id: 'block-trash', block_index: 0, block_offset: 0 },
      { id: uuidv4(), version_id: versionArchived, block_id: 'block-archived', block_index: 0, block_offset: 0 },
    ],
    audit_log: [
      { id: uuidv4(), user_id: uid, node_id: fileA, action: 'version_create', details: { version_number: 1 }, created_at: '2025-03-03T12:00:00Z' },
      { id: uuidv4(), user_id: uid, node_id: fileA, action: 'version_create', details: { version_number: 2 }, created_at: '2025-03-03T13:30:00Z' },
      { id: uuidv4(), user_id: uid, node_id: fileB, action: 'version_create', details: { version_number: 1 }, created_at: '2025-03-04T08:30:00Z' },
      { id: uuidv4(), user_id: uid, node_id: fileC, action: 'version_create', details: { version_number: 1 }, created_at: '2025-03-05T10:20:00Z' },
      { id: uuidv4(), user_id: uid, node_id: fileD, action: 'version_create', details: { version_number: 1 }, created_at: '2025-03-06T14:10:00Z' },
    ],
    user_profiles: [
      DEMO_USER,
      { id: 'demo-anna', email: 'anna@example.local', full_name: 'Анна Петрова', role: 'editor', created_at: '2025-03-01T09:00:00Z' },
      { id: 'demo-oleg', email: 'oleg@example.local', full_name: 'Олег Смирнов', role: 'viewer', created_at: '2025-03-01T09:00:00Z' },
    ],
    share_links: [
      { id: uuidv4(), node_id: fileA, token: 'share-demo-a', permission: 'read', access_count: 3, is_active: true, expires_at: null, created_at: '2025-04-01T10:00:00Z' },
    ],
    access_control_lists: [
      { id: uuidv4(), node_id: fileA, user_id: 'demo-anna', permission: 'write', inherited: false },
    ],
    version_comments: [
      { id: uuidv4(), version_id: versionA2, user_id: 'demo-anna', comment: 'Проверено, можно двигаться дальше', created_at: '2025-04-02T11:00:00Z' },
    ],
    file_integrity_checks: [],
    products: [
      { id: uuidv4(), code: 'PLM-100', name: 'Набор корпуса', lifecycle_stage: 'design', status: 'active' },
      { id: uuidv4(), code: 'PLM-200', name: 'Контроллер', lifecycle_stage: 'engineering', status: 'active' },
    ],
    server_config: [
      { key: 'max_storage_gb', value: '100' },
      { key: 'deploy_target', value: 'demo' },
    ],
    connection_config: [
      { key: 'supabase_url', value: '', is_encrypted: false },
      { key: 'supabase_anon_key', value: '', is_encrypted: true },
      { key: 'supabase_service_role_key', value: '', is_encrypted: true },
    ],
    file_extensions: [
      { id: uuidv4(), extension: 'pdf', mime_type: 'application/pdf', viewer_type: 'iframe', viewer_library: null, is_active: true },
      { id: uuidv4(), extension: 'md', mime_type: 'text/markdown', viewer_type: 'text', viewer_library: null, is_active: true },
      { id: uuidv4(), extension: 'csv', mime_type: 'text/csv', viewer_type: 'text', viewer_library: null, is_active: true },
    ],
    bom_items: [],
  };
}

function loadDb(): DemoDb {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as DemoDb;
  } catch {}
  return createSeedDb();
}

function saveDb(db: DemoDb) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch {}
}

function ensureIds(row: Row) {
  if (!row.id) row.id = uuidv4();
  if (!row.created_at) row.created_at = nowIso();
  if (!row.updated_at) row.updated_at = row.created_at;
  return row;
}

function normalizeLike(value: string) {
  return value.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
}

class DemoQuery {
  private filters: Filter[] = [];
  private orderings: { field: string; ascending: boolean }[] = [];
  private limitCount: number | null = null;
  private head = false;
  private countRequested = false;
  private columns = '*';

  constructor(private db: DemoDb, private table: DemoTable) {}

  select(columns: string = '*', opts: any = {}) {
    this.columns = columns;
    this.head = !!opts?.head;
    this.countRequested = opts?.count === 'exact';
    return this;
  }

  eq(field: string, value: any) {
    this.filters.push((row) => row[field] === value);
    return this;
  }

  neq(field: string, value: any) {
    this.filters.push((row) => row[field] !== value);
    return this;
  }

  is(field: string, value: any) {
    this.filters.push((row) => {
      if (value === null) return row[field] === null || row[field] === undefined;
      return row[field] === value;
    });
    return this;
  }

  ilike(field: string, value: string) {
    const rx = new RegExp(`^${normalizeLike(value.toLowerCase())}$`);
    this.filters.push((row) => String(row[field] ?? '').toLowerCase().match(rx) !== null);
    return this;
  }

  in(field: string, values: any[]) {
    const set = new Set(values);
    this.filters.push((row) => set.has(row[field]));
    return this;
  }

  order(field: string, opts: { ascending?: boolean } = {}) {
    this.orderings.push({ field, ascending: opts.ascending !== false });
    return this;
  }

  limit(count: number) {
    this.limitCount = count;
    return this;
  }

  lt(field: string, value: any) {
    this.filters.push((row) => row[field] < value);
    return this;
  }

  lte(field: string, value: any) {
    this.filters.push((row) => row[field] <= value);
    return this;
  }

  gt(field: string, value: any) {
    this.filters.push((row) => row[field] > value);
    return this;
  }

  gte(field: string, value: any) {
    this.filters.push((row) => row[field] >= value);
    return this;
  }

  private getRows() {
    let rows = [...(this.db[this.table] as Row[])];
    rows = rows.filter((row) => this.filters.every((fn) => fn(row)));
    for (const { field, ascending } of this.orderings.slice().reverse()) {
      rows.sort((a, b) => {
        const av = a[field];
        const bv = b[field];
        if (av === bv) return 0;
        return (av > bv ? 1 : -1) * (ascending ? 1 : -1);
      });
    }
    if (this.limitCount !== null) rows = rows.slice(0, this.limitCount);
    return rows;
  }

  private attachRelations(rows: Row[]) {
    if (this.table === 'share_links') {
      const nodes = this.db.nodes;
      return rows.map((row) => ({ ...row, nodes: nodes.find((n) => n.id === row.node_id) || null }));
    }
    if (this.table === 'file_integrity_checks') {
      const nodes = this.db.nodes;
      return rows.map((row) => ({ ...row, nodes: nodes.find((n) => n.id === row.node_id) || null }));
    }
    if (this.table === 'version_comments') {
      const users = this.db.user_profiles;
      return rows.map((row) => ({ ...row, user_profiles: users.find((u) => u.id === row.user_id) || null }));
    }
    if (this.table === 'access_control_lists') {
      const users = this.db.user_profiles;
      return rows.map((row) => ({ ...row, user_profiles: users.find((u) => u.id === row.user_id) || null }));
    }
    return rows;
  }

  private execSelect() {
    const rows = this.attachRelations(this.getRows());
    if (this.head) {
      return { data: null, error: null, count: rows.length };
    }
    return { data: rows, error: null, count: this.countRequested ? rows.length : null };
  }

  then<TResult1 = any, TResult2 = never>(
    onfulfilled?: ((value: any) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ) {
    return Promise.resolve(this.execSelect()).then(onfulfilled, onrejected);
  }

  maybeSingle() {
    return Promise.resolve(this.execSelect()).then((res) => ({
      ...res,
      data: Array.isArray(res.data) ? res.data[0] ?? null : res.data,
    }));
  }

  insert(values: Row | Row[]) {
    const rows = Array.isArray(values) ? values : [values];
    const prepared = rows.map((row) => ensureIds({ ...deepClone(row) }));
    this.db[this.table].push(...prepared);
    saveDb(this.db);
    return Promise.resolve({ data: prepared, error: null });
  }

  update(values: Row) {
    const updated: Row[] = [];
    for (const row of this.db[this.table]) {
      if (this.filters.every((fn) => fn(row))) {
        Object.assign(row, deepClone(values), { updated_at: nowIso() });
        updated.push(row);
      }
    }
    saveDb(this.db);
    return Promise.resolve({ data: updated, error: null });
  }

  delete() {
    const remaining: Row[] = [];
    const deleted: Row[] = [];
    for (const row of this.db[this.table]) {
      if (this.filters.every((fn) => fn(row))) deleted.push(row);
      else remaining.push(row);
    }
    this.db[this.table] = remaining;
    saveDb(this.db);
    return Promise.resolve({ data: deleted, error: null, count: deleted.length });
  }
}

class DemoStorageBucket {
  upload(_path: string, _file: Blob | File, _opts?: any) {
    return Promise.resolve({ data: { path: _path }, error: null });
  }
}

class DemoStorage {
  from(_name: string) {
    return new DemoStorageBucket();
  }
}

class DemoAuth {
  async getSession() {
    return { data: { session: { access_token: 'demo-token', user: DEMO_USER } } };
  }

  async signOut() {
    return { error: null };
  }

  async signInWithPassword() {
    return { error: null };
  }

  async signUp() {
    return { error: null };
  }

  async resetPasswordForEmail() {
    return { error: null };
  }

  async updateUser() {
    return { error: null };
  }

  onAuthStateChange() {
    return { data: { subscription: { unsubscribe() {} } } };
  }

  mfa = {
    getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal2' } }),
    listFactors: async () => ({ data: { all: [] } }),
    challenge: async () => ({ data: { id: 'demo-challenge' } }),
    verify: async () => ({ error: null }),
    enroll: async () => ({ data: null, error: new Error('Demo mode') }),
  };

  async getActiveSessions() {
    return [];
  }

  async revokeSession() {}

  async revokeAllOtherSessions() {}

  async enable2FA() {
    return null;
  }

  async verify2FASetup() {
    return { error: null };
  }

  async disable2FA() {
    return { error: null };
  }
}

class DemoClient {
  public storage = new DemoStorage();
  public auth = new DemoAuth();
  constructor(private db: DemoDb) {}

  from(table: DemoTable) {
    return new DemoQuery(this.db, table);
  }

  rpc(name: string, args: any) {
    if (name === 'decrement_block_ref_count') {
      const block = this.db.data_blocks.find((b) => b.id === args?.block_id);
      if (block) block.ref_count = Math.max(0, (block.ref_count || 0) - 1);
      saveDb(this.db);
      return Promise.resolve({ data: true, error: null });
    }
    return Promise.resolve({ data: null, error: new Error(`Unsupported rpc: ${name}`) });
  }
}

export function createDemoRuntime() {
  const db = loadDb();
  saveDb(db);
  return {
    client: new DemoClient(db),
    auth: new DemoAuth(),
    user: deepClone(DEMO_USER),
  };
}
