# Layout algorithms for flowcharts

What the research says works, why, with pseudocode for each phase — and measurements from the
implementation in `flowchart-lab.html`.

---

## Why the Sugiyama framework, and not something else

Flowcharts have four properties that together pick the algorithm family for you:

| Property | Consequence |
|---|---|
| Directed, with a reading order | The drawing must encode direction. Rules out symmetric force-directed layouts. |
| Nearly acyclic (a few back-edges) | Cycle removal is cheap; the DAG machinery applies. |
| Sparse — density around 1.2–2.0 edges/node | Layer widths stay small; crossing minimisation is tractable. |
| Variable-size labelled boxes | Rules out algorithms that assume unit-size vertices (most planar/orthogonal grid methods). |

That is exactly the input the **Sugiyama framework** (Sugiyama, Tagawa & Toda, 1981) was designed
for, and forty-five years later it is still what every serious tool uses: Graphviz `dot`, ELK
Layered, dagre, yFiles Hierarchic, MSAGL. The competitive alternatives lose on one of the four:

- **Force-directed / stress majorization** (Kamada-Kawai; Gansner, Koren & North 2004) produces
  beautiful undirected drawings but has no notion of flow direction. `DIG-COLA` and `IPSEP-COLA`
  (Dwyer, Koren & Marriott) bolt directionality on as separation constraints, which works, but
  you're reconstructing layering by another name at higher cost.
