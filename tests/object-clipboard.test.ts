import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {PDFDocument, rgb} from 'pdf-lib';
const require=createRequire(import.meta.url);
const {copyObjects,pasteObjects}=require('../electron/object-clipboard.cjs');
const {listOriginalText,replaceOriginalText}=require('../electron/original-text.cjs');
const {listOriginalObjects}=require('../electron/original-objects.cjs');
const {applyOriginalTransforms}=require('../electron/original-transforms.cjs');

test('clipboard preserves native text and shapes, staged appearance, and independent edits',async()=>{
 const pdf=await PDFDocument.create(),page=pdf.addPage([600,500]);
 page.drawRectangle({x:40,y:350,width:100,height:70,color:rgb(1,0,0)});
 page.drawText('Native text',{x:60,y:200,size:18});
 const bytes=await pdf.save(),snapshot=bytes.slice();
 const fragment=await copyObjects(bytes,[{pageIndex:0,index:0},{pageIndex:0,index:1}],[{pageIndex:0,index:0,matrix:[1,0,0,1,20,0],fill:[0,150,40]}]);
 const pasted=await pasteObjects(bytes,fragment,0,12,-12);
 assert.deepEqual(bytes,snapshot);assert.deepEqual(pasted.indices,[2,3]);
 const shapes=await listOriginalObjects(pasted.bytes,0),texts=await listOriginalText(pasted.bytes,0);
 assert.equal(shapes.length,2);assert.equal(texts.length,2);assert.deepEqual(shapes[1].fill,[0,150,40,255]);
 assert.ok(Math.abs(shapes[1].box[0]-shapes[0].box[0]-32)<.1);
 assert.equal(texts[1].text.trim(),'Native text');assert.equal(texts[1].fontName,texts[0].fontName);
 const deleted=await applyOriginalTransforms(pasted.bytes,[{pageIndex:0,index:2,matrix:[1,0,0,1,0,0],deleted:true}]);
 assert.equal((await listOriginalObjects(deleted,0)).length,1);
});
test('pasted Arabic groups receive independent identities and remain editable',async()=>{
 const pdf=await PDFDocument.create();pdf.addPage([600,500]).drawText('Arabic placeholder',{x:60,y:250,size:20});
 let bytes=await pdf.save();const initial=(await listOriginalText(bytes,0))[0];
 bytes=await replaceOriginalText(bytes,0,initial.index,initial.text,'\u0645\u0631\u062d\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645','noto-naskh-arabic');
 const text=(await listOriginalText(bytes,0))[0];
 const fragment=await copyObjects(bytes,[{pageIndex:0,index:text.index}]);
 const pasted=await pasteObjects(bytes,fragment,0,0,-70);
 const texts=await listOriginalText(pasted.bytes,0);assert.equal(texts.length,2);assert.equal(texts[0].text,texts[1].text);
 const moved=await applyOriginalTransforms(pasted.bytes,[{pageIndex:0,index:texts[1].index,text:texts[1].text,matrix:[1,0,0,1,25,0]}]);
 const after=await listOriginalText(moved,0);
 assert.ok(Math.abs(after[0].box[0]-texts[0].box[0])<.1);assert.ok(Math.abs(after[1].box[0]-texts[1].box[0]-25)<.1);
});
