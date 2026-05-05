# Vault PLM

Система управления документами и продуктами корпоративного уровня с шифрованием, версионностью, совместной работой, PLM-функционалом и аутентификацией.

## Архитектура

Vault PLM построен на основе Content-Addressable Storage (CAS) с поблочной дедупликацией, RBAC+ACL моделью доступа, оптимистичным блокированием, криптографическим обменом ссылками и Supabase Auth для аутентификации.

```
┌─────────────────────────────────────────────────────────┐
│                    Клиентские приложения                 │
│  ┌──────────────────┐    ┌──────────────────────────┐   │
│  │   Веб-интерфейс   │    │   Electron (десктоп)      │   │
│  │   (Vite + TS)     │    │   (main.js + preload.js)  │   │
│  └────────┬─────────┘    └────────────┬───────────────┘   │
│           └──────────┬────────────────┘                   │
│                      │                                    │
│           ┌──────────▼──────────┐                         │
│           │   src/core/         │                         │
│           │   versioning.ts     │  Версионность           │
│           │   access.ts        │  Управление доступом    │
│           │   sharing.ts       │  Общие ссылки           │
│           │   archival.ts      │  Архивация              │
│           │   conflict.ts      │  Разрешение конфликтов  │
│           └──────────┬──────────┘                         │
│                      │                                    │
│           ┌──────────▼──────────┐                         │
│           │   src/utils/        │                         │
│           │   crypto.ts         │  SHA-256, PBKDF2       │
│           │   db.ts             │  Supabase клиент        │
│           └──────────┬──────────┘                         │
│                      │                                    │
│           ┌──────────▼──────────┐                         │
│           │   src/web/auth.ts    │                        │
│           │   AuthService        │  Supabase Auth + 2FA  │
│           └──────────┬──────────┘                         │
│                      │                                    │
└──────────────────────┼────────────────────────────────────┘
                       │
           ┌───────────▼───────────┐
           │   Supabase (PostgreSQL)│
           │   ┌─────────────────┐ │
           │   │ auth.users      │ │  Аутентификация
           │   │ user_profiles   │ │  Профили пользователей
           │   │ user_sessions   │ │  Сессии
           │   │ nodes           │ │  Файловая иерархия
           │   │ file_versions   │ │  Версии файлов
           │   │ data_blocks     │ │  CAS-блоки
           │   │ access_control  │ │  ACL
           │   │ share_links     │ │  Общие ссылки
           │   │ audit_log       │ │  Аудит
           │   │ version_comments│ │  Комментарии
           │   │ server_config   │ │  Конфигурация
           │   │ file_extensions │ │  Расширения
           │   │ collab_sessions │ │  Совместная работа
           │   │ storage_usage   │ │  Статистика хранилища
           │   │ products        │ │  Продукты (PLM)
           │   │ bom_items       │ │  Состав изделия (BOM)
           │   │ workflow_stages │ │  Этапы согласования
           │   │ workflow_instances│ │  Экземпляры процессов
           │   │ backups         │ │  Резервные копии
           │   │ backup_snapshots│ │  Снимки для восстановления
           │   │ file_integrity_checks│ │  Проверка целостности
           │   │ auth_rate_limits│ │  Rate limiting
           │   └─────────────────┘ │
           └───────────────────────┘
```

## Функциональность

### Аутентификация и безопасность
- Supabase Auth (email/password) -- вход, регистрация, сброс пароля
- Двухфакторная аутентификация (TOTP) через Supabase MFA
- Автоматическое создание профиля при регистрации (триггер `handle_new_user`)
- Управление сессиями: просмотр активных сессий, отзыв
- Rate limiting для auth-эндпоинтов (5 попыток / 5 минут)
- Блокировка аккаунта после превышения лимита

### Управление файлами
- Загрузка файлов с drag-and-drop и прогресс-баром
- Создание папок и навигация по иерархии
- Переименование файлов и папок (F2, контекстное меню, inline-кнопка)
- Удаление в корзину с возможностью восстановления
- Архивация/разархивация файлов
- Поиск файлов по имени с debounce
- Древовидная структура папок в боковой панели
- Навигация назад (кнопка, Backspace, хлебные крошки)

