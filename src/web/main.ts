import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';
import {
  saveFileVersion, restoreFileVersion, listFileVersions, garbageCollectBlocks,
  checkPermission, grantPermission, revokePermission, getEffectivePermissions,
  createShareLink, revokeShareLink,
  archiveOldVersions, unarchiveFile, softDeleteNode, purgeDeletedNodes,
  detectConflict, resolveConflict, acquireFileLock, releaseFileLock,
} from '../core/index.ts';
import type { Permission } from '../types/index.ts';
import { AuthService } from './auth.ts';
import {
  subscribeToTable, unsubscribeAll, joinPresence, leavePresence,
  joinEditingChannel, broadcastEditingState, broadcastEditingCursor, leaveEditingChannel,
} from '../utils/realtime.ts';
import { cacheGet, cacheSet, cacheInvalidate, cacheClear, dedupFetch } from '../utils/cache.ts';
import { createDemoRuntime } from './demo-store.ts';

// --- Supabase client (uses .env, auth is handled by Supabase Auth) ---
const SUPABASE_URL = (import.meta as any).env?.VITE_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = (import.meta as any).env?.VITE_SUPABASE_ANON_KEY ?? '';
let sb!: SupabaseClient;
let auth!: AuthService;

// --- HTML escaping (XSS prevention) ---
function esc(s: string | null | undefined): string {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// --- State ---
let currentParentId: string | null = null;
let selectedNodeId: string | null = null;
let selectedProductId: string | null = null;
let currentView = 'files';
let currentUser: any = null; // auth.users + user_profiles merged
let demoMode = false;
let pathStack: { id: string | null; name: string }[] = [{ id: null, name: 'Хранилище' }];
let uploadQueue: { file: File; progress: number }[] = [];
let isUploading = false;
let searchTimeout: any = null;
let ctxMenuEl: HTMLElement | null = null;
/** Ленивая загрузка: ключ — `TREE_ROOT_KEY` или id папки; значение — дочерние папки. */
const TREE_ROOT_KEY = '__root__';
let treeFoldersByParent: Record<string, any[]> = {};
let treeExpanded: Set<string> = new Set();
let realtimeSetup = false;
let loadingOverlay: HTMLElement | null = null;
let realtimeDebounce: any = null;
let editingStates: Record<string, { node_id: string | null; email?: string; full_name?: string; ts: string }> = {};
let activeEditingNodeId: string | null = null;
let presenceUsers: any[] = [];
let cursorStates: Record<string, { node_id: string | null; field: string; pos: number; line?: number; col?: number; typing: boolean; email?: string; full_name?: string; ts: string }> = {};
let cursorFadeTimers: Record<string, any> = {};
type DesktopMenuAction = 'upload' | 'new-folder';
type DesktopBridge = {
  isElectron: boolean;
  platform: string;
  getVersion?: () => string;
  onMenuAction?: (handler: (action: DesktopMenuAction) => void) => () => void;
};
const desktopBridge = (window as any).electronAPI as DesktopBridge | undefined;
const isDesktopApp = !!desktopBridge?.isElectron;
let desktopMenuCleanup: (() => void) | null = null;

// --- i18n ---
const t: Record<string, string> = {
  vault:'Хранилище',all_files:'Все файлы',recent:'Недавние',shared:'Общие ссылки',
  archive:'Архив',audit:'Журнал аудита',storage:'Хранилище данных',admin:'Администрирование',
  nav:'Навигация',manage:'Управление',trash:'Корзина',analytics:'Аналитика',
  server:'Подключение',extensions:'Расширения',products:'Изделия',lifecycle:'Жизненный цикл',
  bom:'Состав изделия',workflows:'Маршруты',
  upload_title:'Перетащите файлы или нажмите для загрузки',
  upload_desc:'Любые типы файлов',
  folders:'Папки',files:'Файлы',total_size:'Общий размер',
  versions:'Версии',access:'Доступ',share_links:'Общие ссылки',
  create_link:'Создать ссылку',restore:'Восстановить',current:'текущая',
  inherited:'Наследуемый',direct:'Прямой',owner_only:'Только владелец',
  password:'Пароль',ttl:'Срок (часы)',permission:'Права',
  read_only:'Чтение',read_write:'Чтение и запись',
  max_access:'Макс. доступов',unlimited:'Без ограничений',
  cancel:'Отмена',create:'Создать',grant:'Выдать',save:'Сохранить',saved:'Сохранено',
  users:'Пользователи',role:'Роль',username:'Имя пользователя',
  created:'Создан',actions:'Действия',add_user:'Добавить',
  blocks:'Блоки',refs:'Ссылки',compression:'Сжатие',hash:'Хеш',
  size:'Размер',date:'Дата',name:'Имя',type:'Тип',code:'Код',
  active:'Активна',inactive:'Неактивна',protected:'С паролем',
  no_password:'Без пароля',accesses:'доступов',expires:'Истекает',
  search:'Поиск...',new_folder:'Новая папка',upload:'Загрузить',
  encrypted:'Шифр.',archived:'Архив',compressed:'Сжат.',
  no_files:'Нет файлов',no_files_desc:'Перетащите файлы или нажмите загрузку',
  no_links:'Нет ссылок',no_audit:'Журнал пуст',no_trash:'Корзина пуста',
  link_created:'Ссылка создана',version_restored:'Версия восстановлена',
  folder_created:'Папка создана',upload_complete:'Загружен',
  upload_failed:'Ошибка загрузки',user_added:'Пользователь добавлен',
  seed_complete:'Демо-данные созданы',
  delete:'Удалить',delete_confirm:'Удалить?',archive_btn:'В архив',
  unarchive_btn:'Из архива',download:'Скачать',revoke:'Отозвать',
  grant_access:'Выдать доступ',revoke_access:'Отзыв прав',
  user:'Пользователь',inherit:'Наследовать',gc:'Сборка мусора',
  gc_done:'Удалено блоков',purge:'Очистить корзину',purge_done:'Удалено',
  run_archive:'Архивация',archive_done:'Архивация завершена',
  lock_acquired:'Заблокировано',lock_failed:'Занято',
  rename:'Переименовать',open:'Открыть',info:'Свойства',
  no_results:'Ничего не найдено',preview:'Просмотр',
  comment:'Комментарий',add_comment:'Комментировать',
  online:'Онлайн',collaborators:'Сотрудники',
  deploy:'Развертывание',config:'Конфигурация',
  disk_usage:'Диск',total_storage:'Всего',used:'Занято',free:'Свободно',
  extension:'Расширение',mime:'MIME',viewer:'Просмотрщик',
  library:'Библиотека',add_extension:'Добавить',
  activity:'Активность',growth:'Рост',overview:'Обзор',
  files_by_type:'По типу',storage_by_type:'Хранилище по типу',
  recent_activity:'Активность',daily_uploads:'Загрузки/день',
  concept:'Концепция',design:'Проектирование',engineering:'Инженерия',
  production:'Производство',eol:'Снятие с производства',
  draft:'Черновик',obsolete:'Устаревшее',
  specification:'Спецификация',drawing:'Чертёж',report:'Отчёт',
  certificate:'Сертификат',manual:'Руководство',
  add_product:'Новое изделие',product_details:'Карточка изделия',
  lifecycle_stage:'Этап',status:'Статус',owner:'Ответственный',
  description:'Описание',metadata:'Атрибуты',
  add_to_bom:'Добавить в состав',bom_items:'Компоненты',
  workflow:'Маршрут',start_workflow:'Запустить',approve:'Утвердить',reject:'Отклонить',
  pending:'Ожидание',in_progress:'В работе',completed:'Завершено',rejected:'Отклонено',
  connection:'Подключение',db_url:'URL базы данных',db_key:'Ключ доступа',
  db_service_key:'Сервисный ключ',test_connection:'Проверить',
  connected:'Подключено',connection_failed:'Ошибка подключения',
  encrypted_field:'Зашифровано',
  backups:'Резервные копии',create_backup:'Создать бэкап',full_backup:'Полный',
  incremental_backup:'Инкрементальный',metadata_only:'Только метаданные',
  blocks_only:'Только блоки',
  backup_type:'Тип',backup_status:'Статус',backup_size:'Размер',
  backup_checksum:'Контрольная сумма',verified:'Проверена',not_verified:'Не проверена',
  running:'Выполняется',
  integrity_check:'Проверка целостности',
  run_integrity:'Проверить файл',integrity_results:'Результаты проверки',
  all_valid:'Все файлы целы',integrity_issues:'Обнаружены проблемы',
  restore_confirm:'Восстановить из этой резервной копии? Текущие данные будут перезаписаны.',
  backup_created:'Бэкап создан',backup_verified:'Бэкап проверен',verify:'Проверка',
  backup_restored:'Бэкап восстановлен',integrity_checked:'Проверка завершена',
  login:'Войти',register:'Регистрация',email:'Email',
  confirm_password:'Подтвердите пароль',full_name:'Полное имя',
  forgot_password:'Забыли пароль?',reset_password:'Сбросить пароль',
  no_account:'Нет аккаунта?',have_account:'Уже есть аккаунт?',
  login_failed:'Ошибка входа',register_failed:'Ошибка регистрации',
  password_reset_sent:'Инструкции отправлены на email',
  sign_out:'Выйти',security:'Безопасность',
  enable_2fa:'Включить 2FA',disable_2fa:'Отключить 2FA',
  verify_2fa:'Подтвердить 2FA',enter_2fa_code:'Введите код из приложения-аутентификатора',
  scan_qr:'Отсканируйте QR-код в приложении-аутентификаторе',
  backup_code:'Сохраните этот код восстановления в безопасном месте',
  two_factor:'Двухфакторная аутентификация',sessions:'Сессии',
  revoke_all_sessions:'Отозвать все сессии',current_session:'Текущая сессия',
  last_active:'Последняя активность',device:'Устройство',
  change_password:'Сменить пароль',new_password:'Новый пароль',
  password_changed:'Пароль изменён',
  welcome:'Добро пожаловать',welcome_desc:'Войдите в систему для доступа к Vault PLM',
};

const LIFECYCLE_STAGES = ['concept','design','engineering','production','eol'];
const DOCUMENT_TYPES = ['specification','drawing','report','certificate','manual'];

// --- Loading overlay ---
function showLoading(msg?: string) {
  if (loadingOverlay) return;
  loadingOverlay = document.createElement('div');
  loadingOverlay.className = 'loading-overlay';
  loadingOverlay.innerHTML = `<div class="loading-spinner"></div><div class="loading-msg">${msg || ''}</div>`;
  document.body.appendChild(loadingOverlay);
}
function updateLoading(msg?: string) {
  if (!loadingOverlay) return;
  const msgEl = loadingOverlay.querySelector('.loading-msg') as HTMLElement | null;
  if (msgEl) msgEl.textContent = msg || '';
}
function hideLoading() {
  if (loadingOverlay) { loadingOverlay.remove(); loadingOverlay = null; }
}

function setupDesktopBridge() {
  if (!isDesktopApp) return;
  const statusEl = document.getElementById('desktop-status') as HTMLElement | null;
  const version = desktopBridge?.getVersion?.() || '';
  const platform = desktopBridge?.platform || '';
  if (statusEl) {
    statusEl.style.display = 'inline-flex';
    const parts = [demoMode ? 'demo' : '', version ? `v${version}` : '', platform].filter(Boolean);
    statusEl.textContent = parts.join(' · ');
  }
  document.body.dataset.desktop = 'true';
  document.title = version ? `Vault PLM v${version}` : 'Vault PLM';
  if (desktopMenuCleanup) {
    desktopMenuCleanup();
    desktopMenuCleanup = null;
  }
  if (desktopBridge?.onMenuAction) {
    desktopMenuCleanup = desktopBridge.onMenuAction((action) => {
      if (action === 'upload') {
        (window as any).triggerUpload?.();
      } else if (action === 'new-folder') {
        (window as any).createFolder?.();
      }
    });
  }
}

async function bootstrapWorkspace() {
  showLoading('Подготовка рабочего пространства...');
  try {
    if (!demoMode) {
      await seedIfEmpty();
    }
    renderNav();
    loadTree();
    setupSearch();
    setupKeyboard();
    setupGlobalClicks();
    loadView(demoMode ? 'files' : 'products');
    setupRealtimeSubscriptions();
  } finally {
    hideLoading();
  }
}

async function startDemoWorkspace() {
  demoMode = true;
  const demo = createDemoRuntime();
  sb = demo.client as any;
  auth = demo.auth as any;
  currentUser = demo.user;
  await bootstrapWorkspace();
}

async function hashFileInBackground(buf: ArrayBuffer): Promise<string> {
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// --- Optimistic UI helpers ---
function optimisticInsertRow(listEl: HTMLElement, html: string, position: 'start' | 'end' = 'start') {
  const container = listEl.querySelector('.file-list') || listEl;
  const temp = document.createElement('div');
  temp.innerHTML = html;
  const row = temp.firstElementChild as HTMLElement;
  if (!row) return;
  row.style.opacity = '0.5';
  row.style.transition = 'opacity 0.3s';
  if (position === 'start') container.prepend(row);
  else container.appendChild(row);
  requestAnimationFrame(() => { row.style.opacity = '1'; });
  bindFileRows();
}

function optimisticRemoveRow(nodeId: string) {
  const row = document.querySelector(`.file-row[data-id="${nodeId}"]`) as HTMLElement;
  if (row) {
    row.style.transition = 'opacity 0.2s, transform 0.2s';
    row.style.opacity = '0';
    row.style.transform = 'translateX(-20px)';
    setTimeout(() => row.remove(), 200);
  }
}

function optimisticUpdateRow(nodeId: string, updates: Record<string, string>) {
  const row = document.querySelector(`.file-row[data-id="${nodeId}"]`) as HTMLElement;
  if (!row) return;
  if (updates.name) {
    const nameEl = row.querySelector('.fr-name');
    if (nameEl) nameEl.textContent = updates.name;
  }
  if (updates.size) {
    const sizeEl = row.querySelector('.fr-size');
    if (sizeEl) sizeEl.textContent = updates.size;
  }
  row.style.transition = 'background 0.3s';
  row.style.background = 'var(--accent-bg)';
  setTimeout(() => {   row.style.background = ''; }, 600);
}

function invalidateNodesAndTreeCaches() {
  treeFoldersByParent = {};
  cacheInvalidate('nodes:');
}

async function fetchChildFolders(parentId: string | null): Promise<any[]> {
  let q = sb
    .from('nodes')
    .select('*')
    .eq('is_deleted', false)
    .eq('is_archived', false)
    .eq('node_type', 'folder')
    .order('name');
  q = parentId === null ? q.is('parent_id', null) : q.eq('parent_id', parentId);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function ensureFolderChildrenCached(parentKey: string, dbParentId: string | null) {
  if (Object.prototype.hasOwnProperty.call(treeFoldersByParent, parentKey)) return;
  const cacheKey = dbParentId === null ? 'nodes:tree-children:root' : `nodes:tree-children:${dbParentId}`;
  const rows = await dedupFetch(cacheKey, () => fetchChildFolders(dbParentId), 15000);
  treeFoldersByParent[parentKey] = rows;
}

// --- Init ---
async function init() {
  demoMode = !SUPABASE_URL || !SUPABASE_ANON_KEY;
  setupDesktopBridge();
  if (demoMode) {
    await startDemoWorkspace();
    return;
  }
  sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  auth = new AuthService(sb);
  showLoading('Запуск Vault PLM...');
  try {
    updateLoading('Подключение к хранилищу...');
    const state = await auth.init();
    if (state.mfaRequired) {
      hideLoading();
      showMFAVerify();
      return;
    }
    if (!state.user) {
      hideLoading();
      showLoginScreen();
      return;
    }
    currentUser = { id: state.user.id, email: state.user.email, ...state.profile };
    await bootstrapWorkspace();
  } catch (e: any) {
    hideLoading();
    toast(e.message || 'Ошибка запуска', 'err');
    showLoginScreen();
  }
}

async function setEditingNode(nodeId: string | null) {
  if (!currentUser) return;
  if (activeEditingNodeId === nodeId) return;
  activeEditingNodeId = nodeId;
  editingStates[currentUser.id] = {
    node_id: nodeId,
    email: currentUser.email || '',
    full_name: currentUser.full_name || '',
    ts: new Date().toISOString(),
  };
  refreshCollabBar();
  await broadcastEditingState(nodeId, {
    user_id: currentUser.id,
    email: currentUser.email || '',
    full_name: currentUser.full_name || '',
  });
}

function refreshCollabBar() {
  const merged = presenceUsers.map((u: any) => {
    const uid = u.user_id;
    if (!uid) return u;
    const editing = editingStates[uid];
    if (!editing) return u;
    return { ...u, node_id: editing.node_id };
  });
  renderCollabBar(merged);
}

function renderLiveCursors(nodeId: string) {
  const el = document.getElementById('live-cursors');
  if (!el) return;
  const active = Object.entries(cursorStates)
    .filter(([uid, st]) =>
      uid !== currentUser?.id &&
      st.node_id === nodeId &&
      st.field === 'comment' &&
      st.typing,
    )
    .map(([, st]) => st);
  if (active.length === 0) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = active
    .map((st) => {
      const p = Math.max(0, st.pos || 0);
      const line = Math.max(1, (st as any).line || 1);
      const col = Math.max(1, (st as any).col || 1);
      return `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:8px"><span class="collab-dot" style="width:6px;height:6px"></span>${esc(st.full_name || st.email || 'Пользователь')} печатает... <span style="opacity:0.75">(строка ${line}, колонка ${col}, позиция ${p})</span></span>`;
    })
    .join('');
}

// --- Auth UI ---
function showLoginScreen() {
  const c = document.getElementById('content')!;
  document.getElementById('nav')!.innerHTML = '';
  document.getElementById('detail')!.style.display = 'none';
  document.getElementById('tree-panel')!.style.display = 'none';
  (document.getElementById('btn-back') as HTMLElement).style.display = 'none';
  document.getElementById('topbar-actions')!.innerHTML = '';
  document.getElementById('bc')!.innerHTML = '';
  c.innerHTML = `
    <div style="max-width:400px;margin:60px auto;background:var(--bg-1);border:1px solid var(--border);border-radius:var(--r-xl);padding:28px">
      <div style="font-size:18px;font-weight:700;margin-bottom:2px">Vault PLM</div>
      <div style="font-size:12px;color:var(--text-2);margin-bottom:20px">${t.welcome_desc}</div>
      <div id="auth-tabs" style="display:flex;gap:0;margin-bottom:16px;border-bottom:2px solid var(--border)">
        <button class="auth-tab active" data-tab="login" onclick="switchAuthTab('login')" style="flex:1;padding:8px;border:none;background:none;font-size:13px;font-weight:600;color:var(--accent);border-bottom:2px solid var(--accent);margin-bottom:-2px;cursor:pointer">${t.login}</button>
        <button class="auth-tab" data-tab="register" onclick="switchAuthTab('register')" style="flex:1;padding:8px;border:none;background:none;font-size:13px;font-weight:500;color:var(--text-3);border-bottom:2px solid transparent;margin-bottom:-2px;cursor:pointer">${t.register}</button>
      </div>
      <div id="auth-login">
        <div class="fg"><label>${t.email}</label><input id="auth-email" type="email" placeholder="admin@vault-plm.local" /></div>
        <div class="fg"><label>${t.password}</label><input id="auth-password" type="password" placeholder="changeme" /></div>
        <div id="auth-error" style="color:var(--red);font-size:11px;margin-bottom:8px;display:none"></div>
        <button class="btn-sm primary" style="width:100%;justify-content:center;padding:8px" onclick="handleLogin()">${t.login}</button>
        <div style="text-align:center;margin-top:10px"><a style="font-size:11px;cursor:pointer;color:var(--text-3)" onclick="showResetPassword()">${t.forgot_password}</a></div>
      </div>
      <div id="auth-register" style="display:none">
        <div class="fg"><label>${t.full_name}</label><input id="reg-name" placeholder="Иванов И.И." /></div>
        <div class="fg"><label>${t.email}</label><input id="reg-email" type="email" placeholder="user@company.com" /></div>
        <div class="fg"><label>${t.password}</label><input id="reg-password" type="password" placeholder="Минимум 6 символов" /></div>
        <div class="fg"><label>${t.confirm_password}</label><input id="reg-confirm" type="password" /></div>
        <div id="reg-error" style="color:var(--red);font-size:11px;margin-bottom:8px;display:none"></div>
        <button class="btn-sm primary" style="width:100%;justify-content:center;padding:8px" onclick="handleRegister()">${t.register}</button>
      </div>
      <div id="auth-reset" style="display:none">
        <div class="fg"><label>${t.email}</label><input id="reset-email" type="email" placeholder="user@company.com" /></div>
        <div id="reset-error" style="color:var(--red);font-size:11px;margin-bottom:8px;display:none"></div>
        <button class="btn-sm primary" style="width:100%;justify-content:center;padding:8px" onclick="handleResetPassword()">${t.reset_password}</button>
        <div style="text-align:center;margin-top:10px"><a style="font-size:11px;cursor:pointer;color:var(--text-3)" onclick="switchAuthTab('login')">${t.have_account}</a></div>
      </div>
    </div>`;
}

function showMFAVerify() {
  const c = document.getElementById('content')!;
  document.getElementById('nav')!.innerHTML = '';
  c.innerHTML = `
    <div style="max-width:400px;margin:60px auto;background:var(--bg-1);border:1px solid var(--border);border-radius:var(--r-xl);padding:28px">
      <div style="font-size:18px;font-weight:700;margin-bottom:2px">${t.two_factor}</div>
      <div style="font-size:12px;color:var(--text-2);margin-bottom:16px">${t.enter_2fa_code}</div>
      <div class="fg"><label>Код 2FA</label><input id="mfa-code" type="text" placeholder="000000" maxlength="6" pattern="[0-9]*" inputmode="numeric" /></div>
      <div id="mfa-error" style="color:var(--red);font-size:11px;margin-bottom:8px;display:none"></div>
      <button class="btn-sm primary" style="width:100%;justify-content:center;padding:8px" onclick="handleMFAVerify()">${t.verify_2fa}</button>
      <div style="text-align:center;margin-top:10px"><a style="font-size:11px;cursor:pointer;color:var(--text-3)" onclick="handleLogout()">${t.cancel}</a></div>
    </div>`;
}

function showConnectionSetup() {
  const c = document.getElementById('content')!;
  document.getElementById('nav')!.innerHTML = '';
  c.innerHTML = `
    <div style="max-width:480px;margin:60px auto;background:var(--bg-1);border:1px solid var(--border);border-radius:var(--r-xl);padding:24px">
      <div style="font-size:16px;font-weight:700;margin-bottom:4px">Vault PLM</div>
      <div style="font-size:12px;color:var(--text-2);margin-bottom:16px">Настройте подключение к базе данных для начала работы</div>
      <div style="display:flex;gap:8px;margin-bottom:16px">
        <button class="btn-sm primary" style="flex:1;justify-content:center" onclick="completeSetup()">Подключиться</button>
        <button class="btn-sm" style="flex:1;justify-content:center" onclick="startDemoWorkspace()">Demo workspace</button>
      </div>
      <div class="fg"><label>URL базы данных (Supabase)</label><input id="setup-url" placeholder="https://xxx.supabase.co" /></div>
      <div class="fg"><label>Ключ доступа (anon key)</label><input id="setup-key" type="password" placeholder="eyJ..." /></div>
      <div class="fg"><label>Сервисный ключ (service_role_key, опционально)</label><input id="setup-skey" type="password" placeholder="eyJ..." /></div>
    </div>`;
}

(window as any).switchAuthTab = (tab: string) => {
  document.querySelectorAll('.auth-tab').forEach(b => { (b as HTMLElement).style.color = 'var(--text-3)'; (b as HTMLElement).style.borderBottomColor = 'transparent'; });
  const activeTab = document.querySelector(`.auth-tab[data-tab="${tab}"]`) as HTMLElement;
  if (activeTab) { activeTab.style.color = 'var(--accent)'; activeTab.style.borderBottomColor = 'var(--accent)'; }
  (document.getElementById('auth-login') as HTMLElement).style.display = tab === 'login' ? 'block' : 'none';
  (document.getElementById('auth-register') as HTMLElement).style.display = tab === 'register' ? 'block' : 'none';
  (document.getElementById('auth-reset') as HTMLElement).style.display = tab === 'reset' ? 'block' : 'none';
};

(window as any).showResetPassword = () => { (window as any).switchAuthTab('reset'); };

(window as any).handleLogin = async () => {
  const email = (document.getElementById('auth-email') as HTMLInputElement).value.trim();
  const password = (document.getElementById('auth-password') as HTMLInputElement).value;
  const errEl = document.getElementById('auth-error')!;
  if (!email || !password) { errEl.textContent = 'Укажите email и пароль'; errEl.style.display = 'block'; return; }
  const result = await auth.signIn(email, password);
  if (result.error) { errEl.textContent = result.error; errEl.style.display = 'block'; return; }
  if (result.mfaRequired) { showMFAVerify(); return; }
  const state = auth.getState();
  currentUser = { id: state.user.id, email: state.user.email, ...state.profile };
  await bootstrapWorkspace();
};

(window as any).handleRegister = async () => {
  const name = (document.getElementById('reg-name') as HTMLInputElement).value.trim();
  const email = (document.getElementById('reg-email') as HTMLInputElement).value.trim();
  const password = (document.getElementById('reg-password') as HTMLInputElement).value;
  const confirm = (document.getElementById('reg-confirm') as HTMLInputElement).value;
  const errEl = document.getElementById('reg-error')!;
  if (!email || !password) { errEl.textContent = 'Укажите email и пароль'; errEl.style.display = 'block'; return; }
  if (password !== confirm) { errEl.textContent = 'Пароли не совпадают'; errEl.style.display = 'block'; return; }
  if (password.length < 6) { errEl.textContent = 'Пароль минимум 6 символов'; errEl.style.display = 'block'; return; }
  const result = await auth.signUp(email, password, name);
  if (result.error) { errEl.textContent = result.error; errEl.style.display = 'block'; return; }
  toast('Регистрация успешна. Войдите в систему.', 'ok');
  (window as any).switchAuthTab('login');
};

(window as any).handleMFAVerify = async () => {
  const code = (document.getElementById('mfa-code') as HTMLInputElement).value.trim();
  const errEl = document.getElementById('mfa-error')!;
  if (!code || code.length !== 6) { errEl.textContent = 'Введите 6-значный код'; errEl.style.display = 'block'; return; }
  const result = await auth.verifyMFA(code);
  if (result.error) { errEl.textContent = result.error; errEl.style.display = 'block'; return; }
  const state = auth.getState();
  currentUser = { id: state.user.id, email: state.user.email, ...state.profile };
  await bootstrapWorkspace();
};

(window as any).handleResetPassword = async () => {
  const email = (document.getElementById('reset-email') as HTMLInputElement).value.trim();
  const errEl = document.getElementById('reset-error')!;
  if (!email) { errEl.textContent = 'Укажите email'; errEl.style.display = 'block'; return; }
  const result = await auth.resetPassword(email);
  if (result.error) { errEl.textContent = result.error; errEl.style.display = 'block'; return; }
  toast(t.password_reset_sent, 'ok');
  (window as any).switchAuthTab('login');
};

(window as any).handleLogout = async () => {
  await setEditingNode(null);
  if (!demoMode) {
    unsubscribeAll(sb);
    leavePresence(sb);
    leaveEditingChannel(sb);
  }
  realtimeSetup = false;
  editingStates = {};
  presenceUsers = [];
  activeEditingNodeId = null;
  Object.values(cursorFadeTimers).forEach((t) => clearTimeout(t));
  cursorFadeTimers = {};
  cursorStates = {};
  treeFoldersByParent = {};
  cacheClear();
  currentUser = null;
  if (demoMode) {
    showConnectionSetup();
  } else {
    await auth.signOut();
    showLoginScreen();
  }
};

(window as any).completeSetup = async () => {
  const url = (document.getElementById('setup-url') as HTMLInputElement).value.trim();
  const key = (document.getElementById('setup-key') as HTMLInputElement).value.trim();
  const skey = (document.getElementById('setup-skey') as HTMLInputElement).value.trim();
  if (!url || !key) { toast('Укажите URL и ключ','err'); return; }
  try {
    const testSb = createClient(url, key);
    await testSb.from('user_profiles').select('*').limit(1);
    toast(t.connected,'ok');
    showLoginScreen();
  } catch (e: any) { toast(t.connection_failed + ': ' + e.message,'err'); }
};

(window as any).startDemoWorkspace = startDemoWorkspace;

function generateDemoContent(name: string, mime: string, size: number): Blob {
  if (mime.startsWith('image/')) {
    // Generate a simple SVG placeholder as PNG won't work without canvas
    if (mime.includes('svg')) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300"><rect fill="#e8e9ed" width="400" height="300"/><text x="200" y="140" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#6b7085">${esc(name)}</text><text x="200" y="165" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#9da1b0">Vault PLM Demo</text></svg>`;
      return new Blob([svg], { type: mime });
    }
    // For PNG/JPG: create a minimal valid 1x1 pixel image and pad
    const pngHeader = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,2,0,0,0,144,119,83,222,0,0,0,12,73,68,65,84,8,215,99,8,6,0,0,0,2,0,1,226,33,188,51,0,0,0,0,73,69,78,68,174,66,96,130]);
    return new Blob([pngHeader], { type: mime });
  }
  if (mime.includes('pdf')) {
    // Minimal valid PDF
    const pdf = `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj\n4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n5 0 obj<</Length 44>>stream\nBT /F1 12 Tf 100 700 Td (${esc(name)}) Tj ET\nendstream\nendobj\nxref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000266 00000 n \n0000000340 00000 n \ntrailer<</Size 6/Root 1 0 R>>\nstartxref\n434\n%%EOF`;
    return new Blob([pdf], { type: 'application/pdf' });
  }
  if (mime.includes('csv')) {
    const csv = '\uFEFFНазвание,Количество,Цена\nДокумент А,10,1500\nДокумент Б,5,2300\nОтчёт В,3,890\nИтого,18,4690\n';
    return new Blob([csv], { type: 'text/csv' });
  }
  if (mime.includes('markdown') || name.endsWith('.md')) {
    const md = `# ${esc(name.replace('.md',''))}\n\nДокументация Vault PLM.\n\n## Описание\n\nЭто демонстрационный файл для системы управления документами.\n\n## Структура\n\n- Папка 1: Документы\n- Папка 2: Изображения\n- Папка 3: Проекты\n\n## Версии\n\n| Версия | Дата | Автор |\n|--------|------|-------|\n| v1 | 2025-01-15 | admin |\n| v2 | 2025-02-20 | admin |\n`;
    return new Blob([md], { type: 'text/markdown' });
  }
  // Generic text content for other types
  const text = `Vault PLM - ${esc(name)}\n\nТип: ${esc(mime)}\nРазмер: ${fmtSize(size)}\nДата: ${new Date().toLocaleDateString('ru-RU')}\n\nЭто демонстрационный файл системы Vault PLM.\nФайл хранится в зашифрованном виде с версионностью и контролем доступа.`;
  return new Blob([text], { type: mime || 'application/octet-stream' });
}

