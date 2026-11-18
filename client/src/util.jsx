import { useEffect, useRef, useState, useCallback } from 'react';
import { live } from './live.js';

export const STATUS = { unassigned: 'Chưa giao', assigned: 'Đã giao', in_progress: 'Đang làm', submitted: 'Đã nộp', approved: 'Đã duyệt' };
export const fmt = (d) => (d ? new Date(d).toLocaleString('vi-VN') : '—');
export const go = (h) => { location.hash = h; };

// nhận mọi thông điệp thời gian thực (luôn dùng bản handler mới nhất)
export function useLive(handler) {
  const ref = useRef(handler); ref.current = handler;
  useEffect(() => live.on((m) => ref.current(m)), []);
}

export function useToast() {
  const [msg, setMsg] = useState('');
  const t = useRef(null);
  const show = useCallback((m) => { setMsg(m); clearTimeout(t.current); t.current = setTimeout(() => setMsg(''), 4000); }, []);
  return [msg, show];
}

export const deadlineText = (iso) => {
  if (!iso) return '';
  const d = new Date(iso), left = d - Date.now();
  const when = d.toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  if (left < 0) return `Quá hạn (${when})`;
  const h = Math.floor(left / 3600000);
  return `Hạn nộp ${when}` + (h < 48 ? ` (còn ${h < 1 ? Math.max(1, Math.round(left / 60000)) + ' phút' : h + ' giờ'})` : '');
};

// Danh sách ô user đã đổi so với lúc giao bài (dữ liệu từ /changes): ô, giá trị trước, giá trị sau
export function ChangeList({ ch, max = 40 }) {
  const [all, setAll] = useState(false);
  if (!ch) return null;
  if (ch.base === null) return <p className="small muted" style={{ margin: '2px 0' }}>{ch.note}</p>;
  if (!ch.total) return <p className="small muted" style={{ margin: '2px 0' }}>Không có ô nào bị đổi so với {ch.base}{ch.formatOnly ? ` (${ch.formatOnly} ô chỉ đổi định dạng)` : ''}.</p>;
  if (ch.word) return <p className="small" style={{ margin: '2px 0' }}><b>Nội dung văn bản đã được chỉnh sửa</b> so với {ch.base}.</p>;
  const rows = all ? ch.list : ch.list.slice(0, max);
  return (
    <div className="changes">
      <div className="small"><b>{ch.total} ô đã đổi</b> so với {ch.base}{ch.formatOnly ? ` · ${ch.formatOnly} ô chỉ đổi định dạng` : ''}</div>
      <table className="list changes-tbl">
        <thead><tr><th style={{ width: 70 }}>Ô</th><th>Trước</th><th>Sau</th></tr></thead>
        <tbody>
          {rows.map((x) => (
            <tr key={x.cell}>
              <td><code>{x.cell}</code></td>
              <td>{x.from === '' ? <i className="muted">(trống)</i> : x.from}</td>
              <td><b>{x.to === '' ? <i>(đã xóa)</i> : x.to}</b></td>
            </tr>
          ))}
        </tbody>
      </table>
      {ch.list.length > max && !all && <button onClick={() => setAll(true)}>Xem hết {ch.list.length} ô</button>}
      {ch.truncated && <p className="small muted">Chỉ hiển thị {ch.list.length}/{ch.total} ô đầu tiên.</p>}
    </div>
  );
}

export function Modal({ title, onClose, children, wide }) {
  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className="modal" style={wide ? { width: 860 } : undefined} onMouseDown={(e) => e.stopPropagation()}>
        <div className="row"><h2 className="grow">{title}</h2><button onClick={onClose}>Đóng</button></div>
        {children}
      </div>
    </div>
  );
}

export function ConnDot() {
  const [s, setS] = useState(live.state());
  useLive((m) => { if (m.t === 'conn') setS(m.state); });
  const label = { open: 'Trực tuyến', connecting: 'Đang kết nối…', closed: 'Mất kết nối' }[s];
  return <span className={'conn ' + s} title="Kết nối thời gian thực">{label}</span>;
}
