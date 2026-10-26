import {useRef} from 'react';
/**
 * `scale` multiplies the pointer travel only. A centred column moves its edge at half
 * the pointer speed, so `scale={2}` keeps the grabbed edge under the cursor.
 * Keyboard steps stay at a fixed 10px.
 */
export function ResizeHandle({name,value,min,max,reverse=false,scale=1,onChange,className}:{name:string;value:number;min:number;max:number;reverse?:boolean;scale?:number;onChange(value:number):void;className:string}) {
  const drag=useRef<{x:number;value:number}|null>(null);
  const clamp=(next:number)=>Math.round(Math.min(max,Math.max(min,next)));
  return <div className={`resize-handle ${className}`} role="separator" aria-orientation="vertical" aria-label={name}
    tabIndex={0} aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} title={`${name}：拖动或使用左右方向键调整`}
    onPointerDown={event=>{if(event.button!==0)return;drag.current={x:event.clientX,value};event.currentTarget.setPointerCapture(event.pointerId);event.preventDefault();}}
    onPointerMove={event=>{if(drag.current)onChange(clamp(drag.current.value+(event.clientX-drag.current.x)*(reverse?-1:1)*scale));}}
    onPointerUp={event=>{drag.current=null;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}}
    onPointerCancel={()=>{drag.current=null;}}
    onKeyDown={event=>{const delta=event.key==='ArrowLeft'?-10:event.key==='ArrowRight'?10:0;if(event.key==='Home')onChange(min);else if(event.key==='End')onChange(max);else if(delta)onChange(clamp(value+delta*(reverse?-1:1)));else return;event.preventDefault();}}><span/></div>;
}