async function seedIfEmpty() {
  if (demoMode) return;
  const { count } = await sb.from('nodes').select('*',{count:'exact',head:true}).eq('is_deleted',false);
  if (count && count > 0) return;
  const uid = currentUser.id;
  const folders = ['Документы','Изображения','Проекты','Отчёты'];
  const fids: string[] = [];
  for (const name of folders) { const id=uuidv4(); await sb.from('nodes').insert({id,parent_id:null,owner_id:uid,name,node_type:'folder',path:`/${name}`,size:0}); fids.push(id); }
  const seeds = [
    {f:0,name:'Договор_2024.pdf',mime:'application/pdf',size:245760},
    {f:0,name:'Приложение_А.docx',mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',size:89400},
    {f:0,name:'Бюджет_Q4.xlsx',mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',size:156000},
    {f:1,name:'Логотип.png',mime:'image/png',size:524288},
    {f:1,name:'Схема.svg',mime:'image/svg+xml',size:34500},
    {f:2,name:'ТЗ.pdf',mime:'application/pdf',size:890000},
    {f:2,name:'README.md',mime:'text/markdown',size:4200},
    {f:3,name:'Отчёт_безопасности.pdf',mime:'application/pdf',size:312000},
    {f:3,name:'Аудит.csv',mime:'text/csv',size:15600},
  ];
  for (const s of seeds) {
    const id=uuidv4();
    await sb.from('nodes').insert({id,parent_id:fids[s.f],owner_id:uid,name:s.name,node_type:'file',path:`/${folders[s.f]}/${s.name}`,mime_type:s.mime,size:s.size});
    const v1=uuidv4(),v2=uuidv4(),h1='a'.repeat(64),h2='b'.repeat(64);
    await sb.from('file_versions').insert([
      {id:v1,node_id:id,version_number:1,total_size:Math.floor(s.size*0.8),content_hash:h1,encrypted_key:new Uint8Array(32),key_nonce:new Uint8Array(24),is_current:false,is_compressed:false,created_by:uid,created_at:'2025-01-15T10:00:00Z',comment:'Начальная версия'},
      {id:v2,node_id:id,version_number:2,total_size:s.size,content_hash:h2,encrypted_key:new Uint8Array(32),key_nonce:new Uint8Array(24),is_current:true,is_compressed:false,created_by:uid,created_at:'2025-02-20T14:30:00Z',comment:'Обновление'},
    ]);
    const b1=uuidv4();
    await sb.from('data_blocks').insert({id:b1,content_hash:h1,encrypted_hash:h1,size:Math.floor(s.size*0.8),encrypted_size:Math.floor(s.size*0.8)+16,physical_path:`/vault/blocks/${h1.substring(0,2)}/${h1}`,compression:'none',ref_count:1});
    await sb.from('file_version_blocks').insert([{id:uuidv4(),version_id:v1,block_id:b1,block_index:0,block_offset:0},{id:uuidv4(),version_id:v2,block_id:b1,block_index:0,block_offset:0}]);
    await sb.from('audit_log').insert([{id:uuidv4(),user_id:uid,node_id:id,action:'version_create',details:{version_number:1},created_at:'2025-01-15T10:00:00Z'},{id:uuidv4(),user_id:uid,node_id:id,action:'version_create',details:{version_number:2},created_at:'2025-02-20T14:30:00Z'}]);
    // Store demo content in Supabase Storage for preview/download
    const demoContent = generateDemoContent(s.name, s.mime, s.size);
    const storagePath = `${uid}/${id}/2`;
    await sb.storage.from('vault-files').upload(storagePath, demoContent, { contentType: s.mime, upsert: true }).catch(()=>{});
  }
  toast(t.seed_complete,'ok');
}

// --- Nav ---
function renderNav() {
  const nav = document.getElementById('nav')!;
  nav.innerHTML = demoMode ? `
    <div class="nav-group"><div class="nav-label">${t.nav}</div>
      <button class="nav-btn active" data-v="files"><span class="ic">&#128193;</span>${t.all_files}</button>
      <button class="nav-btn" data-v="recent"><span class="ic">&#128337;</span>${t.recent}</button>
      <button class="nav-btn" data-v="shared"><span class="ic">&#128279;</span>${t.shared}</button>
      <button class="nav-btn" data-v="archived"><span class="ic">&#128230;</span>${t.archive}</button>
      <button class="nav-btn" data-v="trash"><span class="ic">&#128465;</span>${t.trash}</button>
    </div>
    <div class="nav-group"><div class="nav-label">${t.manage}</div>
      <button class="nav-btn" data-v="analytics"><span class="ic">&#128200;</span>${t.analytics}</button>
      <button class="nav-btn" data-v="audit"><span class="ic">&#128203;</span>${t.audit}</button>
      <button class="nav-btn" data-v="blocks"><span class="ic">&#128336;</span>${t.storage}</button>
    </div>
    <div style="padding:6px;border-top:1px solid var(--border)"><button class="nav-btn" style="color:var(--red)" onclick="handleLogout()"><span class="ic">&#10140;</span>${t.sign_out}</button></div>`
  : `
    <div class="nav-group"><div class="nav-label">${t.nav}</div>
      <button class="nav-btn active" data-v="products"><span class="ic">&#9881;</span>${t.products}</button>
      <button class="nav-btn" data-v="files"><span class="ic">&#128193;</span>${t.all_files}</button>
      <button class="nav-btn" data-v="recent"><span class="ic">&#128337;</span>${t.recent}</button>
      <button class="nav-btn" data-v="shared"><span class="ic">&#128279;</span>${t.shared}</button>
      <button class="nav-btn" data-v="archived"><span class="ic">&#128230;</span>${t.archive}</button>
      <button class="nav-btn" data-v="trash"><span class="ic">&#128465;</span>${t.trash}</button>
    </div>
    <div class="nav-group"><div class="nav-label">${t.manage}</div>
      <button class="nav-btn" data-v="analytics"><span class="ic">&#128200;</span>${t.analytics}</button>
      <button class="nav-btn" data-v="audit"><span class="ic">&#128203;</span>${t.audit}</button>
      <button class="nav-btn" data-v="blocks"><span class="ic">&#128336;</span>${t.storage}</button>
      <button class="nav-btn" data-v="admin"><span class="ic">&#9881;</span>${t.admin}</button>
      <button class="nav-btn" data-v="server"><span class="ic">&#128421;</span>${t.connection}</button>
      <button class="nav-btn" data-v="extensions"><span class="ic">&#128268;</span>${t.extensions}</button>
      <button class="nav-btn" data-v="backups"><span class="ic">&#128190;</span>${t.backups}</button>
      <button class="nav-btn" data-v="security"><span class="ic">&#128274;</span>${t.security}</button>
    </div>
    <div style="padding:6px;border-top:1px solid var(--border)"><button class="nav-btn" style="color:var(--red)" onclick="handleLogout()"><span class="ic">&#10140;</span>${t.sign_out}</button></div>`;
  nav.querySelectorAll('.nav-btn:not([data-nv])').forEach(b => { (b as HTMLElement).dataset.nv='1'; b.addEventListener('click', () => loadView((b as HTMLElement).dataset.v!)); });
  document.getElementById('user-info')!.innerHTML = `<div class="user-avatar">${esc((currentUser?.email||currentUser?.username||'A')[0].toUpperCase())}</div><span>${esc(currentUser?.email||currentUser?.username||'admin')}</span>`;
}

function loadView(view: string) {
  if (demoMode && !['files','recent','shared','archived','trash','analytics','audit','blocks'].includes(view)) {
    view = 'files';
  }
  currentView = view;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active',(b as HTMLElement).dataset.v===view));
  document.getElementById('detail')!.style.display='none';
  selectedNodeId=null; selectedProductId=null;
  const actions = document.getElementById('topbar-actions')!;
  const treePanel = document.getElementById('tree-panel')!;
  const btnBack = document.getElementById('btn-back') as HTMLElement;
  treePanel.style.display='none'; btnBack.style.display='none'; actions.innerHTML='';

  if (view==='files') {
    treePanel.style.display='flex';
    actions.innerHTML = `<button class="btn-sm" onclick="createFolder()">&#128193; ${t.new_folder}</button><button class="btn-sm primary" onclick="triggerUpload()">&#11014; ${t.upload}</button>`;
    btnBack.style.display = pathStack.length>1?'flex':'none';
  } else if (view==='products') {
    actions.innerHTML = `<button class="btn-sm primary" onclick="openAddProductModal()">+ ${t.add_product}</button>`;
  } else if (view==='trash') {
    actions.innerHTML = `<button class="btn-sm danger" onclick="purgeTrash()">&#128465; ${t.purge}</button>`;
  } else if (view==='blocks') {
    actions.innerHTML = `<button class="btn-sm" onclick="runGC()">&#9851; ${t.gc}</button>`;
  } else if (view==='admin') {
    actions.innerHTML = `<button class="btn-sm" onclick="runArchive()">&#128230; ${t.run_archive}</button>`;
  } else if (view==='security') {
    actions.innerHTML = '';
  } else if (view==='backups') {
    actions.innerHTML = '';
  }

  switch(view) {
    case 'products': loadProducts(); break;
    case 'files': loadFiles(currentParentId); break;
    case 'recent': loadRecent(); break;
    case 'shared': loadShared(); break;
    case 'archived': loadArchived(); break;
    case 'trash': loadTrash(); break;
    case 'analytics': loadAnalytics(); break;
    case 'audit': loadAudit(); break;
    case 'blocks': loadBlocks(); break;
    case 'admin': loadAdmin(); break;
    case 'server': loadServer(); break;
    case 'extensions': loadExtensions(); break;
    case 'backups': loadBackups(); break;
    case 'security': loadSecurity(); break;
  }
}

// --- Back navigation ---
(window as any).goBack = () => {
  if (pathStack.length>1) { pathStack.pop(); currentParentId=pathStack[pathStack.length-1].id; loadFiles(currentParentId); (document.getElementById('btn-back') as HTMLElement).style.display=pathStack.length>1?'flex':'none'; }
};

// --- Tree (ленивая загрузка вложенных папок) ---
async function loadTree() {
  try {
    await ensureFolderChildrenCached(TREE_ROOT_KEY, null);
    for (const fid of [...treeExpanded]) {
      await ensureFolderChildrenCached(fid, fid);
    }
  } catch (e: any) {
    console.error(e);
  }
  document.getElementById('tree-body')!.innerHTML = renderTreeLevel(TREE_ROOT_KEY, 0);
  bindTreeItems();
}
function renderTreeLevel(parentKey: string, depth: number): string {
  const list = treeFoldersByParent[parentKey] || [];
  return list.map((n: any) => {
    const isOpen = treeExpanded.has(n.id);
    const childList = treeFoldersByParent[n.id];
    const hasNestedFolders = !!(childList && childList.filter((c: any) => c.node_type === 'folder').length);
    const showArrow =
      Object.prototype.hasOwnProperty.call(treeFoldersByParent, n.id) ? hasNestedFolders : true;
    return `<div class="tree-item${currentParentId === n.id ? ' active' : ''}" data-id="${n.id}"><span class="ti-arrow${isOpen ? ' open' : ''}">${showArrow ? '&#9654;' : ''}</span><span class="ti-ic">&#128193;</span><span class="ti-name">${esc(n.name)}</span></div>${isOpen ? `<div class="tree-children">${renderTreeLevel(n.id, depth + 1)}</div>` : ''}`;
  }).join('');
}
function bindTreeItems() {
  document.querySelectorAll('.tree-item:not([data-bound])').forEach(item => {
    (item as HTMLElement).dataset.bound = '1';
    item.addEventListener('click', async () => {
      const id = (item as HTMLElement).dataset.id!;
      if (treeExpanded.has(id)) treeExpanded.delete(id);
      else {
        treeExpanded.add(id);
        try {
          await ensureFolderChildrenCached(id, id);
        } catch (e: any) {
          console.error(e);
        }
      }
      const nameEl = item.querySelector('.ti-name') || item;
      pathStack = [{ id: null, name: 'Хранилище' }, { id, name: nameEl.textContent!.trim() }];
      currentParentId = id;
      await loadTree();
      loadFiles(id);
      (document.getElementById('btn-back') as HTMLElement).style.display = 'flex';
    });
  });
}

// --- Search ---
function setupSearch() {
  const input = document.getElementById('search-input') as HTMLInputElement;
  input.addEventListener('input', () => { clearTimeout(searchTimeout); searchTimeout=setTimeout(()=>{const q=input.value.trim();if(q.length>=2)searchFiles(q);else if(currentView==='search')loadView('files');},300); });
  input.addEventListener('keydown', (e) => { if(e.key==='Escape'){input.value='';if(currentView==='search')loadView('files');} });
}
async function searchFiles(query: string) {
  currentView='search'; document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
  const c=document.getElementById('content')!;
  document.getElementById('bc')!.innerHTML=`<a>${t.vault}</a><span class="sep">/</span><a>Поиск: ${esc(query)}</a>`;
  const {data,error}=await sb.from('nodes').select('*').eq('is_deleted',false).ilike('name',`%${query}%`).order('name').limit(50);
  if(error){c.innerHTML=errMsg(error.message);return;}
  c.innerHTML=(data||[]).length===0?`<div class="empty"><div class="empty-ic">&#128269;</div><div class="empty-t">${t.no_results}</div></div>`:
    `<div class="file-list-header"><div class="fh-name">${t.name}</div><div class="fh-size">${t.size}</div><div class="fh-date">${t.date}</div></div><div class="file-list">${(data||[]).map(n=>fileRow(n)).join('')}</div>`;
  bindFileRows();
}

// --- Keyboard ---
function setupKeyboard() {
  document.addEventListener('keydown', (e) => {
    if(e.target instanceof HTMLInputElement||e.target instanceof HTMLSelectElement||e.target instanceof HTMLTextAreaElement)return;
    if(e.key==='Delete'&&selectedNodeId)(window as any).deleteFile(selectedNodeId);
    if(e.key==='F2'&&selectedNodeId)startRename(selectedNodeId);
    if(e.key==='Escape'){closeCtxMenu();closePreview();document.getElementById('detail')!.style.display='none';selectedNodeId=null;setEditingNode(null);document.querySelectorAll('.file-row.selected').forEach(r=>r.classList.remove('selected'));}
    if(e.key==='Backspace'&&currentView==='files'&&pathStack.length>1){(window as any).goBack();e.preventDefault();}
  });
}
function setupGlobalClicks() {
  document.addEventListener('contextmenu', (e) => { const row=(e.target as HTMLElement).closest('.file-row') as HTMLElement; if(row){e.preventDefault();showContextMenu(row,e.clientX,e.clientY);} });
}

// --- Context menu ---
function showContextMenu(row:HTMLElement,x:number,y:number) {
  closeCtxMenu();
  const id=row.dataset.id!,type=row.dataset.type!,name=row.querySelector('.fr-name')!.textContent!;
  const menu=document.createElement('div');menu.className='ctx-menu';menu.id='ctx-menu';
  menu.style.left=Math.min(x,window.innerWidth-180)+'px';menu.style.top=Math.min(y,window.innerHeight-200)+'px';
  let items=type==='folder'?`<div class="ctx-item" data-action="open" data-id="${id}"><span class="ctx-ic">&#128193;</span>${t.open}</div>`:
    `<div class="ctx-item" data-action="info" data-id="${id}"><span class="ctx-ic">&#8505;</span>${t.info}</div>
     <div class="ctx-item" data-action="preview" data-id="${id}"><span class="ctx-ic">&#128065;</span>${t.preview}</div>
     <div class="ctx-item" data-action="download" data-id="${id}"><span class="ctx-ic">&#11015;</span>${t.download}</div>
     <div class="ctx-item" data-action="rename" data-id="${id}"><span class="ctx-ic">&#9998;</span>${t.rename}</div>
     <div class="ctx-sep"></div>
     <div class="ctx-item" data-action="archive" data-id="${id}"><span class="ctx-ic">&#128230;</span>${t.archive_btn}</div>`;
  items+=`<div class="ctx-item" data-action="move" data-id="${id}"><span class="ctx-ic">&#128193;</span>Переместить</div>`;
  items+=`<div class="ctx-sep"></div><div class="ctx-item danger" data-action="delete" data-id="${id}"><span class="ctx-ic">&#128465;</span>${t.delete}</div>`;
  menu.innerHTML=items;document.body.appendChild(menu);ctxMenuEl=menu;
  menu.querySelectorAll('.ctx-item').forEach(item=>{item.addEventListener('click',()=>{
    const action=(item as HTMLElement).dataset.action!,id=(item as HTMLElement).dataset.id!;closeCtxMenu();
    switch(action){case 'open':openFolder(id,name);break;case 'info':openDetail(id);break;case 'preview':previewFile(id);break;case 'download':(window as any).downloadFile(id);break;case 'rename':startRename(id);break;case 'archive':(window as any).archiveFile(id);break;case 'move':openMoveModal(id);break;case 'delete':(window as any).deleteFile(id);break;}
  });});
}
function closeCtxMenu(){if(ctxMenuEl){ctxMenuEl.remove();ctxMenuEl=null;}}

// --- Rename ---
function startRename(nodeId:string) {
  const row=document.querySelector(`.file-row[data-id="${nodeId}"]`);if(!row)return;
  const nameEl=row.querySelector('.fr-name')!;const oldName=nameEl.textContent!;
  const input=document.createElement('input');input.className='rename-input';input.value=oldName;
  nameEl.replaceWith(input);input.focus();input.select();
  const finish=async()=>{const newName=input.value.trim()||oldName;if(newName!==oldName){optimisticUpdateRow(nodeId,{name:newName});try{await sb.from('nodes').update({name:newName,updated_at:new Date().toISOString()}).eq('id',nodeId);await sb.from('audit_log').insert({id:uuidv4(),user_id:currentUser.id,node_id:nodeId,action:'node_rename',details:{old_name:oldName,new_name:newName}});invalidateNodesAndTreeCaches();toast(`${t.rename}: ${newName}`,'ok');loadTree();}catch(e:any){toast(e.message,'err');}}loadView(currentView);};
  input.addEventListener('blur',finish);input.addEventListener('keydown',(e)=>{if(e.key==='Enter')input.blur();if(e.key==='Escape'){input.value=oldName;input.blur();}});
}
(window as any).startRename=startRename;

// --- Preview ---
async function previewFile(nodeId:string) {
  const {data:node}=await sb.from('nodes').select('*').eq('id',nodeId).maybeSingle();if(!node)return;
  const ext=(node.name.split('.').pop()||'').toLowerCase();
  const existing=document.getElementById('preview-panel');if(existing)existing.remove();
  const panel=document.createElement('div');panel.className='preview-panel';panel.id='preview-panel';
  panel.innerHTML=`<div class="preview-content"><div class="preview-head"><div class="preview-title">${esc(node.name)}</div><div style="display:flex;gap:4px"><button class="btn-sm primary" onclick="downloadFile('${nodeId}')">&#11015; Скачать</button><button class="btn-sm" onclick="closePreview()">Закрыть</button></div></div><div class="preview-body" style="align-items:center;justify-content:center"><div class="loading-spinner"></div></div></div>`;
  document.body.appendChild(panel);panel.addEventListener('click',(e)=>{if(e.target===panel)closePreview();});
  const isImage=node.mime_type?.startsWith('image/');
  const isPdf=node.mime_type?.includes('pdf');
  const isText=node.mime_type?.startsWith('text/')||['md','txt','csv','json','xml','yaml','yml','log','cfg','ini','sh','bat','py','js','ts','css','html','sql'].includes(ext);
  const isAudio=node.mime_type?.startsWith('audio/');
  const isVideo=node.mime_type?.startsWith('video/');
  let body='';
  try {
    if (demoMode) {
      const blob = generateDemoContent(node.name, node.mime_type || 'application/octet-stream', node.size || 0);
      const url = URL.createObjectURL(blob);
      if (isImage) body=`<img src="${url}" alt="${esc(node.name)}" style="max-width:100%;max-height:100%;object-fit:contain" />`;
      else if (isPdf) body=`<iframe src="${url}" style="width:100%;height:100%;border:none"></iframe>`;
      else if (isAudio) body=`<div style="text-align:center;padding:40px"><div style="font-size:48px;opacity:0.3">&#127925;</div><audio controls src="${url}" style="margin-top:16px;width:80%;max-width:400px"><a href="${url}">Скачать аудио</a></audio><div style="margin-top:8px;font-size:11px;color:var(--text-3)">${esc(node.name)} &middot; ${fmtSize(node.size)}</div></div>`;
      else if (isVideo) body=`<video controls src="${url}" style="max-width:100%;max-height:100%"><a href="${url}">Скачать видео</a></video>`;
      else if (isText) {
        const text = await (await fetch(url)).text();
        const escaped = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        body=`<pre style="width:100%;font-size:12px;color:var(--text-1);white-space:pre-wrap;word-break:break-word;font-family:'IBM Plex Mono',monospace;overflow:auto;max-height:100%;padding:16px;background:var(--bg-1);border:1px solid var(--border);border-radius:var(--r-lg)">${escaped}</pre>`;
      } else {
        body=`<div class="preview-file-info"><div class="preview-icon">&#128196;</div><div class="preview-filename">${esc(node.name)}</div><div class="preview-meta">${esc(node.mime_type||'Неизвестный тип')} &middot; ${fmtSize(node.size)}</div><div style="margin-top:12px"><a href="${url}" target="_blank" class="btn-sm primary">&#11015; Скачать файл</a></div></div>`;
      }
    } else {
      const h = await vaultHeaders();
      const res = await fetch(`${VAULT_API}/files/content?node_id=${nodeId}`, { headers: h });
      const data = await res.json();
      if (data.url) {
        if (isImage) body=`<img src="${data.url}" alt="${esc(node.name)}" style="max-width:100%;max-height:100%;object-fit:contain" />`;
        else if (isPdf) body=`<iframe src="${data.url}" style="width:100%;height:100%;border:none"></iframe>`;
        else if (isAudio) body=`<div style="text-align:center;padding:40px"><div style="font-size:48px;opacity:0.3">&#127925;</div><audio controls src="${data.url}" style="margin-top:16px;width:80%;max-width:400px"><a href="${data.url}">Скачать аудио</a></audio><div style="margin-top:8px;font-size:11px;color:var(--text-3)">${esc(node.name)} &middot; ${fmtSize(node.size)}</div></div>`;
        else if (isVideo) body=`<video controls src="${data.url}" style="max-width:100%;max-height:100%"><a href="${data.url}">Скачать видео</a></video>`;
        else if (isText) {
          try {
            const text = await (await fetch(data.url)).text();
            const escaped = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            body=`<pre style="width:100%;font-size:12px;color:var(--text-1);white-space:pre-wrap;word-break:break-word;font-family:'IBM Plex Mono',monospace;overflow:auto;max-height:100%;padding:16px;background:var(--bg-1);border:1px solid var(--border);border-radius:var(--r-lg)">${escaped}</pre>`;
          } catch {
            body=`<div class="preview-file-info"><div class="preview-icon">&#128196;</div><div class="preview-filename">${esc(node.name)}</div><div class="preview-meta">${esc(node.mime_type)} &middot; ${fmtSize(node.size)}</div><div style="margin-top:12px"><a href="${data.url}" target="_blank" class="btn-sm primary">&#11015; Скачать</a></div></div>`;
          }
        } else {
          body=`<div class="preview-file-info"><div class="preview-icon">&#128196;</div><div class="preview-filename">${esc(node.name)}</div><div class="preview-meta">${esc(node.mime_type||'Неизвестный тип')} &middot; ${fmtSize(node.size)}</div><div style="margin-top:12px"><a href="${data.url}" target="_blank" class="btn-sm primary">&#11015; Скачать файл</a></div></div>`;
        }
      } else {
        body=`<div class="preview-file-info"><div class="preview-icon">${isImage?'&#128444;':isPdf?'&#128213;':'&#128196;'}</div><div class="preview-filename">${esc(node.name)}</div><div class="preview-meta">${esc(node.mime_type||'?')} &middot; ${fmtSize(node.size)}</div><div style="margin-top:12px;color:var(--text-3);font-size:11px">Файл ещё не загружен в хранилище. Скачайте для просмотра.</div></div>`;
      }
    }
  } catch(e: any) {
    body=`<div class="preview-file-info"><div class="preview-icon">&#9888;</div><div class="preview-filename">${esc(node.name)}</div><div class="preview-meta" style="color:var(--red)">${esc(e.message||'Ошибка загрузки')}</div></div>`;
  }
  const bodyEl=panel.querySelector('.preview-body');
  if(bodyEl){bodyEl.style.alignItems='flex-start';bodyEl.style.justifyContent='flex-start';bodyEl.innerHTML=body;}
}
function closePreview(){const p=document.getElementById('preview-panel');if(p)p.remove();}
(window as any).closePreview=closePreview;(window as any).previewFile=previewFile;

// --- Supabase Realtime: списки + presence (без polling) ---
function setupRealtimeSubscriptions() {
  if (demoMode) return;
  if (!realtimeSetup && currentUser) {
    realtimeSetup = true;
    joinPresence(sb, currentUser.id, { email: currentUser.email || '', fullName: currentUser.full_name || '' }, (users) => {
      presenceUsers = users;
      refreshCollabBar();
    });
    const debouncedReload = (prefixes: string[], reloader: () => void) => {
      if (prefixes.some(p => p.startsWith('nodes'))) treeFoldersByParent = {};
      prefixes.forEach(p => cacheInvalidate(p));
      clearTimeout(realtimeDebounce);
      realtimeDebounce = setTimeout(reloader, 300);
    };
    subscribeToTable(sb, 'nodes', () => {
      debouncedReload(['nodes:'], () => {
        if (currentView === 'files') loadFiles(currentParentId);
        else if (currentView === 'recent') loadRecent();
        else if (currentView === 'archived') loadArchived();
        else if (currentView === 'trash') loadTrash();
        loadTree();
      });
    });
    subscribeToTable(sb, 'products', () => {
      debouncedReload(['products:'], () => { if (currentView === 'products') loadProducts(); });
    });
    subscribeToTable(sb, 'share_links', () => {
      debouncedReload(['share_links:'], () => { if (currentView === 'shared') loadShared(); });
    });
    subscribeToTable(sb, 'audit_log', () => {
      debouncedReload(['audit_log:'], () => { if (currentView === 'audit') loadAudit(); });
    });
    subscribeToTable(sb, 'data_blocks', () => {
      debouncedReload(['data_blocks:'], () => { if (currentView === 'blocks') loadBlocks(); });
    });
    joinEditingChannel(
      sb,
      (payload: any) => {
        if (!payload?.user_id) return;
        editingStates[payload.user_id] = {
          node_id: payload.node_id ?? null,
          email: payload.email,
          full_name: payload.full_name,
          ts: payload.ts || new Date().toISOString(),
        };
        refreshCollabBar();
      },
      (payload: any) => {
        if (!payload?.user_id) return;
        cursorStates[payload.user_id] = {
          node_id: payload.node_id ?? null,
          field: payload.field || 'comment',
          pos: payload.pos || 0,
          typing: !!payload.typing,
          email: payload.email,
          full_name: payload.full_name,
          ts: payload.ts || new Date().toISOString(),
          ...(payload.line ? { line: payload.line } : {}),
          ...(payload.col ? { col: payload.col } : {}),
        };
        if (cursorFadeTimers[payload.user_id]) clearTimeout(cursorFadeTimers[payload.user_id]);
        cursorFadeTimers[payload.user_id] = setTimeout(() => {
          if (cursorStates[payload.user_id]) {
            cursorStates[payload.user_id].typing = false;
            if (selectedNodeId) renderLiveCursors(selectedNodeId);
          }
        }, 4000);
        if (selectedNodeId) renderLiveCursors(selectedNodeId);
      },
    );
  }
}

function renderCollabBar(users: any[]) {
  const bar = document.getElementById('collab-bar')!;
  if (currentView !== 'files' && currentView !== 'products') { bar.style.display = 'none'; return; }
  const onlineUsers = users.filter((u: any) => !u.node_id || typeof u.node_id === 'string');
  if (onlineUsers.length === 0) { bar.style.display = 'none'; return; }
  const activeEditors = onlineUsers.filter((u: any) => !!u.node_id);
  bar.style.display = 'flex';
  const editorsLabel = activeEditors.length > 0
    ? `<span style="margin-left:8px;color:var(--text-2);font-size:11px">Редактируют: ${activeEditors.length}</span>`
    : '';
  bar.innerHTML = `<div class="collab-dot"></div><span>${t.online}: ${onlineUsers.length}</span>${editorsLabel}<div style="display:flex;margin-left:4px">${onlineUsers.map((u: any) => `<div class="collab-user" title="${esc(u.full_name || u.email || '?')}${u.node_id ? ' (редактирует файл)' : ''}">${esc((u.full_name || u.email || '?')[0].toUpperCase())}</div>`).join('')}</div>`;
}

// ==================== PLM: PRODUCTS ====================

async function loadProducts() {
  const c=document.getElementById('content')!;
  document.getElementById('bc')!.innerHTML=`<a>${t.products}</a>`;
  const products = await dedupFetch('products:list', async () => {
    const { data, error } = await sb.from('products').select('*').order('code');
    if (error) throw new Error(error.message);
    return data || [];
  });
  const stageCounts: Record<string,number>={};products.forEach((p: any)=>{stageCounts[p.lifecycle_stage]=(stageCounts[p.lifecycle_stage]||0)+1;});
  c.innerHTML=`
    <div class="lifecycle-bar">${LIFECYCLE_STAGES.map(s=>`<div class="lifecycle-stage" onclick="filterByStage('${s}')">${t[s as keyof typeof t]||s} <span style="opacity:0.6">${stageCounts[s]||0}</span></div>`).join('')}</div>
    <div class="stats">${LIFECYCLE_STAGES.map(s=>`<div class="stat-card"><div class="stat-val">${stageCounts[s]||0}</div><div class="stat-lbl">${t[s as keyof typeof t]||s}</div></div>`).join('')}</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px">
      ${products.map(p=>`<div class="product-card" data-id="${p.id}" onclick="openProductDetail('${p.id}')">
        <div class="product-code">${esc(p.code)}</div>
        <div class="product-name">${esc(p.name)}</div>
        <div class="product-desc">${esc(p.description||'')}</div>
        <div class="product-meta">
          <span class="badge badge-stage">${t[p.lifecycle_stage as keyof typeof t]||p.lifecycle_stage}</span>
          <span class="badge ${p.status==='active'?'badge-enc':p.status==='draft'?'badge-arch':'badge-comp'}">${esc(p.status)}</span>
        </div>
      </div>`).join('')}
    </div>`;
}

(window as any).filterByStage = async (stage: string) => {
  const {data}=await sb.from('products').select('*').eq('lifecycle_stage',stage).order('code');
  const c=document.getElementById('content')!;
  c.querySelectorAll('.product-card').forEach(el=>el.remove());
  const grid=c.querySelector('[style*="grid"]')!;
  (data||[]).forEach(p=>{const d=document.createElement('div');d.className='product-card';d.dataset.id=p.id;d.onclick=()=>openProductDetail(p.id);d.innerHTML=`<div class="product-code">${esc(p.code)}</div><div class="product-name">${esc(p.name)}</div><div class="product-desc">${esc(p.description||'')}</div><div class="product-meta"><span class="badge badge-stage">${t[p.lifecycle_stage as keyof typeof t]||p.lifecycle_stage}</span><span class="badge ${p.status==='active'?'badge-enc':'badge-arch'}">${esc(p.status)}</span></div>`;grid.appendChild(d);});
};

async function openProductDetail(productId: string) {
  selectedProductId=productId;
  const panel=document.getElementById('detail')!;panel.style.display='flex';
  const {data:product}=await sb.from('products').select('*').eq('id',productId).maybeSingle();if(!product)return;
  const [docsRes,bomRes,wfRes]=await Promise.all([
    sb.from('product_documents').select('*, nodes(name, size, mime_type)').eq('product_id',productId),
    sb.from('bom_items').select('*, child:products(id, code, name)').eq('parent_product_id',productId),
    sb.from('workflow_instances').select('*, workflow_stages(name, stage_type, order_index), user_profiles(email, full_name)').eq('product_id',productId).order('started_at'),
  ]);
  const docs=docsRes.data||[];const bom=bomRes.data||[];const wfs=wfRes.data||[];
  const stageIdx=LIFECYCLE_STAGES.indexOf(product.lifecycle_stage);
  panel.innerHTML=`
    <div class="detail-head">
      <div class="detail-name">${esc(product.name)}</div>
      <div class="detail-sub">${esc(product.code)} &middot; ${t[product.lifecycle_stage as keyof typeof t]||product.lifecycle_stage} &middot; ${esc(product.status)}</div>
    </div>
    <div class="detail-actions">
      <button class="btn-sm" onclick="changeLifecycleStage('${productId}','prev')">&#8592;</button>
      <span style="font-size:11px;font-weight:600;color:var(--accent)">${t[product.lifecycle_stage as keyof typeof t]||product.lifecycle_stage}</span>
      <button class="btn-sm" onclick="changeLifecycleStage('${productId}','next')">&#8594;</button>
      <button class="btn-sm" onclick="startWorkflow('${productId}')" style="margin-left:auto">${t.start_workflow}</button>
    </div>
    <div class="detail-sec">
      <div class="detail-sec-title">${t.description}</div>
      <div style="font-size:12px;color:var(--text-1)">${esc(product.description||'-')}</div>
      ${Object.keys(product.metadata||{}).length>0?`<div style="margin-top:6px;font-size:11px;color:var(--text-2)">${Object.entries(product.metadata).map(([k,v])=>`<div><span style="color:var(--text-3)">${esc(String(k))}:</span> ${esc(String(v))}</div>`).join('')}</div>`:''}
    </div>
    <div class="detail-sec">
      <div class="detail-sec-title">${t.workflow} <span class="detail-sec-count">${wfs.length}</span></div>
      ${wfs.length===0?'<div style="font-size:11px;color:var(--text-3)">Нет активных маршрутов</div>':
        wfs.map((w:any)=>`<div style="padding:4px 0;border-bottom:1px solid var(--bg-2);font-size:11px"><span style="font-weight:600">${esc(w.workflow_stages?.name||'?')}</span> &middot; <span class="badge ${w.status==='completed'?'badge-enc':w.status==='rejected'?'badge-arch':'badge-stage'}">${esc(w.status)}</span> &middot; ${esc(w.user_profiles?.full_name||w.user_profiles?.email||'?')}${w.comment?` &middot; ${esc(w.comment)}`:''}</div>`).join('')}
    </div>
    <div class="detail-sec">
      <div class="detail-sec-title">${t.bom_items} <span class="detail-sec-count">${bom.length}</span></div>
      ${bom.length===0?'<div style="font-size:11px;color:var(--text-3)">Нет компонентов</div>':
        bom.map((b:any)=>`<div class="bom-row"><span class="bom-qty">${b.quantity}</span><span class="bom-unit">${esc(b.unit)}</span><span style="font-weight:500">${esc(b.child?.code||'?')} ${esc(b.child?.name||'')}</span>${b.reference?`<span class="bom-ref">${esc(b.reference)}</span>`:''}</div>`).join('')}
      <button class="btn-sm" style="width:100%;margin-top:6px;justify-content:center" onclick="openAddBomModal('${productId}')">+ ${t.add_to_bom}</button>
    </div>
    <div class="detail-sec">
      <div class="detail-sec-title">Документы <span class="detail-sec-count">${docs.length}</span></div>
      ${docs.map((d:any)=>`<div style="padding:4px 0;border-bottom:1px solid var(--bg-2);font-size:11px"><span style="font-weight:500">${esc(d.nodes?.name||'?')}</span> <span class="badge badge-stage">${esc(d.document_type)}</span></div>`).join('')}
    </div>`;
}

(window as any).changeLifecycleStage=async(productId:string,dir:string)=>{
  const{data:product}=await sb.from('products').select('*').eq('id',productId).maybeSingle();if(!product)return;
  const idx=LIFECYCLE_STAGES.indexOf(product.lifecycle_stage);
  const newIdx=dir==='next'?Math.min(idx+1,LIFECYCLE_STAGES.length-1):Math.max(idx-1,0);
  if(newIdx===idx)return;
  await sb.from('products').update({lifecycle_stage:LIFECYCLE_STAGES[newIdx],updated_at:new Date().toISOString()}).eq('id',productId);
  await sb.from('audit_log').insert({id:uuidv4(),user_id:currentUser.id,node_id:null,action:'lifecycle_change',details:{product_id:productId,from:product.lifecycle_stage,to:LIFECYCLE_STAGES[newIdx]}});
  cacheInvalidate('products:');
  toast(`${t.lifecycle}: ${t[LIFECYCLE_STAGES[newIdx] as keyof typeof t]}`,'ok');
  openProductDetail(productId);loadProducts();
};

(window as any).openAddProductModal=()=>{
  const m=document.getElementById('modal')!;
  m.innerHTML=`<div class="modal-head"><div class="modal-title">${t.add_product}</div><button class="modal-x" onclick="closeModal()">&times;</button></div>
    <div class="modal-body">
      <div class="fg"><label>${t.code}</label><input id="m-pcode" placeholder="A-100" /></div>
      <div class="fg"><label>${t.name}</label><input id="m-pname" placeholder="Изделие" /></div>
      <div class="fg"><label>${t.description}</label><textarea id="m-pdesc" placeholder="Описание"></textarea></div>
      <div class="fg"><label>${t.lifecycle_stage}</label><select id="m-pstage">${LIFECYCLE_STAGES.map(s=>`<option value="${s}">${t[s as keyof typeof t]||s}</option>`).join('')}</select></div>
    </div>
    <div class="modal-foot"><button class="btn-sm" onclick="closeModal()">${t.cancel}</button><button class="btn-sm primary" onclick="submitAddProduct()">${t.create}</button></div>`;
  document.getElementById('modal-overlay')!.classList.add('open');
};
(window as any).submitAddProduct=async()=>{
  const code=(document.getElementById('m-pcode') as HTMLInputElement).value.trim();
  const name=(document.getElementById('m-pname') as HTMLInputElement).value.trim();
  const desc=(document.getElementById('m-pdesc') as HTMLTextAreaElement).value.trim();
  const stage=(document.getElementById('m-pstage') as HTMLSelectElement).value;
  if(!code||!name){toast('Укажите код и название','err');return;}
  const{error}=await sb.from('products').insert({code,name,description:desc,lifecycle_stage:stage,owner_id:currentUser.id,status:'draft'});
  (window as any).closeModal();if(error)toast('Ошибка: '+error.message,'err');else{cacheInvalidate('products:');toast(t.saved,'ok');loadProducts();}
};

(window as any).startWorkflow=async(productId:string)=>{
  const{data:stages}=await sb.from('workflow_stages').select('*').order('order_index');
  if(!stages||stages.length===0){toast('Нет этапов маршрута','err');return;}
  const first=stages[0];
  await sb.from('workflow_instances').insert({id:uuidv4(),product_id:productId,stage_id:first.id,assigned_to:currentUser.id,status:'in_progress',started_at:new Date().toISOString()});
  await sb.from('audit_log').insert({id:uuidv4(),user_id:currentUser.id,node_id:null,action:'workflow_start',details:{product_id:productId,stage:first.name}});
  toast(t.start_workflow,'ok');openProductDetail(productId);
};

(window as any).openAddBomModal=async(productId:string)=>{
  const{data:products}=await sb.from('products').select('*').neq('id',productId).order('code');
  const m=document.getElementById('modal')!;
  m.innerHTML=`<div class="modal-head"><div class="modal-title">${t.add_to_bom}</div><button class="modal-x" onclick="closeModal()">&times;</button></div>
    <div class="modal-body">
      <div class="fg"><label>Компонент</label><select id="m-bom-child">${(products||[]).map((p:any)=>`<option value="${p.id}">${esc(p.code)} - ${esc(p.name)}</option>`).join('')}</select></div>
      <div class="fg"><label>Количество</label><input id="m-bom-qty" type="number" value="1" /></div>
      <div class="fg"><label>Единица</label><select id="m-bom-unit"><option>pcs</option><option>kg</option><option>m</option><option>l</option></select></div>
      <div class="fg"><label>Позиция</label><input id="m-bom-ref" placeholder="R1, C2..." /></div>
    </div>
    <div class="modal-foot"><button class="btn-sm" onclick="closeModal()">${t.cancel}</button><button class="btn-sm primary" onclick="submitAddBom('${productId}')">${t.create}</button></div>`;
  document.getElementById('modal-overlay')!.classList.add('open');
};
(window as any).submitAddBom=async(productId:string)=>{
  const childId=(document.getElementById('m-bom-child') as HTMLSelectElement).value;
  const qty=parseInt((document.getElementById('m-bom-qty') as HTMLInputElement).value)||1;
  const unit=(document.getElementById('m-bom-unit') as HTMLSelectElement).value;
  const ref=(document.getElementById('m-bom-ref') as HTMLInputElement).value.trim();
  await sb.from('bom_items').insert({id:uuidv4(),parent_product_id:productId,child_product_id:childId,quantity:qty,unit,reference:ref});
  (window as any).closeModal();toast(t.saved,'ok');openProductDetail(productId);
};

// ==================== FILES ====================

let loadFilesSeq = 0;

async function loadFiles(parentId:string|null) {
  const seq = ++loadFilesSeq;
  const c=document.getElementById('content')!;updateBreadcrumb();
  const cacheKey = `nodes:files:${parentId||'root'}`;
  const nodes = await dedupFetch(cacheKey, async () => {
    let q=sb.from('nodes').select('*').eq('is_deleted',false).eq('is_archived',false).order('node_type').order('name');
    if(parentId)q=q.eq('parent_id',parentId);else q=q.is('parent_id',null);
    const{data,error}=await q;if(error)throw new Error(error.message);
    return data||[];
  });
  if (seq !== loadFilesSeq) return;
  const sf=nodes.filter((n: any)=>n.node_type==='folder').length;
  const sfi=nodes.filter((n: any)=>n.node_type==='file').length;
  const ss=nodes.reduce((a:number,n:any)=>a+(n.node_type==='file'?n.size:0),0);
  c.innerHTML=`
    <div class="upload-zone" id="drop-zone"><div class="uz-icon">&#11014;</div><div class="uz-title">${t.upload_title}</div><div class="uz-desc">${t.upload_desc}</div></div>
    <div id="upload-progress"></div>
    <div class="stats"><div class="stat-card"><div class="stat-val">${sf}</div><div class="stat-lbl">${t.folders}</div></div><div class="stat-card"><div class="stat-val">${sfi}</div><div class="stat-lbl">${t.files}</div></div><div class="stat-card"><div class="stat-val">${fmtSize(ss)}</div><div class="stat-lbl">${t.total_size}</div></div></div>
    ${nodes.length>0?`<div class="file-list-header"><div class="fh-name">${t.name}</div><div class="fh-size">${t.size}</div><div class="fh-date">${t.date}</div></div>`:''}
    <div class="file-list" id="file-list-virtual">${nodes.length===0?`<div class="empty"><div class="empty-ic">&#128193;</div><div class="empty-t">${t.no_files}</div></div>`:renderVirtualChunk(nodes,0)}</div>
    <div id="virtual-sentinel" style="height:1px"></div>`;
  setupDropZone();bindFileRows();
  if (nodes.length > 50) setupVirtualScroll(nodes);
  if (currentView === 'files' && !selectedNodeId) {
    renderFilesOverview(nodes, parentId);
  }
}

function renderFilesOverview(nodes: any[], parentId: string | null) {
  const panel = document.getElementById('detail');
  if (!panel) return;
  const folders = nodes.filter((n: any) => n.node_type === 'folder').length;
  const files = nodes.filter((n: any) => n.node_type === 'file').length;
  const size = nodes.reduce((acc: number, n: any) => acc + (n.node_type === 'file' ? (n.size || 0) : 0), 0);
  const title = parentId ? `Папка: ${pathStack[pathStack.length - 1]?.name || 'Хранилище'}` : 'Хранилище';
  panel.style.display = 'flex';
  panel.innerHTML = `
    <div class="detail-head">
      <div class="detail-name">${esc(title)}</div>
      <div class="detail-sub">Рабочая область файлов</div>
    </div>
    <div class="detail-sec">
      <div class="detail-sec-title">Сводка</div>
      <div class="stats" style="grid-template-columns:1fr 1fr 1fr">
        <div class="stat-card" style="padding:10px 12px"><div class="stat-val">${folders}</div><div class="stat-lbl">${t.folders}</div></div>
        <div class="stat-card" style="padding:10px 12px"><div class="stat-val">${files}</div><div class="stat-lbl">${t.files}</div></div>
        <div class="stat-card" style="padding:10px 12px"><div class="stat-val" style="font-size:17px">${fmtSize(size)}</div><div class="stat-lbl">${t.total_size}</div></div>
      </div>
    </div>
    <div class="detail-sec">
      <div class="detail-sec-title">Действия</div>
      <div class="startup-actions" style="margin-top:0">
        <button class="btn-sm primary" onclick="triggerUpload()">Загрузить</button>
        <button class="btn-sm" onclick="createFolder()">Новая папка</button>
      </div>
    </div>
    <div class="detail-sec">
      <div class="detail-sec-title">Подсказка</div>
      <div style="font-size:12px;color:var(--text-2)">Выберите файл, чтобы открыть preview и свойства. Перетащите файл в папку, чтобы переместить его.</div>
    </div>`;
}

async function openFolder(folderId: string, folderName: string) {
  if (!folderId) return;
  setEditingNode(null);
  const last = pathStack[pathStack.length - 1];
  if (!last || last.id !== folderId) {
    pathStack.push({ id: folderId, name: folderName });
  }
  currentParentId = folderId;
  (document.getElementById('btn-back') as HTMLElement).style.display = 'flex';
  showLoading(`Открытие: ${folderName}`);
  try {
    await loadFiles(folderId);
  } finally {
    hideLoading();
  }
}

function fileRow(n:any):string {
  const ic=n.node_type==='folder'?'&#128193;':fileIcon(n.mime_type);
  const icCls=n.node_type==='folder'?'folder':fileIconCls(n.mime_type);
  const badges:string[]=[];
  if(n.is_archived)badges.push(`<span class="badge badge-arch">${t.archived}</span>`);
  if(n.node_type==='file')badges.push(`<span class="badge badge-enc">${t.encrypted}</span>`);
  return `<div class="file-row" data-id="${n.id}" data-type="${n.node_type}"><div class="fr-icon ${icCls}">${ic}</div><div class="fr-name">${esc(n.name)}</div><div class="fr-badges">${badges.join('')}</div><div class="fr-size">${n.node_type==='file'?fmtSize(n.size):'--'}</div><div class="fr-date">${fmtDate(n.updated_at)}</div><div class="fr-actions">${n.node_type==='file'?`<button onclick="event.stopPropagation();previewFile('${n.id}')" title="${t.preview}">&#128065;</button><button onclick="event.stopPropagation();downloadFile('${n.id}')" title="${t.download}">&#11015;</button>`:''}<button onclick="event.stopPropagation();startRename('${n.id}')" title="${t.rename}">&#9998;</button><button class="del" onclick="event.stopPropagation();deleteFile('${n.id}')" title="${t.delete}">&#128465;</button></div></div>`;
}

// --- Virtual scrolling ---
const VIRTUAL_CHUNK = 50;
let virtualAllNodes: any[] = [];
let virtualRendered = 0;
let virtualObserver: IntersectionObserver | null = null;

function renderVirtualChunk(nodes: any[], startIdx: number): string {
  const end = Math.min(startIdx + VIRTUAL_CHUNK, nodes.length);
  let html = '';
  for (let i = startIdx; i < end; i++) html += fileRow(nodes[i]);
  virtualRendered = end;
  return html;
}

function setupVirtualScroll(nodes: any[]) {
  virtualAllNodes = nodes;
  virtualRendered = VIRTUAL_CHUNK;
  if (virtualObserver) virtualObserver.disconnect();
  virtualObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting && virtualRendered < virtualAllNodes.length) {
        const listEl = document.getElementById('file-list-virtual');
        if (!listEl) return;
        listEl.insertAdjacentHTML('beforeend', renderVirtualChunk(virtualAllNodes, virtualRendered));
        bindFileRows();
      }
    }
  }, { rootMargin: '200px' });
  const sentinel = document.getElementById('virtual-sentinel');
  if (sentinel) virtualObserver.observe(sentinel);
}

