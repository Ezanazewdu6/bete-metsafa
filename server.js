/**
 * Bete Metsahaf - Library & Attendance Management System
 * Backend Server API
 */

require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const path = require('path');
const db = require('./db');

// =============================================================================
// CONFIGURATION (fails fast on unsafe or invalid settings)
// =============================================================================

const fatal = (msg) => {
  console.error(`\n[Configuration error] ${msg}\n`);
  process.exit(1);
};

const PORT = process.env.PORT || 3000;

const JWT_SECRET = process.env.JWT_SECRET || '';
const KNOWN_PLACEHOLDER_SECRETS = ['super-secret-university-jwt-key-2026', 'university-library-secret-key-default'];
if (JWT_SECRET.length < 32 || KNOWN_PLACEHOLDER_SECRETS.includes(JWT_SECRET)) {
  fatal(
    'JWT_SECRET is missing, too short (< 32 chars) or a known placeholder.\n' +
      'Generate one with:\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"\n' +
      'and put it in your .env file as JWT_SECRET=...'
  );
}

const TZ = process.env.APP_TIMEZONE || 'UTC';
try {
  new Intl.DateTimeFormat('en-US', { timeZone: TZ });
} catch (_) {
  fatal(`APP_TIMEZONE "${TZ}" is not a valid IANA timezone name (example: Africa/Addis_Ababa).`);
}

const DEFAULT_SETTINGS = {
  work_start: '08:30',
  grace_minutes: '10',
  half_day_hours: '4',
  loan_days: '14',
  fine_per_day: '0.50',
  low_stock: '2'
};

const MAX_RENEWALS = 5;
const MAX_PASSWORD_LENGTH = 72; // bcrypt only uses the first 72 bytes

// =============================================================================
// TIME HELPERS (all timestamps are stored in UTC; "today" is the library's local date)
// =============================================================================

const partsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});

function localParts(date = new Date()) {
  const p = {};
  for (const part of partsFormatter.formatToParts(date)) p[part.type] = part.value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    month: `${p.year}-${p.month}`,
    secondsOfDay: Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second)
  };
}

const todayStr = () => localParts().date;

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function daysBetween(laterStr, earlierStr) {
  const toMs = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toMs(laterStr) - toMs(earlierStr)) / 86400000);
}

const normDate = (v) => (v == null ? null : String(v).slice(0, 10));
const round2 = (n) => Math.round(n * 100) / 100;

// DB value (Date from Postgres, 'YYYY-MM-DD HH:MM:SS' UTC string from MySQL) -> ISO string
function toIso(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2} \d/.test(s)) return `${s.replace(' ', 'T').slice(0, 19)}Z`;
  return s;
}

const parseJson = (v) => {
  if (v == null || typeof v === 'object') return v;
  try {
    return JSON.parse(v);
  } catch (_) {
    return null;
  }
};

// =============================================================================
// SMALL UTILITIES
// =============================================================================

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

const createError = (message, status = 400) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

/** Required, trimmed, length-limited string field. */
function reqText(body, field, max, label = field) {
  const v = body[field];
  if (v === undefined || v === null || (typeof v !== 'string' && typeof v !== 'number')) {
    throw createError(`Field '${label}' is required`);
  }
  const s = String(v).trim();
  if (!s) throw createError(`Field '${label}' is required`);
  if (s.length > max) throw createError(`Field '${label}' must be at most ${max} characters`);
  return s;
}

/** Optional trimmed string; returns null when empty. */
function optText(body, field, max, label = field) {
  const v = body[field];
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' && typeof v !== 'number') throw createError(`Field '${label}' is invalid`);
  const s = String(v).trim();
  if (!s) return null;
  if (s.length > max) throw createError(`Field '${label}' must be at most ${max} characters`);
  return s;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function reqEmail(body, field = 'email') {
  const email = reqText(body, field, 120, 'email').toLowerCase();
  if (!EMAIL_RE.test(email)) throw createError('Please enter a valid email address');
  return email;
}

function reqPassword(body, field = 'password', label = 'Password') {
  const v = body[field];
  if (typeof v !== 'string' || v.length === 0) throw createError(`${label} is required`);
  if (v.length < 8) throw createError(`${label} must be at least 8 characters long`);
  if (v.length > MAX_PASSWORD_LENGTH) throw createError(`${label} must be at most ${MAX_PASSWORD_LENGTH} characters`);
  return v;
}

function toId(value, label = 'id') {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw createError(`Invalid ${label}`, 400);
  return n;
}

function toIntInRange(value, min, max, label) {
  const n = Number(value);
  if (value === '' || value === null || value === undefined || !Number.isInteger(n) || n < min || n > max) {
    throw createError(`${label} must be a whole number between ${min} and ${max}`);
  }
  return n;
}

const escapeLike = (s) => s.replace(/[\\%_]/g, '\\$&');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function withTransaction(fn) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch (_) {
      /* connection already broken */
    }
    throw err;
  } finally {
    conn.release();
  }
}

const logActivity = async (user, action, details = '') => {
  try {
    await db.query('INSERT INTO activity_logs (actor_role, actor_id, action, details) VALUES (?, ?, ?, ?)', [
      user.role,
      user.id,
      action,
      String(details).slice(0, 255)
    ]);
  } catch (err) {
    console.error('Activity log error:', err.message);
  }
};

const getSettings = async () => {
  const [rows] = await db.query('SELECT key_name, value FROM system_settings');
  const stored = Object.fromEntries(rows.map((r) => [r.key_name, r.value]));
  return { ...DEFAULT_SETTINGS, ...stored };
};

const upsertSetting = (key, value) =>
  db.isPostgres
    ? db.query(
        'INSERT INTO system_settings (key_name, value) VALUES (?, ?) ON CONFLICT (key_name) DO UPDATE SET value = EXCLUDED.value',
        [key, value]
      )
    : db.query(
        'INSERT INTO system_settings (key_name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
        [key, value]
      );

