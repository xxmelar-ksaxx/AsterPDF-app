const { _electron } = require('playwright');
const { createServer } = require('vite');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  const source = process.argv[2];
  if(!source)throw Error('Pass a PDF path. Only a temporary copy will be modified.');
  const project=path.join(__dirname,'..');
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'aster-comment-save-'));
  const file=path.join(temp,'Autosave.pdf');
  await fs.copyFile(source,file);
  await fs.writeFile(path.join(temp,'settings.json'),JSON.stringify({authorName:'Autosave test'}));
  const server=await createServer({configFile:false,root:project,server:{host:'127.0.0.1',port:0}});
  await server.listen();
  const env={...process.env,ASTERPDF_DEV_URL:`http://127.0.0.1:${server.httpServer.address().port}`}; delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app=await _electron.launch({executablePath:require('electron'),args:[project,`--user-data-dir=${temp}`,file],env,timeout:60000});
    await app.evaluate(({app})=>{globalThis.autosaveCrashes=[];app.on('render-process-gone',(_event,_contents,details)=>globalThis.autosaveCrashes.push(details));});
    let doc;
    const deadline=Date.now()+90000;
    while(Date.now()<deadline){
      for(const page of app.context().pages()) {
        if(!page.url().includes('workspace=1')&&await page.locator('.document-title').getAttribute('title',{timeout:500}).catch(()=>null)===file){doc=page;break;}
      }
      if(doc)break;await new Promise(resolve=>setTimeout(resolve,200));
    }
    if(!doc)throw Error('Document did not open');
    doc.setDefaultTimeout(30000);
    const pageErrors=[]; const workers=[];
    doc.on('pageerror',error=>{pageErrors.push(error.message);console.error('Page error:',error.stack);});
    doc.on('worker',worker=>workers.push(worker.url()));
    await doc.locator('dialog.save-feedback').waitFor({state:'hidden',timeout:90000});
    await doc.locator('.page-stage canvas').first().waitFor({state:'visible'});
    await doc.getByRole('button',{name:'Comments',exact:true}).click();
    const tools=doc.getByRole('group',{name:'Comment and text markup tools'});
    const compose=doc.locator('.compose');
    await tools.getByRole('button',{name:'Add comment',exact:true}).click();
    await doc.locator('.page-stage').first().click({position:{x:100,y:120}});
    await compose.getByRole('textbox').fill('اختبار الحفظ في الخلفية');
    await doc.evaluate(()=>{window.autosaveCanvas=document.querySelector('.page-stage canvas');window.autosavePixels=window.autosaveCanvas.toDataURL();});
    await compose.getByRole('button',{name:'Add comment',exact:true}).click();
    const status=doc.getByRole('status',{name:'Saving comments in the background'});
    await status.waitFor();
    console.log('Autosave started on the large PDF.');
    await tools.getByRole('button',{name:'Add comment',exact:true}).click();
    await doc.locator('.page-stage').first().click({position:{x:140,y:160}});
    await compose.getByRole('textbox').fill('يمكن كتابة التعليق التالي أثناء الحفظ');
    assert.equal(await compose.getByRole('textbox').textContent(),'يمكن كتابة التعليق التالي أثناء الحفظ');
    await status.waitFor({state:'hidden',timeout:120000});
    assert.equal(await doc.evaluate(()=>window.autosaveCanvas===document.querySelector('.page-stage canvas')&&window.autosaveCanvas.toDataURL()===window.autosavePixels),true,'Page pixels and canvas must survive autosave');
    const firstSize=(await fs.stat(file)).size;
    console.log(JSON.stringify({phase:'first saved',mb:firstSize/1048576,errors:await doc.locator('[role=alert], .error, .error-banner').allTextContents()}));
    await doc.bringToFront();
    await compose.getByRole('button',{name:'Add comment',exact:true}).click();
    await compose.waitFor({state:'hidden'});
    await status.waitFor();
    await status.waitFor({state:'hidden',timeout:120000});
    assert.equal(await doc.evaluate(()=>window.autosaveCanvas===document.querySelector('.page-stage canvas')&&window.autosaveCanvas.toDataURL()===window.autosavePixels),true);
    const secondSize=(await fs.stat(file)).size;
    assert.ok(secondSize<firstSize+100000,'Repeated autosaves must not accumulate editing snapshots');
    assert.deepEqual(await app.evaluate(()=>globalThis.autosaveCrashes),[]);
    assert.deepEqual(pageErrors,[]);
    assert.ok(!workers.some(url=>url.includes('compression-estimator')),'Comments must not start compression estimates');
    assert.equal(await doc.locator('.error-banner').count(),0);
    console.log(JSON.stringify({result:'Two background saves passed; typing stayed usable and the page canvas remained unchanged.',firstMB:firstSize/1048576,secondMB:secondSize/1048576}));
  } finally {
    if(app){await app.evaluate(({BrowserWindow})=>{for(const win of BrowserWindow.getAllWindows())win.destroy();}).catch(()=>{});await app.close().catch(()=>{});}
    await server.close();
    // Only files created by this test are removed; retain the isolated profile.
    await fs.rm(file,{force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
