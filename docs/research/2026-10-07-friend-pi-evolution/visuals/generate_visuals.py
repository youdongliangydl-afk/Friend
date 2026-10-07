#!/usr/bin/env python3
"""Accurate product-layout comparison drawings, not screenshots or shipped UI.

Pure Python SVG generation. Optional PNG renders use Pillow and a CJK font.
Example:
  python3 generate_visuals.py
  BUNDLED_PYTHON generate_visuals.py --render-dir /absolute/qa/report-render
  python3 generate_visuals.py --only 01,04 --catalog overrides.json
"""
from __future__ import annotations
import argparse, datetime, hashlib, html, json, math, os, unicodedata
from pathlib import Path
from xml.etree import ElementTree
try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    Image = ImageDraw = ImageFont = None

ROOT = Path(__file__).resolve().parents[4]
HERE = Path(__file__).resolve().parent
C = dict(bg='#F3F5F1', white='#FFFFFF', side='#F8FAF6', panel='#F8FAF4', line='#DCE5D8',
         ink='#304A3B', body='#455D4E', mute='#738777', green='#3B8069', soft='#EAF3E8',
         emerald='#287257', amber='#9B6729', amberbg='#FFF7E9', red='#A64F42', redbg='#FFF1EC',
         blue='#356D8E', bluebg='#ECF4FA', gray='#EDF1EB', darkgray='#A6B3A2')
FONT_FAMILY = "'PingFang SC','Noto Sans CJK SC','Arial Unicode MS','Inter',sans-serif"
FONT = '/System/Library/Fonts/Supplemental/Arial Unicode.ttf'
PIN = dict(sourceCommit='5ec4b39fb7301ac57715976458f602909fc0a0fb',
           piCommit='eb326d265ae0b88489a6d10319307780df827cdf',
           artifactSha256='a066e009e9d073ee3f49fc5b0e73307da857d57d6b2a425cabd16e7fbc6097d4')
FONT_CACHE = {}

def font(size):
    key = int(round(size))
    if ImageFont is None:
        return None
    if key not in FONT_CACHE:
        FONT_CACHE[key] = ImageFont.truetype(FONT, key)
    return FONT_CACHE[key]

def measure(s, size=14):
    if ImageFont is not None:
        return font(size).getlength(s)
    return sum(size if unicodedata.east_asian_width(ch) in 'WF' else size*.55 for ch in s)

def wrap(s, width, size=14):
    lines=[]
    for para in str(s).split('\n'):
        if not para:
            lines.append(''); continue
        line=''
        for ch in para:
            if line and measure(line+ch,size)>width:
                lines.append(line.rstrip());line=ch.lstrip()
            else: line+=ch
        if line: lines.append(line)
    return lines

class Canvas:
    def __init__(self,w,h,title,description=''):
        self.w,self.h,self.title,self.description=w,h,title,description
        self.ops=[]
    def rect(self,x,y,w,h,fill=C['white'],stroke=None,r=0,sw=1):
        self.ops.append(dict(k='rect',x=x,y=y,w=w,h=h,fill=fill,stroke=stroke,r=r,sw=sw))
    def line(self,x1,y1,x2,y2,color=C['line'],width=1):
        self.ops.append(dict(k='line',x1=x1,y1=y1,x2=x2,y2=y2,color=color,width=width))
    def circle(self,x,y,r,fill,stroke=None,sw=1):
        self.ops.append(dict(k='circle',x=x,y=y,r=r,fill=fill,stroke=stroke,sw=sw))
    def poly(self,points,fill,stroke=None,sw=1):
        self.ops.append(dict(k='poly',points=points,fill=fill,stroke=stroke,sw=sw))
    def text(self,x,y,s,size=14,color=C['body'],weight=400,anchor='start'):
        self.ops.append(dict(k='text',x=x,y=y,s=str(s),size=size,color=color,weight=weight,anchor=anchor))
    def block(self,x,y,s,w,size=14,color=C['body'],leading=None,max_lines=None,weight=400):
        lines=wrap(s,w,size)
        if max_lines is not None and len(lines)>max_lines:
            lines=lines[:max_lines]; last=lines[-1]
            while last and measure(last+'…',size)>w:last=last[:-1]
            lines[-1]=last+'…'
        lead=leading or size*1.65
        for i,ln in enumerate(lines):self.text(x,y+i*lead,ln,size,color,weight)
        return y+len(lines)*lead
    def arrow(self,x1,y1,x2,y2,color=C['green'],width=2):
        self.line(x1,y1,x2,y2,color,width)
        angle=math.atan2(y2-y1,x2-x1)
        pts=[(x2,y2),(x2-8*math.cos(angle-.43),y2-8*math.sin(angle-.43)),(x2-8*math.cos(angle+.43),y2-8*math.sin(angle+.43))]
        self.poly(pts,color)
    def append(self,other,dx=0,dy=0):
        for op in other.ops:
            o=op.copy()
            for key in ('x','x1','x2'):
                if key in o:o[key]+=dx
            for key in ('y','y1','y2'):
                if key in o:o[key]+=dy
            if 'points' in o:o['points']=[(x+dx,y+dy) for x,y in o['points']]
            self.ops.append(o)
    def svg(self):
        parts=[f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.w}" height="{self.h}" viewBox="0 0 {self.w} {self.h}" role="img" aria-labelledby="title description">',f'<title id="title">{html.escape(self.title)}</title>',f'<desc id="description">{html.escape(self.description)}</desc>']
        for o in self.ops:
            k=o['k']
            if k=='rect':
                parts.append(f'<rect x="{o["x"]}" y="{o["y"]}" width="{o["w"]}" height="{o["h"]}" rx="{o["r"]}" fill="{o["fill"]}" stroke="{o["stroke"] or "none"}" stroke-width="{o["sw"]}"/>')
            elif k=='line':parts.append(f'<line x1="{o["x1"]}" y1="{o["y1"]}" x2="{o["x2"]}" y2="{o["y2"]}" stroke="{o["color"]}" stroke-width="{o["width"]}" stroke-linecap="round"/>')
            elif k=='circle':parts.append(f'<circle cx="{o["x"]}" cy="{o["y"]}" r="{o["r"]}" fill="{o["fill"]}" stroke="{o["stroke"] or "none"}" stroke-width="{o["sw"]}"/>')
            elif k=='poly':parts.append(f'<polygon points="{" ".join(f"{x},{y}" for x,y in o["points"])}" fill="{o["fill"]}" stroke="{o["stroke"] or "none"}" stroke-width="{o["sw"]}"/>')
            elif k=='text':parts.append(f'<text x="{o["x"]}" y="{o["y"]}" fill="{o["color"]}" font-family="{html.escape(FONT_FAMILY,quote=True)}" font-size="{o["size"]}" font-weight="{o["weight"]}" text-anchor="{o["anchor"]}">{html.escape(o["s"])}</text>')
        return '\n'.join(parts+['</svg>'])+'\n'
    def png(self,path,scale=1.5):
        if Image is None:raise RuntimeError('PNG rendering requires Pillow; SVG generation does not.')
        image=Image.new('RGB',(round(self.w*scale),round(self.h*scale)),C['white']); d=ImageDraw.Draw(image)
        for o in self.ops:
            k=o['k']
            if k=='rect':
                box=[v*scale for v in (o['x'],o['y'],o['x']+o['w'],o['y']+o['h'])]
                d.rounded_rectangle(box,radius=o['r']*scale,fill=o['fill'],outline=o['stroke'],width=max(1,round(o['sw']*scale)))
            elif k=='line':d.line([o['x1']*scale,o['y1']*scale,o['x2']*scale,o['y2']*scale],fill=o['color'],width=max(1,round(o['width']*scale)))
            elif k=='circle':d.ellipse([(o['x']-o['r'])*scale,(o['y']-o['r'])*scale,(o['x']+o['r'])*scale,(o['y']+o['r'])*scale],fill=o['fill'],outline=o['stroke'],width=max(1,round(o['sw']*scale)))
            elif k=='poly':
                pts=[(x*scale,y*scale) for x,y in o['points']];d.polygon(pts,fill=o['fill'])
                if o['stroke']:d.line(pts+[pts[0]],fill=o['stroke'],width=max(1,round(o['sw']*scale)))
            elif k=='text':
                f=font(o['size']*scale);xx=o['x']*scale
                if o['anchor']=='middle':xx-=f.getlength(o['s'])/2
                elif o['anchor']=='end':xx-=f.getlength(o['s'])
                d.text((xx,o['y']*scale),o['s'],font=f,anchor='ls',fill=o['color'],stroke_width=0)
        image.save(path)


def button(c,x,y,w,label,kind='plain',h=32):
    fill=C['green'] if kind=='primary' else C['redbg'] if kind=='danger' else C['bluebg'] if kind=='blue' else C['white']
    color=C['white'] if kind=='primary' else C['red'] if kind=='danger' else C['blue'] if kind=='blue' else C['body']
    c.rect(x,y,w,h,fill,C['line'] if kind!='primary' else None,8)
    c.text(x+w/2,y+h*.64,label,12,color,500,'middle')

def pill(c,x,y,label,kind='green',size=11):
    colors={'green':(C['soft'],C['emerald']),'amber':(C['amberbg'],C['amber']),'red':(C['redbg'],C['red']),'blue':(C['bluebg'],C['blue']),'gray':(C['gray'],C['mute'])}
    bg,fg=colors.get(kind,colors['gray']);w=measure(label,size)+18
    c.rect(x,y,w,23,bg,None,11);c.text(x+9,y+16,label,size,fg,500);return w

def card(c,x,y,w,h,title=None,badge=None,kind='white'):
    bg=C.get(kind,C['white']);c.rect(x,y,w,h,bg,C['line'],10)
    if title:c.text(x+14,y+26,title,14,C['ink'],600)
    if badge:pill(c,x+w-measure(badge[0],11)-32,y+10,badge[0],badge[1])

def input_box(c,x,y,w,label,value,lines=1):
    c.text(x,y,label,11,C['mute'],500)
    h=34 if lines==1 else 24*lines+16
    c.rect(x,y+8,w,h,C['white'],C['line'],7)
    c.block(x+10,y+30,value,w-20,12,max_lines=lines)
    return y+h+27

def status_row(c,x,y,w,label,status,kind='green',detail=''):
    c.circle(x+7,y+8,4,{'green':C['green'],'red':C['red'],'amber':C['amber'],'gray':C['darkgray'],'blue':C['blue']}[kind])
    c.text(x+21,y+13,label,13,C['body'],500)
    pill(c,x+w-measure(status,11)-18,y-3,status,kind)
    if detail:c.block(x+21,y+35,detail,w-34,11,C['mute'],max_lines=2)

def annotation(c,a,text):
    x,y,w=a['cx'],a['cy']+a['ch']-66,a['cw']
    c.rect(x,y,w,60,C['amberbg'],None,9)
    c.text(x+12,y+18,'核验注释 · 不属于原界面',10,C['amber'],600)
    c.block(x+12,y+36,text,w-24,12,C['amber'],leading=17,max_lines=2)

def chat(c,a,user,reply,tool_name=None,tool_text=None):
    x,y,w=a['cx'],a['cy'],a['cw']
    h=min(82,24+len(wrap(user,w-28,14))*23)
    c.rect(x,y,w,h,C['gray'],None,11);c.block(x+14,y+26,user,w-28,14,max_lines=2)
    yy=y+h+25;c.text(x,yy,'Friend',11,C['mute'],600)
    yy=c.block(x,yy+27,reply,w,15,leading=25,max_lines=6)
    if tool_name:
        card(c,x,yy+7,w,58);c.text(x+13,yy+31,'›  '+tool_name,13,C['body'],500)
        if tool_text:c.text(x+28,yy+49,tool_text,11,C['mute'])
    return yy

def work_title(c,a,title,subtitle=''):
    x,y,w=a['wx'],a['wy'],a['ww']
    c.text(x+16,y+78,title,19,C['ink'],600)
    if subtitle:c.block(x+16,y+103,subtitle,w-32,12,C['mute'],leading=19,max_lines=2)
    return x+16,y+139,w-32

