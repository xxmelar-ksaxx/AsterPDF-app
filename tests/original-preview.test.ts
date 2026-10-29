import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PDFDocument, rgb, degrees } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');
const { renderOriginalPreview, previewOriginalObject } = require('../electron/original-preview.cjs');
const { listOriginalObjects } = require('../electron/original-objects.cjs');
const { listOriginalText } = require('../electron/original-text.cjs');
const { applyOriginalTransforms } = require('../electron/original-transforms.cjs');
import { stageTransform, stageObjectPatch } from '../src/pdf/original-transforms';
const pixel = (image: any, x: number, y: number) => [...image.data.subarray((Math.floor(y)*image.width+Math.floor(x))*4, (Math.floor(y)*image.width+Math.floor(x))*4+4)];

test('drag preview separates original artwork, background and foreground at page rotation/crop', async () => {
  for (const rotation of [0, 90, 180, 270]) {
    const pdf = await PDFDocument.create(), page = pdf.addPage([300, 240]);
    page.setCropBox(20, 20, 260, 200); page.setRotation(degrees(rotation));
    page.drawRectangle({ x: 20, y: 20, width: 260, height: 200, color: rgb(0,0,1) });
    page.drawRectangle({ x: 80, y: 80, width: 80, height: 60, color: rgb(1,0,0) });
    page.drawRectangle({ x: 110, y: 100, width: 15, height: 15, color: rgb(0,1,0) });
    const bytes = await pdf.save(), original = bytes.slice();
    const objects = await listOriginalObjects(bytes, 0), index = Number(objects[1].id);
    const task = pdfjs.getDocument({ data: bytes.slice() }), doc = await task.promise;
    const viewport = (await doc.getPage(1)).getViewport({ scale: 1 });
    const layers = (await renderOriginalPreview(bytes, 0, index, viewport.width, viewport.height, rotation)).map((data:Uint8Array)=>PNG.sync.read(Buffer.from(data)));
    const at = (layer:number,x:number,y:number) => { const p=viewport.convertToViewportPoint(x,y);return pixel(layers[layer],p[0],p[1]); };
    assert.deepEqual(at(0,100,100),[0,0,255,255],`Background ${rotation}`);
    assert.deepEqual(at(1,100,100),[255,0,0,255],`Object ${rotation}`);
    assert.deepEqual(at(1,50,50),[0,0,0,0],`Transparency ${rotation}`);
    assert.deepEqual(at(2,117,107),[0,255,0,255],`Foreground ${rotation}`);
    assert.deepEqual(at(2,100,100),[0,0,0,0]);
    assert.deepEqual(bytes, original, 'Preparing a drag must not change the PDF');
    await task.destroy();
  }
});

test('staged moves compose and are applied together without changing the original bytes', async () => {
  const pdf=await PDFDocument.create(),page=pdf.addPage([300,240]);
  page.drawRectangle({x:20,y:30,width:40,height:30,color:rgb(1,0,0)});
  page.drawText('Keep editable',{x:30,y:170,size:18});
  const bytes=await pdf.save(),original=bytes.slice();
  const shape=(await listOriginalObjects(bytes,0))[0],text=(await listOriginalText(bytes,0))[0];
  let pending=stageTransform([],{pageIndex:0,index:Number(shape.id),matrix:[1,0,0,1,10,15]});
  pending=stageTransform(pending,{pageIndex:0,index:Number(shape.id),matrix:[2,0,0,1,0,0]});
  pending=stageTransform(pending,{pageIndex:0,index:text.index,text:text.text,matrix:[1,0,0,1,20,-30]});
  assert.equal(pending.length,2);
  // The selected sprite stays at its original coordinates; the other staged
  // objects are already positioned in the stationary backdrop.
  const layers=(await renderOriginalPreview(bytes,0,text.index,300,240,0,pending)).map((data:Uint8Array)=>PNG.sync.read(Buffer.from(data)));
  assert.deepEqual(pixel(layers[0],70,190),[255,0,0,255]);
  assert.deepEqual(pixel(layers[0],25,200),[255,255,255,255]);
  const saved=await applyOriginalTransforms(bytes,pending);
  const changed=(await listOriginalObjects(saved,0))[0],moved=(await listOriginalText(saved,0))[0];
  assert.ok(Math.abs(changed.box[0]-60)<.01);assert.ok(Math.abs(changed.box[2]-140)<.01);
  assert.ok(Math.abs(moved.box[0]-text.box[0]-20)<.01);assert.ok(Math.abs(moved.box[1]-text.box[1]+30)<.01);
  assert.equal(moved.text,text.text);assert.deepEqual(bytes,original);
  await assert.rejects(()=>applyOriginalTransforms(bytes,[{pageIndex:0,index:9999,matrix:[1,0,0,1,5,5]}]),/Invalid object/);
  assert.deepEqual(bytes,original);
});

