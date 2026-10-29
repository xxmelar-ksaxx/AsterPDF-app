const { createHash, randomUUID } = require('node:crypto');
const { PDFDocument, PDFName, PDFArray, PDFDict, PDFRawStream, decodePDFRawStream } = require('pdf-lib');
const { engine, withDocument, objectText } = require('./original-text.cjs');
const { readTextGroup } = require('./shaped-text.cjs');
const IDENTITY = [1, 0, 0, 1, 0, 0];
const BULLET = /^[•●○◦▪▫■□◆◇‣⁃∙·➢➤✓✔]$/u;
const point = (m,x,y) => [m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]];
const bounds = points => [Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))];
function inspect(pdfium, page) {
  const memory=pdfium.pdfium, ptr=memory.wasmExports.malloc(128), records=[];
  const textPage=pdfium.FPDFText_LoadPage(page);
  const floats = (count,offset=0) => Array.from({length:count},(_,i)=>memory.getValue(ptr+offset+i*4,'float'));
  const matrix = object => pdfium.FPDFPageObj_GetMatrix(object,ptr) ? floats(6) : IDENTITY;
  const color = (object,stroke) => pdfium[stroke?'FPDFPageObj_GetStrokeColor':'FPDFPageObj_GetFillColor'](object,ptr,ptr+4,ptr+8,ptr+12)
    ? [0,4,8,12].map(offset=>memory.getValue(ptr+offset,'i32')) : null;
  const visit = (object,index) => {
    if (records.length>=20000) throw new Error('This page has too many objects to edit.');
    const type=pdfium.FPDFPageObj_GetType(object), ownMatrix=matrix(object);
    if (pdfium.FPDFPageObj_GetIsActive(object,ptr) && !memory.getValue(ptr,'i32')) return;
    // Form XObjects retain their clipping, transparency groups and shared
    // resources. This PDFium build does not persist arbitrary child edits.
    // Expose the enclosing artwork as one editable group instead.
    const text=type===1 && !readTextGroup(pdfium,object) ? objectText(pdfium,object,textPage).trim() : '';
    if (![2,3,5].includes(type) && !(type===1 && BULLET.test(text))) return;
    if (!pdfium.FPDFPageObj_GetBounds(object,ptr,ptr+4,ptr+8,ptr+12)) return;
    const localBox=floats(4); if (!localBox.every(Number.isFinite)) return;
    let box=localBox, hasFill=type===1, hasStroke=false, shape;
    if (type===2) {
      if (pdfium.FPDFPath_GetDrawMode(object,ptr,ptr+4)) {hasFill=memory.getValue(ptr,'i32')!==0;hasStroke=!!memory.getValue(ptr+4,'i32');}
      const total=pdfium.FPDFPath_CountSegments(object), commands=[], transform=ownMatrix;
      let curve=[];
      if (total<10000) for(let i=0;i<total;i++) {
        const segment=pdfium.FPDFPath_GetPathSegment(object,i);
        if (!pdfium.FPDFPathSegment_GetPoint(segment,ptr,ptr+4)) continue;
        const p=point(transform,...floats(2)), kind=pdfium.FPDFPathSegment_GetType(segment);
        if (kind===1) {curve.push(...p);if(curve.length===6){commands.push(`C ${curve.join(' ')}`);curve=[];}}
        else {curve=[];commands.push(`${kind===2?'M':'L'} ${p.join(' ')}`);}
        if(pdfium.FPDFPathSegment_GetClose(segment)) commands.push('Z');
      }
      shape=commands.join(' ') || undefined;
    }
    const clip=pdfium.FPDFPageObj_GetClipPath(object);
    if(clip) for(let i=0;i<pdfium.FPDFClipPath_CountPaths(clip);i++) {
      const points=[];
      for(let j=0;j<pdfium.FPDFClipPath_CountPathSegments(clip,i);j++) {
        const seg=pdfium.FPDFClipPath_GetPathSegment(clip,i,j);
        if(pdfium.FPDFPathSegment_GetPoint(seg,ptr,ptr+4)) points.push(floats(2));
      }
      if(points.length) {const b=bounds(points);box=[Math.max(box[0],b[0]),Math.max(box[1],b[1]),Math.min(box[2],b[2]),Math.min(box[3],b[3])];}
    }
    if(box[2]<box[0] || box[3]<box[1]) return;
    const fill=hasFill?color(object,false):null, stroke=hasStroke?color(object,true):null;
    const strokeWidth=hasStroke && pdfium.FPDFPageObj_GetStrokeWidth(object,ptr)?floats(1)[0]:0;
    const info={id:String(index),kind:type===3?'image':type===1?'bullet':type===5?'group':'shape',box,fill,stroke,strokeWidth,shape};
    info.token=createHash('sha256').update(JSON.stringify([info,ownMatrix,text])).digest('hex');
    records.push({info,object,type});
  };
  try {for(let i=0;i<pdfium.FPDFPage_CountObjects(page);i++) visit(pdfium.FPDFPage_GetObject(page,i),i);return records;}
  finally {if(textPage)pdfium.FPDFText_ClosePage(textPage);memory.wasmExports.free(ptr);}
}
async function withPage(bytes,pageIndex,action) {
  const pdfium=await engine();
  return withDocument(pdfium,bytes,document=>{
    if(!Number.isInteger(pageIndex)||pageIndex<0||pageIndex>=pdfium.FPDF_GetPageCount(document))throw new Error('Invalid PDF page.');
    const page=pdfium.FPDF_LoadPage(document,pageIndex);if(!page)throw new Error('Could not read this page.');
    try{return action(pdfium,document,page);}finally{pdfium.FPDF_ClosePage(page);}
  });
}
const listOriginalObjects = (bytes,pageIndex) => withPage(bytes,pageIndex,(pdfium,document,page)=>inspect(pdfium,page).map(record=>record.info));

