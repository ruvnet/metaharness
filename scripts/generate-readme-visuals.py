#!/usr/bin/env python3
"""Generate the repository's self-contained SVG motion system. Python stdlib only.

The storyboard is editorial source; generated geometry is deterministic. No JS,
external fonts, remote images, or runtime dependencies are embedded in the SVGs.
"""
from pathlib import Path
from html import escape
import argparse
import itertools
import json
import math
import random

ROOT = Path(__file__).resolve().parents[1]
C = dict(bg='#05090f', panel='#0c1724', line='#2b4358', mint='#7ef0cf',
         ice='#b1d9ff', orange='#ffac78', violet='#b2a0ff', white='#eff7ff', muted='#9bb1c7')


def text(x, y, value, size=28, color='white', weight=500, **attrs):
    at = ' '.join(f'{k.replace("_", "-")}="{escape(str(v), quote=True)}"' for k, v in attrs.items())
    return f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" fill="{C.get(color,color)}" {at}>{escape(str(value))}</text>'


def path(d, color='line', width=1.5, **attrs):
    at = ' '.join(f'{k.replace("_", "-")}="{escape(str(v), quote=True)}"' for k, v in attrs.items())
    return f'<path d="{d}" fill="none" stroke="{C.get(color,color)}" stroke-width="{width}" {at}/>'


def rect(x, y, w, h, fill='panel', stroke='line', rx=16, **attrs):
    at = ' '.join(f'{k.replace("_", "-")}="{escape(str(v), quote=True)}"' for k, v in attrs.items())
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{C.get(fill,fill)}" stroke="{C.get(stroke,stroke)}" {at}/>'


def circle(x, y, r, color='mint', **attrs):
    at = ' '.join(f'{k.replace("_", "-")}="{escape(str(v), quote=True)}"' for k, v in attrs.items())
    return f'<circle cx="{x}" cy="{y}" r="{r}" fill="{C.get(color,color)}" {at}/>'


CSS = '''
text{font-family:Inter,"Segoe UI",Arial,sans-serif} .mono{font-family:"SFMono-Regular",Consolas,monospace}
.packet{stroke-dasharray:5 95;animation:travel 3.6s linear infinite}
.trace{stroke-dasharray:26 74;animation:travel 6s linear infinite}
.orbit{transform-box:fill-box;transform-origin:center;animation:orbit 24s linear infinite}
.counter-orbit{transform-box:fill-box;transform-origin:center;animation:orbit 32s linear infinite reverse}
.pulse{animation:pulse 3.6s ease-in-out infinite}
.float{animation:float 7s ease-in-out infinite}
.scan{animation:scan 5s ease-in-out infinite}
.step{animation:step 8s ease-in-out infinite}
.cursor{animation:blink 1.2s steps(2,end) infinite}
.still{display:none}
@keyframes travel{to{stroke-dashoffset:-100}}
@keyframes orbit{to{transform:rotate(360deg)}}
@keyframes pulse{0%,100%{opacity:.45}50%{opacity:1}}
@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-9px)}}
@keyframes scan{0%,100%{transform:translateX(0);opacity:0}10%,90%{opacity:.7}50%{transform:translateX(228px)}}
@keyframes step{0%,20%,100%{stroke:#7ef0cf;stroke-opacity:.9}28%,92%{stroke:#2b4358;stroke-opacity:1}}
@keyframes blink{50%{opacity:0}}
@media(prefers-reduced-motion:reduce){
 *{animation:none!important;transition:none!important}
 .motion{display:none!important}.still{display:inline!important}
 .scene{display:none!important}.scene-first{display:inline!important;opacity:1!important}
 .packet,.trace{stroke-dasharray:none!important;opacity:.7}.scan{display:none}
}
'''


def defs(extra=''):
    return f'''<defs>
<radialGradient id="ambient"><stop stop-color="#183246" stop-opacity=".62"/><stop offset="1" stop-color="#05090f" stop-opacity="0"/></radialGradient>
<linearGradient id="panel" x2="1" y2="1"><stop stop-color="#102233"/><stop offset="1" stop-color="#08111c"/></linearGradient>
<linearGradient id="beam"><stop stop-color="#b1d9ff"/><stop offset=".5" stop-color="#7ef0cf"/><stop offset="1" stop-color="#ffac78"/></linearGradient>
<filter id="glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="3"/></filter>
<marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M1 1L7 4L1 7" fill="none" stroke="#9bb1c7" stroke-width="1.4"/></marker>
<clipPath id="frame"><rect width="960" height="540" rx="22"/></clipPath>
</defs><style>{CSS}{extra}</style>'''


