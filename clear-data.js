/**
 * Bete Metsahaf - Reset / Clear Database Script
 * Wipes all data across all tables, leaving the schema completely empty and ready for fresh setup.
 */

require('dotenv').config();
const db = require('./db');

const tables = [
  'returns',
  'borrowings',
  'attendance_audit',
  'attendance',
  'books',
  'categories',
  'librarians',
  'admins',
  'activity_logs',
  'system_settings'
];

async function clearData() {
  console.log(`Connecting to ${db.isPostgres ? 'PostgreSQL' : 'MySQL'} to clear all data...\n`);

  try {
    if (db.isPostgres) {
      for (const table of tables) {
        await db.query(`TRUNCATE TABLE "${table}" RESTART IDENTITY CASCADE`);
        console.log(`  cleared  ${table}`);
      }
    } else {
      await db.query('SET FOREIGN_KEY_CHECKS = 0');
      for (const table of tables) {
        await db.query(`TRUNCATE TABLE \`${table}\``);
        console.log(`  cleared  ${table}`);
      }
      await db.query('SET FOREIGN_KEY_CHECKS = 1');
    }

    console.log('\nSuccess: All database tables are now completely empty!');
  } catch (err) {
    console.error('\nError while clearing tables:', err.message);
    process.exit(1);
  } finally {
    await db.end();
  }
}

clearData();
