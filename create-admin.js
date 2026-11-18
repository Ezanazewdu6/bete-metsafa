/**
 * Creates an administrator account.
 *   npm run create-admin
 * Prompts for name, email and password. For scripted use, set
 * NEW_ADMIN_NAME, NEW_ADMIN_EMAIL and NEW_ADMIN_PASSWORD instead.
 */

require('dotenv').config();
const readline = require('readline');
const bcrypt = require('bcrypt');
const db = require('./db');

function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: Boolean(process.stdin.isTTY)
    });
    if (hidden && process.stdin.isTTY) {
      rl._writeToOutput = (s) => {
        rl.output.write(s.includes(question) || s === '\r\n' || s === '\n' ? s : '*');
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

(async () => {
  try {
    const name = (process.env.NEW_ADMIN_NAME || (await ask('Full name: '))).trim();
    const email = (process.env.NEW_ADMIN_EMAIL || (await ask('Email: '))).trim().toLowerCase();
    const password = process.env.NEW_ADMIN_PASSWORD || (await ask('Password (8-72 characters): ', true));

    if (!name || name.length > 100) throw new Error('Name is required (max 100 characters).');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) throw new Error('Please enter a valid email address.');
    if (password.length < 8 || password.length > 72) throw new Error('Password must be 8-72 characters long.');

    const [[admin]] = await db.query('SELECT id FROM admins WHERE email = ?', [email]);
    const [[lib]] = await db.query('SELECT id FROM librarians WHERE email = ?', [email]);
    if (admin || lib) throw new Error('An account with this email already exists.');

    await db.query('INSERT INTO admins (name, email, password_hash) VALUES (?, ?, ?)', [
      name,
      email,
      await bcrypt.hash(password, 10)
    ]);
    console.log(`\nAdministrator created: ${email}`);
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE' || err.code === '42P01') {
      console.error('\nDatabase tables are missing. Run:  npm run setup-db');
    } else {
      console.error(`\nError: ${err.message}`);
    }
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
