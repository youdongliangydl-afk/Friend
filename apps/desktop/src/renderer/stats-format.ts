/** DSH display rules: compact counts and partial cache hits never rounded to 100%. */
export function compactTokens(value:number){const scaled=(n:number)=>String(n>=100?Math.round(n):Math.round(n*10)/10);return value<1000?String(value):value<1000000?scaled(value/1000)+'K':scaled(value/1000000)+'M';}
export function cachePercent(hit:number,input:number):string|null{
 if(!Number.isSafeInteger(hit)||!Number.isSafeInteger(input)||input<=0||hit<0||hit>input)return null;
 const numerator=BigInt(hit),denominator=BigInt(input);
 for(let places=0;places<=16;places++){
  const scale=10n**BigInt(places),units=(numerator*200n*scale+denominator)/(2n*denominator);
  if(units<100n*scale||hit===input){if(!places)return String(units);return `${units/scale}.${String(units%scale).padStart(places,'0')}`.replace(/0+$/,'').replace(/\.$/,'');}
 }
 return null;
}
export function statsDuration(ms:number){const seconds=ms/1000;if(seconds<60)return `${Math.round(seconds*10)/10}秒`;const whole=Math.round(seconds);return `${Math.floor(whole/60)}分${whole%60}秒`;}
export function decodeSpeed(tokens:number,ms:number){if(ms<=0)return null;const speed=tokens/(ms/1000);return `${speed>=10?Math.round(speed):Math.round(speed*10)/10} tok/s`;}
/** Header details open below, composer details above; flip when the viewport requires it. */
export function statsPanelPosition(anchor:{left:number;right?:number;top:number;bottom?:number},panel:{width:number;height:number},viewport:{width:number;height:number},topMargin=12,placement:'above'|'below'='above'){
 const above=anchor.top-8-panel.height,below=(anchor.bottom??anchor.top)+8;
 let top=placement==='above'?above:below;
 if(placement==='above'&&above<topMargin&&below+panel.height<=viewport.height-12)top=below;
 if(placement==='below'&&below+panel.height>viewport.height-12&&above>=topMargin)top=above;
 const left=placement==='below'&&anchor.right!==undefined?anchor.right-panel.width:anchor.left;
 return {left:Math.max(12,Math.min(left,viewport.width-panel.width-12)),top:Math.max(topMargin,Math.min(top,viewport.height-panel.height-12))};
}
