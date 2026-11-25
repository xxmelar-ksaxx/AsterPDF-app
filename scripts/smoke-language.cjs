const { _electron } = require('playwright');
const { createServer } = require('vite');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { resolveLanguage } = require('../electron/language.cjs');

async function run() {
  assert.equal(resolveLanguage('system', ['ar-SA', 'en-US']), 'ar');
  assert.equal(resolveLanguage('en', ['ar-EG']), 'en');
  assert.equal(resolveLanguage('system', ['fr-FR']), 'en');
  const project = path.join(__dirname, '..');
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'aster-language-'));
  const server = await createServer({ root: project, server: { host: '127.0.0.1', port: 0, strictPort: false } });
  await server.listen();
  const env = { ...process.env, ASTERPDF_DEV_URL: 'http://127.0.0.1:' + server.httpServer.address().port };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  async function launch() {
    app = await _electron.launch({ executablePath: require('electron'), args: [project, '--user-data-dir=' + profile], env });
    await app.firstWindow();
    return documentView();
  }
  async function documentView(except) {
    for (let i = 0; i < 150; i++) {
      const doc = app.context().pages().find(p => p !== except && p.url().startsWith(env.ASTERPDF_DEV_URL) && !p.url().includes('workspace=1'));
      if (doc) { await doc.locator('.home-view').waitFor(); return doc; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Document view did not open');
  }
  try {
    const doc = await launch();
    await app.evaluate(({ Menu, app }) => {
      app.getPreferredSystemLanguages = () => ['ar-SA'];
      Menu.getApplicationMenu().items.find(i => ['Settings', 'الإعدادات'].includes(i.label)).submenu.items[0].click();
    });
    const selector = doc.locator('#application-language');
    await selector.selectOption('ar');
    await doc.waitForFunction(() => document.documentElement.dir === 'rtl');
    assert.equal(await doc.locator('#settings-title').textContent(), 'الإعدادات');
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.flatMap(item => item.submenu?.items ?? []).find(item => item.accelerator === 'CmdOrCtrl+Shift+N').click());
    const other = await documentView(doc);
    assert.equal(await other.locator('html').getAttribute('lang'), 'ar');
    await selector.selectOption('en');
    await other.waitForFunction(() => document.documentElement.lang === 'en');
    await selector.selectOption('system');
    await other.waitForFunction(() => document.documentElement.lang === 'ar');
    await selector.selectOption('ar');
    await doc.waitForFunction(() => document.querySelector('#application-language').value === 'ar');
    await app.close();
    const reopened = await launch();
    assert.equal(await reopened.locator('html').getAttribute('lang'), 'ar');
    assert.equal((await reopened.evaluate(() => window.aster.getLanguage())).preference, 'ar');
    console.log('Language selection, system detection, multi-window updates and restart passed.');
  } finally {
    if (app) await app.close();
    await server.close();
    await fs.rm(profile, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
