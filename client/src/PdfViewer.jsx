import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';

let pdfJsPromise;
const loadPdfJs = () => {
  if (!pdfJsPromise) {
    pdfJsPromise = import('pdfjs-dist').then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
      return pdfjs;
    });
  }
  return pdfJsPromise;
};

export default function PdfViewer({ itemId, editable = false, watermark, notice }) {
  const host = useRef(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let dead = false;
    const render = async () => {
      try {
        const [pdfjs, file] = await Promise.all([loadPdfJs(), api.blob(`/items/${itemId}/file`)]);
        const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
        if (dead) return;
        host.current.replaceChildren();
        for (let n = 1; n <= pdf.numPages; n++) {
          const page = await pdf.getPage(n);
          const viewport = page.getViewport({ scale: 1.35 });
          const canvas = document.createElement('canvas');
          canvas.className = 'pdf-page';
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          host.current.appendChild(canvas);
          await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        }
        if (!dead) setLoading(false);
      } catch (e) {
        if (!dead) { setError(e.message || 'Không thể mở PDF'); setLoading(false); }
      }
    };
    render();
    return () => { dead = true; };
  }, [itemId]);

  return (
    <div className="pdf-viewer">
      {notice && <div className="ribbon"><span className="notice">{notice}</span></div>}
      {editable && <div className="ribbon"><span className="muted">PDF chỉ hỗ trợ xem và chú thích bằng công cụ trình duyệt.</span></div>}
      {loading && !error && <p className="wrap muted">Đang tải PDF…</p>}
      {error && <p className="wrap err">{error}</p>}
      <div ref={host} className="pdf-pages" aria-label="Nội dung PDF" />
      {watermark && <div className="pdf-watermark">{watermark}</div>}
    </div>
  );
}
