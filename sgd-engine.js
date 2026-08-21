/* stress layout by stochastic gradient descent

   Zheng, Pawar & Goodman, "Graph Drawing by Stochastic Gradient Descent",
   IEEE TVCG 2019 (arXiv:1710.04626).  Algorithm 1, with the exponential
   annealing schedule from section 2.1.

   Where the Sugiyama engine commits to ranks and then minimises crossings
   combinatorially, this minimises one continuous objective:

     stress(X) = sum over i<j of  w_ij * ( |Xi - Xj| - d_ij )^2 ,   w_ij = d_ij^-2

   d_ij is the graph-theoretic distance, so the drawing tries to make Euclidean
   distance match hop count everywhere at once.  There are no layers, and nothing
   in the model knows which way an edge points or how big a box is; those are
   bolted on afterwards by the constraint pass at the end of this file.
*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SGDLayout = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* Deterministic by default: a workbench where the same input redraws differently
     every run makes it impossible to tell a setting apart from the noise. */
  function rng(seed) {
    var a = (seed || 1) >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ------------------------------------------------------------------ *
   * all-pairs shortest path, one BFS per source
   * ------------------------------------------------------------------ */
  function allPairs(n, adj) {
    var d = new Float64Array(n * n);
    var queue = new Int32Array(n);
    for (var s = 0; s < n; s++) {
      var row = s * n;
      for (var k = 0; k < n; k++) d[row + k] = Infinity;
      d[row + s] = 0;
      var head = 0, tail = 0;
      queue[tail++] = s;
      while (head < tail) {
        var v = queue[head++], nd = d[row + v] + 1, nb = adj[v];
        for (var i = 0; i < nb.length; i++) {
          var w = nb[i];
          if (d[row + w] === Infinity) { d[row + w] = nd; queue[tail++] = w; }
        }
      }
    }
    return d;
  }

  /* The model has no term that separates two components, so an unreachable pair
     left at infinity means the components drift apart forever.  Pinning them one
     hop beyond the diameter keeps the drawing in frame and is honest about the
     fact that the true distance is undefined. */
  function bridgeComponents(d, n) {
    var far = 0, bridged = 0;
    for (var i = 0; i < n * n; i++) if (d[i] !== Infinity && d[i] > far) far = d[i];
    var fill = far + 1;
    for (i = 0; i < n * n; i++) if (d[i] === Infinity) { d[i] = fill; bridged++; }
    return { diameter: far, bridged: bridged / 2 };
  }

  function stress(X, d, n) {
    var total = 0;
    for (var i = 0; i < n; i++) {
      for (var j = i + 1; j < n; j++) {
        var dij = d[i * n + j];
        if (!dij) continue;
        var dx = X[2 * i] - X[2 * j], dy = X[2 * i + 1] - X[2 * j + 1];
        var diff = Math.sqrt(dx * dx + dy * dy) - dij;
        total += (diff * diff) / (dij * dij);
      }
    }
    return total;
  }

  /* ------------------------------------------------------------------ *
   * Algorithm 1
   * ------------------------------------------------------------------ */
  function schedule(d, n, epochs, epsilon) {
    var dMax = 0, dMin = Infinity;
    for (var i = 0; i < n; i++) {
      for (var j = i + 1; j < n; j++) {
        var v = d[i * n + j];
        if (v > dMax) dMax = v;
        if (v > 0 && v < dMin) dMin = v;
      }
    }
    if (!isFinite(dMin)) dMin = 1;
    // w = d^-2, so w_min comes from the largest distance and w_max from the smallest
    var etaMax = dMax * dMax;
    var etaMin = epsilon * dMin * dMin;
    var lambda = Math.log(etaMax / etaMin) / Math.max(1, epochs - 1);
    var out = [];
    for (var t = 0; t < epochs; t++) out.push(etaMax * Math.exp(-lambda * t));
    return out;
  }

  function run(d, n, opts) {
    var o = opts || {};
    var epochs = o.epochs === undefined ? 30 : o.epochs;
    var epsilon = o.epsilon === undefined ? 0.1 : o.epsilon;
    var rand = rng(o.seed === undefined ? 1 : o.seed);

    var X = o.init ? o.init.slice() : (function () {
      // the paper initialises uniformly in a unit square, then the schedule's
      // large first steps blow the drawing up to the right scale on its own
      var a = new Float64Array(2 * n);
      for (var i = 0; i < 2 * n; i++) a[i] = rand();
      return a;
    })();

    var pairCount = (n * (n - 1)) / 2;
    var pi = new Int32Array(pairCount), pj = new Int32Array(pairCount);
    var p = 0;
    for (var i = 0; i < n; i++) for (var j = i + 1; j < n; j++) { pi[p] = i; pj[p] = j; p++; }

    var etas = o.etas || schedule(d, n, epochs, epsilon);
    var trace = [];

    for (var t = 0; t < etas.length; t++) {
      var eta = etas[t];
      // random reshuffling: every pair exactly once per epoch, order redrawn each
      // epoch.  The paper measures this as beating both fixed order and sampling
      // with replacement.
      for (var s = pairCount - 1; s > 0; s--) {
        var r = (rand() * (s + 1)) | 0;
        var ti = pi[s]; pi[s] = pi[r]; pi[r] = ti;
        var tj = pj[s]; pj[s] = pj[r]; pj[r] = tj;
      }
      for (var k = 0; k < pairCount; k++) {
        var a = pi[k], b = pj[k];
        var dij = d[a * n + b];
        if (!dij) continue;
        var mu = eta / (dij * dij);
        if (mu > 1) mu = 1;
        var ax = 2 * a, ay = ax + 1, bx = 2 * b, by = bx + 1;
        var dx = X[ax] - X[bx], dy = X[ay] - X[by];
        var mag = Math.sqrt(dx * dx + dy * dy);
        if (mag < 1e-9) { dx = (rand() - 0.5) * 1e-6; dy = (rand() - 0.5) * 1e-6; mag = Math.sqrt(dx * dx + dy * dy); }
        var scale = ((mag - dij) / 2) * (mu / mag);
        var rx = dx * scale, ry = dy * scale;
        X[ax] -= rx; X[ay] -= ry;
        X[bx] += rx; X[by] += ry;
      }
      trace.push({ epoch: t, eta: eta, stress: stress(X, d, n) });
    }
    return { X: X, trace: trace };
  }

  /* ------------------------------------------------------------------ *
   * alternative optimisers
   *
   * All four write the same X array, so the constraint layer, the renderer and
   * both exporters are unchanged whichever one ran.  Only the first two share an
   * objective; that is the point of having them side by side.
   * ------------------------------------------------------------------ */

  /* Stress majorization, the localized (Gauss-Seidel) form of SMACOF.  Same
     objective as SGD above, different optimiser: it relocates one vertex at a time
     to the weighted average its neighbours want, which is guaranteed to decrease
     stress every sweep.  SGD gives no such guarantee but Zheng et al. report it
     reaching lower stress in fewer iterations, and with both in the same workbench
     you can check that on your own graph rather than taking their word for it. */
  function majorize(d, n, opts) {
    var o = opts || {};
    var iters = o.epochs === undefined ? 30 : o.epochs;
    var rand = rng(o.seed === undefined ? 1 : o.seed);
    var X = o.init ? o.init.slice() : (function () {
      var a = new Float64Array(2 * n);
      // start at the scale of the data, not in a unit square: majorization has no
      // annealing schedule to grow the drawing out of a tiny random blob
      var spread = 0;
      for (var k = 0; k < n * n; k++) if (d[k] > spread) spread = d[k];
      for (var i = 0; i < 2 * n; i++) a[i] = (rand() - 0.5) * spread;
      return a;
    })();
    var trace = [];
    for (var it = 0; it < iters; it++) {
      for (var i = 0; i < n; i++) {
        var nx = 0, ny = 0, den = 0;
        for (var j = 0; j < n; j++) {
          if (j === i) continue;
          var dij = d[i * n + j];
          if (!dij) continue;
          var w = 1 / (dij * dij);
          var dx = X[2 * i] - X[2 * j], dy = X[2 * i + 1] - X[2 * j + 1];
          var mag = Math.sqrt(dx * dx + dy * dy);
          if (mag < 1e-9) { dx = rand() - 0.5; dy = rand() - 0.5; mag = Math.sqrt(dx * dx + dy * dy); }
          nx += w * (X[2 * j] + dij * dx / mag);
          ny += w * (X[2 * j + 1] + dij * dy / mag);
          den += w;
        }
        if (den > 0) { X[2 * i] = nx / den; X[2 * i + 1] = ny / den; }
      }
      trace.push({ epoch: it, eta: 0, stress: stress(X, d, n) });
    }
    return { X: X, trace: trace };
  }

  /* Fruchterman & Reingold 1991: the classic spring embedder, kept as a baseline.
     It never computes graph distances at all, only pulls along edges and pushes
     everything else apart, which is exactly why its drawings say less about global
     structure than a stress layout does. */
  function fruchtermanReingold(n, adjList, opts) {
    var o = opts || {};
    var iters = o.epochs === undefined ? 300 : o.epochs;
    var rand = rng(o.seed === undefined ? 1 : o.seed);
    var side = (o.ideal || 100) * Math.sqrt(n);
    var k = side / Math.sqrt(n);
    var X = new Float64Array(2 * n);
    for (var i = 0; i < 2 * n; i++) X[i] = (rand() - 0.5) * side;
    var dispX = new Float64Array(n), dispY = new Float64Array(n);
    var temp = side / 10, cool = temp / (iters + 1);
    var trace = [];
    for (var it = 0; it < iters; it++) {
      for (i = 0; i < n; i++) { dispX[i] = 0; dispY[i] = 0; }
      for (i = 0; i < n; i++) {
        for (var j = i + 1; j < n; j++) {
          var dx = X[2 * i] - X[2 * j], dy = X[2 * i + 1] - X[2 * j + 1];
          var mag = Math.sqrt(dx * dx + dy * dy);
          if (mag < 1e-6) { dx = rand() - 0.5; dy = rand() - 0.5; mag = Math.sqrt(dx * dx + dy * dy); }
          var rep = (k * k) / mag;               // f_r = k^2 / d
          var ux = dx / mag * rep, uy = dy / mag * rep;
          dispX[i] += ux; dispY[i] += uy;
          dispX[j] -= ux; dispY[j] -= uy;
        }
      }
      for (i = 0; i < n; i++) {
        for (var e = 0; e < adjList[i].length; e++) {
          var t = adjList[i][e];
          if (t <= i) continue;
          var ex = X[2 * i] - X[2 * t], ey = X[2 * i + 1] - X[2 * t + 1];
          var em = Math.sqrt(ex * ex + ey * ey) || 1e-6;
          var att = (em * em) / k;               // f_a = d^2 / k
          var ax = ex / em * att, ay = ey / em * att;
          dispX[i] -= ax; dispY[i] -= ay;
          dispX[t] += ax; dispY[t] += ay;
        }
      }
      for (i = 0; i < n; i++) {
        var dm = Math.sqrt(dispX[i] * dispX[i] + dispY[i] * dispY[i]) || 1e-9;
        var lim = Math.min(dm, temp) / dm;
        X[2 * i] += dispX[i] * lim; X[2 * i + 1] += dispY[i] * lim;
      }
      temp -= cool;
      if (temp < 0) temp = 0;
    }
    return { X: X, trace: trace };
  }

  /* SNAP-tFDP (Chen et al., IEEE VIS 2026, arXiv:2608.01907), Algorithm 1.
     Edge-centric: walk the edge list, pull each edge together, then push the tail
     away from k uniformly sampled non-neighbours.  Degree weighting falls out of the
     sampling rather than being computed.  It never builds a distance matrix, so it
     is the one optimiser here that says nothing about global graph distance, and
     that is the interesting contrast.

     The paper's force pair, from its own comparison table: attraction linear in
     distance, repulsion the bounded Student-t form  -r / (1 + r^2)^gamma.  The
     constants below are chosen to suit flowchart-scale drawings; the paper tunes
     for graphs several orders of magnitude larger. */
  function snapTFDP(n, edgeList, opts) {
    var o = opts || {};
    var epochs = o.epochs === undefined ? 60 : o.epochs;
    var k = o.negatives === undefined ? 5 : o.negatives;
    var gamma = o.gamma === undefined ? 1 : o.gamma;
    var scale = o.ideal || 100;
    var rand = rng(o.seed === undefined ? 1 : o.seed);
    var X = new Float64Array(2 * n);
    for (var i = 0; i < 2 * n; i++) X[i] = (rand() - 0.5) * scale * Math.sqrt(n);
    // each undirected edge travels in both directions, so both endpoints get the
    // same treatment; the paper is explicit about this
    var E = [];
    edgeList.forEach(function (e) { E.push([e[0], e[1]]); E.push([e[1], e[0]]); });
    if (!E.length) return { X: X, trace: [] };
    var eta0 = scale * 0.12;
    for (var t = 0; t < epochs; t++) {
      var eta = eta0 * (1 - t / epochs);
      for (var s = E.length - 1; s > 0; s--) {
        var r = (rand() * (s + 1)) | 0;
        var tmp = E[s]; E[s] = E[r]; E[r] = tmp;
      }
      for (var m = 0; m < E.length; m++) {
        var a = E[m][0], b = E[m][1];
        var dx = X[2 * b] - X[2 * a], dy = X[2 * b + 1] - X[2 * a + 1];
        var mag = Math.sqrt(dx * dx + dy * dy) || 1e-6;
        var fa = eta * (mag / scale);                       // attraction, linear in r
        X[2 * a] += dx / mag * fa; X[2 * a + 1] += dy / mag * fa;
        X[2 * b] -= dx / mag * fa; X[2 * b + 1] -= dy / mag * fa;
        for (var q = 0; q < k; q++) {
          var sIdx = (rand() * n) | 0;
          if (sIdx === a) continue;
          var rx = X[2 * a] - X[2 * sIdx], ry = X[2 * a + 1] - X[2 * sIdx + 1];
          var rm = Math.sqrt(rx * rx + ry * ry) || 1e-6;
          var u = rm / scale;
          var fr = eta * (u / Math.pow(1 + u * u, gamma));  // bounded Student-t
          X[2 * a] += rx / rm * fr; X[2 * a + 1] += ry / rm * fr;
          X[2 * sIdx] -= rx / rm * fr; X[2 * sIdx + 1] -= ry / rm * fr;
        }
      }
    }
    return { X: X, trace: [] };
  }

  /* ------------------------------------------------------------------ *
   * constraint layer
   *
   * Nothing above knows a node is a box or that an edge points somewhere.
   * The stress model has no term for either, so both are imposed afterwards by
   * projecting the layout onto the constraint set.  Alternating a gradient step
   * with a projection is ordinary projected gradient descent, and it keeps the
   * stress objective honest: the projection only moves what it must.
   * ------------------------------------------------------------------ */

  /* Push overlapping boxes apart along whichever axis needs the smaller shove.
     Gansner & Hu's PRISM measures itself on how little it disturbs the input
     layout, which is the right goal here too: the SGD positions carry the
     structure, and overlap removal should not relayout the graph. */
  function removeOverlaps(nodes, opts) {
    var o = opts || {};
    var pad = o.pad === undefined ? 8 : o.pad;
    var maxPasses = o.maxPasses === undefined ? 200 : o.maxPasses;
    var n = nodes.length, moved = 0, pass = 0, remaining = 0;

    for (; pass < maxPasses; pass++) {
      remaining = 0;
      for (var i = 0; i < n; i++) {
        for (var j = i + 1; j < n; j++) {
          var a = nodes[i], b = nodes[j];
          var dx = b.x - a.x, dy = b.y - a.y;
          var ox = (a.w + b.w) / 2 + pad - Math.abs(dx);
          var oy = (a.h + b.h) / 2 + pad - Math.abs(dy);
          if (ox <= 0 || oy <= 0) continue;
          remaining++;
          if (ox < oy) {
            var sx = (dx < 0 ? -1 : 1) * ox / 2;
            a.x -= sx; b.x += sx; moved += ox;
          } else {
            var sy = (dy < 0 ? -1 : 1) * oy / 2;
            a.y -= sy; b.y += sy; moved += oy;
          }
        }
      }
      if (!remaining) break;
    }
    return { passes: pass, overlapsLeft: remaining, travel: moved };
  }

  function countOverlaps(nodes, pad) {
    pad = pad || 0;
    var c = 0;
    for (var i = 0; i < nodes.length; i++) {
      for (var j = i + 1; j < nodes.length; j++) {
        var a = nodes[i], b = nodes[j];
        if (Math.abs(b.x - a.x) < (a.w + b.w) / 2 + pad &&
            Math.abs(b.y - a.y) < (a.h + b.h) / 2 + pad) c++;
      }
    }
    return c;
  }

  /* Give the drawing a reading order back.  For every edge u -> v we want
     v to sit at least `gap` further along the flow axis than u.  Sweeping in
     topological order and pushing only the head of a violated edge satisfies
     every constraint in one pass on a DAG; a cycle cannot be satisfied at all,
     so those edges are reported rather than fought over. */
  function enforceFlow(nodes, edges, opts, host) {
    var o = opts || {};
    var axis = o.axis === 'x' ? 'x' : 'y';
    var gap = o.gap === undefined ? 60 : o.gap;
    var idx = {}, i;
    for (i = 0; i < nodes.length; i++) idx[nodes[i].id] = i;

    /* A retry loop makes the graph cyclic, and then every node has an incoming
       edge, the topological queue starts empty, and the sweep order collapses to
       whatever order the nodes were parsed in.  Pushing a node down after one of
       its own successors has already been placed then breaks an edge that was
       perfectly satisfiable.  Break the cycles first, exactly the way the Sugiyama
       engine does, and sweep the resulting DAG. */
    var work = [];
    edges.forEach(function (e) {
      if (idx[e.from] === undefined || idx[e.to] === undefined) return;
      if (e.from === e.to) return;
      work.push({ from: e.from, to: e.to });
    });
    /* Rüegg, Kieffer, Dwyer, Marriott & Wybrow (GD 2014) tried three ways of handling
       cycles and found the best was to run the same greedy feedback arc set heuristic
       the layered pipeline uses and then withhold a flow constraint from every edge in
       that set.  Withholding leaves those edges free for the stress term to place;
       reversing them, which is what this used to do, forces them to point backwards. */
    var freed = {};
    if (host && host.greedyFAS) {
      host.greedyFAS(nodes.map(function (nd) { return nd.id; }), work);
      work.forEach(function (e, k) { if (e.reversed) freed[k] = true; });
    }

    var succ = [], indeg = [], pairs = [];
    for (i = 0; i < nodes.length; i++) { succ.push([]); indeg.push(0); }
    work.forEach(function (e, k) {
      var a = idx[e.from], b = idx[e.to];
      pairs.push([a, b]);
      if (freed[k]) return;                 // on a cycle: left to the stress term
      succ[a].push(b); indeg[b]++;
    });

    var queue = [], order = [];
    for (i = 0; i < nodes.length; i++) if (!indeg[i]) queue.push(i);
    while (queue.length) {
      var v = queue.shift(); order.push(v);
      for (i = 0; i < succ[v].length; i++) if (--indeg[succ[v][i]] === 0) queue.push(succ[v][i]);
    }
    var acyclic = order.length === nodes.length;
    var seen = {};
    order.forEach(function (k) { seen[k] = true; });
    for (i = 0; i < nodes.length; i++) if (!seen[i]) order.push(i);

    var pushed = 0;
    for (var k2 = 0; k2 < order.length; k2++) {
      var u = order[k2];
      for (i = 0; i < succ[u].length; i++) {
        var w = succ[u][i];
        var need = nodes[u][axis] + gap;
        if (nodes[w][axis] < need) { pushed += need - nodes[w][axis]; nodes[w][axis] = need; }
      }
    }
    // report against the edges as written, not as reoriented
    var violated = 0;
    for (i = 0; i < pairs.length; i++) {
      if (nodes[pairs[i][1]][axis] <= nodes[pairs[i][0]][axis] + 0.5) violated++;
    }
    return { acyclic: acyclic, pushed: pushed, backwardEdges: violated,
             freedByFAS: Object.keys(freed).length };
  }

  /* A cut-down Adaptive Constrained Alignment.

     Stress plus a flow constraint does not produce a flowchart on its own: the
     optimiser wants nodes k hops apart to sit k*hop apart in Euclidean distance,
     the flow gap only supplies part of that vertically, and x quietly makes up the
     difference, which shears a deep chain into a diagonal ribbon.  Rüegg et al. run
     full ACA after stress for exactly this reason.  This is the cheap version: take
     the DAG edges already closest to vertical and merge their endpoints into one
     alignment group sharing a single x, skipping any merge that would stack two
     group members on top of each other. */
  function alignEdges(nodes, edges, opts, host) {
    var o = opts || {};
    var axis = o.axis === 'x' ? 'x' : 'y';       // flow axis
    var across = axis === 'y' ? 'x' : 'y';
    var extent = axis === 'y' ? 'h' : 'w';
    var tol = o.tol === undefined ? 90 : o.tol;
    var idx = {}, i;
    for (i = 0; i < nodes.length; i++) idx[nodes[i].id] = i;

    var work = [];
    edges.forEach(function (e) {
      if (idx[e.from] === undefined || idx[e.to] === undefined || e.from === e.to) return;
      work.push({ from: e.from, to: e.to });
    });
    var freed = {};
    if (host && host.greedyFAS) {
      host.greedyFAS(nodes.map(function (nd) { return nd.id; }), work);
      work.forEach(function (e, k) { if (e.reversed) freed[k] = true; });
    }

    var parent = nodes.map(function (_, k) { return k; });
    function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }

    var cand = [];
    work.forEach(function (e, k) {
      if (freed[k]) return;
      var u = idx[e.from], v = idx[e.to];
      cand.push({ u: u, v: v, gap: Math.abs(nodes[u][across] - nodes[v][across]) });
    });
    cand.sort(function (a, b) { return a.gap - b.gap; });

    var members = {};
    for (i = 0; i < nodes.length; i++) members[i] = [i];
    var merged = 0;
    cand.forEach(function (c) {
      if (c.gap > tol) return;
      var ru = find(c.u), rv = find(c.v);
      if (ru === rv) return;
      var gu = members[ru], gv = members[rv], ok = true;
      for (var a = 0; a < gu.length && ok; a++) {
        for (var b = 0; b < gv.length; b++) {
          var p = nodes[gu[a]], q = nodes[gv[b]];
          if (Math.abs(p[axis] - q[axis]) < (p[extent] + q[extent]) / 2 + 8) { ok = false; break; }
        }
      }
      if (!ok) return;
      parent[rv] = ru;
      members[ru] = gu.concat(gv);
      delete members[rv];
      merged++;
    });

    Object.keys(members).forEach(function (g) {
      var m = members[g];
      if (m.length < 2) return;
      var sum = 0;
      m.forEach(function (k) { sum += nodes[k][across]; });
      var avg = sum / m.length;
      m.forEach(function (k) { nodes[k][across] = avg; });
    });
    return { merged: merged };
  }

  /* Straight-line crossings, so the two workbenches can be scored on the same
     number.  Edges sharing an endpoint meet there by construction and are not
     counted as a crossing. */
  function countCrossings(segs) {
    function side(ax, ay, bx, by, cx, cy) {
      var v = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      return v > 1e-9 ? 1 : (v < -1e-9 ? -1 : 0);
    }
    var c = 0;
    for (var i = 0; i < segs.length; i++) {
      for (var j = i + 1; j < segs.length; j++) {
        var p = segs[i], q = segs[j];
        if (p.from === q.from || p.from === q.to || p.to === q.from || p.to === q.to) continue;
        var d1 = side(p.x1, p.y1, p.x2, p.y2, q.x1, q.y1);
        var d2 = side(p.x1, p.y1, p.x2, p.y2, q.x2, q.y2);
        var d3 = side(q.x1, q.y1, q.x2, q.y2, p.x1, p.y1);
        var d4 = side(q.x1, q.y1, q.x2, q.y2, p.x2, p.y2);
        if (d1 * d2 < 0 && d3 * d4 < 0) c++;
      }
    }
    return c;
  }

  /* ------------------------------------------------------------------ *
   * layout: same output shape as the Sugiyama engine, so the renderer and
   * both exporters work against either one unchanged
   * ------------------------------------------------------------------ */
  var DEFAULTS = {
    optimiser: 'sgd',     // sgd | majorization | fr | snap
    epochs: 30,
    epsilon: 0.1,
    seed: 1,
    edgeLength: 110,      // pixels per hop of graph distance
    flow: 'none',         // none | TB | LR
    flowGap: 70,
    overlapPad: 10,
    align: true,
    alignTol: 90,
    removeOverlaps: true
  };

  function layout(graph, opts, deps) {
    var t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    var o = {};
    Object.keys(DEFAULTS).forEach(function (k) { o[k] = DEFAULTS[k]; });
    if (opts) Object.keys(opts).forEach(function (k) { if (opts[k] !== undefined) o[k] = opts[k]; });

    var host = deps || (typeof FlowLayout !== 'undefined' ? FlowLayout : null);
    if (!host) throw new Error('SGDLayout.layout needs FlowLayout for node sizing and clipping');

    var nodes = graph.nodes.map(function (n) {
      return { id: n.id, label: n.label, shape: n.shape };
    });
    var edges = graph.edges.map(function (e, i) {
      return { id: 'e' + i, from: e.from, to: e.to, label: e.label || '', style: e.style, arrow: e.arrow };
    });
    host.sizeNodes(nodes, host.DEFAULTS);
    var n = nodes.length;
    if (!n) {
      return { nodes: [], edges: [], width: 0, height: 0, dir: o.flow,
               stats: { nodes: 0, edges: 0, stress: 0, crossings: 0, overlaps: 0,
                        diameter: 0, epochs: 0, width: 0, height: 0, ar: 0, ms: 0 } };
    }

    var idx = {}, i;
    for (i = 0; i < n; i++) idx[nodes[i].id] = i;
    var adj = [];
    for (i = 0; i < n; i++) adj.push([]);
    var selfLoops = {};
    edges.forEach(function (e) {
      var a = idx[e.from], b = idx[e.to];
      if (a === undefined || b === undefined) return;
      if (a === b) { selfLoops[e.id] = true; return; }
      adj[a].push(b); adj[b].push(a);
    });

    var d = allPairs(n, adj);
    var comp = bridgeComponents(d, n);
    // scale hop distance into pixels up front so every later stage works in one unit.
    // Stress is unaffected: w_ij = d_ij^-2 cancels the squared residual exactly.
    for (i = 0; i < n * n; i++) d[i] *= o.edgeLength;

    /* Rüegg et al. run the layout three times, adding constraints as they go: untangle
       first, then add flow while overlaps are still allowed so nodes can float past
       each other and swap, and only then separate the boxes.  Applying non-overlap
       any earlier freezes whatever ordering the first pass happened to land on. */
    var res;
    if (o.optimiser === 'majorization') {
      res = majorize(d, n, { epochs: o.epochs, seed: o.seed });
    } else if (o.optimiser === 'fr') {
      res = fruchtermanReingold(n, adj, { epochs: Math.max(40, o.epochs * 10), seed: o.seed, ideal: o.edgeLength });
    } else if (o.optimiser === 'snap') {
      var elist = [];
      edges.forEach(function (e) {
        var a = idx[e.from], b = idx[e.to];
        if (a !== undefined && b !== undefined && a !== b) elist.push([a, b]);
      });
      res = snapTFDP(n, elist, { epochs: Math.max(20, o.epochs * 2), seed: o.seed, ideal: o.edgeLength });
    } else {
      res = run(d, n, { epochs: o.epochs, epsilon: o.epsilon, seed: o.seed });
    }
    var trace = res.trace.slice();
    for (i = 0; i < n; i++) { nodes[i].x = res.X[2 * i]; nodes[i].y = res.X[2 * i + 1]; }

    /* Two constraint sets, and satisfying one can break the other: pushing boxes
       apart moves a node back across the ordering that flow just imposed.  Alternate
       the projections until neither has anything left to do.  This is the usual
       alternating-projection fix, and on these graphs it settles in a couple of
       rounds. */
    var wantFlow = (o.flow === 'TB' || o.flow === 'LR');
    var flowAxis = o.flow === 'TB' ? 'y' : 'x';
    var flowInfo = null, overlapInfo = null;

    if (wantFlow) {
      // stage two: flow settles while boxes may still overlap.  Each round projects
      // onto the ordering, then lets a damped run of the optimiser pull the drawing
      // back toward low stress, which is what lets a node slide past its neighbour.
      var relax = [];
      for (i = 0; i < 4; i++) relax.push(o.edgeLength * o.edgeLength * Math.pow(0.35, i + 1));
      for (var r = 0; r < 3; r++) {
        flowInfo = enforceFlow(nodes, edges, { axis: flowAxis, gap: o.flowGap }, host);
        var cur = new Float64Array(2 * n);
        for (i = 0; i < n; i++) { cur[2 * i] = nodes[i].x; cur[2 * i + 1] = nodes[i].y; }
        var refine = (o.optimiser === 'majorization')
          ? majorize(d, n, { init: cur, epochs: 2, seed: o.seed + 101 + r })
          : (o.optimiser === 'sgd'
              ? run(d, n, { init: cur, etas: relax, seed: o.seed + 101 + r })
              : { X: cur, trace: [] });   // fr and snap have no constrained resume
        for (i = 0; i < n; i++) { nodes[i].x = refine.X[2 * i]; nodes[i].y = refine.X[2 * i + 1]; }
        trace = trace.concat(refine.trace.map(function (t, k) {
          return { epoch: trace.length + k, eta: t.eta, stress: t.stress };
        }));
      }
      flowInfo = enforceFlow(nodes, edges, { axis: flowAxis, gap: o.flowGap }, host);
      if (o.align) alignEdges(nodes, edges, { axis: flowAxis, tol: o.alignTol }, host);
    }

    /* Stage three: separate the boxes.  The two projections can undo one another, so
       alternate, and always finish on non-overlap the way the paper orders it: boxes
       sitting on top of each other read far worse than an edge that leans the wrong
       way, and any edge still leaning is counted honestly below. */
    var rounds = (wantFlow && o.removeOverlaps) ? 6 : 1;
    for (var pass = 0; pass < rounds; pass++) {
      if (wantFlow && pass > 0) flowInfo = enforceFlow(nodes, edges, { axis: flowAxis, gap: o.flowGap }, host);
      overlapInfo = o.removeOverlaps
        ? removeOverlaps(nodes, { pad: o.overlapPad })
        : { passes: 0, overlapsLeft: countOverlaps(nodes, 0), travel: 0 };
      if (!wantFlow || overlapInfo.travel < 0.5) break;
    }
    // count violations against the final positions, not against a mid-pipeline snapshot
    var backward = null;
    if (wantFlow) {
      var pos = {};
      nodes.forEach(function (nd) { pos[nd.id] = nd; });
      backward = 0;
      edges.forEach(function (e) {
        if (e.from === e.to) return;
        var a = pos[e.from], b = pos[e.to];
        if (a && b && b[flowAxis] <= a[flowAxis] + 0.5) backward++;
      });
    }

    var byId = {};
    nodes.forEach(function (nd) { byId[nd.id] = nd; });

    var outEdges = edges.map(function (e) {
      var a = byId[e.from], b = byId[e.to];
      var out = { id: e.id, from: e.from, to: e.to, label: e.label, style: e.style,
                  arrow: e.arrow, selfLoop: !!selfLoops[e.id], points: [], labelPos: null, path: '' };
      if (!a || !b) return out;
      if (out.selfLoop) {
        var r = Math.max(18, a.h * 0.42), cx = a.x + a.w / 2, cy = a.y;
        out.path = 'M' + f(cx) + ' ' + f(cy - r * 0.4) +
                   'C' + f(cx + r * 1.7) + ' ' + f(cy - r * 1.2) + ' ' +
                         f(cx + r * 1.7) + ' ' + f(cy + r * 1.2) + ' ' +
                         f(cx) + ' ' + f(cy + r * 0.4);
        return out;
      }
      var p0 = host.clipToShape(a, { x: b.x, y: b.y });
      var p1 = host.clipToShape(b, { x: a.x, y: a.y });
      out.points = [{ x: p0.x, y: p0.y }, { x: p1.x, y: p1.y }];
      out.path = 'M' + f(p0.x) + ' ' + f(p0.y) + 'L' + f(p1.x) + ' ' + f(p1.y);
      if (e.label) out.labelPos = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
      return out;
    });

    var segs = outEdges.filter(function (e) { return !e.selfLoop && e.points.length === 2; })
      .map(function (e) {
        return { from: e.from, to: e.to,
                 x1: e.points[0].x, y1: e.points[0].y, x2: e.points[1].x, y2: e.points[1].y };
      });
    var crossings = countCrossings(segs);

    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach(function (nd) {
      minX = Math.min(minX, nd.x - nd.w / 2); maxX = Math.max(maxX, nd.x + nd.w / 2);
      minY = Math.min(minY, nd.y - nd.h / 2); maxY = Math.max(maxY, nd.y + nd.h / 2);
    });
    var pad = 24;
    nodes.forEach(function (nd) { nd.x = nd.x - minX + pad; nd.y = nd.y - minY + pad; });
    outEdges.forEach(function (e) {
      e.points.forEach(function (pt) { pt.x = pt.x - minX + pad; pt.y = pt.y - minY + pad; });
      if (e.labelPos) { e.labelPos.x = e.labelPos.x - minX + pad; e.labelPos.y = e.labelPos.y - minY + pad; }
      if (e.points.length === 2) {
        e.path = 'M' + f(e.points[0].x) + ' ' + f(e.points[0].y) +
                 'L' + f(e.points[1].x) + ' ' + f(e.points[1].y);
      } else if (e.selfLoop) {
        var a = byId[e.from];
        var r = Math.max(18, a.h * 0.42), cx = a.x + a.w / 2, cy = a.y;
        e.path = 'M' + f(cx) + ' ' + f(cy - r * 0.4) +
                 'C' + f(cx + r * 1.7) + ' ' + f(cy - r * 1.2) + ' ' +
                       f(cx + r * 1.7) + ' ' + f(cy + r * 1.2) + ' ' +
                       f(cx) + ' ' + f(cy + r * 0.4);
      }
    });

    var W = maxX - minX + pad * 2, H = maxY - minY + pad * 2;
    // report the stress of what is actually drawn, after every constraint pass
    var finalX = new Float64Array(2 * n);
    for (i = 0; i < n; i++) { finalX[2 * i] = nodes[i].x; finalX[2 * i + 1] = nodes[i].y; }
    var stressNow = stress(finalX, d, n);
    var t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    return {
      nodes: nodes.map(function (nd) {
        return { id: nd.id, label: nd.label, lines: nd.lines, shape: nd.shape,
                 x: nd.x, y: nd.y, w: nd.w, h: nd.h, textDy: nd.textDy || 0,
                 layer: 0, chunk: 0 };
      }),
      edges: outEdges,
      width: Math.round(W), height: Math.round(H), dir: o.flow,
      trace: trace,
      stats: {
        nodes: n, edges: outEdges.length,
        stress: +stressNow.toFixed(2),
        crossings: crossings,
        overlaps: countOverlaps(nodes, 0),
        diameter: comp.diameter,
        epochs: o.epochs,
        optimiser: o.optimiser,
        backward: backward,
        width: Math.round(W), height: Math.round(H),
        ar: +(W / Math.max(1, H)).toFixed(2),
        ms: +(t1 - t0).toFixed(1)
      }
    };
  }

  function f(v) { return Math.round(v * 100) / 100; }

  return {
    _rng: rng, allPairs: allPairs, bridgeComponents: bridgeComponents,
    stress: stress, schedule: schedule, run: run,
    removeOverlaps: removeOverlaps, countOverlaps: countOverlaps,
    enforceFlow: enforceFlow, alignEdges: alignEdges, countCrossings: countCrossings,
    layout: layout, DEFAULTS: DEFAULTS,
    majorize: majorize, fruchtermanReingold: fruchtermanReingold, snapTFDP: snapTFDP
  };
});