def table(c,x,y,w,headers,rows,col_widths=None,size=12):
    widths=[w/len(headers)]*len(headers) if col_widths is None else [w*k for k in col_widths]
    h=34*(len(rows)+1);c.rect(x,y,w,h,C['white'],C['line'],7);c.rect(x,y,w,34,C['soft'],None,7)
    for r,row in enumerate([headers]+rows):
        xx=x
        if r:c.line(x,y+r*34,x+w,y+r*34)
        for i,val in enumerate(row):
            c.block(xx+10,y+r*34+22,str(val),widths[i]-16,size,C['ink'] if r==0 else C['body'],max_lines=1,weight=600 if r==0 else 400);xx+=widths[i]
    return y+h

def shell(c,ident,after=False,workspace='上下文',title='演进验证会话',plan=False,mode='Single',running=False,sidebar_variant=None,settings_section=None):
    x,y,W,H=16,112,1248,740
    c.rect(x,y,W,H,C['bg'],C['line'],18)
    # Horizontal projects and native window controls.
    for i,col in enumerate(('#FF625A','#FDBD35','#30C847')):c.circle(x+23+i*19,y+22,5,col)
    c.rect(x+99,y+8,196,34,C['white'],C['line'],9);c.text(x+114,y+30,'□  演进验证项目',13,C['ink'],500)
    c.text(x+312,y+30,'□  第二个项目',12,C['mute']);c.text(x+456,y+30,'＋ 打开项目',12,C['mute'])
    if after:
        button(c,x+W-125,y+8,104,'▥  工作台','plain',34)
    else:
        for i,label in enumerate(('▥','▤','[+]','◇','✧','▦','≋')):
            xx=x+W-258+i*34
            c.rect(xx,y+9,28,30,C['soft'] if i==0 else C['bg'],None,7)
            c.text(xx+14,y+30,label,15,C['green'] if i==0 else C['mute'],400,'middle')
    c.line(x+12,y+49,x+W-12,y+49)
    sy=y+61;SH=H-72;SW=246
    c.rect(x+10,sy,SW,SH,C['side'],C['line'],14)
    c.poly([(x+29,sy+29),(x+53,sy+29),(x+53,sy+35),(x+36,sy+35),(x+36,sy+42),(x+50,sy+42),(x+50,sy+48),(x+36,sy+48),(x+36,sy+58),(x+29,sy+58)],C['green'])
    c.text(x+65,sy+50,'Friend',27,C['green'],600);c.text(x+160,sy+50,'Pi',13,C['mute'])
    button(c,x+25,sy+78,181,'＋ 新建会话     ⌘N','primary',38);button(c,x+213,sy+78,30,'◷',h=38)
    c.rect(x+25,sy+130,218,34,C['white'],C['line'],8);c.text(x+37,sy+152,'搜索会话…',12,C['mute']);c.text(x+207,sy+152,'⌘K',10,C['mute'])
    c.text(x+28,sy+195,'近期  4 个',12,C['mute'],600)
    labels=[('○','当前演进验证','准备就绪'),('✓','文件预览与约束检查','本轮已结束'),('Ⅱ','Swarm 客户端验证','已停止'),('○','研究项目结构','准备就绪')]
    if sidebar_variant=='organized':labels=[('◌','解析器修复','执行中 · 1'),('◇','计划等待批准','待处理 · 1'),('✓','预览功能验证','已完成 · 2'),('⌁','已归档会话','5 个')]
    if ident=='02':labels[0]=('○','原会话（重新打开）','准备就绪')
    if ident=='01':labels[0]=('◌' if after else 'Ⅱ','Swarm 检查任务','正在停止' if after else '已停止')
    for i,(st,name,meta) in enumerate(labels):
        yy=sy+207+i*78
        if i==0:c.rect(x+25,yy,218,68,C['soft'],C['line'],9)
        c.text(x+38,yy+29,st,17,C['green'] if st=='✓' else C['mute'])
        c.block(x+65,yy+27,name,162,13,C['ink'],max_lines=1,weight=600)
        c.text(x+65,yy+49,meta+' · Flash',10,C['mute'])
    if after and sidebar_variant=='organized':
        c.text(x+29,sy+548,'筛选：状态 / 书签 / 最近使用',10,C['mute'])
    c.line(x+12,sy+SH-51,x+SW+8,sy+SH-51)
    if settings_section:c.rect(x+13,sy+SH-48,SW-6,45,C['soft'],None,8)
    c.text(x+30,sy+SH-20,'⚙  设置',13,C['green'] if settings_section else C['mute'])
    # Resize rails.
    c.line(x+263,sy+18,x+263,sy+SH-18,C['line']);c.rect(x+261,sy+SH/2-28,4,56,'#A3BC9A',None,2)
    mx=x+273;mw=648;wx=mx+mw+11;ww=304
    c.rect(mx,sy,mw,SH,C['white'],C['line'],14);c.rect(wx,sy,ww,SH,C['panel'],C['line'],14)
    c.line(wx-6,sy+15,wx-6,sy+SH-15);c.rect(wx-8,sy+SH/2-28,4,56,'#A3BC9A',None,2)
    c.text(mx+24,sy+32,'设置' if settings_section else title,19,C['ink'],600);c.text(mx+24,sy+57,('项目 / '+settings_section) if settings_section else '□  /projects/friend-pi-demo',11,C['mute'])
    c.text(mx+mw-24,sy+34,'正在停止' if ident=='01' and after else '正在工作' if running else '准备就绪',10,C['mute'],400,'end');c.line(mx,sy+73,mx+mw,sy+73)
    c.text(wx+16,sy+32,'工作台' if after else workspace,15,C['ink'],600);c.text(wx+ww-18,sy+32,'×',17,C['mute'],400,'end');c.line(wx,sy+52,wx+ww,sy+52)
    if after:
        tab_width=(ww-36)/5
        for i,tab in enumerate(('文件','Diff','Swarm','Expert','Memory')):
            xx=wx+12+i*(tab_width+3)
            c.rect(xx,sy+62,tab_width,27,C['white'] if tab==workspace else C['panel'],C['line'] if tab==workspace else None,6)
            c.text(xx+tab_width/2,sy+80,tab,10,C['green'] if tab==workspace else C['mute'],500,'middle')
        c.line(wx+12,sy+99,wx+ww-12,sy+99)
    # Codex-style turn rail.
    if not settings_section:
        for i in range(10):c.rect(mx+9,sy+236+i*13,25 if i==5 else 7,2,C['green'] if i==5 else '#B5C1AE')
    cy=sy+99;cx=mx+49;cw=mw-72;ch=SH-250
    py=sy+SH-137
    if settings_section:
        for i,label in enumerate(('通用','模型','项目','专家','记忆','高级')):
            c.text(mx+24+i*73,sy+96,label,12,C['green'] if label in settings_section else C['mute'],500)
        c.line(mx+22,sy+110,mx+mw-22,sy+110)
        cx=mx+25;cy=sy+139;cw=mw-50;ch=SH-247
        c.line(mx+23,sy+SH-76,mx+mw-23,sy+SH-76)
        button(c,mx+mw-171,sy+SH-57,145,'返回当前会话','plain')
        c.text(mx+25,sy+SH-36,'长期配置与详细管理集中于设置。',11,C['mute'])
        return dict(mx=mx,my=sy,mw=mw,mh=SH,cx=cx,cy=cy,cw=cw,ch=ch,wx=wx,wy=sy,ww=ww,wh=SH,composerY=py,sx=x+10,sy=sy,sw=SW,sh=SH,settingsSection=settings_section)
    # Composer remains in the central conversation; settings uses its own footer.
    c.rect(mx+21,py,mw-42,117,'#FDFEFA',C['line'],14)
    c.text(mx+35,py+27,'描述你想完成的工作…',13,C['mute'])
    button(c,mx+33,py+72,30,'＋',h=30);c.text(mx+76,py+93,'关键操作确认',10,C['green'])
    c.text(mx+162,py+93,'先规划',10,C['mute']);c.rect(mx+205,py+82,28,15,C['green'] if plan else '#DDE6D5',None,8);c.circle(mx+225 if plan else mx+213,py+89,5,C['white'])
    c.rect(mx+244,py+78,101,30,C['gray'],C['line'],7);c.rect(mx+(295 if mode=='Swarm' else 247),py+81,46,24,C['white'],C['line'],5)
    c.text(mx+270,py+97,'Single',10,C['green'] if mode=='Single' else C['mute'],400,'middle');c.text(mx+320,py+97,'Swarm',10,C['green'] if mode=='Swarm' else C['mute'],400,'middle')
    c.text(mx+mw-172,py+96,'DeepSeek Flash ▾',10,C['mute']);c.text(mx+mw-62,py+96,'关',10,C['mute'])
    button(c,mx+mw-54,py+76,30,'■' if running else '↗','danger' if running else 'plain',h=30)
    return dict(mx=mx,my=sy,mw=mw,mh=SH,cx=cx,cy=cy,cw=cw,ch=ch,wx=wx,wy=sy,ww=ww,wh=SH,composerY=py,sx=x+10,sy=sy,sw=SW,sh=SH)

META = {
 '01':('停止状态与恢复','图已 stopped，但宿主客观检查仍在写入；状态边界与退出事实脱节。','停止覆盖成员、客观检查和复核；收到终止确认后才显示已停止。',['SWARM-STOP-OBJECTIVE-CHECK','CL-04']),
 '02':('原史缺失保护','已登记 JSONL 缺失时被当作新会话；旧索引静默换到新历史。','保留原会话身份和路径，给出恢复原史、查看备份或明确另建会话。',['CL-01']),
 '03':('完整消息、Markdown 与工具结构','聊天只投影 text，冷恢复丢工具名/输入关联；表格和链接原样显示。','按原生消息块呈现文字、图片、思考、工具及关联结果；安全 Markdown。',['CL-03','EV-03']),
 '04':('未跟踪文件 Diff','仅 git diff HEAD；真实新文件存在时，面板仍显示没有改动。','改动列表包含未跟踪文件，新文件内容可审阅，明确尚未加入索引。',['CL-02']),
 '05':('约束纠正与事实粒度','同来源中的事实被整体撤回，无关 UTF-8 约束也丢失；普通更正仍冲突。','按事实/引用片段维护失效关系；只更正对应事实，保留有效约束。',['R02','R01']),
 '06':('遗忘与候选去重','原生 fork 复制旧事实后，可换词形成候选；尚未自动 active。','遗忘、候选与去重管理集中于设置；Memory tab 只显示本轮实际采用内容。',['M03']),
 '07':('前台优先与后台队列','后台彼此串行，但跨会话前台启动没有取消另一实例的调用。','后台队列与前台优先策略放设置；工作台不显示后台管理或完整记忆库。',['M02']),
 '08':('专家采用一致与版本透明','自动 use 和明确采用执行工具范围不一致；界面不显示当轮快照。','Expert tab 仅介绍本轮选用专家、专业方向与常用 Skill；版本、范围和验证管理放设置。',['EXPERT-AUTO-TOOL-SCOPE']),
 '09':('定向返工与 DAG','复核只拒绝一个任务时，全部任务都重跑；当前展示依赖卡片列表。','Swarm tab 仅显示当前规划 DAG；定向返工与方法修订进入任务详情或设置。',['SWARM-TARGETED-REWORK']),
 '10':('共享版本与冲突','CAS 拒绝过期草稿，但通知先于提交；用户需手动重新载入并合并。','共享版本和冲突编辑进入设置-任务管理；工作台 Swarm 保持当前 DAG。',['SWARM-SHARED-EVENT-COMMIT']),
 '11':('Plan 审批与执行转换','计划靠开关转执行，没有明确计划对象/批准动作；陌生目录只读探索不足。','只读探索生成计划，显式批准绑定目标/约束/范围/检查后再执行。',['C19','C26','plan GUI']),
 '12':('项目、会话状态与组织','横向项目与状态卡已具备；会话在一个近期列表，没有归档/状态筛选。','保留原布局，增加状态分组、固定会话、归档和跨项目名称/正文搜索。',['C02','C05','C06']),
 '13':('轮次预览、书签与定位','短线预览、定位和书签已具备；预览只有请求与最后回复片段。','在现有预览与书签上增加主题、关键词、仅书签筛选及轮次范围回查。',['C09','C24']),
 '14':('分栏、窄屏与快捷键','已支持拖动、键盘调宽、冷恢复和窄屏；布局按全局像素宽度保存。','布局长期设置集中于设置；每项目预设与比例恢复，保持工作台五个轻量 tabs。',['C10','C11']),
 '15':('文件附件与多标签工作台','输入路径预览文本、附件名标签；工作台一次只显示一个文件/模块。','项目文件树、附件能力检查和图文预览，多标签保留文件/Diff/来源。',['C27','C28','C29','C30']),
 '16':('设置搜索、配置一致性与模型能力','全局设置已归位，但 Swarm 默认可矛盾；自定义型号能力硬编码。','设置可搜索并分全局/项目；型号显式能力，配置依赖校验与有效值确认。',['CL-05','C13','C55']),
 '17':('专家验证模板与管理','手写 JSON 基准，重新打开表单不载已有用例；适用范围是一块文本。','验证模板与已有基准全部进入设置-专家管理；Expert tab 不展示管理表单。',['C47','Expert validation coverage']),
 '18':('来源导航与连续现场诊断','来源按钮可开原文，但缺会话定位；连续现场的操作/覆盖信息难核对。','来源回查与连续现场诊断移至设置-高级；不在工作台新增 Context 页。',['R01','R02','C52','C53']),
 '19':('统一轻量工作台与真实采用收据','六个模块入口分散；能力工作台混合运行信息与管理，Memory 展示库而非本轮采用。','用户已选方向：单一工作台入口 + 五个极简 tabs，只展示当前规划、选用专家和实际采用记忆。',['USER-SELECTED-WORKBENCH','C55','C45','C48']),
}


