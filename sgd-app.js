(function(){
'use strict';
var $ = function(id){ return document.getElementById(id); };
var U = LabUI, PRESETS = U.PRESETS;
var syncGutter = U.syncGutter, fit = U.fit, applyView = U.applyView;

/* text metrics from the canvas, so both workbenches size boxes identically */
var mc = (function(){
  try { return document.createElement('canvas').getContext('2d'); } catch(e){ return null; }
})();
if (mc && typeof mc.measureText === 'function') {
  FlowLayout.setMeasurer(function(text, size, weight){
    mc.font = (weight>=500?'500 ':'400 ') + size + 'px ui-sans-serif, system-ui, -apple-system, sans-serif';
    return mc.measureText(text).width;
  });
}

var METRICS = [
  {k:'stress',    get:function(s){return s.stress;},    lower:true, lead:true},
  {k:'crossings', get:function(s){return s.crossings;}, lower:true},
  {k:'overlaps',  get:function(s){return s.overlaps;},  lower:true},
  {k:'backward',  get:function(s){return s.backward===null?'—':s.backward;}, text:true},
  {k:'diameter',  get:function(s){return s.diameter;},  text:true},
  {k:'size',      get:function(s){return s.width+'×'+s.height;}, text:true},
  {k:'ratio',     get:function(s){return s.ar.toFixed(2);}, text:true},
  {k:'time',      get:function(s){return s.ms+'ms';}, text:true}
];

function opts(){
  return {
    epochs: +$('epochs').value,
    edgeLength: +$('edgeLength').value,
    seed: +$('seed').value,
    flow: $('flow').value,
    flowGap: +$('flowGap').value,
    overlapPad: +$('overlapPad').value,
    removeOverlaps: $('noOverlap').checked
  };
}

/* ---------- convergence trace ---------- */
function drawSpark(trace){
  var svg = $('spark');
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  if (!trace || trace.length < 2){ $('trace-note').textContent=''; return; }
  var W = 300, H = 56, pad = 3;
  var vals = trace.map(function(t){ return t.stress; });
  var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
  // stress spans orders of magnitude across a run, so a log scale is the only way
  // the tail of the curve stays visible next to the first few epochs
  var f = function(v){ return Math.log(Math.max(v, 1e-6) + 1); };
  var flo = f(lo), fhi = f(hi), span = (fhi - flo) || 1;
  var pts = vals.map(function(v,i){
    var x = pad + (i/(vals.length-1)) * (W - pad*2);
    var y = pad + (1 - (f(v)-flo)/span) * (H - pad*2);
    return x.toFixed(1)+','+y.toFixed(1);
  });
  var area = U.el('polygon',{points:pad+','+(H-pad)+' '+pts.join(' ')+' '+(W-pad)+','+(H-pad),
    fill:'rgba(95,179,122,0.13)', stroke:'none'});
  var line = U.el('polyline',{points:pts.join(' '), fill:'none', stroke:'#5fb37a',
    'stroke-width':1.4, 'stroke-linejoin':'round', 'vector-effect':'non-scaling-stroke'});
  svg.appendChild(area); svg.appendChild(line);
  $('trace-note').textContent = vals.length + ' epochs, ' + hi.toFixed(1) + ' → ' + lo.toFixed(2);
}

/* ---------- what each control does ---------- */
function setFx(id, text){ var e=$(id); if(e){ e.textContent=text||''; e.className='effect'; } }
function updateEffects(L){
  var t = L.trace || [];
  var settleAt = -1;
  if (t.length > 2){
    var fin = t[t.length-1].stress;
    for (var i=0;i<t.length;i++){ if (t[i].stress <= fin*1.02){ settleAt = i; break; } }
  }
  setFx('fx-epochs', settleAt >= 0
    ? 'Stress is within 2% of its final value by epoch ' + settleAt + '; the rest is polish.'
    : 'Each epoch visits every vertex pair once, in a fresh random order.');

  setFx('fx-seed', 'The optimiser starts from a random layout. Changing the seed finds a '
    + 'different local minimum, which is the honest way to see how stable this graph is.');

  setFx('fx-flow', $('flow').value === 'none'
    ? 'Pure stress: nothing tells the drawing which way an edge points, so it will not read top to bottom.'
    : (L.stats.backward
        ? L.stats.backward + ' edge(s) still point backwards. Those sit on cycles, and no ordering can satisfy them.'
        : 'Every edge points along the flow axis.'));

  setFx('fx-overlap', !$('noOverlap').checked
    ? 'Off. The stress model treats a node as a point, so boxes will sit on top of each other.'
    : (L.stats.overlaps
        ? L.stats.overlaps + ' pair(s) still overlap; raise the box gap or the hop length.'
        : 'No two boxes overlap.'));
}

function showErr(m){ var e=$('err'); e.textContent=m; e.className='errbar'+(m?' on':''); }

/* ---------- run ---------- */
var timer=null, firstRun=true;
function run(immediate){
  clearTimeout(timer);
  timer=setTimeout(function(){
    var g;
    try { g = FlowLayout.parse($('src').value); }
    catch(err){ showErr('parse failed: '+err.message); return; }
    var L;
    try { L = SGDLayout.layout(g, opts(), FlowLayout); }
    catch(err){ showErr('layout failed: '+err.message); return; }
    showErr(g.errors.length ? g.errors.join('\n') : '');
    var prev = U.current() ? U.current().stats : null;
    U.setLayout(L);
    U.render(L);
    U.readout(METRICS, L.stats, prev);
    drawSpark(L.trace);
    updateEffects(L);
    if($('engine').value!=='none') renderCompare();
    if(firstRun){ firstRun=false; requestAnimationFrame(fit); }
  }, immediate?0:180);
}

/* ---------- wiring ---------- */
['flow','noOverlap'].forEach(function(id){
  $(id).addEventListener('change',function(){ run(true); });
});
[['epochs','epochsv'],['edgeLength','edgeLengthv'],['seed','seedv'],
 ['flowGap','flowGapv'],['overlapPad','overlapPadv']].forEach(function(p){
  $(p[0]).addEventListener('input',function(){ $(p[1]).textContent=$(p[0]).value; run(); });
});
$('src').addEventListener('input',function(){ syncGutter(); run(); });
$('src').addEventListener('scroll',function(){ $('gutter').scrollTop=$('src').scrollTop; });
$('src').addEventListener('keydown',function(e){
  if(e.key==='Tab'){
    e.preventDefault();
    var s=this.selectionStart, en=this.selectionEnd;
    this.value=this.value.slice(0,s)+'  '+this.value.slice(en);
    this.selectionStart=this.selectionEnd=s+2; syncGutter(); run();
  }
});
$('preset').addEventListener('change',function(){
  $('src').value=PRESETS[this.value];
  syncGutter(); firstRun=true; run(true);
});

/* ---------- comparison pane ---------- */
var mermaidMod = null, cmpToken = 0;

function cmpMsg(title, detail){
  var box = $('cmpview');
  box.textContent = '';
  var d = document.createElement('div');
  d.className = 'cmp-msg';
  if (title){ var b = document.createElement('b'); b.textContent = title; d.appendChild(b); }
  if (detail){ d.appendChild(document.createTextNode(detail)); }
  box.appendChild(d);
}

function renderCompare(){
  var mode = $('engine').value;
  var pane = $('compare');
  if (mode === 'none'){ pane.classList.remove('on'); $('cmpstat').textContent = ''; return; }
  pane.classList.add('on');
  $('tag-b').textContent = mode === 'sugiyama' ? 'sugiyama (this repo)' : 'mermaid + dagre';

  if (mode === 'sugiyama'){
    // the interesting comparison: same source, same box sizes, same renderer.
    // The only difference is which engine placed the nodes.
    var g, L;
    try { g = FlowLayout.parse($('src').value); L = FlowLayout.layout(g, {routing:'orthogonal'}); }
    catch(err){ cmpMsg('Sugiyama engine failed', String(err && err.message || err).slice(0,200)); return; }
    var box = $('cmpview');
    box.textContent = '';
    var holder = document.createElement('div');
    holder.style.cssText = 'width:100%;height:100%';
    holder.innerHTML = FlowExport.toSVG(L, {mode:'app'});   // our own escaped output
    box.appendChild(holder);
    var svg = box.querySelector('svg');
    if (svg){
      svg.removeAttribute('width'); svg.removeAttribute('height');
      svg.setAttribute('preserveAspectRatio','xMidYMid meet');
      svg.style.maxWidth='none'; svg.style.width='100%'; svg.style.height='100%';
    }
    $('cmpstat').textContent = L.stats.width + '\u00d7' + L.stats.height +
      '  ratio ' + L.stats.ar.toFixed(2) + '  ' + L.stats.crossings + ' crossings  ' + L.stats.ms + 'ms';
    return;
  }

  var token = ++cmpToken;
  var src = $('src').value;
  cmpMsg('', 'loading mermaid\u2026');
  var p = mermaidMod ? Promise.resolve(mermaidMod)
    : import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs').then(function(m){
        mermaidMod = m.default || m;
        mermaidMod.initialize({ startOnLoad:false, theme:'base', securityLevel:'loose',
          flowchart:{ htmlLabels:false },
          themeVariables:{ background:'#f4f2ed', primaryColor:'#ffffff',
            primaryBorderColor:'#3f4650', primaryTextColor:'#161a1f',
            lineColor:'#5a626e', fontSize:'14px',
            fontFamily:'ui-sans-serif, system-ui, sans-serif' } });
        return mermaidMod;
      });
  p.then(function(mm){
    if (token !== cmpToken) return;
    var t0 = performance.now();
    return mm.render('cmp'+token, src).then(function(res){
      if (token !== cmpToken) return;
      var ms = (performance.now()-t0).toFixed(0);
      $('cmpview').innerHTML = res.svg;
      var s2 = $('cmpview').querySelector('svg');
      if (s2){
        s2.removeAttribute('width'); s2.removeAttribute('height');
        s2.setAttribute('preserveAspectRatio','xMidYMid meet');
        s2.style.maxWidth='none';
        var vb = (s2.getAttribute('viewBox')||'').split(/[\s,]+/).map(Number);
        var w = vb[2]?Math.round(vb[2]):0, h = vb[3]?Math.round(vb[3]):0;
        $('cmpstat').textContent = w&&h ? w+'\u00d7'+h+'  ratio '+(w/h).toFixed(2)+'  '+ms+'ms' : ms+'ms';
      }
    });
  }).catch(function(err){
    if (token !== cmpToken) return;
    var offline = /Failed to fetch|dynamically imported|NetworkError|Importing/i.test(String(err && err.message));
    $('cmpstat').textContent='';
    if (offline) cmpMsg('Could not reach jsdelivr',
      'mermaid is fetched from a CDN, so this pane needs a network connection. Everything on the left runs offline.');
    else cmpMsg('mermaid could not render this', String(err && err.message || err).slice(0,200));
  });
}

$('engine').addEventListener('change', function(){
  if (this.value === 'none'){ $('compare').classList.remove('on'); $('cmpstat').textContent=''; }
  else renderCompare();
  requestAnimationFrame(fit);
});

/* ---------- export ---------- */
$('ex-drawio').onclick=function(){
  if(!U.current()) return;
  U.copyOut(this, FlowExport.toDrawio(U.current(),{routing:'polyline'}), 'web application/xml');
};
$('ex-office').onclick=function(){
  if(!U.current()) return;
  U.copyOut(this, FlowExport.toSVG(U.current(),{mode:'flat'}), 'web image/svg+xml');
};
$('ex-svg').onclick=function(){
  if(!U.current()) return;
  U.copyOut(this, FlowExport.toSVG(U.current(),{mode:'app'}), 'web image/svg+xml');
};

window.addEventListener('resize',function(){ if(U.current() && firstRun===false) applyView(); });

/* ---------- boot ---------- */
$('src').value=PRESETS.approval;
syncGutter();
run(true);
})();