### Версионность
- Автоматическое создание версий при каждой загрузке
- Просмотр истории версий в панели деталей
- Восстановление любой предыдущей версии
- Комментарии к версиям (критично для совместной работы)
- Поблочная дедупликация (4MB блоки, SHA-256)
- Сжатие старых версий (zstd/lz4)
- Сборка мусора для осиротевших блоков

### Управление доступом
- RBAC: owner / editor / viewer / auditor
- ACL: прямые и наследуемые права (read / write / admin)
- Проверка прав: Owner > Direct ACL > Inherited ACL > Denied
- Выдача и отзыв прав через модальное окно

### Общие ссылки
- Создание защищенных ссылок с токеном (48 байт, криптографическая стойкость)
- Защита паролем (PBKDF2, 600K итераций)
- Срок действия (TTL в часах)
- Ограничение количества доступов
- Права: только чтение / чтение и запись
- Отзыв ссылок

### Совместная работа
- Индикатор онлайн-пользователей (polling каждые 5 сек)
- Отображение аватаров активных пользователей
- Блокировка файлов для редактирования (advisory lock)
- Обнаружение и разрешение конфликтов версий
- Стратегии: keep_both / last_writer_wins / manual

### PLM: Продукты и BOM
- Управление продуктами: создание, редактирование, удаление
- Состав изделия (BOM): иерархия компонентов с количеством
- Привязка документов к продуктам
- Этапы согласования (workflow stages)
- Экземпляры процессов согласования

### Резервное копирование и целостность
- Типы бэкапов: полный, инкрементальный, только метаданные, только блоки
- Point-in-time восстановление с верификацией
- Снимки таблиц (backup_snapshots) с SHA-256 чексуммами
- Проверка целостности файлов (file_integrity_checks)
- SHA-256 чексумма всего манифеста бэкапа
- UI управления бэкапами: создание, верификация, восстановление

### Просмотр файлов
- Предпросмотр файлов по двойному клику
- Поддержка типов: image, text, iframe, native, custom
- 20 предустановленных расширений
- Управление расширениями через админку
- Добавление библиотек просмотрщиков (npm/CDN)

### Аналитика
- Дашборд с метриками: файлы, папки, версии, сжатые, пользователи
- Gauge использования диска (процент занятого пространства)
- Графики: файлы по типу, хранилище по типу
- Загрузки по дням (последние 14 дней)
- Последняя активность (аудит-лог)

### Администрирование
- Управление пользователями (создание, удаление, роли)
- Запуск архивации старых версий
- Сборка мусора (удаление осиротевших блоков)
- Очистка корзины
- Управление бэкапами

### Безопасность (Security view)
- Включение/отключение 2FA (TOTP) с QR-кодом
- Смена пароля
- Просмотр и отзыв активных сессий

### Сервер и развертывание
- Конфигурация сервера: хост, порт, пользователь, путь, SSH-ключ
- Лимит хранилища (GB)
- Настройки бэкапа: интервал, путь
- Индикатор использования диска
- Кнопка развертывания на сервере (SFTP/SSH)

### Расширения
- Управление поддерживаемыми форматами файлов
- Добавление новых расширений с MIME-типом
- Выбор типа просмотрщика: text / image / iframe / native / custom
- Указание библиотеки для рендеринга

## Структура проекта