// Simple in-memory limiter (per process). Counts failures only, so busy shared IPs aren't punished.
function createFailureLimiter({ windowMs, max }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs);
  timer.unref();
  const entry = (key) => {
    const now = Date.now();
    let e = hits.get(key);
    if (!e || e.reset <= now) {
      e = { count: 0, reset: now + windowMs };
      hits.set(key, e);
    }
    return e;
  };
  return {
    blocked: (key) => entry(key).count >= max,
    retryAfter: (key) => Math.max(1, Math.ceil((entry(key).reset - Date.now()) / 1000)),
    fail: (key) => {
      entry(key).count++;
    },
    clear: (key) => hits.delete(key)
  };
}

const ipLimiter = createFailureLimiter({ windowMs: 15 * 60 * 1000, max: 10 });
const emailLimiter = createFailureLimiter({ windowMs: 15 * 60 * 1000, max: 30 });

// =============================================================================
// APP & MIDDLEWARE
// =============================================================================

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
  "font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});

app.use(express.json({ limit: '100kb' }));

// Only the ./public folder is served (never the project root, .env, source or schema files).
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir, { dotfiles: 'deny', index: false }));
app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

// -----------------------------------------------------------------------------
// Authentication middleware (re-checks the account on every request, so a
// deactivated or deleted user loses access immediately)
// -----------------------------------------------------------------------------

const authenticateToken = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication token required' });

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch (_) {
    return res.status(401).json({ error: 'Invalid or expired session token' });
  }

  let account;
  if (payload.role === 'admin') {
    [[account]] = await db.query('SELECT id, name, email FROM admins WHERE id = ?', [payload.id]);
  } else if (payload.role === 'librarian') {
    [[account]] = await db.query('SELECT id, name, email, active FROM librarians WHERE id = ?', [payload.id]);
    if (account && !account.active) account = null;
  }
  if (!account) return res.status(401).json({ error: 'This account is no longer active. Please sign in again.' });

  req.user = { id: account.id, role: payload.role, name: account.name, email: account.email };
  next();
});

const requireRole = (role) => (req, res, next) => {
  if (!req.user || req.user.role !== role) {
    return res.status(403).json({ error: `Access denied. Requires '${role}' privilege.` });
  }
  next();
};

const anyAuth = [authenticateToken];
const adminOnly = [authenticateToken, requireRole('admin')];
const librarianOnly = [authenticateToken, requireRole('librarian')];

const signToken = (role, user) =>
  jwt.sign({ id: user.id, role }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '12h' });

// =============================================================================
// PUBLIC CONFIG & AUTHENTICATION
// =============================================================================

app.get('/api/config', (req, res) => res.json({ timezone: TZ }));

const DUMMY_HASH = bcrypt.hashSync('timing-equalizer-not-a-real-password', 10);

app.post(
  '/api/auth/login',
  asyncHandler(async (req, res) => {
    const email = reqText(req.body, 'email', 120, 'email').toLowerCase();
    const password = req.body.password;
    if (typeof password !== 'string' || !password) throw createError("Field 'password' is required");

    const ipKey = `ip:${req.ip}`;
    const emailKey = `email:${email}`;
    if (ipLimiter.blocked(ipKey) || emailLimiter.blocked(emailKey)) {
      const wait = Math.max(ipLimiter.retryAfter(ipKey), emailLimiter.retryAfter(emailKey));
      res.set('Retry-After', String(wait));
      throw createError('Too many failed sign-in attempts. Please wait a few minutes and try again.', 429);
    }

    let account = null;
    let role = null;
    const [[admin]] = await db.query('SELECT * FROM admins WHERE email = ?', [email]);
    if (admin) {
      account = admin;
      role = 'admin';
    } else {
      const [[librarian]] = await db.query('SELECT * FROM librarians WHERE email = ?', [email]);
      if (librarian) {
        account = librarian;
        role = 'librarian';
      }
    }

    // Always run bcrypt so response time doesn't reveal whether the email exists
    const passwordOk = await bcrypt.compare(password, account ? account.password_hash : DUMMY_HASH);
    if (!account || !passwordOk) {
      ipLimiter.fail(ipKey);
      emailLimiter.fail(emailKey);
      throw createError('Invalid email or password', 401);
    }

    if (role === 'librarian' && !account.active) {
      throw createError('Your librarian account has been deactivated. Please contact an administrator.', 403);
    }

    ipLimiter.clear(ipKey);
    emailLimiter.clear(emailKey);

    await logActivity({ role, id: account.id }, 'login', `${role === 'admin' ? 'Admin' : 'Librarian'} logged in`);
    res.json({ token: signToken(role, account), role, name: account.name, email: account.email });
  })
);

app.get(
  '/api/auth/me',
  anyAuth,
  asyncHandler(async (req, res) => {
    res.json({ id: req.user.id, role: req.user.role, name: req.user.name, email: req.user.email });
  })
);

// =============================================================================
// LIBRARIAN MANAGEMENT (ADMIN ONLY)
// =============================================================================

async function emailInUse(email, { exceptLibrarianId = null } = {}) {
  const [[admin]] = await db.query('SELECT id FROM admins WHERE email = ?', [email]);
  if (admin) return true;
  const [[lib]] = await db.query('SELECT id FROM librarians WHERE email = ?', [email]);
  return Boolean(lib && lib.id !== exceptLibrarianId);
}

app.get(
  '/api/librarians',
  adminOnly,
  asyncHandler(async (req, res) => {
    const [rows] = await db.query(
      'SELECT id, staff_no, name, email, phone, active, created_at FROM librarians ORDER BY name ASC'
    );
    res.json(rows.map((r) => ({ ...r, active: Number(r.active), created_at: toIso(r.created_at) })));
  })
);

