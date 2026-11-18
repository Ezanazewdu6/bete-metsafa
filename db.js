/**
 * Bete Metsahaf - Unified Database Layer
 *
 * Connects to Supabase / PostgreSQL when DATABASE_URL (or SUPABASE_DB_URL) is set,
 * otherwise to a local MySQL / MariaDB server (e.g. XAMPP).
 *
 * Both engines expose the same interface:
 *   db.query(sql, params)  -> [rows, fields]   (use '?' placeholders)
 *   db.getConnection()     -> connection with beginTransaction/commit/rollback/release/query
 *   db.like                -> 'ILIKE' (Postgres) or 'LIKE' (MySQL, case-insensitive by collation)
 *   db.isDuplicateError(e) / db.isForeignKeyError(e)
 *
 * Timestamps are always stored in UTC. The application converts to the library's
 * timezone (APP_TIMEZONE) when it needs to reason about "today" or display times.
 */

require('dotenv').config();

const fs = require('fs');

const connectionString = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || '';
const isPostgres = Boolean(connectionString);

// Error-code helpers that work for both engines
const isDuplicateError = (err) => Boolean(err) && (err.code === 'ER_DUP_ENTRY' || err.code === '23505');
const isForeignKeyError = (err) =>
  Boolean(err) &&
  (err.code === 'ER_ROW_IS_REFERENCED_2' ||
    err.code === 'ER_ROW_IS_REFERENCED' ||
    err.code === 'ER_NO_REFERENCED_ROW_2' ||
    err.code === '23503');

let db;

if (isPostgres) {
  const { Pool, types } = require('pg');

  // DATE -> 'YYYY-MM-DD' string (no timezone shifting); BIGINT/NUMERIC -> JS numbers
  types.setTypeParser(1082, (s) => s);
  types.setTypeParser(20, (s) => parseInt(s, 10));
  types.setTypeParser(1700, (s) => parseFloat(s));

  // TLS: DB_SSL = require (default, encrypted but certificate not verified)
  //              | verify  (encrypted + verified; needs DB_SSL_CA_PATH)
  //              | disable (local Postgres without TLS)
  const sslMode = (process.env.DB_SSL || 'require').toLowerCase();
  let ssl;
  if (sslMode === 'disable') {
    ssl = false;
  } else if (sslMode === 'verify') {
    if (!process.env.DB_SSL_CA_PATH) {
      throw new Error('DB_SSL=verify requires DB_SSL_CA_PATH (path to your database CA certificate).');
    }
    ssl = { ca: fs.readFileSync(process.env.DB_SSL_CA_PATH, 'utf8'), rejectUnauthorized: true };
  } else {
    ssl = { rejectUnauthorized: false };
  }

  // Remove any sslmode=... from the URL so our explicit ssl setting always wins
  let cleanUrl = connectionString;
  try {
    const u = new URL(connectionString);
    u.searchParams.delete('sslmode');
    cleanUrl = u.toString();
  } catch (_) {
    /* keep original string */
  }

  const pool = new Pool({
    connectionString: cleanUrl,
    ssl,
    max: Number(process.env.DB_POOL_MAX || 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });

  // Idle clients can be dropped by the Supabase pooler; without this handler Node would crash.
  pool.on('error', (err) => console.error('[pg pool] idle client error:', err.message));

  // '?' -> $1, $2 ... and add RETURNING id to plain INSERTs so insertId works
  const prepareSql = (sql) => {
    let i = 1;
    let out = sql.replace(/\?/g, () => `$${i++}`);
    if (/^\s*INSERT\s+INTO/i.test(out) && !/RETURNING/i.test(out) && !/system_settings/i.test(out)) {
      out += ' RETURNING id';
    }
    return out;
  };

  const formatResult = (res) => {
    const rows = res.rows || [];
    rows.insertId = res.command === 'INSERT' && rows[0] ? rows[0].id : 0;
    rows.affectedRows = typeof res.rowCount === 'number' ? res.rowCount : 0;
    return [rows, res.fields];
  };

  db = {
    isPostgres: true,
    engine: 'PostgreSQL / Supabase',
    sslMode,
    like: 'ILIKE',

    async query(sql, params = []) {
      return formatResult(await pool.query(prepareSql(sql), params));
    },

    async getConnection() {
      const client = await pool.connect();
      return {
        beginTransaction: () => client.query('BEGIN'),
        async query(sql, params = []) {
          return formatResult(await client.query(prepareSql(sql), params));
        },
        commit: () => client.query('COMMIT'),
        rollback: () => client.query('ROLLBACK'),
        release: () => client.release()
      };
    },

    end: () => pool.end(),

    // Used by setup-db.js to run the multi-statement schema script
    pgOptions: { connectionString: cleanUrl, ssl }
  };
} else {
  const mysql = require('mysql2/promise');

  const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'university_library',
    charset: 'utf8mb4',
    dateStrings: true, // DATE / DATETIME come back as strings
    decimalNumbers: true, // DECIMAL / SUM() come back as numbers
    timezone: 'Z', // JS Dates are written as UTC
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  });

  // Keep every connection in UTC so CURRENT_TIMESTAMP defaults match what the app writes
  pool.pool.on('connection', (conn) => conn.query("SET time_zone = '+00:00'"));

  db = {
    isPostgres: false,
    engine: 'MySQL / MariaDB',
    like: 'LIKE',
    query: (sql, params = []) => pool.query(sql, params),
    getConnection: () => pool.getConnection(),
    end: () => pool.end()
  };
}

db.isDuplicateError = isDuplicateError;
db.isForeignKeyError = isForeignKeyError;

module.exports = db;
