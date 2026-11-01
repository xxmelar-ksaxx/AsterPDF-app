const {_electron}=require('playwright');
const {createServer}=require('vite');
const {PDFDocument,rgb}=require('pdf-lib');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
async function poll(check){for(let i=0;i<150;i++){if(await check())return;await new Promise(r=>setTimeout(r,100));}throw new Error('Timed out waiting for selection geometry');}
async function main(){
 const project=path.join(__dirname,'..'),temp=await fs.mkdtemp(path.join(os.tmpdir(),'aster-edit-shortcuts-')),file=path.join(temp,'Shortcuts.pdf');
 const pdf=await PDFDocument.create(),page=pdf.addPage([600,500]);
 page.drawRectangle({x:40,y:350,width:100,height:70,color:rgb(1,0,0)});
 page.drawRectangle({x:240,y:350,width:100,height:70,color:rgb(0,0,1)});
 page.drawText('Copy this text',{x:60,y:200,size:18});
 const original=await pdf.save();await fs.writeFile(file,original);
 const server=await createServer({configFile:false,root:project,server:{host:'127.0.0.1',port:0}});await server.listen();
 const env={...process.env,ASTERPDF_DEV_URL:`http://127.0.0.1:${server.httpServer.address().port}`};delete env.ELECTRON_RUN_AS_NODE;
 let app;
 try{
 app=await _electron.launch({executablePath:require('electron'),args:[project,`--user-data-dir=${temp}`,file],env,timeout:60000});
 let doc;for(let i=0;i<200;i++){doc=app.context().pages().find(p=>!p.url().includes('workspace=1')&&p.url().startsWith(env.ASTERPDF_DEV_URL));if(doc&&await doc.locator('.page-control strong').count())break;await new Promise(r=>setTimeout(r,100));}
 assert.ok(doc);doc.setDefaultTimeout(15000);const errors=[];doc.on('pageerror',e=>errors.push(e.message));
 await doc.locator('dialog.save-feedback').waitFor({state:'hidden'});
 const shell=app.context().pages().find(p=>p.url().includes('workspace=1'));
 await shell.locator('.workspace-brand').waitFor();assert.equal(await doc.locator('.topbar').count(),0);
 await doc.getByRole('button',{name:'Edit',exact:true}).click();
 await doc.locator('[data-original-object]').first().waitFor();
 // Ctrl toggles membership without starting a drag or text selection.
 const first=doc.locator('[data-original-object]').nth(0),second=doc.locator('[data-original-object]').nth(1);
 await doc.getByRole('spinbutton',{name:'Font size',exact:true}).focus();
 await first.click();await second.click({modifiers:['Control']});assert.equal(await doc.locator('.multi-object-outline').count(),2);
 await second.click({modifiers:['Control']});assert.equal(await doc.locator('.multi-object-outline').count(),1);
 await second.click({modifiers:['Control']});
 // Dragging a selected item keeps the group, moves both objects live, and records one undo step.
 const before=await doc.locator('.multi-object-outline').evaluateAll(nodes=>nodes.map(n=>({x:+n.getAttribute('x'),y:+n.getAttribute('y')})));
 const firstBox=await first.boundingBox();
 await doc.mouse.move(firstBox.x+firstBox.width/2,firstBox.y+firstBox.height/2);await doc.mouse.down();
 await doc.mouse.move(firstBox.x+firstBox.width/2+45,firstBox.y+firstBox.height/2+25,{steps:8});
 await doc.locator('.original-drag-preview[data-phase="group"]').waitFor({state:'visible'});
 assert.equal(await doc.locator('.selection-count').innerText(),'2 selected');
 assert.ok(await doc.locator('.original-drag-preview [data-moving="true"]').evaluateAll(nodes=>nodes.every(n=>n.style.transform.includes('45px'))));
 await doc.mouse.up();
 await poll(async()=>{const b=await first.boundingBox();return Math.abs(b.x-firstBox.x-45)<1&&Math.abs(b.y-firstBox.y-25)<1;});
 assert.equal(await doc.locator('.selection-count').innerText(),'2 selected');
 await doc.keyboard.press('Control+z');
 await poll(async()=>Math.abs((await first.boundingBox()).x-firstBox.x)<1);
 await first.click();await second.click({modifiers:['Control']});
 // Escape restores every selected object without leaving an edit in history.
 const cancelBox=await first.boundingBox();await doc.mouse.move(cancelBox.x+20,cancelBox.y+20);await doc.mouse.down();await doc.mouse.move(cancelBox.x+70,cancelBox.y+40,{steps:6});await doc.keyboard.press('Escape');await doc.mouse.up();
 assert.ok(Math.abs((await first.boundingBox()).x-cancelBox.x)<1);
 // The group context menu acts on all objects and keeps the selection intact.
 await first.click({button:'right'});await doc.getByRole('menuitem',{name:'Copy selection',exact:true}).click();

 await doc.keyboard.press('Control+v');
 await doc.waitForFunction(()=>document.querySelectorAll('[data-original-object]').length===4);
 assert.equal(await doc.locator('.multi-object-outline').count(),2);
 await doc.getByRole('button',{name:'Delete selected objects',exact:true}).click();await doc.waitForFunction(()=>document.querySelectorAll('[data-original-object]').length===2);
 await doc.keyboard.press('Control+z');await doc.waitForFunction(()=>document.querySelectorAll('[data-original-object]').length===4);
 await doc.keyboard.press('Control+Shift+z');await doc.waitForFunction(()=>document.querySelectorAll('[data-original-object]').length===2);
 // Native text stays text, not an image.
 const text=doc.locator('.original-text-frames .text-frame-border').first();await text.click();
 await doc.keyboard.press('Control+c');await doc.keyboard.press('Control+v');
 await doc.waitForFunction(()=>document.querySelectorAll('.original-text-frames').length===2);
 // Clipboard text is inserted with the current font size.
 await app.evaluate(({clipboard})=>clipboard.writeText('Pasted\ntext'));
 await doc.keyboard.press('Control+v');await doc.locator('[data-overlay-kind="text"]').waitFor();
 const overlay=doc.locator('[data-overlay-kind="text"]');
 await doc.keyboard.press('Escape');await overlay.locator('.text-frame-border').first().click({position:{x:16,y:3}});await doc.keyboard.press('Control+c');await doc.keyboard.press('Control+v');
 await doc.waitForFunction(()=>document.querySelectorAll('[data-overlay-kind="text"]').length===2);
 // Native editing of text keeps normal clipboard behavior.
 await doc.keyboard.press('Escape');await overlay.first().locator('.text-frame-interior').click({position:{x:2,y:2}});
 const editor=doc.locator('[contenteditable="true"], textarea').filter({visible:true}).first();
 await editor.waitFor();await doc.keyboard.press('Control+a');await doc.keyboard.press('Control+c');
 assert.equal((await app.evaluate(({clipboard})=>clipboard.readText())).replace(/\r/g,''),'Pasted\ntext');
 await doc.keyboard.press('Escape');
 // Zoom shortcuts, including Option's code-based macOS keyboard mapping.
 await doc.locator('.zoom-label').click();const viewer=doc.locator('.viewer-scroll'),box=await viewer.boundingBox();
 await doc.mouse.move(box.x+100,box.y+100);await doc.keyboard.down('Alt');await doc.mouse.wheel(0,-120);await doc.keyboard.up('Alt');
 await doc.waitForFunction(()=>document.querySelector('.zoom-label').textContent!=='Fit width');
 const zoom=await doc.locator('.zoom-label').innerText();await doc.keyboard.press('Alt+Minus');assert.notEqual(await doc.locator('.zoom-label').innerText(),zoom);
 await doc.keyboard.press('Alt+0');assert.equal(await doc.locator('.zoom-label').innerText(),'Fit width');
 // Mix an added text object with native artwork, using Cmd as the modifier too.
 await doc.keyboard.press('Escape');await doc.locator('[data-original-object]').first().click();
 await doc.locator('[data-overlay-kind="text"]').first().locator('.text-frame-interior').click({modifiers:['Meta'],position:{x:2,y:2}});
 await doc.locator('.original-text-frames .text-frame-interior').first().click({modifiers:['Control'],position:{x:2,y:2}});
 assert.equal(await doc.locator('.selection-count').innerText(),'3 selected');
 const addedBefore=await doc.locator('[data-overlay-kind="text"]').first().boundingBox(),nativeBefore=await doc.locator('[data-original-object]').first().boundingBox();
 await doc.mouse.move(nativeBefore.x+20,nativeBefore.y+20);await doc.mouse.down();await doc.mouse.move(nativeBefore.x+50,nativeBefore.y+40,{steps:6});await doc.mouse.up();
 await poll(async()=>Math.abs((await doc.locator('[data-overlay-kind="text"]').first().boundingBox()).x-addedBefore.x-30)<1);
 assert.equal(await doc.locator('.selection-count').innerText(),'3 selected');
 await doc.keyboard.press('Control+c');await doc.keyboard.press('Control+v');
 await doc.waitForFunction(()=>document.querySelectorAll('[data-original-object]').length===3&&document.querySelectorAll('[data-overlay-kind="text"]').length===3&&document.querySelectorAll('.original-text-frames').length===3);
 // Paste an image from another application.
 await app.evaluate(async ({clipboard,ClipboardItem,nativeImage})=>{const image=nativeImage.createFromBuffer(Buffer.from([0,0,255,255]),{width:1,height:1});await clipboard.write([new ClipboardItem({'image/png':new Blob([image.toPNG()],{type:'image/png'})})]);});
 await doc.keyboard.press('Control+v');await doc.locator('[data-overlay-kind="image"]').waitFor();
 assert.deepEqual(new Uint8Array(await fs.readFile(file)),original,'No autosave during clipboard edits');assert.equal(await doc.locator('.error-banner').count(),0);assert.deepEqual(errors,[]);
 await doc.screenshot({path:path.join(os.tmpdir(),'aster-edit-shortcuts.png')});
 // The compact header retains the unsaved indicator in the tab, and manual save works.
 await app.evaluate(({Menu})=>Menu.getApplicationMenu().items.find(i=>i.label==='File').submenu.items.find(i=>i.label==='Save').click());
 for(let attempt=0;attempt<200;attempt++){
   const state=await shell.evaluate(()=>window.aster.getWorkspace());
   if(state.tabs.every(tab=>!tab.dirty&&!tab.busy))break;
   if(attempt===199)throw new Error('Manual save did not finish');
   await new Promise(resolve=>setTimeout(resolve,100));
 }
 assert.notDeepEqual(new Uint8Array(await fs.readFile(file)),original);
 const saved=await PDFDocument.load(await fs.readFile(file));assert.equal(saved.getPageCount(),1);
 // Update attention lives at the far right of the tabs, and reduced-motion disables pulsing.
 const shellState=await shell.evaluate(()=>window.aster.getWorkspace());
 const update=await doc.evaluate(()=>window.aster.getUpdateStatus());update.transfer={...update.transfer,phase:'ready',percent:100};
 await app.evaluate(({BrowserWindow},{state,update})=>{for(const win of BrowserWindow.getAllWindows()){win.webContents.send('workspace:changed',{...state,update});for(const view of win.contentView.children) view.webContents?.send('updates:changed',update);}}, {state:shellState,update});
 const updateButton=shell.getByRole('button',{name:'Update AsterPDF',exact:true});await updateButton.waitFor();
 assert.equal(await updateButton.evaluate(el=>getComputedStyle(el).animationName),'update-attention');
 await shell.emulateMedia({reducedMotion:'reduce'});assert.equal(await updateButton.evaluate(el=>getComputedStyle(el).animationName),'none');
 await shell.screenshot({path:path.join(os.tmpdir(),'aster-tabs-header.png'),clip:{x:0,y:0,width:1400,height:42}});
 await updateButton.click();await doc.getByRole('heading',{name:'Settings',exact:true}).waitFor();
 console.log('PASS group live dragging (native artwork + original and added text), Escape, atomic undo, context copy, toolbar delete, clipboard/paste, focus handling, no autosave, Alt zoom and compact header.');
 }catch(error){console.error(error);throw error;}finally{if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});}await server.close();await fs.rm(temp,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
