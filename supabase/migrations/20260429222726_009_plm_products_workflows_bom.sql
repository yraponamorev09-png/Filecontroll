/*
  # Add PLM-specific tables and server connection config

  1. New Tables
    - `products`: Product lifecycle management core entity
      - id (uuid, PK)
      - name (text) - product name
      - code (text, unique) - product code/SKU
      - description (text)
      - lifecycle_stage (text) - concept/design/engineering/production/eol
      - owner_id (uuid, FK -> users.id)
      - parent_product_id (uuid, nullable) - for product variants/assemblies
      - status (text) - draft/active/obsolete/archived
      - metadata (jsonb) - flexible product attributes
      - created_at, updated_at (timestamptz)
    - `product_documents`: Links documents to products
      - id (uuid, PK)
      - product_id (uuid, FK -> products.id)
      - node_id (uuid, FK -> nodes.id)
      - document_type (text) - specification/drawing/report/certificate/manual
      - lifecycle_phase (text) - which phase this doc belongs to
      - is_latest (boolean)
      - created_by (uuid, FK -> users.id)
      - created_at (timestamptz)
    - `bom_items`: Bill of Materials
      - id (uuid, PK)
      - parent_product_id (uuid, FK -> products.id)
      - child_product_id (uuid, FK -> products.id)
      - quantity (integer)
      - unit (text) - pcs/kg/m/etc
      - reference (text) - BOM reference designator
      - created_at (timestamptz)
    - `workflow_stages`: Workflow definitions
      - id (uuid, PK)
      - name (text)
      - stage_type (text) - review/approval/testing/release
      - order_index (integer)
      - required_role (text)
      - created_at (timestamptz)
    - `workflow_instances`: Active workflow instances on products
      - id (uuid, PK)
      - product_id (uuid, FK -> products.id)
      - stage_id (uuid, FK -> workflow_stages.id)
      - assigned_to (uuid, FK -> users.id)
      - status (text) - pending/in_progress/completed/rejected
      - started_at (timestamptz)
      - completed_at (timestamptz)
      - comment (text)
    - `connection_config`: Database/server connection settings (replaces .env)
      - id (uuid, PK)
      - key (text, unique)
      - value (text)
      - is_encrypted (boolean, default false)
      - updated_by (uuid, FK -> users.id)
      - updated_at (timestamptz)

  2. Security
    - Enable RLS on all new tables
    - Anon access policies for app functionality
*/

-- Products table
CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  code text UNIQUE NOT NULL,
  description text DEFAULT '',
  lifecycle_stage text NOT NULL DEFAULT 'concept',
  owner_id uuid NOT NULL REFERENCES users(id),
  parent_product_id uuid REFERENCES products(id),
  status text NOT NULL DEFAULT 'draft',
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE products ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anon can read products" ON products FOR SELECT TO anon USING (true);
CREATE POLICY "Anon can insert products" ON products FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Anon can update products" ON products FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Anon can delete products" ON products FOR DELETE TO anon USING (true);

-- Product documents
CREATE TABLE IF NOT EXISTS product_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  node_id uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  document_type text NOT NULL DEFAULT 'specification',
  lifecycle_phase text DEFAULT '',
  is_latest boolean DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz DEFAULT now()
);

ALTER TABLE product_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anon can read product_documents" ON product_documents FOR SELECT TO anon USING (true);
CREATE POLICY "Anon can insert product_documents" ON product_documents FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Anon can update product_documents" ON product_documents FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Anon can delete product_documents" ON product_documents FOR DELETE TO anon USING (true);

-- BOM items
CREATE TABLE IF NOT EXISTS bom_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  child_product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity integer NOT NULL DEFAULT 1,
  unit text NOT NULL DEFAULT 'pcs',
  reference text DEFAULT '',
  created_at timestamptz DEFAULT now()
);

ALTER TABLE bom_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anon can read bom_items" ON bom_items FOR SELECT TO anon USING (true);
CREATE POLICY "Anon can insert bom_items" ON bom_items FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Anon can update bom_items" ON bom_items FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Anon can delete bom_items" ON bom_items FOR DELETE TO anon USING (true);

