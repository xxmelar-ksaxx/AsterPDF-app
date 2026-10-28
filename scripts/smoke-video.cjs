const { _electron } = require('playwright');
const { createServer } = require('vite');
const { PDFDocument, PDFName } = require('pdf-lib');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

async function main() {
  const project = path.join(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'aster-video-'));
  const file = path.join(temp, 'Video.pdf'), clip = path.join(temp, 'Sample.mp4');
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-t', '12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip]);
  const pdf = await PDFDocument.create(); pdf.addPage([800,450]); pdf.addPage([800,450]); await fs.writeFile(file, await pdf.save());
  const server = await createServer({configFile:false,root:project,server:{host:'127.0.0.1',port:0}}); await server.listen();
  const env = {...process.env, ASTERPDF_DEV_URL:`http://127.0.0.1:${server.httpServer.address().port}`}; delete env.ELECTRON_RUN_AS_NODE;
  let app;
  const launch = async () => {
    app = await _electron.launch({executablePath:require('electron'),args:[project,`--user-data-dir=${temp}`,file],env,timeout:60000});
    let doc;
    for (let i=0;i<200;i++) {
      doc=app.context().pages().find(p=>!p.url().includes('workspace=1')&&p.url().startsWith(env.ASTERPDF_DEV_URL));
      if(doc&&await doc.locator('.page-control strong').count()) break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.ok(doc);doc.setDefaultTimeout(15000);
    await doc.locator('dialog.save-feedback').waitFor({state:'hidden'});
    return doc;
  };
  const close = async () => { if(app){await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.destroy())).catch(()=>{});await app.close().catch(()=>{});app=null;} };
  try {
    let doc=await launch();const errors=[];doc.on('pageerror',e=>errors.push(e.message));
    await doc.getByRole('button',{name:'Edit',exact:true}).click();
    await doc.locator('input[accept=".mp4,video/mp4"]').setInputFiles(clip);
    await doc.waitForFunction(()=>document.querySelector('[aria-label="Add video"]')?.classList.contains('active'));
    const sheet=doc.locator('.page-sheet').first();const bounds=await sheet.boundingBox();
    await doc.mouse.click(bounds.x+bounds.width*.3,bounds.y+bounds.height*.35);
    const object=doc.locator('[data-overlay-kind="video"]');await object.waitFor();
    const before=await object.boundingBox();
    await doc.mouse.move(before.x+15,before.y+15);await doc.mouse.down();await doc.mouse.move(before.x+65,before.y+45,{steps:8});await doc.mouse.up();
    const moved=await object.boundingBox();assert.ok(Math.abs(moved.x-before.x-50)<2,'Video drag moves the object');
    const handle=doc.locator('[data-resize-handle="se"]');const corner=await handle.boundingBox();
    await doc.keyboard.down('Shift');await doc.mouse.move(corner.x+corner.width/2,corner.y+corner.height/2);await doc.mouse.down();await doc.mouse.move(corner.x+65,corner.y+40,{steps:8});await doc.mouse.up();await doc.keyboard.up('Shift');
    const resized=await object.locator('image').boundingBox();assert.ok(resized.width>moved.width);assert.ok(Math.abs(resized.width/resized.height-16/9)<.02,JSON.stringify(resized));
    await doc.mouse.click(resized.x+15,resized.y+15,{button:'right'});await doc.getByRole('menuitem',{name:'Delete video'}).click();await object.waitFor({state:'hidden'});
    await doc.keyboard.press('Control+z');await object.waitFor();
    await doc.getByRole('button',{name:'Play Sample.mp4'}).click();
    await doc.waitForFunction(()=>document.querySelector('.pdf-video video')?.currentTime>.2);
    await doc.locator('.pdf-video video').evaluate(video=>video.pause());
    assert.equal(await doc.locator('.pdf-video video').isVisible(),true,'Pausing keeps the frame and native controls visible');
    await doc.getByRole('button',{name:'Stop video'}).click();
    await doc.getByRole('button',{name:'Save PDF',exact:true}).click();
    await doc.locator('dialog.save-feedback').waitFor({state:'hidden'});await doc.waitForFunction(()=>!document.querySelector('.unsaved-dot'));
    assert.deepEqual(errors,[]);
    const saved=await PDFDocument.load(await fs.readFile(file));assert.ok(saved.catalog.has(PDFName.of('AsterPDFVideoAssetsV1')));
    await fs.rm(clip);
    await close();doc=await launch();doc.on('pageerror',e=>errors.push(e.message));
    await doc.getByRole('button',{name:'Play Sample.mp4'}).click();await doc.waitForFunction(()=>document.querySelector('.pdf-video video')?.currentTime>.2);
    await doc.getByRole('button',{name:'Start presentation'}).click();
    const presentation=doc.getByRole('dialog',{name:'PDF presentation'});await presentation.waitFor();
    await presentation.getByRole('button',{name:'Play Sample.mp4'}).click();
    await doc.waitForFunction(()=>document.querySelector('.presentation-slide video')?.currentTime>.2);
    assert.equal(await doc.locator('.presentation-slide').getAttribute('data-page'),'1');
    await doc.keyboard.press('PageDown');await doc.waitForFunction(()=>document.querySelector('.presentation-slide')?.dataset.page==='2');
    assert.equal(await presentation.locator('video').count(),0);assert.equal(await doc.locator('video').evaluateAll(videos=>videos.some(v=>!v.paused)),false);
    await doc.keyboard.press('Escape');await presentation.waitFor({state:'hidden'});assert.deepEqual(errors,[]);
    console.log('Video passed: MP4 import, placement, drag, proportional resize, delete/undo, playback, save/relaunch, presentation playback and pause on page change.');
  } finally {await close();await server.close();await fs.rm(clip,{force:true});await fs.rm(file,{force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
