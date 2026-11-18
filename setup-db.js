/**
 * Database setup: creates the tables (structure only, no data).
 *  - If DATABASE_URL is set  -> runs supabase_schema.sql on PostgreSQL / Supabase
 *  - otherwise               -> creates DB_NAME on MySQL / MariaDB and runs schema.sql
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const read = (file) => {
  const p = path.join(__dirname, file);
  if (!fs.existsSync(p)) throw new Error(`${file} not found at ${p}`);
  return fs.readFileSync(p, 'utf8');
};

async function setupPostgres() {
  const db = require('./db');
  const { Client } = require('pg');
  console.log('Connecting to PostgreSQL / Supabase...');
  const client = new Client(db.pgOptions);
  await client.connect();
  try {
    // The schema has no parameters, so it can be sent as one multi-statement script.
    await client.query(read('supabase_schema.sql'));
  } finally {
    await client.end();
    await db.end();
  }
  console.log('\nSuccess: PostgreSQL / Supabase tables are ready (no data inserted).');
}

async function setupMysql() {
  const mysql = require('mysql2/promise');
  const host = process.env.DB_HOST || 'localhost';
  const port = Number(process.env.DB_PORT || 3306);
  const user = process.env.DB_USER || 'root';
  const dbName = process.env.DB_NAME || 'university_library';

  if (!/^[A-Za-z0-9_]+$/.test(dbName)) {
    throw new Error('DB_NAME may only contain letters, numbers and underscores.');
  }

  console.log(`Connecting to MySQL at ${host}:${port} as '${user}'...`);
  const connection = await mysql.createConnection({
    host,
    port,
    user,
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true,
    charset: 'utf8mb4'
  });
  try {
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await connection.query(`USE \`${dbName}\``);
    await connection.query(read('schema.sql'));
    try {
      await connection.query('ALTER TABLE borrowings ADD COLUMN renewal_count INT NOT NULL DEFAULT 0 AFTER due_date');
    } catch (_) {}
    try {
      await connection.query('ALTER TABLE borrowings ADD COLUMN fine_carried DECIMAL(8,2) NOT NULL DEFAULT 0.00 AFTER renewal_count');
    } catch (_) {}
    console.log(`\nSuccess: database \`${dbName}\` is ready (no data inserted).`);
  } finally {
    await connection.end();
  }
}

(async () => {
  try {
    if (process.env.DATABASE_URL || process.env.SUPABASE_DB_URL) await setupPostgres();
    else await setupMysql();
    console.log('Next step:  npm run create-admin');
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.error('\n[Connection failed] Could not reach the database server.');
      console.error('-> For XAMPP: start MySQL in the XAMPP Control Panel.');
    } else if (err.code === 'ER_ACCESS_DENIED_ERROR') {
      console.error('\n[Access denied] Check DB_USER / DB_PASSWORD in your .env file.');
    } else {
      console.error('\n[Setup error]', err.message);
    }
    process.exit(1);
  }
})();
