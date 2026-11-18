// Thời gian thực qua WebSocket. Xác thực bằng cookie phiên + kiểm tra Origin (chống Cross-Site WebSocket Hijacking).
// Admin theo dõi workbook lớn: nhận từng thay đổi ô của user ngay khi gõ. User chỉ nhận dữ liệu của chính mình.
const { WebSocketServer } = require('ws');
const auth = require('./auth');
const store = require('./store');
const core = require('./core');

module.exports = function attach(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  const bookWatchers = new Map(); // bookId -> Set<ws>
  const adminAll = new Set();     // admin ở trang chủ (xem tổng quan mọi workbook lớn)
  const rooms = new Map();        // itemId -> Set<ws> (người được giao đang mở)
  const viewRooms = new Map();    // itemId -> Set<ws> (người được cấp quyền XEM bảng tổng hợp đang mở)
  const byUser = new Map();       // userId -> Set<ws>
  const add = (m, k, v) => { if (!m.has(k)) m.set(k, new Set()); m.get(k).add(v); };
  const del = (m, k, v) => { const s = m.get(k); if (s) { s.delete(v); if (!s.size) m.delete(k); } };
  const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };

  const isOnline = (itemId) => rooms.has(itemId);
  const onlineIn = (bookId) => {
    const b = store.books.get(bookId);
    return b ? b.itemIds.filter(isOnline) : [];
  };
  function toAdmins(bookId, msg) {
    const set = new Set([...(bookWatchers.get(bookId) || []), ...adminAll]);
    set.forEach((ws) => send(ws, msg));
  }
  const toUser = (userId, msg) => (byUser.get(userId) || new Set()).forEach((ws) => send(ws, msg));

  function leaveRoom(ws, itemId) {
    ws.rooms.delete(itemId);
    del(rooms, itemId, ws);
    if (!rooms.has(itemId)) {
      const it = store.items.get(itemId);
      if (it) toAdmins(it.bookId, { t: 'presence', item: itemId, online: false });
    }
  }

  // ---------- sự kiện từ lõi nghiệp vụ ----------
  core.bus.on('patch', (o) => {
    const msg = { t: 'patch', item: o.itemId, version: o.version, by: o.by };
    if (o.patch) msg.patch = o.patch;
    if (o.dims) msg.dims = o.dims;
    if (o.widths) msg.widths = o.widths;
    if (o.html !== undefined) msg.html = o.html;
    toAdmins(o.bookId, msg);
    scheduleSummaries(o.bookId);
  });
  core.bus.on('status', ({ item, prevAssigneeId }) => {
    toAdmins(item.bookId, { t: 'status', item: core.adminView(item) });
    if (item.assigneeId) {
      const u = store.user(item.assigneeId);
      toUser(item.assigneeId, { t: 'status', item: core.userView(item, u) });
    }
    if (prevAssigneeId && prevAssigneeId !== item.assigneeId) {
      toUser(prevAssigneeId, { t: 'status', item: item.id, revoked: true });
      (byUser.get(prevAssigneeId) || new Set()).forEach((ws) => { if (ws.rooms.has(item.id)) leaveRoom(ws, item.id); });
    }
  });
  core.bus.on('protect', ({ item }) => {
    toAdmins(item.bookId, { t: 'protect', item: item.id, protect: core.protectView(item, true) });
    if (item.assigneeId) toUser(item.assigneeId, { t: 'protect', item: item.id, protect: core.protectView(item) });
  });
  core.bus.on('book', ({ bookId }) => { toAdmins(bookId, { t: 'book', book: bookId }); scheduleSummaries(bookId); });

  // ---------- bảng tổng hợp cho người chỉ được xem ----------
  // Bảng tổng hợp lấy số liệu từ MỌI sheet trong workbook lớn, nên bất kỳ thay đổi nào trong workbook cũng có thể làm đổi bảng này.
  // Máy chủ tính lại (gộp các thay đổi dồn dập trong 0,4 giây) rồi đẩy GIÁ TRỊ mới cho từng người đang mở bảng; công thức không bao giờ được gửi.
  const dirtyBooks = new Map();
  function scheduleSummaries(bookId) {
    if (dirtyBooks.has(bookId)) return;
    dirtyBooks.set(bookId, setTimeout(() => { dirtyBooks.delete(bookId); pushSummaries(bookId); }, 400));
  }
  function pushSummaries(bookId) {
    const b = store.books.get(bookId);
    if (!b) return;
    for (const id of b.itemIds) {
      const set = viewRooms.get(id), it = store.items.get(id);
      if (!set || !set.size || !it) continue;
      let data = null;
      let rev = null;
      for (const ws of [...set]) {
        if (!core.perm(ws.user, it).viewer) { ws.views.delete(id); del(viewRooms, id, ws); continue; } // quyền đã bị thu hồi
        try {
          if (!data) {
            data = core.viewerData(it);
            rev = store.sha(store.canon(data));
          }
        } catch (e) { console.error('[summary]', e.message); return; }
        send(ws, { t: 'summary', item: id, data, rev });
      }
    }
  }
  core.bus.on('protect', ({ item }) => scheduleSummaries(item.bookId));
  core.bus.on('viewers', ({ item, added, removed }) => {
    added.forEach((uid) => toUser(uid, { t: 'status', item: core.userView(item, store.user(uid)) })); // trang chủ của user nạp lại danh sách
    removed.forEach((uid) => {
      toUser(uid, { t: 'status', item: item.id, revoked: true });
      (byUser.get(uid) || new Set()).forEach((ws) => { ws.views.delete(item.id); del(viewRooms, item.id, ws); });
    });
    toAdmins(item.bookId, { t: 'status', item: core.adminView(item) });
  });
  core.bus.on('consolidation', ({ bookId, c }) => toAdmins(bookId, { t: 'consolidation', book: bookId, n: c.n, id: c.id }));
  core.bus.on('job', ({ bookId, status, result, error }) => toAdmins(bookId, { t: 'job', book: bookId, status, result, error }));

  // ---------- kết nối ----------
  server.on('upgrade', (req, socket, head) => {
    const deny = (code, text) => { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
    if (!String(req.url).startsWith('/ws')) return deny(404, 'Not Found');
    try { if (new URL(req.headers.origin || '').host !== req.headers.host) return deny(403, 'Forbidden'); } catch { return deny(403, 'Forbidden'); }
    let slot = null;
    try { slot = new URL(req.url, 'http://localhost').searchParams.get('slot'); } catch { /* địa chỉ lạ: coi như không có slot */ }
    const session = auth.getSession(auth.sidFrom(req, slot));
    const user = session && store.user(session.userId);
    if (!user) return deny(401, 'Unauthorized');
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.user = user; ws.session = session; ws.alive = true; ws.rooms = new Set(); ws.watching = new Set(); ws.views = new Set();
      ws.ip = req.socket.remoteAddress; ws.tokens = 80; ws.tick = Date.now();
      add(byUser, user.id, ws);
      wss.emit('connection', ws);
    });
  });

  wss.on('connection', (ws) => {
    send(ws, { t: 'hello', role: ws.user.role });
    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', (raw) => {
      if (!auth.stillValid(ws.session)) return ws.close(4001, 'session');
      ws.session.last = Date.now(); // đang thao tác thì không bị coi là rảnh
      // giới hạn tốc độ: tối đa ~60 tin/giây, cho phép bùng nổ 80
      const now = Date.now();
      ws.tokens = Math.min(80, ws.tokens + ((now - ws.tick) / 1000) * 60); ws.tick = now;
      if (--ws.tokens < 0) return send(ws, { t: 'err', error: 'Gửi quá nhanh' });
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (!m || typeof m !== 'object') return;
      try { handle(ws, m); } catch (e) {
        if (e instanceof core.HttpError) send(ws, { t: 'err', seq: m.seq, error: e.message, status: e.status });
        else { console.error(e); send(ws, { t: 'err', seq: m.seq, error: 'Lỗi máy chủ' }); }
      }
    });
    ws.on('close', () => {
      del(byUser, ws.user.id, ws);
      adminAll.delete(ws);
      ws.watching.forEach((b) => del(bookWatchers, b, ws));
      [...ws.rooms].forEach((i) => leaveRoom(ws, i));
      ws.views.forEach((i) => del(viewRooms, i, ws));
    });
  });

  function handle(ws, m) {
    const user = ws.user;
    switch (m.t) {
      case 'sub': { // admin theo dõi 1 workbook lớn, hoặc '*' = tất cả (trang chủ)
        if (!core.isAdmin(user)) throw core.E(403, 'Không đủ quyền');
        if (m.book === '*') { adminAll.add(ws); return send(ws, { t: 'presenceAll', online: [...rooms.keys()] }); }
        if (!store.books.has(m.book)) throw core.E(404, 'Không tìm thấy');
        add(bookWatchers, m.book, ws); ws.watching.add(m.book);
        return send(ws, { t: 'presenceAll', online: onlineIn(m.book) });
      }
      case 'open': { // người được giao mở workbook nhỏ của mình (để admin thấy trạng thái trực tuyến)
        const it = core.getReadable(user, String(m.item), ws.ip);
        if (!core.isAdmin(user) && it.assigneeId === user.id) {
          const book = store.books.get(it.bookId);
          if (book) {
            for (const summary of store.bookItems(book)) {
              if (summary.type !== 'excel' || summary.id === it.id) continue;
              if (!(summary.viewerIds || []).includes(user.id)) continue;
              ws.views.add(summary.id);
              add(viewRooms, summary.id, ws);
              const data = core.viewerData(summary);
              send(ws, { t: 'summary', item: summary.id, data, rev: store.sha(store.canon(data)) });
            }
          }
        }
        if (core.isAdmin(user) || it.assigneeId !== user.id) {
          if (core.perm(user, it).viewer) { // người chỉ xem bảng tổng hợp: đăng ký nhận giá trị mới; gửi luôn bản mới nhất (bù thay đổi đã lỡ khi mất kết nối)
            ws.views.add(it.id); add(viewRooms, it.id, ws);
            const data = core.viewerData(it);
            send(ws, { t: 'summary', item: it.id, data, rev: store.sha(store.canon(data)) });
          }
          return send(ws, { t: 'opened', item: it.id });
        }
        if (!ws.rooms.has(it.id)) {
          ws.rooms.add(it.id);
          const first = !rooms.has(it.id);
          add(rooms, it.id, ws);
          if (first) toAdmins(it.bookId, { t: 'presence', item: it.id, online: true, name: user.name });
        }
        core.markOpened(user, it);
        return send(ws, { t: 'opened', item: it.id });
      }
      case 'edit': {
        const out = core.applyEdit(user, String(m.item), m, ws.ip);
        return send(ws, { t: 'ack', seq: m.seq, version: out.version });
      }
      case 'sel': { // con trỏ + nội dung đang gõ dở của user, chỉ chuyển cho admin
        const it = core.getReadable(user, String(m.item), ws.ip);
        if (core.isAdmin(user) || it.assigneeId !== user.id) return;
        if (!Number.isInteger(m.r) || !Number.isInteger(m.c) || m.r < 0 || m.c < 0 || m.r > 5000 || m.c > 200) return;
        const typing = typeof m.typing === 'string' ? m.typing.slice(0, 200) : null;
        return toAdmins(it.bookId, { t: 'sel', item: it.id, r: m.r, c: m.c, typing, by: user.name });
      }
      case 'unsub': {
        if (m.book === '*') adminAll.delete(ws); else { del(bookWatchers, m.book, ws); ws.watching.delete(m.book); }
        return undefined;
      }
      case 'leave':
        if (ws.rooms.has(String(m.item))) leaveRoom(ws, String(m.item));
        if (ws.views.has(String(m.item))) { ws.views.delete(String(m.item)); del(viewRooms, String(m.item), ws); }
        return undefined;
      case 'ping': return send(ws, { t: 'pong' });
      default: return undefined;
    }
  }

  // nhịp tim + loại bỏ kết nối chết / phiên hết hạn
  setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!auth.stillValid(ws.session)) return ws.close(4001, 'session');
      if (!ws.alive) return ws.terminate();
      ws.alive = false; ws.ping();
    });
  }, 30000).unref();

  return {
    isOnline, onlineIn,
    closeSession: (h) => wss.clients.forEach((ws) => { if (ws.session.h === h) ws.close(4001, 'session'); }),
    closeUser: (userId, exceptH) => (byUser.get(userId) || new Set()).forEach((ws) => { if (ws.session.h !== exceptH) ws.close(4001, 'session'); }),
  };
};
