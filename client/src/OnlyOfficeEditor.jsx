import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import WordEditor from './WordEditor.jsx';

// ---------- trạng thái bật/tắt ONLYOFFICE (hỏi máy chủ 1 lần) ----------
let statusPromise = null;
let ooKnown = false;
const statusPromiseValue = () => ooKnown;
const ooEnabled = () => (statusPromise ||= api.get('/onlyoffice/status').then((r) => (ooKnown = !!r.enabled)).catch(() => false));

// Tải api.js của Document Server đúng 1 lần
const scripts = new Map();
const loadScript = (src) => {
  if (!scripts.has(src)) {
    scripts.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = resolve;
      s.onerror = () => { scripts.delete(src); reject(new Error('Không tải được ONLYOFFICE Document Server. Kiểm tra máy chủ tài liệu đã chạy chưa.')); };
      document.head.appendChild(s);
    }));
  }
  return scripts.get(src);
};

function OnlyOfficeEditor({ itemId, notice, watch }) {
  const holder = useRef(null);
  const [err, setErr] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let editor = null, dead = false;
    const hostId = 'oo-' + itemId;
    (async () => {
      try {
        const { config, scriptUrl } = await api.get(`/items/${itemId}/onlyoffice${watch ? '?watch=1' : ''}`);
        await loadScript(scriptUrl);
        if (dead) return;
        if (!window.DocsAPI) throw new Error('Document Server không phản hồi');
        holder.current.innerHTML = `<div id="${hostId}"></div>`;
        editor = new window.DocsAPI.DocEditor(hostId, {
          ...config,
          width: '100%', height: '100%',
          events: {
            onAppReady: () => setReady(true),
            onError: (e) => setErr(e?.data?.errorDescription || 'Lỗi trình soạn thảo'),
          },
        });
      } catch (e) { if (!dead) setErr(e.message); }
    })();
    return () => { dead = true; try { editor?.destroyEditor(); } catch { /* đã hủy */ } };
  }, [itemId, watch]); // eslint-disable-line

  return (
    <div className="word oo" style={{ display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0, minWidth: 0, width: '100%' }}>
      {notice && <div className="ribbon"><span className="notice">{notice}</span></div>}
      {err && <p className="wrap" style={{ color: '#b00020' }}>{err}</p>}
      {!ready && !err && <p className="wrap muted">Đang mở trình soạn thảo…</p>}
      <div ref={holder} className="oo-host" style={{ position: 'relative', flex: '1 1 auto', minHeight: 0 }} />
    </div>
  );
}

// Dùng ONLYOFFICE khi máy chủ đã cấu hình (ONLYOFFICE_URL...). Chưa cấu hình thì dùng trình soạn thảo cũ.
// Cố ý KHÔNG tự đổi sang trình cũ khi ONLYOFFICE lỗi: báo lỗi rõ ràng, tránh 2 trình soạn thảo ghi đè lên nhau.
export default function WordPane(props) {
  const { id, html, editable, restricted, watermark, notice, onChange } = props;
  const [mode, setMode] = useState('loading'); // loading | oo | classic
  useEffect(() => { let on = true; ooEnabled().then((v) => on && setMode(v ? 'oo' : 'classic')); return () => { on = false; }; }, []);
  if (mode === 'loading') return <p className="wrap muted">Đang tải…</p>;
  if (mode === 'classic') return <WordEditor html={html} editable={editable} restricted={restricted} watermark={watermark} notice={notice} onChange={onChange} />;
  // key theo quyền sửa: khi admin mở lại bài, trình soạn thảo được dựng lại ở chế độ sửa
  return <OnlyOfficeEditor key={`${id}-${editable}`} itemId={id} notice={notice} />;
}

// Bảng tính (Excel): dùng ONLYOFFICE (giao diện Office) khi máy chủ đã cấu hình, ngược lại dùng bảng tính tự viết (children).
// admin=true: ONLYOFFICE có thêm tab "Quản trị ô" (plugin) để cho phép nhập / khóa / ẩn ô; có nút chuyển sang bảng tính tự viết.
// user: khi admin đổi khóa/ẩn ô (rev đổi) thì ép lưu phần đang gõ rồi nạp lại bảng tính với quyền mới.
const DONE = {
  allow: (n) => `Đã cho phép nhập ${n} ô và bật bảo vệ`,
  lock: (n) => `Đã khóa ${n} ô và bật bảo vệ`,
  hide: (n) => `Đã ẩn ${n} ô khỏi nhân viên`,
  show: (n) => `Đã hiện lại ${n} ô`,
  on: () => 'Đã bật bảo vệ: chỉ ô được cho phép mới sửa được',
  off: () => 'Đã tắt bảo vệ: nhân viên sửa được mọi ô (ô ẩn vẫn ẩn)',
};
const BODY = {
  allow: (k) => ({ on: true, allow: k }), lock: (k) => ({ on: true, deny: k }),
  hide: (k) => ({ hide: k }), show: (k) => ({ show: k }), on: () => ({ on: true }), off: () => ({ on: false }),
};
const countOf = (x) => (typeof x === 'number' ? x : Object.keys(x || {}).length);

