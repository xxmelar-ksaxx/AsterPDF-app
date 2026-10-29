const { _electron } = require('playwright');
const { createServer } = require('vite');
const { PDFDocument, rgb } = require('pdf-lib');
const { PNG } = require('pngjs');
const { listOriginalObjects } = require('../electron/original-objects.cjs');
const { listOriginalText } = require('../electron/original-text.cjs');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
async function main() {
  const project=path.join(__dirname,'..'),temp=await fs.mkdtemp(path.join(os.tmpdir(),'aster-original-drag-')),file=path.join(temp,'Drag.pdf');
  const pdf=await PDFDocument.create(),page=pdf.addPage([600,500]);
  page.drawRectangle({x:40,y:350,width:100,height:70,color:rgb(1,0,0)});
  page.drawText('Move original text',{x:40,y:230,size:18});
  const png=new PNG({width:20,height:15});for(let i=0;i<png.data.length;i+=4){png.data[i+2]=255;png.data[i+3]=255;}
  page.drawImage(await pdf.embedPng(PNG.sync.write(png)),{x:300,y:350,width:120,height:80});
  const original=await pdf.save();await fs.writeFile(file,original);
  const server=await createServer({configFile:false,root:project,server:{host:'127.0.0.1',port:0}});await server.listen();
  const env={...process.env,ASTERPDF_DEV_URL:`http://127.0.0.1:${server.httpServer.address().port}`};delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app=await _electron.launch({executablePath:require('electron'),args:[project,`--user-data-dir=${temp}`,file],env,timeout:60000});
    let doc;for(let i=0;i<200;i++){doc=app.context().pages().find(p=>!p.url().includes('workspace=1')&&p.url().startsWith(env.ASTERPDF_DEV_URL));if(doc&&await doc.locator('.page-control strong').count())break;await new Promise(r=>setTimeout(r,100));}
    assert.ok(doc);doc.setDefaultTimeout(15000);const errors=[];doc.on('pageerror',e=>errors.push(e.message));
    await doc.locator('dialog.save-feedback').waitFor({state:'hidden'});await doc.getByRole('button',{name:'Edit',exact:true}).click();
    // Dragging must never call PDF serialization or enter the saving state.
    await app.evaluate(({ipcMain})=>{
      global.dragTestSaves=0;global.dragTestEdits=0;global.dragTestSaving=0;global.dragTestBatches=0;global.dragTestPreviews=0;
      ipcMain.on('pdf:set-saving',(_event,value)=>{if(value)global.dragTestSaving++;});
      for(const channel of ['pdf:edit-original-object','pdf:move-original-text','pdf:save','pdf:apply-original-transforms','pdf:preview-original-object']){
        const handler=ipcMain._invokeHandlers.get(channel);ipcMain.removeHandler(channel);
        ipcMain.handle(channel,async(event,...args)=>{if(channel==='pdf:save')global.dragTestSaves++;else if(channel==='pdf:apply-original-transforms')global.dragTestBatches++;else if(channel==='pdf:preview-original-object')global.dragTestPreviews++;else global.dragTestEdits++;return handler(event,...args);});
      }
    });
    const preview=doc.locator('.original-drag-preview');
    await doc.evaluate(()=>{window.dragTestPaints=0;new MutationObserver(()=>window.dragTestPaints++).observe(document.querySelector('.page-stage > canvas'),{attributes:true,attributeFilter:['width','height']});});
    const move=async(locator,text=false,cancel=false)=>{
      await locator.waitFor();const b=await locator.boundingBox();
      const x=b.x+b.width/2,y=text?b.y+2:b.y+b.height/2;
      await doc.mouse.move(x,y);await doc.mouse.down();await doc.mouse.move(x+40,y+24,{steps:12});
      assert.equal(await preview.isVisible(),true,'Even a cold drag has immediate visual feedback');
      await preview.waitFor({state:'visible'});
      await doc.locator('.original-drag-preview[data-phase="isolated"]').waitFor({state:'visible'});
      assert.equal(await preview.locator('canvas').count(),3);
      const before=await preview.locator('canvas').nth(1).evaluate(el=>el.style.transform);
      await doc.mouse.move(x+65,y+36,{steps:6});
      const after=await preview.locator('canvas').nth(1).evaluate(el=>el.style.transform);assert.notEqual(after,before,'Pixels follow the held pointer');
      const pixels=await preview.locator('canvas').nth(1).evaluate(el=>{const d=el.getContext('2d').getImageData(0,0,el.width,el.height).data;let count=0;for(let i=3;i<d.length;i+=4)if(d[i])count++;return count;});assert.ok(pixels>10,'Preview contains original artwork');
      if(cancel){await doc.keyboard.press('Escape');await doc.mouse.up();return;}
      await doc.mouse.up();assert.equal(await preview.isVisible(),true,'Editable artwork stays on screen after release');
      assert.equal(await app.evaluate(()=>global.dragTestSaving),0,'No saving spinner during movement');
      assert.equal(await app.evaluate(()=>global.dragTestEdits+global.dragTestBatches),0,'No PDF rebuild during movement');
      assert.equal(await doc.evaluate(()=>window.dragTestPaints),0,'No page rerender during movement');
      assert.equal(await app.evaluate(()=>global.dragTestSaves),0,'Dragging must not save the file');
      assert.deepEqual(new Uint8Array(await fs.readFile(file)),original);
      assert.equal(await doc.locator('.error-banner').count(),0);
    };
    await move(doc.locator('[data-object-kind="shape"]'));
    await move(doc.locator('[data-object-kind="image"]'));
    await move(doc.locator('[data-original-resize="se"]'));
    const previews=await app.evaluate(()=>global.dragTestPreviews);
    await move(doc.locator('[data-object-kind="image"]'));
    assert.equal(await app.evaluate(()=>global.dragTestPreviews),previews,'Repeated drags reuse isolated artwork');
    await move(doc.locator('svg[aria-label="Original text frame: Move original text"] .text-frame-border').first(),true);
    const edits=await app.evaluate(()=>global.dragTestEdits);
    await move(doc.locator('[data-object-kind="image"]'),false,true);
    assert.equal(await app.evaluate(()=>global.dragTestEdits),edits,'Escape cancels without a PDF edit');
    await doc.keyboard.press('Control+z');await doc.waitForFunction(()=>!document.querySelector('.overlay-toolbar button')?.disabled);
    await doc.keyboard.press('Control+Shift+z');
    const shape=doc.locator('[data-object-kind="shape"]');
    await shape.click();
    await doc.getByRole('button',{name:'Original object fill color',exact:true}).click();
    const hex=doc.getByRole('textbox',{name:'Hex color',exact:true});
    const hasColor=async color=>doc.waitForFunction(color=>{const c=document.querySelector('.original-drag-preview canvas:nth-child(2)');if(!c)return false;const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;for(let i=0;i<d.length;i+=4)if(d[i]===color[0]&&d[i+1]===color[1]&&d[i+2]===color[2]&&d[i+3]===255)return true;return false;},color);
    await hex.fill('#00aabb');await hasColor([0,170,187]);
    const colorPreviews=await app.evaluate(()=>global.dragTestPreviews);
    await hex.fill('#cc5500');await hasColor([204,85,0]);
    assert.equal(await app.evaluate(()=>global.dragTestPreviews),colorPreviews,'Color previews reuse the local paint layers');
    await hex.press('Escape');
    await doc.getByRole('button',{name:'Delete selected PDF object',exact:true}).click();
    assert.equal(await shape.count(),0);
    assert.equal(await preview.locator('canvas').nth(1).evaluate(el=>el.style.visibility),'hidden','Delete hides actual artwork immediately');
    await doc.keyboard.press('Control+z');await shape.waitFor();await hasColor([204,85,0]);
    await doc.keyboard.press('Control+Shift+z');await shape.waitFor({state:'hidden'});
    await doc.keyboard.press('Control+z');await shape.waitFor();
    assert.equal(await app.evaluate(()=>global.dragTestSaving),0,'Colors and deletes must not enter saving status');
    assert.equal(await app.evaluate(()=>global.dragTestSaves+global.dragTestEdits+global.dragTestBatches),0,'Colors and deletes must not serialize or save the PDF');
    assert.equal(await doc.evaluate(()=>window.dragTestPaints),0,'Colors and deletes must not repaint the PDF page');
    assert.deepEqual(new Uint8Array(await fs.readFile(file)),original);
    await doc.getByRole('button',{name:'Save PDF',exact:true}).click();await doc.locator('dialog.save-feedback').waitFor({state:'hidden'});await doc.waitForFunction(()=>!document.querySelector('.unsaved-dot'));
    assert.equal(await app.evaluate(()=>global.dragTestSaves),1);assert.equal(await app.evaluate(()=>global.dragTestBatches),1,'All moves are applied in one save batch');
    const saved=new Uint8Array(await fs.readFile(file)),objects=await listOriginalObjects(saved,0),text=await listOriginalText(saved,0);
    assert.ok(objects.find(o=>o.kind==='shape').box[0]>40);assert.deepEqual(objects.find(o=>o.kind==='shape').fill.slice(0,3),[204,85,0]);assert.ok(objects.find(o=>o.kind==='image').box[0]>300);assert.ok(text[0].box[0]>40);
    const savedImage=objects.find(o=>o.kind==='image');assert.ok(savedImage.box[2]-savedImage.box[0]>120,'Live resize is saved');
    assert.deepEqual(errors,[]);console.log('Live original drag passed: text/image/shape pixels, instant repeated moves, no saving state or PDF rebuild/page rerender on release, live colors, deletion, Escape, undo/redo and one explicit save batch.');
  } finally {if(app){await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.destroy())).catch(()=>{});await app.close().catch(()=>{});}await server.close();await fs.rm(file,{force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