AFTER_SETTINGS = {
 '05':'高级 · 约束与事实来源','06':'记忆 · 遗忘与候选','07':'后台 · 前台优先与队列',
 '10':'任务管理 · 共享材料','14':'显示 · 布局与快捷键','16':'通用 · 模型与插件',
 '17':'专家 · 验证模板','18':'高级 · 连续现场与来源回查',
}
AFTER_TAB = {'01':'Swarm','02':'文件','03':'文件','04':'Diff','05':'Memory','06':'Memory',
 '07':'Memory','08':'Expert','09':'Swarm','10':'Swarm','11':'Swarm','12':'文件',
 '13':'Memory','14':'文件','15':'文件','16':'文件','17':'Expert','18':'Memory','19':'Memory'}

def draw_scene(ident,after=False):
    title,before,after_note,evidence=META[ident]
    c=Canvas(1280,876,title,'产品界面示意，示例数据；当前参考固定候选，未来方案未实现。')
    c.rect(0,0,c.w,c.h,C['white'])
    label=('用户已选方向 · 未实现' if ident=='19' else '未来方案 · 未实现') if after else '当前界面 · 固定候选示意'
    pill(c,16,10,label,'blue' if after else 'gray',12)
    c.text(16,65,title,26,C['ink'],600)
    c.text(16,90,'当前信息适度缩略；示例数据，不是新客户端截图。' if not after else '已采用用户最新工作台约束；能力方案尚未实施。',12,C['mute'])
    if after:
        workspace=AFTER_TAB[ident]
    else:
        workspace={'01':'Swarm','02':'上下文','03':'文件','04':'Diff','05':'上下文','06':'Memory','07':'Memory','08':'Expert','09':'Swarm','10':'Swarm','11':'上下文','12':'文件','13':'上下文','14':'文件','15':'文件','16':'设置','17':'Expert','18':'上下文','19':'Memory'}[ident]
    a=shell(c,ident,after,workspace,title='原会话' if ident=='02' else '演进验证会话',plan=ident=='11',mode='Swarm' if ident in ('01','09','10','11') and after or ident in ('01','09','10') else 'Single',running=ident=='07' or ident=='01' and after,sidebar_variant='organized' if ident=='12' and after else None,settings_section=AFTER_SETTINGS.get(ident) if after else None)
    x,y,w=a['cx'],a['cy'],a['cw']
    if after:
        px,py,pw=a['wx']+14,a['wy']+120,a['ww']-28
        draw_after_point(c,a,ident,x,y,w,px,py,pw)
    else:
        intro={'Swarm':'让成果并行推进','Memory':'留下经验，随时纠正','Expert':'把方法带进工作','文件':'预览项目文件','Diff':'查看当前改动','上下文':'让长任务保持连续','设置':'新会话默认值'}.get(workspace,workspace)
        px,py,pw=work_title(c,a,intro)
        if ident=='19':draw_before_workbench(c,a,x,y,w,px,py,pw)
        else:draw_point(c,a,ident,False,x,y,w,px,py,pw)
    return c


