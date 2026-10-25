import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Exercise the real controller without installing a DOM emulator. Transpile
// its TS parameter properties; retain the real pure-math module.
const source=(await readFile(new URL('../src/timeline/controller.ts',import.meta.url),'utf8')).replace('"./math"',JSON.stringify(new URL('../src/timeline/math.ts',import.meta.url).href));
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {TimelineController}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
class ElementStub {
 clientWidth=600;scrollLeft=0;style={};dataset={};listeners=new Map();captures=[];releases=[];held=new Set();
 addEventListener(name,fn){this.listeners.set(name,fn);} removeEventListener(name){this.listeners.delete(name);}
 getBoundingClientRect(){return {left:0,width:600,height:80};} closest(){return null;} contains(){return false;}
 setPointerCapture(id){this.captures.push(id);this.held.add(id);} hasPointerCapture(id){return this.held.has(id);} releasePointerCapture(id){this.releases.push(id);this.held.delete(id);}
 emit(name,id,x=0){this.listeners.get(name)?.({button:0,pointerId:id,clientX:x,target:this});}
}
function fixture(t){
 const old={ResizeObserver:globalThis.ResizeObserver,requestAnimationFrame:globalThis.requestAnimationFrame,cancelAnimationFrame:globalThis.cancelAnimationFrame};
 let frame; globalThis.ResizeObserver=class{observe(){}disconnect(){}};globalThis.requestAnimationFrame=callback=>{frame=callback;return 1;};globalThis.cancelAnimationFrame=()=>{};
 const elements=Object.fromEntries(['scroller','sizer','surface','videoLane','playhead','range','startHandle','endHandle','dimLeft','dimRight'].map(key=>[key,new ElementStub()]));
 const video=Object.assign(new ElementStub(),{duration:60,currentTime:0,paused:true,seeking:false,pause(){this.paused=true;},play(){this.paused=false;return Promise.resolve();}});
 const commits=[]; const ctl=new TimelineController(video,elements,{onTrimCommit(...args){commits.push(args);}}); ctl.setTrim(0,60);
 t.after(()=>{ctl.destroy();Object.assign(globalThis,old);});return {ctl,...elements,commits,advanceFrame(){const callback=frame;frame=undefined;callback?.();}};
}
test('a second contact cannot replace the active captured trim pointer',t=>{
 const f=fixture(t);f.surface.emit('pointerdown',1);f.surface.emit('pointerdown',2,100);assert.deepEqual(f.surface.captures,[1]);
 f.surface.emit('pointerup',2,100);assert.equal(f.surface.dataset.dragging,'start');
 f.surface.emit('pointercancel',1);f.surface.emit('pointerdown',3);assert.deepEqual(f.surface.captures,[1,3]);assert.deepEqual(f.surface.releases,[1]);
});
test('only the owning pointer can change and commit a trim',t=>{
 const f=fixture(t);f.surface.emit('pointerdown',1);f.surface.emit('pointerdown',2,300);f.surface.emit('pointermove',2,400);f.advanceFrame();
 f.surface.emit('pointermove',1,100);f.advanceFrame();f.surface.emit('pointerup',1,100);assert.deepEqual(f.commits,[[10,60,'start']]);
});
