import React, { useState, useEffect } from 'react';
import { api } from './api.js';
import { fmt, useLive, Modal } from './util.jsx';

const MODE = { submitted: 'Bài đã nộp và đã duyệt', approved: 'Chỉ bài đã duyệt', latest: 'Gồm cả bản nháp' };
const size = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
const SRC = { submitted: 'bản đã nộp', approved: 'bản đã duyệt', admin: 'bản của admin', draft: 'bản nháp' };

// Tab "Tổng hợp": các phiên bản workbook lớn do máy chủ dựng từ bài đã nộp (bản chụp bất biến, đã xác minh chữ ký)
export default function Consolidation({ bookId, flash }) {
  const [data, setData] = useState(null);
  const [mode, setMode] = useState('submitted');
  const [job, setJob] = useState('');
  const [modal, setModal] = useState(null);
  const load = () => api.get(`/books/${bookId}/consolidations`).then(setData).catch((e) => flash(e.message));
  useEffect(() => { load(); }, [bookId]); // eslint-disable-line

  useLive((m) => {
    if (m.book !== bookId) return;
    if (m.t === 'consolidation') { load(); flash(`Đã có bản tổng hợp mới v${m.n}.`); }
    else if (m.t === 'job') {
      setJob({ queued: 'Đã xếp hàng, đang chờ…', running: 'Đang tổng hợp…', retry: 'Lỗi, đang thử lại…', failed: 'Tổng hợp thất bại: ' + (m.error || ''), done: '' }[m.status] || '');
      if (m.status === 'done') { if (m.result?.skipped) flash(`Không có thay đổi so với bản v${m.result.n}, không tạo bản mới.`); load(); }
    }
  });

  const run = async () => { try { await api.post(`/books/${bookId}/consolidate`, { mode }); } catch (e) { flash(e.message); } };
  const setAuto = async (on) => { try { await api.put(`/books/${bookId}/auto`, { on }); load(); } catch (e) { flash(e.message); } };
  const download = async (c, kind = 'xlsx') => {
    try {
      const l = await api.post(`/consolidations/${c.id}/link`, { kind }); // liên kết ký sẵn, hết hạn sau 5 phút
      await api.download(l.path, l.filename);
    } catch (e) { flash(e.message); }
  };
  const detail = (c) => setModal({
    title: `Chi tiết bản v${c.n}`,
    body: (
      <table className="list">
        <thead><tr><th>Workbook nhỏ</th><th>Người làm</th><th>Trong file?</th><th>Nguồn / ghi chú</th></tr></thead>
        <tbody>
          {c.items.map((r, i) => (
            <tr key={i}>
              <td>{r.name}{r.changed && <span className="tag in_progress"> đổi</span>}</td>
              <td>{r.assignee || (r.type === 'excel' ? 'Admin' : '—')}</td>
              <td>{r.included ? <b className="ok-text">Có</b> : <b className="late">Không</b>}</td>
              <td className="small">{r.note || SRC[r.source] || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    ),
  });
  const compare = async (c, prev) => {
    try {
      const d = await api.get(`/books/${bookId}/consolidations/diff?a=${prev.id}&b=${c.id}`);
      setModal({
        title: `So sánh v${d.a} → v${d.b}`,
        body: d.changes.length === 0 ? <p className="muted">Hai bản giống nhau.</p> : (
          <>
            {d.changes.map((x, i) => (
              <div key={i} className="diffrow">
                <b>{x.name}</b> <span className="tag in_progress">{x.change}</span>
                {x.cellsChanged != null && <span className="small muted"> · {x.cellsChanged} ô khác nhau</span>}
                {x.examples?.map((e, j) => <div className="small" key={j}><code>{e.cell}</code>: {String(e.from) || '(trống)'} → <b>{String(e.to) || '(trống)'}</b></div>)}
              </div>
            ))}
          </>
        ),
      });
    } catch (e) { flash(e.message); }
  };

  if (!data) return <div className="overview muted">Đang tải…</div>;
  return (
    <div className="overview">
      <p className="muted" style={{ marginTop: 0 }}>
        Máy chủ gom các workbook nhỏ <b>đã nộp hoặc đã duyệt</b> (lấy từ bản chụp bất biến, đã xác minh chữ ký) thành một file Excel của workbook lớn (văn bản Word thành một file .docx đi kèm),
        tính lại mọi công thức tổng hợp, và lưu thành các phiên bản không thể sửa. Việc chạy ở luồng riêng nên không làm chậm người đang làm bài.
      </p>
      <div className="row" style={{ margin: '12px 0' }}>
        <select value={mode} onChange={(e) => setMode(e.target.value)}>
          {Object.entries(MODE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button className="primary" onClick={run}>Tổng hợp ngay</button>
        <label className="protect-toggle"><input type="checkbox" checked={data.auto} onChange={(e) => setAuto(e.target.checked)} /> Tự tổng hợp mỗi khi có người nộp bài</label>
        {job && <span className="job-chip">{job}</span>}
      </div>
      {data.items.length === 0 ? <p className="muted">Chưa có bản tổng hợp nào. Khi có người nộp bài (hoặc bấm "Tổng hợp ngay") bản v1 sẽ xuất hiện ở đây.</p> : (
        <table className="list">
          <thead><tr><th>Bản</th><th>Tạo lúc</th><th>Bởi</th><th>Chế độ</th><th>Đưa vào</th><th>Thay đổi</th><th>Dung lượng</th><th>Mã băm</th><th /></tr></thead>
          <tbody>
            {data.items.map((c, i) => (
              <tr key={c.id}>
                <td><b>v{c.n}</b></td><td className="small">{fmt(c.at)}</td><td>{c.by}</td><td className="small">{MODE[c.mode]}</td>
                <td>{c.included}/{c.total}</td><td>{c.changed ? `${c.changed} mục` : '—'}</td><td className="small">{size(c.size)}</td>
                <td><code>{c.sha.slice(0, 10)}</code></td>
                <td className="actions">
                  <button className="primary" onClick={() => download(c)}>Tải .xlsx</button>
                  {c.docx && <button onClick={() => download(c, 'docx')}>Tải .docx ({c.docx.count})</button>}
                  <button onClick={() => detail(c)}>Chi tiết</button>
                  {data.items[i + 1] && <button onClick={() => compare(c, data.items[i + 1])}>So với v{data.items[i + 1].n}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small" style={{ marginTop: 10 }}>
        Tải xuống dùng liên kết ký sẵn, hết hạn sau 5 phút và gắn với phiên của bạn. Mỗi lần tải đều được ghi vào nhật ký.
      </p>
      {modal && <Modal title={modal.title} onClose={() => setModal(null)}>{modal.body}</Modal>}
    </div>
  );
}
