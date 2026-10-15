const path = require('node:path');
const { randomUUID } = require('node:crypto');

function pdfPathsFromArguments(argv, { packaged, cwd, platform = process.platform }) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  return argv.slice(packaged ? 1 : 2).flatMap((argument) => {
    if (typeof argument !== 'string' || argument.startsWith('-') || argument.includes('\0')) return [];
    const value = argument.replace(/^"(.*)"$/, '$1');
    if (paths.extname(value).toLowerCase() !== '.pdf' || /^[a-z]+:\/\//i.test(value)) return [];
    return [paths.resolve(cwd, value)];
  });
}

// Keep OS launch requests until React has subscribed. Only deliver the next
// request after the previous document has opened (or the user has canceled it).
function createFileOpenQueue({ send, platform = process.platform }) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  let ready = false, active = null;
  const pending = [];
  const key = (value) => platform === 'win32' ? value.toLowerCase() : value;
  const flush = () => {
    if (!ready || active || !pending.length) return;
    active = pending.shift();
    send(active);
  };
  return {
    enqueue(filePath) {
      if (typeof filePath !== 'string' || !paths.isAbsolute(filePath) || paths.extname(filePath).toLowerCase() !== '.pdf' || filePath.includes('\0')) return false;
      if (key(active?.path || '') === key(filePath) || pending.some((item) => key(item.path) === key(filePath))) return true;
      pending.push({ id: randomUUID(), path: filePath }); flush(); return true;
    },
    setReady(value) { ready = value; flush(); },
    complete(id) { if (active?.id !== id) return; active = null; flush(); },
    reset() { ready = false; if (active) pending.unshift(active); active = null; }
  };
}

module.exports = { pdfPathsFromArguments, createFileOpenQueue };
