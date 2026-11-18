-- =============================================================================
-- Bete Metsahaf - PostgreSQL / Supabase schema (structure only, no data)
-- Run with:  npm run setup-db     (or paste into Supabase: SQL Editor -> New query -> Run)
-- Safe to run more than once.
-- =============================================================================

CREATE TABLE IF NOT EXISTS admins (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(120) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS librarians (
  id SERIAL PRIMARY KEY,
  staff_no VARCHAR(30) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(120) NOT NULL UNIQUE,
  phone VARCHAR(30) NULL,
  password_hash VARCHAR(255) NOT NULL,
  active SMALLINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  name VARCHAR(80) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS books (
  id SERIAL PRIMARY KEY,
  isbn VARCHAR(20) NOT NULL UNIQUE,
  title VARCHAR(200) NOT NULL,
  author VARCHAR(150) NOT NULL,
  publisher VARCHAR(120) NULL,
  pub_year SMALLINT NULL,
  category_id INT NULL REFERENCES categories(id) ON DELETE SET NULL,
  shelf VARCHAR(30) NULL,
  total_copies INT NOT NULL DEFAULT 1,
  available_copies INT NOT NULL DEFAULT 1,
  description TEXT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  CHECK (available_copies >= 0 AND available_copies <= total_copies)
);
CREATE INDEX IF NOT EXISTS idx_books_title ON books(title);
CREATE INDEX IF NOT EXISTS idx_books_author ON books(author);
CREATE INDEX IF NOT EXISTS idx_books_shelf ON books(shelf);

-- Attendance history is protected: a librarian with attendance rows cannot be deleted
-- (deactivate the account instead).
CREATE TABLE IF NOT EXISTS attendance (
  id SERIAL PRIMARY KEY,
  librarian_id INT NOT NULL REFERENCES librarians(id) ON DELETE RESTRICT,
  work_date DATE NOT NULL,
  check_in TIMESTAMPTZ NULL,
  check_out TIMESTAMPTZ NULL,
  hours NUMERIC(5,2) NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'Present' CHECK (status IN ('Present','Late','Half-day','Absent')),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_librarian_work_date UNIQUE (librarian_id, work_date)
);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(work_date);

CREATE TABLE IF NOT EXISTS attendance_audit (
  id SERIAL PRIMARY KEY,
  attendance_id INT NOT NULL REFERENCES attendance(id) ON DELETE CASCADE,
  admin_id INT NOT NULL REFERENCES admins(id),
  old_values JSONB NULL,
  new_values JSONB NULL,
  reason VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS borrowings (
  id SERIAL PRIMARY KEY,
  book_id INT NOT NULL REFERENCES books(id),
  librarian_id INT NULL REFERENCES librarians(id),
  admin_id INT NULL REFERENCES admins(id),
  borrower_name VARCHAR(120) NOT NULL,
  borrower_ref VARCHAR(60) NULL,
  borrowed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  due_date DATE NOT NULL,
  renewal_count INT NOT NULL DEFAULT 0,
  fine_carried NUMERIC(8,2) NOT NULL DEFAULT 0.00,  -- fines already accrued before renewals
  status VARCHAR(20) NOT NULL DEFAULT 'borrowed' CHECK (status IN ('borrowed','returned'))
);
CREATE INDEX IF NOT EXISTS idx_borrowing_status_due ON borrowings(status, due_date);
CREATE INDEX IF NOT EXISTS idx_borrowing_book ON borrowings(book_id);

CREATE TABLE IF NOT EXISTS returns (
  id SERIAL PRIMARY KEY,
  borrowing_id INT NOT NULL UNIQUE REFERENCES borrowings(id) ON DELETE CASCADE,
  librarian_id INT NULL REFERENCES librarians(id),
  admin_id INT NULL REFERENCES admins(id),
  returned_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  fine NUMERIC(8,2) NOT NULL DEFAULT 0.00
);

CREATE TABLE IF NOT EXISTS activity_logs (
  id SERIAL PRIMARY KEY,
  actor_role VARCHAR(20) NOT NULL,
  actor_id INT NOT NULL,
  action VARCHAR(60) NOT NULL,
  details VARCHAR(255) NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Only holds values an administrator has changed; defaults live in server.js.
CREATE TABLE IF NOT EXISTS system_settings (
  key_name VARCHAR(50) PRIMARY KEY,
  value VARCHAR(100) NOT NULL
);

-- -----------------------------------------------------------------------------
-- Lock the tables away from Supabase's public Data API (anon / authenticated keys).
-- Bete Metsahaf talks to the database directly with the `postgres` role, which
-- bypasses row-level security, so enabling RLS with no policies costs nothing
-- and prevents anyone reading e.g. password hashes through the REST endpoint.
-- -----------------------------------------------------------------------------
ALTER TABLE admins           ENABLE ROW LEVEL SECURITY;
ALTER TABLE librarians       ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories       ENABLE ROW LEVEL SECURITY;
ALTER TABLE books            ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance       ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE borrowings       ENABLE ROW LEVEL SECURITY;
ALTER TABLE returns          ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_logs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_settings  ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
  END IF;
END $$;
