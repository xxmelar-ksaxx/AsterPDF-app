const {_electron}=require('playwright');
const {createServer}=require('vite');
const {PDFDocument,rgb}=require('pdf-lib');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
async function poll(check){for(let i=0;i<150;i++){if(await check())return;await new Promise(r=>setTimeout(r,100));}throw new Error('Timed out waiting for selection geometry');}
async function main(){
 const project=path.join(__dirname,'..'),temp=await fs.mkdtemp(path.join(os.tmpdir(),'aster-marquee-')),file=path.join(temp,'Shortcuts.pdf');
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

 const stage=doc.locator('.page-stage');const b=await stage.boundingBox(),scale=b.width/600;
 const p=(x,y)=>({x:b.x+x*scale,y:b.y+y*scale});
 const sweep=async(a,z,modifier,cancel=false)=>{
   if(modifier)await doc.keyboard.down(modifier);
   const bounds=await stage.boundingBox(),ratio=bounds.width/600;const start={x:bounds.x+a[0]*ratio,y:bounds.y+a[1]*ratio},end={x:bounds.x+z[0]*ratio,y:bounds.y+z[1]*ratio};await doc.mouse.move(start.x,start.y);await doc.mouse.down();await doc.mouse.move(end.x,end.y,{steps:10});
   await doc.getByLabel('Selection box',{exact:true}).waitFor({state:'visible'});
   if(cancel)await doc.keyboard.press('Escape');
   await doc.mouse.up();if(modifier)await doc.keyboard.up(modifier);
   await doc.getByLabel('Selection box',{exact:true}).waitFor({state:'hidden'});
 };
 // Enclose the two shapes, but not the text below them.
 await sweep([25,65],[355,165]);
 assert.equal(await doc.locator('.selection-count').innerText(),'2 selected');assert.equal(await doc.locator('.multi-object-outline').count(),2);
 // A reverse-direction sweep replaces the selection with one enclosed object.
 await sweep([355,165],[225,65]);assert.equal(await doc.locator('.multi-object-outline').count(),1);assert.equal(await doc.locator('.selection-count').count(),0);
 await sweep([25,65],[155,165],'Control');assert.equal(await doc.locator('.selection-count').innerText(),'2 selected');
 // A second additive sweep must deduplicate objects, including with Cmd/Meta.
 await sweep([25,65],[355,165],'Meta');assert.equal(await doc.locator('.selection-count').innerText(),'2 selected');
 await sweep([570,350],[400,260],undefined,true);assert.equal(await doc.locator('.selection-count').innerText(),'2 selected');
 // Mere edge overlap does not accidentally select a large background object.
 await sweep([25,65],[60,100]);assert.equal(await doc.locator('.multi-object-outline').count(),0);
 // Plain clicks clear the selection without creating an undo entry or a text editor.
 await sweep([25,65],[355,165]);const blank=p(550,340);await doc.mouse.click(blank.x,blank.y);
 assert.equal(await doc.locator('.selection-count').count(),0);assert.equal(await doc.locator('.original-text-editor').count(),0);
 // Select original text and artwork together, then use the existing group actions.
 await sweep([370,325],[20,60]);assert.equal(await doc.locator('.selection-count').innerText(),'3 selected');
 assert.equal(await doc.locator('.original-text-frames .text-frame.selected').count(),1);
 const object=doc.locator('[data-original-object]').first(),before=await object.boundingBox();
 await doc.mouse.move(before.x+20,before.y+20);await doc.mouse.down();await doc.mouse.move(before.x+60,before.y+40,{steps:8});await doc.mouse.up();
 await poll(async()=>Math.abs((await object.boundingBox()).x-before.x-40)<1);
 await doc.locator('.edit-selection-frame').waitFor();
 await doc.getByRole('button',{name:'Copy selected objects',exact:true}).click();await doc.keyboard.press('Control+v');
 await poll(async()=>await doc.locator('[data-original-object]').count()===4&&await doc.locator('.original-text-frames').count()===2);
 assert.equal(await doc.locator('.selection-count').innerText(),'3 selected');
 await doc.keyboard.press('Delete');await poll(async()=>await doc.locator('[data-original-object]').count()===2&&await doc.locator('.original-text-frames').count()===1);
 await doc.keyboard.press('Control+z');await poll(async()=>await doc.locator('[data-original-object]').count()===4&&await doc.locator('.original-text-frames').count()===2);

 // Added text and images use the same selection box.
 await app.evaluate(({clipboard})=>clipboard.writeText('Added text'));
 await doc.keyboard.press('Control+v');await doc.locator('[data-overlay-kind="text"]').waitFor();
 await app.evaluate(async({clipboard,ClipboardItem,nativeImage})=>{const bytes=Buffer.alloc(16*16*4,255);const image=nativeImage.createFromBuffer(bytes,{width:16,height:16});await clipboard.write([new ClipboardItem({'image/png':new Blob([image.toPNG()],{type:'image/png'})})]);});
 await doc.keyboard.press('Control+v');await doc.locator('[data-overlay-kind="image"]').waitFor();
 await sweep([45,35],[205,78]);assert.equal(await doc.locator('.selection-count').innerText(),'2 selected');
 await doc.keyboard.press('Delete');assert.equal(await doc.locator('[data-overlay-kind="text"],[data-overlay-kind="image"]').count(),0);
 // Objects created in Draw remain protected in Edit mode.
 await doc.getByRole('button',{name:'Draw',exact:true}).click();await doc.getByRole('button',{name:'Draw rectangle',exact:true}).click();
 const drawBounds=await stage.boundingBox();await doc.mouse.move(drawBounds.x+drawBounds.width*.75,drawBounds.y+drawBounds.height*.13);await doc.mouse.down();await doc.mouse.move(drawBounds.x+drawBounds.width*.85,drawBounds.y+drawBounds.height*.2,{steps:6});await doc.mouse.up();
 await doc.locator('[data-overlay-kind="rectangle"]').waitFor();
 await doc.getByRole('button',{name:'Edit',exact:true}).click();await doc.locator('[data-original-object]').first().waitFor();
 await sweep([430,45],[530,120]);assert.equal(await doc.locator('.selection-count').count(),0);assert.equal(await doc.locator('.multi-object-outline').count(),0);
 assert.equal(await doc.locator('[data-overlay-kind="rectangle"]').count(),1);
 assert.deepEqual(new Uint8Array(await fs.readFile(file)),original,'Selecting and manipulating objects must not autosave');
 assert.deepEqual(errors,[]);assert.equal(await doc.locator('.error-banner').count(),0);
 console.log('PASS marquee: enclosed objects, reverse drag, replace/add/deduplicate, Ctrl/Cmd, Escape, blank click, text plus artwork, group move/copy/delete/undo, no autosave.');
 }catch(error){console.error(error);throw error;}finally{if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});}await server.close();await fs.rm(temp,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
