# Vault PLM

Система управления документами и продуктами корпоративного уровня с шифрованием, версионностью, совместной работой, PLM-функционалом и аутентификацией.

## Архитектура

Vault PLM построен на основе Content-Addressable Storage (CAS) с поблочной дедупликацией, RBAC+ACL моделью доступа, оптимистичным блокированием, криптографическим обменом ссылками и Supabase Auth для аутентификации.

```
┌─────────────────────────────────────────────────────────┐
│                    Клиентские приложения                 │
│  ┌──────────────────┐    ┌──────────────────────────┐  │
│  │   Веб-интерфейс   │    │   Electron (десктоп)      │  │
│  │   (Vite + TS)     │    │   (main.js + preload.js)  │  │
│  └────────┬─────────┘    └────────────┬───────────────┘  │
│           └──────────┬────────────────┘                  │
│                      │                                   │
│           ┌──────────▼──────────┐                        │
│           │   src/core/         │                        │
│           │   versioning.ts     │  Версионность          │
│           │   access.ts        │  Управление доступом   │
│           │   sharing.ts       │  Общие ссылки          │
│           │   archival.ts      │  Архивация             │
│           │   conflict.ts      │  Разрешение конфликтов │
│           └──────────┬──────────┘                        │
│                      │                                   │
│           ┌──────────▼──────────┐                        │
│           │   src/utils/        │                        │
│           │   crypto.ts         │  SHA-256, PBKDF2      │
│           │   db.ts             │  Supabase клиент       │
│           └──────────┬──────────┘                        │
│                      │                                   │
│           ┌──────────▼──────────┐                        │
│           │   src/web/auth.ts    │                        │
│           │   AuthService        │  Supabase Auth + 2FA  │
│           └──────────┬──────────┘                        │
│                      │                                   │
└──────────────────────┼───────────────────────────────────┘
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
│   │   ├── sharing.ts      # createShareLink, validateShareLink, revokeShareLink
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
│       ├── 010_auth_security_foundation.sql     # Auth: профили, сессии, rate limits, RLS
│       ├── 011_backup_integrity.sql             # Бэкапы, снимки, проверка целостности
│       ├── 012_fix_rls_recursion_and_cleanup.sql # Устранение рекурсии RLS, удаление anon-политик
│       ├── 013_fix_legacy_users_fk.sql          # Перенос FK с public.users на auth.users
│       └── 014_fix_nodes_acl_recursion.sql     # SECURITY DEFINER хелперы для разрыва рекурсии
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

## Тестовые аккаунты

| Email | Пароль | Роль |
|-------|--------|------|
| admin@vault-plm.local | changeme | owner |
| owner2@vault-plm.local | Owner2123! | owner |
| engineer@vault-plm.local | Engineer123! | editor |
| auditor@vault-plm.local | Auditor123! | auditor |
| viewer@vault-plm.local | Viewer123! | viewer |

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
# Установка зависимостей
npm install

# Разработка
npm run dev

# Сборка
npm run build
```

### Десктопное приложение (Electron)

```bash
# Разработка
npm run electron:dev

# Запуск
npm run electron:start

# Сборка дистрибутива
npm run electron:build
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

## Лицензия

ISC