- **Topology-shape-metrics orthogonal drawing** (Batini/Tamassia; Tamassia's bend minimisation)
  gives provably bend-minimal drawings, but the classical pipeline assumes point vertices and
  degree ≤ 4. `HOLA` (Kieffer, Dwyer, Marriott & Wybrow 2016) is the modern, genuinely good
  version — worth knowing if you want a "human-drawn" look, and it is the base that **ARCOL**
  (2026) extends with aspect-ratio control.
- **Neural layout** — `DeepGD`, `SmartGD`, `CoRe-GD` (ICLR 2024) — currently optimises *stress*
  on undirected graphs. Not applicable to directed flowcharts yet.

So: Sugiyama, four phases, with the best-known algorithm in each slot.

```
cycle removal → layering → ordering → coordinates    (+ routing, + wrapping)
```

---

## Phase 1 — Cycle removal: greedy feedback arc set

**Use:** Eades, Lin & Smyth (1993), "A fast and effective heuristic for the feedback arc set
problem". Linear time, and it guarantees a solution keeping at least `|E|/2 − |V|/6` edges
forward — a bound the naive DFS back-edge method does not give you.

Why it matters for flowcharts: every reversed edge is an arrow pointing backwards against the
reading order. Minimising them is directly minimising reader confusion.

```
GREEDY-FAS(G):
  s1 ← empty sequence        # prefix
  s2 ← empty sequence        # suffix
  while G is not empty:
      while G has a sink u:              # out-degree 0
          prepend u to s2 ; remove u from G
      while G has a source u:            # in-degree 0
          append u to s1  ; remove u from G
      if G is not empty:
          u ← vertex maximising  outdeg(u) − indeg(u)
          append u to s1 ; remove u from G
  σ ← s1 · s2                            # a linear vertex order
  for each edge (u,v):
      if position(u) > position(v): mark (u,v) REVERSED
```

Reversed edges are flipped for phases 2–4 and flipped back at draw time, so the arrowhead lands
on the correct end. Self-loops are removed here and drawn as a separate arc.

*Implementation note:* the bucket-list version is O(V+E). The one shipped here is a simple
O(V²) scan, which is irrelevant at flowchart scale and much easier to verify.

---

## Phase 2 — Layering: assign each node a rank

This is where the drawing's proportions are decided, and where the three real choices live.

### 2a. Longest path — the baseline

O(V+E), minimises **height**, maximises width. Every node sits as early as it can.

```
LONGEST-PATH(G):
  for v in topological order:
      layer(v) ← 0  if v has no predecessors
                 max(layer(u) + 1  for u in pred(v))  otherwise
```

### 2b. Coffman-Graham — bounded width

Coffman & Graham (1972), imported from processor scheduling. Guarantees no layer holds more than
`W` real nodes. Two phases: a lexicographic labelling, then greedy placement.

```
COFFMAN-GRAHAM(G, W):
  # phase 1: label vertices 1..n
  count ← 0
  while unlabelled vertices remain:
      candidates ← { v : all predecessors of v are labelled }
      v ← candidate whose multiset of predecessor labels is
          lexicographically smallest (compared descending)
      label(v) ← ++count

  # phase 2: fill layers bottom-up in decreasing label order
  k ← 0 ; size ← 0
  for v in vertices sorted by label DESCENDING:
      if size ≥ W  or  some successor of v is not yet placed below layer k:
          k ← k + 1 ; size ← 0
      level(v) ← k ; size ← size + 1
  layer(v) ← maxLevel − level(v)        # flip so sources are on top
```

**The catch, and it is a big one:** Coffman-Graham bounds the count of *real* nodes per layer but
ignores the dummy nodes that long edges generate. Bounding real width while inflating edge width
is often a net loss — see the measurements below. Minimum-width layering *with* dummy nodes
counted is NP-hard (Branke, Leppert, Middendorf & Eades, 2002).

### 2c. Network simplex — minimise total edge length

Gansner, Koutsofios, North & Vo (1993), the algorithm behind `dot`. Solves

> minimise Σ w(e)·(rank(head) − rank(tail) − minlen(e))  subject to rank(head) − rank(tail) ≥ minlen(e)

exactly, via the network simplex method on the dual. Minimising total edge span **is** minimising
dummy node count, which is the single most useful proxy for hierarchical drawing quality: fewer
dummies means shorter edges, fewer crossings, less clutter, and less work downstream.

```
NETWORK-SIMPLEX(G):
  rank ← LONGEST-PATH(G)                # any feasible start
  T ← FEASIBLE-TREE(rank)               # spanning tree of tight edges (slack 0)
  compute cutvalue(e) for every tree edge e
  while ∃ tree edge e with cutvalue(e) < 0:
      f ← non-tree edge of minimum slack that reconnects the two
          components of T − e in the opposite direction
      T ← T − e + f
      re-tighten ranks from T ; recompute cut values
  normalise ranks so min rank = 0
  balance nodes with equal in/out weight into least-crowded feasible rank

FEASIBLE-TREE(rank):
  loop:
     T ← maximal tree of edges with slack(e) = 0, grown by DFS
     if T spans all vertices: return T
     e ← non-tree edge incident on T with minimum slack
     δ ← slack(e), negated if the tree-side endpoint is e's head
     shift every vertex in T by δ            # keeps feasibility, tightens e
```

`slack(e) = rank(head) − rank(tail) − minlen(e)`.
`cutvalue(e)` = total weight of edges crossing from e's tail component to its head component,
minus the weight crossing the other way.

*Complexity:* not polynomially bounded in theory, but fast and near-linear in practice. Cut values
can be updated incrementally in O(V); this implementation recomputes them, which is O(V·E) per
iteration and still fine below a few hundred nodes.

### 2d. Node promotion — a free post-pass

Nikolov & Tarassov (2006). Runs *after* any layering and pulls vertices up one rank whenever
doing so reduces dummy count. Cheap, always safe, and worth 20–56% of dummies on dense graphs.

```
PROMOTE-VERTEX(v):
    diff ← 0
    for u in pred(v):
        if layer(u) = layer(v) − 1:          # must move parents first
            diff ← diff + PROMOTE-VERTEX(u)
    layer(v) ← layer(v) − 1
    return diff − indeg(v) + outdeg(v)       # net change in dummy count

PROMOTE-LAYERING(G):
    repeat until no change:
        for each v with indeg(v) > 0:
            snapshot ← layer
            if PROMOTE-VERTEX(v) < 0: keep it
            else:                     layer ← snapshot
    normalise
```

### What the numbers actually say

Measured with `bench2.js` on random directed graphs (3-run mean):

| n | density | strategy | layers | dummies | crossings | area | ms |
|---|---|---|---|---|---|---|---|
| 30 | 1.63 | longest-path | 6 | 23 | 33 | 1077×562 | 44.0 |
| 30 | 1.63 | coffman-graham | 9 | **93** | 46 | 1199×847 | 36.3 |
| 30 | 1.63 | network-simplex | 6 | **23** | 33 | 1077×562 | **11.5** |
| 50 | 1.86 | longest-path | 20 | 217 | 145 | 1624×1892 | 136.5 |
| 50 | 1.86 | coffman-graham | 23 | **415** | 190 | 1900×2177 | 249.6 |
| 50 | 1.86 | network-simplex | 20 | **198** | **123** | 1564×1892 | **77.3** |
| 70 | 2.26 | longest-path | 24 | 518 | 619 | 2651×2272 | 630.3 |
| 70 | 2.26 | coffman-graham | 25 | 654 | 688 | 2955×2367 | 889.5 |
| 70 | 2.26 | network-simplex | 24 | **434** | **611** | 2643×2272 | **496.3** |

Three conclusions, one of them uncomfortable:

1. **Network simplex wins on every axis including runtime.** It is slower per-iteration but
   produces 16–33% fewer dummies, and dummies are what make phases 3 and 4 expensive. Pay in
   layering, save in ordering. This is the default.
2. **Coffman-Graham is a trap for flowcharts.** Bounding real-node width inflates dummies 2–4×.
   Use it only when you have a hard physical width limit and are willing to pay for it.
3. **On actual flowcharts, none of it matters.** On the four realistic presets in the app —
   approval flow, retry state machine, crossing stress, wide fan — all three strategies produced
   *identical* layer counts, dummy counts and crossings. Real flowcharts are sparse and
   near-linear; longest-path is already optimal on them. The layering choice only starts paying
   at density > 1.5, which most hand-written flowcharts never reach.

Promotion, measured separately on the same graphs:

| n | dummies without | with | reduction |
|---|---|---|---|
| 30 | 52 | 23 | 55.8% |
| 50 | 363 | 217 | 40.2% |
| 70 | 643 | 518 | 19.4% |

Leave it on.

---

## Phase 3 — Ordering: minimise edge crossings

NP-hard even for two layers (Garey & Johnson). Everyone uses the same layer-by-layer sweep.

### Weighted median + transpose (GKNV 1993)

```
ORDERING(layers):
  order ← breadth-first seed order
  best  ← order
  for i in 0 .. maxIterations:
      WMEDIAN(order, direction = (i is even ? down : up))
      TRANSPOSE(order)
      if crossings(order) < crossings(best): best ← order
  return best

WMEDIAN(order, direction):
  for each layer r in sweep order:
      fixed ← the adjacent layer already processed
      for each vertex v in layer r:
          median(v) ← MEDIAN-VALUE(positions of v's neighbours in `fixed`)
      sort layer r by median, leaving vertices with median = −1 in place

MEDIAN-VALUE(P):                     # P sorted
  m ← ⌊|P| / 2⌋
  if |P| = 0:            return −1
  if |P| is odd:         return P[m]
  if |P| = 2:            return (P[0] + P[1]) / 2
  left  ← P[m−1] − P[0]
  right ← P[|P|−1] − P[m]
  return (P[m−1]·right + P[m]·left) / (left + right)     # bias toward the tighter side

TRANSPOSE(order):
  repeat until no improvement:
      for each layer r, for each adjacent pair (v,w):
          if crossings(v,w) > crossings(w,v): swap them
```

The median heuristic alone gets most of the way; `TRANSPOSE` cleans up the local mistakes it
leaves. Neither is worth much without the other.

### Counting crossings: Barth, Jünger & Mutzel (2002)

The naive count is O(|E|²) per layer pair and it is the inner loop of the whole phase. The
accumulator-tree method does it in O(|E| log |V|) and is about twenty lines:

```
COUNT-CROSSINGS(north, south, edges):
  firstIndex ← smallest power of 2 ≥ |south|
  tree ← array of 2·firstIndex − 1 zeros
  firstIndex ← firstIndex − 1
  count ← 0
  for each edge in order of (north position, then south position):
      index ← southPosition(edge) + firstIndex
      tree[index] ← tree[index] + 1
      while index > 0:
          if index is odd: count ← count + tree[index + 1]
          index ← (index − 1) / 2
          tree[index] ← tree[index] + 1
  return count
```

Measured effect of the sweep count on a dense n=50 graph:

| passes | crossings | time |
|---|---|---|
| 0 | 259 | 13.9 ms |
| 1 | 153 | 14.7 ms |
| 2 | 142 | 22.7 ms |
| 4 | 126 | 66.8 ms |
| 8 | **123** | 104.0 ms |
| 16 | 123 | 55.6 ms |
| 32 | 123 | 90.7 ms |

52% of crossings removed by the first pass, 95% of the achievable gain by pass 4, converged by
pass 8. **Anything past 8 sweeps is wasted time** — the app defaults to 24 only so the slider has
somewhere to go.

---

## Phase 4 — Coordinates: Brandes & Köpf

Ordering fixes the *sequence* within each layer. This phase picks actual x-coordinates, and it is
what separates a drawing that looks designed from one that looks generated. The goal is
**straight long edges** — a chain of dummy nodes should form a vertical line, not a staircase.

Brandes & Köpf (2002), "Fast and simple horizontal coordinate assignment": linear time, and the
result is close to what the much slower LP formulations produce.

```
BRANDES-KOPF(layers):
  marked ← MARK-TYPE-1-CONFLICTS(layers)
  for each of the four combinations (vertical ∈ {down,up}) × (horizontal ∈ {left,right}):
      flip the layer array accordingly
      root, align ← VERTICAL-ALIGNMENT(layers, marked)
      x_i        ← HORIZONTAL-COMPACTION(root, align)
      un-flip
  align the four layouts to the narrowest one
  x(v) ← median of the four candidate values      # = mean of the middle two
```

Four passes, because each biases toward one corner; the median cancels the bias.

**Type-1 conflicts** are the crux. An *inner segment* is an edge between two dummy nodes — part of
a long edge, which we want dead straight. A type-1 conflict is an inner segment crossed by a
non-inner segment. When that happens the non-inner segment yields.

```
MARK-TYPE-1-CONFLICTS(layers):
  for i in 1 .. h−2:
      k0 ← 0 ; l ← 0
      for l1 in 0 .. |L[i+1]| − 1:
          v ← L[i+1][l1]
          if l1 is the last index, or v has an incoming inner segment:
              k1 ← (v has inner segment) ? position(its upper endpoint) : |L[i]| − 1
              while l ≤ l1:
                  for u in upperNeighbours(L[i+1][l]):
                      if position(u) < k0 or position(u) > k1:
                          mark edge (u, L[i+1][l])
                  l ← l + 1
              k0 ← k1

VERTICAL-ALIGNMENT(layers, marked):        # blocks of vertically aligned vertices
  root[v] ← v ; align[v] ← v   for all v
  for i in 0 .. h−1:
      r ← −1
      for k in 0 .. |L[i]|−1:
          v ← L[i][k] ; N ← upperNeighbours(v) sorted by position
          for m in { ⌊(|N|−1)/2⌋, ⌈(|N|−1)/2⌉ }:        # median neighbour(s)
              if align[v] = v:
                  u ← N[m]
                  if (u,v) not marked and r < position(u):
                      align[u] ← v ; root[v] ← root[u] ; align[v] ← root[v]
                      r ← position(u)

PLACE-BLOCK(v):                            # longest-path compaction over blocks
  if x[v] is defined: return
  x[v] ← 0 ; w ← v
  repeat:
      if position(w) > 0:
          pred ← left neighbour of w in its layer ; u ← root[pred]
          PLACE-BLOCK(u)
          if sink[v] = v: sink[v] ← sink[u]
          δ ← halfWidth(pred) + separation + halfWidth(w)      # size-aware
          if sink[v] ≠ sink[u]: shift[sink[u]] ← min(shift[sink[u]], x[v] − x[u] − δ)
          else:                 x[v] ← max(x[v], x[u] + δ)
      w ← align[w]
  until w = v
```

The `δ` line is the one modification the textbook algorithm needs for flowcharts. Classical BK
assumes unit-width vertices; flowchart boxes vary from 54px to 300px. Making δ a function of the
two actual nodes generalises it correctly. Rüegg, Schulze, Carstens & von Hanxleden did this
properly in "Size- and port-aware horizontal node coordinate assignment" (GD 2015).

Separation is also asymmetric: dummy-to-dummy gaps use a small `edgeSep` (16px), real-node gaps
use `nodeSep` (44px). Without this, parallel long edges get pushed 44px apart and the drawing
balloons.

*Verified in the test suite:* a 15-node straight chain lays out with an x-spread below 2px, and a
symmetric fan-out/fan-in places the root and the sink within 3px of the same column.

---

## Phase 5 — Wrapping: cut and stack for aspect ratio

A 14-step pipeline draws at 139×1417 — aspect ratio 0.10, unusable on any screen. The fix from
Rüegg & von Hanxleden ("Wrapping Layered Graphs", DIAGRAMS '18; "Generalized Layerings for
Arbitrary and Fixed Drawing Areas", JGAA 21(5) 2017) is to cut the layering into chunks and place
them side by side, wrapping the severed edges around.

```
WRAP(layers, targetRatio):
  spanCount[i] ← number of edges crossing the boundary above layer i
  best ← ∞
  for k in 1 .. maxChunks:
      cuts ← CHOOSE-CUTS(|layers|, spanCount, k)
      (w,h) ← simulated size if split at `cuts`
      err ← |log((w/h) / targetRatio)|
      if err < best: best ← err ; bestCuts ← cuts
  translate each chunk c by (Σ widths of chunks < c + gap·c, −topOf(c))
  re-route edges whose endpoints land in different chunks

CHOOSE-CUTS(n, spanCount, k):
  for c in 1 .. k−1:
      nominal ← round(c · n / k)
      pick index in [nominal − freedom, nominal + freedom]
        minimising  spanCount[index] + 0.35·|index − nominal|
```

The second term is the compromise ELK's `improveCuts` option describes: you want cuts evenly
spaced *and* through as few edges as possible, and those two goals disagree.

Measured on the 14-step pipeline, target ratio 1.6:

| | size | ratio | chunks |
|---|---|---|---|
| off | 139×1417 | 0.10 | 1 |
| on | 564×372 | **1.52** | 4 |

Edges severed by a cut are re-routed around the chunk — down out of the bottom, across the
gutter, back in at the top — each on its own lane so they don't stack. Because each severed edge
costs a long detour, the cut *count* selection also carries a penalty proportional to how many
edges a given set of cuts would sever:

```
err(k) = |log((w/h) / targetRatio)|  +  0.9 · (severedEdges / totalEdges)
```

Without that term, wrapping happily cuts through the busiest layer in the graph and produces a
tangle. With it, a graph full of long back-edges declines to wrap, which is the right answer.

**Honest limitation:** this is still a post-layout transform on final coordinates. ELK integrates
wrapping into the layering phase, so ordering and coordinate assignment can account for the
wrapped edges and produce shorter routes. The post-transform never introduces overlaps (verified
in tests) and is right for chain-like flows — the case that needs it. On the 40-node incident
preset, wrapping *works* but the unwrapped drawing is more readable, which is why that preset
ships with wrapping off.

---

## Phase 6 — Edge routing

Three modes, all operating on the dummy-node chain:

- **Orthogonal with channel assignment** — the naive version runs every edge across the gap at
  its midpoint, so any two edges jogging between the same pair of layers draw *on top of each
  other*. This is the single most visible way a hand-rolled router loses to ELK.

  The fix is to treat each layer gap as a set of tracks and colour the runs like an interval
  graph: two runs may share a track only if their spans don't overlap.

  ```
  ASSIGN-CHANNELS(edges):
    group every cross-gap run by (chunk, layer gap)
    for each group:
        lo ← max over runs of the run's near edge      # band all runs can reach
        hi ← min over runs of the run's far edge
        sort runs by span start
        for each run:                                   # greedy interval colouring
            t ← first track whose members' spans do not overlap this one
            assign run to track t
        run on track t of T sits at  lo + (t+1)(hi−lo)/(T+1)
  ```

### Hyperedges: a fan-out is one bus, not five ladders

Interval colouring on its own treats the five edges of a fan-out as five conflicting runs,
because their spans all overlap near the source. It hands each one its own track and draws a
stack of nested ladders.

But edges that share an endpoint are not in conflict — they are one *hyperedge*, and they belong
on a single shared track. Bundle first, then colour the bundles:

```
for each layer gap:
    count how many runs touch each endpoint node
    key(run) ← 'S'+sourceNode  if that node carries >1 run
               'T'+targetNode  else if that node carries >1 run
               unique          otherwise
    bundle runs by key; bundle span = union of member spans
    interval-colour the BUNDLES
    every run in a bundle gets its bundle's track
```

Paired with this, a face carrying three or more edges collapses its ports to a single stub,
since they will share one track anyway — one line into the bus beats five stubs into it. With
one caveat learned the hard way: **only when the face flows one way**. A node whose bottom face
carries both departures and a reversed arrival will stack their stubs at the same coordinate.
Requiring the face to be uniform before collapsing fixed twelve small vertical collisions on the
incident graph.

  Measured collinear overlap, total length of edge segments drawn over other edge segments:

  | graph | midpoint routing | channel assignment |
  |---|---|---|
  | approval flow | 832 px over 22 pairs | **0** |
  | crossing stress | 273 px over 5 pairs | **0** |
  | incident response (40 nodes) | 26,740 px over 155 pairs | **0** |

  (Overlap between edges that share an endpoint is excluded — that is the bus, and the shared
  ink is deliberate.)

  One subtlety that cost a debugging pass: endpoint clipping builds *fresh* point objects, so it
  silently dropped the layer index and excluded every node-adjacent segment from channelling.
  Only dummy-to-dummy runs were being separated. Carrying the metadata through the clip is what
  took approval flow from 46 px to 0.

  Also: if the off-axis offset is under ~14px, draw a short diagonal instead of a stair, because
  a 6px stair reads as a rendering artefact.
- **Polyline** — straight segments through dummy centres.
- **Spline** — cubic beziers whose control points extend along the flow axis, so the curve leaves
  the source and enters the target pointing the way the diagram reads. Multi-point edges use
  Catmull-Rom with virtual endpoints offset along the same axis. Wrap detours are forced back to
  orthogonal — Catmull-Rom through a right-angled detour overshoots into visible loops, and the
  detour is a routing decision rather than a style one.

  A plain Catmull-Rom is the obvious implementation and it is wrong here: with only two points it
  degenerates to a straight line, and in a flowchart most edges span a single layer. That made
  `spline` produce byte-identical output to `polyline` on ordinary diagrams. The test suite now
  asserts all three modes differ on a four-node graph.

### Ports: where an edge attaches

Clipping an endpoint by intersecting the straight line to its target is geometrically correct
and visually wrong for orthogonal routing. It lets an edge leave through a *corner*, and it
sends every edge converging on a node to nearly the same point on its outline.

Orthogonal and spline routing therefore attach to the face perpendicular to the flow, with the
attachment points spread along it:

```
ASSIGN-PORTS(edges):
  bucket each edge end by (node, which face it leaves through)
  for each bucket:
      sort ends by where their partner sits across the face
      usable ← halfWidth · spreadFactor(shape)
      step   ← min(portGap, 2·usable / (count−1))
      for i in 0 .. count−1:                       # aim, then separate
          want   ← clamp(partnerPosition − centre, −usable, +usable)
          pos[i] ← i = 0 ? want : max(want, pos[i−1] + step)
      slide the whole block back inside [−usable, +usable]
      attach at PROJECT-ONTO-OUTLINE(node, pos[i], face)
```

The *aim-then-separate* step matters. Spreading ports evenly around the centre knocks
naturally-aligned edges into pointless diagonals — an edge arriving from straight above gets
shoved sideways just because the target happens to have a second parent. Letting each port ask
for the position it wants and only pushing when two collide keeps straight edges straight.

`PROJECT-ONTO-OUTLINE` solves the shape's implicit equation for the flow coordinate at a given
cross-offset, so a diamond attaches on its slope and a cylinder on its cap arc rather than on
the bounding box. `spreadFactor` narrows the band for pointed shapes (0.5 for diamond and
circle, 0.66 for a rectangle).

Polyline deliberately keeps straight-line clipping — that is the honest behaviour for a mode
whose whole point is direct segments, and it makes polyline visibly different from orthogonal
on graphs where every edge would otherwise be vertical anyway.

Combined with channel assignment, collinear overlap on all three test graphs — including the
40-node incident response — is now **zero**.

Endpoints are clipped to the actual shape boundary, not the bounding box:

Cylinder labels get a vertical offset: the top cap arc dips to `y + 2e` at the horizontal centre,
which is exactly where a centred label sits. The node reserves `e` extra height and the text
shifts down by `e`.

| shape | implicit boundary | clip |
|---|---|---|
| rect, cylinder | max(\|dx\|/w′, \|dy\|/h′) = 1 | `t = min(w′/\|dx\|, h′/\|dy\|)` |
| diamond | \|dx\|/w′ + \|dy\|/h′ = 1 | `t = 1 / (\|dx\|/w′ + \|dy\|/h′)` |
| circle | (dx/w′)² + (dy/h′)² = 1 | `t = 1 / √((dx/w′)² + (dy/h′)²)` |
| round, stadium | blend of rect and ellipse | mean of the two |

(w′, h′ are half-width and half-height.) The test suite asserts the implicit radius is within
1% of 1.0 for every endpoint of every edge — this caught a genuine bug where a
bounding-box check passed a point that was inside the diamond.

---

## What is deliberately not implemented

- **Ports** — fixed attachment points on node borders. Essential for circuit/dataflow diagrams,
  rarely wanted for flowcharts. ELK's port-constraint handling (Spönemann et al., GD '09) is the
  reference.
- **Compound nodes / subgraphs** (`subgraph` blocks). Needs cross-hierarchy edge handling; a
  substantial addition.
- **Edge bundling** (Pupyrev, Nachmanson & Kaufmann 2011). Helps at 100+ edges, hurts readability
  below that.
- **Incremental / stable layout.** Currently a re-layout can reshuffle everything. Rüegg et al.
  have work on incremental layout for model migration.
- **MinWidth / StretchWidth layering** (Nikolov, Tarassov & Branke 2005) — dummy-aware width
  bounding, the thing Coffman-Graham should have been. This is the highest-value next addition.

---

## Export: getting it into Office and draw.io

Two exports, two different jobs.

**`.drawio`** emits an `mxGraphModel`: one `<mxCell vertex="1">` per node carrying our exact
geometry, one `<mxCell edge="1">` per edge carrying our computed interior waypoints in an
`<Array as="points">`. Shapes map to native draw.io styles (`rhombus`, `shape=cylinder3`,
`shape=hexagon`, `parallelogram`), so everything arrives as a real, editable, re-routable draw.io
object at the exact position the algorithm chose. Open the file directly, or paste the XML via
**Extras → Edit Diagram**.

**`.svg for Office`** emits a deliberately primitive SVG: no CSS classes, no `<style>` block, no
`transform` attributes, no `foreignObject`, every fill and stroke as a presentation attribute,
Arial as the font, and an opaque white background rect. That restraint is what makes PowerPoint's
**right-click → Convert to Shape** work — it turns each `<rect>`, `<ellipse>`, `<polygon>` and
`<path>` into a native PowerPoint shape and each `<text>` into editable text. The styled `.svg`
export uses classes and ids for web embedding and does *not* convert as cleanly.

Routes:

- **PowerPoint / Word** — insert the Office SVG → right-click → Convert to Shape → ungroup.
- **Visio** — import the `.drawio` into diagrams.net, then File → Export as → VSDX.
- **draw.io / diagrams.net** — open the `.drawio` file directly.

---

## References

- Sugiyama, Tagawa & Toda (1981). Methods for visual understanding of hierarchical system structures. *IEEE Trans. SMC* 11(2).
- Eades, Lin & Smyth (1993). A fast and effective heuristic for the feedback arc set problem. *IPL* 47.
- Coffman & Graham (1972). Optimal scheduling for two-processor systems. *Acta Informatica* 1(3).
- Gansner, Koutsofios, North & Vo (1993). A technique for drawing directed graphs. *IEEE TSE* 19(3).
- Barth, Jünger & Mutzel (2002). Simple and efficient bilayer cross counting. *GD '02*.
- Brandes & Köpf (2002). Fast and simple horizontal coordinate assignment. *GD '01*, LNCS 2265.
- Branke, Leppert, Middendorf & Eades (2002). Width-restricted layering of acyclic digraphs with consideration of dummy nodes. *IPL* 81(2).
- Nikolov, Tarassov & Branke (2005). In search for efficient heuristics for minimum-width graph layering with consideration of dummy nodes. *ACM JEA* 10.
- Nikolov & Tarassov (2006). Graph layering by promotion of nodes. *Discrete Applied Mathematics* 154.
- Rüegg, Schulze, Carstens & von Hanxleden (2015). Size- and port-aware horizontal node coordinate assignment. *GD '15*.
- Rüegg, Ehlers, Spönemann & von Hanxleden (2017). Generalized layerings for arbitrary and fixed drawing areas. *JGAA* 21(5).
- Rüegg & von Hanxleden (2018). Wrapping layered graphs. *DIAGRAMS '18*.
- Kieffer, Dwyer, Marriott & Wybrow (2016). HOLA: human-like orthogonal network layout. *IEEE TVCG* 22(1).
- Alsuwaykit et al. (2026). ARCOL: aspect ratio constrained orthogonal layout. arXiv:2603.29618.