app.post(
  '/api/librarians',
  adminOnly,
  asyncHandler(async (req, res) => {
    const staff_no = reqText(req.body, 'staff_no', 30, 'staff number');
    const name = reqText(req.body, 'name', 100);
    const email = reqEmail(req.body);
    const phone = optText(req.body, 'phone', 30);
    const password = reqPassword(req.body);

    if (await emailInUse(email)) throw createError('An account with this email address already exists');

    const hashed = await bcrypt.hash(password, 10);
    try {
      const [result] = await db.query(
        'INSERT INTO librarians (staff_no, name, email, phone, password_hash) VALUES (?, ?, ?, ?, ?)',
        [staff_no, name, email, phone, hashed]
      );
      await logActivity(req.user, 'create_librarian', `Created librarian ${name} (${email})`);
      res.status(201).json({ id: result.insertId, message: 'Librarian created successfully' });
    } catch (err) {
      if (db.isDuplicateError(err)) throw createError(`Staff number "${staff_no}" or this email is already in use`);
      throw err;
    }
  })
);

app.put(
  '/api/librarians/:id',
  adminOnly,
  asyncHandler(async (req, res) => {
    const id = toId(req.params.id);
    const staff_no = reqText(req.body, 'staff_no', 30, 'staff number');
    const name = reqText(req.body, 'name', 100);
    const email = reqEmail(req.body);
    const phone = optText(req.body, 'phone', 30);
    const a = req.body.active;
    const active = a === false || a === 0 || a === '0' || a === 'false' ? 0 : 1;

    if (await emailInUse(email, { exceptLibrarianId: id })) {
      throw createError('Another account already uses this email address');
    }

    try {
      const [result] = await db.query(
        'UPDATE librarians SET staff_no = ?, name = ?, email = ?, phone = ?, active = ? WHERE id = ?',
        [staff_no, name, email, phone, active, id]
      );
      if (result.affectedRows === 0) throw createError('Librarian not found', 404);
    } catch (err) {
      if (db.isDuplicateError(err)) throw createError(`Staff number "${staff_no}" or this email is already in use`);
      throw err;
    }

    await logActivity(req.user, 'edit_librarian', `Updated librarian ID ${id}`);
    res.json({ ok: true, message: 'Librarian updated successfully' });
  })
);

app.post(
  '/api/librarians/:id/reset-password',
  adminOnly,
  asyncHandler(async (req, res) => {
    const id = toId(req.params.id);
    const password = reqPassword(req.body, 'password', 'New password');
    const hashed = await bcrypt.hash(password, 10);
    const [result] = await db.query('UPDATE librarians SET password_hash = ? WHERE id = ?', [hashed, id]);
    if (result.affectedRows === 0) throw createError('Librarian not found', 404);
    await logActivity(req.user, 'reset_password', `Reset password for librarian ID ${id}`);
    res.json({ ok: true, message: 'Password reset successfully' });
  })
);

app.delete(
  '/api/librarians/:id',
  adminOnly,
  asyncHandler(async (req, res) => {
    const id = toId(req.params.id);
    try {
      const [result] = await db.query('DELETE FROM librarians WHERE id = ?', [id]);
      if (result.affectedRows === 0) throw createError('Librarian not found', 404);
    } catch (err) {
      if (db.isForeignKeyError(err)) {
        throw createError(
          'Cannot delete a librarian who has attendance or transaction history. Deactivate their account instead.'
        );
      }
      throw err;
    }
    await logActivity(req.user, 'delete_librarian', `Deleted librarian ID ${id}`);
    res.json({ ok: true, message: 'Librarian removed successfully' });
  })
);

// =============================================================================
// SYSTEM SETTINGS
// =============================================================================

app.get(
  '/api/settings',
  anyAuth,
  asyncHandler(async (req, res) => {
    res.json(await getSettings());
  })
);

app.put(
  '/api/settings',
  adminOnly,
  asyncHandler(async (req, res) => {
    const u = req.body;
    if (!u || typeof u !== 'object' || Array.isArray(u)) throw createError('Invalid settings payload');

    const clean = {};
    if (u.work_start !== undefined) {
      const v = String(u.work_start).trim();
      if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(v)) {
        throw createError('Work start time must be in 24-hour HH:MM format (e.g. 08:30)');
      }
      clean.work_start = v;
    }
    if (u.grace_minutes !== undefined) {
      clean.grace_minutes = String(toIntInRange(u.grace_minutes, 0, 120, 'Grace period (minutes)'));
    }
    if (u.half_day_hours !== undefined) {
      const v = Number(u.half_day_hours);
      if (!Number.isFinite(v) || v <= 0 || v > 12) {
        throw createError('Half-day threshold must be a number greater than 0 and at most 12 hours');
      }
      clean.half_day_hours = String(v);
    }
    if (u.loan_days !== undefined) {
      clean.loan_days = String(toIntInRange(u.loan_days, 1, 365, 'Standard loan duration (days)'));
    }
    if (u.fine_per_day !== undefined) {
      const v = Number(u.fine_per_day);
      if (!Number.isFinite(v) || v < 0 || v > 1000) {
        throw createError('Daily overdue fine must be a number between 0 and 1000');
      }
      clean.fine_per_day = String(round2(v));
    }
    if (u.low_stock !== undefined) {
      clean.low_stock = String(toIntInRange(u.low_stock, 1, 100, 'Low-stock threshold'));
    }

    for (const [key, value] of Object.entries(clean)) await upsertSetting(key, value);

    await logActivity(req.user, 'update_settings', 'Updated system circulation and shift settings');
    res.json({ ok: true, message: 'System settings updated successfully', settings: await getSettings() });
  })
);

// =============================================================================
// ATTENDANCE
// =============================================================================

const ATTENDANCE_SELECT = `
  SELECT a.id, l.id AS librarian_id, l.name, l.staff_no, a.work_date, a.check_in, a.check_out, a.hours, a.status
  FROM attendance a
  JOIN librarians l ON l.id = a.librarian_id
`;

function mapAttendance(r, today) {
  const workDate = normDate(r.work_date);
  const incomplete = r.check_in && !r.check_out && r.status !== 'Absent' && workDate < today;
  return {
    id: r.id,
    librarian_id: r.librarian_id,
    name: r.name,
    staff_no: r.staff_no,
    work_date: workDate,
    check_in: toIso(r.check_in),
    check_out: toIso(r.check_out),
    hours: r.hours == null ? null : Number(r.hours),
    status: incomplete ? 'Incomplete checkout' : r.status
  };
}