```
├── index.html              # HTML-шаблон с CSS
├── package.json            # Зависимости и скрипты
├── tsconfig.json           # Конфигурация TypeScript
├── vite.config.ts          # Конфигурация Vite
├── electron/
│   ├── main.js             # Главное окно Electron
│   └── preload.js          # Secure bridge для FS
├── src/
│   ├── main.ts             # Точка входа (CLI)
│   ├── types/
│   │   └── index.ts        # Типы: Node, FileVersion, DataBlock, ACL, ShareLink, AuditLog
│   ├── core/
│   │   ├── index.ts        # Реэкспорт всех модулей
│   │   ├── versioning.ts   # saveFileVersion, restoreFileVersion, garbageCollectBlocks
│   │   ├── access.ts       # checkPermission, grantPermission, revokePermission
│   │   ├── sharing.ts      # createShareLink, revokeShareLink
│   │   ├── archival.ts     # archiveOldVersions, softDeleteNode, purgeDeletedNodes
│   │   └── conflict.ts     # detectConflict, resolveConflict, acquireFileLock
│   ├── utils/
│   │   ├── crypto.ts       # SHA-256, PBKDF2, генерация токенов, разбиение на блоки
│   │   └── db.ts           # Supabase клиент (singleton)
│   └── web/
│       ├── main.ts         # Веб-интерфейс (SPA)
│       └── auth.ts         # AuthService: Supabase Auth + TOTP + MFA
├── supabase/
│   ├── functions/
│   │   └── vault/
│   │       └── index.ts    # Edge Function: API для версионности, ACL, шаринга, бэкапов
│   └── migrations/
│       ├── 003_vault_helper_functions.sql       # Индексы, триггеры, хелперы
│       ├── 005_fix_users_rls.sql                # RLS для users
│       ├── 006_fix_all_rls_anon.sql             # RLS для всех таблиц
│       ├── 007_fix_node_closure_rls.sql         # RLS для node_closure
│       ├── 009_plm_products_workflows_bom.sql   # PLM: продукты, BOM, workflow
│       ├── 010_auth_security_foundation.sql      # Auth: профили, сессии, rate limits, RLS
│       ├── 011_backup_integrity.sql              # Бэкапы, снимки, проверка целостности
│       ├── 012_fix_rls_recursion_and_cleanup.sql # Устранение рекурсии RLS, удаление anon-политик
│       ├── 013_fix_legacy_users_fk.sql           # Перенос FK с public.users на auth.users
│       ├── 014_fix_nodes_acl_recursion.sql      # SECURITY DEFINER хелперы для разрыва рекурсии
│       ├── 015_enable_realtime_publication.sql  # Публикация таблиц для Supabase Realtime
│       └── 016_security_rls_tightening.sql       # Ужесточение RLS после аудита
```

## Схема базы данных

### Аутентификация

| Таблица | Описание | Ключевые поля |
|---------|----------|---------------|
| `auth.users` | Пользователи Supabase Auth | id, email, encrypted_password |
| `auth.identities` | Identity провайдеры | id, user_id, provider, identity_data |
| `user_profiles` | Профили приложения | id (FK auth.users), email, full_name, role, totp_enabled |
| `user_sessions` | Активные сессии | user_id, session_token_hash, is_active, expires_at |
| `auth_rate_limits` | Rate limiting | identifier, action, attempt_count, window_start |

### Файловая система

| Таблица | Описание | Ключевые поля |
|---------|----------|---------------|
| `nodes` | Файловая иерархия | id, parent_id, name, node_type, size, is_archived, is_deleted |
| `file_versions` | Версии файлов | id, node_id, version_number, content_hash, is_current, comment |
| `data_blocks` | CAS-блоки | id, content_hash, size, ref_count, compression |
| `file_version_blocks` | Связь версий и блоков | version_id, block_id, block_index |
| `access_control_lists` | ACL | node_id, user_id, permission, inherit |
| `share_links` | Общие ссылки | token, password_hash, expires_at, max_access_count |
| `audit_log` | Аудит | user_id, node_id, action, details (JSON) |
| `node_closure` | Замыкание для иерархии | ancestor_id, descendant_id, depth |
| `version_comments` | Комментарии к версиям | version_id, user_id, comment |
| `collab_sessions` | Сессии совместной работы | node_id, user_id, session_id, cursor_position |
| `storage_usage` | Снимки использования диска | snapshot_date, total_files, total_size, orphan_blocks |

### PLM

| Таблица | Описание | Ключевые поля |
|---------|----------|---------------|
| `products` | Продукты | id, name, description, owner_id, status |
| `product_documents` | Документы продуктов | product_id, node_id |
| `bom_items` | Состав изделия | product_id, parent_item_id, part_name, quantity |
| `workflow_stages` | Этапы согласования | id, name, stage_order, is_required |
| `workflow_instances` | Экземпляры процессов | product_id, current_stage, status |

### Бэкапы и целостность

| Таблица | Описание | Ключевые поля |
|---------|----------|---------------|
| `backups` | Реестр бэкапов | id, type, status, metadata_json, blocks_manifest, checksum |
| `backup_snapshots` | Снимки таблиц | backup_id, table_name, row_count, checksum, data |
| `file_integrity_checks` | Проверка целостности | node_id, version_id, expected_hash, verified_hash, is_valid |

### Конфигурация

| Таблица | Описание | Ключевые поля |
|---------|----------|---------------|
| `server_config` | Конфигурация сервера | key (unique), value |
| `connection_config` | Подключения | key, value |
| `file_extensions` | Поддерживаемые расширения | extension (unique), mime_type, viewer_type, viewer_library |