export function SheetPane({ id, editable, notice, children, admin, rev, protect, assigned }) {
  const [mode, setMode] = useState('loading'); // loading | watch (admin xem trực tiếp user) | oo | classic
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [msg, setMsg] = useState('');
  const revNow = admin ? protect && protect.rev : rev;
  const lastRev = useRef(revNow);
  useEffect(() => {
    let on = true;
    ooEnabled().then((v) => on && setMode(!v ? 'classic' : admin && assigned ? 'watch' : 'oo'));
    return () => { on = false; };
  }, []); // eslint-disable-line

  // Admin: nhận lệnh từ plugin trong ONLYOFFICE (cùng origin) rồi gọi API quyền bằng phiên của admin
  useEffect(() => {
    if (!admin) return undefined;
    const onMsg = async (e) => {
      const d = e.data;
      if (e.origin !== window.location.origin || !d || d.src !== 'oo-cell-admin' || d.item !== id || !BODY[d.action]) return;
      const keys = Array.isArray(d.keys) ? d.keys.filter((k) => typeof k === 'string').slice(0, 60000) : [];
      if (['allow', 'lock', 'hide', 'show'].includes(d.action) && !keys.length) { setMsg('Chưa chọn ô nào, hoặc không đọc được vùng chọn.'); return; }
      try { await api.put(`/items/${id}/protect`, BODY[d.action](keys)); setMsg(DONE[d.action](keys.length)); } catch (err) { setMsg(err.message); }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [admin, id]);

  // Quyền ô vừa đổi (rev mới): lưu phần đang gõ rồi tải lại để mọi người thấy ô khóa/ẩn mới. User và admin đang xem trực tiếp đều nạp lại.
  useEffect(() => {
    if (!((!admin && mode === 'oo') || (admin && mode === 'watch')) || revNow === lastRev.current) return undefined;
    lastRev.current = revNow;
    let on = true;
    (async () => {
      try { await api.post(`/items/${id}/onlyoffice/flush`); } catch { /* vẫn nạp lại */ }
      if (on) { setNonce((n) => n + 1); setMsg(admin ? 'Quyền ô vừa đổi, đã tải lại bản user đang thấy.' : 'Quản trị viên vừa đổi quyền các ô, bảng tính đã được tải lại.'); }
    })();
    return () => { on = false; };
  }, [revNow, mode, admin, id]);

  if (mode === 'loading') return <p className="wrap muted">Đang tải…</p>;
  const editor = (watch) => <OnlyOfficeEditor key={`${id}-${editable}-${nonce}-${watch ? 'w' : 'e'}`} itemId={id} watch={watch} notice={msg || notice} />;
  if (!admin || !statusPromiseValue()) return mode === 'classic' ? children : editor(false);
  const switchTo = async (m) => {
    if (m === mode || busy) return;
    setBusy(true);
    try { if (mode === 'oo' || mode === 'watch') await api.post(`/items/${id}/onlyoffice/flush`); } catch { /* vẫn chuyển, dữ liệu chưa lưu sẽ về khi ONLYOFFICE tự lưu */ }
    setMode(m); setBusy(false);
  };
  const allowedN = countOf(protect && protect.cells), hiddenN = countOf(protect && protect.hidden);
  const tab = (m, label, off) => <button className={mode === m ? '' : 'ghost'} disabled={busy || off} onClick={() => switchTo(m)}>{label}</button>;
  return (
    <div className="oo-switch-wrap" style={{ display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0, minWidth: 0, width: '100%' }}>
      <div className="ribbon" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {assigned && tab('watch', 'Xem user làm (trực tiếp)')}
        {tab('oo', 'Giao diện Office (sửa)')}
        {tab('classic', 'Khóa ô và theo dõi')}
        {busy && <span className="muted">Đang lưu…</span>}
        {protect && <span className="muted">Bảo vệ: <b>{protect.on ? 'Bật' : 'Tắt'}</b> · {allowedN} ô cho phép nhập · {hiddenN} ô ẩn</span>}
        {mode === 'watch' && <span className="muted">Đang xem đúng bản user thấy, từng ký tự và con trỏ hiện ngay khi họ gõ (ô ẩn hiển thị trống)</span>}
        {mode === 'oo' && <span className="muted">Dùng tab <b>Quản trị ô</b> trên thanh công cụ để khóa/ẩn ô đang chọn</span>}
        {mode === 'classic' && <span className="muted">Bảng này cập nhật vài giây một lần khi user gõ trong ONLYOFFICE</span>}
        {msg && <span className="notice">{msg}</span>}
      </div>
      {mode === 'classic' ? children : editor(mode === 'watch')}
    </div>
  );
}
