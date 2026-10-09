/** Preview placement adapted from DeepSeek Harness HoverCard at 4878cda; see third-party/deepseek-harness. */
export function changePreviewPosition(anchor:{top:number;bottom:number},bounds:{left:number;width:number},height:number,viewport:{width:number;height:number},topMargin:number){
 const width=Math.max(0,Math.min(bounds.width-48,viewport.width-16));
 const belowTop=Math.max(topMargin,anchor.bottom+8),above=Math.max(0,anchor.top-8-topMargin),below=Math.max(0,viewport.height-belowTop-8);
 const onTop=above>=Math.min(420,below),maxHeight=Math.min(420,onTop?above:below);
 return {left:Math.max(8,Math.min(bounds.left+24,viewport.width-width-8)),top:onTop?Math.max(topMargin,anchor.top-Math.min(height,maxHeight)-8):belowTop,width,maxHeight};
}
