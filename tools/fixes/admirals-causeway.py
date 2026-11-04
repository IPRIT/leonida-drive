"""Remove only the two source-label loops on the east Admiral's Causeway span.
No heightfield, buildings, other road geometry or crossing design is rebuilt.
"""
import gzip,json,math,struct
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2];DATA=ROOT/'public/data'
PAIRS=[((1401,-161),(1378.8,-154.8)),((1300.3,-127.7),(1313,-125.5))]
r=json.loads((DATA/'roads.json').read_text());deleted=set();regions=[]
if 'admirals-causeway-v1' in r.get('sourceFixes',[]):
 print('Already applied');raise SystemExit(0)
for a,b in PAIRS:
 nodes=[]
 for p in (a,b):
  found=[i for i,q in enumerate(r['nodes']) if math.dist(p,q)<.2]
  if len(found)!=1:raise RuntimeError('Source anchors changed; review this correction')
  nodes.append(found[0])
 ids=[i for i,e in enumerate(r['edges']) if {e['a'],e['b']}==set(nodes)]
 if len(ids)==1:continue
 if len(ids)!=2:raise RuntimeError('Unexpected bridge topology')
 keep=min(ids,key=lambda i:sum(math.dist(p,q) for p,q in zip(list(zip(r['edges'][i]['p'][::2],r['edges'][i]['p'][1::2])),list(zip(r['edges'][i]['p'][2::2],r['edges'][i]['p'][3::2])))))
 points=[p for i in ids for p in zip(r['edges'][i]['p'][::2],r['edges'][i]['p'][1::2])]
 regions.append((min(p[0] for p in points)-.4,min(p[1] for p in points)-.4,max(p[0] for p in points)+.4,max(p[1] for p in points)+.4,a,b))
 e=r['edges'][keep];A=r['nodes'][e['a']];B=r['nodes'][e['b']];n=max(2,math.ceil(math.dist(A,B)/3));e['p']=[];e['y']=[]
 for j in range(n+1):
  t=j/n;e['p'] += [round(A[k]+(B[k]-A[k])*t,3) for k in (0,1)];e['y'].append(round(r['ny'][e['a']]*(1-t)+r['ny'][e['b']]*t,3))
 e['w']=15;e['cl']=1;e['w0']=15;e['br']=[1]*(n+1);e.pop('wp',None)
 deleted.update(set(ids)-{keep})
# Fit one smooth through-curve between the real shore/island junctions. The
# four intermediate graph nodes came from the label, not actual road bends.
chain=[2777,2785,2795,2799,2812,2824];path=[]
for a,b in zip(chain,chain[1:]):
 ids=[i for i,e in enumerate(r['edges']) if i not in deleted and {e['a'],e['b']}=={a,b}]
 assert len(ids)==1
 e=r['edges'][ids[0]];pts=list(zip(e['p'][::2],e['p'][1::2]));path.append((e,e['a']==a,pts if e['a']==a else pts[::-1]))
P=r['nodes'][chain[0]][:];Q=r['nodes'][chain[-1]][:];D=[Q[k]-P[k] for k in (0,1)];L=math.hypot(*D)
def unit(v):
 l=math.hypot(*v);return [x/l for x in v]
U=unit([path[0][2][1][k]-P[k] for k in (0,1)]);V=unit([Q[k]-path[-1][2][-2][k] for k in (0,1)])
def project(p):return max(0,min(1,sum((p[k]-P[k])*D[k] for k in (0,1))/(L*L)))
def curve(t):
 return [(2*t**3-3*t*t+1)*P[k]+(t**3-2*t*t+t)*U[k]*L+(-2*t**3+3*t*t)*Q[k]+(t**3-t*t)*V[k]*L for k in (0,1)]
us=[project(r['nodes'][n]) for n in chain]
y0,y1=r['ny'][chain[0]],r['ny'][chain[-1]]
crest=max(r['ny'][n] for n in chain);rise=crest-(y0+y1)/2
def deck_height(t):return y0+(y1-y0)*(t*t*(3-2*t))+rise*math.sin(math.pi*t)**2
for n,u in zip(chain,us):
 r['nodes'][n]=[round(x,3) for x in curve(u)];r['ny'][n]=round(deck_height(u),3)
for j,(e,forward,pts) in enumerate(path):
 u0,u1=us[j:j+2];count=max(2,math.ceil((u1-u0)*L/3));out=[];heights=[]
 for k in range(count+1):
  t=k/count;out.append([round(x,3) for x in curve(u0+(u1-u0)*t)]);heights.append(round(deck_height(u0+(u1-u0)*t),3))
 if not forward:out.reverse();heights.reverse()
 e['p']=[x for p in out for x in p];e['y']=heights;e['w']=15;e['cl']=1;e['br']=[1]*len(out);e['noSidewalk']=True;e.pop('wp',None)
r.setdefault('sourceFixes',[]).append('admirals-causeway-v1')
# This bridge has parapets, not walkable sidewalks. Scope the flag to its span.
for e in r['edges']:
 if e.get('br') and any(e['br']) and all(1100<=x<=1410 and -175<=z<=-50 for x,z in zip(e['p'][::2],e['p'][1::2])):e['noSidewalk']=True
if deleted:
 remap={i:j for j,i in enumerate(i for i in range(len(r['edges'])) if i not in deleted)}
 r['edges']=[e for i,e in enumerate(r['edges']) if i not in deleted]
 for c in r.get('overpasses',[]):
  for k in ('upper','lower'):c[k]=[remap[i] for i in c[k] if i in remap]
 (DATA/'roads.json').write_text(json.dumps(r,separators=(',',':')))
# Preserve the binary map's arrays, attributes and all coordinates outside the
# two tiny lenses. Project their centreline vertices onto the corrected span.
raw=bytearray(gzip.decompress((DATA/'map.bin').read_bytes()));hl=struct.unpack_from('<I',raw,8)[0];h=json.loads(raw[12:12+hl]);base=12+hl;changed=0
for name in ('r0','r1','r2','r3'):
 _,off,n=h['arrays'][name+'.parts'];parts=struct.unpack_from('<'+'i'*n,raw,base+off)
 _,off,n=h['arrays'][name+'.coords'];coords=list(struct.unpack_from('<'+'h'*n,raw,base+off));cursor=0
 for k in range(0,len(parts),4):
  ax=az=0;points=[]
  for j in range(parts[k+2]):
   ax+=coords[cursor+j*2];az+=coords[cursor+j*2+1];x=h['origin'][0]+ax*h['q'];z=h['origin'][1]+az*h['q']
   t=project((x,z));cx=P[0]+D[0]*t;cz=P[1]+D[1]*t
   if 0<t<1 and math.hypot(x-cx,z-cz)<18:
    x,z=curve(t);changed+=1
   points.append((round((x-h['origin'][0])/h['q']),round((z-h['origin'][1])/h['q'])))
  prev=(0,0)
  for j,p in enumerate(points):coords[cursor+j*2]=p[0]-prev[0];coords[cursor+j*2+1]=p[1]-prev[1];prev=p
  cursor+=parts[k+2]*2
 struct.pack_into('<'+'h'*n,raw,base+off,*coords)
if changed:(DATA/'map.bin').write_bytes(gzip.compress(raw,mtime=0))
print(json.dumps({'removed_false_edges':len(deleted),'map_vertices_adjusted':changed}))