app.get(
  '/api/attendance/today',
  librarianOnly,
  asyncHandler(async (req, res) => {
    const today = todayStr();
    const [rows] = await db.query(`${ATTENDANCE_SELECT} WHERE a.librarian_id = ? AND a.work_date = ?`, [
      req.user.id,
      today
    ]);
    res.json(rows[0] ? mapAttendance(rows[0], today) : null);
  })
);

app.post(
  '/api/attendance/check-in',
  librarianOnly,
  asyncHandler(async (req, res) => {
    const settings = await getSettings();
    const now = new Date();
    const local = localParts(now);

    const [startHour, startMinute] = settings.work_start.split(':').map(Number);
    const graceMinutes = Number(settings.grace_minutes);
    const lateAfterSeconds = (startHour * 60 + startMinute + graceMinutes) * 60;
    const status = local.secondsOfDay > lateAfterSeconds ? 'Late' : 'Present';

    try {
      await db.query('INSERT INTO attendance (librarian_id, work_date, check_in, status) VALUES (?, ?, ?, ?)', [
        req.user.id,
        local.date,
        now,
        status
      ]);
    } catch (err) {
      if (db.isDuplicateError(err)) throw createError('You have already checked in for today');
      throw err;
    }

    await logActivity(req.user, 'check_in', `Check-in recorded as ${status}`);
    res.json({ ok: true, status });
  })
);

app.post(
  '/api/attendance/check-out',
  librarianOnly,
  asyncHandler(async (req, res) => {
    const settings = await getSettings();
    const halfDayHours = Number(settings.half_day_hours);
    const now = new Date();

    const [[open]] = await db.query(
      'SELECT id, check_in, status FROM attendance WHERE librarian_id = ? AND work_date = ? AND check_out IS NULL',
      [req.user.id, todayStr()]
    );
    if (!open || !open.check_in) {
      throw createError('No open check-in found for today, or check-out was already recorded');
    }

    const minutes = Math.max(0, Math.round((now - new Date(toIso(open.check_in))) / 60000));
    const hours = round2(minutes / 60);
    const status = hours < halfDayHours && open.status === 'Present' ? 'Half-day' : open.status;

    await db.query('UPDATE attendance SET check_out = ?, hours = ?, status = ? WHERE id = ?', [
      now,
      hours,
      status,
      open.id
    ]);

    await logActivity(req.user, 'check_out', `Check-out recorded (${hours} hrs)`);
    res.json({ ok: true, message: `Check-out recorded successfully (${hours} hrs worked)` });
  })
);

app.get(
  '/api/attendance/me',
  librarianOnly,
  asyncHandler(async (req, res) => {
    const today = todayStr();
    const [rows] = await db.query(`${ATTENDANCE_SELECT} WHERE a.librarian_id = ? ORDER BY a.work_date DESC LIMIT 90`, [
      req.user.id
    ]);
    res.json(rows.map((r) => mapAttendance(r, today)));
  })
);

app.get(
  '/api/attendance',
  adminOnly,
  asyncHandler(async (req, res) => {
    const from = req.query.from || '1970-01-01';
    const to = req.query.to || '2999-12-31';
    if (!DATE_RE.test(from) || !DATE_RE.test(to)) throw createError('Dates must be in YYYY-MM-DD format');

    const params = [from, to];
    let where = ' WHERE a.work_date BETWEEN ? AND ?';
    if (req.query.librarian_id) {
      where += ' AND a.librarian_id = ?';
      params.push(toId(req.query.librarian_id, 'librarian id'));
    }

    const today = todayStr();
    const [rows] = await db.query(`${ATTENDANCE_SELECT} ${where} ORDER BY a.work_date DESC, l.name ASC LIMIT 2000`, params);
    res.json(rows.map((r) => mapAttendance(r, today)));
  })
);

function parseDateTimeInput(value, label) {
  if (value === null || value === '') return null;
  const s = String(value);
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    throw createError(`${label} must be an ISO timestamp that includes a timezone (e.g. 2026-01-31T08:30:00Z)`);
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw createError(`${label} is not a valid date/time`);
  return d;
}

app.put(
  '/api/attendance/:id',
  adminOnly,
  asyncHandler(async (req, res) => {
    const id = toId(req.params.id);
    const status = reqText(req.body, 'status', 30);
    const reason = reqText(req.body, 'reason', 255);

    const validStatuses = ['Present', 'Late', 'Absent', 'Half-day'];
    if (!validStatuses.includes(status)) throw createError(`Status must be one of: ${validStatuses.join(', ')}`);

    await withTransaction(async (conn) => {
      const [[old]] = await conn.query(
        'SELECT check_in, check_out, hours, status FROM attendance WHERE id = ? FOR UPDATE',
        [id]
      );
      if (!old) throw createError('Attendance record not found', 404);

      const newIn = req.body.check_in !== undefined ? parseDateTimeInput(req.body.check_in, 'check_in') : null;
      const newOut = req.body.check_out !== undefined ? parseDateTimeInput(req.body.check_out, 'check_out') : null;

      const checkIn = req.body.check_in !== undefined ? newIn : old.check_in ? new Date(toIso(old.check_in)) : null;
      const checkOut = req.body.check_out !== undefined ? newOut : old.check_out ? new Date(toIso(old.check_out)) : null;

      // Times are only re-validated / hours only recalculated when the admin actually supplied new times;
      // a status-only correction never fails because of pre-existing data.
      let hours = old.hours == null ? null : Number(old.hours);
      const timesChanged = req.body.check_in !== undefined || req.body.check_out !== undefined;
      if (timesChanged && checkIn && checkOut) {
        if (checkOut < checkIn) throw createError('Check-out cannot be earlier than check-in');
        hours = round2((checkOut - checkIn) / 3600000);
      }

      await conn.query('UPDATE attendance SET check_in = ?, check_out = ?, hours = ?, status = ? WHERE id = ?', [
        checkIn,
        checkOut,
        hours,
        status,
        id
      ]);

      const before = {
        check_in: toIso(old.check_in),
        check_out: toIso(old.check_out),
        hours: old.hours == null ? null : Number(old.hours),
        status: old.status
      };
      const after = {
        check_in: checkIn ? checkIn.toISOString() : null,
        check_out: checkOut ? checkOut.toISOString() : null,
        hours,
        status
      };

      await conn.query(
        'INSERT INTO attendance_audit (attendance_id, admin_id, old_values, new_values, reason) VALUES (?, ?, ?, ?, ?)',
        [id, req.user.id, JSON.stringify(before), JSON.stringify(after), reason]
      );
    });

    await logActivity(req.user, 'correct_attendance', `Adjusted attendance record ID ${id}: ${reason}`);
    res.json({ ok: true, message: 'Attendance record updated with audit trail' });
  })
);

