import type {ExpertScenario} from '@friend-pi/core';

export const scenarioMethods: readonly {scenario:ExpertScenario;title:string;keywords:string[];applicability:string;exclusions:string[];body:string}[] = [
 {scenario:'code-development',title:'代码开发',keywords:['开发','实现','code','development','implement'],applicability:'在授权项目内实现有明确验收条件的代码需求',exclusions:['没有可核验需求或授权写范围','部署、凭证和权限变更'],body:'输入：明确需求、现有实现、授权范围与客观检查。先读取相关调用链和约束，复用既有组件；制定最小实现与验收条件，再在授权范围内实现。产物：固定代码版本、变更说明和检查收据。客观检查：需求对应行为、必要边界及相关回归全部通过；未运行和未知项分别列出。'},
 {scenario:'code-repair',title:'代码修复',keywords:['修复','缺陷','错误','bug','repair','fix'],applicability:'有可复现故障或明确错误边界的代码修复',exclusions:['无法区分预期行为的无证据猜测','扩大权限或覆盖无关修改'],body:'输入：故障现象、最小触发条件、预期结果与授权项目。先复现并定位公共根因，读取调用者；添加能区分修复前后的最小回归，再修复并验证调用链。产物：根因、固定修复版本、复现与回归证据。客观检查：原故障不再出现、正常路径和关键边界通过；无法复现时保留未知。'},
 {scenario:'source-research',title:'带来源的调研',keywords:['调研','来源','引用','research','source','citation'],applicability:'在许可材料内回答可用原文与预登记事实断言核对的问题',exclusions:['缺少许可来源仍要求确定结论','只有来源覆盖但无法支持断言'],body:'输入：问题、许可来源、时间版本和事实核对要求。优先一手材料，读取支持结论的完整片段与条件；为每项断言绑定精确来源位置，区分事实、推断和未知。产物：逐断言结论、引用片段及来源版本。客观检查：引用实际存在、内容支持该断言、关键条件未遗漏；覆盖率不能代替结论正确性。'},
 {scenario:'structured-delivery',title:'结构化交付',keywords:['交付','结构化','字段','structured','delivery','schema'],applicability:'输入与输出模式明确且有客观校验器的结构化交付',exclusions:['输出合同不明确或需要未授权数据','为了满足格式而编造内容'],body:'输入：全部许可材料、目标模式、字段规则及客观校验器。逐项覆盖必填字段和材料，保留原始值、来源与未知状态；先验证内容再验证格式。产物：符合模式的文件或对象、字段覆盖说明和校验收据。客观检查：模式、类型、必填、引用和业务断言全部通过；不得以格式有效替代内容正确。'},
];

export function expertScenario(value:unknown):ExpertScenario|undefined {
 return scenarioMethods.find(method=>method.scenario===value)?.scenario;
}
