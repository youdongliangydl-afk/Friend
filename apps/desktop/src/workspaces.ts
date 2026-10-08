import { mkdirSync, realpathSync, statSync, existsSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { projectIdentity, type RecordStore } from '@friend-pi/core';

export type WorkspaceRef = { kind: 'project'; projectId: string } | { kind: 'temporary'; sessionId: string };
export interface Project { id: string; path: string; name: string }
export interface WorkspaceSession {
  id: string; projectId: string; workspace?: WorkspaceRef; workspaceDir?: string;
}
export interface ResolvedWorkspace { id: string; path: string; name: string; ref: WorkspaceRef }
export function sessionWorkspace(store: RecordStore, record: WorkspaceSession): ResolvedWorkspace {
  if (record.workspace?.kind === 'temporary') {
    if (!record.workspaceDir || record.workspace.sessionId !== record.id) throw new Error('临时工作区不可用');
    const path = realpathSync(record.workspaceDir);
    if(path!==resolve(record.workspaceDir))throw new Error('临时会话目录已变化，请恢复原目录后重试');
    return { id: projectIdentity(path), path, name: '临时工作区', ref: record.workspace };
  }
  const projectId = record.workspace?.kind === 'project' ? record.workspace.projectId : record.projectId;
  const project = store.get<Project>('project:' + projectId)?.value;
  if (!project) throw new Error('项目不可用');
  return { ...project, path: realpathSync(project.path), ref: { kind: 'project', projectId } };
}
export function temporaryDirectory(value:unknown):string {
  if(typeof value!=='string'||!value.trim())throw new Error('请填写临时会话默认目录');
  const path=value.trim()==='~'?homedir():value.trim().startsWith('~/')?join(homedir(),value.trim().slice(2)):value.trim();
  if(!isAbsolute(path))throw new Error('默认目录必须是绝对路径或 ~/ 路径');
  const directory=resolve(path);
  if(existsSync(directory)&&!statSync(directory).isDirectory())throw new Error('默认目录不是文件夹');
  return directory;
}
export function temporaryWorkspace(defaultDirectory: string, sessionId: string) {
  if (!/^[a-zA-Z0-9-]+$/.test(sessionId)) throw new Error('会话标识无效');
  const parent=temporaryDirectory(defaultDirectory);mkdirSync(parent,{recursive:true,mode:0o700});
  const canonicalParent=realpathSync(parent),path=join(canonicalParent,sessionId);
  try{mkdirSync(path,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('会话子目录已存在，未复用，请重试新建会话');throw error;}
  const workspaceDir=realpathSync(path);if(workspaceDir!==path)throw new Error('会话子目录已变化，未打开');
  return { workspace: { kind: 'temporary', sessionId } as WorkspaceRef, workspaceDir };
}
export function orderedProjects(projects: Project[], order: readonly string[]) {
  const ranks = new Map(order.map((id, i) => [id, i]));
  return projects.map((p, i) => ({ p, rank: ranks.get(p.id) ?? order.length + i })).sort((a, b) => a.rank - b.rank).map(x => x.p);
}
export function validateProjectOrder(projects: readonly Project[], ids: unknown): string[] {
  if (!Array.isArray(ids) || ids.length !== projects.length || new Set(ids).size !== ids.length ||
      ids.some(id => typeof id !== 'string' || !projects.some(p => p.id === id))) throw new Error('项目列表已变化，请重试排序');
  return [...ids];
}
