import { t } from '../i18n';
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
  return <div className="rail-reader-controls" aria-label={t("Page navigation and zoom")}>
    <div className="rail-page-control page-control" role="group" aria-label={t("Page navigation")}>
      <button onClick={()=>onPage(page-1)} disabled={disabled||page<=1} aria-label={t("Previous page")} title={t("Previous page")}><ChevronUp size={17}/></button>
      {draft===null?<button className="rail-page-number" aria-label={t("Page number")} title={t("Click to go to a page")} disabled={disabled}
        onClick={()=>{editing.current=String(page);setDraft(String(page));}}><strong>{page}</strong></button>
        :<input className="rail-page-input" aria-label={t("Page number")} inputMode="numeric" autoFocus maxLength={6} value={draft}
          onFocus={event=>event.currentTarget.select()}
          onChange={event=>{const next=event.target.value.replace(/[\u0660-\u0669\u06f0-\u06f9]/g,char=>String(char.charCodeAt(0)-(char.charCodeAt(0)>=0x6f0?0x6f0:0x660)));editing.current=next;setDraft(next);}}
          onBlur={()=>finish(true)} onKeyDown={event=>{if(event.key==='Enter'||event.key==='Escape'){event.preventDefault();event.stopPropagation();finish(event.key==='Enter');}}}/>}
      <small className="rail-page-total" title={t("{0} pages", total)} aria-label={t("{0} total pages", total)}>{total}</small>
      <button onClick={()=>onPage(page+1)} disabled={disabled||page>=total} aria-label={t("Next page")} title={t("Next page")}><ChevronDown size={17}/></button>
    </div>
    <div className="rail-zoom-control" role="group" aria-label={t("Zoom")}>
      <button onClick={()=>onZoom(1)} disabled={disabled} aria-label={t("Zoom in")} title={t("Zoom in (Alt/Option + scroll)")}><Plus size={17}/></button>
      <button className="zoom-label" onClick={onFit} disabled={disabled} aria-label={t("Fit width")} title={t("{0} · Click to fit width", t(zoomLabel))}>{t(zoomLabel)}</button>
      <button onClick={()=>onZoom(-1)} disabled={disabled} aria-label={t("Zoom out")} title={t("Zoom out (Alt/Option + scroll)")}><Minus size={17}/></button>
    </div>
  </div>;
}