def draw_point(c,a,ident,after,x,y,w,px,py,pw):
    # Each optimization has a distinct product view, not just before/after text boxes.
    if ident=='01':
        chat(c,a,'停止当前 Swarm 检查任务。','正在停止相关执行…' if after else '本轮已停止。')
        if after:
            card(c,px,py,pw,76,'正在停止',('2/3 已确认','amber'))
            c.block(px+14,py+50,'保留结果；等待检查进程退出确认。',pw-28,12,C['mute'],max_lines=2)
            for i,(lab,st,k) in enumerate([('成员执行','已终止','green'),('客观检查','取消中','amber'),('独立复核','未启动','gray')]):status_row(c,px,py+108+i*67,pw,lab,st,k)
            button(c,px,py+336,pw,'查看保留现场');c.text(px,py+394,'退出确认完成后才显示「已停止」。',12,C['mute'])
        else:
            card(c,px,py,pw,76,'任务图',('已停止','gray'));c.text(px+14,py+52,'全部任务已完成，等待复核',12,C['mute'])
            card(c,px,py+95,pw,147,'整合与验收证据');c.text(px+14,py+151,'客观检查：等待结果',12,C['mute']);c.text(px+14,py+189,'独立复核：尚未启动',12,C['mute'])
            button(c,px,py+260,128,'接续');button(c,px+142,py+260,128,'复核成果')
            annotation(c,a,'独立探针：stop 返回后，延迟客观检查仍写文件。')
    elif ident=='02':
        if after:
            card(c,x,y,w,259,'无法打开原始历史',('待恢复','amber'),kind='amberbg')
            c.block(x+18,y+65,'原始会话文件缺失。原会话身份和登记路径已保留，未创建新历史。',w-36,16,leading=27,max_lines=3)
            c.text(x+18,y+157,'期望位置：sessions / … / original.jsonl',12,C['mute'])
            button(c,x+18,y+185,144,'选择恢复的原史','primary');button(c,x+176,y+185,118,'查看备份')
            c.text(x+18,y+238,'需要开始新任务？明确另建会话，不替换当前记录。',12,C['body'])
            card(c,px,py,pw,128,'恢复记录');status_row(c,px+10,py+53,pw-20,'原会话','保留','green');c.text(px+15,py+106,'消息和书签等待原文件恢复。',12,C['mute'])
        else:
            c.text(x+w/2,y+101,'F ·',50,C['green'],500,'middle');c.text(x+w/2,y+154,'从一个小任务开始',24,C['ink'],600,'middle')
            c.block(x+52,y+198,'和 Friend 一起写代码，留下经验，完成长任务。',w-104,15,C['mute'],max_lines=2)
            button(c,x+80,y+248,w-160,'先阅读项目，告诉我整体架构')
            card(c,px,py,pw,132,'当前工作现场');c.text(px+14,py+68,'尚未采用重建现场',13,C['mute']);c.text(px+14,py+105,'原始会话仍由 Pi 管理。',11,C['mute'])
            annotation(c,a,'原 JSONL 缺失后静默新建，桌面索引被新路径覆盖。')
    elif ident=='03':
        if after:
            c.rect(x,y,w,53,C['gray'],None,10);c.text(x+14,y+31,'检查原文与文件改动，给出表格和步骤。',14,C['body'])
            c.text(x,y+83,'检查结果',20,C['ink'],600)
            table(c,x,y+103,w,['文件','状态','结论'],[['README.md','已读取','UTF-8 保留'],['new-file.ts','新建','待检查']], [.39,.24,.37])
            c.text(x,y+235,'1. 保留约束并执行测试',14,C['body']);c.text(x,y+264,'2. 核对改动与客观证据',14,C['body'])
            c.text(x,y+295,'官方来源  ↗',13,C['blue'],500)
            card(c,x,y+315,w,71);c.text(x+14,y+340,'✓  read · README.md  →  原始内容',13,C['body'],500);c.text(x+14,y+363,'✓  write · new-file.ts  →  已保存',13,C['body'],500)
            for i,(lab,st) in enumerate([('本轮工具','2 个'),('思考过程','可展开'),('图片附件','1 张')]):status_row(c,px,py+i*70,pw,lab,st,'green')
            card(c,px,py+229,pw,134,'图片附件');c.rect(px+14,py+271,pw-28,72,C['bluebg'],None,8);c.poly([(px+28,py+326),(px+75,py+285),(px+114,py+317),(px+161,py+280),(px+237,py+326)],'#B4CBC2');c.text(px+14,py+354,'设计示意.png · 原生内容块',11,C['mute'])
        else:
            chat(c,a,'检查原文与文件改动，给出表格和步骤。','| 文件 | 状态 |\n| --- | --- |\n| README.md | 已读取 |\n\n1. 保留约束\n2. 核对改动\n[官方来源](https://example.com)')
            card(c,x,y+305,w,49);c.text(x+14,y+336,'›  工具结果',13,C['body'])
            input_box(c,px,py,pw,'文件路径','README.md');button(c,px,py+84,pw,'选择文件…');card(c,px,py+148,pw,101,'文本预览');c.text(px+14,py+207,'# Friend-Pi',13,C['body'])
            annotation(c,a,'原 JSONL 中的 thinking、image、toolCall 未投影到历史界面。')
    elif ident=='04':
        chat(c,a,'新建文件后，请让我查看当前项目改动。','已生成 new-file.ts。请核对工作区改动。')
        if after:
            c.text(px,py,'工作区  2  个改动',13,C['ink'],600)
            card(c,px,py+22,pw,78);c.text(px+13,py+48,'M   README.md',13,C['body']);c.text(px+13,py+77,'?    new-file.ts',13,C['green'],600)
            pill(c,px,py+122,'未跟踪 · 尚未加入索引','amber')
            c.text(px,py+168,'new-file.ts',15,C['ink'],600)
            c.rect(px,py+183,pw,157,C['soft'],C['line'],8)
            c.block(px+12,py+212,'+ export const\n+ actualNewFile = true;\n+\n+ // 保留 UTF-8',pw-24,12,C['green'],leading=25)
            button(c,px,py+360,pw,'在文件工作台打开')
        else:
            button(c,px,py,pw,'刷新 Diff');c.text(px+pw/2,py+125,'·',43,C['darkgray'],400,'middle');c.text(px+pw/2,py+164,'当前没有工作区改动',15,C['mute'],500,'middle')
            annotation(c,a,'真实 Git 夹具：status 有 ?? new-file.ts，但 diff HEAD 为空。')
    elif ident=='05':
        chat(c,a,'数据库改用 PostgreSQL，其它约束保留。','数据库记忆已纠正；相关派生现场已失效。')
        if after:
            c.text(px,py,'有效约束 · 2 条',14,C['ink'],600)
            card(c,px,py+21,pw,135,'F01 · 数据库',('已纠正','green'));c.text(px+14,py+70,'使用 PostgreSQL',14,C['body']);c.text(px+14,py+97,'替代：使用 SQLite',12,C['mute']);c.text(px+14,py+121,'来源：原文第 1 个事实  ↗',11,C['blue'])
            card(c,px,py+175,pw,118,'F02 · 中文编码',('保留','green'));c.text(px+14,py+225,'必须保留 UTF-8 中文字段',14,C['body']);c.text(px+14,py+267,'同一原文，独立事实与引用片段  ↗',11,C['blue'])
            card(c,x,y+180,w,132,'纠正范围');c.text(x+16,y+225,'只撤回 F01 及其派生方法；F02 保持有效。',14,C['body']);button(c,x+16,y+259,170,'查看事实来源与失效关系')
        else:
            card(c,px,py,pw,121,'当前工作现场');c.text(px+14,py+70,'有效约束',12,C['mute']);c.text(px+14,py+100,'暂无记录',14,C['mute'])
            card(c,px,py+143,pw,102,'项目记忆',('v2','green'));c.text(px+14,py+199,'数据库使用 PostgreSQL',13,C['body'])
            annotation(c,a,'只纠正数据库事实，整理后同来源 UTF-8 约束也被移除。')
    elif ident=='06':
        chat(c,a,'遗忘这条旧经验，再检查后台学习结果。','该记忆及派生内容已遗忘。原始历史仍可回查。')
        if after:
            card(c,px,py,pw,110,'重新学习抑制',('生效','green'));c.text(px+14,py+55,'证据谱系 + 事实摘要',13,C['body']);c.block(px+14,py+80,'相同原始事实在 fork 历史中仍被识别。',pw-28,12,C['mute'],max_lines=2)
            card(c,px,py+130,pw,142,'过滤记录');c.text(px+14,py+181,'Reflection · 已过滤重复事实',12,C['body']);c.text(px+14,py+210,'原因：用户已遗忘对应事实',12,C['mute']);c.text(px+14,py+246,'查看原始证据与遗忘记录  ↗',11,C['blue'])
            card(c,x,y+196,w,125,'候选去重');c.text(x+14,y+244,'0 条旧事实候选；2 条新的独立经验等待判断。',14,C['body']);button(c,x+14,y+271,155,'查看候选与抑制原因')
        else:
            card(c,px,py,pw,94,'项目记忆');c.text(px+14,py+63,'旧记忆已移除',13,C['mute'])
            card(c,px,py+117,pw,175,'待判断的候选',('候选','amber'));c.block(px+14,py+172,'原生 fork 后的旧事实换词摘要',pw-28,14,max_lines=3);button(c,px+14,py+244,92,'采用');button(c,px+118,py+244,92,'遗忘')
            annotation(c,a,'旧事实以 candidate 再次出现，尚未自动成为 active。')
    elif ident=='07':
        chat(c,a,'开始当前会话 B 的前台分析任务。','正在读取当前项目文件…')
        if after:
            pill(c,px,py,'应用级前台优先','green',12)
            card(c,px,py+42,pw,93,'当前前台');c.text(px+14,py+93,'会话 B · 分析项目结构',13,C['body']);c.text(px+14,py+116,'使用冻结模型与专家快照',11,C['mute'])
            card(c,px,py+154,pw,198,'后台等待队列')
            status_row(c,px+12,py+207,pw-24,'Reflection · A','让路','amber', '调用已取消，保留来源与阶段。')
            status_row(c,px+12,py+286,pw-24,'Expert 验证','等待','gray','前台空闲后串行继续。')
            button(c,px,py+372,pw,'查看全部队列与有限重试记录')
        else:
            card(c,px,py,pw,147,'后台学习',('执行中','amber'));c.text(px+14,py+56,'Reflection · 会话 A',13,C['body']);c.text(px+14,py+87,'1 项等待空闲',12,C['mute']);button(c,px+14,py+107,100,'暂停学习')
            card(c,px,py+168,pw,93,'前台');c.text(px+14,py+220,'会话 B 正在工作',13,C['body'])
            annotation(c,a,'跨控制器前台启动后，A 的后台 AbortSignal 未取消。')
    elif ident=='08':
        chat(c,a,'采用只读研究专家，检查项目和来源。','本轮采用只读研究专家方法。')
        if after:
            card(c,px,py,pw,178,'本轮实际采用',('自动采用','green'));c.text(px+14,py+62,'只读研究专家  v1',19,C['ink'],600);c.text(px+14,py+88,'ID：e912…83c1（示例）',12,C['mute']);c.text(px+14,py+112,'版本与内容摘要：已冻结',12,C['mute']);pill(c,px+14,py+130,'工具范围：read','green')
            card(c,px,py+198,pw,115,'专家库最新版本');c.text(px+14,py+250,'v2 仅用于下一次执行',14,C['body']);c.text(px+14,py+288,'本轮快照不随编辑改变。',11,C['mute'])
            button(c,px,py+333,pw,'查看采用原文、版本差异与 Skill')
            card(c,x,y+190,w,118,'工具策略一致');c.text(x+15,y+234,'自动 use 与明确选择采用同一冻结范围。',14,C['body']);c.text(x+15,y+275,'范围外工具调用会明确被拒绝并保留过程。',13,C['mute'])
        else:
            card(c,px,py,pw,60,'自动选择');c.text(px+14,py+48,'按需采用适合的方法',12,C['mute'])
            for i,name in enumerate(['规划专家','只读研究专家','实现专家']):
                card(c,px,py+79+i*87,pw,74,name);c.text(px+14,py+132+i*87,'v1 · 编辑 / 停用 / 版本与回滚',11,C['mute'])
            annotation(c,a,'自动 use 到 read 专家后，冻结工具范围仍 undefined。')
    elif ident=='09':
        chat(c,a,'复核只指出 task-a 错误，请保留 task-b 成果。','已进入第 1 轮返工。')
        if after:
            card(c,x,y+163,w,220,'定向返工计划',('待确认','amber'))
            nodes=[('task-a','解析器','返工',x+20,y+221,'red'),('task-b','文档','保留',x+w-180,y+221,'green'),('integration','整合','重验',x+w/2-80,y+309,'amber')]
            for tid,lab,st,nx,ny,k in nodes:
                card(c,nx,ny,155,58,lab,(st,k));c.text(nx+12,ny+45,tid,10,C['mute'])
            c.arrow(x+97,y+280,x+w/2-31,y+307,C['red']);c.arrow(x+w-103,y+280,x+w/2+32,y+307,C['green'])
            pill(c,px,py,'1 项返工 · 1 项保留','green')
            card(c,px,py+42,pw,129,'复核问题');c.block(px+14,py+87,'task-a：边界解析不完整。task-b 已通过，结果与来源保持。',pw-28,13,max_lines=3)
            input_box(c,px,py+194,pw,'修订方法','增加空输入案例；保留原 UTF-8 规则。',3)
            button(c,px,py+316,pw,'确认受影响任务并接续','primary');c.text(px,py+377,'重试仍受 2 轮自动返工上限约束。',11,C['mute'])
        else:
            for i,lab in enumerate(['task-a · 解析器','task-b · 文档']):
                card(c,px,py+i*126,pw,109,lab,('执行中','amber'));c.text(px+14,py+55+i*126,'返工 1 轮 · 第 2 次尝试',12,C['mute']);c.text(px+14,py+83+i*126,'查看尝试 · running',12,C['green'])
            card(c,px,py+272,pw,105,'复核结果');c.block(px+14,py+320,'只有 task-a 错误，task-b 正确。',pw-28,13,max_lines=2)
            annotation(c,a,'定向返工探针：两个任务都各重跑一次，未保留正确任务。')
    elif ident=='10':
        chat(c,a,'共享材料已变化，保存我基于 v1 的草稿。','并发修改被拒绝。请载入新版本后再保存。' if not after else '你的草稿已保留。可按差异合并到已提交的最新版本。')
        if after:
            card(c,x,y+170,w,213,'共享材料冲突',('基于 v1 → 最新 v2','amber'))
            widths=(w-42)/3
            for i,(lab,body,bg) in enumerate([('你的草稿','API 名称\n新增 UTF-8 检查',C['redbg']),('最新 v2','API 名称\n修改返回字段',C['bluebg']),('合并结果','API 名称\n两项独立变更',C['soft'])]):
                xx=x+14+i*(widths+7);c.rect(xx,y+219,widths,93,bg,None,7);c.text(xx+8,y+240,lab,12,C['ink'],600);c.block(xx+8,y+265,body,widths-16,11,leading=19,max_lines=3)
            button(c,x+14,y+329,152,'保存合并为 v3','primary');button(c,x+180,y+329,128,'保留草稿稍后处理')
            card(c,px,py,pw,170,'版本与发布');status_row(c,px+12,py+49,pw-24,'共享版本保存','已完成','green');status_row(c,px+12,py+108,pw-24,'变更通知','保存后发出','green')
            c.text(px,py+202,'版本链  v1  →  v2  →  v3',14,C['body']);c.text(px,py+229,'版本材料与更新记录可沿来源回查。',12,C['mute'])
        else:
            yy=input_box(c,px,py,pw,'已有材料','接口约定.md · v1')
            yy=input_box(c,px,yy,pw,'内容 · 基于 v1','API 名称\n新增 UTF-8 检查',4)
            button(c,px,yy,pw,'保存此版本')
            c.block(px,yy+59,'并发修改会被拒绝。刷新后重新载入材料再整合草稿。',pw,12,C['mute'],max_lines=3)
            annotation(c,a,'CAS 正确，但同步订阅事件时另一 SQLite 连接尚查不到该版本。')
    elif ident=='11':
        if after:
            card(c,x,y,w,319,'执行计划',('待批准','amber'))
            c.text(x+16,y+67,'目标：补齐预览与新文件 Diff',17,C['ink'],600)
            c.block(x+16,y+102,'有效约束：UTF-8；不更改旧项目；使用原生 Pi 执行。',w-32,13,max_lines=2)
            table(c,x+16,y+151,w-32,['步骤','文件范围','客观检查'],[['只读探索','src / README','来源可回查'],['实现与验证','preview.ts','测试 + Diff']],[.31,.34,.35],11)
            button(c,x+16,y+266,144,'批准并执行','primary');button(c,x+174,y+266,106,'修订计划');button(c,x+294,y+266,124,'保持分析')
            card(c,px,py,pw,145,'计划 → 执行');status_row(c,px+12,py+51,pw-24,'只读探索','已完成','green');status_row(c,px+12,py+108,pw-24,'用户批准','等待','amber')
            c.block(px,py+181,'批准后固定计划身份、约束、工具范围与验证标准。',pw,13,max_lines=3)
            pill(c,px,py+266,'只读：read / ls / find / grep','green')
        else:
            chat(c,a,'先阅读项目，制定实施计划。','1. 阅读 README\n2. 实现文件预览\n3. 执行测试\n\n计划满意后，关闭「先规划」再发实施要求。')
            card(c,px,py,pw,114,'当前计划模式');c.block(px+14,py+56,'只读取已知文件和历史；shell 调用被阻断。',pw-28,13,max_lines=3)
            card(c,px,py+136,pw,153,'开始实施');c.block(px+14,py+183,'在输入框手动切换计划开关，然后重新发送执行要求。',pw-28,13,max_lines=3)
            annotation(c,a,'已有只读边界，但没有计划对象、显式批准或完整目录探索入口。')
    elif ident=='12':
        if after:
            chat(c,a,'查看本项目有哪些工作等待我处理。','1 项正在执行，1 项计划等待批准；最近完成 2 项。')
            card(c,px,py,pw,103,'项目概况');c.text(px+14,py+60,'当前项目 · 4 个活跃会话',14,C['body']);c.text(px+14,py+85,'本地执行 · 最近使用',11,C['mute'])
            for i,(lab,st,k) in enumerate([('执行中','1 个','green'),('需要处理','1 个','amber'),('最近完成','2 个','gray'),('已归档','5 个','gray')]):status_row(c,px,py+138+i*59,pw,lab,st,k)
            button(c,px,py+395,pw,'跨项目搜索名称与原文')
            card(c,x,y+174,w,131,'会话操作');button(c,x+14,y+222,109,'固定会话');button(c,x+135,y+222,109,'归档');button(c,x+256,y+222,152,'查看状态与中断原因')
        else:
            chat(c,a,'查看本项目有哪些工作等待我处理。','可以从左栏近期列表与历史弹窗选择会话。')
            card(c,px,py,pw,190,'历史会话');
            for i,(lab,model) in enumerate([('当前演进验证','本项目 · Flash'),('文件预览与约束检查','本项目 · Flash'),('第二项目会话','第二项目 · Flash')]):
                c.text(px+14,py+54+i*47,lab,13,C['body']);c.text(px+14,py+73+i*47,model,10,C['mute'])
            c.block(px,py+227,'搜索：当前项目名称子串\n组织：一个近期列表\n管理：打开与重命名',pw,13,max_lines=4)
            annotation(c,a,'顶栏项目与状态卡已存在；此图提出组织增强，不把现有布局视为缺陷。')
    elif ident=='13':
        chat(c,a,'找回第一次提出 UTF-8 约束的轮次。','该约束位于第一轮；可以沿原文核对。')
        bx=x+5;by=y+163
        if after:
            card(c,bx,by,w-10,218,'第 1 轮 · 目标与有效约束',('已完成 · 已收藏','green'))
            c.text(bx+14,by+64,'请求：保留 UTF-8，补齐预览功能。',14,C['body'])
            c.block(bx+14,by+91,'回答：先检查原文和输入，再验证文件结果。',w-38,13,max_lines=2)
            pill(c,bx+14,by+127,'2 个工具','green');pill(c,bx+111,by+127,'1 个文件改动','blue');pill(c,bx+237,by+127,'2 条来源','gray')
            button(c,bx+14,by+166,104,'定位原文','primary');button(c,bx+130,by+166,106,'查看 Diff');button(c,bx+248,by+166,114,'复制来源入口')
            input_box(c,px,py,pw,'轮次筛选','主题 / 关键词 / 仅书签')
            for i,lab in enumerate(['★ 第 1 轮 · UTF-8 约束','第 4 轮 · 预览实现','★ 第 6 轮 · 验证结果']):
                card(c,px,py+84+i*81,pw,62);c.text(px+12,py+121+i*81,lab,12,C['body'])
            button(c,px,py+349,pw,'选择轮次范围并回查原文');c.text(px,py+398,'筛选结果可键盘定位；保留现有 B / Esc 操作。',10,C['mute'])
        else:
            c.rect(bx,by,w-35,142,C['bg'],C['line'],11);c.text(bx+14,by+31,'保留 UTF-8，补齐预览功能。',14,C['ink'],500);c.poly([(bx+w-76,by+17),(bx+w-63,by+17),(bx+w-63,by+37),(bx+w-69.5,by+30),(bx+w-76,by+37)],C['bg'],C['green'],1.4)
            c.block(bx+14,by+62,'先检查原文和输入，再验证文件结果。这里显示最后回复的三行摘要。',w-68,13,C['mute'],max_lines=3)
            card(c,px,py,pw,108,'轮次定位');c.text(px+14,py+55,'短线、悬停预览、键盘定位、书签',12,C['body']);c.text(px+14,py+86,'已实现并有真实 GUI 证据。',11,C['mute'])
            annotation(c,a,'现有预览只关联请求和最后回复；工具、文件与来源未进入轮次概览。')
    elif ident=='14':
        chat(c,a,'调整工作台比例，在窄窗口继续工作。','左右分隔线可拖动并保存宽度；窄屏工作台浮层显示。')
        if after:
            card(c,x,y+177,w,202,'布局与命令');
            for i,(lab,ratio) in enumerate([('专注','仅对话'),('双栏','对话 + 工作台'),('三栏','会话 / 对话 / 工作台')]):
                xx=x+14+i*(w-34)/3;c.rect(xx,y+225,(w-49)/3,77,C['soft'] if i==2 else C['gray'],C['line'],8);c.text(xx+10,y+250,lab,13,C['ink'],600);c.block(xx+10,y+275,ratio,(w-69)/3,11,C['mute'],max_lines=2)
            input_box(c,x+14,y+323,w-28,'本项目布局预设','比例  20 / 53 / 27   ·   可切换固定像素')
            input_box(c,px,py,pw,'命令导航','⌘K 搜索操作与快捷键')
            for i,(lab,key) in enumerate([('打开工作台','⌘⇧W'),('切换文件','⌘P'),('定位轮次','⌘J'),('调整分栏','← / →'),('关闭浮层','Esc')]):
                c.text(px,py+101+i*47,lab,13,C['body']);c.text(px+pw,py+101+i*47,key,11,C['mute'],400,'end');c.line(px,py+114+i*47,px+pw,py+114+i*47)
            button(c,px,py+375,pw,'保存为本项目布局')
        else:
            card(c,x,y+172,w,169,'窄窗口示意');
            c.rect(x+16,y+219,w-32,100,C['white'],C['line'],8);c.rect(x+w-207,y+219,191,100,C['panel'],C['line'],8);c.text(x+32,y+257,'中央对话',13,C['body']);c.text(x+w-190,y+257,'按需工作台浮层',12,C['body']);c.text(x+w-190,y+287,'× 关闭',11,C['mute'])
            card(c,px,py,pw,125,'分栏宽度');c.text(px+14,py+63,'会话栏：319 px',13,C['body']);c.text(px+14,py+96,'工作台：440 px',13,C['body'])
            c.block(px,py+158,'已支持拖动、键盘调宽和冷恢复。快捷键分散在各入口。',pw,13,max_lines=4)
            annotation(c,a,'当前宽窄路径已通过；增强目标是可发现性与跨窗口布局意图。')
    elif ident=='15':
        chat(c,a,'阅读设计图片，并对照两个源文件和 Diff。','工作台可以按路径打开文件；图片附件需要型号支持。')
        if after:
            c.rect(x,y+168,w,39,C['gray'],C['line'],8)
            for i,(label,width) in enumerate([('README.md',124),('new-file.ts',123),('设计.png',92),('Diff',74)]):
                xx=x+9+sum(z[1]+5 for z in [('README.md',124),('new-file.ts',123),('设计.png',92),('Diff',74)][:i]);c.rect(xx,y+176,width,24,C['white'] if i==2 else C['gray'],None,5);c.text(xx+width/2,y+193,label,11,C['body'],400,'middle')
            c.rect(x+14,y+226,w-28,102,C['bluebg'],None,9);c.poly([(x+42,y+302),(x+122,y+242),(x+203,y+290),(x+318,y+239),(x+w-39,y+302)],'#B0CABE');c.text(x+20,y+352,'设计.png · 图文预览 · 可打开对应来源',12,C['mute'])
            card(c,px,py,pw,248,'项目文件');
            for i,(lab,col) in enumerate([('▾ src',C['ink']),('    preview.ts',C['body']),('    new-file.ts  · 新建',C['green']),('▾ assets',C['ink']),('    设计.png',C['body']),('README.md',C['body'])]):c.text(px+13,py+54+i*32,lab,12,col)
            pill(c,px,py+273,'当前模型：支持图片','green');button(c,px,py+318,pw,'附件预览与能力检查')
        else:
            yy=input_box(c,px,py,pw,'文件路径','README.md');button(c,px,yy,pw,'选择文件…');
            card(c,px,yy+58,pw,151,'文本预览');c.block(px+13,yy+111,'# Friend-Pi\n\n临时项目文件预览。',pw-26,12,leading=25,max_lines=4)
            card(c,x,y+187,w,97,'附件');pill(c,x+14,y+235,'preview.txt  ×','gray');pill(c,x+133,y+235,'设计.png  ×','gray')
            annotation(c,a,'一个工作台视图；图片预览 dataUrl 分支没有 Main 入口。文件预览文档仅承诺文本。')
    elif ident=='16':
        chat(c,a,'让新会话默认使用 Swarm，并配置可用型号。','全局设置只影响新会话，当前执行保留自己的快照。')
        if after:
            input_box(c,px,py,pw,'搜索设置','模型、插件、项目、快捷键…')
            c.text(px,py+89,'全局  /  项目  /  模型  /  插件',12,C['green'],500)
            card(c,px,py+108,pw,153,'默认协作方式',('Swarm','green'));c.text(px+14,py+161,'Swarm 插件已同步启用',13,C['body']);c.block(px+14,py+188,'依赖检查通过；返回有效配置，不静默降级。',pw-28,12,C['mute'],max_lines=3)
            card(c,px,py+282,pw,150,'自定义型号能力');pill(c,px+14,py+326,'视觉','blue');pill(c,px+73,py+326,'思考','green');c.text(px+14,py+384,'上下文与输出上限：显式配置',11,C['mute']);c.text(px+14,py+408,'认证：保留现有凭据，不显示 Key',11,C['mute'])
            card(c,x,y+185,w,156,'设置已校验');c.text(x+14,y+234,'新会话：Swarm + 插件启用 + 型号能力一致',14,C['body']);c.text(x+14,y+270,'当前会话：继续使用原执行快照',13,C['mute']);button(c,x+14,y+295,142,'查看有效配置差异')
        else:
            yy=input_box(c,px,py,pw,'默认模型','自动选择已配置模型')
            yy=input_box(c,px,yy,pw,'默认 Agent 方式','Swarm')
            card(c,px,yy,pw,130,'默认启用能力');c.text(px+14,yy+58,'☐ Swarm    ☑ Memory',12,C['body']);c.text(px+14,yy+89,'☑ Expert     ☑ 上下文',12,C['body'])
            button(c,px,yy+149,pw,'保存默认设置')
            annotation(c,a,'矛盾默认可保存；新会话界面静默变 Single。自定义型号固定 text/non-reasoning。')
    elif ident=='17':
        chat(c,a,'为方法候选定义可重复的验证标准。','至少两个独立适用案例与一个范围外反例，匹配用户预期。')
        if after:
            card(c,x,y+170,w,214,'验证基准  v2',('已加载','green'))
            c.text(x+14,y+218,'模板：信息提取 · 稳定 JSON 断言',14,C['body'],600)
            table(c,x+14,y+239,w-28,['用例','类型','客观门槛'],[['case-a','适用','字段/类型匹配'],['case-b','独立适用','输出范围匹配'],['edge-a','范围外','拒绝越界要求']],[.27,.25,.48],11)
            card(c,px,py,pw,152,'验证模板');
            for i,lab in enumerate(['代码改动：测试与文件断言','信息提取：稳定 JSON','事实核验：可回查来源']):c.text(px+14,py+55+i*34,lab,12,C['body'])
            card(c,px,py+173,pw,151,'发布门槛',('待验证','amber'));c.block(px+14,py+223,'2 个独立正例 + 1 个反例 + 客观检查。没有证据就不发布。',pw-28,13,max_lines=3);c.text(px+14,py+298,'范围：本项目 / 明确任务领域',11,C['mute'])
            button(c,px,py+348,pw,'保存新基准版本并验证','primary')
        else:
            card(c,px,py,pw,138,'方法候选',('候选','amber'));c.block(px+14,py+63,'适用范围、步骤和检查标准是一块文本。',pw-28,13,max_lines=3)
            yy=input_box(c,px,py+161,pw,'案例 ID','case-1')
            yy=input_box(c,px,yy,pw,'输入任务','（空）')
            yy=input_box(c,px,yy,pw,'预期 JSON','{}')
            button(c,px,yy,pw,'保存验证基准')
            annotation(c,a,'重新打开表单是默认空案例，未载入已有 suite；当前客观校验限定 JSON 比对。')
    elif ident=='18':
        chat(c,a,'找回早期约束，说明本次整理覆盖了哪些原文。','可从当前工作现场点击来源，或在历史中搜索原文。')
        if after:
            card(c,x,y+172,w,210,'来源导航');c.text(x+14,y+217,'演进项目  /  约束会话  /  第 1 轮',13,C['blue'],500)
            c.rect(x+14,y+239,w-28,68,C['soft'],None,8);c.text(x+25,y+265,'原文：数据库使用 SQLite；必须保留 UTF-8。',13,C['body']);c.text(x+25,y+291,'当前引用片段：必须保留 UTF-8 中文字段',12,C['green'],500)
            button(c,x+14,y+332,112,'跳转原轮次','primary');button(c,x+138,y+332,138,'返回当前现场')
            card(c,px,py,pw,127,'工作现场 v4',('已采用','green'));c.text(px+14,py+58,'第 4 次整理 · 已成功保存',11,C['mute']);c.text(px+14,py+86,'覆盖：1–24 轮 · 新输入 25–26 原文保留',11,C['body']);c.text(px+14,py+112,'有效约束：2 条 · 失效事实：1 条',11,C['body'])
            card(c,px,py+149,pw,118,'有限窗口预算');c.rect(px+14,py+192,pw-28,10,C['gray'],None,5);c.rect(px+14,py+192,(pw-28)*.68,10,C['green'],None,5);c.text(px+14,py+226,'示例 68% · 近期原文保留 4 轮',12,C['mute'])
            button(c,px,py+289,pw,'查看来源覆盖与失效原因');c.block(px,py+351,'成功采用后推进水位；取消、缺来源、预算不足保留旧有效现场。',pw,12,C['mute'],max_lines=4)
        else:
            card(c,px,py,pw,150,'当前工作现场');c.text(px+14,py+56,'有效约束',12,C['mute']);c.text(px+14,py+82,'必须保留 UTF-8 中文字段',13,C['body']);button(c,px+14,py+105,81,'来源 1')
            yy=input_box(c,px,py+175,pw,'回查原始历史','UTF-8')
            card(c,px,yy,pw,128,'user · 原始历史');c.block(px+14,yy+56,'数据库使用 SQLite；必须保留 UTF-8。',pw-28,12,max_lines=3);button(c,px+14,yy+89,71,'原文');button(c,px+98,yy+89,82,'前后文')
            annotation(c,a,'原文可读，但缺会话/轮次导航；来源覆盖、采用与新输入诊断未呈现。')


