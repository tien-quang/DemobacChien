import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import WordEditor from './WordEditor.jsx';

// ---------- trạng thái bật/tắt ONLYOFFICE (hỏi máy chủ 1 lần) ----------
let statusPromise = null;
const ooEnabled = () => (statusPromise ||= api.get('/onlyoffice/status').then((r) => !!r.enabled).catch(() => false));

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

function OnlyOfficeEditor({ itemId, notice }) {
  const holder = useRef(null);
  const [err, setErr] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let editor = null, dead = false;
    const hostId = 'oo-' + itemId;
    (async () => {
      try {
        const { config, scriptUrl } = await api.get(`/items/${itemId}/onlyoffice`);
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
  }, [itemId]); // eslint-disable-line

  return (
    <div className="word oo">
      {notice && <div className="ribbon"><span className="notice">{notice}</span></div>}
      {err && <p className="wrap" style={{ color: '#b00020' }}>{err}</p>}
      {!ready && !err && <p className="wrap muted">Đang mở trình soạn thảo…</p>}
      <div ref={holder} className="oo-host" />
    </div>
  );
}

// Hook: 'loading' | true | false (ONLYOFFICE đã cấu hình trên máy chủ chưa)
export function useOnlyOffice() {
  const [v, setV] = useState('loading');
  useEffect(() => { let on = true; ooEnabled().then((x) => on && setV(x)); return () => { on = false; }; }, []);
  return v;
}

// Dùng ONLYOFFICE cho cả Word và Excel khi máy chủ đã cấu hình (ONLYOFFICE_URL...). Chưa cấu hình thì hiện `classic` (giao diện cũ).
// Cố ý KHÔNG tự đổi sang giao diện cũ khi ONLYOFFICE lỗi: báo lỗi rõ ràng, tránh 2 trình soạn thảo ghi đè lên nhau.
// `force` = true buộc dùng giao diện cũ (admin cần bảng cũ để khóa ô).
export function OfficePane({ id, editable, notice, classic, force }) {
  const oo = useOnlyOffice();
  if (oo === 'loading') return <p className="wrap muted">Đang tải…</p>;
  if (!oo || force) return classic;
  // key theo quyền sửa: khi admin mở lại bài, trình soạn thảo được dựng lại ở chế độ sửa
  return <OnlyOfficeEditor key={`${id}-${editable}`} itemId={id} notice={notice} />;
}

// Giữ tên cũ cho Word
export default function WordPane(props) {
  const { id, html, editable, restricted, watermark, notice, onChange } = props;
  return <OfficePane id={id} editable={editable} notice={notice} classic={<WordEditor html={html} editable={editable} restricted={restricted} watermark={watermark} notice={notice} onChange={onChange} />} />;
}