def base(h=540):
    s = rect(0, 0, 960, h, 'bg', 'line', 22)
    s += f'<ellipse cx="690" cy="{h*.48}" rx="470" ry="{h*.7}" fill="url(#ambient)"/>'
    for x in range(32, 956, 32):
        for y in range(24, h, 32):
            s += circle(x, y, .7, '#26394c', opacity='.45')
    s += path(f'M28 52V28H52 M908 28h24v24 M28 {h-52}v24h24 M908 {h-28}h24v-24', 'ice', 1, opacity='.5')
    return s


def svg(title, desc, content, h=540, extra=''):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="960" height="{h}" viewBox="0 0 960 {h}" role="img" aria-labelledby="title desc">
<title id="title">{escape(title)}</title><desc id="desc">{escape(desc)}</desc>
{defs(extra)}{base(h)}{content}</svg>\n'''


def signal(d, color='mint', delay=0, arrow=True):
    return (path(d, 'line', 2, **({'marker_end':'url(#arrow)'} if arrow else {}))
            + path(d, color, 5, opacity='.16', pathLength=100, **{'class':'packet','style':f'animation-delay:{delay}s','filter':'url(#glow)'})
            + path(d, color, 2.2, pathLength=100, **{'class':'packet','style':f'animation-delay:{delay}s'}))


def icon(kind, x, y, size=46, color='mint'):
    shapes = {
      'cube': 'M24 3L44 14V36L24 47L4 36V14Z M4 14L24 25L44 14 M24 25V47 M24 3V25',
      'shield': 'M24 3L42 10V25Q40 39 24 46Q8 39 6 25V10Z M15 24L22 31L34 17',
      'graph': 'M8 10L24 24L40 8 M24 24L9 40 M24 24L41 39 M8 10L40 8L41 39L9 40Z',
      'layers': 'M3 14L24 3L45 14L24 25Z M3 24L24 35L45 24 M3 34L24 45L45 34',
      'code': 'M16 12L4 24L16 36 M32 12L44 24L32 36 M28 5L20 43',
      'route': 'M6 24H18Q24 24 24 18V8H42 M24 18V37H42 M35 2L42 8L35 14 M35 31L42 37L35 43',
      'loop': 'M40 16A18 18 0 0 0 8 12L4 20 M4 9V20H15 M8 32A18 18 0 0 0 32 41L44 28 M33 28H44V39',
      'memory': 'M6 10C6 2 42 2 42 10C42 18 6 18 6 10V37C6 45 42 45 42 37V10 M6 23C6 31 42 31 42 23',
      'terminal': 'M5 7H43V41H5Z M12 17L20 24L12 31 M26 31H36',
      'scan': 'M4 16V4H16 M32 4H44V16 M44 32V44H32 M16 44H4V32 M13 15H35 M13 24H29 M13 33H35',
      'ship': 'M24 4L43 16V37L24 47L5 37V16Z M5 16L24 27L43 16 M24 27V47 M15 10L34 22',
      'spark': 'M24 2L29 18L46 24L29 30L24 46L19 30L2 24L19 18Z',
      'witness': 'M7 4H30L41 15V44H7Z M30 4V15H41 M14 24H34 M14 31H29 M14 38H24',
      'chip': 'M11 11H37V37H11Z M18 18H30V30H18Z M17 3V11 M31 3V11 M17 37V45 M31 37V45 M3 17H11 M3 31H11 M37 17H45 M37 31H45',
      'clock': 'M24 5A19 19 0 1 1 23.9 5 M24 12V25L34 31',
    }
    d=shapes.get(kind, shapes['cube'])
    return f'<g transform="translate({x} {y}) scale({size/48})">'+path(d,color,2,stroke_linejoin='round',stroke_linecap='round')+path(d,color,2.8,pathLength=100,**{'class':'trace','opacity':'.85'})+'</g>'


def wire_geometry(kind, cx, cy, scale=1, phase=0):
    """Matched-vertex projections; every sampled path has identical topology."""
    points=[]; edges=[]
    if kind=='hypercube':
        raw=list(itertools.product((-1,1),repeat=4))
        for i,v in enumerate(raw):
            p=list(v)
            for a,b,t in [(0,3,phase),(1,2,phase*.5+.4),(0,2,.4),(1,3,.5)]:
                p[a],p[b]=p[a]*math.cos(t)-p[b]*math.sin(t),p[a]*math.sin(t)+p[b]*math.cos(t)
            z=3.9/(3.9-p[3]); depth=5/(5-p[2]*z)
            points.append((cx+p[0]*z*depth*60*scale,cy+p[1]*z*depth*60*scale))
        edges=[(i,j) for i,v in enumerate(raw) for j,u in enumerate(raw) if j>i and sum(a!=b for a,b in zip(v,u))==1]
    elif kind=='torus':
        for i in range(24):
            a=i*math.tau/24+phase
            for j in range(8):
                b=j*math.tau/8
                x=(98+32*math.cos(b))*math.cos(a)
                z=(98+32*math.cos(b))*math.sin(a)
                y=32*math.sin(b)
                yy=y*math.cos(.8)-z*math.sin(.8)
                zz=y*math.sin(.8)+z*math.cos(.8)
                perspective=500/(500-zz)
                points.append((cx+x*perspective*scale,cy+yy*perspective*scale))
                k=i*8+j
                edges.extend([(k,i*8+(j+1)%8),(k,((i+1)%24)*8+j)])
    elif kind=='hyperbolic':
        for ring in range(6):
            r=140*math.tanh(ring*.38)
            for j in range(36):
                a=j*math.tau/36+phase+math.sin(phase)*(1-ring*.06)*.16
                points.append((cx+r*math.cos(a)*scale,cy+r*math.sin(a)*.74*scale))
                k=ring*36+j
                if ring: edges.append((k,k-36))
                edges.append((k,ring*36+(j+1)%36))
    elif kind=='sphere':
        for i in range(11):
            a=(i+1)*math.pi/12
            for j in range(24):
                b=j*math.tau/24+phase
                x=math.sin(a)*math.cos(b)*132
                z=math.sin(a)*math.sin(b)*132
                y=math.cos(a)*132
                yy=y*.85-z*.5; zz=y*.5+z*.85
                k=i*24+j; dep=480/(480-zz)
                points.append((cx+x*dep*scale,cy+yy*dep*scale))
                edges.append((k,i*24+(j+1)%24))
                if i: edges.append((k,k-24))
    else: # interference surface
        for i in range(18):
            for j in range(12):
                x=(i-8.5)*17; z=(j-5.5)*19
                y=math.sin(i*.42+phase)*math.cos(j*.44+phase)*24
                points.append((cx+(x+z*.35)*scale,cy+(y+z*.52)*scale))
                k=i*12+j
                if i: edges.append((k,k-12))
                if j: edges.append((k,k-1))
    d=' '.join(f'M{points[a][0]:.1f} {points[a][1]:.1f}L{points[b][0]:.1f} {points[b][1]:.1f}' for a,b in edges)
    return d,points


def geometry(kind, cx, cy, scale=1, color='ice'):
    frames=[wire_geometry(kind,cx,cy,scale,i*math.tau/24) for i in range(25)]
    # Four-dimensional rotation needs two complete revolutions for a seamless loop.
    if kind=='hypercube': frames=[wire_geometry(kind,cx,cy,scale,i*math.tau/12) for i in range(25)]
    vals=';'.join(d for d,p in frames)
    motion=f'<path d="{frames[0][0]}" fill="none" stroke="{C[color]}" stroke-width="1" opacity=".58"><animate attributeName="d" values="{vals}" dur="24s" repeatCount="indefinite"/></path>'
    for n in range(0,len(frames[0][1]),max(1,len(frames[0][1])//18)):
        x,y=frames[0][1][n]
        xs=';'.join(f'{p[n][0]:.1f}' for d,p in frames)
        ys=';'.join(f'{p[n][1]:.1f}' for d,p in frames)
        motion+=f'<circle cx="{x:.1f}" cy="{y:.1f}" r="2.4" fill="{C["white"]}"><animate attributeName="cx" values="{xs}" dur="24s" repeatCount="indefinite"/><animate attributeName="cy" values="{ys}" dur="24s" repeatCount="indefinite"/></circle>'
    still=path(frames[0][0],color,1,opacity='.58')
    return '<g class="motion">'+motion+'</g><g class="still">'+still+'</g>'


def card(x,y,w,h,title,sub='',ico=None,color='mint',index=0):
    s=rect(x,y,w,h,'url(#panel)','line',14)
    s+=rect(x,y,w,h,'none',color,14,**{'class':'step','style':f'animation-delay:{-index*1.5}s'})
    if ico:
        s+=icon(ico,x+18,y+17,34,color)
        tx=x+62
    else: tx=x+22
    s+=text(tx,y+(32 if h<90 else 41),title,26 if h<90 or w<270 else 28,color,700)
    if sub: s+=text(x+22,y+h-18 if h<90 else y+h-21,sub,20 if h<90 or w<280 else 21,'muted')
    return '<g class="diagram-card">'+s+'</g>'


def sequence(labels,subs,icons=None,colors=None):
    n=len(labels); icons=icons or ['cube']*n; colors=colors or ['mint']*n
    s=''; coords=[]
    if n<=3: coords=[(48+i*298,248) for i in range(n)]
    elif n==4: coords=[(94,204),(546,204),(546,351),(94,351)]
    else: coords=[(58,207),(362,207),(666,207),(666,359),(362,359),(58,359)][:n]
    w=320 if n==4 else 268 if n<=3 else 236
    h=104
    for i,((x,y),(u,v)) in enumerate(zip(coords,coords[1:])):
        if y==v:
            d=f'M{x+w} {y+52}H{u}' if x<u else f'M{x} {y+52}H{u+w}'
        else: d=f'M{x+w/2} {y+h}V{v}'
        s+=signal(d,colors[i],-i*.8)
    for i,(x,y) in enumerate(coords):
        s+=card(x,y,w,h,labels[i],subs[i] if subs else '',icons[i],colors[i],i)
        s+=text(x+6,y-12,f'0{i+1}',17,'muted',600,**{'class':'mono'})
    return s


def coherence():
    s=''
    centers=[(240,310),(710,310)]
    for n,(cx,cy) in enumerate(centers):
        s+=f'<ellipse cx="{cx}" cy="{cy}" rx="169" ry="115" fill="#0b1a28" stroke="{C["mint" if n==0 else "violet"]}" stroke-opacity=".5"/>'
        pts=[(cx+math.cos(i*math.tau/10)*110,cy+math.sin(i*math.tau/10)*72) for i in range(10)]
        pts+=[(cx,cy),(cx-40,cy-30),(cx+35,cy+18)]
        for i,(x,y) in enumerate(pts):
            for j,(u,v) in enumerate(pts):
                if i<j and (i+j)%3==0: s+=path(f'M{x:.1f} {y:.1f}L{u:.1f} {v:.1f}','ice',.9,opacity='.27')
            s+=circle(round(x,1),round(y,1),4,'white')
        s+=text(cx,462,'DOMAIN A' if n==0 else 'DOMAIN B',26,'mint' if n==0 else 'violet',600,text_anchor='middle')
    s+=signal('M240 310C360 173 592 440 710 310','orange')
    s+=path('M477 204V436','orange',1.5,stroke_dasharray='4 8',opacity='.6')
    s+=rect(366,173,225,43,'bg','line',20)+text(478,202,'CUT PRESSURE',20,'orange',600,text_anchor='middle')
    s+=circle(480,310,8,'orange',**{'class':'pulse'})
    return s


def layers(labels, captions):
    s=geometry('hypercube',178,331,.8,'ice')
    for i,(label,caption) in enumerate(zip(labels,captions)):
        y=187+i*54
        s+=path(f'M350 {y+6}L864 {y+6}L912 {y+28}L398 {y+28}Z','ice',1,opacity='.35')
        s+=rect(372,y+10,530,44,'url(#panel)','line',5,**{'class':'step','style':f'animation-delay:{-i*1.3}s'})
        s+=text(391,y+40,label,25,'white',600)
        if caption: s+=text(875,y+39,caption,19,'mint',500,text_anchor='end')
    return s


def security():
    s=sequence(['Capability','Proof','Witness'],['Check authority','Verify transition','Record decision'],['shield','scan','witness'])
    s+=signal('M778 352V409H643V433','mint')+signal('M778 409H241V433','orange')
    s+=text(585,464,'ALLOW: APPLY',25,'mint',650)+text(94,464,'DENY: NO MUTATION',25,'orange',650)
    return s


def cycle(labels, subs):
    s=''
    coords=[(85,210),(550,210),(550,365),(85,365)]
    routes=['M405 256H550','M710 314V365','M550 411H405','M245 365V314']
    for i,d in enumerate(routes): s+=signal(d,'orange' if i==2 else 'mint',-i*.8)
    for i,((x,y),title,sub) in enumerate(zip(coords,labels,subs)):
        s+=card(x,y,320,96,title,sub,['scan','code','shield','loop'][i], 'orange' if i==2 else 'mint',i)
    s+=text(480,348,'↻',38,'muted',500,text_anchor='middle')
    return s


def routing():
    s=geometry('hyperbolic',246,326,.92,'ice')
    s+=signal('M260 323C386 179 448 232 554 231','muted')
    s+=signal('M260 323C386 292 448 324 554 324','mint')
    s+=signal('M260 323C386 448 448 417 554 417','muted')
    for i,(title,sub,col) in enumerate([('Candidate A','Predicted quality / cost','muted'),('Selected model','Cheapest above your bar','mint'),('Candidate C','Escalation when needed','muted')]):
        s+=card(554,185+93*i,350,80,title,sub,'route',col,i)
    s+=circle(260,323,8,'orange',**{'class':'pulse'})
    return s


def boot():
    labels=['Reset','Hardware','MMU','EL2','Kernel objects','First witness','Scheduler']
    coords=[(118,238),(358,238),(598,238),(838,238),(718,393),(478,393),(238,393)]
    s=''
    for i,((x,y),(u,v)) in enumerate(zip(coords,coords[1:])):
        s+=signal(f'M{x} {y}L{u} {v}','mint',-i*.5)
    for i,((x,y),label) in enumerate(zip(coords,labels)):
        s+=circle(x,y,25,'panel',stroke=C['mint'],**{'class':'step','style':f'animation-delay:{-i}s'})
        s+=text(x,y+9,str(i+1),24,'mint',600,text_anchor='middle')
        s+=text(x,y+62,label,26,'white',600,text_anchor='middle')
    return s


def tiers():
    s=''
    for i,(label,sub,col) in enumerate([('HOT','Active state','orange'),('WARM','Ready to recall','mint'),('DORMANT','Compressed state','ice'),('COLD','Persistent state','violet')]):
        x=60+i*228
        for k in range(3):
            y=252+k*31
            s+=path(f'M{x} {y}l90 -45l90 45l-90 45Z',col,1.4,opacity=str(.85-k*.2))
        s+=text(x+90,219,label,28,col,700,text_anchor='middle')
        s+=text(x+90,399,sub,21,'muted',500,text_anchor='middle')
        if i<3: s+=signal(f'M{x+181} 292H{x+227}',col,-i)
    s+=signal('M150 414V452H834V414','ice')
    s+=text(490,441,'CHECKPOINT + WITNESS REPLAY',22,'ice',600,text_anchor='middle')
    return s


def witness():
    s=''
    for i in range(5):
        x=88+i*174
        s+=icon('witness',x+20,241,62,'orange' if i==3 else 'mint')
        s+=text(x+52,343,f'W{i+1}',27,'white',700,text_anchor='middle')
        if i<4: s+=signal(f'M{x+91} 273H{x+187}','ice',-i)
    s+=signal('M145 365V413H835V365','orange')
    s+=text(480,449,'CHECKPOINT → VERIFIED REPLAY',29,'ice',650,text_anchor='middle')
    return s


def scheduler():
    s=card(58,220,283,108,'Deadline','Time-sensitive urgency','clock','mint')
    s+=card(58,360,283,108,'Cut pressure','Isolation / locality','graph','orange')
    s+=signal('M341 272C445 272 431 330 499 330','mint')+signal('M341 412C445 412 431 330 499 330','orange')
    s+=geometry('torus',616,328,.74,'ice')
    s+=text(616,453,'SCHEDULER',28,'white',700,text_anchor='middle')
    s+=signal('M737 330H827','mint')+icon('chip',832,302,55)
    return s


def hosts():
    s=rect(346,269,268,105,'url(#panel)','mint',16)+icon('cube',367,294,45)
    s+=text(425,314,'Harness',29,'white',700)+text(425,344,'Shared kernel',21,'muted')
    nodes=[(65,211,'Claude Code','MCP + hooks'),(642,211,'Codex','MCP config'),(65,375,'RVM','Capabilities'),(642,375,'Other hosts','Native adapters')]
    for i,(x,y,title,sub) in enumerate(nodes):
        right=x>400
        s+=signal(f'M{614 if right else 346} 321C{630 if right else 330} 321 {630 if right else 330} {y+44} {x if right else x+255} {y+44}','mint',-i)
        s+=card(x,y,255,92,title,sub,'code','ice',i)
    return s


def terminal(lines,tag):
    s=rect(58,183,844,281,'#08121d','line',16)
    for i,c in enumerate(['orange','mint','ice']): s+=circle(84+i*20,207,4,c)
    s+=text(862,214,tag,18,'muted',500,text_anchor='end',**{'class':'mono'})
    for i,line in enumerate(lines):
        s+=text(85,263+i*54,line,26,'mint' if i==0 else 'white',500,**{'class':'mono'})
    s+=rect(84+len(lines[-1])*15.7,243+(len(lines)-1)*54,12,27,'mint','none',0,**{'class':'cursor'})
    return s


def network_memory():
    s=geometry('sphere',287,326,.93,'ice')
    s+=signal('M344 243C518 150 630 197 688 241','mint')
    s+=signal('M688 365C576 491 352 440 287 326','orange')
    s+=card(581,213,316,96,'Memory','Scoped to your harness','memory','mint')
    s+=card(581,354,316,96,'Optional field','Verifier + storage setup','graph','orange',1)
    return s


def diagram(c):
    kind=c['kind']
    if kind=='coherence': return coherence()
    if kind=='layers': return layers(c['labels'],c['subs'])
    if kind=='security': return security()
    if kind=='cycle': return cycle(c['labels'],c['subs'])
    if kind=='routing': return routing()
    if kind=='boot': return boot()
    if kind=='tiers': return tiers()
    if kind=='witness': return witness()
    if kind=='scheduler': return scheduler()
    if kind=='hosts': return hosts()
    if kind=='terminal': return terminal(c['lines'],c.get('tag','QUICK START'))
    if kind=='memory': return network_memory()
    return sequence(c['labels'],c['subs'],c.get('icons'),c.get('colors'))


def chapter_inner(product,c,index,total):
    s=text(48,42,f'{product.upper()} / FIELD GUIDE',19,'mint',600,letter_spacing='2')
    s+=text(911,42,f'{index:02d} / {total:02d}',19,'muted',500,text_anchor='end',**{'class':'mono'})
    s+=text(48,98,c['title'],46,'white',750,letter_spacing='-1.4')
    s+=text(49,138,c['subtitle'],25,'muted')
    s+=diagram(c)
    s+=path('M48 489H912','line',1)
    s+=text(49,521,c['footer'],23,'mint',550)
    return s


def hero(cfg):
    name=cfg['product']; is_rvm=name=='RVM'
    s=geometry('hypercube' if is_rvm else 'torus',744,170,1.18,'ice')
    s+=f'<g opacity=".35">{geometry("hyperbolic",744,170,1.4,"mint")}</g>'
    s+=signal('M627 267C802 323 891 77 692 53','orange',arrow=False)
    s+=text(48,47,'RUVNET / '+('AGENT RUNTIME' if is_rvm else 'HARNESS FACTORY'),19,'mint',600,letter_spacing='3')
    s+=text(42,151,name,110 if is_rvm else 74,'white',800,letter_spacing='-4')
    for i,line in enumerate(cfg['hero_lines']): s+=text(48,207+i*42,line,33,'ice',550,letter_spacing='-.5')
    s+=path('M48 285H510','line',1)+icon(cfg['icon'],48,299,24)
    s+=text(87,319,cfg['hero_footer'],19,'mint',600,letter_spacing='1.2')
    return svg(f'{name}: {cfg["tagline"]}',cfg['hero_description'],s,348)


def animated_slideshow(cfg, chapters, trailer=False):
    n=len(chapters); duration=n*8; css=''; content=''
    for i,c in enumerate(chapters):
        p=i*100/n; end=(i+1)*100/n; fade=1.4
        # Deliberate hard hold with short dissolve; first frame is meaningful.
        if i==0:
            k=f'0%,{end-fade:.3f}%{{opacity:1}}{end:.3f}%,{100-fade:.3f}%{{opacity:0}}100%{{opacity:1}}'
        else:
            k=f'0%,{p-fade:.3f}%{{opacity:0}}{p:.3f}%,{end-fade:.3f}%{{opacity:1}}{end:.3f}%,100%{{opacity:0}}'
        css+=f'@keyframes scene{i}{{{k}}}.s{i}{{opacity:{1 if i==0 else 0};animation:scene{i} {duration}s linear infinite;}}'
        inner=cinema_inner(cfg,i,n) if trailer else chapter_inner(cfg['product'],c,i+1,n)
        content+=f'<g class="scene s{i}'+(' scene-first' if i==0 else '')+'">'+inner+'</g>'
    return svg(cfg['product']+(' cinematic trailer' if trailer else ' complete animated walkthrough'),
               f'{duration}-second illustrative tour: '+'. '.join(c['description'] for c in chapters)+'. Reduced motion shows the first chapter; all chapters are available separately with text.',content,extra=css)


def cinema_inner(cfg,index,total):
    rvm=cfg['product']=='RVM'
    stories=([
        (['Agents become','a living graph.'],['Coherence domains follow','communication and trust.'],'sphere',['OBSERVE','SCORE','ADAPT'],'graph'),
        (['Authority before','every action.'],['Check capabilities and proof.','Witness the decision.'],'hypercube',['CAPABILITY','PROOF','WITNESS'],'shield'),
        (['One package.','Verified execution.'],['RVF verification, placement,','and instance lifecycle.'],'torus',['RVF','VERIFY','LAUNCH'],'ship'),
        (['A name is not','a permission.'],['Govern ruv:// context with','capabilities and receipts.'],'hyperbolic',['NAME','CAPABILITY','REVISION'],'layers'),
    ] if rvm else [
        (['Your repo.','Your own agent.'],['Analyze the project.','Generate a harness you own.'],'hypercube',['ANALYZE','COMPOSE','GENERATE'],'spark'),
        (['One harness.','Your chosen host.'],['Claude Code, Codex, RVM.','Adapters fit the host.'],'sphere',['CLAUDE CODE','CODEX','RVM'],'route'),
        (['Keep the model.','Evolve the harness.'],['Darwin proposes and tests.','Keep measured improvements.'],'torus',['PROPOSE','EVALUATE','RETAIN'],'loop'),
        (['Your name.','Your npm package.'],['Customize. Validate. Publish.','Ship a versioned team CLI.'],'hyperbolic',['CUSTOMIZE','VALIDATE','SHIP'],'ship'),
    ])
    headlines,body,kind,labels,ico=stories[index]
    s=text(48,43,cfg['product'].upper()+' / IN MOTION',19,'mint',650,letter_spacing='2')
    s+=text(910,43,f'{index+1:02d} / {total:02d}',20,'muted',500,text_anchor='end',**{'class':'mono'})
    s+='<g opacity=".7">'+geometry(kind,730,289,1.24,'ice')+'</g>'
    # A wide elliptical orbital path gives the projected object a depth cue.
    s+=path('M541 363C571 443 938 313 907 204C879 126 514 252 541 363','mint',1,opacity='.3')
    s+=signal('M541 363C571 443 938 313 907 204C879 126 514 252 541 363','orange',arrow=False)
    for j,line in enumerate(headlines): s+=text(47,129+j*66,line,51,'white',780,letter_spacing='-1.8')
    for j,line in enumerate(body): s+=text(49,252+j*38,line,28,'muted',500)
    s+=icon(ico,49,339,58,'mint')
    for j,label in enumerate(labels):
        x=127; y=352+j*32
        s+=text(x,y,label,21,'mint' if j!=1 else 'ice',600,letter_spacing='1.3')
        if j<2: s+=signal(f'M114 {y+3}V{y+22}','orange',-j*.6,False)
    # Distinct labelled points connect the narrative to the moving geometry.
    pts=[(587,198),(853,290),(655,404)]
    for j,(x,y) in enumerate(pts):
        s+=circle(x,y,11,'orange',opacity='.12',**{'class':'pulse'})+circle(x,y,3.8,'orange')
        s+=path(f'M{x} {y}h26','orange',1,opacity='.75')
        s+=text(x+31,y+5,f'0{j+1}',17,'ice',550,**{'class':'mono'})
    s+=path('M48 471H912','line',1)
    s+=text(49,507,'EXPLORE THE FULL WALKTHROUGH',23,'white',650,letter_spacing='.4')
    s+=text(903,508,'→',32,'mint',500,text_anchor='end')
    return s


def header(cfg,h,i):
    s=icon(h['icon'],45,46,52,'mint')
    s+=text(120,56,f'{cfg["product"].upper()} / {i:02d}',17,'mint',600,letter_spacing='2')
    s+=text(119,106,h['title'],43,'white',750,letter_spacing='-1')
    s+=f'<g opacity=".55">{geometry(h["geometry"],811,78,.39,"ice")}</g>'
    s+=signal('M650 106C735 37 851 145 916 58','orange',arrow=False)
    return svg(f'{cfg["product"]}: {h["title"]}',h['description'],s,156)


def icon_card(cfg,feature):
    s=rect(2,2,124,124,'panel','line',24)+icon(feature['icon'],30,30,68,'mint')
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" role="img" aria-labelledby="title desc"><title id="title">{escape(cfg["product"]+": "+feature["title"])}</title><desc id="desc">{escape(feature["description"])}</desc>{defs()}{s}</svg>\n'


def walkthrough(cfg,files):
    p=cfg['product']; path='assets/visuals/'
    lines=[f'# {p} in motion','',cfg['intro'],'',f'[← Repository overview](../README.md) · [Quick start]({cfg["quickstart"]})','',
           f'[![{p} complete animated walkthrough: {len(cfg["chapters"])} chapters.]({path}walkthrough.svg)]({path}walkthrough.svg)','',
           f'**{len(cfg["chapters"])} chapters · {len(cfg["chapters"])*8} seconds · loops automatically.** Open any chapter below to study one flow. With reduced motion enabled, the tour holds its opening scene; the individual chapters remain available.','',
           'These diagrams explain architecture and documented workflows. Moving particles illustrate control or data flow; they are not live telemetry, timing measurements, or benchmark results.','',
           '| Chapter | What it explains |','|---|---|']
    for i,c in enumerate(cfg['chapters'],1): lines.append(f'| [{i:02d}. {c["title"]}](#{c["slug"]}) | {c["summary"]} |')
    for i,c in enumerate(cfg['chapters'],1):
        lines += ['',f'<a id="{c["slug"]}"></a>','',f'## {i:02d}. {c["title"]}','',
                  f'![{c["description"]}]({path}{i:02d}-{c["slug"]}.svg)','',c['body'],'']
        if c.get('command'): lines += ['```bash',c['command'],'```','']
        lines.append('Read more: '+' · '.join(f'[{s[0]}]({s[1]})' for s in c['sources'])+'.')
    lines += ['',f'## Start with {p}','',cfg['cta'],'',
              '## About the animations','',
              'Self-contained SVGs with native vector motion, no scripts, remote images, or external fonts. The layout uses a compact 16:9 canvas; all important content also appears as selectable text. The visual language follows RuVector: a near-black field, pale cyan geometry, mint signals, and orange trajectories. Geometric projections are visual metaphors, not claims about the underlying implementation.', '',
              'The source storyboard and regeneration instructions are in [visuals/README.md](visuals/README.md).','']
    return '\n'.join(lines)


def build(root):
    cfg=json.loads((root/'docs/visuals/storyboard.json').read_text())
    out=root/'docs/assets/visuals'; out.mkdir(parents=True,exist_ok=True)
    files={}
    files['hero.svg']=hero(cfg)
    files['trailer.svg']=animated_slideshow(cfg,[cfg['chapters'][i] for i in cfg['trailer']],True)
    files['walkthrough.svg']=animated_slideshow(cfg,cfg['chapters'])
    for i,c in enumerate(cfg['chapters'],1):
        files[f'{i:02d}-{c["slug"]}.svg']=svg(cfg['product']+': '+c['title'],c['description'],chapter_inner(cfg['product'],c,i,len(cfg['chapters'])))
    for i,h in enumerate(cfg['headers'],1): files['header-'+h['slug']+'.svg']=header(cfg,h,i)
    for f in cfg['features']: files['icon-'+f['slug']+'.svg']=icon_card(cfg,f)
    for name,contents in files.items(): (out/name).write_text(contents)
    (root/'docs/visual-walkthrough.md').write_text(walkthrough(cfg,files))
    print(f'{cfg["product"]}: {len(files)} SVGs, {sum(len(s.encode()) for s in files.values()):,} bytes')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,default=ROOT)
    args=parser.parse_args()
    build(args.root)
