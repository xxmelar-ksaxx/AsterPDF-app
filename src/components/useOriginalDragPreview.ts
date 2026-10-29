import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import type { PageViewport } from 'pdfjs-dist';
import type { OriginalTransform } from '../types';
import { identity, inverse, multiply, transformFor, editFor } from '../pdf/original-transforms';
export type PreviewBox = { x: number; y: number; width: number; height: number };
export type OriginalDragPreview = ReturnType<typeof useOriginalDragPreview>;
type Entry = { index: number; source: Uint8Array; key: string; promise: Promise<ImageBitmap[]>; images?: ImageBitmap[] };
type Scene = {index:number;source:Uint8Array;key:string;original:HTMLCanvasElement;paints:HTMLCanvasElement[];colorKey?:string;tint?:HTMLCanvasElement};

export default function useOriginalDragPreview(viewport: PageViewport | null, getSourceBytes: () => Uint8Array, pageIndex: number, enabled: boolean,
  pageCanvas: RefObject<HTMLCanvasElement | null>, transforms: OriginalTransform[]) {
  const element = useRef<HTMLDivElement>(null);
  const active = useRef<{ index: number; before: PreviewBox; next: PreviewBox; matrix: number[]; finished: boolean } | null>(null);
  const cache = useRef<Entry | null>(null), scene = useRef<Scene | null>(null);
  const warmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef({ viewport, getSourceBytes, pageIndex, transforms }); latest.current = { viewport, getSourceBytes, pageIndex, transforms };
  const paintedSource = useRef<Uint8Array | null>(null), generation = useRef(0);
  const pageTransforms = () => latest.current.transforms.filter(item => item.pageIndex === latest.current.pageIndex);
  const keyFor = (index: number) => {
    const v=latest.current.viewport;
    return `${v?.width}/${v?.height}/${v?.rotation}/${latest.current.pageIndex}/${JSON.stringify(pageTransforms().filter(item=>item.index!==index))}`;
  };
  const cssMatrix = (index: number) => {
    const {viewport:v,transforms:items,pageIndex:page}=latest.current;
    return v ? multiply(multiply(v.transform,transformFor(items,page,index)),inverse(v.transform)) : identity;
  };
  const hide = () => { element.current?.replaceChildren(); if(element.current)element.current.style.display='none';scene.current=null; };
  const discardCache = () => { cache.current?.images?.forEach(image=>image.close());cache.current=null; };
  const paintMatrix = (matrix: number[]) => {
    const node=element.current,canvas=node?.children[1] as HTMLCanvasElement | undefined;
    if(!canvas)return;
    const current=scene.current;
    if(current){
      const edit=editFor(latest.current.transforms,latest.current.pageIndex,current.index);
      canvas.style.visibility=edit?.deleted?'hidden':'visible';
      const colorKey=JSON.stringify([edit?.fill,edit?.stroke]);
      if(colorKey!==current.colorKey){
        current.colorKey=colorKey;
        const context=canvas.getContext('2d')!;context.clearRect(0,0,canvas.width,canvas.height);
        if((edit?.fill||edit?.stroke)&&current.paints.length===2){
          const tint=current.tint??=document.createElement('canvas');tint.width=canvas.width;tint.height=canvas.height;
          for(const [index,channel] of (['fill','stroke'] as const).entries()){
            const paint=current.paints[index],color=edit?.[channel];
            if(!color){context.drawImage(paint,0,0);continue;}
            const ink=tint.getContext('2d')!;ink.globalCompositeOperation='source-over';ink.clearRect(0,0,tint.width,tint.height);ink.drawImage(paint,0,0);
            ink.globalCompositeOperation='source-in';ink.fillStyle=`rgb(${color.join(',')})`;ink.fillRect(0,0,tint.width,tint.height);
            context.drawImage(tint,0,0);
          }
        }else context.drawImage(current.original,0,0);
      }
    }
    canvas.style.transformOrigin='0 0';canvas.style.transform=`matrix(${matrix.join(',')})`;
    node!.style.display='block';
  };
  const update = (next: PreviewBox) => {
    const drag=active.current;if(!drag)return;drag.next=next;
    const sx=next.width/drag.before.width,sy=next.height/drag.before.height;
    const delta=[sx,0,0,sy,next.x-drag.before.x*sx,next.y-drag.before.y*sy];
    paintMatrix(multiply(delta,element.current?.dataset.phase==='snapshot'?identity:drag.matrix));
  };
  const prepare = (index: number) => {
    const {viewport:v,getSourceBytes:bytes,pageIndex:page}=latest.current;
    if(!v)return Promise.reject(new Error('Page is not ready.'));
    const source=bytes(),key=keyFor(index);
    if(cache.current?.source===source&&cache.current.index===index&&cache.current.key===key)return cache.current.promise;
    const pending=cache.current?.promise;discardCache();
    const entry:Entry={index,source,key,promise:Promise.resolve([])};
    const ratio=Math.min(devicePixelRatio||1,2,Math.sqrt(3_900_000/(v.width*v.height))),items=latest.current.transforms;
    entry.promise=(pending?pending.catch(()=>{}):Promise.resolve()).then(()=>{
      if(cache.current!==entry)throw new Error('Preview changed.');
      return window.aster.previewOriginalObject(source,page,index,Math.max(1,Math.ceil(v.width*ratio)),Math.max(1,Math.ceil(v.height*ratio)),(v.rotation%360+360)%360,items);
    }).then(async layers=>{
      const images:ImageBitmap[]=[];
      try{
        for(const layer of layers)images.push(await createImageBitmap(new Blob([new Uint8Array(layer)],{type:'image/png'})));
        if(cache.current!==entry)throw new Error('Preview changed.');
        entry.images=images;return images;
      }catch(error){images.forEach(image=>image.close());throw error;}
    }).catch(error=>{if(cache.current===entry)cache.current=null;throw error;});
    cache.current=entry;return entry.promise;
  };
  const display = (index: number) => {
    const request=++generation.current,source=latest.current.getSourceBytes(),key=keyFor(index);
    if(scene.current?.index===index&&scene.current.source===source&&scene.current.key===key){
      if(active.current&&!active.current.finished)update(active.current.next);else paintMatrix(cssMatrix(index));return;
    }
    void prepare(index).then(images=>{
      const v=latest.current.viewport,node=element.current;
      if(request!==generation.current||!v||!node||source!==latest.current.getSourceBytes()||key!==keyFor(index))return;
      const canvases=images.map(image=>{
        const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
        canvas.style.width=`${v.width}px`;canvas.style.height=`${v.height}px`;canvas.getContext('2d')!.drawImage(image,0,0);return canvas;
      });
      const original=document.createElement('canvas');original.width=canvases[1].width;original.height=canvases[1].height;original.getContext('2d')!.drawImage(canvases[1],0,0);
      node.replaceChildren(...canvases.slice(0,3));
      node.dataset.phase='isolated';scene.current={index,source,key,original,paints:canvases.slice(3,5)};
      if(active.current&&!active.current.finished)update(active.current.next);else paintMatrix(cssMatrix(index));
    }).catch(()=>{ /* Keep the last usable visual; the document edit remains staged. */ });
  };
  const sync = () => {
    if(active.current&&!active.current.finished)return;
    const items=pageTransforms(),source=latest.current.getSourceBytes();
    if(!items.length){
      // A native content edit/save can replace the source before PDF.js paints.
      if(scene.current&&scene.current.source!==source&&paintedSource.current!==source)return;
      ++generation.current;hide();return;
    }
    const previous=scene.current;
    const index=previous&&previous.source===source&&previous.key===keyFor(previous.index)?previous.index:items[items.length-1].index;
    display(index);
  };
  const begin = (index: number, box: PreviewBox) => {
    clearTimeout(warmTimer.current);
    active.current={index,before:box,next:box,matrix:cssMatrix(index),finished:false};
    const v=latest.current.viewport,source=pageCanvas.current,node=element.current;
    // An immediate snapshot covers a cold selection while isolated artwork is
    // prepared once. Repeated drags reuse the same isolated canvas.
    if(v&&source?.width&&node&&!(scene.current?.index===index&&scene.current.source===latest.current.getSourceBytes()&&scene.current.key===keyFor(index))){
      const ratio=Math.min(source.width/v.width,Math.sqrt(3_900_000/(v.width*v.height)));
      const composed=document.createElement('canvas');composed.width=Math.ceil(v.width*ratio);composed.height=Math.ceil(v.height*ratio);
      const context=composed.getContext('2d')!;context.drawImage(source,0,0,composed.width,composed.height);
      for(const child of Array.from(node.children) as HTMLCanvasElement[]){
        if(child.style.visibility==='hidden')continue;
        context.save();context.scale(ratio,ratio);const m=new DOMMatrix(child.style.transform||undefined);context.transform(m.a,m.b,m.c,m.d,m.e,m.f);
        context.drawImage(child,0,0,v.width,v.height);context.restore();
      }
      const ghost=document.createElement('canvas');ghost.width=composed.width;ghost.height=composed.height;
      ghost.style.width=`${v.width}px`;ghost.style.height=`${v.height}px`;ghost.style.opacity='.65';
      const x=Math.max(0,box.x-2),y=Math.max(0,box.y-2),w=Math.max(0,Math.min(v.width,box.x+box.width+2)-x),h=Math.max(0,Math.min(v.height,box.y+box.height+2)-y);
      if(w&&h)ghost.getContext('2d')!.drawImage(composed,x*ratio,y*ratio,w*ratio,h*ratio,x*ratio,y*ratio,w*ratio,h*ratio);
      composed.style.width=`${v.width}px`;composed.style.height=`${v.height}px`;
      node.replaceChildren(composed,ghost,document.createElement('canvas'));node.dataset.phase='snapshot';scene.current=null;
    }
    display(index);
  };
  const cancel = () => {
    active.current=null;++generation.current;
    if(element.current?.dataset.phase==='snapshot'&&element.current.children[1]) (element.current.children[1] as HTMLCanvasElement).style.opacity='0';
    sync();
  };
  const finish = async (commit:()=>Promise<void>) => {
    if(!active.current)return;
    active.current.finished=true;
    try{await commit();}finally{active.current=null;requestAnimationFrame(sync);}
  };
  useLayoutEffect(()=>{if(!viewport){++generation.current;hide();discardCache();return;}sync();},[transforms,getSourceBytes,viewport?.width,viewport?.height,viewport?.rotation,pageIndex]);
  useEffect(()=>{if(!enabled)clearTimeout(warmTimer.current);},[enabled]);
  useEffect(()=>()=>{clearTimeout(warmTimer.current);++generation.current;active.current=null;hide();discardCache();},[]);
  return {element,begin,update,finish,cancel,
    warm:(index:number)=>{clearTimeout(warmTimer.current);if(!enabled)return;warmTimer.current=setTimeout(()=>{if(!active.current&&latest.current.getSourceBytes().byteLength<64*1024*1024)void prepare(index).catch(()=>{});},120);},
    painted:(source:Uint8Array)=>{paintedSource.current=source;sync();}
  };
}