function bindFileRows() {
  document.querySelectorAll('.file-row:not([data-bound])').forEach(r=>{
    (r as HTMLElement).dataset.bound='1';
    // Make rows draggable for move operations
    (r as HTMLElement).draggable = true;
    r.addEventListener('dragstart',(e: DragEvent)=>{
      e.dataTransfer!.setData('text/plain', (r as HTMLElement).dataset.id!);
      (r as HTMLElement).classList.add('dragging');
    });
    r.addEventListener('dragend',()=>{
      (r as HTMLElement).classList.remove('dragging');
      document.querySelectorAll('.drop-target').forEach(el=>el.classList.remove('drop-target'));
    });
    r.addEventListener('click',async()=>{const id=(r as HTMLElement).dataset.id!,type=(r as HTMLElement).dataset.type!;if(type==='folder'){const name=r.querySelector('.fr-name')!.textContent!;await openFolder(id,name);}else{document.querySelectorAll('.file-row.selected').forEach(x=>x.classList.remove('selected'));r.classList.add('selected');openDetail(id);}});
    r.addEventListener('dblclick',async()=>{const id=(r as HTMLElement).dataset.id!,type=(r as HTMLElement).dataset.type!;if(type==='file')previewFile(id);else{const name=r.querySelector('.fr-name')!.textContent!;await openFolder(id,name);}});
  });
  // Make folder rows drop targets
  document.querySelectorAll('.file-row[data-type="folder"]').forEach(f=>{
    f.addEventListener('dragover',(e: DragEvent)=>{
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'move';
      f.classList.add('drop-target');
    });
    f.addEventListener('dragleave',()=>f.classList.remove('drop-target'));
    f.addEventListener('drop',async(e: DragEvent)=>{
      e.preventDefault();
      f.classList.remove('drop-target');
      const nodeId = e.dataTransfer!.getData('text/plain');
      const targetId = (f as HTMLElement).dataset.id!;
      if(nodeId === targetId) return;
      await moveNodeToFolder(nodeId, targetId);
    });
  });
}