def draw_before_workbench(c,a,x,y,w,px,py,pw):
    chat(c,a,'只看当前会话真正采用了什么。','当前右上有多个模块入口，工作台包含完整管理界面。')
    card(c,px,py,pw,113,'项目记忆',('active','green'))
    c.text(px+14,py+60,'中文规范 · v4 · 本项目',13,C['body'])
    for i,lab in enumerate(('纠正','停用','来源','遗忘')):button(c,px+12+i*64,py+78,58,lab,h=26)
    card(c,px,py+133,pw,123,'待判断的候选',('candidate','amber'))
    c.block(px+14,py+183,'模型提取的经验，等待用户判断。',pw-28,13,max_lines=2)
    button(c,px+14,py+216,86,'采用',h=27);button(c,px+112,py+216,86,'纠正',h=27)
    card(c,px,py+277,pw,125,'后台学习',('running','amber'))
    c.text(px+14,py+332,'reflection · 1 项等待空闲',12,C['mute'])
    button(c,px+14,py+353,98,'暂停学习');button(c,px+124,py+353,112,'立即学习')
    annotation(c,a,'工作台显示库、候选、后台与管理操作，不能区分本轮实际采用。')


def light_file(c,px,py,pw,rich=False):
    c.text(px,py+7,'文件',15,C['ink'],600)
    c.text(px,py+35,'friend-pi-demo  /  src',11,C['mute'])
    c.line(px,py+48,px+pw,py+48)
    for i,lab in enumerate(('▾ src','    preview.ts','    new-file.ts','▸ assets','README.md')):
        yy=py+73+i*27
        if i==2:c.rect(px,yy-19,pw,26,C['soft'],None,5)
        c.text(px+9,yy,lab,12,C['green'] if i==2 else C['body'])
    c.line(px,py+202,px+pw,py+202)
    if rich:
        for i,label in enumerate(('preview.ts','设计.png')):button(c,px+i*(pw/2+3),py+216,pw/2-3,label,h=28)
        c.rect(px,py+260,pw,104,C['bluebg'],None,8)
        c.poly([(px+10,py+341),(px+68,py+279),(px+123,py+323),(px+196,py+276),(px+pw-10,py+341)],'#B0CABE')
        c.text(px,py+391,'设计.png · 图文预览',12,C['mute'])
        pill(c,px,py+416,'型号支持图片','green')
    else:
        c.text(px,py+230,'new-file.ts',12,C['ink'],600)
        c.rect(px,py+249,pw,131,'#FAFCF8',C['line'],7)
        for i,(number,code) in enumerate([('1','export const preview ='),('2','  { encoding: "UTF-8" };'),('3',''),('4','// 本轮新文件')]):
            yy=py+277+i*25;c.text(px+10,yy,number,11,C['darkgray']);c.text(px+35,yy,code,11,C['body'])
        c.text(px,py+411,'预览与文件来源保持可回查。',11,C['mute'])


