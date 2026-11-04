// Token phiên nằm trong cookie HttpOnly (JavaScript không đọc được). sessionStorage chỉ giữ "slot": mã dùng để chọn
// cookie phiên của TAB này, nên admin và user đăng nhập cùng lúc trên cùng 1 trình duyệt mà không ghi đè nhau.
let onUnauth = () => {};
export const setUnauthHandler = (f) => { onUnauth = f; };

let memSlot = null; // dự phòng khi trình duyệt chặn sessionStorage
export const sessionSlot = () => {
  const key = 'office-session-slot';
  let slot = null;
  try { slot = sessionStorage.getItem(key); } catch { slot = memSlot; }
  if (!slot) {
    // getRandomValues chạy cả khi mở bằng http://IP-trong-mạng-LAN (crypto.randomUUID thì KHÔNG: cần https hoặc localhost)
    slot = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    memSlot = slot;
    try { sessionStorage.setItem(key, slot); } catch { /* dùng bản trong bộ nhớ */ }
  }
  return slot;
};

async function request(path, method = 'GET', body, extra = {}) {
  const res = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    headers: {
      'X-Session-Slot': sessionSlot(),
      ...(body !== undefined && !extra.raw ? { 'Content-Type': 'application/json' } : {}),
      ...(extra.headers || {}),
    },
    body: body === undefined ? undefined : extra.raw ? body : JSON.stringify(body),
  });
  if (extra.blob && res.ok) return res.blob();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== '/login') onUnauth(data.error);
    const e = new Error(data.error || 'Lỗi ' + res.status);
    e.data = data; e.status = res.status;
    throw e;
  }
  return data;
}

const save = async (blob, name) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
};

export const api = {
  get: (p) => request(p),
  post: (p, b = {}) => request(p, 'POST', b),
  put: (p, b) => request(p, 'PUT', b),
  patch: (p, b) => request(p, 'PATCH', b),
  del: (p) => request(p, 'DELETE'),
  upload: (file, bookId) =>
    file.arrayBuffer().then((buf) =>
      request('/books/upload', 'POST', buf, {
        raw: true,
        headers: {
          'Content-Type': 'application/octet-stream',
          'x-filename': encodeURIComponent(file.name),
          ...(bookId ? { 'x-book': bookId } : {}),
        },
      })),
  download: async (path, filename) => save(await request(path, 'GET', undefined, { blob: true }), filename),
  blob: (path) => request(path, 'GET', undefined, { blob: true }),
};