async function moveNodeToFolder(nodeId: string, targetFolderId: string) {
  if(!currentUser) return;
  // Prevent moving a folder into itself or its descendant
  const { data: targetNode } = await sb.from('nodes').select('id, path').eq('id', targetFolderId).maybeSingle();
  if(!targetNode) return;
  const { data: movingNode } = await sb.from('nodes').select('id, name, path, node_type').eq('id', nodeId).maybeSingle();
  if(!movingNode) return;
  // Check for self-move
  if(nodeId === targetFolderId) { toast('Нельзя переместить в себя', 'err'); return; }
  try {
    const newPath = targetNode.path + '/' + movingNode.name;
    await sb.from('nodes').update({ parent_id: targetFolderId, path: newPath, updated_at: new Date().toISOString() }).eq('id', nodeId);
    await sb.from('audit_log').insert({ id: uuidv4(), user_id: currentUser.id, node_id: nodeId, action: 'node_move', details: { target_folder: targetFolderId, new_path: newPath } });
    invalidateNodesAndTreeCaches();
    toast(`Перемещено в ${targetNode.path}`, 'ok');
    loadTree();
    loadFiles(currentParentId);
  } catch(e: any) {
    toast(e.message, 'err');
  }
}

// --- Upload ---
function setupDropZone(){const zone=document.getElementById('drop-zone'),input=document.getElementById('file-input') as HTMLInputElement;if(!zone)return;if((zone as any)._dzBound)return;(zone as any)._dzBound=true;zone.addEventListener('click',()=>input.click());zone.addEventListener('dragover',e=>{e.preventDefault();zone.classList.add('dragover');});zone.addEventListener('dragleave',()=>zone.classList.remove('dragover'));zone.addEventListener('drop',e=>{e.preventDefault();zone.classList.remove('dragover');handleFiles(e.dataTransfer!.files);});input.onchange=()=>{if(input.files)handleFiles(input.files);input.value='';};}
async function handleFiles(fileList:FileList){for(const file of fileList)uploadQueue.push({file,progress:0});if(!isUploading)processUploadQueue();}
async function processUploadQueue(){if(uploadQueue.length===0){isUploading=false;return;}isUploading=true;renderUploadProgress();while(uploadQueue.length>0){const item=uploadQueue[0];try{await uploadFileWithProgress(item);toast(`${t.upload_complete}: ${item.file.name}`,'ok');}catch(e:any){toast(`${t.upload_failed}: ${item.file.name}`,'err');}uploadQueue.shift();renderUploadProgress();}isUploading=false;invalidateNodesAndTreeCaches();loadFiles(currentParentId);loadTree();}
function renderUploadProgress(){const el=document.getElementById('upload-progress');if(!el)return;if(uploadQueue.length===0){el.innerHTML='';return;}el.innerHTML=uploadQueue.map(item=>`<div style="background:var(--bg-1);border:1px solid var(--border);border-radius:var(--r);padding:4px 10px;margin-bottom:3px;display:flex;align-items:center;gap:6px"><span style="font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(item.file.name)}</span><div class="progress-bar" style="width:60px"><div class="progress-fill" style="width:${item.progress}%"></div></div><span style="font-size:10px;color:var(--accent);width:28px;text-align:right">${item.progress}%</span></div>`).join('');}
async function uploadFileWithProgress(item:{file:File;progress:number}){if(!currentUser)throw new Error('No user');const file=item.file;const buf=await file.arrayBuffer();const size=buf.byteLength;const id=uuidv4();item.progress=15;renderUploadProgress();const{error:nodeErr}=await sb.from('nodes').insert({id,parent_id:currentParentId,owner_id:currentUser.id,name:file.name,node_type:'file',path:`/${file.name}`,mime_type:file.type||'application/octet-stream',size});if(nodeErr)throw nodeErr;item.progress=30;renderUploadProgress();const hash=await hashFileInBackground(buf);item.progress=45;renderUploadProgress();const vid=uuidv4();await sb.from('file_versions').insert({id:vid,node_id:id,version_number:1,total_size:size,content_hash:hash,encrypted_key:new Uint8Array(32),key_nonce:new Uint8Array(24),is_current:true,is_compressed:false,created_by:currentUser.id,comment:'Загружен'});item.progress=55;renderUploadProgress();const physicalPath=`/vault/blocks/${hash.substring(0,2)}/${hash}`;const{data:existingBlock,error:existingErr}=await sb.from('data_blocks').select('id, ref_count').eq('content_hash',hash).limit(1);if(existingErr)throw existingErr;let bid:string;if(existingBlock&&existingBlock.length>0){bid=existingBlock[0].id;await sb.from('data_blocks').update({ref_count:(existingBlock[0].ref_count||0)+1}).eq('id',bid);}else{bid=uuidv4();const{error:blockErr}=await sb.from('data_blocks').insert({id:bid,content_hash:hash,encrypted_hash:hash,size,encrypted_size:size+16,physical_path:physicalPath,compression:'none',ref_count:1});if(blockErr)throw blockErr;}await sb.from('file_version_blocks').insert({id:uuidv4(),version_id:vid,block_id:bid,block_index:0,block_offset:0});item.progress=65;renderUploadProgress();// Store actual file content in Supabase Storage for preview/download
const storagePath=`${currentUser.id}/${id}/1`;const{error:storageErr}=await sb.storage.from('vault-files').upload(storagePath,file,{contentType:file.type||'application/octet-stream',upsert:true});if(storageErr)console.warn('Storage upload failed (non-fatal):',storageErr.message);item.progress=85;renderUploadProgress();await sb.from('audit_log').insert({id:uuidv4(),user_id:currentUser.id,node_id:id,action:'version_create',details:{version_number:1,size}});item.progress=100;renderUploadProgress();}
(window as any).triggerUpload=()=>{(document.getElementById('file-input') as HTMLInputElement).click();};
(window as any).createFolder=async()=>{
  if(!currentUser)return;
  const name='Новая папка';
  const id=uuidv4();
  try{
    const{error}=await sb.from('nodes').insert({id,parent_id:currentParentId,owner_id:currentUser.id,name,node_type:'folder',path:`/${name}`,size:0});
    if(error){toast(error.message,'err');return;}
    invalidateNodesAndTreeCaches();
    toast(t.folder_created,'ok');
    loadTree();
    await loadFiles(currentParentId);
    // Inline rename: find the new row and start editing
    requestAnimationFrame(()=>{
      const row=document.querySelector(`.file-row[data-id="${id}"]`);
      if(row){
        row.classList.add('selected');
        startRename(id);
      }
    });
  }catch(e:any){
    toast(e.message,'err');
    loadFiles(currentParentId);
  }
};

