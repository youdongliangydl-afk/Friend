export function TerminalNotice({message,error,onClose}:{message:string;error:boolean;onClose():void}){
  const mcp=message.startsWith('MCP servers need attention:');
  return <div className={'terminal-notice'+(error?' error':'')} role={error?'alert':'status'}>
    <details key={message} open={error||undefined}>
      <summary>{error?'操作未完成':mcp?'扩展服务连接异常':'提示'}<span>详情</span></summary>
      <div className="terminal-notice-details"><p>{message}</p>{mcp&&<p>可在设置的扩展页面检查服务连接；这不影响本地终端。</p>}</div>
    </details>
    <button aria-label="关闭提示" onClick={onClose}>×</button>
  </div>;
}
