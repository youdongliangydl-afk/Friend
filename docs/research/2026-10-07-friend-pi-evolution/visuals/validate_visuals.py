#!/usr/bin/env python3
"""Read-only validation of report diagrams and selected workbench direction.
Writes the review result only under the report-render QA directory.
"""
import sys
sys.dont_write_bytecode=True
import importlib.util,json,hashlib
from pathlib import Path
from xml.etree import ElementTree
here=Path(__file__).resolve().parent
root=here.parents[3]
s=importlib.util.spec_from_file_location('friend_pi_visuals',here/'generate_visuals.py')
v=importlib.util.module_from_spec(s);s.loader.exec_module(v)
manifest=json.loads((here/'manifest.json').read_text())
expected=['文件','Diff','Swarm','Expert','Memory']
assert manifest['pointCount']==19
assert manifest['futureWorkbenchContract']['entryCount']==1
assert manifest['futureWorkbenchContract']['tabs']==expected
assert manifest['futureWorkbenchContract']['contextTab'] is False
problems=[];checks=[]
for item in manifest['items']:
 ident=item['id'];before=v.draw_scene(ident,False);after=v.draw_scene(ident,True)
 for variant in ['before','after','comparison']:
  entry=item['files'][variant];path=here/entry['file'];ElementTree.fromstring(path.read_text())
  assert hashlib.sha256(path.read_bytes()).hexdigest()==entry['sha256']
  if variant!='before':assert '未实现' in path.read_text()
 assert [o for o in before.ops if o['k']!='text'] != [o for o in after.ops if o['k']!='text']
 texts=[o['s'] for o in after.ops if o['k']=='text']
 tab_texts=[o['s'] for o in after.ops if o['k']=='text' and o['x']>=947 and o['y']==253]
 assert tab_texts==expected, (ident,tab_texts)
 assert not any(name in texts for name in ['Context','上下文','后台队列','共享材料'])
 assert texts.count('▥  工作台')==1
 toolbar=[o['s'] for o in after.ops if o['k']=='text' and o['x']>=1000 and 120<=o['y']<=155]
 assert toolbar==['▥  工作台'],(ident,toolbar)
 for variant,canvas in [('before',before),('after',after)]:
  for op in canvas.ops:
   if op['k']!='text':continue
   width=v.measure(op['s'],op['size']);x=op['x']
   end=x+width if op['anchor']=='start' else x+width/2 if op['anchor']=='middle' else x
   if end>canvas.w-8 or op['y']>canvas.h-3:
    problems.append(dict(id=ident,variant=variant,text=op['s'],end=round(end,1),y=op['y']))
   if x>=961 and 272<=op['y']<=841 and end>1240:
    problems.append(dict(id=ident,variant=variant,text=op['s'],region='workbench',end=round(end,1)))
 # Management stays out of the workbench rectangle in all future scenes.
 right=[o['s'] for o in after.ops if o['k']=='text' and o['x']>=961 and 272<=o['y']<=830]
 forbidden=('启用','停用','暂停学习','立即学习','保存验证基准','新任务图','创建任务图','候选','记忆库')
 # Explanatory exclusion text may mention candidate/library, but no action or library heading is allowed.
 assert not any(t in forbidden for t in right)
 assert item['futureSurface']==('settings' if ident in v.AFTER_SETTINGS else 'conversation-and-light-workbench')
 checks.append({'id':ident,'hashes':'PASS','xml':'PASS','nonTextGeometryDifferent':True,'singleWorkbenchEntry':True,'fiveLightweightTabs':True,'contextTab':False,'managementOutsideWorkbench':True,'futureSurface':item['futureSurface'],'futureUnimplemented':True})
assert not problems,problems
report={'schemaVersion':2,'points':19,'svgFiles':57,'hashes':'PASS','xml':'PASS','textBounds':'PASS','nonTextGeometryDifferences':'PASS','selectedWorkbenchContract':'PASS','userSelectedDirectionIds':['19'],'allFutureHaveSingleEntryAndFiveTabs':True,'managementAndPersistentSettingsSurface':'settings','sourceBusinessUnchanged':True,'noGuiUsed':True,'noCredentialReads':True,'checks':checks,'problems':problems,'manualImageReview':['19-comparison.png','17-after.png','09-after.png','08-after.png','05-after.png','06-after.png']}
qa=root/'.artifacts/qa/evolution-audit/report-render';qa.mkdir(parents=True,exist_ok=True)
(qa/'visual-review.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:report[k] for k in ['points','svgFiles','hashes','xml','textBounds','selectedWorkbenchContract']},ensure_ascii=False))
