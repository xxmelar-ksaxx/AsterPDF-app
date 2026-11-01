import { useEffect, useRef, useState, type MouseEvent, type PointerEvent, type RefObject } from 'react';
import type { EditSelection } from '../types';

export type SelectionCandidate = { selection: EditSelection; x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };
const key = (item: EditSelection) => item.kind === 'overlay' ? item.id : `${item.pageId}:${item.index}`;

export default function useMarqueeSelection({enabled,stage,width,height,candidates,selection,onSelect}:{
  enabled:boolean;stage:RefObject<HTMLDivElement|null>;width:number;height:number;candidates:SelectionCandidate[];
  selection:EditSelection[];onSelect:(items:EditSelection[])=>void;
}) {
  const gesture=useRef<{pointer:number;start:Point;end:Point;base:EditSelection[];additive:boolean;candidates:SelectionCandidate[];moved:boolean}|null>(null);
  const [box,setBox]=useState<{x:number;y:number;width:number;height:number}|null>(null);
  const [hits,setHits]=useState<SelectionCandidate[]>([]);
  const suppressClick=useRef(false);
  const point=(event:{clientX:number;clientY:number}):Point=>{
    const bounds=stage.current!.getBoundingClientRect();
    return {x:Math.max(0,Math.min(width,(event.clientX-bounds.left)*width/bounds.width)),y:Math.max(0,Math.min(height,(event.clientY-bounds.top)*height/bounds.height))};
  };
  const release=(pointer:number)=>{if(stage.current?.hasPointerCapture(pointer))stage.current.releasePointerCapture(pointer);};
  const cancel=(restore=true)=>{
    const current=gesture.current;if(!current)return;
    gesture.current=null;setBox(null);setHits([]);release(current.pointer);
    if(restore)onSelect(current.base);
  };
  useEffect(()=>{if(gesture.current)cancel(enabled);},[enabled,width,height]);
  useEffect(()=>{
    const keyDown=(event:KeyboardEvent)=>{if(event.key==='Escape'&&gesture.current){event.preventDefault();event.stopImmediatePropagation();cancel();}};
    window.addEventListener('keydown',keyDown,true);return()=>window.removeEventListener('keydown',keyDown,true);
  });
  const down=(event:PointerEvent<HTMLDivElement>)=>{
    if(!enabled||event.button!==0||!stage.current)return false;
    const target=event.target as Element;
    if(target.closest('[data-original-object],[data-original-text-index],[data-overlay-id],.original-object-frame,.edit-selection-frame,.editable-signature,.comment-pin,.pending-pin,.pdf-video,button,input,textarea,[contenteditable],a'))return false;
    // Let the existing click-away handler finish an active inline edit first.
    if(stage.current.querySelector('.original-text-editor'))return false;
    event.preventDefault();event.stopPropagation();
    if(document.activeElement instanceof HTMLElement)document.activeElement.blur();window.getSelection()?.removeAllRanges();
    const start=point(event),additive=event.ctrlKey||event.metaKey;
    gesture.current={pointer:event.pointerId,start,end:start,base:selection,additive,candidates,moved:false};
    suppressClick.current=true;
    if(!additive)onSelect([]);
    event.currentTarget.setPointerCapture(event.pointerId);return true;
  };
  const update=(event:PointerEvent<HTMLDivElement>)=>{
    const current=gesture.current;if(!current||current.pointer!==event.pointerId)return false;
    event.preventDefault();event.stopPropagation();current.end=point(event);
    if(!current.moved&&Math.hypot(current.end.x-current.start.x,current.end.y-current.start.y)<4)return true;
    current.moved=true;
    const rect={x:Math.min(current.start.x,current.end.x),y:Math.min(current.start.y,current.end.y),width:Math.abs(current.start.x-current.end.x),height:Math.abs(current.start.y-current.end.y)};
    const found=current.candidates.filter(c=>c.x>=rect.x-1&&c.y>=rect.y-1&&c.x+c.width<=rect.x+rect.width+1&&c.y+c.height<=rect.y+rect.height+1);
    setBox(rect);setHits(found);return true;
  };
  const up=(event:PointerEvent<HTMLDivElement>)=>{
    const current=gesture.current;if(!current||current.pointer!==event.pointerId)return false;
    update(event);gesture.current=null;release(current.pointer);setBox(null);setHits([]);
    const rect={left:Math.min(current.start.x,current.end.x),top:Math.min(current.start.y,current.end.y),right:Math.max(current.start.x,current.end.x),bottom:Math.max(current.start.y,current.end.y)};
    const found=current.moved?current.candidates.filter(c=>c.x>=rect.left-1&&c.y>=rect.top-1&&c.x+c.width<=rect.right+1&&c.y+c.height<=rect.bottom+1).map(c=>c.selection):[];
    const merged=new Map((current.additive?current.base:[]).map(item=>[key(item),item]));for(const item of found)merged.set(key(item),item);
    onSelect([...merged.values()]);return true;
  };
  const click=(event:MouseEvent<HTMLDivElement>)=>{if(!suppressClick.current)return false;suppressClick.current=false;event.preventDefault();event.stopPropagation();return true;};
  const pointerCancel=()=>{if(!gesture.current)return false;suppressClick.current=false;cancel();return true;};
  const visual=box?<svg className="edit-marquee" width={width} height={height} aria-label="Selection box">
    {hits.map(hit=><rect key={key(hit.selection)} className="edit-marquee-hit" x={hit.x} y={hit.y} width={hit.width} height={hit.height}/>)}
    <rect className="edit-marquee-box" {...box}/>
  </svg>:null;
  return {down,move:update,up,click,cancel:pointerCancel,visual};
}
