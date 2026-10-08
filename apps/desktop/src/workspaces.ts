import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
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
    return { id: projectIdentity(path), path, name: '临时工作区', ref: record.workspace };
  }
  const projectId = record.workspace?.kind === 'project' ? record.workspace.projectId : record.projectId;
  const project = store.get<Project>('project:' + projectId)?.value;
  if (!project) throw new Error('项目不可用');
  return { ...project, path: realpathSync(project.path), ref: { kind: 'project', projectId } };
}
export function temporaryWorkspace(dataDir: string, sessionId: string) {
  if (!/^[a-zA-Z0-9-]+$/.test(sessionId)) throw new Error('会话标识无效');
  const path = join(dataDir, 'workspaces', sessionId);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return { workspace: { kind: 'temporary', sessionId } as WorkspaceRef, workspaceDir: realpathSync(path) };
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
