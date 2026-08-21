/* UI shared by both workbenches.

   The renderer, pan/zoom, gutter, readout and clipboard export are the same whichever
   engine produced the layout: both engines return the same {nodes, edges, width,
   height, stats} shape, so none of this needs to know which one ran.  It lives here
   rather than in each app file because the last time two copies of this code existed
   they drifted, and a fix landed in only one of them.
*/
(function (root) {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var NS = 'http://www.w3.org/2000/svg';

  /* shared drawing state: the live <svg>, its pan/zoom transform, and the element
     cache that lets a redraw move existing shapes instead of rebuilding them */
  var view = {k:1, x:0, y:0};
  var last = null, prevStats = null, dom = {nodes:{}, edges:{}}, svgEl = null, rootG = null;

  function setLayout(L){ prevStats = last ? last.stats : null; last = L; }
  function current(){ return last; }
  function reset(){
    Object.keys(dom.nodes).forEach(function(k){ dom.nodes[k].remove(); });
    Object.keys(dom.edges).forEach(function(k){ dom.edges[k].remove(); });
    dom.nodes = {}; dom.edges = {};
    last = null; prevStats = null;
  }

var PRESETS = {
approval:`flowchart TD
  A[New request] --> B{Complete?}
  B -->|no| R[/Return to sender/]
  B -->|yes| C[Assign reviewer]
  C --> D{Under $10k?}
  D -->|yes| E[Auto-approve]
  D -->|no| F[Committee review]
  F --> G{Approved?}
  G -->|no| R
  G -->|yes| E
  E --> H[(Write to ledger)]
  H --> I((Done))
  R --> I`,

chain:`flowchart TD
  s((Intake)) --> n1[Validate schema]
  n1 --> n2[Normalise fields]
  n2 --> n3[Deduplicate]
  n3 --> n4[Enrich from CRM]
  n4 --> n5[Score risk]
  n5 --> n6[Apply policy]
  n6 --> n7[Reserve funds]
  n7 --> n8[Notify customer]
  n8 --> n9[Settle]
  n9 --> n10[Reconcile]
  n10 --> n11[Archive]
  n11 --> e((Complete))`,

crossy:`flowchart TD
  a1[Ingest A] --> b3[Queue C]
  a2[Ingest B] --> b2[Queue B]
  a3[Ingest C] --> b1[Queue A]
  a1 --> b1
  a3 --> b3
  b1 --> c2[Worker 2]
  b2 --> c1[Worker 1]
  b3 --> c3[Worker 3]
  c1 --> d2[(Shard 2)]
  c2 --> d1[(Shard 1)]
  c3 --> d2`,

state:`flowchart TD
  idle((Idle)) --> run[Running]
  run --> chk{Healthy?}
  chk -->|yes| run
  chk -->|no| back[Back off]
  back -.-> run
  back --> giveup{Attempts left?}
  giveup -->|yes| back
  giveup -->|no| dead[/Dead letter/]
  run ==> done((Complete))
  dead --> idle`,

incident:`flowchart TD
  a((Alert fires)) --> b[Page on-call]
  b --> c{Acknowledged in 5m?}
  c -->|no| d[Escalate to secondary]
  d --> c
  c -->|yes| e[Open incident channel]
  e --> f[Declare severity]
  f --> g{Sev 1 or 2?}
  g -->|yes| h[Notify incident commander]
  g -->|no| i[Assign single responder]
  h --> j[Start comms timer]
  i --> k[Begin triage]
  j --> k
  k --> l{Customer impact?}
  l -->|yes| m[Post status page update]
  l -->|no| n[Log internal only]
  m --> o[Gather signals]
  n --> o
  o --> p[(Pull metrics)]
  o --> q[(Pull traces)]
  o --> r[(Pull recent deploys)]
  p --> s2[Form hypothesis]
  q --> s2
  r --> s2
  s2 --> t{Recent deploy suspect?}
  t -->|yes| u[Roll back release]
  t -->|no| v[Inspect dependencies]
  u --> w{Recovered?}
  v --> x{Upstream degraded?}
  x -->|yes| y[Fail over region]
  x -->|no| z[Deep dive logs]
  y --> w
  z --> aa{Root cause found?}
  aa -->|no| s2
  aa -->|yes| ab[Apply mitigation]
  ab --> w
  w -->|no| ac{Time budget left?}
  ac -->|yes| s2
  ac -->|no| ad[Engage vendor support]
  ad --> w
  w -->|yes| ae[Monitor 30 minutes]
  ae --> af{Stable?}
  af -->|no| s2
  af -->|yes| ag[Post all-clear]
  ag --> ah[Close status page]
  ah --> ai[Schedule postmortem]
  ai --> aj[Draft timeline]
  aj --> ak[Identify action items]
  ak --> al[(File follow-up tickets)]
  al --> am[Review in weekly]
  am --> an((Incident closed))`,

wide:`flowchart TD
  R[Dispatcher] --> A1[Region NA]
  R --> A2[Region EU]
  R --> A3[Region APAC]
  R --> A4[Region LATAM]
  R --> A5[Region MEA]
  A1 --> Z[(Aggregate)]
  A2 --> Z
  A3 --> Z
  A4 --> Z
  A5 --> Z
  Z --> O((Report))`
};

/* ---------- render ---------- */
function el(t,a){ var e=document.createElementNS(NS,t); for(var k in a) e.setAttribute(k,a[k]); return e; }

function ensureSvg(){
  if (svgEl) return;
  svgEl = el('svg',{xmlns:NS});
  var defs = el('defs');
  // namespaced: a bare id here collides with the controls in the markup, and a
  // url(#id) that resolves to an <input> paints no arrowhead at all
  var m = el('marker',{id:'fl-arrow',viewBox:'0 0 10 10',refX:'9',refY:'5',
    markerWidth:'7',markerHeight:'7',orient:'auto-start-reverse',markerUnits:'strokeWidth'});
  m.appendChild(el('path',{d:'M0 0 L10 5 L0 10 z',fill:'#5a626e'}));
  defs.appendChild(m); svgEl.appendChild(defs);
  rootG = el('g'); svgEl.appendChild(rootG);
  $('canvas').appendChild(svgEl);
}

function shapeNode(n){
  var g = FlowExport.shapeGeom({x:0,y:0,w:n.w,h:n.h,shape:n.shape});
  var fill = n.shape==='diamond' ? '#eef2f9' : '#ffffff';
  var stroke = n.shape==='diamond' ? '#2f6fd0' : '#3f4650';
  var parts=[];
  if (g.kind==='rect') parts.push(el('rect',{x:g.x,y:g.y,width:g.w,height:g.h,rx:g.rx,ry:g.rx,fill:fill,stroke:stroke,'stroke-width':1.5}));
  else if (g.kind==='ellipse') parts.push(el('ellipse',{cx:g.cx,cy:g.cy,rx:g.rx,ry:g.ry,fill:fill,stroke:stroke,'stroke-width':1.5}));
  else if (g.kind==='poly') parts.push(el('polygon',{points:g.pts.map(function(p){return p[0]+','+p[1];}).join(' '),fill:fill,stroke:stroke,'stroke-width':1.5}));
  else { parts.push(el('path',{d:g.d,fill:fill,stroke:stroke,'stroke-width':1.5}));
         if(g.cap) parts.push(el('path',{d:g.cap,fill:'none',stroke:stroke,'stroke-width':1.5})); }
  var lines = n.lines||[n.label], lh = 14*1.32;
  var t = el('text',{x:0,y:(n.textDy||0)-((lines.length-1)*lh)/2,'text-anchor':'middle','dominant-baseline':'central',
    'font-family':'ui-sans-serif, system-ui, sans-serif','font-size':14,'font-weight':500,fill:'#161a1f'});
  lines.forEach(function(l,i){
    var ts = el('tspan',{x:0}); if(i) ts.setAttribute('dy',lh);
    ts.textContent = l; t.appendChild(ts);
  });
  parts.push(t);
  return parts;
}

function render(L){
  ensureSvg();
  var seenN={}, seenE={};

  L.edges.forEach(function(e){
    seenE[e.id]=1;
    var p = dom.edges[e.id];
    if(!p){
      p = el('path',{class:'fl-edge',fill:'none','stroke-linecap':'round','stroke-linejoin':'round'});
      rootG.appendChild(p); dom.edges[e.id]=p;
    }
    p.setAttribute('d', e.path);
    p.setAttribute('stroke', '#5a626e');
    p.setAttribute('stroke-width', e.style==='thick'?2.6:1.5);
    if(e.style==='dashed') p.setAttribute('stroke-dasharray','6 4'); else p.removeAttribute('stroke-dasharray');
    if(e.arrow==='none') p.removeAttribute('marker-end'); else p.setAttribute('marker-end','url(#fl-arrow)');
  });

  L.edges.forEach(function(e){
    if(!e.label||!e.labelPos) return;
    var id='lbl_'+e.id; seenE[id]=1;
    var g = dom.edges[id];
    if(!g){
      g = el('g',{class:'fl-edge'});
      g.appendChild(el('rect',{rx:3,fill:'#f4f2ed'}));
      var t=el('text',{'text-anchor':'middle','dominant-baseline':'central',
        'font-family':'ui-sans-serif, system-ui, sans-serif','font-size':12,fill:'#3f4650'});
      g.appendChild(t); rootG.appendChild(g); dom.edges[id]=g;
    }
    var txt=g.lastChild; txt.textContent=e.label;
    var w=e.label.length*7+10, h=18;
    g.firstChild.setAttribute('x',-w/2); g.firstChild.setAttribute('y',-h/2);
    g.firstChild.setAttribute('width',w); g.firstChild.setAttribute('height',h);
    g.setAttribute('transform','translate('+e.labelPos.x+','+e.labelPos.y+')');
  });

  L.nodes.forEach(function(n){
    seenN[n.id]=1;
    var g = dom.nodes[n.id];
    var sig = n.shape+'|'+n.w+'|'+n.h+'|'+(n.textDy||0)+'|'+(n.lines||[]).join('\u0001');
    if(!g || g.dataset.sig!==sig){
      if(g) g.remove();
      g = el('g',{class:'fl-node'}); g.dataset.sig=sig;
      shapeNode(n).forEach(function(p){ g.appendChild(p); });
      rootG.appendChild(g); dom.nodes[n.id]=g;
    }
    g.setAttribute('transform','translate('+n.x+','+n.y+')');
  });

  Object.keys(dom.nodes).forEach(function(k){ if(!seenN[k]){ dom.nodes[k].remove(); delete dom.nodes[k]; }});
  Object.keys(dom.edges).forEach(function(k){ if(!seenE[k]){ dom.edges[k].remove(); delete dom.edges[k]; }});
}

/* ---------- readout ---------- */
function readout(metrics, s, prevStats){
  var box=$('readout');
  if(!box.children.length){
    metrics.forEach(function(m){
      var d=document.createElement('div');
      d.className='metric'+(m.lead?' lead':'');
      d.innerHTML='<span class="k">'+m.k+'</span><span class="v" data-v></span><span class="d" data-d></span>';
      box.appendChild(d);
    });
  }
  metrics.forEach(function(m,i){
    var cell=box.children[i];
    var v=m.get(s);
    cell.querySelector('[data-v]').textContent=v;
    var dEl=cell.querySelector('[data-d]');
    if(m.text||!prevStats){ dEl.className='d'; dEl.textContent=''; return; }
    var was=m.get(prevStats), diff=v-was;
    // a float metric such as stress otherwise shows its full binary expansion here
    diff = Math.round(diff*100)/100;
    if(Math.abs(diff) < 0.005){ dEl.className='d'; dEl.textContent=''; return; }
    var better = m.lower ? diff<0 : diff>0;
    dEl.className='d on '+(better?'down':'up');
    dEl.textContent=(diff>0?'+':'')+diff;
  });
}

/* ---------- pan / zoom ---------- */
function applyView(){
  if(!rootG) return;
  rootG.setAttribute('transform','translate('+view.x+','+view.y+') scale('+view.k+')');
  $('zoomlabel').textContent=Math.round(view.k*100)+'%';
}
function fit(){
  if(!last) return;
  var c=$('canvas'), cw=c.clientWidth, ch=c.clientHeight;
  if(!cw||!ch) return;
  var k=Math.min(cw/(last.width+40), ch/(last.height+40), 1.6);
  view.k=k; view.x=(cw-last.width*k)/2; view.y=(ch-last.height*k)/2;
  applyView();
}
function zoomBy(f, cx, cy){
  var c=$('canvas');
  cx = cx===undefined ? c.clientWidth/2 : cx;
  cy = cy===undefined ? c.clientHeight/2 : cy;
  var nk=Math.max(0.1, Math.min(4, view.k*f));
  view.x = cx-(cx-view.x)*(nk/view.k);
  view.y = cy-(cy-view.y)*(nk/view.k);
  view.k=nk; applyView();
}
(function(){
  var c=$('canvas'), dragging=false, sx=0, sy=0, ox=0, oy=0;
  c.addEventListener('pointerdown',function(e){
    dragging=true; sx=e.clientX; sy=e.clientY; ox=view.x; oy=view.y;
    c.classList.add('drag'); c.setPointerCapture(e.pointerId);
  });
  c.addEventListener('pointermove',function(e){
    if(!dragging) return;
    view.x=ox+(e.clientX-sx); view.y=oy+(e.clientY-sy); applyView();
  });
  ['pointerup','pointercancel'].forEach(function(ev){
    c.addEventListener(ev,function(){ dragging=false; c.classList.remove('drag'); });
  });
  c.addEventListener('wheel',function(e){
    e.preventDefault();
    var r=c.getBoundingClientRect();
    zoomBy(e.deltaY<0?1.12:1/1.12, e.clientX-r.left, e.clientY-r.top);
  },{passive:false});
  c.addEventListener('keydown',function(e){
    var step=40;
    if(e.key==='ArrowLeft'){view.x+=step;applyView();e.preventDefault();}
    if(e.key==='ArrowRight'){view.x-=step;applyView();e.preventDefault();}
    if(e.key==='ArrowUp'){view.y+=step;applyView();e.preventDefault();}
    if(e.key==='ArrowDown'){view.y-=step;applyView();e.preventDefault();}
    if(e.key==='0'){fit();e.preventDefault();}
  });
  $('zin').onclick=function(){zoomBy(1.2);};
  $('zout').onclick=function(){zoomBy(1/1.2);};
  $('zfit').onclick=fit;
})();

/* ---------- gutter ---------- */
function syncGutter(){
  var ta=$('src'), n=ta.value.split('\n').length, g=$('gutter'), out=[];
  for(var i=1;i<=n;i++) out.push(i);
  g.textContent=out.join('\n');
  g.scrollTop=ta.scrollTop;
}

/* ---------- export ---------- */
function flash(btn,msg){
  if(btn.dataset.restore) clearTimeout(+btn.dataset.restore);
  else btn.dataset.label = btn.textContent;
  btn.textContent = msg;
  btn.dataset.restore = setTimeout(function(){
    btn.textContent = btn.dataset.label; delete btn.dataset.restore;
  },1300);
}

/* Chrome's async clipboard only accepts text/plain, text/html and image/png natively;
   image/svg+xml is refused outright. Anything else has to travel as a "web " custom
   format, which only web apps that opt in can read. So the payload always goes on
   text/plain, which is what draw.io's Edit Diagram box, editors, and paste-as-text all
   read, and the typed copy rides along for whatever can use it. */
function copyOut(btn, text, webType){
  function attempt(withTyped){
    if (!(window.ClipboardItem && navigator.clipboard && navigator.clipboard.write)) {
      return navigator.clipboard && navigator.clipboard.writeText
        ? navigator.clipboard.writeText(text) : Promise.reject();
    }
    var reps = {'text/plain': new Blob([text], {type:'text/plain'})};
    if (withTyped && webType) reps[webType] = new Blob([text], {type:webType});
    try { return navigator.clipboard.write([new ClipboardItem(reps)]); }
    catch (e) { return Promise.reject(e); }
  }
  // Chrome parks a clipboard write until the document regains focus, so the promise can
  // sit pending forever and the button would never say anything. Cap the wait and let
  // the synchronous fallback take over; writing the same text twice is harmless.
  var settled = false;
  function guard(p){
    return new Promise(function(res, rej){
      p.then(function(v){ if(!settled){ settled=true; res(v); } },
             function(e){ if(!settled){ settled=true; rej(e); } });
      setTimeout(function(){ if(!settled){ settled=true; rej(new Error('clipboard timeout')); } }, 1200);
    });
  }
  guard(attempt(true).catch(function(){ return attempt(false); }))
    .then(function(){ flash(btn,'copied'); })
    .catch(function(){
      var ta=document.createElement('textarea');
      ta.value=text; ta.style.cssText='position:fixed;top:-1000px';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); flash(btn,'copied'); }
      catch(e){ flash(btn,'copy failed'); }
      ta.remove();
    });
}

$('ex-drawio').onclick=function(){
  if(!last) return;
  copyOut(this, FlowExport.toDrawio(last,{routing:$('routing').value}), 'web application/xml');
};
$('ex-office').onclick=function(){
  if(!last) return;
  copyOut(this, FlowExport.toSVG(last,{mode:'flat'}), 'web image/svg+xml');
};
$('ex-svg').onclick=function(){
  if(!last) return;
  copyOut(this, FlowExport.toSVG(last,{mode:'app'}), 'web image/svg+xml');
};

  root.LabUI = {
    PRESETS: PRESETS, NS: NS, el: el,
    ensureSvg: ensureSvg, render: render, readout: readout,
    applyView: applyView, fit: fit, zoomBy: zoomBy, view: view, dom: dom,
    syncGutter: syncGutter, copyOut: copyOut, flash: flash,
    reset: reset, setLayout: setLayout, current: current
  };
})(this);
