import {createHash} from 'node:crypto';
import type {BrowserScope} from './session-view.js';
export function browserPartition(scope: BrowserScope,sessionId: string,workspacePath: string): string {
  // Workspace identity survives registering a temporary directory as a project.
  const identity=scope==='app'?'app':scope==='session'?sessionId:createHash('sha256').update(workspacePath).digest('hex');
  return `persist:friend-browser-v1-${scope}-${identity}`;
}
