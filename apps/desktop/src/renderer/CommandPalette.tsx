import {useEffect,useId,useMemo,useRef,useState,type KeyboardEvent} from 'react';
import {createPortal} from 'react-dom';
import {filterCommands,movePaletteSelection,paletteEnterTarget,type PaletteCommand} from './command-palette.js';

export interface CommandPaletteProps {
  commands: PaletteCommand[];
  onAction(command: PaletteCommand): unknown;
  onClose(): void;
  label?: string;
}
/** ⌘K palette: type to filter, ↑↓ or Home/End to select, Enter to run, Esc to close. */
export function CommandPalette({commands,onAction,onClose,label='命令面板'}:CommandPaletteProps){
  const base=useId(),listId=base+'list',option=useId();
  const [query,setQuery]=useState(''),[active,setActive]=useState(0),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const input=useRef<HTMLInputElement>(null),items=useMemo(()=>filterCommands(commands,query),[commands,query]);
  useEffect(()=>{setActive(0);},[query]);
  useEffect(()=>{setActive(index=>Math.max(0,Math.min(index,items.length-1)));},[items.length]);
  useEffect(()=>{const previous=document.activeElement as HTMLElement|null;input.current?.focus();return()=>previous?.focus();},[]);
  useEffect(()=>{document.getElementById(option+'-'+active)?.scrollIntoView({block:'nearest'});},[active,option]);
  const run=async(command:PaletteCommand|undefined)=>{if(!command||command.disabled||busy)return;setBusy(true);setError('');try{await onAction(command);onClose();}catch(reason){setError(reason instanceof Error?reason.message:String(reason));}finally{setBusy(false);}};
  const keys=(event:KeyboardEvent<HTMLElement>)=>{
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();return;}
    if(event.key==='Tab'){event.preventDefault();return;}
    if(event.key==='Enter'){event.preventDefault();void run(paletteEnterTarget(items,active));return;}
    if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
    event.preventDefault();setActive(index=>movePaletteSelection(index,items.length,event.key as 'ArrowDown'|'ArrowUp'|'Home'|'End'));
  };
  return createPortal(<div className="modal-backdrop command-palette-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}>
    <section className="modal command-palette" role="dialog" aria-modal="true" aria-label={label} aria-busy={busy} onKeyDown={keys} style={{alignSelf:'flex-start',marginTop:'10vh',width:'min(560px,94vw)',maxHeight:'70vh',display:'flex',flexDirection:'column',padding:'16px',overflow:'hidden'}}>
      <input ref={input} role="combobox" aria-expanded="true" aria-controls={listId} aria-activedescendant={items.length?option+'-'+active:undefined} aria-autocomplete="list" aria-label="搜索命令" placeholder="搜索面板、设置或会话动作…" value={query} onChange={event=>setQuery(event.target.value)} autoComplete="off" spellCheck={false} disabled={busy}/>
      <ul id={listId} role="listbox" aria-label="可执行命令" style={{listStyle:'none',margin:'10px 0 0',padding:0,overflow:'auto',minHeight:0}}>
        {items.map((command,index)=><li id={option+'-'+index} key={command.id} role="option" data-command={command.id} aria-selected={index===active} aria-disabled={command.disabled||undefined} title={command.hint||command.group} onMouseDown={event=>event.preventDefault()} onMouseMove={()=>setActive(index)} onClick={()=>void run(command)} style={{display:'flex',alignItems:'center',gap:'8px',padding:'7px 9px',borderRadius:'7px',cursor:command.disabled?'default':'pointer',background:index===active?'#edf3ee':'transparent',opacity:command.disabled?.45:1,fontSize:'12px'}}>
          <span style={{flex:1,minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{command.title}</span><small style={{color:'#93a08f',fontSize:'10px'}}>{command.hint||command.group}</small>
        </li>)}
      </ul>
      {!items.length&&<p className="hint" role="status">没有匹配的命令</p>}
      {error&&<p className="inline-error" role="alert">{error}</p>}
      <p className="hint" aria-hidden="true" style={{marginTop:'8px'}}>↑↓ 选择 · Enter 执行 · Esc 关闭</p>
    </section>
  </div>,document.body);
}
