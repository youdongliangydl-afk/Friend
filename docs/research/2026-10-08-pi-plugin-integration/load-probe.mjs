import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {DefaultResourceLoader,SettingsManager,initTheme} from '@earendil-works/pi-coding-agent';
const base=resolve('.cache/research/pi-plugin-integration/2026-10-08'),slug=process.argv[2];
const info=JSON.parse(readFileSync(join(base,slug+'-registry.json'),'utf8'));
const cwd=join(base,'load-fixtures',slug,'project'),agentDir=join(base,'load-fixtures',slug,'agent');
mkdirSync(cwd,{recursive:true});mkdirSync(agentDir,{recursive:true});
process.env.PI_CODING_AGENT_DIR=agentDir;process.env.PI_OFFLINE='1';process.env.PI_BG_DISABLE_UPDATE_CHECK='1';
for(const key of Object.keys(process.env))if(/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET)/i.test(key))delete process.env[key];
initTheme('light',false);
const extensions=(info.pi?.extensions||[]).map(path=>join(base,slug,'package',path));
const settings=SettingsManager.inMemory({extensions,packages:[],defaultTools:[]});
const loader=new DefaultResourceLoader({cwd,agentDir,settingsManager:settings,noThemes:true,noSkills:true,noPromptTemplates:true});
const result={node:process.version,pi:'1.0.4',name:info.name,version:info.version,phase:'extension registration only',modelCalls:0,guiAcceptance:'NOT_RUN',declaredEntryPoints:extensions};
try{await loader.reload({resolveProjectTrust:async()=>true});const loaded=loader.getExtensions();result.errors=loaded.errors;result.registered=loaded.extensions.map(e=>({path:e.path,tools:[...e.tools.keys()],commands:[...e.commands.keys()],eventHooks:[...e.handlers.keys()]}));}catch(error){result.error=String(error);}
writeFileSync(join(base,slug+'-load-probe.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