def light_diff(c,px,py,pw):
    c.text(px,py+7,'本轮改动',15,C['ink'],600)
    c.text(px,py+38,'工作区  2 个文件',12,C['mute'])
    for i,(name,status) in enumerate([('README.md','M'),('new-file.ts','?')]):
        yy=py+65+i*33;c.rect(px,yy-19,pw,29,C['soft'] if i else C['panel'],None,5);c.text(px+8,yy,status,12,C['green']);c.text(px+31,yy,name,12,C['body'])
    c.line(px,py+120,px+pw,py+120);c.text(px,py+148,'new-file.ts',13,C['ink'],600)
    pill(c,px,py+167,'未跟踪 · 尚未加入索引','amber')
    c.rect(px,py+207,pw,157,C['soft'],C['line'],7)
    for i,line in enumerate(['+ export const','+ actualNewFile = true;','+','+ // 保留 UTF-8']):c.text(px+12,py+235+i*29,line,12,C['green'])
    c.text(px,py+405,'文件状态与内容都可见。',11,C['mute'])


def light_dag(c,px,py,pw,variant='normal'):
    c.text(px,py+7,'当前规划',15,C['ink'],600)
    c.text(px,py+34,'只显示当前任务的依赖关系。',11,C['mute'])
    if variant=='stop':
        nodes=[('实现','已结束',px+44,py+59,'green'),('客观检查','取消中',px+44,py+157,'amber'),('独立复核','未启动',px+44,py+255,'gray')]
        for name,state,nx,ny,k in nodes:card(c,nx,ny,pw-88,65,name,(state,k))
        c.arrow(px+pw/2,py+124,px+pw/2,py+155);c.arrow(px+pw/2,py+222,px+pw/2,py+253,C['darkgray'])
    else:
        nodes=[('task-a','解析器','返工' if variant=='rework' else '计划',px,py+69,'red' if variant=='rework' else 'gray'),('task-b','文档','保留' if variant=='rework' else '计划',px+pw-129,py+69,'green' if variant=='rework' else 'gray'),('integration','整合','重验' if variant=='rework' else '依赖前项',px+(pw-160)/2,py+220,'amber' if variant=='rework' else 'gray')]
        for tid,name,state,nx,ny,k in nodes:
            nw=129 if tid!='integration' else 160;card(c,nx,ny,nw,86,name);pill(c,nx+9,ny+41,state,k);c.text(nx+9,ny+75,tid,9,C['mute'])
        c.arrow(px+65,py+156,px+pw/2-26,py+218,C['red'] if variant=='rework' else C['green']);c.arrow(px+pw-65,py+156,px+pw/2+26,py+218,C['green'])
    c.text(px,py+366,'任务详情与深度操作  ↗',12,C['blue'])
    c.block(px,py+406,'成员管理、共享材料和返工配置集中到设置或任务详情。',pw,11,C['mute'],max_lines=3)


def light_expert(c,px,py,pw):
    c.text(px,py+7,'本轮选用',15,C['ink'],600)
    c.text(px,py+35,'当前会话 · 第 6 轮',11,C['mute'])
    card(c,px,py+57,pw,94,'只读研究专家',('v1','green'))
    c.block(px+14,py+107,'核对原始材料，给出有来源、可验证的结论。',pw-28,12,max_lines=2)
    c.text(px,py+184,'专业方向',12,C['mute'],500)
    c.text(px,py+213,'源码阅读 / 证据核验',14,C['body'])
    c.text(px,py+254,'常用 Skill',12,C['mute'],500)
    pill(c,px,py+271,'项目阅读','green');pill(c,px+89,py+271,'来源核验','green')
    c.text(px,py+332,'此卡来自本轮选用记录。',11,C['mute'])
    c.text(px,py+397,'专家管理与验证在设置  ↗',12,C['blue'])


def light_memory_used(c,px,py,pw,postgres=False):
    c.text(px,py+7,'本轮实际采用',15,C['ink'],600)
    c.text(px,py+35,'当前会话 · 第 6 轮 · 2 条',11,C['mute'])
    data=[('UTF-8 中文规范','必须保留 UTF-8 中文字段。','v4'),('数据库规范' if postgres else '项目阅读方法','使用 PostgreSQL。' if postgres else '先读原文，再给出结论。','v2')]
    for i,(title,body,version) in enumerate(data):
        yy=py+58+i*134;card(c,px,yy,pw,115,title,(version,'green'));c.block(px+14,yy+60,body,pw-28,12,max_lines=2);c.text(px+14,yy+98,'已注入本轮 · 查看来源  ↗',11,C['blue'])
    c.block(px,py+348,'只展示真实采用收据，搜索命中与候选不会出现在这里。',pw,11,C['mute'],max_lines=3)
    c.text(px,py+416,'完整记忆管理在设置  ↗',12,C['blue'])


