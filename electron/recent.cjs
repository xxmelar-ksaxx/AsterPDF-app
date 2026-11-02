const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_RECENT = 32;
const retain = (items) => [...items.filter(item => item.pinned), ...items.filter(item => !item.pinned).sort((a, b) => b.openedAt - a.openedAt).slice(0, MAX_RECENT)];
const MAX_PREVIEW_LENGTH = 200_000;

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function validPreview(value) {
  return typeof value === 'string' && value.length <= MAX_PREVIEW_LENGTH &&
    /^data:image\/jpeg;base64,[a-zA-Z0-9+/]+={0,2}$/.test(value);
}

function createRecentStore(userDataPath) {
  const file = path.join(userDataPath, 'recent-pdfs.json');
  let pending = Promise.resolve();
  const serialized = (work) => {
    const result = pending.then(work);
    pending = result.catch(() => {});
    return result;
  };

  async function read() {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item) => item && typeof item.path === 'string' &&
        path.isAbsolute(item.path) && item.path.toLowerCase().endsWith('.pdf') &&
        Number.isFinite(item.openedAt) && item.openedAt > 0 && item.openedAt < 8.64e15 &&
        Number.isFinite(item.modifiedAt))
        .map((item) => ({
          path: item.path,
          pinned: item.pinned === true,
          openedAt: item.openedAt,
          modifiedAt: item.modifiedAt,
          preview: validPreview(item.preview) ? item.preview : null
        }));
    } catch {
      return [];
    }
  }

  async function write(items) {
    await fs.mkdir(userDataPath, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(items), { mode: 0o600 });
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  return {
    list: () => serialized(async () => {
      const items = await read();
      const available = await Promise.all(items.map(async (item) => {
        try {
          const stats = await fs.stat(item.path);
          if (!stats.isFile()) return null;
          return {
            path: item.path,
            name: path.basename(item.path),
            pinned: item.pinned,
            openedAt: item.openedAt,
            preview: Math.abs(stats.mtimeMs - item.modifiedAt) < 1 ? item.preview : null
          };
        } catch {
          return null;
        }
      }));
      return available.filter(Boolean);
    }),
    record: (filePath, modifiedAt) => serialized(async () => {
      const resolved = path.resolve(filePath);
      const items = await read();
      const existing = items.find((item) => samePath(item.path, resolved));
      const next = retain([{
        path: resolved,
        pinned: existing?.pinned === true,
        openedAt: Date.now(),
        modifiedAt,
        preview: existing && Math.abs(existing.modifiedAt - modifiedAt) < 1 ? existing.preview : null
      }, ...items.filter((item) => !samePath(item.path, resolved))]);
      await write(next);
    }),
    pin: (filePath, pinned) => serialized(async () => {
      const items = await read();
      const entry = items.find(item => samePath(item.path, filePath));
      if (entry) { entry.pinned = pinned === true; await write(retain(items)); }
    }),
    remove: (filePath) => serialized(async () => {
      await write((await read()).filter(item => !samePath(item.path, filePath)));
    }),
    setPreview: (filePath, preview) => serialized(async () => {
      if (!validPreview(preview)) throw new Error('Invalid PDF preview.');
      const items = await read();
      const entry = items.find((item) => samePath(item.path, filePath));
      if (!entry) return;
      entry.preview = preview;
      await write(items);
    })
  };
}

module.exports = { createRecentStore };
