-- mysql_data_load.sql
-- Purpose: create and load a reasonably sized MySQL source dataset for practice.
--
-- Run after connecting to the MySQL database:
--   mysql -h 127.0.0.1 -P 3306 -u shop_user -p shop_mysql < mysql_data_load.sql
--
-- This file creates source tables with slightly different column names than PostgreSQL,
-- which is useful for mock migration practice.

CREATE TABLE IF NOT EXISTS customers (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE,
  phone VARCHAR(40),
  city VARCHAR(100),
  state_code VARCHAR(10),
  loyalty_tier VARCHAR(30),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
  id INT PRIMARY KEY AUTO_INCREMENT,
  sku VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  category VARCHAR(100) NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  stock_qty INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
  id INT PRIMARY KEY AUTO_INCREMENT,
  customer_id INT NOT NULL,
  order_number VARCHAR(50) NOT NULL UNIQUE,
  status VARCHAR(30) NOT NULL,
  total_amount DECIMAL(12,2) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE TABLE IF NOT EXISTS order_items (
  id INT PRIMARY KEY AUTO_INCREMENT,
  order_id INT NOT NULL,
  product_id INT NOT NULL,
  quantity INT NOT NULL,
  unit_price DECIMAL(10,2) NOT NULL,
  line_total DECIMAL(12,2) NOT NULL,
  CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES orders(id),
  CONSTRAINT fk_order_items_product FOREIGN KEY (product_id) REFERENCES products(id)
);

INSERT INTO customers (id, name, email, phone, city, state_code, loyalty_tier, created_at)
WITH RECURSIVE seq AS (
  SELECT 1 AS n
  UNION ALL
  SELECT n + 1 FROM seq WHERE n < 500
)
SELECT
  n,
  CONCAT('Customer ', n),
  CONCAT('customer', n, '@example.com'),
  CONCAT('+91-90000', LPAD(n, 5, '0')),
  CASE (n % 8)
    WHEN 0 THEN 'Hyderabad'
    WHEN 1 THEN 'Bengaluru'
    WHEN 2 THEN 'Chennai'
    WHEN 3 THEN 'Pune'
    WHEN 4 THEN 'Mumbai'
    WHEN 5 THEN 'Delhi'
    WHEN 6 THEN 'Kolkata'
    ELSE 'Ahmedabad'
  END,
  CASE (n % 8)
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
    WHEN n % 20 = 0 THEN 'platinum'
    WHEN n % 10 = 0 THEN 'gold'
    WHEN n % 5 = 0 THEN 'silver'
    ELSE 'standard'
  END,
  DATE_SUB(NOW(), INTERVAL (n % 365) DAY)
FROM seq
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  email = VALUES(email),
  phone = VALUES(phone),
  city = VALUES(city),
  state_code = VALUES(state_code),
  loyalty_tier = VALUES(loyalty_tier),
  created_at = VALUES(created_at);

INSERT INTO products (id, sku, name, category, price, stock_qty, created_at)
WITH RECURSIVE seq AS (
  SELECT 1 AS n
  UNION ALL
  SELECT n + 1 FROM seq WHERE n < 120
)
SELECT
  n,
  CONCAT('SKU-', LPAD(n, 5, '0')),
  CONCAT('Product ', n),
  CASE (n % 6)
    WHEN 0 THEN 'books'
    WHEN 1 THEN 'electronics'
    WHEN 2 THEN 'fashion'
    WHEN 3 THEN 'groceries'
    WHEN 4 THEN 'furniture'
    ELSE 'sports'
  END,
  ROUND(10 + (n * 1.73), 2),
  20 + (n % 180),
  DATE_SUB(NOW(), INTERVAL (n % 180) DAY)
FROM seq
ON DUPLICATE KEY UPDATE
  sku = VALUES(sku),
  name = VALUES(name),
  category = VALUES(category),
  price = VALUES(price),
  stock_qty = VALUES(stock_qty),
  created_at = VALUES(created_at);

INSERT INTO orders (id, customer_id, order_number, status, total_amount, created_at)
WITH RECURSIVE seq AS (
  SELECT 1 AS n
  UNION ALL
  SELECT n + 1 FROM seq WHERE n < 1500
)
SELECT
  n,
  ((n - 1) % 500) + 1,
  CONCAT('ORD-MY-', LPAD(n, 6, '0')),
  CASE (n % 5)
    WHEN 0 THEN 'pending'
    WHEN 1 THEN 'paid'
    WHEN 2 THEN 'packed'
    WHEN 3 THEN 'shipped'
    ELSE 'delivered'
  END,
  ROUND(50 + (n * 3.21), 2),
  DATE_SUB(NOW(), INTERVAL (n % 120) DAY)
FROM seq
ON DUPLICATE KEY UPDATE
  customer_id = VALUES(customer_id),
  order_number = VALUES(order_number),
  status = VALUES(status),
  total_amount = VALUES(total_amount),
  created_at = VALUES(created_at);

INSERT INTO order_items (id, order_id, product_id, quantity, unit_price, line_total)
WITH RECURSIVE seq AS (
  SELECT 1 AS n
  UNION ALL
  SELECT n + 1 FROM seq WHERE n < 4500
)
SELECT
  n,
  ((n - 1) % 1500) + 1,
  ((n - 1) % 120) + 1,
  1 + (n % 5),
  ROUND(15 + (((n - 1) % 120) * 2.15), 2),
  ROUND((1 + (n % 5)) * (15 + (((n - 1) % 120) * 2.15)), 2)
FROM seq
ON DUPLICATE KEY UPDATE
  order_id = VALUES(order_id),
  product_id = VALUES(product_id),
  quantity = VALUES(quantity),
  unit_price = VALUES(unit_price),
  line_total = VALUES(line_total);

-- Quick checks:
-- SELECT COUNT(*) FROM customers;
-- SELECT COUNT(*) FROM products;
-- SELECT COUNT(*) FROM orders;
-- SELECT COUNT(*) FROM order_items;