def draw_after_point(c,a,ident,x,y,w,px,py,pw):
    # Right-side views are strictly lightweight and current-round scoped.
    tab=AFTER_TAB[ident]
    if tab=='文件':light_file(c,px,py,pw,rich=ident=='15')
    elif tab=='Diff':light_diff(c,px,py,pw)
    elif tab=='Swarm':light_dag(c,px,py,pw,'stop' if ident=='01' else 'rework' if ident=='09' else 'normal')
    elif tab=='Expert':light_expert(c,px,py,pw)
    elif tab=='Memory':light_memory_used(c,px,py,pw,postgres=ident=='05')

    if ident=='01':
        chat(c,a,'停止当前 Swarm 检查任务。','正在停止相关执行，保留当前成果与原史。')
        card(c,x,y+156,w,231,'正在停止',('2/3 已确认退出','amber'))
        for i,(lab,state,k) in enumerate([('成员执行','已终止','green'),('客观检查','取消中','amber'),('独立复核','未启动','gray')]):status_row(c,x+16,y+210+i*53,w-32,lab,state,k)
        c.text(x+16,y+364,'收到终止确认后才显示已停止；详情不放在 Swarm tab。',12,C['mute'])
    elif ident=='02':
        card(c,x,y,w,272,'无法打开原始历史',('待恢复','amber'),kind='amberbg')
        c.block(x+18,y+65,'原始会话文件缺失。原身份与登记路径保留，不静默新建空历史。',w-36,16,leading=27,max_lines=3)
        c.text(x+18,y+157,'原路径：sessions / … / original.jsonl',12,C['mute'])
        button(c,x+18,y+189,144,'恢复原始历史','primary');button(c,x+176,y+189,126,'查看备份')
        c.text(x+18,y+249,'另建会话必须明确创建新身份。',12,C['body'])
    elif ident=='03':
        c.rect(x,y,w,52,C['gray'],None,10);c.text(x+14,y+31,'检查原文与文件改动，给出表格和步骤。',14,C['body'])
        c.text(x,y+84,'检查结果',20,C['ink'],600)
        table(c,x,y+105,w,['文件','状态','结论'],[['README.md','已读取','UTF-8 保留'],['new-file.ts','新建','待检查']],[.39,.24,.37])
        c.text(x,y+235,'1. 保留约束并执行测试',14,C['body']);c.text(x,y+264,'2. 核对改动与客观证据',14,C['body']);c.text(x,y+295,'官方来源  ↗',13,C['blue'])
        card(c,x,y+315,w,72);c.text(x+14,y+340,'✓ read · README.md → 原始内容',13,C['body']);c.text(x+14,y+365,'✓ write · new-file.ts → 已保存',13,C['body'])
    elif ident=='04':
        chat(c,a,'新建文件后，请查看当前项目改动。','Diff 现在包含已跟踪和未跟踪文件；新文件不被自动加入索引。')
        card(c,x,y+195,w,123,'本轮文件');c.text(x+14,y+243,'new-file.ts · 新建 · 内容可审阅',14,C['body']);c.text(x+14,y+281,'点击右侧 Diff tab，按文件核对。',12,C['mute'])
    elif ident=='05':
        c.text(x,y+9,'约束与事实来源',20,C['ink'],600)
        table(c,x,y+30,w,['事实','当前值','处理'],[['F01 数据库','PostgreSQL','只替代 SQLite'],['F02 中文编码','保留 UTF-8','保持有效']],[.32,.36,.32])
        card(c,x,y+155,w,144,'纠正关系');c.text(x+16,y+199,'同一原文的两个引用片段分别维护。',14,C['body']);c.text(x+16,y+231,'撤回数据库事实及其派生；中文编码约束继续有效。',13,C['mute']);button(c,x+16,y+258,153,'查看事实与来源映射')
        c.text(x,y+343,'此诊断位于设置-高级，不新增 Context tab。',12,C['mute'])
    elif ident=='06':
        c.text(x,y+9,'遗忘与候选管理',20,C['ink'],600)
        card(c,x,y+32,w,135,'重新学习抑制',('生效','green'))
        c.text(x+16,y+80,'遗忘事实以证据谱系和内容摘要识别。',14,C['body'])
        c.block(x+16,y+108,'原生 fork 复制的同一旧事实被过滤，不通过换词重复进入候选。',w-32,13,C['mute'],max_lines=2)
        table(c,x,y+190,w,['候选','判断','下一步'],[['旧事实换词摘要','已过滤','查看抑制原因'],['新的独立经验','待判断','人工检查来源']],[.42,.25,.33])
        button(c,x,y+325,148,'查看完整记忆库');button(c,x+162,y+325,132,'查看遗忘记录')
        c.text(x,y+386,'这些是设置页；Memory tab 仅显示右侧采用收据。',12,C['mute'])
    elif ident=='07':
        c.text(x,y+9,'前台优先与后台队列',20,C['ink'],600)
        card(c,x,y+31,w,92,'前台优先策略',('已启用','green'));c.text(x+16,y+85,'跨会话前台启动时，后台调用自动让路并保留阶段。',14,C['body'])
        table(c,x,y+145,w,['任务','状态','原因'],[['会话 B · 前台分析','执行中','当前用户请求'],['会话 A · Reflection','等待','已取消调用并让路'],['Expert 方法验证','排队','后台串行']],[.43,.22,.35])
        button(c,x,y+317,145,'暂停后台队列');button(c,x+159,y+317,167,'查看有限重试与失败')
        c.text(x,y+382,'队列与策略在设置，工作台不承载后台管理。',12,C['mute'])
    elif ident=='08':
        chat(c,a,'本轮采用只读研究专家，核对项目与来源。','本轮专家信息展示在 Expert tab；库编辑、范围与验证统一进入设置。')
        card(c,x,y+198,w,145,'本轮采用一致');c.text(x+16,y+243,'自动 use 与明确选择遵守同一冻结范围。',14,C['body']);c.text(x+16,y+278,'本轮仍使用 v1；库中 v2 不改写当前记录。',13,C['mute']);button(c,x+16,y+307,151,'到设置查看采用记录')
    elif ident=='09':
        chat(c,a,'复核只指出 task-a 错误，请保留 task-b 成果。','右侧仅显示当前依赖图；定向返工从任务详情进入。')
        card(c,x,y+181,w,178,'任务详情 · 定向返工',('待确认','amber'))
        c.text(x+16,y+228,'受影响：task-a 与依赖它的整合；保留 task-b。',13,C['body'])
        c.text(x+16,y+267,'修订方法：增加空输入案例，保留 UTF-8 规则。',13,C['mute'])
        button(c,x+16,y+297,155,'确认方案并接续','primary');button(c,x+184,y+297,158,'设置中调整深度配置')
        c.text(x,y+393,'Swarm tab 不混入新建表单、成员管理或全部历史。',12,C['mute'])
    elif ident=='10':
        c.text(x,y+9,'共享材料冲突',20,C['ink'],600)
        c.text(x,y+38,'接口约定.md · 本地基于 v1 · 最新已保存 v2',12,C['mute'])
        widths=(w-28)/3
        for i,(lab,body,bg) in enumerate([('你的草稿','API 名称\n新增 UTF-8 检查',C['redbg']),('最新 v2','API 名称\n修改返回字段',C['bluebg']),('合并结果','API 名称\n两项独立变更',C['soft'])]):
            xx=x+i*(widths+14);c.rect(xx,y+62,widths,118,bg,None,8);c.text(xx+10,y+87,lab,13,C['ink'],600);c.block(xx+10,y+117,body,widths-20,12,leading=22,max_lines=3)
        button(c,x,y+204,159,'保存合并为 v3','primary');button(c,x+174,y+204,142,'保留草稿')
        card(c,x,y+261,w,109,'保存与通知');c.text(x+16,y+307,'先完成共享版本保存，再发布更新事件。',14,C['body']);c.text(x+16,y+342,'版本管理放设置-任务管理，Swarm tab 只展示 DAG。',12,C['mute'])
    elif ident=='11':
        card(c,x,y,w,326,'执行计划',('待批准','amber'))
        c.text(x+16,y+63,'目标：补齐预览与新文件 Diff',17,C['ink'],600)
        c.block(x+16,y+97,'有效约束：UTF-8；不更改旧项目；仍由 Pi 原生执行。',w-32,13,max_lines=2)
        table(c,x+16,y+145,w-32,['步骤','文件范围','客观检查'],[['只读探索','src / README','来源可回查'],['实现验证','preview.ts','测试 + Diff']],[.31,.34,.35],11)
        button(c,x+16,y+269,140,'批准并执行','primary');button(c,x+169,y+269,111,'修订计划');button(c,x+294,y+269,113,'保持分析')
        c.text(x,y+374,'计划批准是任务流程；长期策略与启停仍在设置。',12,C['mute'])
    elif ident=='12':
        chat(c,a,'查看本项目还有哪些工作等待处理。','项目继续横向展示；左栏按状态组织会话，归档和详细管理放设置。')
        card(c,x,y+181,w,168,'当前项目');
        for i,(lab,state,k) in enumerate([('解析器修复','执行中','green'),('预览计划','等待批准','amber')]):status_row(c,x+16,y+237+i*68,w-32,lab,state,k)
        c.text(x,y+393,'会话组织保留原布局，右工作台不承担全库管理。',12,C['mute'])
    elif ident=='13':
        chat(c,a,'找回第一次提出 UTF-8 约束的轮次。','短线预览、书签和定位保持；增加主题、关键词、仅书签与范围回查。')
        card(c,x,y+177,w,216,'第 1 轮 · 目标与约束',('已收藏','green'))
        c.text(x+16,y+228,'请求：保留 UTF-8，补齐预览。',14,C['body']);c.text(x+16,y+258,'回答：先检查原文，再验证文件结果。',13,C['mute'])
        pill(c,x+16,y+281,'2 个工具','green');pill(c,x+115,y+281,'1 个文件','blue');pill(c,x+213,y+281,'2 条来源','gray')
        button(c,x+16,y+335,100,'定位原文','primary');button(c,x+129,y+335,115,'仅书签');button(c,x+258,y+335,128,'选择轮次范围')
    elif ident=='14':
        c.text(x,y+9,'项目布局与快捷键',20,C['ink'],600)
        for i,(lab,detail) in enumerate([('专注','仅对话'),('双栏','对话 + 工作台'),('三栏','会话 / 对话 / 工作台')]):
            xx=x+i*(w+12)/3;c.rect(xx,y+33,(w-24)/3,92,C['soft'] if i==2 else C['gray'],C['line'],8);c.text(xx+11,y+62,lab,14,C['ink'],600);c.block(xx+11,y+90,detail,(w-44)/3,11,C['mute'],max_lines=2)
        input_box(c,x,y+162,w,'本项目恢复方式','比例 20 / 53 / 27 · 可切换固定像素')
        table(c,x,y+240,w,['操作','快捷键','作用域'],[['打开工作台','⌘⇧W','当前窗口'],['定位轮次','⌘J','当前会话'],['关闭浮层','Esc','窄屏']],[.44,.26,.30])
        c.text(x,y+413,'已有拖动、键盘与窄屏基础；这里只增强预设和恢复质量。',11,C['mute'])
    elif ident=='15':
        chat(c,a,'对照设计图片、源文件与本轮 Diff。','附件已有文本与图片能力；增强文件树、多标签和可回查链接。')
        card(c,x,y+188,w,164,'本轮附件与文件链接');pill(c,x+16,y+239,'preview.txt · 文本','gray');pill(c,x+184,y+239,'设计.png · 图片','blue');c.text(x+16,y+290,'点击来源文件，右侧文件 tab 保留阅读位置。',14,C['body']);c.text(x+16,y+327,'不把现有文件预览和附件能力写成缺失。',12,C['mute'])
    elif ident=='16':
        c.text(x,y+9,'可搜索的全局与项目配置',20,C['ink'],600)
        input_box(c,x,y+42,w,'搜索设置','型号能力、默认模式、插件、快捷键…')
        card(c,x,y+129,w,126,'默认协作方式',('Swarm 已校验','green'));c.text(x+16,y+178,'Swarm 插件同步启用，保存后的有效值一致。',14,C['body']);c.text(x+16,y+222,'当前会话继续使用原执行快照。',13,C['mute'])
        table(c,x,y+282,w,['型号能力','配置来源','状态'],[['视觉 / 思考','显式型号声明','可检查'],['上下文 / 输出上限','真实能力设置','可检查']],[.43,.34,.23])
        c.text(x,y+404,'API Key 保留既有认证，不显示凭据。',11,C['mute'])
    elif ident=='17':
        c.text(x,y+9,'专家验证模板与基准',20,C['ink'],600)
        c.text(x,y+39,'载入已保存基准 v2；修改生成新版本。',12,C['mute'])
        for i,lab in enumerate(['代码改动','稳定 JSON','事实核验']):button(c,x+i*(w+12)/3,y+59,(w-24)/3,lab,'blue' if i==1 else 'plain')
        table(c,x,y+119,w,['用例','类型','客观门槛'],[['case-a','适用','字段 / 类型匹配'],['case-b','独立适用','输出范围匹配'],['edge-a','范围外','拒绝越界要求']],[.28,.25,.47])
        card(c,x,y+278,w,103,'发布门槛',('待验证','amber'));c.text(x+16,y+324,'2 个独立正例 + 1 个反例 + 必要客观检查。',14,C['body']);c.text(x+16,y+357,'缺少证据不发布；管理不进入 Expert tab。',12,C['mute'])
    elif ident=='18':
        c.text(x,y+9,'连续现场与来源回查',20,C['ink'],600)
        card(c,x,y+32,w,127,'第 4 次整理',('已保存','green'));c.text(x+16,y+80,'覆盖 1–24 轮，新输入 25–26 仍保留原文。',14,C['body']);c.text(x+16,y+115,'有效约束 2 条；只撤回已纠正事实。',13,C['mute']);c.text(x+16,y+144,'有限窗口：示例 68% · 近期原文保留 4 轮',11,C['mute'])
        card(c,x,y+181,w,192,'来源回查');c.text(x+16,y+229,'演进项目 / 约束会话 / 第 1 轮',13,C['blue']);c.rect(x+16,y+247,w-32,60,C['soft'],None,8);c.text(x+27,y+282,'当前引用：必须保留 UTF-8 中文字段。',13,C['body']);button(c,x+16,y+329,119,'跳转原轮次','primary');button(c,x+148,y+329,141,'返回当前会话')
        c.text(x,y+412,'不新增 Context 页，诊断与长期策略归设置-高级。',11,C['mute'])
    elif ident=='19':
        chat(c,a,'本轮真正选用了什么专家与记忆？','工作台只显示当前工作信息；未采用的候选、检索命中与库记录不冒充已用。')
        card(c,x,y+188,w,173,'轻量工作台',('用户已选方向','blue'))
        c.text(x+16,y+238,'一个入口：文件 / Diff / Swarm / Expert / Memory',14,C['body'])
        c.text(x+16,y+276,'规划看依赖图，专家看本轮选用，记忆看真实采用。',13,C['mute'])
        c.text(x+16,y+315,'启停、长期配置与详细管理统一放设置。',13,C['mute'])
        c.text(x+16,y+345,'没有 Context tab；原生历史与后台能力继续保留。',12,C['body'])


