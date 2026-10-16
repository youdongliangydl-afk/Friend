/** Versioned data exchanged over the Pi bus; no cross-plugin controller import. */
export interface ExpertSkillSelection { id:string; version?:number }
export interface ExpertSpawnOverrides {
  prompt?:string;
  skillRefs?:ExpertSkillSelection[];
  toolsMode?:'inherit'|'allowlist';
  tools?:string[];
  modelId?:string;
  thinkingLevel?:string;
}
export interface ResolvedExpertSpawn {
  v:1;
  id:string;
  title:string;
  version:number;
  hash:string;
  prompt:string;
  skills:{id:string;version:number;hash:string;body:string;title?:string}[];
  toolsMode:'inherit'|'allowlist';
  tools:string[];
  modelId?:string;
  thinkingLevel?:string;
  writeScopes?:string[];
}
