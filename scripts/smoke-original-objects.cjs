const {_electron}=require('playwright');
const {createServer}=require('vite');
const {PDFDocument,rgb}=require('pdf-lib');
const {PNG}=require('pngjs');
const {listOriginalObjects}=require('../electron/original-objects.cjs');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
async function main(){
 const project=path.join(__dirname,'..'),temp=await fs.mkdtemp(path.join(os.tmpdir(),'aster-original-objects-'));
 const file=path.join(temp,'Objects.pdf'),replacement=path.join(temp,'Replacement.png');
 const image=new PNG({width:12,height:8});for(let i=0;i<image.data.length;i+=4){image.data[i]=255;image.data[i+3]=255;}
 await fs.writeFile(replacement,PNG.sync.write(image));
 const pdf=await PDFDocument.create(),page=pdf.addPage([600,500]);
 page.drawRectangle({x:60,y:330,width:100,height:70,color:rgb(.2,.6,.3)});
 page.drawCircle({x:200,y:360,size:4,color:rgb(0,0,0)});
 page.drawText('•',{x:60,y:240,size:18});page.drawText('Keep text editable',{x:85,y:240,size:18});
 const embedded=await pdf.embedPng(PNG.sync.write(image));page.drawImage(embedded,{x:300,y:320,width:120,height:80});
 await fs.writeFile(file,await pdf.save());
 const server=await createServer({configFile:false,root:project,server:{host:'127.0.0.1',port:0}});await server.listen();
 const env={...process.env,ASTERPDF_DEV_URL:`http://127.0.0.1:${server.httpServer.address().port}`};delete env.ELECTRON_RUN_AS_NODE;
 let app;
 try{
  app=await _electron.launch({executablePath:require('electron'),args:[project,`--user-data-dir=${temp}`,file],env,timeout:60000});
  let doc;for(let i=0;i<200;i++){doc=app.context().pages().find(p=>!p.url().includes('workspace=1')&&p.url().startsWith(env.ASTERPDF_DEV_URL));if(doc&&await doc.locator('.page-control strong').count())break;await new Promise(r=>setTimeout(r,100));}
  assert.ok(doc);doc.setDefaultTimeout(20000);const errors=[];doc.on('pageerror',e=>errors.push(e.message));
  await doc.locator('dialog.save-feedback').waitFor({state:'hidden'});
  await doc.getByRole('button',{name:'Edit',exact:true}).click();
  const shape=doc.locator('[data-object-kind="shape"]').first();await shape.waitFor();
  const before=await shape.evaluate(el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};});
  await doc.mouse.move(before.x+before.width/2,before.y+before.height/2);await doc.mouse.down();await doc.mouse.move(before.x+before.width/2+40,before.y+before.height/2+25,{steps:12});await doc.mouse.up();
  await doc.waitForFunction(x=>{const e=document.querySelector('[data-object-kind="shape"]');return e&&Math.abs(e.getBoundingClientRect().x-x)<2;},before.x+40).catch(async error=>{console.log({before,after:await shape.evaluate(el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};}),selected:await doc.locator('.original-object-frame').count(),error:await doc.locator('.error-banner').allTextContents(),errors});throw error;});
  await doc.keyboard.press('Control+z');await doc.waitForFunction(x=>{const e=document.querySelector('[data-object-kind="shape"]');return e&&Math.abs(e.getBoundingClientRect().x-x)<2;},before.x);
  await doc.keyboard.press('Control+Shift+z');await doc.waitForFunction(x=>{const e=document.querySelector('[data-object-kind="shape"]');return e&&Math.abs(e.getBoundingClientRect().x-x)<2;},before.x+40);
  await shape.click();await doc.getByRole('button',{name:'Original object fill color',exact:true}).click();
  await doc.getByRole('textbox',{name:'Hex color'}).fill('#2476a9');await doc.getByRole('textbox',{name:'Hex color'}).press('Enter');
  await doc.getByRole('button',{name:'Original object fill color',exact:true}).waitFor();await doc.keyboard.press('Escape');
  await shape.waitFor();await shape.click();const sizeBefore=await shape.evaluate(el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};});
  const handle=await doc.locator('[data-original-resize="se"]').boundingBox();
  await doc.keyboard.down('Shift');await doc.mouse.move(handle.x+4,handle.y+4);await doc.mouse.down();await doc.mouse.move(handle.x+60,handle.y+42,{steps:10});await doc.mouse.up();await doc.keyboard.up('Shift');
  await doc.waitForFunction(w=>{const e=document.querySelector('[data-object-kind="shape"]');return e&&e.getBoundingClientRect().width>w+30;},sizeBefore.width);
  const sizeAfter=await shape.evaluate(el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};});assert.ok(Math.abs(sizeAfter.width/sizeAfter.height-sizeBefore.width/sizeBefore.height)<.02);
  const originalImage=doc.locator('[data-object-kind="image"]');await originalImage.click({button:'right'});
  const chooserPromise=doc.waitForEvent('filechooser');await doc.getByRole('menuitem',{name:'Replace image…'}).click();await (await chooserPromise).setFiles(replacement);
  await doc.waitForFunction(()=>!document.querySelector('.overlay-toolbar [aria-label="Delete selected PDF object"]')?.disabled);
  const bullet=doc.locator('[data-object-kind="bullet"]');await bullet.click();await doc.keyboard.press('Delete');await bullet.waitFor({state:'hidden'});
  await doc.keyboard.press('Control+z');await bullet.waitFor();
  await doc.locator('svg[aria-label="Original text frame: Keep text editable"] .text-frame-interior').click();
  const editor=doc.getByRole('textbox',{name:'Edit original PDF text',exact:true});await editor.waitFor();
  await editor.press('Escape');await editor.waitFor({state:'hidden'});
  await doc.getByRole('button',{name:'Comments',exact:true}).click();assert.equal(await doc.locator('[data-original-object]').count(),0,'Original objects cannot be moved in other features');
  await doc.getByRole('button',{name:'Save PDF',exact:true}).click();await doc.locator('dialog.save-feedback').waitFor({state:'hidden'});await doc.waitForFunction(()=>!document.querySelector('.unsaved-dot'));
  const saved=await listOriginalObjects(new Uint8Array(await fs.readFile(file)),0);
  assert.deepEqual(saved.find(o=>o.kind==='shape').fill.slice(0,3),[36,118,169]);
  assert.equal(saved.filter(o=>o.kind==='image').length,1);assert.equal(saved.filter(o=>o.kind==='bullet').length,1);
  assert.deepEqual(errors,[]);assert.equal(await doc.locator('.error-banner').count(),0);
  console.log('Original object editing passed: selection, drag, proportional resize, color, image replacement, delete, undo/redo, mode isolation and saved native PDF objects.');
 }finally{if(app){await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.destroy())).catch(()=>{});await app.close().catch(()=>{});}await server.close();await fs.rm(file,{force:true});await fs.rm(replacement,{force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