def compare(ident):
    title,before,after,evidence=META[ident]
    c=Canvas(2632,1190,f'{ident} {title}｜Friend-Pi 优化前后产品对比',
             '左侧是固定候选的产品界面示意，依据源码与实测且采用示例数据；右侧是未来方案，未实现，等待用户决策。')
    c.rect(0,0,c.w,c.h,C['white'])
    pill(c,26,19,f'优化点 {ident}','green',13)
    c.text(26,82,title,35,C['ink'],600)
    c.text(26,113,'保留 Friend 布局：顶栏项目 · 左侧会话 · 中央对话/轮次/输入 · 右侧按需工作台',17,C['mute'])
    c.append(draw_scene(ident,False),18,147);c.append(draw_scene(ident,True),1334,147)
    c.line(1316,171,1316,1017,C['line'],1)
    c.block(34,1064,'现状：'+before,1232,17,C['body'],leading=25,max_lines=3)
    c.block(1350,1064,'未来（未实现）：'+after,1232,17,C['blue'],leading=25,max_lines=3)
    c.text(34,1152,'依据：'+ ' · '.join(evidence),14,C['mute'])
    c.text(1350,1152,'布局方向用户已确认；实施与验证尚未进行。' if ident=='19' else '能力细节仍待用户决策后实施。',14,C['blue'])
    c.text(34,1181,'参考候选 5ec4b39 · Pi eb326d2 · 图为示意，示例数据；不替代真实客户端截图。',13,C['mute'])
    return c


def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    global FONT
    p=argparse.ArgumentParser(description=__doc__,formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--output-dir',type=Path,default=HERE)
    p.add_argument('--render-dir',type=Path,help='Optional standalone and paired PNG output directory')
    p.add_argument('--only',default='',help='Comma-separated IDs, e.g. 01,04')
    p.add_argument('--catalog',type=Path,help='JSON overrides keyed by ID: title/beforeSummary/afterSummary/evidence')
    p.add_argument('--font',default=FONT,help='CJK TrueType/TTC font for deterministic PNG rendering')
    p.add_argument('--scale',type=float,default=1.5)
    args=p.parse_args();FONT=args.font
    allowed_visuals=HERE.resolve();allowed_render=(ROOT/'.artifacts/qa/evolution-audit/report-render').resolve()
    # This generator is scoped to report artifacts, never application source or user data.
    args.output_dir=args.output_dir.resolve()
    if not args.output_dir.is_relative_to(allowed_visuals):p.error('output-dir must remain inside this visuals directory')
    if args.render_dir:
        args.render_dir=args.render_dir.resolve()
        if not args.render_dir.is_relative_to(allowed_render):p.error('render-dir must remain inside .artifacts/qa/evolution-audit/report-render')
        if Image is None:p.error('Pillow unavailable; use the bundled Python, or omit --render-dir')
        args.render_dir.mkdir(parents=True,exist_ok=True)
    if args.catalog:
        override=json.loads(args.catalog.read_text())
        for ident,d in override.items():
            if ident not in META:p.error(f'Unknown catalog ID {ident}')
            old=META[ident];META[ident]=(d.get('title',old[0]),d.get('beforeSummary',old[1]),d.get('afterSummary',old[2]),d.get('evidence',old[3]))
    ids=[i.strip().zfill(2) for i in args.only.split(',') if i.strip()] or list(META)
    for ident in ids:
        if ident not in META:p.error(f'Unknown ID {ident}')
    args.output_dir.mkdir(parents=True,exist_ok=True)
    items=[];checks=[]
    for ident in ids:
        title,before,after,evidence=META[ident]
        canvases={'before':draw_scene(ident,False),'after':draw_scene(ident,True),'comparison':compare(ident)}
        paths={};render_paths={}
        for kind,canvas in canvases.items():
            path=args.output_dir/f'{ident}-{kind}.svg';path.write_text(canvas.svg(),encoding='utf8')
            element=ElementTree.fromstring(path.read_text());assert element.tag=='{http://www.w3.org/2000/svg}svg'
            assert '未实现' in path.read_text() or kind=='before'
            paths[kind]={'file':path.name,'sha256':sha(path),'width':canvas.w,'height':canvas.h,'primitiveCount':len(canvas.ops)}
            if args.render_dir:
                png=args.render_dir/f'{ident}-{kind}.png';canvas.png(png,args.scale);render_paths[kind]={'file':str(png),'sha256':sha(png)}
            checks.append({'id':ident,'variant':kind,'xml':'PASS','primitives':len(canvas.ops),'notScreenshot':True,'futureUnimplemented':kind!='before'})
        items.append({'id':ident,'title':title,'beforeSummary':before,'afterSummary':after,'evidenceIds':evidence,'type':'product-layout-comparison','currentEvidenceLevel':'source-and-recorded-observation schematic; example data','futureImplemented':False,'directionStatus':'user-selected' if ident=='19' else 'proposal','futureSurface':'settings' if ident in AFTER_SETTINGS else 'conversation-and-light-workbench','futureWorkbenchTab':AFTER_TAB[ident],'files':paths,'renders':render_paths})
    manifest={'schemaVersion':1,'generatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'candidate':PIN,'generator':Path(__file__).name,'drawingPolicy':'No business modifications, no GUI input, no credentials. SVG/PNG are illustrative product layouts, not screenshots. Future proposals remain unimplemented.','theme':'light Friend original layout','fontFamily':FONT_FAMILY,'pngRenderer':{'library':'Pillow' if args.render_dir else None,'font':FONT if args.render_dir else None,'scale':args.scale if args.render_dir else None,'browserUsed':False},'pointCount':len(items),'futureWorkbenchContract':{'entryCount':1,'tabs':['文件','Diff','Swarm','Expert','Memory'],'contextTab':False,'swarmScope':'current planning DAG only','expertScope':'current selected expert intro/direction/common Skills','memoryScope':'actual current session/round adoption receipts only','allManagementAndPersistentConfiguration':'settings','userSelectedDirectionIds':['19']},'items':items}
    (args.output_dir/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    (args.output_dir/'catalog.json').write_text(json.dumps({i:{'title':META[i][0],'beforeSummary':META[i][1],'afterSummary':META[i][2],'evidence':META[i][3]} for i in META},ensure_ascii=False,indent=2)+'\n')
    # A static, offline index; no remote scripts, analytics, API calls or user credentials.
    links=[]
    for item in items:
        ident=item['id'];links.append(f'<article id="point-{ident}"><h2>{ident} · {html.escape(item["title"])}</h2><img loading="lazy" src="{ident}-comparison.svg" alt="{html.escape(item["title"])}：当前与未来方案对比"/><div class="notes"><p><b>当前：</b>{html.escape(item["beforeSummary"])}</p><p><b>未来（未实现）：</b>{html.escape(item["afterSummary"])}</p></div><p class="links"><a href="{ident}-before.svg">单独查看当前示意</a><a href="{ident}-after.svg">单独查看未来方案</a><small>依据：{html.escape(" · ".join(item["evidenceIds"]))}</small></p></article>')
    nav=''.join(f'<a href="#point-{item["id"]}">{item["id"]}</a>' for item in items)
    page='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Friend-Pi 演进规划 · 产品前后对比图</title><style>body{margin:0;background:#f4f6f2;color:#304a3b;font-family:system-ui,"PingFang SC",sans-serif}header{max-width:1500px;margin:40px auto;padding:0 24px}h1{font-size:32px}header p{line-height:1.8;color:#667c6d}nav{display:flex;gap:9px;flex-wrap:wrap}a{color:#287257}nav a{padding:7px 12px;background:white;border:1px solid #dce5d8;border-radius:8px;text-decoration:none}main{max-width:1800px;margin:auto;padding:0 18px 60px}article{background:white;border:1px solid #dce5d8;border-radius:18px;padding:20px;margin:24px 0;scroll-margin:12px}article h2{margin:8px 12px 22px;font-size:23px}img{display:block;width:100%;height:auto}.notes{display:grid;grid-template-columns:1fr 1fr;gap:35px;padding:0 20px}.notes p{line-height:1.7;color:#587060}.links{display:flex;flex-wrap:wrap;gap:25px;padding:0 20px}.links small{color:#7b8a7c}@media(max-width:900px){.notes{grid-template-columns:1fr;gap:0}article{padding:8px}img{min-width:1100px}article{overflow:auto}}@media print{nav{display:none}article{page-break-inside:avoid;border:0;box-shadow:none;padding:0}body{background:white}}</style><header><h1>Friend-Pi 后续演进 · 产品对比示意</h1><p>固定候选 5ec4b39 / Pi eb326d2。左侧依据源码与已记录实测重构当前界面，采用示例数据；右侧为尚未实现的未来方案。图不替代真实产品截图，工作台布局已按用户最新方向规划，能力细节仍未实现；第 19 点为用户已选方向。</p><nav>'+nav+'</nav></header><main>'+''.join(links)+'</main></html>'
    (args.output_dir/'index.html').write_text(page)
    readme='''# Friend-Pi 演进规划对比图\n\n本目录包含 19 个优化点，每点有 before / after / comparison 三个 SVG。全部为产品布局示意，采用示例数据，**不是新客户端截图**；after 与 comparison 都明确标注未来未实现。当前依据源码及实测记录，证据 ID 在 manifest.json / catalog.json 中。真实截图由 Root 统一采集与管理。未来图统一采用用户明确的单入口、五个轻量 tabs，管理与长期配置放设置，不展示 Context tab；第 19 点标为用户已选方向，仍未实现。\n\n生成器只写本目录；可选 PNG 只写 `.artifacts/qa/evolution-audit/report-render`。不修改业务代码、不调用 GUI、不读取凭据。\n\n```sh\npython3 docs/research/2026-10-07-friend-pi-evolution/visuals/generate_visuals.py\n\n# 只重建选定优化点；--catalog 可覆盖标题、当前/未来说明及证据 ID\npython3 docs/research/2026-10-07-friend-pi-evolution/visuals/generate_visuals.py --only 01,04 --catalog docs/research/2026-10-07-friend-pi-evolution/visuals/catalog.json\n\n# 可选离线 PNG，使用已有 Pillow，不调用浏览器或真实 GUI\n/Users/youdongliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 docs/research/2026-10-07-friend-pi-evolution/visuals/generate_visuals.py --render-dir /Users/youdongliang/Desktop/Friend-Pi/.artifacts/qa/evolution-audit/report-render\n```\n\n`index.html` 是离线图集，无外部脚本。`validate_visuals.py` 可重新核对 19 点摘要、XML、文字边界和统一工作台约束，结果只写 QA 的 report-render 目录。`manifest.json` 记录 SVG/PNG 摘要和固定候选身份。`--font` 可指定支持中文的 TrueType/TTC 字体，`--scale` 指定 PNG 比例。SVG 生成不依赖 Pillow。\n\n局部重建会使 manifest/index 只列出本次选择的图；完整交付前再次不带 --only 生成全 19 点。不要将 before 示意当成原始截图，也不要把 after 视为已实现。\n'''
    (args.output_dir/'README.md').write_text(readme)
    validation={'schemaVersion':1,'sourceCommit':PIN['sourceCommit'],'visualPoints':len(items),'svgCount':len(checks),'svgXmlPass':True,'noGuiInput':True,'noCredentialReads':True,'sourceBusinessUnchanged':True,'checks':checks}
    if args.render_dir:(args.render_dir/'visual-validation.json').write_text(json.dumps(validation,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'output':str(args.output_dir),'points':len(items),'svgFiles':len(checks),'pngOutput':str(args.render_dir) if args.render_dir else None},ensure_ascii=False))

if __name__=='__main__':main()