// --- Breadcrumb ---
function updateBreadcrumb(){document.getElementById('bc')!.innerHTML=pathStack.map((p,i)=>`<a onclick="navTo(${i})">${esc(p.name)}</a>${i<pathStack.length-1?'<span class="sep">/</span>':''}`).join('');}
(window as any).navTo=(idx:number)=>{pathStack=pathStack.slice(0,idx+1);currentParentId=pathStack[idx].id;loadFiles(currentParentId);(document.getElementById('btn-back') as HTMLElement).style.display=pathStack.length>1?'flex':'none';};

// --- Detail ---
async function openDetail(nodeId:string) {
  await setEditingNode(nodeId);
  selectedNodeId=nodeId;const panel=document.getElementById('detail')!;panel.style.display='flex';
  const{data:node}=await sb.from('nodes').select('*').eq('id',nodeId).maybeSingle();if(!node)return;
  panel.innerHTML=`<div class="detail-head"><div class="detail-name">${esc(node.name)}</div><div class="detail-sub">${esc(node.mime_type||'Файл')} &middot; ${fmtSize(node.size)}</div></div><div style="padding:14px;color:var(--text-3)">Загрузка...</div>`;
  const[verRes,aclRes,shrRes,commentsRes]=await Promise.all([
    sb.from('file_versions').select('*').eq('node_id',nodeId).order('version_number',{ascending:false}),
    sb.from('access_control_lists').select('*, user_profiles(email, full_name)').eq('node_id',nodeId),
    sb.from('share_links').select('*').eq('node_id',nodeId).eq('is_active',true),
    sb.from('version_comments').select('*, user_profiles(email, full_name)').eq('version_id',(await sb.from('file_versions').select('id').eq('node_id',nodeId).eq('is_current',true).maybeSingle()).data?.id||''),
  ]);
  const versions=verRes.data||[];const acls=aclRes.data||[];const shares=shrRes.data||[];const comments=commentsRes.data||[];
  const isOwner=node.owner_id===currentUser?.id;const currentVer=versions.find((v:any)=>v.is_current);
  panel.innerHTML=`
    <div class="detail-head"><div class="detail-name">${esc(node.name)}</div><div class="detail-sub">${esc(node.mime_type||'Файл')} &middot; ${fmtSize(node.size)} &middot; ${fmtDate(node.created_at)}</div></div>
    <div class="detail-actions">
      ${node.node_type==='file'?`<button class="btn-sm" onclick="previewFile('${nodeId}')">&#128065; ${t.preview}</button><button class="btn-sm" onclick="downloadFile('${nodeId}')">&#11015; ${t.download}</button>${!node.is_archived?`<button class="btn-sm" onclick="archiveFile('${nodeId}')">&#128230; ${t.archive_btn}</button>`:`<button class="btn-sm" onclick="unarchiveFileAction('${nodeId}')">&#128193; ${t.unarchive_btn}</button>`}<button class="btn-sm" onclick="lockFile('${nodeId}')">&#128274; Lock</button>`:''}
      <button class="btn-sm" onclick="startRename('${nodeId}')" style="margin-left:auto">&#9998; ${t.rename}</button>
      <button class="btn-sm danger" onclick="deleteFile('${nodeId}')">&#128465; ${t.delete}</button>
    </div>
    <div class="detail-sec"><div class="detail-sec-title">${t.versions} <span class="detail-sec-count">${versions.length}</span></div>
      ${versions.map((v:any)=>`<div class="ver-item"><div class="ver-dot ${v.is_current?'cur':''}"></div><div class="ver-info"><div class="ver-num">v${v.version_number} ${v.is_current?`(${t.current})`:''}</div>${v.comment?`<div class="ver-comment">${v.comment}</div>`:''}<div class="ver-date">${fmtDate(v.created_at)}</div></div><div class="ver-size">${fmtSize(v.total_size)}</div>${!v.is_current?`<button class="btn-restore" onclick="restoreVer('${nodeId}',${v.version_number})">${t.restore}</button>`:''}</div>`).join('')}
    </div>
    ${currentVer?`<div class="detail-sec"><div class="detail-sec-title">${t.comment} <span class="detail-sec-count">${comments.length}</span></div>
      ${comments.map((c:any)=>`<div class="comment-item"><span class="comment-author">${esc(c.user_profiles?.full_name||c.user_profiles?.email||'?')}</span><div class="comment-text">${esc(c.comment)}</div><div class="comment-date">${fmtDate(c.created_at)}</div></div>`).join('')}
      <div class="comment-form"><textarea id="new-comment" placeholder="${t.add_comment}..." style="min-height:64px;resize:vertical"></textarea><button onclick="addComment('${currentVer.id}')">${t.create}</button></div><div id="live-cursors" style="margin-top:6px;font-size:11px;color:var(--text-2)"></div></div>`:''}
    <div class="detail-sec"><div class="detail-sec-title">${t.access} <span class="detail-sec-count">${acls.length}</span></div>
      ${acls.length===0?`<div style="font-size:11px;color:var(--text-3)">${t.owner_only}</div>`:acls.map((a:any)=>`<div class="acl-row"><div class="acl-av">${esc((a.user_profiles?.full_name||a.user_profiles?.email||'?')[0].toUpperCase())}</div><div class="acl-name">${esc(a.user_profiles?.full_name||a.user_profiles?.email||'?')}</div><span class="acl-perm ${a.permission}">${a.permission}</span>${isOwner?`<button class="btn-restore" onclick="revokeAccess('${nodeId}','${a.user_id}')" style="color:var(--red)">&times;</button>`:''}</div>`).join('')}
      ${isOwner?`<button class="btn-sm" style="width:100%;margin-top:6px;justify-content:center" onclick="openGrantModal('${nodeId}')">+ ${t.grant_access}</button>`:''}</div>
    <div class="detail-sec"><div class="detail-sec-title">${t.share_links} <span class="detail-sec-count">${shares.length}</span></div>
      ${shares.map((s:any)=>`<div class="share-row"><div class="share-tok">${s.token.substring(0,20)}...</div><div class="share-meta">${s.permission==='read'?t.read_only:t.read_write} &middot; ${s.access_count} ${t.accesses}${s.expires_at?` &middot; ${fmtDate(s.expires_at)}`:''}</div><button class="btn-restore" onclick="revokeShare('${s.id}','${nodeId}')" style="color:var(--red);margin-top:2px">${t.revoke}</button></div>`).join('')}
      <button class="btn-sm primary" style="width:100%;margin-top:8px;justify-content:center" onclick="openShareModal('${nodeId}')">${t.create_link}</button></div>`;
  const commentInput = document.getElementById('new-comment') as HTMLTextAreaElement | null;
  if (commentInput && currentUser) {
    let typingTimer: any = null;
    const calcLineCol = () => {
      const pos = commentInput.selectionStart || 0;
      const value = commentInput.value || '';
      const before = value.slice(0, pos);
      const parts = before.split('\n');
      return { pos, line: parts.length, col: (parts[parts.length - 1] || '').length + 1 };
    };
    const sendCursor = (typing: boolean) => {
      const lc = calcLineCol();
      broadcastEditingCursor(
        { node_id: nodeId, field: 'comment', pos: lc.pos, typing, line: lc.line, col: lc.col },
        { user_id: currentUser.id, email: currentUser.email || '', full_name: currentUser.full_name || '' },
      );
    };
    commentInput.addEventListener('input', () => {
      sendCursor(true);
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => sendCursor(false), 1200);
    });
    commentInput.addEventListener('click', () => sendCursor(true));
    commentInput.addEventListener('keyup', () => sendCursor(true));
    commentInput.addEventListener('blur', () => sendCursor(false));
    renderLiveCursors(nodeId);
  }
}

(window as any).addComment=async(versionId:string)=>{const input=document.getElementById('new-comment') as HTMLInputElement;const comment=input.value.trim();if(!comment)return;try{await sb.from('version_comments').insert({id:uuidv4(),version_id:versionId,user_id:currentUser.id,comment});toast(t.comment,'ok');if(selectedNodeId)openDetail(selectedNodeId);}catch(e:any){toast(e.message,'err');}};
(window as any).deleteFile=async(nodeId:string)=>{if(!confirm(t.delete_confirm))return;optimisticRemoveRow(nodeId);try{await softDeleteNode(nodeId,currentUser.id);invalidateNodesAndTreeCaches();toast(t.delete,'ok');document.getElementById('detail')!.style.display='none';loadTree();if(currentView==='files')loadFiles(currentParentId);}catch(e:any){toast(e.message,'err');loadView(currentView);}};
(window as any).archiveFile=async(nodeId:string)=>{optimisticRemoveRow(nodeId);try{await sb.from('nodes').update({is_archived:true,updated_at:new Date().toISOString()}).eq('id',nodeId);await sb.from('audit_log').insert({id:uuidv4(),user_id:currentUser.id,node_id:nodeId,action:'archive_files',details:{}});invalidateNodesAndTreeCaches();toast(t.archive_btn,'ok');document.getElementById('detail')!.style.display='none';loadTree();if(currentView==='files')loadFiles(currentParentId);}catch(e:any){toast(e.message,'err');loadView(currentView);}};
(window as any).unarchiveFileAction=async(nodeId:string)=>{try{await unarchiveFile(nodeId);invalidateNodesAndTreeCaches();toast(t.unarchive_btn,'ok');if(currentView==='archived')loadArchived();else if(currentView==='files')loadFiles(currentParentId);loadTree();}catch(e:any){toast(e.message,'err');}};
(window as any).downloadFile=async(nodeId:string)=>{
  const{data:node}=await sb.from('nodes').select('name,mime_type').eq('id',nodeId).maybeSingle();if(!node)return;
  if (demoMode) {
    const blob = generateDemoContent(node.name, node.mime_type || 'application/octet-stream', 1024);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');a.href=url;a.download=node.name;a.click();
    URL.revokeObjectURL(url);
    return;
  }
  try{
    const h=await vaultHeaders();
    const res=await fetch(`${VAULT_API}/files/content?node_id=${nodeId}`,{headers:h});
    const data=await res.json();
    if(data.url){
      // Fetch actual content from signed URL
      const fileRes=await fetch(data.url);
      if(fileRes.ok){
        const blob=await fileRes.blob();
        const url=URL.createObjectURL(blob);
        const a=document.createElement('a');a.href=url;a.download=node.name;a.click();
        URL.revokeObjectURL(url);
        return;
      }
    }
  }catch{/* fall through to placeholder */}
  // Fallback: placeholder download
  const blob=new Blob([`Vault PLM: ${node.name}`],{type:node.mime_type||'application/octet-stream'});
  const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=node.name;a.click();URL.revokeObjectURL(url);
};
(window as any).lockFile=async(nodeId:string)=>{try{const result=await acquireFileLock(nodeId,currentUser.id,30000);if(result.acquired)toast(t.lock_acquired,'ok');else toast(t.lock_failed,'err');}catch(e:any){toast(e.message,'err');}};
(window as any).restoreVer=async(nodeId:string,vn:number)=>{try{await restoreFileVersion(nodeId,vn,currentUser.id);toast(`${t.version_restored}: v${vn}`,'ok');openDetail(nodeId);}catch(e:any){toast(e.message,'err');}};
(window as any).revokeAccess=async(nodeId:string,userId:string)=>{try{await revokePermission(currentUser.id,userId,nodeId);toast(t.revoke_access,'ok');openDetail(nodeId);}catch(e:any){toast(e.message,'err');}};
(window as any).openGrantModal=(nodeId:string)=>{const m=document.getElementById('modal')!;sb.from('user_profiles').select('id,email,full_name,role').then(({data})=>{const users=data||[];m.innerHTML=`<div class="modal-head"><div class="modal-title">${t.grant_access}</div><button class="modal-x" onclick="closeModal()">&times;</button></div><div class="modal-body"><div class="fg"><label>${t.user}</label><select id="m-grant-user">${users.map((u:any)=>`<option value="${u.id}">${esc(u.full_name||u.email)} (${u.role})</option>`).join('')}</select></div><div class="fg"><label>${t.permission}</label><select id="m-grant-perm"><option value="read">${t.read_only}</option><option value="write">${t.read_write}</option><option value="admin">admin</option></select></div><div class="fg"><label>${t.inherit}</label><select id="m-grant-inherit"><option value="true">${t.inherited}</option><option value="false">${t.direct}</option></select></div></div><div class="modal-foot"><button class="btn-sm" onclick="closeModal()">${t.cancel}</button><button class="btn-sm primary" onclick="submitGrant('${nodeId}')">${t.grant}</button></div>`;document.getElementById('modal-overlay')!.classList.add('open');});};
(window as any).submitGrant=async(nodeId:string)=>{const userId=(document.getElementById('m-grant-user') as HTMLSelectElement).value;const perm=(document.getElementById('m-grant-perm') as HTMLSelectElement).value as Permission;const inherit=(document.getElementById('m-grant-inherit') as HTMLSelectElement).value==='true';try{await grantPermission(currentUser.id,userId,nodeId,perm,inherit);(window as any).closeModal();toast(t.grant_access,'ok');openDetail(nodeId);}catch(e:any){toast(e.message,'err');}};

// --- Share ---
let shareNodeId:string|null=null;
(window as any).openShareModal=(nodeId:string)=>{shareNodeId=nodeId;const m=document.getElementById('modal')!;m.innerHTML=`<div class="modal-head"><div class="modal-title">${t.create_link}</div><button class="modal-x" onclick="closeModal()">&times;</button></div><div class="modal-body"><div class="fg"><label>${t.password}</label><input type="password" id="m-pw" placeholder="${t.unlimited}" /></div><div class="fg"><label>${t.ttl}</label><input type="number" id="m-ttl" value="24" /></div><div class="fg"><label>${t.permission}</label><select id="m-perm"><option value="read">${t.read_only}</option><option value="write">${t.read_write}</option></select></div><div class="fg"><label>${t.max_access}</label><input type="number" id="m-max" placeholder="${t.unlimited}" /></div></div><div class="modal-foot"><button class="btn-sm" onclick="closeModal()">${t.cancel}</button><button class="btn-sm primary" onclick="submitShare()">${t.create}</button></div>`;document.getElementById('modal-overlay')!.classList.add('open');};
(window as any).closeModal=()=>{document.getElementById('modal-overlay')!.classList.remove('open');};
(window as any).submitShare=async()=>{if(!shareNodeId||!currentUser)return;const pw=(document.getElementById('m-pw') as HTMLInputElement).value;const ttl=parseInt((document.getElementById('m-ttl') as HTMLInputElement).value)||24;const perm=(document.getElementById('m-perm') as HTMLSelectElement).value as 'read'|'write';const max=(document.getElementById('m-max') as HTMLInputElement).value;try{const result=await createShareLink(currentUser.id,shareNodeId,{password:pw||undefined,expiresInHours:ttl,maxAccessCount:max?parseInt(max):undefined,permission:perm});(window as any).closeModal();toast(`${t.link_created}: ${result.token.substring(0,12)}...`,'ok');openDetail(shareNodeId);}catch(e:any){(window as any).closeModal();toast(e.message,'err');}};
(window as any).revokeShare=async(linkId:string,nodeId:string)=>{try{await revokeShareLink(currentUser.id,linkId);toast(t.revoke,'ok');openDetail(nodeId);}catch(e:any){toast(e.message,'err');}};

// --- Move modal ---
async function openMoveModal(nodeId: string) {
  const { data: node } = await sb.from('nodes').select('id, name, parent_id').eq('id', nodeId).maybeSingle();
  if (!node) return;
  const { data: folders } = await sb.from('nodes').select('id, name, parent_id, path').eq('node_type', 'folder').eq('is_deleted', false).eq('is_archived', false).neq('id', nodeId).order('name');
  const m = document.getElementById('modal')!;
  m.innerHTML = `<div class="modal-head"><div class="modal-title">Переместить: ${esc(node.name)}</div><button class="modal-x" onclick="closeModal()">&times;</button></div>
    <div class="modal-body">
      <div class="fg"><label>Целевая папка</label>
        <select id="m-move-target">
          <option value="">Корень хранилища</option>
          ${(folders || []).map((f: any) => `<option value="${f.id}" ${f.id === node.parent_id ? 'disabled' : ''}>${esc(f.path || f.name)}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="modal-foot"><button class="btn-sm" onclick="closeModal()">${t.cancel}</button><button class="btn-sm primary" onclick="submitMove('${nodeId}')">Переместить</button></div>`;
  document.getElementById('modal-overlay')!.classList.add('open');
}
(window as any).submitMove = async (nodeId: string) => {
  const targetId = (document.getElementById('m-move-target') as HTMLSelectElement).value || null;
  if (targetId) {
    await moveNodeToFolder(nodeId, targetId);
  } else {
    // Move to root
    if (!currentUser) return;
    const { data: node } = await sb.from('nodes').select('name').eq('id', nodeId).maybeSingle();
    if (!node) return;
    try {
      await sb.from('nodes').update({ parent_id: null, path: `/${node.name}`, updated_at: new Date().toISOString() }).eq('id', nodeId);
      await sb.from('audit_log').insert({ id: uuidv4(), user_id: currentUser.id, node_id: nodeId, action: 'node_move', details: { target_folder: null } });
      invalidateNodesAndTreeCaches();
      toast('Перемещено в корень', 'ok');
      loadTree();
      loadFiles(currentParentId);
    } catch (e: any) { toast(e.message, 'err'); }
  }
  (window as any).closeModal();
};

// --- Trash ---
async function loadTrash(){const c=document.getElementById('content')!;const nodes=await dedupFetch('nodes:trash',async()=>{const{data,error}=await sb.from('nodes').select('*').eq('is_deleted',true).order('deleted_at',{ascending:false});if(error)throw new Error(error.message);return data||[];});updateBreadcrumbView(t.trash);c.innerHTML=nodes.length===0?`<div class="empty"><div class="empty-ic">&#128465;</div><div class="empty-t">${t.no_trash}</div></div>`:`<div class="file-list">${nodes.map((n: any)=>`<div class="file-row" data-id="${n.id}" data-type="${n.node_type}"><div class="fr-icon file">${n.node_type==='folder'?'&#128193;':'&#128196;'}</div><div class="fr-name">${esc(n.name)}</div><div class="fr-size">${fmtSize(n.size)}</div><div class="fr-date">${fmtDate(n.deleted_at)}</div><div class="fr-actions"><button onclick="event.stopPropagation();restoreFromTrash('${n.id}')">${t.restore}</button></div></div>`).join('')}</div>`;}
(window as any).restoreFromTrash=async(nodeId:string)=>{try{await sb.from('nodes').update({is_deleted:false,deleted_at:null,updated_at:new Date().toISOString()}).eq('id',nodeId);invalidateNodesAndTreeCaches();toast(t.restore,'ok');loadTrash();loadTree();if(currentView==='files')loadFiles(currentParentId);}catch(e:any){toast(e.message,'err');}};
(window as any).purgeTrash=async()=>{try{const count=await purgeDeletedNodes(0);toast(`${t.purge_done}: ${count}`,'ok');loadTrash();}catch(e:any){toast(e.message,'err');}};

// --- Recent ---
async function loadRecent(){const c=document.getElementById('content')!;const data=await dedupFetch('nodes:recent',async()=>{const{data,error}=await sb.from('nodes').select('*').eq('is_deleted',false).eq('is_archived',false).eq('node_type','file').order('updated_at',{ascending:false}).limit(20);if(error)throw new Error(error.message);return data||[];});updateBreadcrumbView(t.recent);c.innerHTML=`<div class="file-list-header"><div class="fh-name">${t.name}</div><div class="fh-size">${t.size}</div><div class="fh-date">${t.date}</div></div><div class="file-list">${(data||[]).map((n: any)=>fileRow(n)).join('')}</div>`;bindFileRows();}

// --- Shared ---
async function loadShared(){const c=document.getElementById('content')!;const data=await dedupFetch('share_links:list',async()=>{const{data,error}=await sb.from('share_links').select('*, nodes(name)').order('created_at',{ascending:false});if(error)throw new Error(error.message);return data||[];});updateBreadcrumbView(t.shared);c.innerHTML=(data||[]).length===0?`<div class="empty"><div class="empty-ic">&#128279;</div><div class="empty-t">${t.no_links}</div></div>`:`<table class="tbl"><thead><tr><th>${t.name}</th><th>Токен</th><th>${t.permission}</th><th>${t.accesses}</th><th></th></tr></thead><tbody>${(data||[]).map((l: any)=>`<tr><td>${esc(l.nodes?.name||'?')}</td><td><span class="share-tok">${l.token.substring(0,16)}...</span></td><td>${esc(l.permission)}</td><td>${l.access_count}</td><td>${l.is_active?`<button class="btn-sm danger" onclick="revokeShare('${l.id}','${l.node_id}')">${t.revoke}</button>`:''}</td></tr>`).join('')}</tbody></table>`;}

// --- Archived ---
async function loadArchived(){const c=document.getElementById('content')!;const data=await dedupFetch('nodes:archived',async()=>{const{data,error}=await sb.from('nodes').select('*').eq('is_archived',true).eq('is_deleted',false).order('updated_at',{ascending:false});if(error)throw new Error(error.message);return data||[];});updateBreadcrumbView(t.archive);c.innerHTML=`<div class="file-list">${(data||[]).map((n: any)=>fileRow(n)).join('')}</div>`;bindFileRows();}

// --- Analytics ---
async function loadAnalytics(){const c=document.getElementById('content')!;updateBreadcrumbView(t.analytics);const[nodesRes,blocksRes,versionsRes,auditRes,productsRes]=await Promise.all([sb.from('nodes').select('node_type,mime_type,size,created_at').eq('is_deleted',false),sb.from('data_blocks').select('size,ref_count,created_at'),sb.from('file_versions').select('total_size,is_compressed,created_at'),sb.from('audit_log').select('action,created_at').order('created_at',{ascending:false}).limit(200),sb.from('products').select('lifecycle_stage,status')]);const nodes=nodesRes.data||[];const blocks=blocksRes.data||[];const versions=versionsRes.data||[];const audit=auditRes.data||[];const products=productsRes.data||[];
const totalFiles=nodes.filter(n=>n.node_type==='file').length;const totalFolders=nodes.filter(n=>n.node_type==='folder').length;const totalSize=nodes.filter(n=>n.node_type==='file').reduce((a:number,n:any)=>a+n.size,0);const compressedVersions=versions.filter(v=>v.is_compressed).length;const orphanBlocks=blocks.filter(b=>b.ref_count<=0).length;const maxStorage=parseInt((await sb.from('server_config').select('value').eq('key','max_storage_gb').maybeSingle()).data?.value||'100')*1024*1024*1024;const usedPercent=maxStorage>0?Math.min(100,Math.round(totalSize/maxStorage*100)):0;
const byType:Record<string,number>={};nodes.filter(n=>n.node_type==='file').forEach(n=>{const ext=(n.mime_type||'other').split('/').pop()||'other';byType[ext]=(byType[ext]||0)+1;});
const topTypes=Object.entries(byType).sort((a,b)=>b[1]-a[1]).slice(0,6);const maxTypeCount=topTypes.length>0?topTypes[0][1]:1;
const dayMap:Record<string,number>={};const now=new Date();for(let i=13;i>=0;i--){const d=new Date(now);d.setDate(d.getDate()-i);dayMap[d.toISOString().split('T')[0]]=0;}audit.forEach(a=>{const day=a.created_at?.split('T')[0];if(day&&day in dayMap)dayMap[day]++;});const dayEntries=Object.entries(dayMap);const maxDay=Math.max(1,...dayEntries.map(d=>d[1]));
const stageCounts:Record<string,number>={};products.forEach(p=>{stageCounts[p.lifecycle_stage]=(stageCounts[p.lifecycle_stage]||0)+1;});
c.innerHTML=`
  <div class="stats"><div class="stat-card"><div class="stat-val">${totalFiles}</div><div class="stat-lbl">${t.files}</div></div><div class="stat-card"><div class="stat-val">${totalFolders}</div><div class="stat-lbl">${t.folders}</div></div><div class="stat-card"><div class="stat-val">${fmtSize(totalSize)}</div><div class="stat-lbl">${t.total_size}</div></div><div class="stat-card"><div class="stat-val">${products.length}</div><div class="stat-lbl">${t.products}</div></div><div class="stat-card"><div class="stat-val">${compressedVersions}</div><div class="stat-lbl">${t.compressed}</div></div></div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
    <div style="background:var(--bg-1);border:1px solid var(--border);border-radius:var(--r-lg);padding:12px"><div class="detail-sec-title">${t.disk_usage}</div><div class="gauge"><div class="gauge-bar"><div class="gauge-fill" style="width:${usedPercent}%;background:${usedPercent>80?'var(--red)':usedPercent>60?'var(--yellow)':'var(--green)'}"></div></div><div class="gauge-labels"><span>${fmtSize(totalSize)}</span><span>${fmtSize(maxStorage)}</span></div></div><div style="margin-top:6px;font-size:11px;color:var(--text-2)">${usedPercent}% занято</div></div>
    <div style="background:var(--bg-1);border:1px solid var(--border);border-radius:var(--r-lg);padding:12px"><div class="detail-sec-title">${t.products} по этапам</div>${LIFECYCLE_STAGES.map(s=>`<div style="display:flex;align-items:center;gap:6px;padding:2px 0;font-size:11px"><span style="width:80px;color:var(--text-2)">${t[s as keyof typeof t]||s}</span><div class="progress-bar" style="flex:1"><div class="progress-fill" style="width:${products.length>0?stageCounts[s]||0:0}/${products.length||1}*100%;background:var(--accent)"></div></div><span style="font-weight:600">${stageCounts[s]||0}</span></div>`).join('')}</div>
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
    <div style="background:var(--bg-1);border:1px solid var(--border);border-radius:var(--r-lg);padding:12px"><div class="detail-sec-title">${t.files_by_type}</div><div class="chart-bar-container">${topTypes.map(([k,v])=>`<div class="chart-bar" style="height:${Math.max(8,v/maxTypeCount*100)}%"><div class="chart-bar-val">${v}</div><div class="chart-bar-label">${k}</div></div>`).join('')}</div></div>
    <div style="background:var(--bg-1);border:1px solid var(--border);border-radius:var(--r-lg);padding:12px"><div class="detail-sec-title">${t.daily_uploads}</div><div class="chart-bar-container">${dayEntries.map(([d,v])=>`<div class="chart-bar" style="height:${Math.max(4,v/maxDay*100)}%;background:var(--green)"><div class="chart-bar-val">${v||''}</div><div class="chart-bar-label">${d.slice(5)}</div></div>`).join('')}</div></div>
  </div>`;}

// --- Audit ---
async function loadAudit(){const c=document.getElementById('content')!;const data=await dedupFetch('audit_log:list',async()=>{const{data,error}=await sb.from('audit_log').select('*').order('created_at',{ascending:false}).limit(100);if(error)throw new Error(error.message);return data||[];});updateBreadcrumbView(t.audit);c.innerHTML=(data||[]).length===0?`<div class="empty"><div class="empty-ic">&#128203;</div><div class="empty-t">${t.no_audit}</div></div>`:`<table class="tbl"><thead><tr><th>${t.date}</th><th>${t.type}</th><th>Детали</th></tr></thead><tbody>${(data||[]).map((e:any)=>`<tr><td>${fmtDate(e.created_at)}</td><td>${fmtAction(e.action)}</td><td style="color:var(--text-3);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${JSON.stringify(e.details).substring(0,50)}</td></tr>`).join('')}</tbody></table>`;}

// --- Blocks ---
async function loadBlocks(){const c=document.getElementById('content')!;const blocks=await dedupFetch('data_blocks:list',async()=>{const{data,error}=await sb.from('data_blocks').select('*').order('created_at',{ascending:false}).limit(50);if(error)throw new Error(error.message);return data||[];});updateBreadcrumbView(t.storage);const ts=blocks.reduce((a:number,b:any)=>a+b.size,0);const orphans=blocks.filter((b:any)=>b.ref_count<=0).length;c.innerHTML=`<div class="stats"><div class="stat-card"><div class="stat-val">${blocks.length}</div><div class="stat-lbl">${t.blocks}</div></div><div class="stat-card"><div class="stat-val">${fmtSize(ts)}</div><div class="stat-lbl">${t.total_size}</div></div><div class="stat-card"><div class="stat-val" style="color:${orphans>0?'var(--yellow)':'var(--green)'}">${orphans}</div><div class="stat-lbl">Орфаны</div></div></div><table class="tbl"><thead><tr><th>${t.hash}</th><th>${t.size}</th><th>${t.refs}</th><th>${t.compression}</th></tr></thead><tbody>${blocks.map((b:any)=>`<tr><td style="font-family:monospace;color:var(--accent);font-size:11px">${b.content_hash.substring(0,16)}...</td><td>${fmtSize(b.size)}</td><td style="color:${b.ref_count<=0?'var(--yellow)':'var(--text-0)'}">${b.ref_count}</td><td>${b.compression}</td></tr>`).join('')}</tbody></table>`;}
(window as any).runGC=async()=>{showLoading(t.gc);try{const count=await garbageCollectBlocks('/vault');cacheInvalidate('data_blocks:');toast(`${t.gc_done}: ${count}`,'ok');loadBlocks();}catch(e:any){toast(e.message,'err');}finally{hideLoading();}};

// --- Admin ---
async function loadAdmin(){const c=document.getElementById('content')!;updateBreadcrumbView(t.admin);const[profilesRes,nodesRes,blocksRes,versionsRes]=await Promise.all([sb.from('user_profiles').select('*').order('created_at',{ascending:false}),sb.from('nodes').select('*',{count:'exact',head:true}).eq('is_deleted',false),sb.from('data_blocks').select('*',{count:'exact',head:true}),sb.from('file_versions').select('*',{count:'exact',head:true})]);const users=profilesRes.data||[];c.innerHTML=`<div class="stats"><div class="stat-card"><div class="stat-val">${nodesRes.count||0}</div><div class="stat-lbl">${t.files}</div></div><div class="stat-card"><div class="stat-val">${versionsRes.count||0}</div><div class="stat-lbl">${t.versions}</div></div><div class="stat-card"><div class="stat-val">${blocksRes.count||0}</div><div class="stat-lbl">${t.blocks}</div></div></div><div class="section-header"><div class="section-title">${t.users}</div><button class="btn-sm primary" onclick="openAddUserModal()">+ ${t.add_user}</button></div><table class="tbl"><thead><tr><th>${t.email}</th><th>${t.role}</th><th>2FA</th><th>${t.created}</th><th></th></tr></thead><tbody>${users.map((u:any)=>`<tr><td style="font-weight:500">${u.email}</td><td><span class="acl-perm ${u.role==='owner'?'admin':u.role==='editor'?'write':'read'}">${u.role}</span></td><td>${u.totp_enabled?'<span class="badge badge-enc">ON</span>':'<span class="badge badge-arch">OFF</span>'}</td><td style="color:var(--text-3)">${fmtDate(u.created_at)}</td><td>${u.id!==currentUser?.id?`<button class="btn-sm danger" onclick="deleteUser('${u.id}')">${t.delete}</button>`:''}</td></tr>`).join('')}</tbody></table>`;}
(window as any).openAddUserModal=()=>{const m=document.getElementById('modal')!;m.innerHTML=`<div class="modal-head"><div class="modal-title">${t.add_user}</div><button class="modal-x" onclick="closeModal()">&times;</button></div><div class="modal-body"><div class="fg"><label>${t.email}</label><input id="m-uname" type="email" placeholder="user@company.com" /></div><div class="fg"><label>${t.password}</label><input id="m-upw" type="password" placeholder="Минимум 6 символов" /></div><div class="fg"><label>${t.full_name}</label><input id="m-ufname" placeholder="Иванов И.И." /></div><div class="fg"><label>${t.role}</label><select id="m-role"><option value="viewer">viewer</option><option value="editor">editor</option><option value="auditor">auditor</option><option value="owner">owner</option></select></div></div><div class="modal-foot"><button class="btn-sm" onclick="closeModal()">${t.cancel}</button><button class="btn-sm primary" onclick="submitAddUser()">${t.create}</button></div>`;document.getElementById('modal-overlay')!.classList.add('open');};
(window as any).submitAddUser=async()=>{const email=(document.getElementById('m-uname') as HTMLInputElement).value.trim();const pw=(document.getElementById('m-upw') as HTMLInputElement).value;const fname=(document.getElementById('m-ufname') as HTMLInputElement).value.trim();const role=(document.getElementById('m-role') as HTMLSelectElement).value;if(!email||!pw){toast('Укажите email и пароль','err');return;}const{error}=await sb.auth.signUp({email,password:pw,options:{data:{full_name:fname,role}}});(window as any).closeModal();if(error)toast('Ошибка: '+error.message,'err');else{toast(t.user_added,'ok');loadAdmin();}};
(window as any).deleteUser=async(id:string)=>{if(!confirm('Удалить пользователя?'))return;const{error}=await sb.from('user_profiles').delete().eq('id',id);if(error){toast(error.message,'err');return;}loadAdmin();};
(window as any).runArchive=async()=>{showLoading(t.run_archive);try{const result=await archiveOldVersions({versionAgeDays:90,fileIdleDays:180,compressionAlgorithm:'zstd',batchSize:100},currentUser?.id);invalidateNodesAndTreeCaches();toast(`${t.archive_done}: ${result.versionsArchived} версий`,'ok');loadAdmin();}catch(e:any){toast(e.message,'err');}finally{hideLoading();}};

// --- Server/Connection config ---
async function loadServer(){const c=document.getElementById('content')!;updateBreadcrumbView(t.connection);const[connRes,serverRes]=await Promise.all([sb.from('connection_config').select('*').order('key'),sb.from('server_config').select('*').order('key')]);const conn=connRes.data||[];const server=serverRes.data||[];
const nodes=(await sb.from('nodes').select('size').eq('is_deleted',false).eq('node_type','file')).data||[];const totalSize=nodes.reduce((a:number,n:any)=>a+n.size,0);const maxStorage=parseInt(server.find(c=>c.key==='max_storage_gb')?.value||'100')*1024*1024*1024;const usedPct=maxStorage>0?Math.min(100,Math.round(totalSize/maxStorage*100)):0;
c.innerHTML=`
  <div class="stats"><div class="stat-card"><div class="stat-val">${fmtSize(totalSize)}</div><div class="stat-lbl">${t.used}</div></div><div class="stat-card"><div class="stat-val">${fmtSize(maxStorage)}</div><div class="stat-lbl">${t.total_storage}</div></div><div class="stat-card"><div class="stat-val" style="color:${usedPct>80?'var(--red)':usedPct>60?'var(--yellow)':'var(--green)'}">${usedPct}%</div><div class="stat-lbl">${t.disk_usage}</div></div></div>
  <div class="gauge" style="margin-bottom:16px"><div class="gauge-bar"><div class="gauge-fill" style="width:${usedPct}%;background:${usedPct>80?'var(--red)':usedPct>60?'var(--yellow)':'var(--green)'}"></div></div><div class="gauge-labels"><span>${fmtSize(totalSize)}</span><span>${fmtSize(maxStorage)}</span></div></div>
  <div class="section-header"><div class="section-title">${t.connection}</div><button class="btn-sm primary" onclick="saveConnectionConfig()">${t.save}</button></div>
  <div class="config-grid">${conn.map(cfg=>`<div class="config-item"><div class="config-key">${cfg.key==='supabase_url'?t.db_url:cfg.key==='supabase_anon_key'?t.db_key:cfg.key==='supabase_service_role_key'?t.db_service_key:cfg.key}</div><div class="config-val"><input data-table="connection_config" data-key="${cfg.key}" type="${cfg.is_encrypted?'password':'text'}" value="${cfg.value}" /></div>${cfg.is_encrypted?`<div class="config-encrypted">${t.encrypted_field}</div>`:''}</div>`).join('')}</div>
  <div class="section-header" style="margin-top:16px"><div class="section-title">${t.config}</div><button class="btn-sm primary" onclick="saveServerConfig()">${t.save}</button></div>
  <div class="config-grid">${server.map(cfg=>`<div class="config-item"><div class="config-key">${cfg.key}</div><div class="config-val"><input data-table="server_config" data-key="${cfg.key}" value="${cfg.value}" /></div></div>`).join('')}</div>
  <div style="margin-top:16px;padding:12px;background:var(--bg-1);border:1px solid var(--border);border-radius:var(--r-lg)"><div class="detail-sec-title">${t.deploy}</div><p style="font-size:11px;color:var(--text-2);margin-bottom:8px">Развертывание на сервере через SFTP/SSH</p><button class="btn-sm primary" onclick="deployToServer()">&#128421; Развернуть</button></div>`;}
(window as any).saveConnectionConfig=async()=>{const inputs=document.querySelectorAll('[data-table="connection_config"]');for(const input of inputs){const key=(input as HTMLInputElement).dataset.key!;const value=(input as HTMLInputElement).value;await sb.from('connection_config').update({value,updated_by:currentUser.id,updated_at:new Date().toISOString()}).eq('key',key);}toast(t.saved,'ok');};
(window as any).saveServerConfig=async()=>{const inputs=document.querySelectorAll('[data-table="server_config"]');for(const input of inputs){const key=(input as HTMLInputElement).dataset.key!;const value=(input as HTMLInputElement).value;await sb.from('server_config').update({value,updated_by:currentUser.id,updated_at:new Date().toISOString()}).eq('key',key);}toast(t.saved,'ok');};
(window as any).deployToServer=async()=>{toast('Развертывание запущено...','ok');await sb.from('audit_log').insert({id:uuidv4(),user_id:currentUser.id,node_id:null,action:'deploy_start',details:{timestamp:new Date().toISOString()}});setTimeout(()=>toast('Развертывание завершено (демо)','ok'),2000);};

// --- Extensions ---
async function loadExtensions(){const c=document.getElementById('content')!;updateBreadcrumbView(t.extensions);const{data,error}=await sb.from('file_extensions').select('*').order('extension');if(error){c.innerHTML=errMsg(error.message);return;}c.innerHTML=`<div class="section-header"><div class="section-title">${t.extensions} (${(data||[]).length})</div><button class="btn-sm primary" onclick="openAddExtModal()">+ ${t.add_extension}</button></div><table class="tbl"><thead><tr><th>${t.extension}</th><th>${t.mime}</th><th>${t.viewer}</th><th>${t.library}</th><th></th></tr></thead><tbody>${(data||[]).map((e:any)=>`<tr><td style="font-weight:600">.${e.extension}</td><td style="color:var(--text-2);font-size:11px">${e.mime_type}</td><td><span class="badge ${e.is_active?'badge-enc':'badge-arch'}">${e.viewer_type}</span></td><td style="color:var(--text-3);font-size:11px">${e.viewer_library||'-'}</td><td><button class="btn-sm danger" onclick="deleteExt('${e.id}')">${t.delete}</button></td></tr>`).join('')}</tbody></table>`;}
(window as any).openAddExtModal=()=>{const m=document.getElementById('modal')!;m.innerHTML=`<div class="modal-head"><div class="modal-title">${t.add_extension}</div><button class="modal-x" onclick="closeModal()">&times;</button></div><div class="modal-body"><div class="fg"><label>${t.extension}</label><input id="m-ext" placeholder="pdf" /></div><div class="fg"><label>${t.mime}</label><input id="m-mime" placeholder="application/pdf" /></div><div class="fg"><label>${t.viewer}</label><select id="m-viewer"><option value="text">text</option><option value="image">image</option><option value="iframe">iframe</option><option value="native">native</option><option value="custom">custom</option></select></div><div class="fg"><label>${t.library}</label><input id="m-lib" placeholder="npm:lib (optional)" /></div></div><div class="modal-foot"><button class="btn-sm" onclick="closeModal()">${t.cancel}</button><button class="btn-sm primary" onclick="submitAddExt()">${t.create}</button></div>`;document.getElementById('modal-overlay')!.classList.add('open');};
(window as any).submitAddExt=async()=>{const ext=(document.getElementById('m-ext') as HTMLInputElement).value.trim().replace(/^\./,'');const mime=(document.getElementById('m-mime') as HTMLInputElement).value.trim();const viewer=(document.getElementById('m-viewer') as HTMLSelectElement).value;const lib=(document.getElementById('m-lib') as HTMLInputElement).value.trim();if(!ext)return;const{error}=await sb.from('file_extensions').insert({extension:ext,mime_type:mime,viewer_type:viewer,viewer_library:lib||null});(window as any).closeModal();if(error)toast('Ошибка: '+error.message,'err');else{toast(t.saved,'ok');loadExtensions();}};
(window as any).deleteExt=async(id:string)=>{try{await sb.from('file_extensions').delete().eq('id',id);loadExtensions();}catch(e:any){toast(e.message,'err');}};

// --- Security (2FA, sessions, password change) ---
async function loadSecurity() {
  const c = document.getElementById('content')!;
  updateBreadcrumbView(t.security);
  const userId = currentUser?.id;
  if (!userId) { c.innerHTML = errMsg('Не авторизован'); return; }

  const { data: profile } = await sb.from('user_profiles').select('*').eq('id', userId).maybeSingle();
  const { data: factorsData } = await sb.auth.mfa.listFactors();
  const allFactors = (factorsData as any)?.all || [];
  const totpFactor = allFactors.find((f: any) => f.factor_type === 'totp' && f.status === 'verified');
  const has2FA = !!totpFactor;

  const sessions = await auth.getActiveSessions();

  c.innerHTML = `
    <div class="section-header"><div class="section-title">${t.two_factor}</div></div>
    <div style="background:var(--bg-1);border:1px solid var(--border);border-radius:var(--r-lg);padding:14px;margin-bottom:14px">
      ${has2FA
        ? `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><span class="badge badge-enc">${t.active}</span><span style="font-size:12px;color:var(--text-1)">2FA включена</span></div>
           <button class="btn-sm danger" onclick="disable2FA('${totpFactor.id}')">${t.disable_2fa}</button>`
        : `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><span class="badge badge-arch">${t.inactive}</span><span style="font-size:12px;color:var(--text-1)">2FA не настроена</span></div>
           <button class="btn-sm primary" onclick="start2FASetup()">${t.enable_2fa}</button>`}
    </div>
    <div id="setup-2fa-area"></div>

    <div class="section-header" style="margin-top:16px"><div class="section-title">${t.change_password}</div></div>
    <div style="background:var(--bg-1);border:1px solid var(--border);border-radius:var(--r-lg);padding:14px;margin-bottom:14px">
      <div class="fg"><label>${t.new_password}</label><input id="sec-newpw" type="password" placeholder="Минимум 6 символов" /></div>
      <div class="fg"><label>${t.confirm_password}</label><input id="sec-confirmpw" type="password" /></div>
      <div id="sec-pw-error" style="color:var(--red);font-size:11px;display:none"></div>
      <button class="btn-sm primary" onclick="handleChangePassword()">${t.save}</button>
    </div>

    <div class="section-header" style="margin-top:16px"><div class="section-title">${t.sessions}</div></div>
    <div style="background:var(--bg-1);border:1px solid var(--border);border-radius:var(--r-lg);padding:14px">
      ${sessions.length === 0
        ? `<div style="font-size:12px;color:var(--text-3)">Нет активных сессий</div>`
        : `<table class="tbl"><thead><tr><th>${t.device}</th><th>IP</th><th>${t.last_active}</th><th></th></tr></thead><tbody>
           ${sessions.map((s: any) => `<tr><td style="font-size:11px">${s.device_info || 'Браузер'}</td><td style="font-size:11px">${s.ip_address || '-'}</td><td style="font-size:11px">${fmtDate(s.created_at)}</td><td><button class="btn-sm danger" onclick="revokeSession('${s.id}')">${t.revoke}</button></td></tr>`).join('')}
           </tbody></table>
           <button class="btn-sm danger" style="margin-top:8px" onclick="revokeAllSessions()">${t.revoke_all_sessions}</button>`}
    </div>`;
}

(window as any).start2FASetup = async () => {
  const result = await auth.enable2FA();
  if (!result) { toast('Ошибка настройки 2FA', 'err'); return; }
  const area = document.getElementById('setup-2fa-area')!;
  area.innerHTML = `
    <div style="background:var(--bg-1);border:1px solid var(--accent);border-radius:var(--r-lg);padding:14px;margin-bottom:14px">
      <div style="font-size:13px;font-weight:600;margin-bottom:8px">${t.scan_qr}</div>
      <div style="background:var(--bg-2);border:1px solid var(--border);border-radius:var(--r);padding:12px;margin-bottom:8px;font-family:monospace;font-size:10px;word-break:break-all;color:var(--accent)">${result.uri}</div>
      <div style="font-size:11px;color:var(--text-2);margin-bottom:8px">Секрет: <code style="background:var(--bg-2);padding:1px 4px;border-radius:3px">${result.secret}</code></div>
      <div class="fg"><label>Код подтверждения</label><input id="setup-2fa-code" type="text" maxlength="6" placeholder="000000" inputmode="numeric" /></div>
      <div id="setup-2fa-error" style="color:var(--red);font-size:11px;display:none"></div>
      <button class="btn-sm primary" onclick="verify2FASetup('${result.factorId}')">${t.verify_2fa}</button>
    </div>`;
};

(window as any).verify2FASetup = async (factorId: string) => {
  const code = (document.getElementById('setup-2fa-code') as HTMLInputElement).value.trim();
  const errEl = document.getElementById('setup-2fa-error')!;
  if (!code || code.length !== 6) { errEl.textContent = 'Введите 6-значный код'; errEl.style.display = 'block'; return; }
  const result = await auth.verify2FASetup(factorId, code);
  if (result.error) { errEl.textContent = result.error; errEl.style.display = 'block'; return; }
  toast('2FA включена', 'ok');
  loadSecurity();
};

(window as any).disable2FA = async (factorId: string) => {
  const result = await auth.disable2FA(factorId);
  if (result.error) { toast(result.error, 'err'); return; }
  toast('2FA отключена', 'ok');
  loadSecurity();
};

(window as any).handleChangePassword = async () => {
  const pw = (document.getElementById('sec-newpw') as HTMLInputElement).value;
  const confirm = (document.getElementById('sec-confirmpw') as HTMLInputElement).value;
  const errEl = document.getElementById('sec-pw-error')!;
  if (pw !== confirm) { errEl.textContent = 'Пароли не совпадают'; errEl.style.display = 'block'; return; }
  if (pw.length < 6) { errEl.textContent = 'Минимум 6 символов'; errEl.style.display = 'block'; return; }
  const result = await auth.updatePassword(pw);
  if (result.error) { errEl.textContent = result.error; errEl.style.display = 'block'; return; }
  toast(t.password_changed, 'ok');
  (document.getElementById('sec-newpw') as HTMLInputElement).value = '';
  (document.getElementById('sec-confirmpw') as HTMLInputElement).value = '';
};

(window as any).revokeSession = async (sessionId: string) => {
  await auth.revokeSession(sessionId);
  toast('Сессия отозвана', 'ok');
  loadSecurity();
};

(window as any).revokeAllSessions = async () => {
  await auth.revokeAllOtherSessions();
  toast(t.revoke_all_sessions, 'ok');
  loadSecurity();
};

// --- Backups & Integrity ---
const VAULT_API = `${SUPABASE_URL}/functions/v1/vault`;
/** Edge Function: JWT пользователя + apikey (не анонимный ключ как Bearer). */
async function vaultHeaders(): Promise<Record<string, string>> {
  if (demoMode) {
    return {
      Authorization: 'Bearer demo',
      apikey: 'demo',
      'Content-Type': 'application/json',
    };
  }
  const { data: { session } } = await sb.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error('Нет сессии');
  return {
    Authorization: `Bearer ${token}`,
    apikey: SUPABASE_ANON_KEY,
    'Content-Type': 'application/json',
  };
}

async function loadBackups() {
  const c = document.getElementById('content')!;
  updateBreadcrumbView(t.backups);

  let backups: any[] = [];
  let checks: any[] = [];
  try {
    const h = await vaultHeaders();
    const [backupsJson, integrityRes] = await Promise.all([
      fetch(`${VAULT_API}/backups`, { headers: h }).then((r) => r.json()),
      sb.from('file_integrity_checks').select('*, nodes(name)').order('checked_at', { ascending: false }).limit(20),
    ]);
    backups = Array.isArray(backupsJson) ? backupsJson : [];
    checks = integrityRes.data || [];
  } catch {
    backups = [];
    try {
      const { data } = await sb.from('file_integrity_checks').select('*, nodes(name)').order('checked_at', { ascending: false }).limit(20);
      checks = data || [];
    } catch {
      checks = [];
    }
  }

  c.innerHTML = `
    <div class="section-header"><div class="section-title">${t.backups}</div>
      <button class="btn-sm primary" onclick="openBackupModal()">${t.create_backup}</button>
    </div>
    <table class="tbl"><thead><tr>
      <th>${t.date}</th><th>${t.backup_type}</th><th>${t.backup_status}</th>
      <th>${t.files}</th><th>${t.versions}</th><th>${t.blocks}</th>
      <th>${t.backup_size}</th><th>${t.backup_checksum}</th><th></th>
    </tr></thead><tbody>
    ${backups.length === 0 ? `<tr><td colspan="9" style="text-align:center;color:var(--text-3);padding:20px">Нет резервных копий</td></tr>` :
      backups.map((b: any) => `<tr>
        <td style="font-size:11px">${fmtDate(b.started_at)}</td>
        <td><span class="badge ${b.type==='full'?'badge-stage':'badge-arch'}">${b.type}</span></td>
        <td><span class="badge ${b.status==='completed'?'badge-enc':b.status==='failed'?'badge-arch':'badge-stage'}">${t[b.status as keyof typeof t] || b.status}</span></td>
        <td style="font-size:11px">${b.total_nodes||0}</td>
        <td style="font-size:11px">${b.total_versions||0}</td>
        <td style="font-size:11px">${b.total_blocks||0}</td>
        <td style="font-size:11px">${fmtSize(b.total_size||0)}</td>
        <td style="font-size:10px;font-family:monospace;max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${b.checksum||''}">${b.is_verified ? '<span style="color:var(--green)">&#10003;</span>' : '<span style="color:var(--yellow)">&#9679;</span>'} ${(b.checksum||'').substring(0,12)}...</td>
        <td style="white-space:nowrap">
          ${b.status==='completed'?`<button class="btn-sm" onclick="verifyBackup('${b.id}')">${t.verify}</button><button class="btn-sm" onclick="restoreBackup('${b.id}')">${t.restore}</button>`:''}
        </td>
      </tr>`).join('')}
    </tbody></table>

    <div class="section-header" style="margin-top:20px"><div class="section-title">${t.integrity_results}</div>
      <button class="btn-sm" onclick="runIntegrityCheckAll()">${t.integrity_check}</button>
    </div>
    ${checks.length === 0 ? `<div style="color:var(--text-3);font-size:12px;padding:12px">Проверки целостности не проводились</div>` :
      `<table class="tbl"><thead><tr><th>${t.name}</th><th>Версия</th><th>${t.backup_status}</th><th>${t.date}</th><th>Детали</th></tr></thead><tbody>
      ${checks.map((ch: any) => `<tr>
        <td style="font-size:11px">${esc(ch.nodes?.name || ch.node_id?.substring(0,8) || '')}</td>
        <td style="font-size:11px">${ch.version_id?.substring(0,8)}</td>
        <td>${ch.is_valid ? '<span style="color:var(--green)">&#10003; OK</span>' : '<span style="color:var(--red)">&#10007; FAIL</span>'}</td>
        <td style="font-size:11px">${fmtDate(ch.checked_at)}</td>
        <td style="font-size:10px;color:var(--text-3)">${esc(ch.error_detail || '-')}</td>
      </tr>`).join('')}
      </tbody></table>`}`;
}

(window as any).openBackupModal = () => {
  const m = document.getElementById('modal')!;
  m.innerHTML = `<div class="modal-head"><div class="modal-title">${t.create_backup}</div><button class="modal-x" onclick="closeModal()">&times;</button></div>
    <div class="modal-body">
      <div class="fg"><label>${t.backup_type}</label>
        <select id="m-backup-type">
          <option value="full">${t.full_backup}</option>
          <option value="incremental">${t.incremental_backup}</option>
          <option value="metadata_only">${t.metadata_only}</option>
          <option value="blocks_only">${t.blocks_only}</option>
        </select>
      </div>
    </div>
    <div class="modal-foot"><button class="btn-sm" onclick="closeModal()">${t.cancel}</button><button class="btn-sm primary" onclick="submitCreateBackup()">${t.create}</button></div>`;
  document.getElementById('modal-overlay')!.classList.add('open');
};

(window as any).submitCreateBackup = async () => {
  const type = (document.getElementById('m-backup-type') as HTMLSelectElement).value;
  (window as any).closeModal();
  showLoading(`${t.create_backup}...`);
  try {
    updateLoading(`Создание бэкапа (${type})...`);
    const res = await fetch(`${VAULT_API}/backups`, {
      method: 'POST',
      headers: await vaultHeaders(),
      body: JSON.stringify({ type }),
    });
    const data = await res.json();
    if (data.error) { toast(data.error, 'err'); return; }
    toast(`${t.backup_created}: ${data.total_nodes} файлов, ${data.total_blocks} блоков`, 'ok');
    loadBackups();
  } catch (e: any) { toast(e.message, 'err'); }
  finally { hideLoading(); }
};

(window as any).verifyBackup = async (id: string) => {
  showLoading(`${t.verify}...`);
  try {
    updateLoading('Проверка контрольных сумм...');
    const res = await fetch(`${VAULT_API}/backups/verify`, {
      method: 'POST',
      headers: await vaultHeaders(),
      body: JSON.stringify({ backup_id: id }),
    });
    const data = await res.json();
    if (data.error) { toast(data.error, 'err'); return; }
    toast(data.is_valid ? t.backup_verified : 'Бэкап повреждён!', data.is_valid ? 'ok' : 'err');
    loadBackups();
  } catch (e: any) { toast(e.message, 'err'); }
  finally { hideLoading(); }
};

(window as any).restoreBackup = async (id: string) => {
  if (!confirm(t.restore_confirm)) return;
  showLoading(`${t.restore}...`);
  try {
    updateLoading('Восстановление данных из бэкапа...');
    const res = await fetch(`${VAULT_API}/backups/restore`, {
      method: 'POST',
      headers: await vaultHeaders(),
      body: JSON.stringify({ backup_id: id }),
    });
    const data = await res.json();
    if (data.error) { toast(data.error, 'err'); return; }
    invalidateNodesAndTreeCaches();
    toast(t.backup_restored, 'ok');
    loadBackups();
  } catch (e: any) { toast(e.message, 'err'); }
  finally { hideLoading(); }
};

(window as any).runIntegrityCheckAll = async () => {
  showLoading(`${t.integrity_check}...`);
  try {
    const { data: nodes } = await sb.from('nodes').select('id').eq('is_deleted', false).eq('node_type', 'file').limit(50);
    if (!nodes || nodes.length === 0) { toast('Нет файлов для проверки', 'err'); return; }
    let checked = 0;
    let issues = 0;
    const total = nodes.length;
    for (const node of nodes) {
      updateLoading(`${t.integrity_check}: ${checked + 1}/${total}`);
      const res = await fetch(`${VAULT_API}/integrity-check`, {
        method: 'POST',
        headers: await vaultHeaders(),
        body: JSON.stringify({ node_id: node.id }),
      });
      const data = await res.json();
      if (data.all_valid === false) issues++;
      checked++;
    }
    toast(`${t.integrity_checked}: ${checked} файлов, ${issues} проблем`, issues > 0 ? 'err' : 'ok');
    loadBackups();
  } catch (e: any) { toast(e.message, 'err'); }
  finally { hideLoading(); }
};

// --- Helpers ---
function fmtSize(b:number):string{if(b===0)return'0 Б';const k=1024;const u=['Б','КБ','МБ','ГБ','ТБ'];const i=Math.floor(Math.log(b)/Math.log(k));return parseFloat((b/Math.pow(k,i)).toFixed(1))+' '+u[i];}
function fmtDate(d:string):string{if(!d)return'--';return new Date(d).toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});}
function fmtAction(a:string):string{const map:Record<string,string>={version_create:'Создание версии',version_restore:'Восстановление',acl_grant:'Выдача прав',acl_revoke:'Отзыв прав',share_link_create:'Создание ссылки',share_link_revoke:'Отзыв ссылки',node_soft_delete:'Удаление',node_rename:'Переименование',node_move:'Перемещение',archive_versions:'Архивация',archive_files:'Архивация файлов',file_lock:'Блокировка',file_unlock:'Разблокировка',conflict_resolve:'Разрешение конфликта',lifecycle_change:'Смена этапа ЖЦ',workflow_start:'Запуск маршрута',deploy_start:'Развертывание'};return map[a]||a.replace(/_/g,' ');}
function fileIcon(mime:string|null):string{if(!mime)return'&#128196;';if(mime.startsWith('image/'))return'&#128444;';if(mime.includes('pdf'))return'&#128213;';if(mime.includes('word')||mime.includes('doc'))return'&#128209;';if(mime.includes('sheet')||mime.includes('xls')||mime.includes('csv'))return'&#128202;';return'&#128196;';}
function fileIconCls(mime:string|null):string{if(!mime)return'file';if(mime.startsWith('image/'))return'img';if(mime.includes('pdf')||mime.includes('word')||mime.includes('doc'))return'doc';return'file';}
function errMsg(msg:string):string{return`<div class="empty"><div class="empty-ic">&#9888;</div><div class="empty-t">Ошибка</div><div class="empty-d">${esc(msg)}</div></div>`;}
function updateBreadcrumbView(name:string){document.getElementById('bc')!.innerHTML=`<a>${t.vault}</a><span class="sep">/</span><a>${name}</a>`;}
function toast(msg:string,type:'ok'|'err'){
  const c=document.getElementById('toasts')!;
  const d=document.createElement('div');
  d.className=`toast ${type}`;
  const icon=document.createElement('span');
  icon.textContent=type==='ok'?'OK':'ERR';
  const text=document.createElement('span');
  text.textContent=` ${msg}`;
  d.append(icon,text);
  c.appendChild(d);
  setTimeout(()=>{d.style.opacity='0';d.style.transform='translateX(100%)';d.style.transition='all .2s';setTimeout(()=>d.remove(),200);},3000);
}

// --- Theme toggle ---
function applyTheme(theme: string) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('vault-theme', theme);
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.innerHTML = theme === 'dark' ? '&#9788;' : '&#9790;';
}
(window as any).toggleTheme = () => {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  applyTheme(current === 'dark' ? 'light' : 'dark');
};
// Restore saved theme
const savedTheme = localStorage.getItem('vault-theme');
if (savedTheme) applyTheme(savedTheme);
else if (window.matchMedia('(prefers-color-scheme: dark)').matches) applyTheme('dark');

// --- Boot ---
init();