app.get(
  '/api/attendance/:id/audit',
  adminOnly,
  asyncHandler(async (req, res) => {
    const id = toId(req.params.id);
    const [rows] = await db.query(
      `SELECT aa.id, aa.attendance_id, aa.admin_id, aa.old_values, aa.new_values, aa.reason, aa.created_at, adm.name AS admin_name
       FROM attendance_audit aa
       JOIN admins adm ON adm.id = aa.admin_id
       WHERE aa.attendance_id = ?
       ORDER BY aa.created_at DESC, aa.id DESC`,
      [id]
    );
    res.json(
      rows.map((r) => ({
        ...r,
        old_values: parseJson(r.old_values),
        new_values: parseJson(r.new_values),
        created_at: toIso(r.created_at)
      }))
    );
  })
);

// =============================================================================
// BOOKS & CATEGORIES
// =============================================================================

app.get(
  '/api/categories',
  anyAuth,
  asyncHandler(async (req, res) => {
    const [rows] = await db.query('SELECT id, name FROM categories ORDER BY name ASC');
    res.json(rows);
  })
);

app.post(
  '/api/categories',
  adminOnly,
  asyncHandler(async (req, res) => {
    const name = reqText(req.body, 'name', 80);
    try {
      const [result] = await db.query('INSERT INTO categories (name) VALUES (?)', [name]);
      res.status(201).json({ ok: true, id: result.insertId });
    } catch (err) {
      if (db.isDuplicateError(err)) throw createError(`Category "${name}" already exists`);
      throw err;
    }
  })
);

const SHELF_EXPR = "COALESCE(NULLIF(TRIM(shelf), ''), 'Unassigned')";

app.get(
  '/api/shelves',
  anyAuth,
  asyncHandler(async (req, res) => {
    const [rows] = await db.query(
      `SELECT ${SHELF_EXPR} AS shelf,
              COUNT(*) AS total_titles,
              COALESCE(SUM(total_copies), 0) AS total_copies,
              COALESCE(SUM(available_copies), 0) AS available_copies
       FROM books
       GROUP BY ${SHELF_EXPR}
       ORDER BY ${SHELF_EXPR} ASC`
    );
    res.json(
      rows.map((r) => ({
        shelf: r.shelf,
        total_titles: Number(r.total_titles),
        total_copies: Number(r.total_copies),
        available_copies: Number(r.available_copies)
      }))
    );
  })
);

app.get(
  '/api/books',
  anyAuth,
  asyncHandler(async (req, res) => {
    const settings = await getSettings();
    const term = `%${escapeLike(String(req.query.q || '').trim())}%`;
    const params = [term, term, term, term];
    let where = `(b.title ${db.like} ? OR b.author ${db.like} ? OR b.isbn ${db.like} ? OR b.shelf ${db.like} ?)`;

    if (req.query.shelf) {
      const shelf = String(req.query.shelf).trim();
      if (shelf === 'Unassigned') {
        where += " AND (b.shelf IS NULL OR TRIM(b.shelf) = '')";
      } else {
        where += ' AND b.shelf = ?';
        params.push(shelf);
      }
    }

    if (req.query.filter === 'unavailable') {
      where += ' AND b.available_copies = 0';
    } else if (req.query.filter === 'low') {
      where += ' AND b.available_copies <= ?';
      params.push(Number(settings.low_stock));
    }

    const [rows] = await db.query(
      `SELECT b.*, c.name AS category
       FROM books b
       LEFT JOIN categories c ON c.id = b.category_id
       WHERE ${where}
       ORDER BY b.shelf ASC, b.title ASC`,
      params
    );
    res.json(rows.map((r) => ({ ...r, created_at: toIso(r.created_at) })));
  })
);

function parseBookBody(b) {
  const isbn = reqText(b, 'isbn', 20, 'ISBN');
  const title = reqText(b, 'title', 200);
  const author = reqText(b, 'author', 150);
  const publisher = optText(b, 'publisher', 120);
  const shelf = optText(b, 'shelf', 30);
  const description = optText(b, 'description', 2000);
  const total = toIntInRange(b.total_copies, 1, 100000, 'Total copies');

  let pub_year = null;
  if (b.pub_year !== undefined && b.pub_year !== null && b.pub_year !== '') {
    pub_year = toIntInRange(b.pub_year, 1000, new Date().getFullYear() + 1, 'Publication year');
  }
  let category_id = null;
  if (b.category_id !== undefined && b.category_id !== null && b.category_id !== '') {
    category_id = toId(b.category_id, 'category');
  }
  return { isbn, title, author, publisher, shelf, description, total, pub_year, category_id };
}

