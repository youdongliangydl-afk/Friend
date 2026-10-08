export function materialPath(url:string,basePath?:string):{path:string;line?:number}|undefined {
  if(/^[a-z][a-z0-9+.-]*:(?![0-9]+$)/i.test(url)||url.startsWith('#')||url.startsWith('//'))return;
  let decoded:string;try{decoded=decodeURIComponent(url.split(/[?#]/)[0]);}catch{return;}
  const match=/^(.*?)(?::(\d+))?$/.exec(decoded)!;
  const path=match[1];if(!path)return;
  return {path:path.startsWith('/')?path:basePath?basePath.slice(0,basePath.lastIndexOf('/')+1)+path:path,line:match[2]?Number(match[2]):undefined};
}
