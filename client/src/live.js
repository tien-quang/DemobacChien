// Kết nối thời gian thực dùng chung. Tự kết nối lại; các chỉnh sửa chưa được server xác nhận (ack)
// được giữ trong hàng đợi và gửi lại sau khi kết nối lại, nên mất mạng ngắn không mất dữ liệu.
import { sessionSlot } from './api.js';
const listeners = new Set();
const subs = new Map();      // key -> message cần gửi lại sau mỗi lần kết nối
const pending = new Map();   // seq -> { msg, resolve, reject, sent }
let ws = null, state = 'closed', retry = 0, wanted = false, seq = 0, timer = null;
const emit = (m) => listeners.forEach((f) => f(m));
const setState = (s) => { state = s; emit({ t: 'conn', state: s }); };
const emitPending = () => emit({ t: 'pending', n: pending.size });
const open = () => ws && ws.readyState === 1;
const raw = (m) => { if (open()) ws.send(JSON.stringify(m)); };

function flushPending() {
  for (const p of pending.values()) if (!p.sent) { raw(p.msg); p.sent = open(); }
}

function connect() {
  wanted = true;
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  setState('connecting');
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?slot=' + sessionSlot());
  ws.onopen = () => {
    retry = 0; setState('open');
    subs.forEach((m) => raw(m));
    pending.forEach((p) => { p.sent = false; });
    flushPending();
  };
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if ((m.t === 'ack' || m.t === 'err') && m.seq && pending.has(m.seq)) {
      const p = pending.get(m.seq); pending.delete(m.seq);
      if (m.t === 'ack') p.resolve(m); else { const er = new Error(m.error); er.status = m.status; p.reject(er); }
      emitPending();
      return;
    }
    emit(m);
  };
  ws.onclose = (e) => {
    setState('closed');
    if (e.code === 4001) { wanted = false; emit({ t: 'session-expired' }); return; }
    if (wanted) { clearTimeout(timer); timer = setTimeout(connect, Math.min(10000, 800 * 2 ** retry++)); }
  };
  ws.onerror = () => {};
}

export const live = {
  connect,
  disconnect() { wanted = false; clearTimeout(timer); subs.clear(); if (ws) ws.close(); },
  on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  state: () => state,
  pendingCount: () => pending.size,
  // đăng ký 1 thông điệp "sub"/"open" được gửi lại tự động mỗi khi kết nối lại; trả về hàm hủy
  sub(msg, leaveMsg) {
    const key = JSON.stringify(msg);
    subs.set(key, msg); raw(msg);
    return () => { subs.delete(key); if (leaveMsg) raw(leaveMsg); };
  },
  send: raw,
  edit(msg) {
    return new Promise((resolve, reject) => {
      const s = ++seq;
      pending.set(s, { msg: { ...msg, t: 'edit', seq: s }, resolve, reject, sent: false });
      emitPending();
      flushPending();
    });
  },
  // chờ mọi chỉnh sửa đang chờ được server xác nhận (dùng trước khi nộp bài)
  drain(timeoutMs = 8000) {
    return new Promise((resolve) => {
      if (!pending.size) return resolve(true);
      const t = setTimeout(() => { off(); resolve(false); }, timeoutMs);
      const off = live.on((m) => { if (m.t === 'pending' && m.n === 0) { clearTimeout(t); off(); resolve(true); } });
    });
  },
};