function save(pdfium,document,page) {
  if(!pdfium.FPDFPage_GenerateContent(page))throw new Error('Could not rebuild the edited page.');
  const writer=pdfium.PDFiumExt_OpenFileWriter(), memory=pdfium.pdfium;
  if(!writer)throw new Error('Could not create PDF output.');
  try {
    if(!pdfium.PDFiumExt_SaveAsCopy(document,writer))throw new Error('Could not save the object edit.');
    const size=pdfium.PDFiumExt_GetFileWriterSize(writer);
    if(size<8||size>1024*1024*1024)throw new Error('Invalid edited PDF size.');
    const ptr=memory.wasmExports.malloc(size);if(!ptr)throw new Error('Not enough memory to save.');
    try {if(pdfium.PDFiumExt_GetFileWriterData(writer,ptr,size)!==size)throw new Error('Could not read the edited PDF.');return Uint8Array.from(memory.HEAPU8.subarray(ptr,ptr+size));}
    finally{memory.wasmExports.free(ptr);}
  } finally{pdfium.PDFiumExt_CloseFileWriter(writer);}
}
async function editOriginalObject(bytes,pageIndex,id,token,change) {
  if(typeof id!=='string'||!/^\d+(\.\d+){0,15}$/.test(id)||typeof token!=='string'||!change||typeof change!=='object')throw new Error('Invalid object edit.');
  const result=await withPage(bytes,pageIndex,(pdfium,document,page)=>{
    // This engine's content generator does not serialize top-level shadings.
    // Form XObjects remain intact streams, including their gradient artwork.
    for(let i=0;i<pdfium.FPDFPage_CountObjects(page);i++) {
      if(pdfium.FPDFPageObj_GetType(pdfium.FPDFPage_GetObject(page,i))===4)
        throw new Error('This page contains standalone gradient artwork that the object editor cannot preserve yet. The PDF was not changed.');
    }
    const record=inspect(pdfium,page).find(record=>record.info.id===id && record.info.token===token);
    if(!record)throw new Error('The object changed. Select it again.');
    const {object,type,info}=record;
    if(change.type==='delete') {
      const removed=pdfium.FPDFPage_RemoveObject(page,object);
      if(!removed)throw new Error('This object could not be removed.');pdfium.FPDFPageObj_Destroy(object);
    } else if(change.type==='transform') {
      const m=change.matrix;
      if(!Array.isArray(m)||m.length!==6||!m.every(n=>Number.isFinite(n)&&Math.abs(n)<=1e6)||Math.abs(m[0]*m[3]-m[1]*m[2])<1e-8)throw new Error('Invalid object size or position.');
      const local=m;
      pdfium.FPDFPageObj_Transform(object,...local);
      pdfium.FPDFPageObj_TransformClipPath(object,...local);
    } else if(change.type==='color') {
      const rgba=change.color, channel=change.channel;
      if(!['fill','stroke'].includes(channel)||!info[channel]||!Array.isArray(rgba)||rgba.length!==3||!rgba.every(n=>Number.isInteger(n)&&n>=0&&n<=255))throw new Error('Choose an existing fill or stroke and a valid color.');
      if(!pdfium[channel==='fill'?'FPDFPageObj_SetFillColor':'FPDFPageObj_SetStrokeColor'](object,...rgba,info[channel][3]))throw new Error('Could not change this object color.');
    } else if(change.type==='replace-image') {
      if(type!==3||!(change.png instanceof Uint8Array)||change.png.length>50*1024*1024)throw new Error('Choose an image smaller than 50 MB.');
      const input=Buffer.from(change.png);
      if(input.length<24||input.readUInt32BE(16)*input.readUInt32BE(20)>40_000_000)throw new Error('The replacement image is too large.');
      // SetBitmap mutates a shared image resource, including other placements.
      // Mark only this paint operation and give it a fresh resource instead.
      // Its existing transform, clipping and graphics state remain intact.
      const tag=`AsterReplace${randomUUID().replaceAll('-','')}`;
      if(!pdfium.FPDFPageObj_AddMark(object,tag))throw new Error('Could not identify this image for replacement.');
      return {bytes:save(pdfium,document,page),tag};
    } else throw new Error('Unsupported object edit.');

    return save(pdfium,document,page);
  });
  if(result instanceof Uint8Array)return result;
  const pdf=await PDFDocument.load(result.bytes,{updateMetadata:false}),page=pdf.getPage(pageIndex);
  const image=await pdf.embedPng(change.png);
  const resources=page.node.Resources().clone(),xobjects=resources.lookup(PDFName.of('XObject'),PDFDict).clone();
  const name=PDFName.of(result.tag);xobjects.set(name,image.ref);resources.set(PDFName.of('XObject'),xobjects);page.node.set(PDFName.of('Resources'),resources);
  const content=page.node.Contents(),streams=content instanceof PDFArray?content.asArray():[content];
  const refs=[];let replaced=0;
  for(const ref of streams){
    const stream=pdf.context.lookup(ref);if(!(stream instanceof PDFRawStream))throw new Error('Could not read this image content stream.');
    let text=Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
    const marker=new RegExp(`/${result.tag}\\s+BMC\\s*([\\s\\S]*?)\\s*EMC`,'g');
    text=text.replace(marker,(_,body)=>{
      const paints=[...body.matchAll(/\/([^\s\[\]()<>/%]+)\s+Do\b/g)];
      if(paints.length!==1)throw new Error('The image is part of unsupported grouped content.');
      replaced++;return body.replace(paints[0][0],`${name.toString()} Do`);
    });
    refs.push(pdf.context.register(pdf.context.flateStream(Buffer.from(text,'latin1'))));
  }
  if(replaced!==1)throw new Error('Could not isolate this image. The PDF was not changed.');
  page.node.set(PDFName.of('Contents'),pdf.context.obj(refs));
  return new Uint8Array(await pdf.save());
}
module.exports={listOriginalObjects,editOriginalObject};
