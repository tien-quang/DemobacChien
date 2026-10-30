// Xác thực: mật khẩu scrypt, phiên dạng cookie HttpOnly (token ngẫu nhiên, có thể thu hồi), 2FA TOTP, giới hạn tốc độ.
const crypto = require('crypto');
const store = require('./store');

const IDLE_MS = (Number(process.env.IDLE_MINUTES) || 30) * 60 * 1000;
const ABS_MS = (Number(process.env.SESSION_HOURS) || 8) * 3600 * 1000;

// ---------- mật khẩu ----------
const verifyPw = (pw, stored) => {
  const [salt, h] = stored.split(':');
  const a = Buffer.from(h, 'hex');
  const b = crypto.scryptSync(pw, salt, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const pwPolicy = (pw) => {
  if (typeof pw !== 'string' || pw.length < 8) return 'Mật khẩu phải từ 8 ký tự';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Mật khẩu phải gồm cả chữ và số';
  if (['admin123', 'user1234', 'password1', '12345678a'].includes(pw.toLowerCase())) return 'Mật khẩu quá dễ đoán';
  return null;
};

// ---------- phiên (chỉ lưu BĂM của token, token gốc chỉ nằm trong cookie của trình duyệt) ----------
const sessions = new Map();
const hashSid = (sid) => crypto.createHash('sha256').update(sid).digest('hex');
function createSession(user, ip, ua) {
  const sid = crypto.randomBytes(32).toString('base64url');
  const h = hashSid(sid);
  sessions.set(h, { h, id: h.slice(0, 10), userId: user.id, created: Date.now(), last: Date.now(), ip, ua: String(ua || '').slice(0, 120) });
  return sid;
}
function getSession(sid) {
  if (!sid || typeof sid !== 'string' || sid.length > 100) return null;
  const s = sessions.get(hashSid(sid));
  if (!s) return null;
  const now = Date.now();
  if (now - s.created > ABS_MS || now - s.last > IDLE_MS) { sessions.delete(s.h); return null; }
  s.last = now;
  return s;
}
const stillValid = (s) => {
  const x = sessions.get(s.h); const now = Date.now();
  return !!x && now - x.created <= ABS_MS && now - x.last <= IDLE_MS;
};
const revokeById = (id) => { for (const [h, s] of sessions) if (s.id === id) { sessions.delete(h); return s; } return null; };
const revokeUser = (userId, exceptH) => { for (const [h, s] of sessions) if (s.userId === userId && h !== exceptH) sessions.delete(h); };
const listSessions = (userId) => [...sessions.values()].filter((s) => !userId || s.userId === userId);
setInterval(() => { const now = Date.now(); for (const [h, s] of sessions) if (now - s.created > ABS_MS || now - s.last > IDLE_MS) sessions.delete(h); }, 60000).unref();

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i <= 0) return;
    const val = p.slice(i + 1).trim();
    // cookie của trang khác / cookie hỏng (ví dụ %E0%A4%A) không được làm sập máy chủ
    try { out[p.slice(0, i).trim()] = decodeURIComponent(val); } catch { out[p.slice(0, i).trim()] = val; }
  });
  return out;
}

// Mỗi tab trình duyệt có 1 "slot" riêng (client gửi header X-Session-Slot, WebSocket gửi ?slot=), cookie phiên tên sid-<slot>.
// Nhờ vậy admin và user đăng nhập CÙNG LÚC trên cùng 1 trình duyệt mà không ghi đè phiên của nhau.
// Slot sai định dạng hoặc không có (công cụ dòng lệnh, bản cũ) dùng cookie "sid" như trước.
const sessionCookieName = (slot) => (/^[A-Za-z0-9_-]{16,64}$/.test(String(slot || '')) ? `sid-${slot}` : 'sid');
const sidFrom = (req, slot) => parseCookies(req.headers.cookie)[sessionCookieName(slot)];
const cookieFlags = (maxAge) =>
  `Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}` + (process.env.COOKIE_SECURE === '1' ? '; Secure' : '');
const setCookie = (res, sid, slot) => res.append('Set-Cookie', `${sessionCookieName(slot)}=${encodeURIComponent(sid)}; ${cookieFlags(ABS_MS / 1000)}`);
const clearCookie = (res, slot) => res.append('Set-Cookie', `${sessionCookieName(slot)}=; ${cookieFlags(0)}`);

// Phiên còn hiệu lực không? (KHÔNG làm mới đồng hồ "rảnh" của phiên đó)
const isLive = (sid) => {
  const s = typeof sid === 'string' && sid.length <= 100 ? sessions.get(hashSid(sid)) : null;
  const now = Date.now();
  return !!s && now - s.created <= ABS_MS && now - s.last <= IDLE_MS;
};
// Dọn cookie của các tab cũ (phiên đã hết hạn/bị thu hồi) để header yêu cầu không phình to dần
function sweepStaleCookies(req, res, slot) {
  const keep = sessionCookieName(slot);
  for (const [name, val] of Object.entries(parseCookies(req.headers.cookie))) {
    if (name.startsWith('sid-') && name !== keep && !isLive(val)) res.append('Set-Cookie', `${name}=; ${cookieFlags(0)}`);
  }
}

// ---------- TOTP (RFC 6238), không cần thư viện ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32enc = (buf) => {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
};
const b32dec = (s) => {
  let bits = 0, val = 0; const out = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) { const i = B32.indexOf(ch); if (i < 0) continue; val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
};
const hotp = (secret, counter) => {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', b32dec(secret)).update(buf).digest();
  const o = h[19] & 15;
  const code = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 1e6).padStart(6, '0');
};
const newTotpSecret = () => b32enc(crypto.randomBytes(20));
function totpCheck(totp, code) {
  if (!totp || !totp.secret || !/^\d{6}$/.test(String(code || ''))) return false;
  const step = Math.floor(Date.now() / 30000);
  for (const d of [-1, 0, 1]) {
    const s = step + d;
    const ok = crypto.timingSafeEqual(Buffer.from(hotp(totp.secret, s)), Buffer.from(String(code)));
    if (ok && s > (totp.last || 0)) { totp.last = s; return true; } // mỗi mã chỉ dùng 1 lần
  }
  return false;
}
const totpUri = (user, secret) => `otpauth://totp/OfficeNoiBo:${encodeURIComponent(user.username)}?secret=${secret}&issuer=OfficeNoiBo`;

// ---------- giới hạn tốc độ (cửa sổ cố định) ----------
const buckets = new Map();
function hit(key, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.n++;
  return b.n <= limit;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 60000).unref();

// khóa đăng nhập sai
const fails = new Map();
const lockedFor = (key) => { const f = fails.get(key); return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0; };
function failLogin(key, max, lockMs) {
  const f = fails.get(key) || { n: 0, until: 0 };
  f.n++;
  if (f.n >= max) { f.until = Date.now() + lockMs; f.n = 0; }
  fails.set(key, f);
}
const clearFails = (key) => fails.delete(key);

module.exports = {
  verifyPw, pwPolicy, createSession, getSession, stillValid, revokeById, revokeUser, listSessions, parseCookies,
  setCookie, clearCookie, sessionCookieName, sidFrom, sweepStaleCookies, newTotpSecret, totpCheck, totpUri, hit, lockedFor, failLogin, clearFails, IDLE_MS,
};