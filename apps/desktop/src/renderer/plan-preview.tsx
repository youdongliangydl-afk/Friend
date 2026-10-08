export function PlanPreview({body,disabled,onRead,onApprove,onRevise,onReject}:{body:string;disabled:boolean;onRead():void;onApprove():void;onRevise():void;onReject():void}) {
  const excerpt=body.replace(/^\s{0,3}#{1,6}\s+/gm,'').replace(/[*`]/g,'').split('\n').filter(line=>line.trim()).join('\n').trim().slice(0,400);
  return <section className="plan-approval card" aria-label="就绪计划">
    <button type="button" className="plan-preview" onClick={onRead} aria-label="查看计划全文">
      <span className="plan-preview-heading"><strong>计划已就绪</strong><span>查看全文 ↗</span></span>
      <span className="plan-preview-excerpt">{excerpt||'点击查看完整计划。'}</span>
    </button>
    <div className="button-row"><button className="primary" disabled={disabled} onClick={onApprove}>批准并执行</button><button disabled={disabled} onClick={onRevise}>要求修改</button><button disabled={disabled} onClick={onReject}>退出计划</button></div>
  </section>;
}
