// Hàng đợi việc: bền vững (lưu trong cơ sở dữ liệu), tự thử lại tối đa 3 lần, gộp các yêu cầu trùng, chạy lại sau sập máy.
const store = require('./store');
const core = require('./core');
const { consolidate } = require('./consolidate');

const handlers = { consolidate };
let busy = false;

async function tick() {
  if (busy) return;
  const job = store.claimJob();
  if (!job) return;
  busy = true;
  const payload = JSON.parse(job.payload);
  core.bus.emit('job', { bookId: payload.bookId, status: 'running', jobId: job.id });
  try {
    const result = await handlers[job.type](payload);
    store.finishJob(job.id, result);
    core.bus.emit('job', { bookId: payload.bookId, status: 'done', jobId: job.id, result });
  } catch (e) {
    store.failJob(job.id, e.message, job.attempts);
    core.bus.emit('job', { bookId: payload.bookId, status: job.attempts < 3 ? 'retry' : 'failed', jobId: job.id, error: e.message });
    console.error('[job]', job.type, e.message);
  } finally { busy = false; }
}

function enqueueConsolidation(bookId, mode, by, delayMs = 0) {
  const r = store.enqueueJob('consolidate', bookId, { bookId, mode, by: by || null }, delayMs);
  core.bus.emit('job', { bookId, status: 'queued', jobId: r.id });
  return r;
}

// tự tổng hợp sau mỗi lần có người nộp bài (gộp nhiều lần nộp liên tiếp thành 1 lần chạy)
core.bus.on('submitted', ({ item }) => {
  const b = store.books.get(item.bookId);
  if (b && b.auto) enqueueConsolidation(b.id, 'submitted', null, 3000);
});

const start = () => setInterval(tick, 300).unref();
module.exports = { start, enqueueConsolidation, tick };
