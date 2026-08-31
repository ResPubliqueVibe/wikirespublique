import crypto from 'node:crypto';
import { Users, Sessions } from './db.js';

const SCRYPT_KEYLEN = 64;
const COOKIE_NAME = 'rp_session';
const SESSION_DAYS = 30;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  let salt, expected;
  try {
    salt = Buffer.from(parts[1], 'hex');
    expected = Buffer.from(parts[2], 'hex');
  } catch {
    return false;
  }
  if (!salt.length || !expected.length) return false;
  let actual;
  try {
    actual = crypto.scryptSync(password, salt, expected.length);
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function startSession(res, userId) {
  const id = crypto.randomBytes(32).toString('hex');
  const csrf = crypto.randomBytes(32).toString('hex');
  Sessions.create(id, userId, csrf, SESSION_DAYS);
  res.cookie(COOKIE_NAME, id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.SECURE_COOKIES === '1',
    path: '/',
    maxAge: SESSION_DAYS * 86400000,
  });
  return { id, csrf };
}

export function endSession(req, res) {
  const id = req.cookies?.[COOKIE_NAME];
  if (id) Sessions.destroy(id);
  res.clearCookie(COOKIE_NAME, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.SECURE_COOKIES === '1',
  });
}

/** Populates req.user and req.csrfToken for every request. */
export function sessionMiddleware(req, res, next) {
  req.user = null;
  req.csrfToken = null;
  const id = req.cookies?.[COOKIE_NAME];
  if (id) {
    const sess = Sessions.get(id);
    if (sess) {
      const user = Users.byId(sess.user_id);
      // Снятое подтверждение обрывает и уже открытые сессии.
      if (user && user.approved) {
        req.user = user;
        req.csrfToken = sess.csrf_token;
      }
    }
  }
  next();
}

export function requireLogin(req, res, next) {
  if (!req.user) {
    const back = encodeURIComponent(req.originalUrl);
    return res.redirect(`/login?next=${back}`);
  }
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) {
    const err = new Error('Требуются права администратора');
    err.status = 403;
    return next(err);
  }
  next();
}

/** CSRF guard for POST routes. */
export function checkCsrf(req, res, next) {
  const sent = req.body?._csrf;
  if (!req.csrfToken || !safeEqual(sent, req.csrfToken)) {
    const err = new Error('Неверный или отсутствующий CSRF-токен. Обновите страницу и попробуйте снова.');
    err.status = 403;
    return next(err);
  }
  next();
}

export { COOKIE_NAME };
