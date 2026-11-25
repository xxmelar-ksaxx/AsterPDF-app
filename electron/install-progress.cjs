const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

// The OS runs the indicator independently so it holds no files in the
// installation directory while the updater replaces the application.
function createInstallProgress(userData) {
  const marker = path.join(userData, 'update-in-progress');
  const readyFile = marker + '.ready';
  const logoFile = marker + '.png';
  const clear = () => Promise.all([marker, readyFile, logoFile].map(file => fs.rm(file, { force: true })));
  async function show(message, waitingMessage, rtl = false) {
    const windows = process.platform === 'win32';
    if (!windows && process.platform !== 'darwin') return false;
    const token = randomUUID();
    const script = await fs.readFile(path.join(__dirname, windows ? 'install-progress.ps1' : 'install-progress-mac.js'), 'utf8');
    await fs.writeFile(logoFile, await fs.readFile(path.join(__dirname, '..', 'assets', 'icon.png')), { mode: 0o600 });
    await fs.writeFile(marker, token, { mode: 0o600 });
    const executable = windows ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/usr/bin/osascript';
    // Start-Process gives the Windows UI its own console lifetime when the
    // Electron process (including its hidden console) is terminated.
    const args = windows ? ['-NoProfile', '-NonInteractive', '-Command',
      "Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WindowStyle Hidden -ArgumentList @('-NoProfile','-NonInteractive','-STA','-EncodedCommand',$env:ASTER_INSTALL_SCRIPT)"]
      : ['-l', 'JavaScript', '-e', script];
    const child = spawn(executable, args, {
      cwd: os.tmpdir(), detached: !windows, windowsHide: true, stdio: 'ignore',
      env: { ...process.env, ...(windows && { ASTER_INSTALL_SCRIPT: Buffer.from(script, 'utf16le').toString('base64') }), ASTER_INSTALL_LOGO: logoFile, ASTER_INSTALL_RTL: rtl ? '1' : '0', ASTER_INSTALL_TEXT: message, ASTER_INSTALL_WAIT: waitingMessage, ASTER_INSTALL_TOKEN: token, ASTER_INSTALL_MARKER: marker, ASTER_INSTALL_READY: readyFile }
    });
    let exited = false;
    child.once('error', () => { exited = true; });
    child.once('exit', code => { if (!windows || code !== 0) exited = true; });
    child.unref();
    const deadline = Date.now() + 8000;
    while (!exited && Date.now() < deadline) {
      if ((await fs.readFile(readyFile, 'utf8').catch(() => '')).split(':')[0] === token) return true;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await clear();
    return false;
  }
  return { show, clear };
}
module.exports = { createInstallProgress };
