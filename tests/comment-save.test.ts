import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PDFDocument, PDFDict, PDFName, PDFRawStream, PDFString } from 'pdf-lib';
import { prepareCommentData } from '../src/pdf/comment-save-data';
import { attachOverlayPackage, readOverlayPackage, type OverlayObject } from '../src/pdf/overlays';
import { pruneUnusedObjects } from '../src/pdf/prune-unused';

test('repeated comment saves discard old snapshots and keep editable artwork and attachments', async () => {
  const pdf=await PDFDocument.create();
  pdf.addPage([300,400]).drawText('Keep page content');
  const attachment=pdf.context.register(pdf.context.stream(new Uint8Array([1,2,3,4])));
  pdf.catalog.set(PDFName.of('Names'),pdf.context.obj({EmbeddedFiles:{Names:[PDFString.of('attachment.bin'),{Type:'Filespec',F:PDFString.of('attachment.bin'),EF:{F:attachment}}]}}));
  const base=await pdf.save();
  const objects: OverlayObject[]=[{id:'shape',pageId:'source-0',kind:'rectangle',x:.1,y:.1,width:.2,height:.2,color:'#000000',lineWidth:2}];
  let bytes=await attachOverlayPackage(base,base,objects);
  // Reproduce old versions that left a complete compressed snapshot detached.
  const bloated=await PDFDocument.load(bytes);
  bloated.context.register(bloated.context.stream(randomBytes(2*1024*1024)));
  bytes=await bloated.save();
  const sizes:number[]=[];
  for(let i=0;i<3;i++) {
    const result=await prepareCommentData(bytes,[{id:`note-${i}`,page:1,x:10,y:10,author:'Test',text:`Comment ${i}`,date:'2026-10-21'}]);
    bytes=result.bytes;sizes.push(bytes.length);
    const saved=await PDFDocument.load(bytes);
    const clean=await PDFDocument.load(result.base);
    assert.equal(saved.getPageCount(),1);
    assert.equal(clean.getPage(0).node.Annots()!.size(),i+1);
    assert.deepEqual((await readOverlayPackage(bytes))?.objects,objects);
    const names=saved.catalog.lookup(PDFName.of('Names'),PDFDict);
    assert.ok(names.has(PDFName.of('EmbeddedFiles')));
    const stream=saved.context.lookup(attachment);
    assert.ok(stream instanceof PDFRawStream);
    assert.deepEqual([...stream.getContents()],[1,2,3,4]);
  }
  assert.ok(sizes[0]<10000,'Old detached megabytes must be reclaimed');
  assert.ok(sizes[2]<sizes[0]+6000,'Further saves grow only by comment data');
});

test('reachability cleanup retains trailer metadata and does not follow stream bytes as objects', async()=>{
  const pdf=await PDFDocument.create();pdf.addPage();pdf.setTitle('Keep title');
  const orphan=pdf.context.register(pdf.context.stream(new Uint8Array(100)));
  pruneUnusedObjects(pdf);
  assert.equal(pdf.context.lookup(orphan),undefined);
  const reopened=await PDFDocument.load(await pdf.save());
  assert.equal(reopened.getTitle(),'Keep title');assert.equal(reopened.getPageCount(),1);
});
