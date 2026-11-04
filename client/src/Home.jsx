import React, { useState, useEffect, useRef } from 'react';
import { api } from './api.js';
import { live } from './live.js';
import { go, fmt, useLive, deadlineText } from './util.jsx';

/* ================= Admin: danh sách workbook lớn ================= */
export function HomeAdmin() {
  const [books, setBooks] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const timer = useRef(null);
  const load = () => api.get('/books').then(setBooks);
  useEffect(() => {
    load(); live.connect();
    return live.sub({ t: 'sub', book: '*' }, { t: 'unsub', book: '*' });
  }, []);
  useLive((m) => { if (['status', 'presence', 'book'].includes(m.t)) { clearTimeout(timer.current); timer.current = setTimeout(load, 400); } });

  const run = async (fn) => { setBusy(true); setMsg(''); try { await fn(); } catch (e) { setMsg(e.message); } finally { setBusy(false); } };
  const upload = (files) => files?.length && run(async () => {
    const ids = [];
    for (const f of files) {
      const r = await api.upload(f);
      if (r.warnings?.length) alert(`${f.name}:\n` + r.warnings.join('\n'));
      ids.push(r.bookId);
    }
    if (ids.length === 1) go('#/book/' + ids[0]); else { setMsg(`Đã tạo ${ids.length} workbook lớn.`); load(); }
  });
  const remove = async (b) => {
    if (!confirm(`Xóa workbook lớn "${b.title}" cùng ${b.total} workbook nhỏ bên trong? Không thể khôi phục.`)) return;
    await api.del('/books/' + b.id); load();
  };

  return (
    <div className="wrap">
      <h1>Tạo workbook lớn</h1>
      <div className="tiles">
        <div className="tile excel">
          <h2>Từ file Excel / Word</h2>
          <p>Chọn một hoặc nhiều file: mỗi file .xlsx thành một workbook lớn, mỗi sheet trong đó thành một workbook nhỏ. File .docx thành một văn bản.</p>
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => fileRef.current.click()}>Tải lên .xlsx / .docx</button>
          </div>
          <input ref={fileRef} type="file" multiple hidden accept=".xlsx,.docx,.pdf,application/pdf" onChange={(e) => { upload([...e.target.files]); e.target.value = ''; }} />
        </div>
        <div className="tile word">
          <h2>Dữ liệu mẫu để demo</h2>
          <p>Tạo sẵn 2 workbook lớn: "Tính lương" và "Tính tiền nợ", mỗi cái chứa nhiều workbook nhỏ và một sheet tổng hợp.</p>
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => run(async () => { await api.post('/books/sample'); load(); })}>Tạo 2 workbook mẫu</button>
            <button disabled={busy} onClick={() => { const t = prompt('Tên workbook lớn:'); if (t) run(async () => { const r = await api.post('/books', { title: t }); go('#/book/' + r.id); }); }}>Workbook lớn trống</button>
          </div>
        </div>
      </div>
      {msg && <p className="err">{msg}</p>}
      <h1>Các workbook lớn</h1>
      {!books ? <p className="muted">Đang tải…</p> : books.length === 0 ? <p className="muted">Chưa có workbook lớn nào.</p> : books.map((b) => (
        <div className="doccard" key={b.id}>
          <div className="badge excel">{b.title.slice(0, 1).toUpperCase()}</div>
          <div className="grow">
            <a className="doctitle" href={'#/book/' + b.id}>{b.title}</a>
            <div className="muted small">
              {b.total} workbook nhỏ · {b.assigned} đã giao · {b.submitted} đã nộp · {b.approved} đã duyệt
              {b.online > 0 && <span className="live-chip"> · <i className="pulse" /> {b.online} người đang làm</span>}
              {' · '}{fmt(b.createdAt)}
            </div>
            {b.assigned > 0 && <div className="progress" title={`${b.submitted}/${b.assigned} đã nộp`}><span style={{ width: (b.submitted / b.assigned) * 100 + '%' }} /></div>}
          </div>
          <button className="primary" onClick={() => go('#/book/' + b.id)}>Mở</button>
          <button className="danger" onClick={() => remove(b)}>Xóa</button>
        </div>
      ))}
    </div>
  );
}

/* ================= User: danh sách workbook được giao ================= */
export function HomeUser() {
  const [items, setItems] = useState(null);
  const load = () => api.get('/my-items').then(setItems);
  useEffect(() => { load(); live.connect(); }, []);
  useLive((m) => { if (m.t === 'status') load(); });
  return (
    <div className="wrap">
      <h1>Workbook được giao cho bạn</h1>
      {!items ? <p className="muted">Đang tải…</p> : items.length === 0 ? <p className="muted">Hiện chưa có workbook nào được giao cho bạn.</p> : items.map((i) => (
        <div className="doccard" key={i.id}>
          <div className={'badge ' + i.type}>{i.type === 'excel' ? 'X' : i.type === 'pdf' ? 'P' : 'W'}</div>
          <div className="grow">
            <a className="doctitle" href={'#/item/' + i.id}>{i.name}</a>
            <div className="muted small">
              <span className={'tag ' + i.status}>{{ assigned: 'Mới giao', in_progress: 'Đang làm', submitted: 'Đã nộp, chờ duyệt', approved: 'Đã duyệt' }[i.status]}</span>
              {i.returnNote && <span className="late"> · Bị trả lại: {i.returnNote}</span>}
              {i.deadline && <span className={i.pastDue ? 'late' : ''}> · {deadlineText(i.deadline)}</span>}
            </div>
          </div>
          <button className="primary" onClick={() => go('#/item/' + i.id)}>{['submitted', 'approved'].includes(i.status) ? 'Xem' : 'Làm bài'}</button>
        </div>
      ))}
    </div>
  );
}
