const { _electron }=require('playwright');
const { createServer }=require('vite');
const { PDFDocument, PDFName, rgb }=require('pdf-lib');
const { attachOverlayPackage }=require('../src/pdf/overlays.ts');
const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const assert=require('node:assert/strict');

async function main(){
 const project=path.join(__dirname,'..');const temp=await fs.mkdtemp(path.join(os.tmpdir(),'aster-presentation-'));const file=path.join(temp,'Slides.pdf');
 const pdf=await PDFDocument.create();
 pdf.addPage([800,450]).drawText('Landscape slide',{x:40,y:390,size:24});
 const second=pdf.addPage([400,650]);second.drawText('Portrait slide',{x:40,y:590,size:24});
 const appearance=pdf.context.register(pdf.context.flateStream('1 0 0 rg 0 0 100 60 re f',{Type:'XObject',Subtype:'Form',BBox:[0,0,100,60],Resources:{}}));
 second.node.set(PDFName.of('Annots'),pdf.context.obj([pdf.context.register(pdf.context.obj({Type:'Annot',Subtype:'Text',Rect:[150,300,250,360],Contents:require('pdf-lib').PDFString.of('Hidden comment'),AP:{N:appearance},F:4}))]));
 const base=await pdf.save();
 const object={id:'shape',pageId:'source-1',kind:'rectangle',x:.1,y:.2,width:.3,height:.1,color:'#007700',fill:'#007700',lineWidth:2};
 await fs.writeFile(file,await attachOverlayPackage(base,base,[object]));
 const original=await fs.readFile(file);
 const server=await createServer({configFile:false,root:project,server:{host:'127.0.0.1',port:0}});await server.listen();
 const env={...process.env,ASTERPDF_DEV_URL:`http://127.0.0.1:${server.httpServer.address().port}`};delete env.ELECTRON_RUN_AS_NODE;
 let app;
 try{
  app=await _electron.launch({executablePath:require('electron'),args:[project,`--user-data-dir=${temp}`,file],env,timeout:60000});
  let doc,shell;
  for(let i=0;i<150;i++){
   shell=app.context().pages().find(p=>p.url().includes('workspace=1'));
   doc=app.context().pages().find(p=>!p.url().includes('workspace=1')&&p.url().startsWith(env.ASTERPDF_DEV_URL));
   if(doc&&await doc.locator('.page-control strong').count())break;
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(doc&&shell);doc.setDefaultTimeout(20000);
  const errors=[];doc.on('pageerror',error=>errors.push(error.message));
  await doc.locator('dialog.save-feedback').waitFor({state:'hidden'});
  await doc.getByRole('button',{name:'Next page',exact:true}).click();
  await doc.waitForFunction(()=>document.querySelector('.page-control strong').textContent==='2');
  await doc.locator('.viewer-scroll').evaluate(el=>el.scrollTo({top:el.scrollTop,behavior:'instant'}));
  const beforeScroll=await doc.locator('.viewer-scroll').evaluate(el=>el.scrollTop);
  const initialMenu=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isMenuBarVisible());
  await doc.getByRole('button',{name:'Start presentation'}).click();
  const presentation=doc.getByRole('dialog',{name:'PDF presentation'});
  await presentation.waitFor();
  await doc.waitForFunction(()=>document.querySelector('.presentation-slide').dataset.page==='2');
  const native=await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows()[0];return {full:win.isFullScreen(),menu:win.isMenuBarVisible(),top:win.contentView.children[0].getBounds().y};});
  assert.deepEqual(native,{full:true,menu:false,top:0});
  const geometry=await doc.locator('.presentation-slide').evaluate(el=>{const r=el.getBoundingClientRect();return{w:r.width,h:r.height,screenW:innerWidth,screenH:innerHeight};});
  assert.ok(geometry.w<=geometry.screenW+1&&geometry.h<=geometry.screenH+1);
  assert.ok(Math.abs(geometry.h-geometry.screenH)<2,'Portrait slide should fit height');
  assert.equal(await presentation.locator('button,input,textarea,.comment-pin,.comment-markup,.pdf-link').count(),0);
  assert.ok(await presentation.locator('[data-overlay-id="shape"]').count(),'Added drawing must remain visible');
  const pixel=await presentation.locator('canvas').evaluate(canvas=>{const c=canvas.getContext('2d');return [...c.getImageData(Math.floor(canvas.width*.5),Math.floor(canvas.height*.49),1,1).data];});
  assert.deepEqual(pixel,[255,255,255,255],'Embedded comment appearance must be hidden');
  await doc.keyboard.press('ArrowLeft');await doc.waitForFunction(()=>document.querySelector('.presentation-slide').dataset.page==='1');
  await doc.keyboard.press('Space');await doc.waitForFunction(()=>document.querySelector('.presentation-slide').dataset.page==='2');
  await doc.keyboard.press('Home');await doc.waitForFunction(()=>document.querySelector('.presentation-slide').dataset.page==='1');
  await doc.keyboard.press('End');await doc.waitForFunction(()=>document.querySelector('.presentation-slide').dataset.page==='2');
  await doc.keyboard.press('Escape');await presentation.waitFor({state:'hidden'});
  const restored=await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows()[0];return {full:win.isFullScreen(),menu:win.isMenuBarVisible(),top:win.contentView.children[0].getBounds().y};});
  assert.deepEqual(restored,{full:false,menu:initialMenu,top:42});
  await doc.waitForFunction(top=>Math.abs(document.querySelector('.viewer-scroll').scrollTop-top)<2,beforeScroll);
  await doc.getByRole('button',{name:'Start presentation'}).click();await presentation.waitFor();
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setFullScreen(false));
  await presentation.waitFor({state:'hidden'});
  assert.deepEqual(errors,[]);assert.deepEqual(await fs.readFile(file),original,'Presenting must not write the PDF');
  console.log('Presentation passed: fullscreen, hidden app/comment controls, embedded annotations hidden, artwork visible, page fitting/navigation, Escape and native exit, scroll restored, file unchanged.');
 }finally{if(app){await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.destroy())).catch(()=>{});await app.close().catch(()=>{});}await server.close();await fs.rm(file,{force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
