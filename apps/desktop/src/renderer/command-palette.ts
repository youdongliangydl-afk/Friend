import {toolNames,type ToolPage} from '../session-view.js';
export type PaletteGroup = '面板' | '设置' | '会话';
export interface PaletteCommand { id: string; title: string; group: PaletteGroup; hint?: string; keywords?: string[]; disabled?: boolean }
export interface PaletteSession { id: string; name?: string; archived?: boolean; running?: boolean }
export interface PaletteContext { session?: PaletteSession; searchShortcut?: string }
export const paletteSettings = [{ id: 'general', title: '常规设置' }, { id: 'models', title: '模型设置' }, { id: 'instructions', title: '自定义指令' }, { id: 'memory', title: '记忆设置' }, { id: 'extensions', title: '扩展设置' }] as const;
const toolKeywords: Record<ToolPage, string[]> = { trace: ['轨迹', 'trace'], file: ['文件', 'file'], diff: ['差异', 'diff'], git: ['git', '提交', '暂存', '分支'], terminal: ['终端', 'terminal', 'shell'], swarm: ['任务', '团队', 'swarm'], expert: ['专家', 'expert'], memory: ['记忆', 'memory'] };
export const palettePanels: { id: string; title: string; keywords: string[] }[] = [
  { id: 'conversation', title: '回到会话', keywords: ['聊天', '对话', 'conversation', 'chat'] },
  { id: 'browser', title: '打开网页', keywords: ['浏览器', 'browser', 'web'] },
  ...(Object.keys(toolNames) as ToolPage[]).map(page => ({ id: page, title: '打开' + toolNames[page] + '面板', keywords: [...toolKeywords[page], '面板'] })),
];
/** Searchable actions stay data; App only dispatches on the stable ids. */
export function commandRegistry(context: PaletteContext = {}): PaletteCommand[] {
  const commands: PaletteCommand[] = palettePanels.map(panel => ({ id: 'panel:' + panel.id, title: panel.title, group: '面板', keywords: panel.keywords }));
  for (const page of paletteSettings) commands.push({ id: 'settings:' + page.id, title: page.title, group: '设置', keywords: ['设置', 'settings', page.id] });
  commands.push(
    { id: 'session:new', title: '新建会话', group: '会话', hint: '⌘N', keywords: ['new', '新建', '会话'] },
    { id: 'session:search', title: '搜索项目与会话', group: '会话', hint: context.searchShortcut || '⌘F', keywords: ['search', '搜索', '查找'] },
  );
  if (context.session) {
    commands.push(
      { id: 'session:rename', title: '重命名当前会话', group: '会话', keywords: ['rename', '重命名'] },
      { id: 'session:stop', title: '停止当前任务', group: '会话', keywords: ['stop', '停止'], ...(context.session.running ? {} : { disabled: true }) },
      { id: 'session:archive', title: context.session.archived ? '恢复当前会话' : '归档当前会话', group: '会话', keywords: [context.session.archived ? 'restore' : 'archive', '归档', '恢复'] },
    );
  }
  return commands;
}
const normalize = (value: string) => value.trim().toLocaleLowerCase();
export function subsequenceMatch(text: string, term: string): boolean {
  if (!term) return true;
  let index = 0;
  for (const char of text) { if (char === term[index]) index++; if (index === term.length) return true; }
  return false;
}
/** Every term must match; exact title beats prefix, prefix beats substring, then keywords, group and fuzzy title. */
export function commandScore(command: PaletteCommand, terms: string[]): number | undefined {
  const title = normalize(command.title), group = normalize(command.group), keywords = (command.keywords || []).map(normalize), id = normalize(command.id);
  let score = 0;
  for (const term of terms) {
    if (title === term) score += 1000;
    else if (title.startsWith(term)) score += 500;
    else if (title.includes(term)) score += 300;
    else if (keywords.includes(term)) score += 240;
    else if (keywords.some(keyword => keyword.startsWith(term))) score += 180;
    else if (keywords.some(keyword => keyword.includes(term))) score += 140;
    else if (group.includes(term)) score += 90;
    else if (id.includes(term)) score += 60;
    else if (subsequenceMatch(title, term)) score += 30;
    else return;
  }
  return score;
}
export function filterCommands(commands: PaletteCommand[], query: string, limit = 20): PaletteCommand[] {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  return commands.map((command, index) => ({ command, index, score: terms.length ? commandScore(command, terms) : 0 }))
    .filter(row => row.score !== undefined)
    .sort((a, b) => b.score! - a.score! || Number(a.command.disabled === true) - Number(b.command.disabled === true) || a.index - b.index)
    .slice(0, Math.max(0, limit))
    .map(row => row.command);
}
export type PaletteMoveKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';
export function movePaletteSelection(current: number, count: number, key: PaletteMoveKey): number {
  if (count <= 0) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  const from = current < 0 || current >= count ? (key === 'ArrowDown' ? -1 : 0) : current;
  return (from + (key === 'ArrowDown' ? 1 : count - 1)) % count;
}
export function paletteEnterTarget(commands: PaletteCommand[], index: number): PaletteCommand | undefined {
  const command = commands[index];
  return command && command.disabled !== true ? command : undefined;
}
