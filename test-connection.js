/**
 * Checks the database connection and that every table exists.
 *   npm run test-db
 */

require('dotenv').config();
const db = require('./db');

const TABLES = [
  'admins', 'librarians', 'categories', 'books', 'attendance',
  'attendance_audit', 'borrowings', 'returns', 'activity_logs', 'system_settings'
];

(async () => {
  console.log(`Engine: ${db.engine}`);
  try {
    await db.query('SELECT 1');
    console.log('Connected successfully.\n');
  } catch (err) {
    console.error(`Connection failed: ${err.message}`);
    console.error('\nTips: check the credentials/URL in .env, that the server is running (MySQL) or the Supabase project is not paused.');
    process.exit(1);
  }

  let missing = 0;
  for (const table of TABLES) {
    try {
      const [[row]] = await db.query(`SELECT COUNT(*) AS count FROM ${table}`);
      console.log(`  ok       ${table} (${row.count} rows)`);
    } catch (_) {
      console.log(`  MISSING  ${table}`);
      missing++;
    }
  }

  console.log(missing ? '\nSome tables are missing. Run:  npm run setup-db' : '\nDatabase is ready.');
  await db.end();
  process.exit(missing ? 1 : 0);
})();
