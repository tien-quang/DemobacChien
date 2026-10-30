// Token phiên nằm trong cookie HttpOnly; sessionStorage chỉ giữ mã chọn cookie của tab hiện tại.
let onUnauth = () => {};
export const setUnauthHandler = (f) => { onUnauth = f; };
const sessionSlot = () => {
  const key = 'office-session-slot';
  let slot = sessionStorage.getItem(key);
  if (!slot) {
    slot = crypto.randomUUID().replaceAll('-', '');
    sessionStorage.setItem(key, slot);
  }
  return slot;
};

async function request(path, method = 'GET', body, extra = {}) {
  const res = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body !== undefined && !extra.raw ? { 'Content-Type': 'application/json' } : {}),
      'X-Session-Slot': sessionSlot(),
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
};
