import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { objectTransform } from '../src/components/OriginalObjectLayer';

test('object movement and resizing stay aligned on rotated, cropped and zoomed pages',async()=>{
  const pdf=await PDFDocument.create();const page=pdf.addPage([600,500]);page.setCropBox(20,30,560,440);
  const task=getDocument({data:await pdf.save()});const document=await task.promise;
  try{
    const source=await document.getPage(1);
    for(const rotation of [0,90,180,270]){
      const viewport=source.getViewport({scale:1.25,rotation});
      const points=[[80,100],[180,100],[180,170],[80,170]];
      const screen=points.map(p=>viewport.convertToViewportPoint(p[0],p[1]));
      const x=Math.min(...screen.map(p=>p[0])),y=Math.min(...screen.map(p=>p[1]));
      const before={x,y,width:Math.max(...screen.map(p=>p[0]))-x,height:Math.max(...screen.map(p=>p[1]))-y};
      const after={x:x+25,y:y-17,width:before.width*1.4,height:before.height*.7};
      const m=objectTransform(before,after,viewport);
      const moved=points.map(([x,y])=>viewport.convertToViewportPoint(m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]));
      const actual=[Math.min(...moved.map(p=>p[0])),Math.min(...moved.map(p=>p[1])),Math.max(...moved.map(p=>p[0])),Math.max(...moved.map(p=>p[1]))];
      const expected=[after.x,after.y,after.x+after.width,after.y+after.height];
      actual.forEach((value,i)=>assert.ok(Math.abs(value-expected[i])<.00001,`Rotation ${rotation}: ${actual} vs ${expected}`));
    }
  }finally{await task.destroy();}
});
