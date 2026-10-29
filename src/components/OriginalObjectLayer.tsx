import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { ImagePlus, Trash2 } from 'lucide-react';
import type { PageViewport } from 'pdfjs-dist';
import type { OriginalPdfObject, OriginalObjectChange, OriginalObjectSelection } from '../types';
import { resizeImage, type ResizeHandle } from '../pdf/image-geometry';

type Box = { x: number; y: number; width: number; height: number };
const label = (object: OriginalPdfObject) => ({ image: 'Image', shape: 'Shape', bullet: 'Bullet', group: 'Grouped artwork' })[object.kind];
function objectBox(object: OriginalPdfObject, viewport: PageViewport): Box {
  const a=viewport.convertToViewportPoint(object.box[0],object.box[1]),b=viewport.convertToViewportPoint(object.box[2],object.box[3]);
  return {x:Math.min(a[0],b[0]),y:Math.min(a[1],b[1]),width:Math.max(1,Math.abs(b[0]-a[0])),height:Math.max(1,Math.abs(b[1]-a[1]))};
}
export function objectTransform(before: Box, after: Box, viewport: PageViewport) {
  const sx=after.width/before.width,sy=after.height/before.height;
  const transform=(x:number,y:number)=>{const p=viewport.convertToViewportPoint(x,y);return viewport.convertToPdfPoint(after.x+(p[0]-before.x)*sx,after.y+(p[1]-before.y)*sy);};
  const zero=transform(0,0),x=transform(1,0),y=transform(0,1);
  return [x[0]-zero[0],x[1]-zero[1],y[0]-zero[0],y[1]-zero[1],...zero];
}

