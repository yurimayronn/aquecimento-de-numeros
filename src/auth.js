const crypto = require('crypto');

const COOKIE = 'wa_admin';
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

// tokens de sessão válidos em memória: token -> expiraEm
const tokens = new Map();

function parseCookies(req) {
  const header = (req && req.headers && req.headers.cookie) || '';
  const out = {};
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}

function isValid(token) {
  if (!token) return false;
  const exp = tokens.get(token);
  if (!exp) return false;
  if (Date.now() > exp) {
    tokens.delete(token);
    return false;
  }
  return true;
}

function isAuthed(req) {
  return isValid(parseCookies(req)[COOKIE]);
}

function issueToken() {
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, Date.now() + TOKEN_TTL_MS);
  return token;
}

function revoke(req) {
  const t = parseCookies(req)[COOKIE];
  if (t) tokens.delete(t);
}

// comparação de senha resistente a timing
function passwordMatches(input, expected) {
  const a = Buffer.from(String(input || ''));
  const b = Buffer.from(String(expected || ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const cookieHeader = (token) =>
  `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${TOKEN_TTL_MS / 1000}`;
const clearCookieHeader = () => `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;

module.exports = {
  COOKIE,
  parseCookies,
  isValid,
  isAuthed,
  issueToken,
  revoke,
  passwordMatches,
  cookieHeader,
  clearCookieHeader,
};
