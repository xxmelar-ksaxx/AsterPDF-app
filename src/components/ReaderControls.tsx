import { useRef, useState } from 'react';
import { ChevronUp, ChevronDown, Plus, Minus } from 'lucide-react';

type Props = { page:number; total:number; zoomLabel:string; disabled:boolean; onPage:(page:number)=>void; onZoom:(direction:number)=>void; onFit:()=>void };
export default function ReaderControls({page,total,zoomLabel,disabled,onPage,onZoom,onFit}:Props) {
  const [draft,setDraft]=useState<string|null>(null);
  const editing=useRef<string|null>(null);
  const finish=(commit:boolean)=>{
    const value=editing.current;editing.current=null;setDraft(null);
    if(!commit||value===null||!/^\d+$/.test(value)||disabled)return;
    onPage(Math.max(1,Math.min(total,Number(value))));
  };
  return <div className="rail-reader-controls" aria-label="Page navigation and zoom">
    <div className="rail-page-control page-control" role="group" aria-label="Page navigation">
      <button onClick={()=>onPage(page-1)} disabled={disabled||page<=1} aria-label="Previous page" title="Previous page"><ChevronUp size={17}/></button>
      {draft===null?<button className="rail-page-number" aria-label="Page number" title="Click to go to a page" disabled={disabled}
        onClick={()=>{editing.current=String(page);setDraft(String(page));}}><strong>{page}</strong></button>
        :<input className="rail-page-input" aria-label="Page number" inputMode="numeric" autoFocus maxLength={6} value={draft}
          onFocus={event=>event.currentTarget.select()}
          onChange={event=>{const next=event.target.value.replace(/[\u0660-\u0669\u06f0-\u06f9]/g,char=>String(char.charCodeAt(0)-(char.charCodeAt(0)>=0x6f0?0x6f0:0x660)));editing.current=next;setDraft(next);}}
          onBlur={()=>finish(true)} onKeyDown={event=>{if(event.key==='Enter'||event.key==='Escape'){event.preventDefault();event.stopPropagation();finish(event.key==='Enter');}}}/>}
      <small className="rail-page-total" title={`${total} pages`} aria-label={`${total} total pages`}>{total}</small>
      <button onClick={()=>onPage(page+1)} disabled={disabled||page>=total} aria-label="Next page" title="Next page"><ChevronDown size={17}/></button>
    </div>
    <div className="rail-zoom-control" role="group" aria-label="Zoom">
      <button onClick={()=>onZoom(1)} disabled={disabled} aria-label="Zoom in" title="Zoom in (Alt/Option + scroll)"><Plus size={17}/></button>
      <button className="zoom-label" onClick={onFit} disabled={disabled} aria-label="Fit width" title={`${zoomLabel} · Click to fit width`}>{zoomLabel}</button>
      <button onClick={()=>onZoom(-1)} disabled={disabled} aria-label="Zoom out" title="Zoom out (Alt/Option + scroll)"><Minus size={17}/></button>
    </div>
  </div>;
}
