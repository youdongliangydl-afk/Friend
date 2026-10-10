export interface XmlNode { name:string; attributes:Record<string,string>; children:(XmlNode|string)[] }
const local=(name:string)=>name.split(':').at(-1)!;
function decode(value:string){return value.replace(/&([^;]+);/g,(_all,entity:string)=>{
  const named:Record<string,string>={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};if(Object.hasOwn(named,entity))return named[entity];
  const number=/^#x[\da-f]+$/i.test(entity)?parseInt(entity.slice(2),16):/^#\d+$/.test(entity)?Number(entity.slice(1)):NaN;
  if(!Number.isInteger(number)||number<=0||number>0x10ffff||number>=0xd800&&number<=0xdfff)throw new Error('文档 XML 包含无效实体');return String.fromCodePoint(number);
});}
/** A bounded OOXML reader: no DTD, external entities, scripts, or network access. */
export function parseXml(bytes:Uint8Array|string):XmlNode {
  let source:string;
  if(typeof bytes==='string')source=bytes;else {const utf16=bytes[0]===255&&bytes[1]===254;source=new TextDecoder(utf16?'utf-16le':'utf-8',{fatal:true}).decode(bytes);}
  const root:XmlNode={name:'#document',attributes:{},children:[]},stack=[root];let offset=0,nodes=0;
  while(offset<source.length){
    if(++nodes>2_000_000)throw new Error('文档 XML 节点超过 200 万上限');
    if(source[offset]!=='<'){const next=source.indexOf('<',offset),end=next<0?source.length:next;stack.at(-1)!.children.push(decode(source.slice(offset,end)));offset=end;continue;}
    const special=source.startsWith('<!--',offset)?['-->','comment']:source.startsWith('<![CDATA[',offset)?[']]>', 'cdata']:source.startsWith('<?',offset)?['?>','instruction']:undefined;
    if(special){const end=source.indexOf(special[0],offset+2);if(end<0)throw new Error('文档 XML 未闭合');if(special[1]==='cdata')stack.at(-1)!.children.push(source.slice(offset+9,end));offset=end+special[0].length;continue;}
    if(source.startsWith('<!',offset))throw new Error('文档 XML 不允许 DTD 或实体声明');
    let end=offset+1,quote='';for(;end<source.length;end++){const ch=source[end];if(quote){if(ch===quote)quote='';}else if(ch==='"'||ch==="'")quote=ch;else if(ch==='>')break;}
    if(end===source.length)throw new Error('文档 XML 标签未闭合');const tag=source.slice(offset+1,end).trim();offset=end+1;
    if(tag.startsWith('/')){if(stack.length===1||stack.at(-1)!.name!==tag.slice(1).trim())throw new Error('文档 XML 标签不匹配');stack.pop();continue;}
    const match=/^([^\s/>]+)/.exec(tag);if(!match)throw new Error('文档 XML 标签无效');const node:XmlNode={name:match[1],attributes:{},children:[]};
    let rest=tag.slice(match[0].length).replace(/\/\s*$/,'');while(rest.trim()){
      const attr=/^\s+([^\s=/>]+)\s*=\s*(["'])([\s\S]*?)\2/.exec(rest);if(!attr)throw new Error('文档 XML 属性无效');if(Object.hasOwn(node.attributes,attr[1]))throw new Error('文档 XML 属性重复');node.attributes[attr[1]]=decode(attr[3]);rest=rest.slice(attr[0].length);
    }
    stack.at(-1)!.children.push(node);if(!tag.endsWith('/')){stack.push(node);if(stack.length>256)throw new Error('文档 XML 嵌套超过 256 层上限');}
  }
  if(stack.length!==1)throw new Error('文档 XML 未闭合');const elements=root.children.filter((item):item is XmlNode=>typeof item!=='string');if(elements.length!==1)throw new Error('文档 XML 根节点无效');return elements[0];
}
export function nameIs(node:XmlNode,name:string){return local(node.name)===name;}
export function children(node:XmlNode,name?:string){return node.children.filter((item):item is XmlNode=>typeof item!=='string'&&(!name||nameIs(item,name)));}
export function descendants(node:XmlNode,name:string):XmlNode[]{return children(node).flatMap(child=>[...(nameIs(child,name)?[child]:[]),...descendants(child,name)]);}
export function attribute(node:XmlNode,name:string){return node.attributes[name]??Object.entries(node.attributes).find(([key])=>local(key)===name)?.[1];}
export function xmlText(node:XmlNode):string{return node.children.map(child=>typeof child==='string'?child:xmlText(child)).join('');}
export function officeText(node:XmlNode):string {
  if(nameIs(node,'t'))return xmlText(node);if(nameIs(node,'tab'))return '\t';if(nameIs(node,'br')||nameIs(node,'cr'))return '\n';
  if(nameIs(node,'rPh'))return '';return children(node).map(officeText).join('');
}
