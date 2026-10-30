// Luồng riêng dựng file (.xlsx / .docx) để việc nặng không làm nghẽn API và WebSocket.
const { parentPort, workerData } = require('worker_threads');

(async () => {
  try {
    let buf;
    if (workerData.kind === 'docx') buf = await require('html-to-docx')('<html><body>' + workerData.html + '</body></html>');
    else buf = await require('./excel').exportXlsx({ parts: workerData.parts });
    parentPort.postMessage({ buf: Buffer.from(buf) });
  } catch (e) { parentPort.postMessage({ error: e.message }); }
})();
