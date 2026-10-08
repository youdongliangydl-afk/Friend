import { execFileSync } from 'node:child_process';
export interface ProcessIdentity { pid: number; ppid: number; pgid: number; tty: string; born: string; state: string }
export function processSnapshot(): Map<number, ProcessIdentity> {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,tty=,lstart=,stat='], { encoding: 'utf8', timeout: 3000 }).split('\n');
  const result = new Map<number, ProcessIdentity>();
  for (const row of rows) {
    const fields = row.trim().split(/\s+/); if (fields.length < 10) continue;
    result.set(Number(fields[0]), { pid: Number(fields[0]), ppid: Number(fields[1]), pgid: Number(fields[2]), tty: fields[3], born: fields.slice(4, 9).join(' '), state: fields[9] });
  }
  return result;
}
export function ownedDescendants(root: ProcessIdentity, snapshot: Map<number, ProcessIdentity>, known: Map<number, ProcessIdentity>) {
  const liveRoot = snapshot.get(root.pid);
  if (liveRoot?.born === root.born) {
    known.set(root.pid, root);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of snapshot.values()) if (row.pid > 1 && !known.has(row.pid) &&
        (known.has(row.ppid) && snapshot.get(row.ppid)?.born === known.get(row.ppid)?.born || !['??','?','-'].includes(root.tty) && row.tty === root.tty)) {
        known.set(row.pid, row); changed = true;
      }
    }
  }
  return known;
}
export function identityAlive(identity: ProcessIdentity, snapshot: Map<number, ProcessIdentity>) {
  const current = snapshot.get(identity.pid); return current?.born === identity.born && !current.state.startsWith('Z');
}
export async function terminateOwned(identities: Iterable<ProcessIdentity>) {
  const captured=new Map([...identities].map(p=>[p.pid,p]));
  const refresh=()=>{const snapshot=processSnapshot();for(const root of [...captured.values()])ownedDescendants(root,snapshot,captured);return snapshot;};
  const signal = (name: NodeJS.Signals) => {
    const snapshot = refresh(),owned=[...captured.values()];
    // Children first. A fixed captured identity is checked again immediately before
    // signaling; never signal a reused PID or an arbitrary OS process group.
    const byPid = new Map(owned.map(p => [p.pid, p]));
    const depth = (p: ProcessIdentity) => { let n = 0, parent = byPid.get(p.ppid); const seen = new Set<number>(); while (parent && !seen.has(parent.pid)) { seen.add(parent.pid); n++; parent = byPid.get(parent.ppid); } return n; };
    for (const p of owned.sort((a,b) => depth(b)-depth(a))) if (identityAlive(p,snapshot)) try { process.kill(p.pid,name); } catch {}
  };
  // Freeze owned parents before the final descendant snapshot. A TERM handler
  // must not fork a detached child and exit between two inspection samples.
  signal('SIGSTOP');
  for(let i=0;i<4;i++){const count=captured.size;refresh();signal('SIGSTOP');if(captured.size===count)break;}
  signal('SIGTERM'); // Pending while stopped; no handler is allowed to spawn.
  signal('SIGKILL');
  for (let i=0;i<8;i++) { await new Promise(r=>setTimeout(r,100)); const snapshot=refresh(); if([...captured.values()].every(p=>!identityAlive(p,snapshot)))return true; signal('SIGKILL'); }
  return false;
}