export default function OriginalObjectLayer({enabled,busy,getSourceBytes,pageId,pageIndex,viewport,selection,onSelect,onChange,onError}: {
  enabled:boolean;busy:boolean;getSourceBytes:()=>Uint8Array;pageId:string;pageIndex:number;viewport:PageViewport;
  selection:OriginalObjectSelection|null;onSelect:(selection:OriginalObjectSelection|null)=>void;
  onChange:(selection:OriginalObjectSelection,change:OriginalObjectChange)=>Promise<void>;onError:(message:string)=>void;
}) {
  const [objects,setObjects]=useState<OriginalPdfObject[]>([]);
  const [preview,setPreview]=useState<Box|null>(null);
  const [menu,setMenu]=useState<{x:number;y:number;object:OriginalPdfObject}|null>(null);
  const input=useRef<HTMLInputElement>(null);
  const replacement=useRef<OriginalPdfObject|null>(null);
  const drag=useRef<{object:OriginalPdfObject;box:Box;next:Box;x:number;y:number;handle?:ResizeHandle}|null>(null);
  const selected=selection?.pageId===pageId?objects.find(object=>object.id===selection.object.id):undefined;
  const target=(object:OriginalPdfObject)=>({pageId,pageIndex,object});
  useEffect(()=>{
    let cancelled=false;setObjects([]);setPreview(null);drag.current=null;setMenu(null);
    if(enabled)void window.aster.listOriginalObjects(getSourceBytes(),pageIndex).then(items=>{if(!cancelled)setObjects(items);})
      .catch(error=>{if(!cancelled)onError(`Could not inspect page objects: ${error instanceof Error?error.message:String(error)}`);});
    return()=>{cancelled=true;};
  },[enabled,getSourceBytes,pageIndex,onError]);
  useEffect(()=>{
    if(!menu)return;
    const dismiss=(event:globalThis.PointerEvent)=>{if(!(event.target as Element).closest('[data-original-object-menu]'))setMenu(null);};
    window.addEventListener('pointerdown',dismiss);return()=>window.removeEventListener('pointerdown',dismiss);
  },[menu]);
  useEffect(()=>{
    if(!selected||!enabled)return;
    const key=(event:KeyboardEvent)=>{
      if(busy||event.defaultPrevented||event.ctrlKey||event.metaKey||event.altKey||(event.target as Element).closest('input,textarea,[contenteditable="true"],dialog'))return;
      if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();void onChange(target(selected),{type:'delete'});}
      else if(event.key==='Escape'){event.preventDefault();onSelect(null);setMenu(null);}
    };
    window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
  },[selected,enabled,busy,onChange,onSelect,pageId,pageIndex]);
  if(!enabled)return null;
  const begin=(event:PointerEvent<SVGElement>,object:OriginalPdfObject,handle?:ResizeHandle)=>{
    if(event.button!==0||busy)return;event.preventDefault();event.stopPropagation();window.getSelection()?.removeAllRanges();setMenu(null);
    onSelect(target(object));const box=objectBox(object,viewport);
    drag.current={object,box,next:box,x:event.clientX,y:event.clientY,handle};event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move=(event:PointerEvent<SVGElement>)=>{
    const active=drag.current;if(!active)return;
    const dx=event.clientX-active.x,dy=event.clientY-active.y;
    if(Math.hypot(dx,dy)<2&&!preview)return;
    active.next=active.handle?resizeImage(active.box,active.handle,dx,dy,event.shiftKey):{...active.box,x:active.box.x+dx,y:active.box.y+dy};
    setPreview(active.next);
  };
  const end=(event:PointerEvent<SVGElement>)=>{
    const active=drag.current;drag.current=null;setPreview(null);
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
    if(!active||active.box===active.next)return;
    void onChange(target(active.object),{type:'transform',matrix:objectTransform(active.box,active.next,viewport)});
  };
  const box=selected?(preview||objectBox(selected,viewport)):null;
  const frame=box?{x:box.x-Math.max(0,24-box.width)/2,y:box.y-Math.max(0,24-box.height)/2,width:Math.max(24,box.width),height:Math.max(24,box.height)}:null;
  const context=(event:React.MouseEvent,object:OriginalPdfObject)=>{
    if(busy)return;event.preventDefault();event.stopPropagation();onSelect(target(object));
    setMenu({object,x:Math.max(8,Math.min(innerWidth-205,event.clientX)),y:Math.max(8,Math.min(innerHeight-95,event.clientY))});
  };
  return <>
    <svg className="original-object-layer" width={viewport.width} height={viewport.height} aria-label="Original PDF objects"
      onPointerMove={move} onPointerUp={end} onPointerCancel={()=>{drag.current=null;setPreview(null);}} onDragStart={event=>event.preventDefault()}>
      {objects.map(object=>{
        const b=objectBox(object,viewport);
        return <g key={object.id} data-original-object={object.id} data-object-kind={object.kind} aria-label={`Original ${label(object).toLowerCase()}`}
          onPointerDown={event=>begin(event,object)} onContextMenu={event=>context(event,object)}>
          <title>{object.kind==='group'?'Grouped artwork · move and resize as one object':label(object)}</title>
          {object.shape?<path className="original-object-hit" d={object.shape} transform={`matrix(${viewport.transform.join(' ')})`}
            style={{pointerEvents:object.fill?'all':'stroke'}} fill={object.fill?'transparent':'none'} stroke="transparent" strokeWidth={Math.max(object.strokeWidth,6/viewport.scale)} />:
            <rect className="original-object-hit" {...b} fill="transparent" />}
        </g>;
      })}
    </svg>
    {selected&&box&&frame&&<svg className="original-object-frame" width={viewport.width} height={viewport.height} aria-label="Selected original object"
      onPointerMove={move} onPointerUp={end} onPointerCancel={()=>{drag.current=null;setPreview(null);}}>
      <rect {...frame} className="original-object-outline" onPointerDown={event=>begin(event,selected)} onContextMenu={event=>context(event,selected)} />
      {(['nw','n','ne','e','se','s','sw','w'] as ResizeHandle[]).map(handle=>{
        const x=frame.x+(handle.includes('e')?frame.width:handle.includes('w')?0:frame.width/2);
        const y=frame.y+(handle.includes('s')?frame.height:handle.includes('n')?0:frame.height/2);
        return <rect key={handle} data-original-resize={handle} className={`image-resize-handle resize-${handle}`} x={x-4} y={y-4} width={8} height={8}
          onPointerDown={event=>begin(event,selected,handle)} />;
      })}
    </svg>}
    {menu&&createPortal(<div className="image-context-menu" data-original-object-menu role="menu" aria-label="Original object actions" style={{left:menu.x,top:menu.y}}>
      {menu.object.kind==='image'&&<button role="menuitem" onClick={()=>{replacement.current=menu.object;setMenu(null);input.current?.click();}}><ImagePlus size={15}/>Replace image…</button>}
      <button role="menuitem" onClick={()=>{void onChange(target(menu.object),{type:'delete'});setMenu(null);}}><Trash2 size={15}/>Delete {label(menu.object).toLowerCase()}</button>
    </div>,document.body)}
    <input ref={input} hidden type="file" accept="image/png,image/jpeg,image/webp" aria-label="Replace original image" onChange={async event=>{
      const file=event.target.files?.[0],object=replacement.current;event.target.value='';if(!file||!object)return;
      try{
        const bitmap=await createImageBitmap(file);
        try{
          if(bitmap.width*bitmap.height>40_000_000)throw new Error('Choose an image with fewer than 40 million pixels.');
          const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext('2d')!.drawImage(bitmap,0,0);
          const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Could not read the image.')),'image/png'));
          await onChange(target(object),{type:'replace-image',png:new Uint8Array(await blob.arrayBuffer())});
        }finally{bitmap.close();}
      }catch(error){onError(`Could not replace image: ${error instanceof Error?error.message:String(error)}`);}
    }}/>
  </>;
}
