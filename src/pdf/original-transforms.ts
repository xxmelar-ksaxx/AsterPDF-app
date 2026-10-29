import type { OriginalPdfObject, OriginalPdfText, OriginalTransform } from '../types';
export const identity = [1, 0, 0, 1, 0, 0];
export function multiply(a: number[], b: number[]) {
  return [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
}
export function inverse(m: number[]) {
  const d=m[0]*m[3]-m[1]*m[2];
  return [m[3]/d,-m[1]/d,-m[2]/d,m[0]/d,(m[2]*m[5]-m[3]*m[4])/d,(m[1]*m[4]-m[0]*m[5])/d];
}
export const transformFor = (items: OriginalTransform[], pageIndex: number, index: number) => items.find(item=>item.pageIndex===pageIndex&&item.index===index)?.matrix ?? identity;
export function transformedBox(box: number[], m: number[]) {
  const points=[[box[0],box[1]],[box[2],box[1]],[box[2],box[3]],[box[0],box[3]]].map(([x,y])=>[m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]]);
  return [Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))];
}
export const editFor = (items: OriginalTransform[], pageIndex: number, index: number) => items.find(item=>item.pageIndex===pageIndex&&item.index===index);
export const isOriginalDeleted = (items: OriginalTransform[], pageIndex: number, index: number) => !!editFor(items,pageIndex,index)?.deleted;
export const transformedObject = (object: OriginalPdfObject, transforms: OriginalTransform[], page: number) => ({...object,box:transformedBox(object.box,transformFor(transforms,page,Number(object.id))),
  fill: editFor(transforms,page,Number(object.id))?.fill ? [...editFor(transforms,page,Number(object.id))!.fill!, object.fill?.[3] ?? 255] : object.fill,
  stroke: editFor(transforms,page,Number(object.id))?.stroke ? [...editFor(transforms,page,Number(object.id))!.stroke!, object.stroke?.[3] ?? 255] : object.stroke });
export const transformedText = (text: OriginalPdfText, transforms: OriginalTransform[], page: number) => {
  const matrix=transformFor(transforms,page,text.index);
  return {...text,color:editFor(transforms,page,text.index)?.fill ? [...editFor(transforms,page,text.index)!.fill!,text.color[3]] : text.color,box:transformedBox(text.box,matrix),matrix:multiply(matrix,text.matrix)};
};
export function stageTransform(items: OriginalTransform[], next: OriginalTransform) {
  const matrix=multiply(next.matrix,transformFor(items,next.pageIndex,next.index));
  return [...items.filter(item=>item.pageIndex!==next.pageIndex||item.index!==next.index),{...editFor(items,next.pageIndex,next.index),...next,matrix}];
}

export function stageObjectPatch(items: OriginalTransform[], pageIndex: number, index: number, patch: Partial<OriginalTransform>) {
  return [...items.filter(item=>item.pageIndex!==pageIndex||item.index!==index),
    {matrix:identity,...editFor(items,pageIndex,index),...patch,pageIndex,index}];
}