app.post(
  '/api/books',
  anyAuth,
  asyncHandler(async (req, res) => {
    const b = parseBookBody(req.body);
    try {
      const [result] = await db.query(
        `INSERT INTO books (isbn, title, author, publisher, pub_year, category_id, shelf, description, total_copies, available_copies)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [b.isbn, b.title, b.author, b.publisher, b.pub_year, b.category_id, b.shelf, b.description, b.total, b.total]
      );
      await logActivity(req.user, 'add_book', `Added book "${b.title}"`);
      res.status(201).json({ id: result.insertId, message: 'Book created successfully' });
    } catch (err) {
      if (db.isDuplicateError(err)) throw createError(`A book with ISBN ${b.isbn} already exists`);
      if (db.isForeignKeyError(err)) throw createError('The selected category does not exist');
      throw err;
    }
  })
);

app.put(
  '/api/books/:id',
  anyAuth,
  asyncHandler(async (req, res) => {
    const id = toId(req.params.id);
    const b = parseBookBody(req.body);

    try {
      await withTransaction(async (conn) => {
        const [[existing]] = await conn.query(
          'SELECT total_copies, available_copies FROM books WHERE id = ? FOR UPDATE',
          [id]
        );
        if (!existing) throw createError('Book not found', 404);

        const onLoan = existing.total_copies - existing.available_copies;
        if (b.total < onLoan) {
          throw createError(`Total copies (${b.total}) cannot be less than copies currently on loan (${onLoan})`);
        }
        const available = b.total - onLoan;

        await conn.query(
          `UPDATE books
           SET isbn = ?, title = ?, author = ?, publisher = ?, pub_year = ?, category_id = ?, shelf = ?,
               description = ?, total_copies = ?, available_copies = ?
           WHERE id = ?`,
          [b.isbn, b.title, b.author, b.publisher, b.pub_year, b.category_id, b.shelf, b.description, b.total, available, id]
        );
      });
    } catch (err) {
      if (db.isDuplicateError(err)) throw createError(`Another book already uses ISBN ${b.isbn}`);
      if (db.isForeignKeyError(err)) throw createError('The selected category does not exist');
      throw err;
    }

    await logActivity(req.user, 'edit_book', `Updated book ID ${id}`);
    res.json({ ok: true, message: 'Book updated successfully' });
  })
);

app.delete(
  '/api/books/:id',
  adminOnly,
  asyncHandler(async (req, res) => {
    const id = toId(req.params.id);
    try {
      const [result] = await db.query('DELETE FROM books WHERE id = ?', [id]);
      if (result.affectedRows === 0) throw createError('Book not found', 404);
    } catch (err) {
      if (db.isForeignKeyError(err)) throw createError('Cannot delete a book that has active or past borrowing history');
      throw err;
    }
    await logActivity(req.user, 'delete_book', `Deleted book ID ${id}`);
    res.json({ ok: true, message: 'Book removed successfully' });
  })
);

// =============================================================================
// BORROWING & RETURNS (TRANSACTIONAL)
// =============================================================================

app.get(
  '/api/borrowings',
  anyAuth,
  asyncHandler(async (req, res) => {
    const settings = await getSettings();
    const finePerDay = Number(settings.fine_per_day);
    const today = todayStr();

    const params = [];
    let filter = '';
    if (req.query.status === 'overdue') {
      filter = "AND b.status = 'borrowed' AND b.due_date < ?";
      params.push(today);
    } else if (req.query.status === 'borrowed') {
      filter = "AND b.status = 'borrowed'";
    } else if (req.query.status === 'returned') {
      filter = "AND b.status = 'returned'";
    }

    if (req.query.search && typeof req.query.search === 'string') {
      const q = `%${req.query.search.trim()}%`;
      filter += ` AND (bk.title ${db.like} ? OR bk.isbn ${db.like} ? OR b.borrower_name ${db.like} ? OR b.borrower_ref ${db.like} ?)`;
      params.push(q, q, q, q);
    }

    const [rows] = await db.query(
      `SELECT b.id, bk.title, bk.isbn, b.borrower_name, b.borrower_ref, b.borrowed_at, b.due_date,
              COALESCE(b.renewal_count, 0) AS renewal_count, b.fine_carried, b.status,
              r.returned_at, r.fine, l.name AS librarian
       FROM borrowings b
       JOIN books bk ON bk.id = b.book_id
       LEFT JOIN returns r ON r.borrowing_id = b.id
       LEFT JOIN librarians l ON l.id = b.librarian_id
       WHERE 1 = 1 ${filter}
       ORDER BY b.id DESC
       LIMIT 300`,
      params
    );

    res.json(
      rows.map((r) => {
        const dueDate = normDate(r.due_date);
        const overdueDays = r.status === 'borrowed' ? Math.max(daysBetween(today, dueDate), 0) : 0;
        const { fine_carried, ...rest } = r;
        return {
          ...rest,
          borrowed_at: toIso(r.borrowed_at),
          returned_at: toIso(r.returned_at),
          due_date: dueDate,
          fine: r.fine == null ? null : Number(r.fine),
          overdue_days: overdueDays,
          accrued_fine: r.status === 'borrowed' ? round2(Number(fine_carried || 0) + overdueDays * finePerDay) : 0
        };
      })
    );
  })
);

app.post(
  '/api/borrowings',
  anyAuth,
  asyncHandler(async (req, res) => {
    const book_id = toId(req.body.book_id, 'book');
    const borrower_name = reqText(req.body, 'borrower_name', 120, 'borrower name');
    const borrower_ref = optText(req.body, 'borrower_ref', 60, 'borrower reference');

    const settings = await getSettings();
    let loanDays = Number(settings.loan_days);
    if (req.body.days !== undefined && req.body.days !== null && req.body.days !== '') {
      loanDays = toIntInRange(req.body.days, 1, 365, 'Loan duration (days)');
    }
    const dueDate = addDays(todayStr(), loanDays);

    const bookTitle = await withTransaction(async (conn) => {
      const [[book]] = await conn.query('SELECT available_copies, title FROM books WHERE id = ? FOR UPDATE', [book_id]);
      if (!book) throw createError('Book not found', 404);
      if (book.available_copies < 1) throw createError('No available copies remaining for this book');

      await conn.query('UPDATE books SET available_copies = available_copies - 1 WHERE id = ?', [book_id]);
      await conn.query(
        `INSERT INTO borrowings (book_id, librarian_id, admin_id, borrower_name, borrower_ref, borrowed_at, due_date)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          book_id,
          req.user.role === 'librarian' ? req.user.id : null,
          req.user.role === 'admin' ? req.user.id : null,
          borrower_name,
          borrower_ref,
          new Date(),
          dueDate
        ]
      );
      return book.title;
    });

    await logActivity(req.user, 'issue_book', `Issued "${bookTitle}" to ${borrower_name}`);
    res.status(201).json({ ok: true, message: 'Book issued successfully', due_date: dueDate });
  })
);

