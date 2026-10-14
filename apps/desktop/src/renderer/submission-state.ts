interface SubmissionRun {sessionId?:string;previousRunId?:string;runId?:string}
interface RunState {sessionId:string;runId?:string;isRunning:boolean;lifecycleStatus?:string}
const terminalStatuses=new Set(['completed','failed','stopped','interrupted','paused']);

export function submissionSettled(submission:SubmissionRun|null,current:RunState|null|undefined):boolean {
  return !!submission&&!!current&&submission.sessionId===current.sessionId&&!!current.runId&&
    current.runId!==submission.previousRunId&&(!submission.runId||submission.runId===current.runId)&&
    !current.isRunning&&terminalStatuses.has(current.lifecycleStatus||'');
}