## API (Edge Function)

Edge Function `vault` предоставляет REST API:

| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/vault/versions` | Создать новую версию файла |
| GET | `/vault/versions?node_id=` | Получить список версий |
| POST | `/vault/permissions/check` | Проверить права доступа |
| POST | `/vault/share-links` | Создать общую ссылку |
| GET | `/vault/nodes?parent_id=` | Получить содержимое папки |
| GET | `/vault/audit?node_id=` | Получить аудит-лог |
| POST | `/vault/backups` | Создать бэкап |
| GET | `/vault/backups` | Список бэкапов |
| POST | `/vault/backups/verify` | Верифицировать бэкап |
| POST | `/vault/backups/restore` | Восстановить из бэкапа |
| POST | `/vault/integrity/check` | Проверить целостность файлов |
| GET | `/vault/integrity/status` | Статус проверок целостности |

## Клавиатурные шорткаты

| Клавиша | Действие |
|---------|----------|
| F2 | Переименовать выбранный файл |
| Delete | Удалить выбранный файл |
| Escape | Закрыть панель деталей / предпросмотр |
| Backspace | Назад в навигации по папкам |

## Установка и запуск

### Требования
- Node.js 18+
- npm 9+

### Веб-приложение

```bash
npm install
npm run dev
npm run build
```

### Переменные окружения

Создайте `.env` файл:

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

## Безопасность

### Аутентификация
- Supabase Auth (email/password) с bcrypt cost=10
- Двухфакторная аутентификация (TOTP) через Supabase MFA
- Автоматический триггер создания профиля при регистрации
- Rate limiting: 5 попыток входа за 5 минут
- Управление сессиями с возможностью отзыва

### Шифрование
- SHA-256 для хеширования контента (CAS-дедупликация)
- PBKDF2 (600K итераций) для паролей общих ссылок
- Шифрование ключей файлов (encrypted_key + key_nonce)
- Криптографически стойкие токены (48 байт, crypto.getRandomValues)

### Управление доступом
- Row Level Security (RLS) на всех таблицах
- Многоуровневая проверка прав: Owner > Direct > Inherited > Denied
- Оптимистичное блокирование файлов
- Аудит всех действий
- Authenticated-политики (не anon) для всех операций
- SECURITY DEFINER хелперы для разрыва циклов рекурсии RLS
- Все FK ссылаются на auth.users (не на legacy public.users)

### Целостность данных
- SHA-256 чексуммы для бэкапов и снимков
- Проверка целостности файлов (expected vs verified hash)
- Point-in-time восстановление с верификацией

Актуальный разбор рисков и закрытых дыр: см. [SECURITY_AUDIT.md](SECURITY_AUDIT.md).

## Миграции базы данных

| # | Файл | Описание |
|---|------|----------|
| 003 | `vault_helper_functions.sql` | Индексы, триггеры, хелперы |
| 005 | `fix_users_rls.sql` | RLS для users |
| 006 | `fix_all_rls_anon.sql` | RLS для всех таблиц |
| 007 | `fix_node_closure_rls.sql` | RLS для node_closure |
| 009 | `plm_products_workflows_bom.sql` | PLM: продукты, BOM, workflow |
| 010 | `auth_security_foundation.sql` | Auth: профили, сессии, rate limits, замена anon RLS |
| 011 | `backup_integrity.sql` | Бэкапы, снимки, проверка целостности |
| 012 | `fix_rls_recursion_and_cleanup.sql` | Устранение рекурсии RLS, удаление anon-политик |
| 013 | `fix_legacy_users_fk.sql` | Перенос FK с public.users на auth.users |
| 014 | `fix_nodes_acl_recursion.sql` | SECURITY DEFINER хелперы для разрыва рекурсии nodes<->ACL |
| 015 | `enable_realtime_publication.sql` | Таблицы в publication `supabase_realtime` |
| 016 | `security_rls_tightening.sql` | Секреты `connection_config`; бэкапы; проверки целостности |

## Технологии

| Компонент | Технология |
|-----------|-----------|
| Фронтенд | TypeScript, Vite 8 |
| Десктоп | Electron 41 |
| База данных | Supabase (PostgreSQL) |
| Аутентификация | Supabase Auth + MFA |
| Edge Functions | Deno Runtime |
| Криптография | Web Crypto API |
| Хеширование | SHA-256, PBKDF2, bcrypt |
| CAS-хранилище | Поблочное, 4MB блоки |

## Working Agreement

This is the active operating contract for our collaboration.

- I work one block at a time.
- Each block must have a clear definition of done before implementation starts.
- After each block I run the relevant checks: build, tests, and desktop start when applicable.
- If a block exposes hidden dependencies, I stabilize those before moving on.
- I keep the next block short, testable, and shippable.
- Desktop entrypoints are `electron/main.cjs` and `electron/preload.cjs`.
- `npm start` launches the packaged desktop flow, `npm run dev` stays web-only, and `npm run demo` is the lightweight CLI check.

## Active Roadmap

### 1. Desktop UX

- Real Electron app startup flow
- App menu and window behavior
- Safe desktop actions from the renderer
- Better launch and loading states

### 2. File Workflow

- Upload
- Preview
- Rename
- Move
- Delete and restore
- File detail panel cleanup

### 3. PLM Block

- Product detail screen
- BOM editor
- Workflow UI
- Revision and status actions

### 4. Collaboration

- Comments and mentions
- Presence and online state
- Realtime updates where they matter

### 5. Hardening and Polish

- Permission edge cases
- Error states and empty states
- Performance pass
- Documentation cleanup

### Working Rule

The active roadmap above overrides the legacy roadmap above. If we change direction later, we update this section first and keep the rest of the work aligned to it.

---

## Legacy Roadmap

This section is kept for historical context only. Use the Active Roadmap above for current work.

### Этап 1 -- Фундамент (завершено)

- [x] CAS-хранилище с поблочной дедупликацией (4MB блоки, SHA-256)
- [x] Версионность файлов: создание, просмотр, восстановление
- [x] Иерархия файлов и папок с навигацией
- [x] RBAC + ACL модель доступа (owner/editor/viewer/auditor)
- [x] Общие ссылки с парольной защитой (PBKDF2) и TTL
- [x] Supabase Auth: регистрация, вход, сброс пароля
- [x] 2FA (TOTP) через Supabase MFA
- [x] Управление сессиями и rate limiting
- [x] Оптимистичное блокирование файлов
- [x] Разрешение конфликтов (keep_both / last_writer_wins / manual)
- [x] Аудит-лог всех действий
- [x] RLS на всех таблицах, authenticated-политики
- [x] SECURITY DEFINER хелперы для разрыва RLS-рекурсии
- [x] Edge Function API (версионность, ACL, шаринг, бэкапы, целостность)

### Этап 2 -- PLM и инфраструктура (завершено)

- [x] Продукты: CRUD, жизненный цикл, привязка документов
- [x] BOM: иерархия компонентов с количеством
- [x] Workflow: этапы согласования, экземпляры процессов
- [x] Бэкапы: полный, инкрементальный, metadata-only, blocks-only
- [x] Верификация и восстановление бэкапов с SHA-256 чексуммами
- [x] Проверка целостности файлов (expected vs verified hash)
- [x] Аналитика: дашборд с метриками, графики, аудит
- [x] Администрирование: пользователи, архивация, GC, корзина
- [x] Безопасность: 2FA, смена пароля, управление сессиями
- [x] Конфигурация сервера и подключений
- [x] Управление расширениями файлов и просмотрщиками
- [x] Совместная работа: индикатор онлайн, блокировки

### Аудит и укрепление безопасности (выполнено в текущем объёме)

- [x] Edge Function `vault`: обязательная проверка JWT (`auth.getUser`), чтения через клиент с токеном пользователя (RLS)
- [x] Клиент: вызовы Edge с `access_token` и заголовком `apikey`, без подмены `user_id` в теле запросов
- [x] Миграция `016_security_rls_tightening.sql`: сужение доступа к `connection_config`, бэкапам, снимкам и проверкам целостности
- [x] Снижение риска XSS: экранирование (`esc`) в основных шаблонах `main.ts`
- [x] Документ [SECURITY_AUDIT.md](SECURITY_AUDIT.md) с зафиксированными рисками и долгами

### Этап 3 -- Real-time и производительность (в процессе)

- [x] Real-time уведомления через Supabase Realtime (`postgres_changes` для списков + Presence для онлайна; polling убран)
- [ ] WebSocket-канал / broadcast для совместного редактирования содержимого (курсоры, совместное редактирование)
- [ ] Операции с файлами в фоне (Service Worker / Web Worker)
- [ ] Индикаторы прогресса для всех длительных операций
- [ ] Оптимистичные обновления UI повсеместно (частично: переименование и строки файлов)
- [x] Виртуальный скроллинг для больших списков файлов (подгрузка чанками при прокрутке, >50 элементов)
- [x] Ленивая загрузка дерева папок (дочерние папки по раскрытию, без полной выборки `nodes`)
- [x] Кэширование запросов на клиенте (TTL через `dedupFetch` в `src/utils/cache.ts`)

### Этап 4 -- Расширенный PLM

- [ ] Визуальный редактор BOM (древовидная диаграмма)
- [ ] Сравнение версий BOM (diff)
- [ ] Маршруты согласования: визуальный конструктор (drag-and-drop)
- [ ] Уведомления и эскалация при просрочке этапов
- [ ] Электронные подписи (ЭЦП) для утверждения документов
- [ ] Связь изменений (ECN/ECO) -- Engineering Change Notice/Order
- [ ] Отслеживание ревизий компонентов (revision control)
- [ ] Где используется (Where-Used) -- поиск по BOM-иерархии
- [ ] Импорт/экспорт BOM (CSV, Excel, XML)
- [ ] Статус-машина жизненного цикла продукта (конфигурируемая)

### Этап 5 -- Совместная работа и коммуникации

- [ ] Комментарии к файлам и версиям (потоковые)
- [ ] Упоминания (@mention) с уведомлениями
- [ ] Задачи по документам (назначение, сроки, статусы)
- [ ] Совместный просмотр файлов (co-viewing) с курсорами
- [ ] Чат в контексте документа
- [ ] Лента активности (activity feed) по проекту/продукту
- [ ] Email-уведомления о событиях (подписка на события)
- [ ] Интеграция с календарем для дедлайнов

### Этап 6 -- Интеграции

- [ ] REST API для внешних систем (полноценный CRUD)
- [ ] Webhook-уведомления на внешние URL
- [ ] Интеграция с CAD-системами (SolidWorks, AutoCAD -- импорт метаданных)
- [ ] Интеграция с ERP (SAP, 1C -- синхронизация BOM)
- [ ] SSO: SAML 2.0 / OpenID Connect
- [ ] LDAP/Active Directory синхронизация пользователей
- [ ] API-ключи для автоматизации (CI/CD)
- [ ] Экспорт в PDF с водяными знаками

### Этап 7 -- Мобильность и доступность

- [ ] PWA: офлайн-доступ, синхронизация при подключении
- [ ] Адаптивный дизайн для планшетов
- [ ] Нативное мобильное приложение (React Native / Capacitor)
- [ ] Сканер QR-кодов для быстрого доступа к документам
- [ ] Push-уведомления (Firebase Cloud Messaging)
- [ ] Поддержка клавиатурной навигации (WCAG 2.1 AA)
- [ ] Скринридер-совместимость (ARIA)
- [ ] Высококонтрастная тема

### Этап 8 -- Масштабирование и DevOps

- [ ] Мультитенантность (организации, пространства)
- [ ] Квоты на хранилище по организации
- [ ] Репликация данных между регионами
- [ ] CDN для раздачи блоков (Edge caching)
- [ ] Горизонтальное масштабирование Edge Functions
- [ ] Мониторинг: Prometheus метрики, Grafana дашборды
- [ ] Alerting: автоматические уведомления при сбоях
- [ ] CI/CD пайплайн (тесты, миграции, деплой)
- [ ] Blue-green деплой для zero-downtime обновлений
- [ ] Автоматические тесты: unit, integration, E2E

### Этап 9 -- Аналитика и AI

- [ ] Полнотекстовый поиск (PostgreSQL tsvector + tsquery)
- [ ] Поиск по содержимому файлов (OCR для сканов)
- [ ] Автоматическая классификация документов (ML)
- [ ] Извлечение метаданных из CAD-файлов
- [ ] Предиктивная аналитика: прогноз использования хранилища
- [ ] Рекомендации по связанным документам
- [ ] Автоматическое тегирование файлов
- [ ] Дубликат-детектор (по содержимому, не только по хешу)

---

## Лицензия

ISC
