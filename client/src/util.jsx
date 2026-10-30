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

export function Modal({ title, onClose, children }) {
  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
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
