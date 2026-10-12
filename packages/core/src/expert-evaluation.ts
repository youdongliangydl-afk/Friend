import type {JsonObject, SourceRef} from './index.js';
import type {CheckRef} from './capability-services.js';

export type ExpertScenario = 'code-development' | 'code-repair' | 'source-research' | 'structured-delivery';
export interface EvaluationMethodRef {id:string;version:number;hash:string}
export interface HostCase {
  id:string;kind:'positive'|'negative';families:string[];inputHash:string;
  critical:boolean;taskRef:string;
}
export interface HostEvaluationSuite {
  v:1;scenario:ExpertScenario;suiteId:string;suiteHash:string;
  environmentHash:string;checkerHash:string;promptHash:string;
  roleHash:string;materialsHash:string;
  validation:HostCase[];release:HostCase[];
}
export interface HostEvalRequest {
  v:1;operationId:string;budgetId:string;sourceRunId:string;
  suiteId:string;suiteHash:string;phase:'validation'|'release';
  caseId:string;taskRef:string;repetition:number;side:'baseline'|'candidate';
  method:EvaluationMethodRef & {body:string};
  baseline:EvaluationMethodRef;candidate:EvaluationMethodRef;
  modelId:string;thinkingLevel:string;tools:string[];
  environmentHash:string;checkerHash:string;promptHash:string;
  roleHash:string;materialsHash:string;timeoutMs:number;
}
export interface HostEvalResult {
  v:1;operationId:string;requestHash:string;suiteHash:string;
  status:'completed'|'waiting'|'unknown';
  checks:{id:string;passed:boolean;critical:boolean;ref?:CheckRef}[];
  usage:{totalTokens:number|null;providerRequests:number;unknown:boolean};
  timing:{admittedAt:string;checkedAt:string;queueWaitMs:number;elapsedMs:number};
  nativeEvidence:SourceRef[];outputHash:string;reason?:string;
}
/** Host closures own hidden tasks/checkers; the plugin receives opaque references. */
export interface ExpertEvaluationHost {
  v:1;
  catalog(input:{scenario:ExpertScenario;baseline:EvaluationMethodRef;candidate:EvaluationMethodRef;modelId:string;thinkingLevel:string;tools:string[]}):Promise<HostEvaluationSuite|undefined>;
  advance(request:HostEvalRequest):Promise<HostEvalResult>;
  read(input:{operationId:string}):Promise<HostEvalResult|undefined>;
}

export interface CapabilityDiagnostic {
  v:1;conclusion:string;basis:string[];gaps:string[];
  raw?:JsonObject;
}
