-- =============================================================================
-- Bete Metsahaf - MySQL / MariaDB schema (structure only, no data)
-- Run with:  npm run setup-db        (creates the database named in DB_NAME, then this file)
-- =============================================================================

CREATE TABLE IF NOT EXISTS admins (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(120) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS librarians (
  id INT AUTO_INCREMENT PRIMARY KEY,
  staff_no VARCHAR(30) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(120) NOT NULL UNIQUE,
  phone VARCHAR(30) NULL,
  password_hash VARCHAR(255) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL UNIQUE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS books (
  id INT AUTO_INCREMENT PRIMARY KEY,
  isbn VARCHAR(20) NOT NULL UNIQUE,
  title VARCHAR(200) NOT NULL,
  author VARCHAR(150) NOT NULL,
  publisher VARCHAR(120) NULL,
  pub_year SMALLINT NULL,
  category_id INT NULL,
  shelf VARCHAR(30) NULL,
  total_copies INT NOT NULL DEFAULT 1,
  available_copies INT NOT NULL DEFAULT 1,
  description TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
  CHECK (available_copies >= 0 AND available_copies <= total_copies),
  INDEX idx_books_title (title),
  INDEX idx_books_author (author),
  INDEX idx_books_shelf (shelf)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Attendance history is protected: a librarian with attendance rows cannot be deleted
-- (deactivate the account instead).
CREATE TABLE IF NOT EXISTS attendance (
  id INT AUTO_INCREMENT PRIMARY KEY,
  librarian_id INT NOT NULL,
  work_date DATE NOT NULL,
  check_in DATETIME NULL,   -- stored in UTC
  check_out DATETIME NULL,  -- stored in UTC
  hours DECIMAL(5,2) NULL,
  status ENUM('Present','Late','Half-day','Absent') NOT NULL DEFAULT 'Present',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_librarian_work_date (librarian_id, work_date),
  INDEX idx_attendance_date (work_date),
  FOREIGN KEY (librarian_id) REFERENCES librarians(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS attendance_audit (
  id INT AUTO_INCREMENT PRIMARY KEY,
  attendance_id INT NOT NULL,
  admin_id INT NOT NULL,
  old_values JSON NULL,
  new_values JSON NULL,
  reason VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (attendance_id) REFERENCES attendance(id) ON DELETE CASCADE,
  FOREIGN KEY (admin_id) REFERENCES admins(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS borrowings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  book_id INT NOT NULL,
  librarian_id INT NULL,
  admin_id INT NULL,
  borrower_name VARCHAR(120) NOT NULL,
  borrower_ref VARCHAR(60) NULL,
  borrowed_at DATETIME DEFAULT CURRENT_TIMESTAMP,  -- UTC
  due_date DATE NOT NULL,
  renewal_count INT NOT NULL DEFAULT 0,
  fine_carried DECIMAL(8,2) NOT NULL DEFAULT 0.00,  -- fines already accrued before renewals
  status ENUM('borrowed','returned') NOT NULL DEFAULT 'borrowed',
  FOREIGN KEY (book_id) REFERENCES books(id),
  FOREIGN KEY (librarian_id) REFERENCES librarians(id),
  FOREIGN KEY (admin_id) REFERENCES admins(id),
  INDEX idx_borrowing_status_due (status, due_date),
  INDEX idx_borrowing_book (book_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS returns (
  id INT AUTO_INCREMENT PRIMARY KEY,
  borrowing_id INT NOT NULL UNIQUE,
  librarian_id INT NULL,
  admin_id INT NULL,
  returned_at DATETIME DEFAULT CURRENT_TIMESTAMP,  -- UTC
  fine DECIMAL(8,2) NOT NULL DEFAULT 0.00,
  FOREIGN KEY (borrowing_id) REFERENCES borrowings(id) ON DELETE CASCADE,
  FOREIGN KEY (librarian_id) REFERENCES librarians(id),
  FOREIGN KEY (admin_id) REFERENCES admins(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS activity_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  actor_role VARCHAR(20) NOT NULL,
  actor_id INT NOT NULL,
  action VARCHAR(60) NOT NULL,
  details VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Only holds values an administrator has changed; defaults live in server.js.
CREATE TABLE IF NOT EXISTS system_settings (
  key_name VARCHAR(50) PRIMARY KEY,
  value VARCHAR(100) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