-- Workflow stages
CREATE TABLE IF NOT EXISTS workflow_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  stage_type text NOT NULL DEFAULT 'review',
  order_index integer NOT NULL DEFAULT 0,
  required_role text DEFAULT '',
  created_at timestamptz DEFAULT now()
);

ALTER TABLE workflow_stages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anon can read workflow_stages" ON workflow_stages FOR SELECT TO anon USING (true);
CREATE POLICY "Anon can insert workflow_stages" ON workflow_stages FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Anon can update workflow_stages" ON workflow_stages FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Anon can delete workflow_stages" ON workflow_stages FOR DELETE TO anon USING (true);

-- Workflow instances
CREATE TABLE IF NOT EXISTS workflow_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  stage_id uuid NOT NULL REFERENCES workflow_stages(id),
  assigned_to uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending',
  started_at timestamptz DEFAULT now(),
  completed_at timestamptz,
  comment text DEFAULT ''
);

ALTER TABLE workflow_instances ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anon can read workflow_instances" ON workflow_instances FOR SELECT TO anon USING (true);
CREATE POLICY "Anon can insert workflow_instances" ON workflow_instances FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Anon can update workflow_instances" ON workflow_instances FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Anon can delete workflow_instances" ON workflow_instances FOR DELETE TO anon USING (true);

-- Connection config (replaces .env for Supabase credentials)
CREATE TABLE IF NOT EXISTS connection_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text UNIQUE NOT NULL,
  value text NOT NULL DEFAULT '',
  is_encrypted boolean DEFAULT false,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE connection_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anon can read connection_config" ON connection_config FOR SELECT TO anon USING (true);
CREATE POLICY "Anon can insert connection_config" ON connection_config FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Anon can update connection_config" ON connection_config FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Anon can delete connection_config" ON connection_config FOR DELETE TO anon USING (true);

-- Seed default workflow stages
INSERT INTO workflow_stages (name, stage_type, order_index, required_role) VALUES
  ('Проектирование', 'review', 1, 'editor'),
  ('Инженерная проверка', 'review', 2, 'owner'),
  ('Утверждение', 'approval', 3, 'owner'),
  ('Тестирование', 'testing', 4, 'editor'),
  ('Выпуск', 'release', 5, 'owner')
ON CONFLICT DO NOTHING;

-- Seed default connection config
INSERT INTO connection_config (key, value, is_encrypted) VALUES
  ('supabase_url', '', false),
  ('supabase_anon_key', '', true),
  ('supabase_service_role_key', '', true),
  ('app_name', 'Vault PLM', false),
  ('app_version', '1.0.0', false),
  ('session_timeout_minutes', '480', false),
  ('max_login_attempts', '5', false),
  ('encryption_at_rest', 'true', false),
  ('audit_retention_days', '365', false)
ON CONFLICT (key) DO NOTHING;

-- Seed demo products
DO $$
DECLARE
  uid uuid;
BEGIN
  SELECT id INTO uid FROM users LIMIT 1;
  IF uid IS NOT NULL THEN
    INSERT INTO products (name, code, description, lifecycle_stage, owner_id, status, metadata) VALUES
      ('Изделие А-100', 'A-100', 'Основное изделие линейки Alpha', 'production', uid, 'active', '{"category": "Механические", "weight_kg": 45.2}'),
      ('Изделие А-200', 'A-200', 'Модификация с усиленным корпусом', 'engineering', uid, 'active', '{"category": "Механические", "weight_kg": 52.1}'),
      ('Изделие Б-010', 'B-010', 'Электронный контроллер', 'design', uid, 'draft', '{"category": "Электроника", "voltage": "24V"}'),
      ('Изделие В-001', 'V-001', 'Концепт нового поколения', 'concept', uid, 'draft', '{"category": "Инновации", "status": "research"}'),
      ('Комплект К-50', 'K-50', 'Комплект монтажных элементов', 'production', uid, 'active', '{"category": "Комплектующие", "items": 12}')
    ON CONFLICT (code) DO NOTHING;
  END IF;
END $$;
