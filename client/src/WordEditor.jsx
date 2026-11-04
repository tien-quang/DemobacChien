import React, { useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { Watermark } from './Spreadsheet.jsx';

const clean = (html) => DOMPurify.sanitize(html || '', { USE_PROFILES: { html: true } });

export default function WordEditor({ html, editable, restricted, watermark, notice, onChange }) {
  const ref = useRef(null);
  const timer = useRef(null);
  const [words, setWords] = useState(0);

  const countWords = () => {
    const t = (ref.current?.innerText || '').trim();
    setWords(t ? t.split(/\s+/).length : 0);
  };

  // Nội dung luôn qua DOMPurify trước khi hiển thị (chống XSS giữa các tài khoản)
  useEffect(() => {
    ref.current.innerHTML = clean(html);
    countWords();
  }, [editable, html && !editable ? html : null]); // eslint-disable-line

  const emit = () => {
    countWords();
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onChange(clean(ref.current.innerHTML)), 400);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  const cmd = (name, arg) => {
    if (!editable) return;
    ref.current.focus();
    document.execCommand(name, false, arg);
    emit();
  };
  const promptLink = () => {
    const url = window.prompt('Địa chỉ liên kết (https://...)');
    if (url) cmd('createLink', url);
  };
  const insertImage = () => {
    if (!editable) return;
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file || file.size > 2 * 1024 * 1024) return;
      const reader = new FileReader();
      reader.onload = () => cmd('insertImage', reader.result);
      reader.readAsDataURL(file);
    };
    input.click();
  };
  const block = (e) => { if (restricted) e.preventDefault(); };
  const onPaste = (e) => {
    e.preventDefault();
    if (!editable) return;
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
    emit();
  };
  const insertTable = () => {
    const rows = Math.max(1, Math.min(20, Number(window.prompt('Số dòng', '3')) || 3));
    const cols = Math.max(1, Math.min(12, Number(window.prompt('Số cột', '3')) || 3));
    const cell = '<td style="border:1px solid #999;padding:6px;min-width:60px">&nbsp;</td>';
    const row = `<tr>${cell.repeat(cols)}</tr>`;
    cmd('insertHTML', `<table style="border-collapse:collapse;width:100%"><tbody>${row.repeat(rows)}</tbody></table><p><br></p>`);
  };
  const insertChecklist = () => cmd('insertHTML', '<div>☐ Việc cần làm</div>');
  const insertPageBreak = () => cmd('insertHTML', '<div style="break-before:page;height:1px"></div>');
  const findText = () => {
    const text = window.prompt('Tìm nội dung');
    if (text) window.find(text);
  };
  const dis = !editable;
  const keep = (e) => { if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') e.preventDefault(); };

  return (
    <div className="word">
      <div className="office-window word-window">
        <div className="office-brand"><b>Word</b><span>·</span><strong>Document</strong></div>
        <div className="office-quick"><button title="Lưu">💾</button><button>↶</button><button>↷</button></div>
        <div className="office-window-actions"><button>−</button><button>□</button><button>×</button></div>
      </div>
      <div className="office-tabs word-tabs">
        <button className="active">Home</button><button>Insert</button><button>Page Layout</button><button>References</button><button>Review</button><button>View</button><span className="office-search">⌕ <span>Tell me what you want to do</span></span>
      </div>
      <div className="ribbon" onMouseDown={keep}>
        <span className="ribbon-group-label">Clipboard</span>
        <button disabled={dis} onClick={() => cmd('undo')}>Hoàn tác</button>
        <button disabled={dis} onClick={() => cmd('redo')}>Làm lại</button>
        <span className="sep" />
        <select disabled={dis} defaultValue="P" onChange={(e) => cmd('formatBlock', e.target.value)} title="Kiểu đoạn">
          <option value="P">Văn bản thường</option>
          <option value="H1">Tiêu đề 1</option>
          <option value="H2">Tiêu đề 2</option>
          <option value="H3">Tiêu đề 3</option>
        </select>
        <select disabled={dis} defaultValue="" onChange={(e) => e.target.value && cmd('fontName', e.target.value)} title="Phông chữ">
          <option value="">Phông chữ</option><option>Arial</option><option>Calibri</option><option>Georgia</option><option>Tahoma</option><option>Times New Roman</option><option>Verdana</option>
        </select>
        <select disabled={dis} defaultValue="" onChange={(e) => e.target.value && cmd('fontSize', e.target.value)} title="Cỡ chữ">
          <option value="">Cỡ chữ</option><option value="1">8</option><option value="2">10</option><option value="3">12</option><option value="4">14</option><option value="5">18</option><option value="6">24</option><option value="7">32</option>
        </select>
        <button disabled={dis} onClick={() => cmd('bold')}><b>B</b></button>
        <button disabled={dis} onClick={() => cmd('italic')}><i>I</i></button>
        <button disabled={dis} onClick={() => cmd('underline')}><u>U</u></button>
        <button disabled={dis} onClick={() => cmd('strikeThrough')}><s>S</s></button>
        <label className="color" title="Màu chữ">A
          <input type="color" disabled={dis} defaultValue="#000000" onChange={(e) => cmd('foreColor', e.target.value)} />
        </label>
        <label className="color" title="Tô nền chữ">Nền
          <input type="color" disabled={dis} defaultValue="#ffff00" onChange={(e) => cmd('hiliteColor', e.target.value)} />
        </label>
        <span className="sep" />
        <button disabled={dis} onClick={() => cmd('justifyLeft')}>Trái</button>
        <button disabled={dis} onClick={() => cmd('justifyCenter')}>Giữa</button>
        <button disabled={dis} onClick={() => cmd('justifyRight')}>Phải</button>
        <button disabled={dis} onClick={() => cmd('justifyFull')}>Đều</button>
        <button disabled={dis} onClick={() => cmd('outdent')}>← Thụt</button>
        <button disabled={dis} onClick={() => cmd('indent')}>Thụt →</button>
        <button disabled={dis} onClick={() => cmd('insertUnorderedList')}>Gạch đầu dòng</button>
        <button disabled={dis} onClick={() => cmd('insertOrderedList')}>Đánh số</button>
        <button disabled={dis} onClick={insertTable}>Chèn bảng</button>
        <button disabled={dis} onClick={insertImage}>Chèn ảnh</button>
        <button disabled={dis} onClick={promptLink}>Liên kết</button>
        <button disabled={dis} onClick={() => cmd('unlink')}>Bỏ liên kết</button>
        <button disabled={dis} onClick={() => cmd('insertHorizontalRule')}>Đường kẻ</button>
        <button disabled={dis} onClick={() => cmd('subscript')}>X₂</button>
        <button disabled={dis} onClick={() => cmd('superscript')}>X²</button>
        <button disabled={dis} onClick={insertChecklist}>☐ Checklist</button>
        <button disabled={dis} onClick={insertPageBreak}>Ngắt trang</button>
        <button disabled={dis} onClick={() => cmd('selectAll')}>Chọn tất cả</button>
        <button onClick={findText}>Tìm</button>
        <button onClick={() => window.print()}>In</button>
        <button disabled={dis} onClick={() => cmd('removeFormat')}>Xóa định dạng</button>
        {notice && <span className="notice">{notice}</span>}
      </div>
      <div className="pagearea">
        <div className="pagewrap">
          <div
            ref={ref}
            className="page"
            contentEditable={editable}
            suppressContentEditableWarning
            spellCheck
            onInput={emit}
            onPaste={onPaste}
            onCopy={block}
            onCut={block}
            onContextMenu={block}
            onDragStart={block}
            onDrop={(e) => e.preventDefault()}
          />
          {watermark && <Watermark text={watermark} />}
        </div>
      </div>
      <div className="statusbar"><span>{words} từ</span><span>{editable ? 'Đang chỉnh sửa' : 'Chỉ xem'}</span></div>
    </div>
  );
}
