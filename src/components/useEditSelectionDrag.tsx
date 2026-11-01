import { useEffect, useRef, useState, type PointerEvent, type MouseEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Scissors, Trash2 } from 'lucide-react';
import type { PageViewport } from 'pdfjs-dist';
import type { EditSelection } from '../types';
import type { OverlayObject } from '../pdf/overlays';
import type { OriginalDragPreview, PreviewBox } from './useOriginalDragPreview';

export default function useEditSelectionDrag({selection,pageId,viewport,stage,overlays,preview,disabled,onMove,onCopy,onDelete,onError}:{
  selection:EditSelection[];pageId:string;viewport:PageViewport|null;stage:RefObject<HTMLDivElement|null>;overlays:OverlayObject[];
  preview:OriginalDragPreview;disabled:boolean;onMove:(dx:number,dy:number)=>Promise<void>;onCopy:(cut?:boolean)=>void;onDelete:()=>void;onError:(message:string)=>void;
}) {
  const [offset,setOffset]=useState<{x:number;y:number}|null>(null);
  const [menu,setMenu]=useState<{x:number;y:number}|null>(null);
  const drag=useRef<{x:number;y:number;dx:number;dy:number;elements:{node:SVGElement;transform:string}[];pointer:number}|null>(null);
  const suppressClick=useRef(false);
  const local=selection.filter(s=>s.pageId===pageId);
  const native=local.filter(s=>s.kind==='native');
  const boxes:PreviewBox[]=viewport?local.flatMap(s=>{
    if(s.kind==='native'){const a=viewport.convertToViewportPoint(s.box[0],s.box[1]),b=viewport.convertToViewportPoint(s.box[2],s.box[3]);return [{x:Math.min(a[0],b[0]),y:Math.min(a[1],b[1]),width:Math.abs(b[0]-a[0]),height:Math.abs(b[1]-a[1])}];}
    const o=overlays.find(o=>o.id===s.id);return o?[{x:o.x*viewport.width,y:o.y*viewport.height,width:o.width*viewport.width,height:o.height*viewport.height}]:[];
  }):[];
  const matches=(target:EventTarget|null)=>{
    if(!(target instanceof Element))return false;
    if(target.closest('.edit-selection-frame'))return true;
    const overlay=target.closest('[data-overlay-id]')?.getAttribute('data-overlay-id');
    const index=target.closest('[data-original-object]')?.getAttribute('data-original-object')??target.closest('[data-original-text-index]')?.getAttribute('data-original-text-index');
    return local.some(s=>s.kind==='overlay'?s.id===overlay:index!==undefined&&index!==null&&s.index===Number(index));
  };
  const restore=()=>{for(const item of drag.current?.elements||[])item.node.style.transform=item.transform;drag.current=null;setOffset(null);};
  const cancel=()=>{if(!drag.current)return;preview.cancelGroup();restore();};
  useEffect(()=>{
    if(selection.length<2||disabled){setMenu(null);cancel();return;}
    if(native.length)preview.warmGroup(native.map(s=>s.index));
  },[JSON.stringify(selection),disabled,viewport?.width,viewport?.height]);
  useEffect(()=>{
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'&&drag.current){event.preventDefault();event.stopImmediatePropagation();cancel();}else if(event.key==='Escape')setMenu(null);};
    const outside=(event:globalThis.PointerEvent)=>{if(!(event.target as Element).closest('.edit-selection-menu'))setMenu(null);};
    window.addEventListener('keydown',key,true);window.document.addEventListener('pointerdown',outside);
    return()=>{window.removeEventListener('keydown',key,true);window.document.removeEventListener('pointerdown',outside);};
  });
  useEffect(()=>()=>{for(const item of drag.current?.elements||[])item.node.style.transform=item.transform;},[]);
  const down=(event:PointerEvent<HTMLDivElement>)=>{
    if(disabled||!viewport||selection.length<2||event.button!==0||event.ctrlKey||event.metaKey||!matches(event.target))return;
    event.preventDefault();event.stopPropagation();setMenu(null);suppressClick.current=true;
    if(document.activeElement instanceof HTMLElement)document.activeElement.blur();window.getSelection()?.removeAllRanges();
    const elements=Array.from(stage.current?.querySelectorAll<SVGElement>('[data-overlay-id],[data-original-object],[data-original-text-index],[data-selected-original]')||[]).filter(node=>local.some(s=>s.kind==='overlay'?s.id===node.dataset.overlayId:String(s.index)===(node.dataset.originalObject??node.dataset.originalTextIndex??node.dataset.selectedOriginal))).map(node=>({node,transform:node.style.transform}));
    drag.current={x:event.clientX,y:event.clientY,dx:0,dy:0,elements,pointer:event.pointerId};
    if(native.length)preview.beginGroup(native.map(s=>s.index),boxes);
    setOffset({x:0,y:0});event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move=(event:PointerEvent<HTMLDivElement>)=>{
    const current=drag.current;if(!current)return;event.preventDefault();event.stopPropagation();
    current.dx=event.clientX-current.x;current.dy=event.clientY-current.y;
    setOffset({x:current.dx,y:current.dy});preview.updateGroup(current.dx,current.dy);
    for(const {node,transform} of current.elements)node.style.transform=`translate(${current.dx}px,${current.dy}px) ${transform}`;
  };
  const up=(event:PointerEvent<HTMLDivElement>)=>{
    const current=drag.current;if(!current||!viewport)return;event.preventDefault();event.stopPropagation();
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
    if(Math.hypot(current.dx,current.dy)<2){cancel();return;}
    void preview.finishGroup(()=>onMove(current.dx/viewport.scale,current.dy/viewport.scale)).catch(e=>onError(`Could not move selection: ${e.message}`)).finally(restore);
  };
  const context=(event:MouseEvent<HTMLDivElement>)=>{
    if(disabled||selection.length<2||!matches(event.target))return false;
    event.preventDefault();event.stopPropagation();setMenu({x:Math.max(8,Math.min(innerWidth-200,event.clientX)),y:Math.max(8,Math.min(innerHeight-130,event.clientY))});return true;
  };
  const click=(event:MouseEvent<HTMLDivElement>)=>{if(suppressClick.current){suppressClick.current=false;event.preventDefault();event.stopPropagation();}};
  const x=Math.min(...boxes.map(b=>b.x)),y=Math.min(...boxes.map(b=>b.y));
  const right=Math.max(...boxes.map(b=>b.x+b.width)),bottom=Math.max(...boxes.map(b=>b.y+b.height));
  const frame=selection.length>1&&boxes.length&&viewport?<svg className="edit-selection-frame" width={viewport.width} height={viewport.height} aria-label="Selected objects" style={{transform:`translate(${offset?.x||0}px,${offset?.y||0}px)`}}>
    <rect x={x-4} y={y-4} width={right-x+8} height={bottom-y+8}/>
  </svg>:null;
  const popup=menu?createPortal(<div className="image-context-menu edit-selection-menu" role="menu" aria-label="Selection actions" style={{left:menu.x,top:menu.y}}>
    <button role="menuitem" onClick={()=>{onCopy();setMenu(null);}}><Copy size={15}/>Copy selection</button>
    <button role="menuitem" onClick={()=>{onCopy(true);setMenu(null);}}><Scissors size={15}/>Cut selection</button>
    <button role="menuitem" onClick={()=>{onDelete();setMenu(null);}}><Trash2 size={15}/>Delete selection</button>
  </div>,document.body):null;
  return {down,move,up,cancel,context,click,frame,popup};
}
