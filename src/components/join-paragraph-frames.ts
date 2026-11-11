import type { Paragraph } from '../pdf/paragraphs';
import { textSize, type OverlayObject } from '../pdf/overlays';
import type { InstalledFont } from './FontPicker';
import { textOverlayLayout } from './text-overlay-size';

// Native blocks already have their source baseline bounds. For edited frames use
// their actual layout, since an earlier edit may have added or removed lines.
export function joinParagraphFrames(native:Paragraph[], overlays:OverlayObject[], width:number, height:number, fonts:InstalledFont[]):Paragraph[] {
  const editable = overlays.filter(o=>o.kind==='text' && o.textSizing==='paragraph' && !o.hidden && !o.locked && o.editingTool!=='draw');
  if (!editable.length) return native;
  const frames:Paragraph[] = native.concat(editable.map(object=>{
    const layout = textOverlayLayout(object,width,fonts);
    return {sources:[],overlayIds:[object.id],object:{...object,height:((layout.lines.at(-1)?.offsetY || 0)+textSize(object))/height}};
  })).sort((a,b)=>a.object.y-b.object.y);
  const result:Paragraph[] = [];
  for (const frame of frames) {
    const next = frame.object;
    const size = textSize(next);
    const above = result.filter(candidate=>{
      const prev = candidate.object;
      const overlap = Math.min(prev.x+prev.width,next.x+next.width)-Math.max(prev.x,next.x);
      return next.y>prev.y && overlap > Math.min(prev.width,next.width)*.45;
    }).sort((a,b)=>b.object.y-a.object.y)[0];
    if (above && (above.overlayIds?.length || frame.overlayIds?.length)) {
      const prev = above.object;
      const step = (next.y-prev.y-prev.height)*height + size;
      const leading = size*(prev.lineSpacing ?? 1.4);
      const gap = step-leading;
      const aligned = Math.min(Math.abs(prev.x-next.x),Math.abs(prev.x+prev.width-next.x-next.width))*width <= size;
      const sameStyle = prev.fontChoice===next.fontChoice && Math.abs(textSize(prev)-size)<.15 && prev.color===next.color &&
        (prev.opacity??1)===(next.opacity??1) && prev.textAlign===next.textAlign &&
        Math.abs((prev.lineSpacing??1.4)-(next.lineSpacing??1.4))<.2 &&
        (['bold','italic','underline','strikeThrough'] as const).every(key=>Boolean(prev[key])===Boolean(next[key]));
      if (aligned && sameStyle && gap >= -size*.35 && gap <= size*2.2 && (prev.text?.length||0)+(next.text?.length||0)<10000) {
        const left = Math.min(prev.x,next.x);
        above.object = {...prev, x:left, width:Math.max(prev.x+prev.width,next.x+next.width)-left,
          height:next.y+next.height-prev.y, text:prev.text+'\n'+next.text,
          paragraphGap:next.paragraphGap ?? prev.paragraphGap ?? Math.max(0,Math.round(gap*100)/100),breakSpacing:undefined};
        above.sources = [...above.sources,...frame.sources];
        above.overlayIds = [...(above.overlayIds||[]),...(frame.overlayIds||[])];
        continue;
      }
    }
    result.push({...frame});
  }
  // Unmerged overlay frames already provide their own edit surface.
  return result.filter(frame=>frame.sources.length || (frame.overlayIds?.length||0)>1);
}
