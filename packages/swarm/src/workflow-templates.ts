import {digest} from '@friend-pi/core';
import type {WorkflowDefinition,WorkflowNode,WorkflowTemplate} from './workflow.js';
const node=(id:string,title:string,prompt:string,dependencies:string[]=[],write=false):WorkflowNode=>({id,title,prompt,dependencies,mode:write?'write':'read',writeScopes:write?['output']:[],codePaths:['.'],maxRetries:2});
/** Editable starting points; no role IDs or models are imposed. */
export function builtinWorkflowTemplates():WorkflowTemplate[] {
  const presets:[string,string,WorkflowNode[]][]=[
    ['source-research','来源研究',[node('sources','收集来源','围绕 {{args.target}} 收集可追溯来源，保留注册会话和条目标识。'),node('compare','比较证据','比较来源冲突、时间和适用条件。',['sources']),node('report','研究报告','逐条绑定声明和来源，明确未知项。',['compare'])]],
    ['code-development','代码开发',[node('plan','实现方案','检查 {{args.target}}，拆分验收条件。'),node('implement','实现','按方案在 output 范围完成产物；实际代码范围由用户编辑后授权。',['plan'],true),node('verify','验证','核对实现与验收条件，报告实际检查。',['implement'])]],
    ['code-repair','问题修复',[node('inspect','审查输入','检查 {{args.target}} 的约束和变更。'),node('correctness','定位原因','检查边界、错误处理与状态恢复，给出可复现原因。',['inspect']),node('security','权限和来源','检查权限、来源和数据边界。',['inspect']),node('repair','修复','在 output 生成修复产物；实际代码范围由用户编辑授权。',['correctness','security'],true),node('report','修复验证','核对修复覆盖复现步骤与回归范围。',['repair'])]],
    ['structured-delivery','结构化交付',[node('inspect','数据检查','检查 {{args.target}} 的字段、缺失值和来源。'),node('analyze','分析','依据数据提出可复算结论。',['inspect']),node('report','结构化交付','在 output 产出结构化文件，逐条说明结论、适用条件和来源。',['analyze'],true)]],
  ];
  return presets.map(([id,title,nodes])=>{const definition:WorkflowDefinition={v:1,title,goal:`${title}：{{args.target}}`,nodes,parameters:{target:'请填写目标'},maxWorkers:4,...(nodes.some(n=>n.mode==='write')?{checks:[{command:'node',args:['-e',"const fs=require('node:fs');if(!fs.existsSync('output')||!fs.statSync('output').isDirectory()||!fs.readdirSync('output').length)process.exit(1)"]}]}:{})};return {v:1,id,version:1,definition,hash:digest(definition),createdAt:'2026-10-17T00:00:00.000Z'};});
}
