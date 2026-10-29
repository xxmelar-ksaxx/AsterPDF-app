const { engine, withDocument, objectText } = require('./original-text.cjs');
const { textGroupObjects } = require('./shaped-text.cjs');
const { saveOriginalDocument } = require('./original-objects.cjs');
function transformPage(p, page, transforms, preview = false) {
  const count = p.FPDFPage_CountObjects(page);
  const originalObjects = Array.from({length:count},(_,index)=>p.FPDFPage_GetObject(page,index));
  const removed = new Set();
  if (!preview) for (let i=0;i<count;i++) if(p.FPDFPageObj_GetType(p.FPDFPage_GetObject(page,i))===4)
    throw new Error('This page contains standalone gradient artwork that the object editor cannot preserve yet. The PDF was not changed.');
  for (const item of transforms) {
    const m=item.matrix;
    if(!Number.isInteger(item.index)||item.index<0||item.index>=count||!Array.isArray(m)||m.length!==6||!m.every(v=>Number.isFinite(v)&&Math.abs(v)<=1e6)||Math.abs(m[0]*m[3]-m[1]*m[2])<1e-8)throw new Error('Invalid object movement.');
    const object=p.FPDFPage_GetObject(page,item.index),type=p.FPDFPageObj_GetType(object);
    if(![1,2,3,5].includes(type))throw new Error('This object cannot be moved.');
    if(item.text!==undefined){
      const textPage=p.FPDFText_LoadPage(page);
      try{if(type!==1||objectText(p,object,textPage)!==item.text)throw new Error('The original text changed. Select it again.');}
      finally{p.FPDFText_ClosePage(textPage);}
    }
    for(const member of type===1?textGroupObjects(p,page,object):[object]){
      if(item.deleted){
        if(preview)p.FPDFPageObj_SetIsActive(member,false);else removed.add(member);
        continue;
      }
      p.FPDFPageObj_Transform(member,...m);p.FPDFPageObj_TransformClipPath(member,...m);
      for(const channel of ['fill','stroke'])if(item[channel]!==undefined){
        const color=item[channel];
        if(!Array.isArray(color)||color.length!==3||!color.every(value=>Number.isInteger(value)&&value>=0&&value<=255))throw new Error('Invalid object color.');
        const ptr=p.pdfium.wasmExports.malloc(16),get=channel==='fill'?'FPDFPageObj_GetFillColor':'FPDFPageObj_GetStrokeColor',set=channel==='fill'?'FPDFPageObj_SetFillColor':'FPDFPageObj_SetStrokeColor';
        try{
          if(!p[get](member,ptr,ptr+4,ptr+8,ptr+12)||!p[set](member,...color,p.pdfium.getValue(ptr+12,'i32')))throw new Error('Could not change this object color.');
        }finally{p.pdfium.wasmExports.free(ptr);}
      }
    }
  }
  // Resolve all original indices before removing anything, so deletion cannot
  // redirect a later edit to the wrong object in the same save batch.
  for(const object of removed){if(!p.FPDFPage_RemoveObject(page,object))throw new Error('Could not delete the object.');p.FPDFPageObj_Destroy(object);}
  const surviving = new Map(Array.from({length:p.FPDFPage_CountObjects(page)},(_,index)=>[p.FPDFPage_GetObject(page,index),index]));
  return originalObjects.map(object=>surviving.get(object)??-1);
}
async function applyOriginalTransforms(bytes,transforms,target){
  if(!Array.isArray(transforms)||transforms.length>20000)throw new Error('Invalid object movements.');
  if(!transforms.length)return target?{bytes,index:target.index}:bytes;
  const p=await engine();
  return withDocument(p,bytes,document=>{
    const pages=new Map();
    let targetIndex=target?.index;
    for(const item of transforms){
      if(!Number.isInteger(item.pageIndex)||item.pageIndex<0||item.pageIndex>=p.FPDF_GetPageCount(document))throw new Error('Invalid object page.');
      if(!pages.has(item.pageIndex))pages.set(item.pageIndex,[]);pages.get(item.pageIndex).push(item);
    }
    for(const [index,items] of pages){
      const page=p.FPDF_LoadPage(document,index);if(!page)throw new Error('Could not read the edited page.');
      try{const mapping=transformPage(p,page,items);if(target?.pageIndex===index)targetIndex=mapping[target.index]??-1;if(!p.FPDFPage_GenerateContent(page))throw new Error('Could not rebuild the edited page.');}
      finally{p.FPDF_ClosePage(page);}
    }
    const result=saveOriginalDocument(p,document);
    return target?{bytes:result,index:targetIndex}:result;
  });
}
module.exports={applyOriginalTransforms,transformPage};