app.post(
  '/api/borrowings/:id/return',
  anyAuth,
  asyncHandler(async (req, res) => {
    const id = toId(req.params.id);
    const settings = await getSettings();
    const finePerDay = Number(settings.fine_per_day);
    const today = todayStr();

    const fine = await withTransaction(async (conn) => {
      const [[loan]] = await conn.query(
        "SELECT book_id, due_date, fine_carried FROM borrowings WHERE id = ? AND status = 'borrowed' FOR UPDATE",
        [id]
      );
      if (!loan) throw createError('Active borrowing record not found or already returned', 404);

      const overdueDays = Math.max(daysBetween(today, normDate(loan.due_date)), 0);
      const total = round2(Number(loan.fine_carried || 0) + overdueDays * finePerDay);

      await conn.query("UPDATE borrowings SET status = 'returned' WHERE id = ?", [id]);
      await conn.query('UPDATE books SET available_copies = available_copies + 1 WHERE id = ?', [loan.book_id]);
      await conn.query(
        'INSERT INTO returns (borrowing_id, librarian_id, admin_id, returned_at, fine) VALUES (?, ?, ?, ?, ?)',
        [
          id,
          req.user.role === 'librarian' ? req.user.id : null,
          req.user.role === 'admin' ? req.user.id : null,
          new Date(),
          total
        ]
      );
      return total;
    });

    await logActivity(req.user, 'return_book', `Returned borrowing ID ${id} (Fine: ${fine.toFixed(2)})`);
    res.json({ ok: true, fine, message: 'Book returned successfully' });
  })
);

app.post(
  '/api/borrowings/:id/renew',
  anyAuth,
  asyncHandler(async (req, res) => {
    const id = toId(req.params.id);
    const settings = await getSettings();
    const finePerDay = Number(settings.fine_per_day);
    const body = req.body || {};

    let extension = Number(settings.loan_days);
    if (body.days !== undefined && body.days !== null && body.days !== '') {
      extension = toIntInRange(body.days, 1, 90, 'Extension duration (days)');
    }
    extension = Math.min(extension, 90);
    const today = todayStr();

    const result = await withTransaction(async (conn) => {
      const [[loan]] = await conn.query(
        `SELECT b.id, b.due_date, b.status, b.borrower_name, b.fine_carried,
                COALESCE(b.renewal_count, 0) AS renewal_count, bk.title
         FROM borrowings b
         JOIN books bk ON bk.id = b.book_id
         WHERE b.id = ?
         FOR UPDATE`,
        [id]
      );
      if (!loan) throw createError('Borrowing record not found', 404);
      if (loan.status !== 'borrowed') throw createError('Cannot renew a book that has already been returned');
      if (loan.renewal_count >= MAX_RENEWALS) {
        throw createError(
          `Maximum renewal limit (${MAX_RENEWALS} times) reached for this loan. The book must be returned and inspected.`
        );
      }

      const currentDue = normDate(loan.due_date);
      const overdueDays = Math.max(daysBetween(today, currentDue), 0);

      // Fines already earned stay on the loan: renewing must not erase them.
      const carried = round2(Number(loan.fine_carried || 0) + overdueDays * finePerDay);

      // Extend from the current due date if still in the future, otherwise from today.
      const base = currentDue > today ? currentDue : today;
      const newDue = addDays(base, extension);

      await conn.query(
        'UPDATE borrowings SET due_date = ?, renewal_count = COALESCE(renewal_count, 0) + 1, fine_carried = ? WHERE id = ?',
        [newDue, carried, id]
      );
      return { loan, newDue, carried };
    });

    await logActivity(
      req.user,
      'renew_book',
      `Renewed "${result.loan.title}" (${result.loan.borrower_name}) by +${extension} days. New due date: ${result.newDue}`
    );

    const fineNote = result.carried > 0 ? ` Fine accrued so far: ${result.carried.toFixed(2)}.` : '';
    res.json({
      ok: true,
      message: `Loan renewed successfully by +${extension} days! New due date: ${result.newDue}.${fineNote}`,
      new_due_date: result.newDue,
      renewal_count: Number(result.loan.renewal_count) + 1,
      fine_carried: result.carried
    });
  })
);

// =============================================================================
// DASHBOARD & ANALYTICS
// =============================================================================

const monthLabel = (key) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
};