test('worker previews use the original embedded text and image pixels', async () => {
  const pdf=await PDFDocument.create(),page=pdf.addPage([300,240]);
  page.drawText('Original text',{x:20,y:170,size:20});
  const png=new PNG({width:10,height:10});for(let i=0;i<png.data.length;i+=4){png.data[i]=255;png.data[i+3]=255;}
  page.drawImage(await pdf.embedPng(PNG.sync.write(png)),{x:100,y:50,width:40,height:40});
  const bytes=await pdf.save();
  const text=(await listOriginalText(bytes,0))[0], image=(await listOriginalObjects(bytes,0)).find((object:any)=>object.kind==='image');
  for(const index of [text.index,Number(image.id)]) {
    const layers=(await previewOriginalObject(bytes,0,index,300,240,0)).map((data:Uint8Array)=>PNG.sync.read(Buffer.from(data)));
    assert.ok(layers[1].data.some((value:number,i:number)=>i%4===3&&value>0),'Selected object must have visible pixels');
    if(index===Number(image.id))assert.deepEqual(pixel(layers[1],110,160),[255,0,0,255]);
  }
});

test('fill and stroke previews stay independent, and staged deletion/color preserve object identities on save', async () => {
  const pdf=await PDFDocument.create(),page=pdf.addPage([300,240]);
  page.drawRectangle({x:10,y:10,width:20,height:20,color:rgb(0,0,0)});
  page.drawRectangle({x:80,y:60,width:70,height:60,color:rgb(1,0,0),borderColor:rgb(0,0,1),borderWidth:8,opacity:.5,borderOpacity:.75});
  page.drawText('After deletion',{x:30,y:180,size:18});
  const bytes=await pdf.save(),original=bytes.slice();
  const objects=await listOriginalObjects(bytes,0),shape=objects[1],text=(await listOriginalText(bytes,0))[0];
  const layers=(await renderOriginalPreview(bytes,0,Number(shape.id),300,240,0)).map((data:Uint8Array)=>PNG.sync.read(Buffer.from(data)));
  assert.equal(layers.length,5);
  assert.ok(Math.abs(pixel(layers[3],100,140)[3]-128)<=1,'Fill alpha is retained');
  assert.equal(pixel(layers[4],100,140)[3],0,'Stroke cannot recolor the fill');
  assert.ok(Math.abs(pixel(layers[4],80,140)[3]-191)<=1,'Stroke alpha is retained');
  let edits=stageObjectPatch([],0,Number(objects[0].id),{deleted:true});
  edits=stageObjectPatch(edits,0,Number(shape.id),{fill:[0,255,0],stroke:[255,255,0]});
  edits=stageTransform(edits,{pageIndex:0,index:Number(shape.id),matrix:[1,0,0,1,10,5]});
  edits=stageObjectPatch(edits,0,text.index,{text:text.text,fill:[30,40,50]});
  const result=await applyOriginalTransforms(bytes,edits,{pageIndex:0,index:text.index});
  const savedObjects=await listOriginalObjects(result.bytes,0),savedText=await listOriginalText(result.bytes,0);
  assert.equal(savedObjects.length,1);
  assert.deepEqual(savedObjects[0].fill.slice(0,3),[0,255,0]);assert.deepEqual(savedObjects[0].stroke.slice(0,3),[255,255,0]);
  assert.equal(savedObjects[0].fill[3],shape.fill[3]);assert.equal(savedObjects[0].stroke[3],shape.stroke[3]);
  assert.ok(Math.abs(savedObjects[0].box[0]-shape.box[0]-10)<.01);
  assert.equal(result.index,savedText[0].index);assert.deepEqual(savedText[0].color.slice(0,3),[30,40,50]);
  assert.deepEqual(bytes,original);
});
