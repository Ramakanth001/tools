-- pg_data_load.sql
-- Purpose: create and load a reasonably sized PostgreSQL target dataset for practice.
--
-- Run after connecting to the PostgreSQL database:
--   psql -h 127.0.0.1 -p 5432 -U shop_pg_user -d shop_pg -f pg_data_load.sql
--
-- This file is useful if you want PostgreSQL to already contain tables and data.
-- For MySQL -> PostgreSQL migration practice, many people keep PostgreSQL mostly empty,
-- but this script helps you test introspection, comparisons, and dry runs.

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT UNIQUE,
  phone TEXT,
  city TEXT,
  state_code TEXT,
  loyalty_tier TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  product_name TEXT NOT NULL,
  category TEXT NOT NULL,
  price NUMERIC(10,2) NOT NULL,
  stock_qty INTEGER NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  order_number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  total_amount NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL,
  unit_price NUMERIC(10,2) NOT NULL,
  line_total NUMERIC(12,2) NOT NULL
);

INSERT INTO customers (id, full_name, email, phone, city, state_code, loyalty_tier, created_at)
SELECT
  gs,
  'Customer ' || gs,
  'customer' || gs || '@example.com',
  '+91-90000' || LPAD(gs::text, 5, '0'),
  CASE (gs % 8)
    WHEN 0 THEN 'Hyderabad'
    WHEN 1 THEN 'Bengaluru'
    WHEN 2 THEN 'Chennai'
    WHEN 3 THEN 'Pune'
    WHEN 4 THEN 'Mumbai'
    WHEN 5 THEN 'Delhi'
    WHEN 6 THEN 'Kolkata'
    ELSE 'Ahmedabad'
  END,
  CASE (gs % 8)
    WHEN 0 THEN 'TS'
    WHEN 1 THEN 'KA'
    WHEN 2 THEN 'TN'
    WHEN 3 THEN 'MH'
    WHEN 4 THEN 'MH'
    WHEN 5 THEN 'DL'
    WHEN 6 THEN 'WB'
    ELSE 'GJ'
  END,
  CASE
    WHEN gs % 20 = 0 THEN 'platinum'
    WHEN gs % 10 = 0 THEN 'gold'
    WHEN gs % 5 = 0 THEN 'silver'
    ELSE 'standard'
  END,
  NOW() - ((gs % 365) || ' days')::interval
FROM generate_series(1, 500) AS gs
ON CONFLICT (id) DO NOTHING;

INSERT INTO products (id, sku, product_name, category, price, stock_qty, created_at)
SELECT
  gs,
  'SKU-' || LPAD(gs::text, 5, '0'),
  'Product ' || gs,
  CASE (gs % 6)
    WHEN 0 THEN 'books'
    WHEN 1 THEN 'electronics'
    WHEN 2 THEN 'fashion'
    WHEN 3 THEN 'groceries'
    WHEN 4 THEN 'furniture'
    ELSE 'sports'
  END,
  ROUND((10 + (gs * 1.73))::numeric, 2),
  20 + (gs % 180),
  NOW() - ((gs % 180) || ' days')::interval
FROM generate_series(1, 120) AS gs
ON CONFLICT (id) DO NOTHING;

INSERT INTO orders (id, customer_id, order_number, status, total_amount, created_at)
SELECT
  gs,
  ((gs - 1) % 500) + 1,
  'ORD-PG-' || LPAD(gs::text, 6, '0'),
  CASE (gs % 5)
    WHEN 0 THEN 'pending'
    WHEN 1 THEN 'paid'
    WHEN 2 THEN 'packed'
    WHEN 3 THEN 'shipped'
    ELSE 'delivered'
  END,
  ROUND((50 + (gs * 3.21))::numeric, 2),
  NOW() - ((gs % 120) || ' days')::interval
FROM generate_series(1, 1500) AS gs
ON CONFLICT (id) DO NOTHING;

INSERT INTO order_items (id, order_id, product_id, quantity, unit_price, line_total)
SELECT
  gs,
  ((gs - 1) % 1500) + 1,
  ((gs - 1) % 120) + 1,
  1 + (gs % 5),
  ROUND((15 + (((gs - 1) % 120) * 2.15))::numeric, 2),
  ROUND(((1 + (gs % 5)) * (15 + (((gs - 1) % 120) * 2.15)))::numeric, 2)
FROM generate_series(1, 4500) AS gs
ON CONFLICT (id) DO NOTHING;

-- Quick checks:
-- SELECT COUNT(*) FROM customers;
-- SELECT COUNT(*) FROM products;
-- SELECT COUNT(*) FROM orders;
-- SELECT COUNT(*) FROM order_items;
