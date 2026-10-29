import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PDFDocument, PDFName, PDFOperator, rgb, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject, rectangle, clip, endPath } from 'pdf-lib';
const require=createRequire(import.meta.url);
const {listOriginalObjects,editOriginalObject}=require('../electron/original-objects.cjs');
const {listOriginalText,engine,withDocument}=require('../electron/original-text.cjs');
const {PNG}=require('pngjs');
const png=new PNG({width:2,height:2});png.data.fill(255);const imageBytes=PNG.sync.write(png);
async function pixel(bytes:Uint8Array,x:number,y:number) {
  const p=await engine();return withDocument(p,bytes,(doc:number)=>{
    const page=p.FPDF_LoadPage(doc,0),bitmap=p.FPDFBitmap_Create(600,500,1);
    try {p.FPDFBitmap_FillRect(bitmap,0,0,600,500,0xffffffff);p.FPDF_RenderPageBitmap(bitmap,page,0,0,600,500,0,0);
      const offset=p.FPDFBitmap_GetBuffer(bitmap)+(500-y)*p.FPDFBitmap_GetStride(bitmap)+x*4;
      return [p.pdfium.HEAPU8[offset+2],p.pdfium.HEAPU8[offset+1],p.pdfium.HEAPU8[offset]];
    }finally{p.FPDFBitmap_Destroy(bitmap);p.FPDF_ClosePage(page);}
  });
}
async function fixture() {
  const pdf=await PDFDocument.create(),page=pdf.addPage([600,500]);
  page.drawRectangle({x:40,y:340,width:80,height:50,color:rgb(1,0,0)});
  page.drawCircle({x:190,y:370,size:4,color:rgb(0,0,0)});
  page.drawText('•',{x:40,y:230,size:16});page.drawText('Keep this text',{x:65,y:230,size:16});
  const image=await pdf.embedPng(imageBytes);page.drawImage(image,{x:300,y:340,width:96,height:64});
  page.drawImage(image,{x:440,y:340,width:96,height:64});
  const form=pdf.context.register(pdf.context.flateStream('0.2 0.6 0.3 rg 0 0 40 30 re f',{Type:'XObject',Subtype:'Form',BBox:[0,0,40,30],Resources:{}}));
  const name=page.node.newXObject('Group',form);
  for(const x of [80,300])page.pushOperators(pushGraphicsState(),concatTransformationMatrix(1.2,.2,-.1,1.1,x,100),drawObject(name),popGraphicsState());
  return new Uint8Array(await pdf.save());
}
test('original shapes, bullets and images can be moved, resized, recolored, replaced and removed',async()=>{
  let bytes=await fixture();const original=bytes.slice();
  const objects=await listOriginalObjects(bytes,0);
  assert.equal(objects.filter((o:any)=>o.kind==='image').length,2);
  assert.equal(objects.filter((o:any)=>o.kind==='bullet').length,1);
  const shape=objects.find((o:any)=>o.kind==='shape'&&o.fill?.[0]===255);
  bytes=await editOriginalObject(bytes,0,shape.id,shape.token,{type:'transform',matrix:[2,0,0,1.5,10,-20]});
  const moved=(await listOriginalObjects(bytes,0)).find((o:any)=>o.id===shape.id);
  assert.ok(Math.abs(moved.box[0]-90)<.01);assert.ok(Math.abs(moved.box[2]-250)<.01);
  await assert.rejects(editOriginalObject(bytes,0,shape.id,shape.token,{type:'delete'}),/changed/);
  bytes=await editOriginalObject(bytes,0,moved.id,moved.token,{type:'color',channel:'fill',color:[30,80,190]});
  const colored=(await listOriginalObjects(bytes,0)).find((o:any)=>o.id===shape.id);assert.deepEqual(colored.fill,[30,80,190,255]);
  const image=(await listOriginalObjects(bytes,0)).find((o:any)=>o.kind==='image');
  const replacement=new PNG({width:3,height:3});for(let i=0;i<replacement.data.length;i+=4){replacement.data[i]=255;replacement.data[i+3]=255;}
  bytes=await editOriginalObject(bytes,0,image.id,image.token,{type:'replace-image',png:new Uint8Array(PNG.sync.write(replacement))});
  assert.deepEqual(await pixel(bytes,330,365),[255,0,0]);
  assert.deepEqual(await pixel(bytes,470,365),[255,255,255],'Replacing one image must not change another instance of the same resource');
  assert.deepEqual((await listOriginalObjects(bytes,0)).find((o:any)=>o.id===image.id).box,image.box);
  const bullet=(await listOriginalObjects(bytes,0)).find((o:any)=>o.kind==='bullet');
  bytes=await editOriginalObject(bytes,0,bullet.id,bullet.token,{type:'delete'});
  assert.equal((await listOriginalObjects(bytes,0)).filter((o:any)=>o.kind==='bullet').length,0);
  assert.ok((await listOriginalText(bytes,0)).some((o:any)=>o.text==='Keep this text'));
  assert.equal((await listOriginalObjects(original,0)).filter((o:any)=>o.kind==='bullet').length,1,'The input PDF is unchanged');
});
test('editing grouped exported artwork affects only its selected instance',async()=>{
  let bytes=await fixture();const objects=await listOriginalObjects(bytes,0);
  const nested=objects.filter((o:any)=>o.kind==='group');assert.equal(nested.length,2);
  const [first,second]=nested;
  bytes=await editOriginalObject(bytes,0,first.id,first.token,{type:'transform',matrix:[1,0,0,1,14,9]});
  let after=await listOriginalObjects(bytes,0);
  assert.ok(Math.abs(after.find((o:any)=>o.id===first.id).box[0]-first.box[0]-14)<.02,JSON.stringify({first,after:after.filter((o:any)=>o.id.includes('.'))}));
  assert.deepEqual(after.find((o:any)=>o.id===second.id).box,second.box);
  assert.deepEqual(await pixel(bytes,117,129),[51,153,77]);
  assert.deepEqual(await pixel(bytes,84,105),[255,255,255]);
  assert.deepEqual(await pixel(bytes,323,120),[51,153,77]);
  const target=after.find((o:any)=>o.id===first.id);
  bytes=await editOriginalObject(bytes,0,target.id,target.token,{type:'delete'});
  after=await listOriginalObjects(bytes,0);
  assert.equal(after.filter((o:any)=>o.kind==='group').length,1);
  assert.deepEqual(after.find((o:any)=>o.kind==='group').box,second.box);
});
test('clipped images keep their crop when moved and replaced',async()=>{
  const pdf=await PDFDocument.create(),page=pdf.addPage([600,500]);
  const image=await pdf.embedPng(imageBytes);
  page.pushOperators(pushGraphicsState(),rectangle(310,350,40,40),clip(),endPath());
  page.drawImage(image,{x:300,y:340,width:100,height:80});page.pushOperators(popGraphicsState());
  let bytes=new Uint8Array(await pdf.save());let object=(await listOriginalObjects(bytes,0))[0];assert.deepEqual(object.box,[310,350,350,390]);
  bytes=await editOriginalObject(bytes,0,object.id,object.token,{type:'transform',matrix:[1,0,0,1,20,0]});
  object=(await listOriginalObjects(bytes,0))[0];assert.deepEqual(object.box,[330,350,370,390]);
  const red=new PNG({width:2,height:2});for(let i=0;i<red.data.length;i+=4){red.data[i]=255;red.data[i+3]=255;}
  bytes=await editOriginalObject(bytes,0,object.id,object.token,{type:'replace-image',png:new Uint8Array(PNG.sync.write(red))});
  assert.deepEqual(await pixel(bytes,350,370),[255,0,0]);
  assert.deepEqual(await pixel(bytes,325,370),[255,255,255]);
  assert.deepEqual(await pixel(bytes,375,370),[255,255,255]);
});
test('pages with unsupported standalone gradients fail safely without changing the PDF',async()=>{
  const pdf=await PDFDocument.create(),page=pdf.addPage([600,500]);
  const shading=pdf.context.obj({ShadingType:2,ColorSpace:'DeviceRGB',Coords:[30,50,200,50],Extend:[true,true],
    Function:{FunctionType:2,Domain:[0,1],C0:[1,0,0],C1:[0,0,1],N:1}});
  page.node.Resources()!.set(PDFName.of('Shading'),pdf.context.obj({Gradient:shading}));
  page.pushOperators(pushGraphicsState(),rectangle(30,50,170,80),clip(),endPath(),PDFOperator.of('sh' as any,[PDFName.of('Gradient')]),popGraphicsState());
  page.drawRectangle({x:300,y:300,width:50,height:50,color:rgb(0,1,0)});
  const bytes=new Uint8Array(await pdf.save()),before=await pixel(bytes,60,80);
  const object=(await listOriginalObjects(bytes,0))[0];
  await assert.rejects(editOriginalObject(bytes,0,object.id,object.token,{type:'transform',matrix:[1,0,0,1,20,0]}),/gradient artwork.*PDF was not changed/);
  assert.deepEqual(await pixel(bytes,60,80),before);
});