app.get(
  '/api/dashboard',
  anyAuth,
  asyncHandler(async (req, res) => {
    const settings = await getSettings();
    const today = todayStr();
    const lowStock = Number(settings.low_stock);

    const scalar = async (sql, params = []) => {
      const [rows] = await db.query(sql, params);
      return Number(Object.values(rows[0] || {})[0] || 0);
    };

    // Last 6 calendar months (library timezone), zero-filled, bucketed in JS so it is identical on both engines
    const monthKeys = [];
    {
      let [y, m] = localParts().month.split('-').map(Number);
      for (let i = 0; i < 6; i++) {
        monthKeys.unshift(`${y}-${String(m).padStart(2, '0')}`);
        m -= 1;
        if (m === 0) {
          m = 12;
          y -= 1;
        }
      }
    }
    const since = new Date(Date.now() - 200 * 86400000);
    const [borrowRows] = await db.query('SELECT borrowed_at FROM borrowings WHERE borrowed_at >= ?', [since]);
    const monthCounts = Object.fromEntries(monthKeys.map((k) => [k, 0]));
    for (const r of borrowRows) {
      const key = localParts(new Date(toIso(r.borrowed_at))).month;
      if (key in monthCounts) monthCounts[key]++;
    }

    const [recentRows] = await db.query(
      `SELECT b.id, bk.title, b.borrower_name, b.due_date, COALESCE(b.renewal_count, 0) AS renewal_count, b.fine_carried, b.status, b.borrowed_at
       FROM borrowings b
       JOIN books bk ON bk.id = b.book_id
       ORDER BY b.id DESC
       LIMIT 8`
    );
    const [categoryRows] = await db.query(
      `SELECT COALESCE(c.name, 'Uncategorized') AS name, SUM(b.total_copies) AS n
       FROM books b
       LEFT JOIN categories c ON c.id = b.category_id
       GROUP BY COALESCE(c.name, 'Uncategorized')
       ORDER BY name ASC`
    );
    const [activityRows] = await db.query(
      'SELECT actor_role, action, details, created_at FROM activity_logs ORDER BY id DESC LIMIT 8'
    );

    const data = {
      total_books: await scalar('SELECT COALESCE(SUM(total_copies), 0) FROM books'),
      total_titles: await scalar('SELECT COUNT(*) FROM books'),
      available_books: await scalar('SELECT COALESCE(SUM(available_copies), 0) FROM books'),
      borrowed_books: await scalar("SELECT COUNT(*) FROM borrowings WHERE status = 'borrowed'"),
      overdue_books: await scalar("SELECT COUNT(*) FROM borrowings WHERE status = 'borrowed' AND due_date < ?", [today]),
      low_stock: await scalar('SELECT COUNT(*) FROM books WHERE available_copies <= ?', [lowStock]),
      recent: recentRows.map((r) => {
        const dueDate = normDate(r.due_date);
        const isOverdue = r.status === 'borrowed' && dueDate && dueDate < today;
        const overdueDays = isOverdue ? Math.max(daysBetween(today, dueDate), 0) : 0;
        return {
          ...r,
          due_date: dueDate,
          borrowed_at: toIso(r.borrowed_at),
          is_overdue: isOverdue,
          overdue_days: overdueDays,
          accrued_fine: isOverdue ? round2(Number(r.fine_carried || 0) + overdueDays * Number(settings.fine_per_day)) : 0
        };
      }),
      by_category: categoryRows.map((r) => ({ name: r.name, n: Number(r.n) })),
      monthly_borrowings: monthKeys.map((k) => ({ month: monthLabel(k), count: monthCounts[k] })),
      activity: activityRows.map((r) => ({ ...r, created_at: toIso(r.created_at) }))
    };

    if (req.user.role === 'admin') {
      data.total_librarians = await scalar('SELECT COUNT(*) FROM librarians WHERE active = 1');
      data.present_today = await scalar(
        "SELECT COUNT(*) FROM attendance WHERE work_date = ? AND status IN ('Present', 'Late', 'Half-day')",
        [today]
      );
      data.late_today = await scalar("SELECT COUNT(*) FROM attendance WHERE work_date = ? AND status = 'Late'", [today]);
      const checkedIn = await scalar('SELECT COUNT(*) FROM attendance WHERE work_date = ?', [today]);
      data.absent_today = Math.max(data.total_librarians - checkedIn, 0);
    }

    res.json(data);
  })
);

// =============================================================================
// ERROR HANDLING
// =============================================================================

app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint not found' }));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large' });

  const status = err.status && err.status < 500 ? err.status : 500;
  if (status === 500) console.error('[Error Handler]', err);
  res.status(status).json({ error: status === 500 ? 'An unexpected server error occurred' : err.message });
});

// =============================================================================
// STARTUP
// =============================================================================

async function ensureFirstAdmin() {
  const [[row]] = await db.query('SELECT COUNT(*) AS count FROM admins');
  if (Number(row.count) > 0) return;

  const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME } = process.env;
  if (ADMIN_EMAIL && ADMIN_PASSWORD) {
    const email = ADMIN_EMAIL.trim().toLowerCase();
    if (!EMAIL_RE.test(email) || ADMIN_PASSWORD.length < 8 || ADMIN_PASSWORD.length > MAX_PASSWORD_LENGTH) {
      console.warn('[Setup] ADMIN_EMAIL / ADMIN_PASSWORD in .env are invalid (password needs 8-72 characters); no admin created.');
    } else {
      await db.query('INSERT INTO admins (name, email, password_hash) VALUES (?, ?, ?)', [
        (ADMIN_NAME || 'Administrator').trim(),
        email,
        await bcrypt.hash(ADMIN_PASSWORD, 10)
      ]);
      console.log(`[Setup] First administrator created: ${email}`);
      console.log('[Setup] Remove ADMIN_PASSWORD from your .env file now.');
      return;
    }
  }
  console.warn('\n[Setup] No administrator account exists yet. Create one with:  npm run create-admin\n');
}

let server;

(async () => {
  try {
    await db.query('SELECT 1');
    console.log(`Connected to database engine: ${db.engine}`);
    console.log(`Library timezone: ${TZ} (today is ${todayStr()})`);
    if (db.isPostgres && db.sslMode === 'require') {
      console.warn('[Security] Database TLS is on but the server certificate is not verified. See README (DB_SSL=verify).');
    }

    await ensureFirstAdmin();

    server = app.listen(PORT, () => console.log(`Bete Metsahaf server running at http://localhost:${PORT}`));
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE' || err.code === '42P01') {
      console.error('Fatal: database tables are missing. Run:  npm run setup-db');
    } else if (err.code === 'ECONNREFUSED' || (err.errors && err.errors.some((e) => e.code === 'ECONNREFUSED'))) {
      console.error(
        '\nFatal: Cannot connect to MySQL database at localhost:3306.\n' +
          '-> For XAMPP: Please open the XAMPP Control Panel and click "Start" next to MySQL.\n'
      );
    } else {
      console.error('Fatal server initialization error:', err.message || err);
    }
    process.exit(1);
  }
})();

const shutdown = async () => {
  try {
    if (server) server.close();
    await db.end();
  } finally {
    process.exit(0);
  }
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));
