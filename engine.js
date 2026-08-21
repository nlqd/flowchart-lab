/* flowchart layout engine
   Sugiyama pipeline:
     1 cycle breaking      greedy FAS (Eades, Lin, Smyth 1993)
     2 layering            longest-path | Coffman-Graham | network simplex (GKNV 1993)
                           + optional node promotion (Nikolov & Tarassov 2006)
     3 ordering            weighted median (GKNV) + transpose, scored with
                           accumulator-tree crossing counting (Barth, Junger, Mutzel 2002)
     4 x-coordinates       Brandes & Kopf 2002, size-aware delta
     5 wrapping            cut-and-stack for aspect ratio (after Ruegg et al.)
     6 routing             polyline | orthogonal | spline
*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FlowLayout = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * text measurement (injectable; browser overrides with canvas)
   * ------------------------------------------------------------------ */
  var measure = function (text, size, weight) {
    var w = 0;
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c >= 0x3000) w += 1.0;
      else if ('iljtfrI.,:;\'!|'.indexOf(text[i]) >= 0) w += 0.32;
      else if ('mwMW@'.indexOf(text[i]) >= 0) w += 0.92;
      else if (text[i] === text[i].toUpperCase() && /[A-Z]/.test(text[i])) w += 0.68;
      else w += 0.55;
    }
    return w * size * (weight >= 500 ? 1.04 : 1);
  };
  function setMeasurer(fn) { measure = fn; }

  /* ------------------------------------------------------------------ *
   * 0. parser  (mermaid-flavoured subset)
   * ------------------------------------------------------------------ */
  var SHAPES = [
    [/^\(\((.*)\)\)$/, 'circle'],
    [/^\(\[(.*)\]\)$/, 'stadium'],
    [/^\[\((.*)\)\]$/, 'cylinder'],
    [/^\{\{(.*)\}\}$/, 'hexagon'],
    [/^\[\/(.*)\/\]$/, 'parallelogram'],
    [/^\[\\(.*)\\\]$/, 'parallelogram'],
    [/^\{(.*)\}$/, 'diamond'],
    [/^\((.*)\)$/, 'round'],
    [/^\[(.*)\]$/, 'rect']
  ];
  /* A link is any run of dashes, equals or dots, optionally opened with `<` and closed
     with an arrowhead.  Mermaid lets you pad a link to make it span more ranks, so
     `-->`, `--->` and `----->` are the same link; matching a fixed set of three-character
     tokens silently dropped every padded edge. */
  var LINK_SRC = '<?(?:-\\.{1,3}-|\\.-|-\\.|-{2,}|={2,})[->ox]?';
  var EDGE_RE = new RegExp('(' + LINK_SRC + ')(?:\\s*\\|[^|]*\\|)?');
  /* the second label form: `A -- text --> B`.  Only a bare two-character opener starts
     one, which is what keeps `A --- B --- C` a pair of links rather than a label. */
  var INLINE_RE = new RegExp('^(\\s*)([^|]*?)\\s*(' + LINK_SRC + ')');

  function linkStyle(link) {
    if (link.indexOf('.') >= 0) return 'dashed';
    if (link.indexOf('=') >= 0) return 'thick';
    return 'solid';
  }
  function linkArrow(link) {
    return '>ox'.indexOf(link.charAt(link.length - 1)) >= 0 ? 'normal' : 'none';
  }

  /* Everything inside a node's brackets or quotes is label text, so a label reading
     "retry --> give up" must not be mistaken for a link.  Blank those spans out, match
     against the blanked copy, and slice the original by the index it reports.  The mask
     is the same length as the line so the indices line up. */
  function maskLabels(line) {
    var out = line.split(''), depth = 0, quote = null;
    for (var i = 0; i < out.length; i++) {
      var c = out[i];
      if (quote) { if (c === quote) quote = null; out[i] = ' '; continue; }
      if (depth > 0 && (c === '"' || c === "'")) { quote = c; out[i] = ' '; continue; }
      if (c === '[' || c === '(' || c === '{') { depth++; continue; }
      if (c === ']' || c === ')' || c === '}') { if (depth > 0) depth--; continue; }
      if (depth > 0) out[i] = ' ';
    }
    return out.join('');
  }

  function parseNodeRef(raw, nodes, order) {
    var s = raw.trim();
    if (!s) return null;
    var m = s.match(/^([A-Za-z0-9_.\u00c0-\uffff-]+)([\s\S]*)$/);
    if (!m) return null;
    var id = m[1], rest = m[2].trim(), shape = null, label = null;
    if (rest) {
      for (var i = 0; i < SHAPES.length; i++) {
        var mm = rest.match(SHAPES[i][0]);
        if (mm) { shape = SHAPES[i][1]; label = mm[1]; break; }
      }
      if (!shape) { shape = 'rect'; label = rest; }
    }
    if (!nodes[id]) { nodes[id] = { id: id, label: id, shape: 'rect' }; order.push(id); }
    if (label !== null) {
      nodes[id].label = label.replace(/^["']|["']$/g, '').replace(/<br\s*\/?>/gi, '\n');
      nodes[id].shape = shape;
    }
    return id;
  }

  function parseLine(line, lineNo, nodes, order, edges, errors) {
    var mask = maskLabels(line);
    var cursor = 0, prev = null, guard = 0;
    while (guard++ < 200) {
      var m = mask.slice(cursor).match(EDGE_RE);
      if (!m) {
        var tail = line.slice(cursor);
        if (tail.trim() && !parseNodeRef(tail, nodes, order)) {
          errors.push('line ' + lineNo + ': cannot read "' + tail.trim() + '"');
        }
        return;
      }
      var linkAt = cursor + m.index;
      var from = parseNodeRef(line.slice(cursor, linkAt), nodes, order) || prev;
      cursor = linkAt + m[0].length;

      var whole = line.substr(linkAt, m[0].length);
      var link = line.substr(linkAt, m[1].length);
      var piped = whole.match(/\|([^|]*)\|\s*$/);
      var label = piped ? piped[1].trim() : '';

      if (!label && /^(--|==|-\.)$/.test(link)) {
        var inline = mask.slice(cursor).match(INLINE_RE);
        if (inline) {
          label = line.substr(cursor + inline[1].length, inline[2].length).trim();
          link = inline[3];
          cursor += inline[0].length;
        }
      }

      var nextM = mask.slice(cursor).match(EDGE_RE);
      var rightEnd = nextM ? cursor + nextM.index : line.length;
      var to = parseNodeRef(line.slice(cursor, rightEnd), nodes, order);

      if (from && to) {
        edges.push({
          from: from, to: to,
          label: label.replace(/^["']|["']$/g, ''),
          style: linkStyle(link), arrow: linkArrow(link)
        });
      } else if (!from) {
        errors.push('line ' + lineNo + ': link "' + link + '" has nothing on its left');
      } else {
        errors.push('line ' + lineNo + ': link from "' + from + '" has no target');
      }

      prev = to;
      if (!nextM) return;
    }
  }

  function parse(src) {
    var nodes = {}, order = [], edges = [], dir = 'TB', errors = [];
    var lines = String(src).split(/\r?\n/);
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li].replace(/%%.*$/, '').trim();
      if (!line) continue;
      var h = line.match(/^(?:flowchart|graph)\s+(TB|TD|BT|LR|RL)\s*$/i);
      if (h) { dir = h[1].toUpperCase() === 'TD' ? 'TB' : h[1].toUpperCase(); continue; }
      if (/^(subgraph|end|click|style|classDef|class|linkStyle)\b/i.test(line)) continue;

      parseLine(line, li + 1, nodes, order, edges, errors);
    }
    return {
      nodes: order.map(function (id) { return nodes[id]; }),
      edges: edges, dir: dir, errors: errors
    };
  }

  /* ------------------------------------------------------------------ *
   * node sizing
   * ------------------------------------------------------------------ */
  function sizeNodes(nodes, o) {
    nodes.forEach(function (n) {
      var lines = String(n.label).split('\n');
      var tw = 0;
      lines.forEach(function (l) { tw = Math.max(tw, measure(l, o.fontSize, 500)); });
      var th = lines.length * o.fontSize * 1.35;
      var padX = o.padX, padY = o.padY;
      if (n.shape === 'diamond') { padX = o.padX * 2.4; padY = o.padY * 1.9; }
      if (n.shape === 'circle') { padX = o.padX * 1.5; padY = o.padY * 1.5; }
      if (n.shape === 'hexagon' || n.shape === 'parallelogram') padX = o.padX * 1.8;
      if (n.shape === 'cylinder') padY = o.padY * 1.6;
      n.w = Math.max(o.minW, Math.round(tw + padX * 2));
      n.h = Math.max(o.minH, Math.round(th + padY * 2));
      if (n.shape === 'circle') { var d = Math.max(n.w, n.h); n.w = d; n.h = d; }
      n.textDy = 0;
      if (n.shape === 'cylinder') {
        // the top cap dips to y+2e at the horizontal centre, which is exactly where the
        // label sits.  Reserve that depth and push the text below it.
        var cap = Math.min(12, n.h / 4);
        n.h += cap;
        n.textDy = cap;
      }
      n.lines = lines;
    });
  }

  /* ------------------------------------------------------------------ *
   * 1. cycle breaking - greedy feedback arc set (Eades/Lin/Smyth)
   * ------------------------------------------------------------------ */
  function greedyFAS(ids, edges) {
    var alive = {}, out = {}, inn = {};
    ids.forEach(function (id) { alive[id] = true; out[id] = []; inn[id] = []; });
    edges.forEach(function (e, i) {
      if (e.from === e.to) return;
      out[e.from].push(i); inn[e.to].push(i);
    });
    var outDeg = {}, inDeg = {};
    ids.forEach(function (id) { outDeg[id] = out[id].length; inDeg[id] = inn[id].length; });

    var removed = {}, s1 = [], s2 = [], left = ids.length;
    function drop(v) {
      alive[v] = false; removed[v] = true; left--;
      out[v].forEach(function (i) { if (alive[edges[i].to]) inDeg[edges[i].to]--; });
      inn[v].forEach(function (i) { if (alive[edges[i].from]) outDeg[edges[i].from]--; });
    }
    var guard = 0;
    while (left > 0 && guard++ < ids.length * 4 + 16) {
      var moved = true;
      while (moved) {
        moved = false;
        for (var i = 0; i < ids.length; i++) {
          var v = ids[i];
          if (alive[v] && outDeg[v] === 0) { s2.unshift(v); drop(v); moved = true; }
        }
      }
      moved = true;
      while (moved) {
        moved = false;
        for (var j = 0; j < ids.length; j++) {
          var u = ids[j];
          if (alive[u] && inDeg[u] === 0) { s1.push(u); drop(u); moved = true; }
        }
      }
      if (left > 0) {
        var best = null, bestD = -Infinity;
        for (var k = 0; k < ids.length; k++) {
          var w = ids[k];
          if (!alive[w]) continue;
          var d = outDeg[w] - inDeg[w];
          if (d > bestD) { bestD = d; best = w; }
        }
        if (best === null) break;
        s1.push(best); drop(best);
      }
    }
    ids.forEach(function (id) { if (!removed[id]) s1.push(id); });

    var pos = {};
    s1.concat(s2).forEach(function (id, i) { pos[id] = i; });
    var reversed = [];
    edges.forEach(function (e, i) {
      if (e.from === e.to) { e.selfLoop = true; return; }
      if (pos[e.from] > pos[e.to]) { e.reversed = true; reversed.push(i); }
      else e.reversed = false;
    });
    return reversed;
  }

  /* ------------------------------------------------------------------ *
   * 2. layering
   * ------------------------------------------------------------------ */
  function buildDag(ids, edges) {
    var succ = {}, pred = {};
    ids.forEach(function (id) { succ[id] = []; pred[id] = []; });
    edges.forEach(function (e) {
      if (e.selfLoop) return;
      var a = e.reversed ? e.to : e.from, b = e.reversed ? e.from : e.to;
      succ[a].push(b); pred[b].push(a);
    });
    return { succ: succ, pred: pred };
  }

  function topoOrder(ids, dag) {
    var indeg = {}, q = [], out = [];
    ids.forEach(function (id) { indeg[id] = dag.pred[id].length; if (!indeg[id]) q.push(id); });
    while (q.length) {
      var v = q.shift(); out.push(v);
      dag.succ[v].forEach(function (w) { if (--indeg[w] === 0) q.push(w); });
    }
    ids.forEach(function (id) { if (out.indexOf(id) < 0) out.push(id); });
    return out;
  }

  function longestPath(ids, dag) {
    var layer = {}, order = topoOrder(ids, dag);
    order.forEach(function (v) {
      var m = 0;
      dag.pred[v].forEach(function (u) { m = Math.max(m, (layer[u] || 0) + 1); });
      layer[v] = m;
    });
    return layer;
  }

  function coffmanGraham(ids, dag, W) {
    var n = ids.length, label = {}, labelled = {}, count = 0;
    while (count < n) {
      var cand = null, candKey = null;
      for (var i = 0; i < n; i++) {
        var v = ids[i];
        if (labelled[v]) continue;
        var ok = dag.pred[v].every(function (u) { return labelled[u]; });
        if (!ok) continue;
        var key = dag.pred[v].map(function (u) { return label[u]; }).sort(function (a, b) { return b - a; });
        if (cand === null || lexLess(key, candKey)) { cand = v; candKey = key; }
      }
      if (cand === null) { for (var j = 0; j < n; j++) if (!labelled[ids[j]]) { cand = ids[j]; break; } }
      labelled[cand] = true; label[cand] = ++count;
    }
    function lexLess(a, b) {
      for (var i = 0; i < Math.max(a.length, b.length); i++) {
        var x = a[i] === undefined ? -1 : a[i], y = b[i] === undefined ? -1 : b[i];
        if (x !== y) return x < y;
      }
      return false;
    }
    var byLabelDesc = ids.slice().sort(function (a, b) { return label[b] - label[a]; });
    var lvl = {}, k = 0, size = 0;
    byLabelDesc.forEach(function (v) {
      var ready = dag.succ[v].every(function (w) { return lvl[w] !== undefined && lvl[w] < k; });
      if (size >= W || !ready) {
        var need = 0;
        dag.succ[v].forEach(function (w) { if (lvl[w] !== undefined) need = Math.max(need, lvl[w] + 1); });
        k = Math.max(k + 1, need); size = 0;
      }
      lvl[v] = k; size++;
    });
    var maxK = 0; ids.forEach(function (v) { maxK = Math.max(maxK, lvl[v]); });
    var layer = {}; ids.forEach(function (v) { layer[v] = maxK - lvl[v]; });
    return layer;
  }

  /* network simplex (Gansner, Koutsofios, North, Vo 1993) */
  function networkSimplex(ids, dag, edgeList, maxIter) {
    if (!edgeList.length) { var z = {}; ids.forEach(function (i) { z[i] = 0; }); return z; }
    var rank = longestPath(ids, dag);
    var E = edgeList.map(function (e, i) { return { i: i, t: e.t, h: e.h, w: 1, minlen: 1 }; });
    function slack(e) { return rank[e.h] - rank[e.t] - e.minlen; }

    var tree = {}, inTree = {};
    function tightTree() {
      var nodes = {}, count = 0, stack = [ids[0]];
      nodes[ids[0]] = true; count = 1;
      var adj = {}; ids.forEach(function (v) { adj[v] = []; });
      E.forEach(function (e) { adj[e.t].push(e); adj[e.h].push(e); });
      var treeEdges = [];
      while (stack.length) {
        var v = stack.pop();
        adj[v].forEach(function (e) {
          if (slack(e) !== 0) return;
          var o = e.t === v ? e.h : e.t;
          if (nodes[o]) return;
          nodes[o] = true; count++; treeEdges.push(e); stack.push(o);
        });
      }
      return { nodes: nodes, count: count, edges: treeEdges };
    }

    var tt = tightTree(), guard = 0;
    while (tt.count < ids.length && guard++ < ids.length * 4 + 20) {
      var best = null, bestSlack = Infinity, incidentIsTail = false;
      E.forEach(function (e) {
        var a = tt.nodes[e.t], b = tt.nodes[e.h];
        if (a === b) return;
        var s = slack(e);
        if (s < bestSlack) { bestSlack = s; best = e; incidentIsTail = a; }
      });
      if (!best) break;
      var delta = incidentIsTail ? bestSlack : -bestSlack;
      ids.forEach(function (v) { if (tt.nodes[v]) rank[v] += delta; });
      tt = tightTree();
    }

    var treeEdges = tt.edges.slice();
    function components(exclude) {
      var side = {}, adj = {};
      ids.forEach(function (v) { adj[v] = []; });
      treeEdges.forEach(function (e) { if (e === exclude) return; adj[e.t].push(e.h); adj[e.h].push(e.t); });
      var stack = [exclude.t]; side[exclude.t] = 1;
      while (stack.length) {
        var v = stack.pop();
        adj[v].forEach(function (o) { if (!side[o]) { side[o] = 1; stack.push(o); } });
      }
      return side;
    }
    function cutValue(e) {
      var tailSide = components(e), cv = 0;
      E.forEach(function (f) {
        var ft = !!tailSide[f.t], fh = !!tailSide[f.h];
        if (ft === fh) return;
        cv += ft ? f.w : -f.w;
      });
      return cv;
    }

    var iter = 0;
    while (iter++ < (maxIter || 60)) {
      var leave = null;
      for (var i = 0; i < treeEdges.length; i++) {
        if (cutValue(treeEdges[i]) < 0) { leave = treeEdges[i]; break; }
      }
      if (!leave) break;
      var tailSide = components(leave), enter = null, es = Infinity;
      E.forEach(function (f) {
        if (f === leave) return;
        if (!tailSide[f.t] && tailSide[f.h]) {
          var s = slack(f);
          if (s < es) { es = s; enter = f; }
        }
      });
      if (!enter) break;
      treeEdges.splice(treeEdges.indexOf(leave), 1);
      treeEdges.push(enter);
      // re-tighten ranks from the new tree
      var adj = {}; ids.forEach(function (v) { adj[v] = []; });
      treeEdges.forEach(function (e) { adj[e.t].push({ o: e.h, d: e.minlen }); adj[e.h].push({ o: e.t, d: -e.minlen }); });
      var seen = {}, st = [ids[0]]; rank[ids[0]] = 0; seen[ids[0]] = true;
      while (st.length) {
        var v = st.pop();
        adj[v].forEach(function (a) { if (!seen[a.o]) { seen[a.o] = true; rank[a.o] = rank[v] + a.d; st.push(a.o); } });
      }
      ids.forEach(function (v) { if (!seen[v]) rank[v] = rank[v] || 0; });
    }
    var min = Infinity; ids.forEach(function (v) { min = Math.min(min, rank[v]); });
    ids.forEach(function (v) { rank[v] -= min; });
    // repair any constraint the re-tighten broke
    var ord = topoOrder(ids, dag);
    ord.forEach(function (v) {
      dag.pred[v].forEach(function (u) { if (rank[v] <= rank[u]) rank[v] = rank[u] + 1; });
    });
    return rank;
  }

  /* node promotion (Nikolov & Tarassov 2006) - fewer dummies */
  function promote(ids, dag, layer) {
    function promoteVertex(v, lay, depth) {
      if (depth > ids.length) return 1e9;
      var diff = 0;
      dag.pred[v].forEach(function (u) {
        if (lay[u] === lay[v] - 1) diff += promoteVertex(u, lay, depth + 1);
      });
      lay[v] = lay[v] - 1;
      return diff - dag.pred[v].length + dag.succ[v].length;
    }
    var changed = true, rounds = 0;
    while (changed && rounds++ < 8) {
      changed = false;
      for (var i = 0; i < ids.length; i++) {
        var v = ids[i];
        if (!dag.pred[v].length) continue;
        var backup = {}; ids.forEach(function (n) { backup[n] = layer[n]; });
        if (promoteVertex(v, layer, 0) < 0) changed = true;
        else ids.forEach(function (n) { layer[n] = backup[n]; });
      }
    }
    var min = Infinity; ids.forEach(function (v) { min = Math.min(min, layer[v]); });
    ids.forEach(function (v) { layer[v] -= min; });
    return layer;
  }

  /* ------------------------------------------------------------------ *
   * 3. ordering
   * ------------------------------------------------------------------ */
  function countCrossingsBetween(north, south, adjDown, posSouth) {
    var pairs = [];
    north.forEach(function (v, i) {
      (adjDown[v] || []).forEach(function (w) {
        if (posSouth[w] === undefined) return;
        pairs.push([i, posSouth[w]]);
      });
    });
    pairs.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    var first = 1;
    while (first < south.length) first *= 2;
    var treeSize = 2 * first - 1;
    first -= 1;
    var tree = new Array(treeSize).fill(0), cross = 0;
    pairs.forEach(function (p) {
      var index = p[1] + first;
      tree[index]++;
      while (index > 0) {
        if (index % 2) cross += tree[index + 1];
        index = (index - 1) >> 1;
        tree[index]++;
      }
    });
    return cross;
  }

  function totalCrossings(layers, adjDown) {
    var total = 0;
    for (var i = 0; i + 1 < layers.length; i++) {
      var posS = {};
      layers[i + 1].forEach(function (v, j) { posS[v] = j; });
      total += countCrossingsBetween(layers[i], layers[i + 1], adjDown, posS);
    }
    return total;
  }

  function medianValue(positions) {
    var P = positions.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(P.length / 2);
    if (P.length === 0) return -1;
    if (P.length % 2 === 1) return P[m];
    if (P.length === 2) return (P[0] + P[1]) / 2;
    var left = P[m - 1] - P[0], right = P[P.length - 1] - P[m];
    if (left + right === 0) return (P[m - 1] + P[m]) / 2;
    return (P[m - 1] * right + P[m] * left) / (left + right);
  }

  function ordering(layers, adjUp, adjDown, iters) {
    var best = layers.map(function (l) { return l.slice(); });
    var bestCross = totalCrossings(best, adjDown);
    var cur = layers.map(function (l) { return l.slice(); });

    for (var it = 0; it < iters; it++) {
      var down = it % 2 === 0;
      var range = [];
      for (var i = 0; i < cur.length; i++) range.push(i);
      if (!down) range.reverse();
      range.forEach(function (i) {
        var fixedIdx = down ? i - 1 : i + 1;
        if (fixedIdx < 0 || fixedIdx >= cur.length) return;
        var posFixed = {};
        cur[fixedIdx].forEach(function (v, j) { posFixed[v] = j; });
        var adj = down ? adjUp : adjDown;
        var meds = cur[i].map(function (v, idx) {
          var ps = (adj[v] || []).map(function (u) { return posFixed[u]; })
            .filter(function (p) { return p !== undefined; });
          return { v: v, m: medianValue(ps), idx: idx };
        });
        meds.sort(function (a, b) {
          var am = a.m < 0 ? a.idx : a.m, bm = b.m < 0 ? b.idx : b.m;
          return am - bm || a.idx - b.idx;
        });
        cur[i] = meds.map(function (x) { return x.v; });
      });
      transpose(cur, adjUp, adjDown);
      var c = totalCrossings(cur, adjDown);
      if (c < bestCross) { bestCross = c; best = cur.map(function (l) { return l.slice(); }); }
      if (bestCross === 0) break;
    }
    return { layers: best, crossings: bestCross };
  }

  function transpose(layers, adjUp, adjDown) {
    var improved = true, guard = 0;
    while (improved && guard++ < 24) {
      improved = false;
      for (var r = 0; r < layers.length; r++) {
        var L = layers[r];
        for (var i = 0; i + 1 < L.length; i++) {
          var v = L[i], w = L[i + 1];
          if (pairCross(v, w, r, layers, adjUp, adjDown) >
              pairCross(w, v, r, layers, adjUp, adjDown)) {
            L[i] = w; L[i + 1] = v; improved = true;
          }
        }
      }
    }
  }

  function pairCross(v, w, r, layers, adjUp, adjDown) {
    var c = 0;
    [[adjUp, r - 1], [adjDown, r + 1]].forEach(function (pair) {
      var adj = pair[0], idx = pair[1];
      if (idx < 0 || idx >= layers.length) return;
      var pos = {};
      layers[idx].forEach(function (u, j) { pos[u] = j; });
      var pv = (adj[v] || []).map(function (u) { return pos[u]; }).filter(function (x) { return x !== undefined; });
      var pw = (adj[w] || []).map(function (u) { return pos[u]; }).filter(function (x) { return x !== undefined; });
      pv.forEach(function (a) { pw.forEach(function (b) { if (a > b) c++; }); });
    });
    return c;
  }

  /* ------------------------------------------------------------------ *
   * 4. x-coordinates - Brandes & Kopf
   * ------------------------------------------------------------------ */
  function markConflicts(layers, adjUp, isInner) {
    var marked = {};
    function key(u, v) { return u + '\u0000' + v; }
    for (var i = 1; i + 1 < layers.length; i++) {
      var k0 = 0, l = 0, cur = layers[i + 1], prev = layers[i];
      var posPrev = {};
      prev.forEach(function (v, j) { posPrev[v] = j; });
      for (var l1 = 0; l1 < cur.length; l1++) {
        var v = cur[l1];
        var innerUp = null;
        (adjUp[v] || []).forEach(function (u) { if (isInner(u, v)) innerUp = u; });
        if (l1 === cur.length - 1 || innerUp !== null) {
          var k1 = prev.length - 1;
          if (innerUp !== null) k1 = posPrev[innerUp];
          for (; l <= l1; l++) {
            var vl = cur[l];
            (adjUp[vl] || []).forEach(function (u) {
              var k = posPrev[u];
              if (k === undefined) return;
              if (k < k0 || k > k1) marked[key(u, vl)] = true;
            });
          }
          k0 = k1;
        }
      }
    }
    return marked;
  }

  function bkPass(layersIn, adj, marked, sep, down, left) {
    var layers = layersIn.map(function (l) { return l.slice(); });
    if (!down) layers.reverse();
    if (!left) layers.forEach(function (l) { l.reverse(); });

    var pos = {}, layerOf = {};
    layers.forEach(function (L, i) { L.forEach(function (v, j) { pos[v] = j; layerOf[v] = i; }); });

    function upper(v) {
      var i = layerOf[v];
      if (i === 0) return [];
      var set = {};
      layers[i - 1].forEach(function (u) { set[u] = true; });
      return (adj[v] || []).filter(function (u) { return set[u]; })
        .sort(function (a, b) { return pos[a] - pos[b]; });
    }

    var root = {}, align = {}, sink = {}, shift = {}, x = {};
    layers.forEach(function (L) {
      L.forEach(function (v) { root[v] = v; align[v] = v; sink[v] = v; shift[v] = Infinity; });
    });

    for (var i = 0; i < layers.length; i++) {
      var r = -1;
      for (var k = 0; k < layers[i].length; k++) {
        var v = layers[i][k], N = upper(v);
        if (!N.length) continue;
        var mids = [Math.floor((N.length - 1) / 2), Math.ceil((N.length - 1) / 2)];
        for (var mi = 0; mi < mids.length; mi++) {
          if (align[v] !== v) continue;
          var u = N[mids[mi]];
          var conflict = marked[u + '\u0000' + v];  // conflicts are edge properties, flip-invariant
          if (!conflict && r < pos[u]) {
            align[u] = v; root[v] = root[u]; align[v] = root[v]; r = pos[u];
          }
        }
      }
    }

    function placeBlock(v) {
      if (x[v] !== undefined) return;
      x[v] = 0;
      var w = v, guard = 0;
      do {
        if (pos[w] > 0) {
          var predNode = layers[layerOf[w]][pos[w] - 1];
          var u = root[predNode];
          placeBlock(u);
          if (sink[v] === v) sink[v] = sink[u];
          var d = sep(predNode, w);
          if (sink[v] !== sink[u]) {
            shift[sink[u]] = Math.min(shift[sink[u]], x[v] - x[u] - d);
          } else {
            x[v] = Math.max(x[v], x[u] + d);
          }
        }
        w = align[w];
      } while (w !== v && guard++ < 10000);
    }

    layers.forEach(function (L) { L.forEach(function (v) { if (root[v] === v) placeBlock(v); }); });
    var out = {};
    layers.forEach(function (L) {
      L.forEach(function (v) {
        out[v] = x[root[v]];
        var s = shift[sink[root[v]]];
        if (s < Infinity) out[v] += s;
      });
    });
    if (!left) Object.keys(out).forEach(function (v) { out[v] = -out[v]; });
    return out;
  }

  function brandesKopf(layers, adj, adjUp, isInner, sep) {
    var marked = markConflicts(layers, adjUp, isInner);
    var runs = [
      bkPass(layers, adj, marked, sep, true, true),
      bkPass(layers, adj, marked, sep, true, false),
      bkPass(layers, adj, marked, sep, false, true),
      bkPass(layers, adj, marked, sep, false, false)
    ];
    var all = [];
    layers.forEach(function (L) { L.forEach(function (v) { all.push(v); }); });

    var widths = runs.map(function (r) {
      var lo = Infinity, hi = -Infinity;
      all.forEach(function (v) { lo = Math.min(lo, r[v]); hi = Math.max(hi, r[v]); });
      return { lo: lo, hi: hi, w: hi - lo };
    });
    var narrow = 0;
    widths.forEach(function (w, i) { if (w.w < widths[narrow].w) narrow = i; });
    runs.forEach(function (r, i) {
      var d = (i === 0 || i === 2) ? widths[narrow].lo - widths[i].lo
                                   : widths[narrow].hi - widths[i].hi;
      if (d) all.forEach(function (v) { r[v] += d; });
    });
    var x = {};
    all.forEach(function (v) {
      var vals = runs.map(function (r) { return r[v]; }).sort(function (a, b) { return a - b; });
      x[v] = (vals[1] + vals[2]) / 2;
    });
    return x;
  }

  /* ------------------------------------------------------------------ *
   * 5. wrapping - cut and stack
   * ------------------------------------------------------------------ */
  function chooseCuts(layerCount, spanCount, k, freedom) {
    if (k <= 1) return [];
    var cuts = [];
    for (var c = 1; c < k; c++) {
      var nominal = Math.round(c * layerCount / k);
      var best = nominal, bestScore = Infinity;
      for (var d = -freedom; d <= freedom; d++) {
        var idx = nominal + d;
        if (idx <= 0 || idx >= layerCount) continue;
        if (cuts.indexOf(idx) >= 0) continue;
        var score = spanCount[idx] + Math.abs(d) * 0.35;
        if (score < bestScore) { bestScore = score; best = idx; }
      }
      cuts.push(best);
    }
    return cuts.sort(function (a, b) { return a - b; });
  }

  /* ------------------------------------------------------------------ *
   * main layout
   * ------------------------------------------------------------------ */
  var DEFAULTS = {
    layering: 'network-simplex',   // longest-path | coffman-graham | network-simplex
    promote: true,
    cgWidth: 4,
    orderIters: 24,
    routing: 'orthogonal',         // orthogonal | polyline | spline
    dir: null,                     // overrides parsed direction
    nodeSep: 44,
    edgeSep: 16,
    rankSep: 56,
    fontSize: 14,
    edgeFontSize: 12,
    padX: 14,
    padY: 10,
    minW: 54,
    minH: 38,
    wrap: false,
    targetAR: 1.6,
    wrapGap: 56,
    cutFreedom: 2,
    cornerRadius: 8
  };

  function layout(graph, opts) {
    var t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    var o = {};
    Object.keys(DEFAULTS).forEach(function (k) { o[k] = DEFAULTS[k]; });
    if (opts) Object.keys(opts).forEach(function (k) { if (opts[k] !== undefined) o[k] = opts[k]; });

    var nodes = graph.nodes.map(function (n) {
      return { id: n.id, label: n.label, shape: n.shape };
    });
    var edges = graph.edges.map(function (e, i) {
      return { id: 'e' + i, from: e.from, to: e.to, label: e.label || '', style: e.style, arrow: e.arrow };
    });
    var dir = o.dir || graph.dir || 'TB';

    sizeNodes(nodes, o);

    // LR/RL: lay out top-down on transposed boxes, then transpose back
    var horizontal = (dir === 'LR' || dir === 'RL');
    if (horizontal) nodes.forEach(function (n) { var t = n.w; n.w = n.h; n.h = t; });

    var ids = nodes.map(function (n) { return n.id; });
    if (!ids.length) {
      return { nodes: [], edges: [], width: 0, height: 0, stats: emptyStats(t0) };
    }

    /* 1 - cycles */
    greedyFAS(ids, edges);
    var dag = buildDag(ids, edges);

    /* 2 - layering */
    var layer;
    if (o.layering === 'longest-path') layer = longestPath(ids, dag);
    else if (o.layering === 'coffman-graham') layer = coffmanGraham(ids, dag, Math.max(1, o.cgWidth));
    else {
      var nsEdges = [];
      edges.forEach(function (e) {
        if (e.selfLoop) return;
        nsEdges.push({ t: e.reversed ? e.to : e.from, h: e.reversed ? e.from : e.to });
      });
      layer = networkSimplex(ids, dag, nsEdges, 80);
    }
    if (o.promote && o.layering !== 'coffman-graham') promote(ids, dag, layer);

    var hasEdgeLabels = edges.some(function (e) { return e.label && !e.selfLoop; });
    if (hasEdgeLabels) ids.forEach(function (v) { layer[v] *= 2; });
    var rankStep = hasEdgeLabels ? o.rankSep / 2 : o.rankSep;

    var maxLayer = 0;
    ids.forEach(function (v) { maxLayer = Math.max(maxLayer, layer[v]); });

    /* 3 - dummies */
    var proper = {};   // id -> {w,h,dummy,edgeId,label}
    nodes.forEach(function (n) { proper[n.id] = { w: n.w, h: n.h, dummy: false, real: n }; });
    var layerOf = {};
    ids.forEach(function (v) { layerOf[v] = layer[v]; });
    var dummyCount = 0;

    edges.forEach(function (e) {
      if (e.selfLoop) { e.chain = null; return; }
      var a = e.reversed ? e.to : e.from, b = e.reversed ? e.from : e.to;
      var la = layer[a], lb = layer[b];
      var chain = [a];
      var labelRank = hasEdgeLabels && e.label ? la + Math.max(1, Math.floor((lb - la) / 2)) : -1;
      for (var L = la + 1; L < lb; L++) {
        var did = '\u0001d' + e.id + '_' + L;
        var isLabel = (L === labelRank);
        var lw = 1, lh = 1;
        if (isLabel) {
          lw = Math.max(10, measure(e.label, o.edgeFontSize, 400) + 10);
          lh = o.edgeFontSize * 1.4;
        }
        proper[did] = { w: lw, h: lh, dummy: true, edgeId: e.id, isLabel: isLabel, labelText: isLabel ? e.label : '' };
        layerOf[did] = L; chain.push(did); dummyCount++;
      }
      chain.push(b);
      e.chain = chain;
      e.flip = e.reversed;
    });

    /* proper-graph adjacency */
    var adj = {}, adjUp = {}, adjDown = {};
    Object.keys(proper).forEach(function (v) { adj[v] = []; adjUp[v] = []; adjDown[v] = []; });
    var innerSeg = {};
    edges.forEach(function (e) {
      if (!e.chain) return;
      for (var i = 0; i + 1 < e.chain.length; i++) {
        var u = e.chain[i], v = e.chain[i + 1];
        if (layerOf[u] === layerOf[v]) continue;
        adjDown[u].push(v); adjUp[v].push(u);
        adj[u].push(v); adj[v].push(u);
        if (proper[u].dummy && proper[v].dummy) innerSeg[u + '\u0000' + v] = true;
      }
    });
    function isInner(u, v) { return !!innerSeg[u + '\u0000' + v]; }

    /* build layers, seeded by BFS for a decent starting order */
    var layers = [];
    for (var i = 0; i <= maxLayer; i++) layers.push([]);
    var seen = {}, queue = ids.filter(function (v) { return !dag.pred[v].length; });
    if (!queue.length) queue = [ids[0]];
    var seedOrder = [];
    while (queue.length) {
      var v0 = queue.shift();
      if (seen[v0]) continue;
      seen[v0] = true; seedOrder.push(v0);
      (dag.succ[v0] || []).forEach(function (w) { if (!seen[w]) queue.push(w); });
    }
    ids.forEach(function (v) { if (!seen[v]) seedOrder.push(v); });
    var placed = {};
    seedOrder.forEach(function (v) {
      layers[layerOf[v]].push(v); placed[v] = true;
      edges.forEach(function (e) {
        if (!e.chain) return;
        if (e.chain[0] !== v) return;
        e.chain.forEach(function (c) {
          if (!placed[c] && proper[c].dummy) { layers[layerOf[c]].push(c); placed[c] = true; }
        });
      });
    });
    Object.keys(proper).forEach(function (v) {
      if (!placed[v]) { layers[layerOf[v]].push(v); placed[v] = true; }
    });
    layers = layers.filter(function (L) { return L.length; });

    /* 4 - ordering */
    var ord = ordering(layers, adjUp, adjDown, o.orderIters);
    layers = ord.layers;

    /* 5 - coordinates */
    function sep(a, b) {
      var pa = proper[a], pb = proper[b];
      var gap = (pa.dummy || pb.dummy) ? o.edgeSep : o.nodeSep;
      return pa.w / 2 + pb.w / 2 + gap;
    }
    var xs = brandesKopf(layers, adj, adjUp, isInner, sep);

    var ys = [], acc = 0;
    layers.forEach(function (L, i) {
      var maxH = 0;
      L.forEach(function (v) { maxH = Math.max(maxH, proper[v].h); });
      if (i > 0) acc += rankStep;
      ys.push(acc + maxH / 2);
      acc += maxH;
    });

    var P = {};
    layers.forEach(function (L, i) {
      L.forEach(function (v) { P[v] = { x: xs[v], y: ys[i], layer: i, w: proper[v].w, h: proper[v].h }; });
    });

    /* 6 - wrapping */
    var chunkOf = {};
    layers.forEach(function (L, i) { L.forEach(function (v) { chunkOf[v] = 0; }); });
    var cuts = [], wrapBounds = null;
    if (o.wrap && layers.length > 2) {
      var spanCount = new Array(layers.length + 1).fill(0);
      edges.forEach(function (e) {
        if (!e.chain) return;
        var a = P[e.chain[0]], b = P[e.chain[e.chain.length - 1]];
        if (!a || !b) return;
        var lo = Math.min(a.layer, b.layer), hi = Math.max(a.layer, b.layer);
        for (var c = lo + 1; c <= hi; c++) spanCount[c]++;
      });
      var bestK = 1, bestErr = Infinity, bestCuts = [];
      var totalEdges = Math.max(1, edges.filter(function (e) { return e.chain; }).length);
      for (var k = 1; k <= Math.min(6, layers.length); k++) {
        var trial = chooseCuts(layers.length, spanCount, k, o.cutFreedom);
        var m = measureWrapped(layers, P, trial, o.wrapGap);
        // every severed edge becomes a long detour around the chunk, so cutting through
        // a busy layer has a real cost - weigh it against the ratio we gain
        var severed = trial.reduce(function (acc, c2) { return acc + (spanCount[c2] || 0); }, 0);
        var err = Math.abs(Math.log((m.w / Math.max(1, m.h)) / o.targetAR))
                + (severed / totalEdges) * 0.9;
        if (err < bestErr) { bestErr = err; bestK = k; bestCuts = trial; }
      }
      cuts = bestCuts;
      if (cuts.length) wrapBounds = applyWrap(layers, P, chunkOf, cuts, o.wrapGap);
    }

    /* 7 - assemble output */
    var outNodes = nodes.map(function (n) {
      var p = P[n.id];
      return {
        id: n.id, label: n.label, lines: n.lines, shape: n.shape,
        x: p.x, y: p.y, w: n.w, h: n.h, textDy: n.textDy || 0,
        layer: p.layer, chunk: chunkOf[n.id] || 0
      };
    });

    var outEdges = [], wrapLane = 0;
    edges.forEach(function (e) {
      if (e.selfLoop) {
        outEdges.push({
          id: e.id, from: e.from, to: e.to, label: e.label, style: e.style, arrow: e.arrow,
          selfLoop: true, points: [], labelPos: null
        });
        return;
      }
      var chain = e.flip ? e.chain.slice().reverse() : e.chain;
      var pts = chain.map(function (c) {
        return { x: P[c].x, y: P[c].y, chunk: chunkOf[c] || 0, layer: P[c].layer };
      });
      if (wrapBounds) {
        var routed = [pts[0]];
        for (var pi = 0; pi + 1 < pts.length; pi++) {
          if (pts[pi].chunk !== pts[pi + 1].chunk) {
            var det = detour(pts, pi, wrapBounds, wrapLane++, o.wrapGap);
            if (det) det.forEach(function (d) { routed.push(d); });
          }
          routed.push(pts[pi + 1]);
        }
        pts = routed;
      }
      var labelPos = null;
      chain.forEach(function (c) {
        if (proper[c] && proper[c].isLabel) labelPos = { x: P[c].x, y: P[c].y };
      });
      outEdges.push({
        id: e.id, from: e.from, to: e.to, label: e.label, style: e.style, arrow: e.arrow,
        reversed: e.reversed, points: pts, labelPos: labelPos, wrapped: pts.some(function (p, i) {
          return i > 0 && p.chunk !== pts[i - 1].chunk;
        })
      });
    });

    /* transpose back for LR/RL */
    if (horizontal) {
      outNodes.forEach(function (n) {
        var t = n.x; n.x = n.y; n.y = t;
        t = n.w; n.w = n.h; n.h = t;
      });
      outEdges.forEach(function (e) {
        e.points.forEach(function (p) { var t = p.x; p.x = p.y; p.y = t; });
        if (e.labelPos) { var t2 = e.labelPos.x; e.labelPos.x = e.labelPos.y; e.labelPos.y = t2; }
      });
    }
    if (dir === 'BT' || dir === 'RL') {
      var axis = (dir === 'BT') ? 'y' : 'x';
      outNodes.forEach(function (n) { n[axis] = -n[axis]; });
      outEdges.forEach(function (e) {
        e.points.forEach(function (p) { p[axis] = -p[axis]; });
        if (e.labelPos) e.labelPos[axis] = -e.labelPos[axis];
      });
    }

    /* normalise to origin */
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    outNodes.forEach(function (n) {
      minX = Math.min(minX, n.x - n.w / 2); maxX = Math.max(maxX, n.x + n.w / 2);
      minY = Math.min(minY, n.y - n.h / 2); maxY = Math.max(maxY, n.y + n.h / 2);
    });
    outEdges.forEach(function (e) {
      e.points.forEach(function (p) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      });
    });
    if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 0; maxY = 0; }
    var pad = 24;
    outNodes.forEach(function (n) { n.x = n.x - minX + pad; n.y = n.y - minY + pad; });
    outEdges.forEach(function (e) {
      e.points.forEach(function (p) { p.x = p.x - minX + pad; p.y = p.y - minY + pad; });
      if (e.labelPos) { e.labelPos.x = e.labelPos.x - minX + pad; e.labelPos.y = e.labelPos.y - minY + pad; }
    });

    var W = maxX - minX + pad * 2, H = maxY - minY + pad * 2;

    /* clip endpoints + build route geometry */
    var nodeById = {};
    outNodes.forEach(function (n) { nodeById[n.id] = n; });
    var flowVertical = !(dir === 'LR' || dir === 'RL');
    if (o.routing === 'polyline') {
      // polyline is the honest straight-line mode: aim at the target, clip on the outline
      outEdges.forEach(function (e) {
        if (e.selfLoop) return;
        var pts = e.points;
        var src = nodeById[e.from], dst = nodeById[e.to];
        pts[0] = clipToShape(src, pts[1] || { x: dst.x, y: dst.y });
        pts[pts.length - 1] = clipToShape(dst, pts[pts.length - 2] || { x: src.x, y: src.y });
        pts[0].layer = src.layer; pts[0].chunk = src.chunk; pts[0].nodeId = src.id;
        pts[pts.length - 1].layer = dst.layer; pts[pts.length - 1].chunk = dst.chunk;
        pts[pts.length - 1].nodeId = dst.id;
      });
    } else {
      assignPorts(outEdges, nodeById, flowVertical, Math.max(14, o.edgeSep + 8));
    }

    var chan = o.routing === 'orthogonal'
      ? assignChannels(outEdges, flowVertical ? 'y' : 'x', flowVertical ? 'x' : 'y',
                       Math.max(6, o.edgeSep * 0.6), 14)
      : null;

    outEdges.forEach(function (e) {
      if (e.selfLoop) { e.path = selfLoopPath(nodeById[e.from]); return; }
      var pts = e.points;
      e.path = buildPath(pts, o.routing, o.cornerRadius, flowVertical, chan, e.id);
      if (!e.labelPos && e.label) {
        var mid = pts[Math.floor(pts.length / 2)];
        var prev = pts[Math.max(0, Math.floor(pts.length / 2) - 1)];
        e.labelPos = { x: (mid.x + prev.x) / 2, y: (mid.y + prev.y) / 2 };
      }
    });

    var t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    return {
      nodes: outNodes, edges: outEdges, width: Math.round(W), height: Math.round(H),
      dir: dir,
      stats: {
        nodes: outNodes.length, edges: outEdges.length,
        layers: layers.length, dummies: dummyCount,
        crossings: ord.crossings,
        reversed: edges.filter(function (e) { return e.reversed; }).length,
        chunks: cuts.length + 1,
        width: Math.round(W), height: Math.round(H),
        ar: +(W / Math.max(1, H)).toFixed(2),
        ms: +(t1 - t0).toFixed(1)
      }
    };
  }

  function emptyStats(t0) {
    return { nodes: 0, edges: 0, layers: 0, dummies: 0, crossings: 0, reversed: 0,
             chunks: 1, width: 0, height: 0, ar: 0, ms: 0 };
  }

  function measureWrapped(layers, P, cuts, gap) {
    var chunkIdx = {}, c = 0;
    for (var i = 0; i < layers.length; i++) {
      if (cuts.indexOf(i) >= 0) c++;
      chunkIdx[i] = c;
    }
    var lo = {}, hi = {}, top = {}, bot = {};
    layers.forEach(function (L, i) {
      var ci = chunkIdx[i];
      L.forEach(function (v) {
        var p = P[v];
        lo[ci] = Math.min(lo[ci] === undefined ? Infinity : lo[ci], p.x - p.w / 2);
        hi[ci] = Math.max(hi[ci] === undefined ? -Infinity : hi[ci], p.x + p.w / 2);
        top[ci] = Math.min(top[ci] === undefined ? Infinity : top[ci], p.y - p.h / 2);
        bot[ci] = Math.max(bot[ci] === undefined ? -Infinity : bot[ci], p.y + p.h / 2);
      });
    });
    var w = 0, h = 0, n = Object.keys(lo).length;
    Object.keys(lo).forEach(function (k) {
      w += hi[k] - lo[k];
      h = Math.max(h, bot[k] - top[k]);
    });
    w += gap * (n - 1);
    return { w: w, h: h };
  }

  function applyWrap(layers, P, chunkOf, cuts, gap) {
    var chunkIdx = {}, c = 0;
    for (var i = 0; i < layers.length; i++) {
      if (cuts.indexOf(i) >= 0) c++;
      chunkIdx[i] = c;
    }
    var lo = {}, hi = {}, top = {}, bot = {};
    layers.forEach(function (L, i) {
      var ci = chunkIdx[i];
      L.forEach(function (v) {
        var p = P[v];
        lo[ci] = Math.min(lo[ci] === undefined ? Infinity : lo[ci], p.x - p.w / 2);
        hi[ci] = Math.max(hi[ci] === undefined ? -Infinity : hi[ci], p.x + p.w / 2);
        top[ci] = Math.min(top[ci] === undefined ? Infinity : top[ci], p.y - p.h / 2);
        bot[ci] = Math.max(bot[ci] === undefined ? -Infinity : bot[ci], p.y + p.h / 2);
      });
    });
    var offX = {}, run = 0;
    var keys = Object.keys(lo).map(Number).sort(function (a, b) { return a - b; });
    keys.forEach(function (k) {
      offX[k] = run - lo[k];
      run += (hi[k] - lo[k]) + gap;
    });
    var baseTop = top[keys[0]];
    layers.forEach(function (L, i) {
      var ci = chunkIdx[i];
      L.forEach(function (v) {
        P[v].x += offX[ci];
        P[v].y -= (top[ci] - baseTop);
        chunkOf[v] = ci;
      });
    });
    // bounds in final (post-translation) space, for routing wrapped edges around chunks
    var bounds = {};
    keys.forEach(function (k) {
      bounds[k] = {
        left: lo[k] + offX[k], right: hi[k] + offX[k],
        top: baseTop, bottom: bot[k] - (top[k] - baseTop)
      };
    });
    return bounds;
  }

  /* An edge that crosses a cut must not be drawn straight through the gap - it has to
     leave the bottom of one chunk, cross the gutter, and come back in at the top of the
     next.  Each wrapped edge gets its own lane so they do not stack on top of each other. */
  function detour(pts, i, bounds, lane, gap) {
    var a = pts[i], b = pts[i + 1];
    var ca = bounds[a.chunk], cb = bounds[b.chunk];
    if (!ca || !cb) return null;
    var forward = b.chunk > a.chunk;
    var off = lane * 7;
    var exitY = ca.bottom + 18 + off;
    var enterY = cb.top - 18 - off;
    var gutter = forward
      ? (ca.right + cb.left) / 2 + (off - gap / 4)
      : (cb.right + ca.left) / 2 + (off - gap / 4);
    return [
      { x: a.x, y: exitY, chunk: a.chunk, hard: true },
      { x: gutter, y: exitY, chunk: a.chunk, hard: true },
      { x: gutter, y: enterY, chunk: b.chunk, hard: true },
      { x: b.x, y: enterY, chunk: b.chunk, hard: true }
    ];
  }

  /* ------------------------------------------------------------------ *
   * geometry
   * ------------------------------------------------------------------ */
  /* How far along the ray (dx,dy) from the centre the outline sits, for shapes whose
     silhouette is a polygon.  Points are centre-relative, in order. */
  function rayToPolygon(dx, dy, pts) {
    var best = Infinity;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i], q = pts[(i + 1) % pts.length];
      var ex = q[0] - p[0], ey = q[1] - p[1];
      var den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue;
      var t = (p[0] * ey - p[1] * ex) / den;
      var u = (p[0] * dy - p[1] * dx) / den;
      if (t > 0 && u >= 0 && u <= 1) best = Math.min(best, t);
    }
    return isFinite(best) ? best : 1;
  }

  /* A cylinder is a box with an elliptical cap dished into each end, so near the left
     and right of the top face the outline sits well below the bounding box.  Clipping
     to the box there leaves the arrow floating in the gap. */
  function rayToCylinder(dx, dy, hw, hh, e) {
    var tSide = Math.abs(hw / (dx || 1e-9));
    if (Math.abs(dy * tSide) <= hh - e) return tSide;
    var c = (dy < 0 ? -1 : 1) * (hh - e);
    var A = (dx * dx) / (hw * hw) + (dy * dy) / (e * e);
    var B = -2 * dy * c / (e * e);
    var C = (c * c) / (e * e) - 1;
    var disc = B * B - 4 * A * C;
    if (disc < 0) return tSide;
    var root = (-B + Math.sqrt(disc)) / (2 * A);
    return root > 0 ? root : tSide;
  }

  function clipToShape(n, toward) {
    var dx = toward.x - n.x, dy = toward.y - n.y;
    if (dx === 0 && dy === 0) return { x: n.x, y: n.y + n.h / 2 };
    var hw = n.w / 2, hh = n.h / 2, t, k;
    if (n.shape === 'circle' || n.shape === 'stadium' || n.shape === 'round') {
      t = 1 / Math.sqrt((dx * dx) / (hw * hw) + (dy * dy) / (hh * hh));
      if (n.shape !== 'circle') {
        var tr = Math.min(Math.abs(hw / (dx || 1e-9)), Math.abs(hh / (dy || 1e-9)));
        t = (t + tr) / 2;
      }
    } else if (n.shape === 'diamond') {
      t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
    } else if (n.shape === 'cylinder') {
      t = rayToCylinder(dx, dy, hw, hh, Math.min(12, n.h / 4));
    } else if (n.shape === 'hexagon') {
      k = Math.min(18, n.w / 5);
      t = rayToPolygon(dx, dy, [[-hw + k, -hh], [hw - k, -hh], [hw, 0],
                                [hw - k, hh], [-hw + k, hh], [-hw, 0]]);
    } else if (n.shape === 'parallelogram') {
      k = Math.min(18, n.w / 5);
      t = rayToPolygon(dx, dy, [[-hw + k, -hh], [hw, -hh], [hw - k, hh], [-hw, hh]]);
    } else {
      t = Math.min(Math.abs(hw / (dx || 1e-9)), Math.abs(hh / (dy || 1e-9)));
    }
    return { x: n.x + dx * t, y: n.y + dy * t, chunk: toward.chunk };
  }

  /* Geometric clipping sends an edge out of whichever point on the outline lies on the
     straight line to its target - which for a box means it can leave through a corner and
     arrive at a corner, and several edges converging on one node all land on the same spot.
     Real orthogonal routers attach to the face perpendicular to the flow and spread the
     attachment points along it.  That is what this does. */
  var SPREAD = {
    rect: 0.66, round: 0.6, stadium: 0.5, diamond: 0.5,
    circle: 0.5, cylinder: 0.62, hexagon: 0.52, parallelogram: 0.5
  };

  // where the shape's outline sits, `off` across from the centre, on the `side` face
  function faceProject(n, off, side, vertical) {
    var halfCross = (vertical ? n.w : n.h) / 2;
    var halfFlow = (vertical ? n.h : n.w) / 2;
    var r = halfCross ? Math.min(1, Math.abs(off) / halfCross) : 0;
    var d = halfFlow;
    if (n.shape === 'diamond') d = halfFlow * (1 - r);
    else if (n.shape === 'circle') d = halfFlow * Math.sqrt(Math.max(0, 1 - r * r));
    else if (n.shape === 'cylinder' && vertical) {
      var e = Math.min(12, n.h / 4);
      d = halfFlow - e + e * Math.sqrt(Math.max(0, 1 - r * r));
    }
    return vertical
      ? { x: n.x + off, y: n.y + side * d }
      : { x: n.x + side * d, y: n.y + off };
  }

  function assignPorts(outEdges, nodeById, vertical, portGap) {
    var buckets = {};
    var ca = vertical ? 'x' : 'y', fa = vertical ? 'y' : 'x';

    outEdges.forEach(function (e) {
      if (e.selfLoop || e.points.length < 2) return;
      var src = nodeById[e.from], dst = nodeById[e.to];
      if (!src || !dst) return;
      var nextP = e.points[1], prevP = e.points[e.points.length - 2];
      var sSide = (nextP[fa] >= src[fa]) ? 1 : -1;
      var dSide = (prevP[fa] <= dst[fa]) ? -1 : 1;
      var ks = e.from + '|' + sSide, kd = e.to + '|' + dSide;
      (buckets[ks] = buckets[ks] || { node: src, side: sSide, list: [] })
        .list.push({ e: e, idx: 0, ref: nextP[ca], kind: 'out' });
      (buckets[kd] = buckets[kd] || { node: dst, side: dSide, list: [] })
        .list.push({ e: e, idx: e.points.length - 1, ref: prevP[ca], kind: 'in' });
    });

    Object.keys(buckets).forEach(function (k) {
      var b = buckets[k], n = b.node, list = b.list;
      list.sort(function (p, q) { return p.ref - q.ref; });
      var halfCross = (vertical ? n.w : n.h) / 2;
      var usable = halfCross * (SPREAD[n.shape] || 0.6);
      var count = list.length;
      var centre = vertical ? n.x : n.y;
      var step = count > 1 ? Math.min(portGap, (usable * 2) / (count - 1)) : 0;
      // Three or more edges on one face share a single track downstream, so they form a
      // bus, and one stub into that bus reads far better than a row of short ones.  Only
      // when the face flows one way, though: a face carrying both arrivals and departures
      // would stack their stubs on top of each other.
      var uniform = list.every(function (it) { return it.kind === list[0].kind; });
      if (count >= 3 && uniform) {
        var pc = faceProject(n, 0, b.side, vertical);
        list.forEach(function (item) {
          item.e.points[item.idx] = { x: pc.x, y: pc.y, layer: n.layer, chunk: n.chunk, nodeId: n.id };
        });
        return;
      }

      // Each port wants to sit where its partner is, so an edge arriving from straight
      // above stays straight.  Push apart only as far as the minimum gap demands, then
      // slide the whole block back onto the face.  Spreading evenly regardless would
      // knock naturally-aligned edges into pointless diagonals.
      var wants = [], anchor = -1;
      for (var i = 0; i < count; i++) {
        var want = Math.max(-usable, Math.min(usable, list[i].ref - centre));
        if (Math.abs(want) <= 1) anchor = i;   // this edge already runs straight
        // A departure and the arrival on the node directly across the gap are derived
        // from the same two box positions, so they land on the same offset and share one
        // corridor.  One run then sits on top of the other and a pair of crossing edges
        // reads as a single forked line.  Pull arrivals in by half a port gap; an edge
        // already running straight keeps its offset of zero and stays straight.
        if (list[i].kind === 'in' && Math.abs(want) > 1) {
          want -= (want > 0 ? 1 : -1) * Math.min(portGap / 2, Math.abs(want));
        }
        wants.push(want);
      }
      // Ports only have to stay far enough apart to read as separate; demanding the full
      // port gap here is what used to drag a straight edge into a diagonal.
      var minGap = Math.min(step, portGap * 0.45);
      var pos = [];
      for (i = 0; i < count; i++) pos.push(i === 0 ? wants[i] : Math.max(wants[i], pos[i - 1] + minGap));
      if (anchor >= 0 && Math.abs(pos[anchor]) > 0.01) {
        var slide = -pos[anchor];
        for (i = 0; i < count; i++) pos[i] += slide;
      }
      var excess = pos[count - 1] - usable;
      if (excess > 0) for (i = 0; i < count; i++) pos[i] -= excess;
      var deficit = -usable - pos[0];
      if (deficit > 0) for (i = 0; i < count; i++) pos[i] += deficit;

      list.forEach(function (item, j) {
        var p = faceProject(n, pos[j], b.side, vertical);
        item.e.points[item.idx] = { x: p.x, y: p.y, layer: n.layer, chunk: n.chunk, nodeId: n.id };
      });
    });
  }

  /* Every edge that changes lane between two layers needs a run across the gap.  If they
     all sit at the midpoint they draw on top of each other - which is exactly where ELK's
     orthogonal router beats a naive one.  Group the runs by layer gap, then colour them
     like an interval graph: two runs may share a track only if their spans don't overlap.
     Track t of T sits at lo + (t+1)(hi-lo)/(T+1), so the gap stays evenly divided. */
  function assignChannels(outEdges, fa, ca, gapPad, jog) {
    var groups = {};
    outEdges.forEach(function (e) {
      if (e.selfLoop) return;
      for (var i = 0; i + 1 < e.points.length; i++) {
        var a = e.points[i], b = e.points[i + 1];
        if (a.hard || b.hard) continue;
        if (a.layer === undefined || b.layer === undefined) continue;
        if (Math.abs(a[ca] - b[ca]) < jog) continue;      // straight enough, no run needed
        if (Math.abs(a[fa] - b[fa]) < 1) continue;
        var key = (a.chunk | 0) + '#' + Math.min(a.layer, b.layer) + '#' + Math.max(a.layer, b.layer);
        (groups[key] = groups[key] || []).push({
          eid: e.id, i: i, aId: a.nodeId, bId: b.nodeId,
          lo: Math.min(a[fa], b[fa]), hi: Math.max(a[fa], b[fa]),
          c0: Math.min(a[ca], b[ca]), c1: Math.max(a[ca], b[ca])
        });
      }
    });

    var out = {};
    Object.keys(groups).forEach(function (k) {
      var segs = groups[k];
      // usable band = the span every run in this gap can reach
      var lo = -Infinity, hi = Infinity;
      segs.forEach(function (s) { lo = Math.max(lo, s.lo); hi = Math.min(hi, s.hi); });
      if (!(hi - lo > 2)) { lo = segs[0].lo; hi = segs[0].hi; }

      // Runs that share an endpoint are one hyperedge - a fan-out or a merge - and belong
      // on a single shared track.  Giving each its own track is what turns a clean bus into
      // a stack of nested ladders.
      var count = {};
      segs.forEach(function (s) {
        if (s.aId) count[s.aId] = (count[s.aId] || 0) + 1;
        if (s.bId) count[s.bId] = (count[s.bId] || 0) + 1;
      });
      var hyper = {}, order = [];
      segs.forEach(function (s, idx) {
        var ca2 = s.aId ? (count[s.aId] || 0) : 0, cb2 = s.bId ? (count[s.bId] || 0) : 0;
        var key = (ca2 > 1 && ca2 >= cb2) ? 'S' + s.aId
                : (cb2 > 1) ? 'T' + s.bId
                : 'u' + idx;
        if (!hyper[key]) { hyper[key] = { c0: s.c0, c1: s.c1, segs: [] }; order.push(key); }
        hyper[key].c0 = Math.min(hyper[key].c0, s.c0);
        hyper[key].c1 = Math.max(hyper[key].c1, s.c1);
        hyper[key].segs.push(s);
      });

      var bundles = order.map(function (key) { return hyper[key]; });
      bundles.sort(function (p, q) { return p.c0 - q.c0 || p.c1 - q.c1; });
      var tracks = [];
      bundles.forEach(function (bd) {
        var t = 0;
        for (; t < tracks.length; t++) {
          var clash = false;
          for (var j = 0; j < tracks[t].length; j++) {
            var o = tracks[t][j];
            if (bd.c0 < o.c1 + gapPad && bd.c1 > o.c0 - gapPad) { clash = true; break; }
          }
          if (!clash) break;
        }
        if (t === tracks.length) tracks.push([]);
        tracks[t].push(bd);
        bd.track = t;
      });
      var T = tracks.length;
      bundles.forEach(function (bd) {
        var y = lo + (bd.track + 1) * (hi - lo) / (T + 1);
        bd.segs.forEach(function (s) { out[s.eid + ':' + s.i] = y; });
      });
    });
    return out;
  }

  function buildPath(pts, mode, radius, vertical, chan, eid) {
    if (pts.length < 2) return '';
    var wrapped = pts.some(function (p) { return p.hard; });
    // a wrapped detour is a routing decision, not a style one.  Splining through its
    // right angles makes Catmull-Rom overshoot into loops, so force orthogonal there.
    if (wrapped) mode = 'orthogonal';
    if (mode === 'polyline') return roundedPolyline(pts, radius * 0.6);
    if (mode === 'spline') return flowSpline(pts, vertical);
    var JOG = 14;
    var out = ['M' + f(pts[0].x) + ' ' + f(pts[0].y)];
    for (var i = 1; i < pts.length; i++) {
      var a = pts[i - 1], b = pts[i];
      var offAxis = vertical ? Math.abs(a.x - b.x) : Math.abs(a.y - b.y);
      var onAxis = vertical ? Math.abs(a.y - b.y) : Math.abs(a.x - b.x);
      if (offAxis < 0.6 || onAxis < 0.6 || offAxis < JOG) {
        out.push('L' + f(b.x) + ' ' + f(b.y));
        continue;
      }
      var mid = chan && chan[eid + ':' + (i - 1)];
      if (vertical) {
        var my = mid === undefined ? (a.y + b.y) / 2 : mid;
        out.push('L' + f(a.x) + ' ' + f(my));
        out.push('L' + f(b.x) + ' ' + f(my));
        out.push('L' + f(b.x) + ' ' + f(b.y));
      } else {
        var mx = mid === undefined ? (a.x + b.x) / 2 : mid;
        out.push('L' + f(mx) + ' ' + f(a.y));
        out.push('L' + f(mx) + ' ' + f(b.y));
        out.push('L' + f(b.x) + ' ' + f(b.y));
      }
    }
    return roundCorners(out.join(''), radius);
  }

  function f(n) { return Math.round(n * 100) / 100; }

  function roundedPolyline(pts, r) {
    var d = 'M' + f(pts[0].x) + ' ' + f(pts[0].y);
    for (var i = 1; i < pts.length; i++) d += 'L' + f(pts[i].x) + ' ' + f(pts[i].y);
    return d;
  }

  function roundCorners(d, r) {
    if (!r) return d;
    var cmds = d.match(/[ML][^ML]*/g) || [];
    var pts = cmds.map(function (c) {
      var p = c.slice(1).trim().split(/\s+/).map(Number);
      return { x: p[0], y: p[1] };
    });
    var clean = [pts[0]];
    for (var i = 1; i < pts.length; i++) {
      var p = pts[i], q = clean[clean.length - 1];
      if (Math.abs(p.x - q.x) > 0.4 || Math.abs(p.y - q.y) > 0.4) clean.push(p);
    }
    // A vertex the line runs straight through is not a corner.  Rounding it emits a Q
    // that draws as a straight segment anyway, which on a long dummy chain turns one
    // vertical line into a dozen curves in every export.
    for (i = 1; i + 1 < clean.length; i++) {
      var a0 = clean[i - 1], b0 = clean[i], c0 = clean[i + 1];
      var cross = (b0.x - a0.x) * (c0.y - b0.y) - (b0.y - a0.y) * (c0.x - b0.x);
      if (Math.abs(cross) < 0.5) { clean.splice(i, 1); i--; }
    }
    if (clean.length < 3) {
      return clean.map(function (p, i) { return (i ? 'L' : 'M') + f(p.x) + ' ' + f(p.y); }).join('');
    }
    var out = 'M' + f(clean[0].x) + ' ' + f(clean[0].y);
    for (var j = 1; j < clean.length - 1; j++) {
      var prev = clean[j - 1], cur = clean[j], next = clean[j + 1];
      var d1 = dist(prev, cur), d2 = dist(cur, next);
      var rr = Math.min(r, d1 / 2, d2 / 2);
      var a = lerp(cur, prev, rr / (d1 || 1)), b = lerp(cur, next, rr / (d2 || 1));
      out += 'L' + f(a.x) + ' ' + f(a.y) + 'Q' + f(cur.x) + ' ' + f(cur.y) + ' ' + f(b.x) + ' ' + f(b.y);
    }
    var last = clean[clean.length - 1];
    out += 'L' + f(last.x) + ' ' + f(last.y);
    return out;
  }
  function dist(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }
  function lerp(a, b, t) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }

  /* Splines leave the source and enter the target along the flow axis, the way dot
     routes them.  A plain Catmull-Rom degenerates to a straight line on 2-point
     edges - and in a flowchart most edges span a single layer, so that made
     'spline' indistinguishable from 'polyline'. */
  function flowSpline(pts, vertical) {
    var a = pts[0], z = pts[pts.length - 1];
    var travel = vertical ? (z.y - a.y) : (z.x - a.x);
    var sign = travel >= 0 ? 1 : -1;

    if (pts.length === 2) {
      var span = Math.abs(travel);
      var k = Math.max(14, span * 0.45);
      var c1 = vertical ? { x: a.x, y: a.y + sign * k } : { x: a.x + sign * k, y: a.y };
      var c2 = vertical ? { x: z.x, y: z.y - sign * k } : { x: z.x - sign * k, y: z.y };
      return 'M' + f(a.x) + ' ' + f(a.y) +
             'C' + f(c1.x) + ' ' + f(c1.y) + ' ' + f(c2.x) + ' ' + f(c2.y) + ' ' + f(z.x) + ' ' + f(z.y);
    }

    // multi-point: Catmull-Rom with virtual endpoints offset along the flow axis,
    // so the curve enters and leaves the boxes cleanly instead of flattening out
    var k2 = 22 * sign;
    var pre = vertical ? { x: a.x, y: a.y - k2 } : { x: a.x - k2, y: a.y };
    var post = vertical ? { x: z.x, y: z.y + k2 } : { x: z.x + k2, y: z.y };
    return catmullRom(pts, pre, post);
  }

  /* Centripetal parameterisation (alpha = 0.5), not uniform.  A long edge's dummy points
     are spaced one rank apart while the stub off the source box is a few pixels, and
     uniform Catmull-Rom answers that imbalance by overshooting: the curve bulges past the
     corridor and lands back on it with a visible kink.  Weighting each segment by the
     square root of its length is the standard cure, and it cannot cusp or self-intersect. */
  function catmullRom(pts, pre, post) {
    if (pts.length === 2) {
      return 'M' + f(pts[0].x) + ' ' + f(pts[0].y) + 'L' + f(pts[1].x) + ' ' + f(pts[1].y);
    }
    var p = [pre || pts[0]].concat(pts, [post || pts[pts.length - 1]]);
    var t = [0];
    for (var k = 1; k < p.length; k++) {
      t.push(t[k - 1] + Math.max(1e-4, Math.sqrt(dist(p[k - 1], p[k]))));
    }
    var d = 'M' + f(pts[0].x) + ' ' + f(pts[0].y);
    for (var i = 1; i + 2 < p.length; i++) {
      var p0 = p[i - 1], p1 = p[i], p2 = p[i + 1], p3 = p[i + 2];
      var span = t[i + 1] - t[i];
      var a = span / (3 * (t[i + 1] - t[i - 1]));
      var b = span / (3 * (t[i + 2] - t[i]));
      var c1 = { x: p1.x + (p2.x - p0.x) * a, y: p1.y + (p2.y - p0.y) * a };
      var c2 = { x: p2.x - (p3.x - p1.x) * b, y: p2.y - (p3.y - p1.y) * b };
      d += 'C' + f(c1.x) + ' ' + f(c1.y) + ' ' + f(c2.x) + ' ' + f(c2.y) + ' ' + f(p2.x) + ' ' + f(p2.y);
    }
    return d;
  }

  function selfLoopPath(n) {
    if (!n) return '';
    var x = n.x + n.w / 2, y = n.y, r = Math.max(18, n.h * 0.42);
    return 'M' + f(x) + ' ' + f(y - r * 0.4) +
           'C' + f(x + r * 1.7) + ' ' + f(y - r * 1.2) + ' ' +
                 f(x + r * 1.7) + ' ' + f(y + r * 1.2) + ' ' +
                 f(x) + ' ' + f(y + r * 0.4);
  }

  return {
    parse: parse, layout: layout, setMeasurer: setMeasurer, DEFAULTS: DEFAULTS,
    _internals: {
      greedyFAS: greedyFAS, longestPath: longestPath, coffmanGraham: coffmanGraham,
      networkSimplex: networkSimplex, promote: promote, buildDag: buildDag,
      countCrossingsBetween: countCrossingsBetween, totalCrossings: totalCrossings,
      brandesKopf: brandesKopf, chooseCuts: chooseCuts, measure: function () { return measure; }
    }
  };
});
