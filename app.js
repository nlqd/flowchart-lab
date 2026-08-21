(function(){
'use strict';
var $ = function(id){ return document.getElementById(id); };
var U = LabUI, PRESETS = U.PRESETS;
var syncGutter = U.syncGutter, fit = U.fit, applyView = U.applyView;

/* what this workbench reads out; the shared readout renders whatever it is handed */
var METRICS = [
  {k:'crossings', get:function(s){return s.crossings;}, lower:true, lead:true},
  {k:'dummies',   get:function(s){return s.dummies;},   lower:true},
  {k:'layers',    get:function(s){return s.layers;}},
  {k:'reversed',  get:function(s){return s.reversed;},  lower:true},
  {k:'chunks',    get:function(s){return s.chunks;}},
  {k:'size',      get:function(s){return s.width+'\u00d7'+s.height;}, text:true},
  {k:'ratio',     get:function(s){return s.ar.toFixed(2);}, text:true},
  {k:'time',      get:function(s){return s.ms+'ms';}, text:true}
];

/* accurate text metrics beat the built-in approximation */
var mc = (function(){
  try { return document.createElement('canvas').getContext('2d'); } catch(e){ return null; }
})();
if (mc && typeof mc.measureText === 'function') {
  FlowLayout.setMeasurer(function(text, size, weight){
    mc.font = (weight>=500?'500 ':'400 ') + size + 'px ui-sans-serif, system-ui, -apple-system, sans-serif';
    return mc.measureText(text).width;
  });
}


/* ---------- what each option actually does to the picture ---------- */
var FX = {
  layering:{
    'network-simplex':'Minimises total edge length, so long edges span fewer ranks. Fewest dummy nodes; the safe default.',
    'longest-path':'Every node sits as early as it can. Shortest drawing, but wide layers and more dummies.',
    'coffman-graham':'Caps real nodes per layer. Narrower rows, but long edges get stretched — watch dummies climb.'
  },
  routing:{
    orthogonal:'Right angles. Edges attach to faces rather than corners, fan-outs and merges share one bus, and every other run gets its own track so nothing draws on top of anything else.',
    polyline:'Straight segments through each dummy point — shows exactly where the dummies sit. On a plain chain every edge is already vertical, so this looks identical to orthogonal.',
    spline:'Curves leaving and entering along the flow direction. Wrap detours stay orthogonal; splining their right angles would overshoot into loops.'
  }
};
function setFx(id, text, muted){
  var el2=document.getElementById(id); if(!el2) return;
  el2.textContent=text||''; el2.className='effect'+(muted?' nochange':'');
}

/* ---------- state ---------- */

function opts(){
  return {
    layering: $('layering').value,
    promote: $('promote').checked,
    cgWidth: +$('cgw').value,
    orderIters: +$('iters').value,
    dir: $('dir').value || null,
    routing: $('routing').value,
    nodeSep: +$('nodeSep').value,
    rankSep: +$('rankSep').value,
    wrap: $('wrap').checked,
    targetAR: +$('ar').value
  };
}

/* ---------- run ---------- */
var timer=null, firstRun=true;
function run(immediate){
  clearTimeout(timer);
  timer=setTimeout(function(){
    var g;
    try { g = FlowLayout.parse($('src').value); }
    catch(err){ showErr('parse failed: '+err.message); return; }
    var L;
    try { L = FlowLayout.layout(g, opts()); }
    catch(err){ showErr('layout failed: '+err.message); return; }
    showErr(g.errors.length ? g.errors.join('\n') : '');
    var sigBefore = U.current() ? layoutSignature(U.current()) : null;
    var prev = U.current() ? U.current().stats : null;
    U.setLayout(L);
    U.render(L);
    U.readout(METRICS, L.stats, prev);
    updateEffects(L, sigBefore);
    if($('engine').value!=='none') renderCompare();
    if(firstRun){ firstRun=false; requestAnimationFrame(fit); }
  }, immediate?0:180);
}
function layoutSignature(L){
  return L.stats.layers+'/'+L.stats.dummies+'/'+L.stats.crossings+'/'+L.stats.width+'x'+L.stats.height;
}
function updateEffects(L, sigBefore){
  setFx('fx-layering', FX.layering[$('layering').value]);
  setFx('fx-routing', FX.routing[$('routing').value]);

  var it=+$('iters').value;
  setFx('fx-iters', it===0
    ? 'Crossing minimisation is off — this is the raw seed order.'
    : 'Crossings settle by about pass 8; ' + it + ' passes currently gives ' + L.stats.crossings + '.');

  setFx('fx-wrap', !$('wrap').checked
    ? 'Off — the drawing keeps its natural ' + L.stats.ar.toFixed(2) + ' ratio.'
    : (L.stats.chunks>1
        ? 'Split into ' + L.stats.chunks + ' columns; ratio is now ' + L.stats.ar.toFixed(2) + ' against a target of ' + $('ar').value + '.'
        : 'On, but cutting this graph would sever too many edges to be worth it. Wrapping suits chain-like flows.'));

  // honest signal: some knobs genuinely do nothing on a sparse graph.  Append it rather
  // than replace, so you still learn what the control is for.
  if(sigBefore && lastChangedControl && sigBefore===layoutSignature(L)){
    var slot=({layering:'fx-layering', iters:'fx-iters', wrap:'fx-wrap', routing:null})[lastChangedControl];
    if(slot){
      var elx=document.getElementById(slot);
      elx.textContent = elx.textContent + '  \u2014 no change on this graph; it is too sparse for this setting to bite.';
    }
  }
  lastChangedControl=null;
}
var lastChangedControl=null;

function showErr(m){ var e=$('err'); e.textContent=m; e.className='errbar'+(m?' on':''); }

/* ---------- wiring ---------- */
['layering','promote','cgw','dir','routing','wrap'].forEach(function(id){
  $(id).addEventListener('change',function(){
    lastChangedControl=id;
    $('cgrow').style.display = $('layering').value==='coffman-graham' ? '' : 'none';
    run(true);
  });
});
[['iters','itersv'],['nodeSep','nodeSepv'],['rankSep','rankSepv'],['ar','arv']].forEach(function(p){
  $(p[0]).addEventListener('input',function(){
    lastChangedControl=p[0]; $(p[1]).textContent=$(p[0]).value; run();
  });
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
  $('wrap').checked = (this.value==='chain');
  syncGutter(); firstRun=true; run(true);
});


/* ---------- comparison engines: real mermaid, loaded on demand ---------- */
var mermaidMod = null, elkLoaded = false, cmpToken = 0;

function cmpMsg(title, detail){
  var box = $('cmpview');
  box.textContent = '';
  var d = document.createElement('div');
  d.className = 'cmp-msg';
  if (title){ var b = document.createElement('b'); b.textContent = title; d.appendChild(b); }
  if (detail){ d.appendChild(document.createTextNode(detail)); }
  box.appendChild(d);
}

function loadMermaid(withElk){
  if (mermaidMod && (!withElk || elkLoaded)) return Promise.resolve(mermaidMod);
  var base = 'https://cdn.jsdelivr.net/npm/';
  var p = mermaidMod
    ? Promise.resolve(mermaidMod)
    : import(base + 'mermaid@11/dist/mermaid.esm.min.mjs').then(function(m){
        mermaidMod = m.default || m;
        mermaidMod.initialize({ startOnLoad:false, theme:'base', securityLevel:'loose',
          flowchart:{ htmlLabels:false },
          themeVariables:{ background:'#f4f2ed', primaryColor:'#ffffff',
            primaryBorderColor:'#3f4650', primaryTextColor:'#161a1f',
            lineColor:'#5a626e', fontSize:'14px',
            fontFamily:'ui-sans-serif, system-ui, sans-serif' } });
        return mermaidMod;
      });
  if (!withElk) return p;
  return p.then(function(mm){
    if (elkLoaded) return mm;
    return import(base + '@mermaid-js/layout-elk@0/dist/mermaid-layout-elk.esm.min.mjs')
      .then(function(e){ mm.registerLayoutLoaders(e.default || e); elkLoaded = true; return mm; });
  });
}

function renderCompare(){
  var mode = $('engine').value;
  var pane = $('compare');
  if (mode === 'none'){ pane.classList.remove('on'); $('cmpstat').textContent = ''; return; }
  pane.classList.add('on');
  $('tag-b').textContent = mode === 'mermaid-elk' ? 'mermaid + ELK' : 'mermaid + dagre';

  var token = ++cmpToken;
  var src = $('src').value;
  cmpMsg('', 'loading ' + (mode === 'mermaid-elk' ? 'mermaid + ELK' : 'mermaid') + '\u2026');

  loadMermaid(mode === 'mermaid-elk').then(function(mm){
    if (token !== cmpToken) return;
    // mermaid needs the layout declared in frontmatter, not as a render arg
    var text = mode === 'mermaid-elk' ? '---\nconfig:\n  layout: elk\n---\n' + src : src;
    var t0 = performance.now();
    return mm.render('cmp' + token, text).then(function(res){
      if (token !== cmpToken) return;
      var ms = (performance.now() - t0).toFixed(0);
      $('cmpview').innerHTML = res.svg;
      var svg = $('cmpview').querySelector('svg');
      if (svg){
        svg.removeAttribute('width'); svg.removeAttribute('height');
        svg.setAttribute('preserveAspectRatio','xMidYMid meet');
        svg.style.maxWidth = 'none';
        var vb = (svg.getAttribute('viewBox')||'').split(/[\s,]+/).map(Number);
        var w = vb[2] ? Math.round(vb[2]) : 0, h = vb[3] ? Math.round(vb[3]) : 0;
        $('cmpstat').textContent = w && h
          ? w + '\u00d7' + h + '  ratio ' + (w/h).toFixed(2) + '  ' + ms + 'ms'
          : ms + 'ms';
      }
    });
  }).catch(function(err){
    if (token !== cmpToken) return;
    var offline = /Failed to fetch|dynamically imported|NetworkError|Importing/i.test(String(err && err.message));
    $('cmpstat').textContent = '';
    if (offline) cmpMsg('Could not reach jsdelivr',
      'mermaid is fetched from a CDN, so this pane needs a network connection. Everything on the left runs offline.');
    else cmpMsg('mermaid could not render this', String(err && err.message || err).slice(0,200));
  });
}

$('engine').addEventListener('change', function(){
  if (this.value === 'none'){ $('compare').classList.remove('on'); $('cmpstat').textContent=''; }
  else renderCompare();
  // opening or closing the second pane resizes the first one, so the old transform
  // would leave the drawing clipped against the new edge
  requestAnimationFrame(fit);
});

window.addEventListener('resize',function(){ if(U.current() && firstRun===false) applyView(); });

/* ---------- boot ---------- */
$('src').value=PRESETS.approval;
syncGutter();
run(true);
})();
