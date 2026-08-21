# Flowchart Lab

Two layout engines for the same mermaid-style source, each with its pipeline exposed as
controls, so you can see what the choices cost.

`index.html` is the Sugiyama workbench: swap the layering algorithm and watch the dummy count
move, turn crossing minimisation off and watch the picture fall apart.

`sgd.html` is the stress workbench: the same graph placed by stochastic gradient descent on a
continuous objective, with no layers at all. Its compare pane draws the Sugiyama result beside
it from the same source and the same box sizes, so the only difference is which engine placed
the nodes.

No build step, no dependencies, no server. Plain ES5 in a handful of files.

## Running it

Open `index.html` or `sgd.html`. Any static host works, including a local one:

```sh
python3 -m http.server 8000
```

For a copy you can email or drop on a shared drive, `flowchart-lab.html` and `stress-lab.html`
are the same two apps inlined into one file each, runnable from `file://`. Regenerate them
after changing anything:

```sh
node build-standalone.js
```

## The two engines

| | Sugiyama (`index.html`) | Stress (`sgd.html`) |
|---|---|---|
| Optimises | crossings, combinatorially, rank by rank | one continuous objective over all pairs at once |
| Knows about direction | yes, it is the first thing it decides | no, imposed afterwards as a constraint |
| Knows about box size | yes, first-class in x-coordinate assignment | no, imposed afterwards by pushing boxes apart |
| Needs | nothing global | all-pairs shortest paths |
| Typical shape | tall and narrow | closer to square |

## What it does

### Sugiyama

The engine implements the four classical Sugiyama phases plus routing and wrapping:

1. Cycle removal with greedy feedback arc set (Eades, Lin & Smyth 1993)
2. Layering with longest path, Coffman-Graham, or network simplex (GKNV 1993), with optional
   node promotion (Nikolov & Tarassov 2006)
3. Ordering with weighted median and transpose, scored by accumulator-tree crossing counting
   (Barth, Jünger & Mutzel 2002)
4. X coordinates with Brandes & Köpf (2002), made size-aware for variable-width boxes
5. Cut-and-stack wrapping to hit a target aspect ratio
6. Orthogonal, polyline, or spline routing, with edges attaching to faces and sharing tracks

### Stress by SGD

`sgd-engine.js` implements Algorithm 1 of Zheng, Pawar & Goodman, *Graph Drawing by
Stochastic Gradient Descent* (IEEE TVCG 2019, [arXiv:1710.04626](https://arxiv.org/pdf/1710.04626)),
with the exponential annealing schedule from their section 2.1. It minimises

```
stress(X) = sum over i<j of  w_ij * ( |Xi - Xj| - d_ij )^2 ,   w_ij = d_ij^-2
```

where `d_ij` is hop distance, so the drawing tries to make Euclidean distance match graph
distance everywhere at once. There is no solver, no eigendecomposition, and no quadtree: each
step moves exactly the two vertices of one pair.

Nothing in that model knows a node is a box or that an edge points somewhere, so both are
imposed afterwards by projecting onto the constraint set. The arrangement follows Rüegg,
Kieffer, Dwyer, Marriott & Wybrow, *Stress-Minimizing Orthogonal Layout of Data Flow Diagrams
with Ports* (GD 2014,
[PDF](https://rtsys.informatik.uni-kiel.de/~biblio/downloads/papers/gd14.pdf)), which is the
published version of this same idea:

- Flow direction is a separation constraint, `pos(u) + gap <= pos(v)` for every edge. Cycles
  make some of those contradictory. Rüegg et al. compared three ways of coping and found the
  best was to run the greedy feedback arc set heuristic the layered pipeline already uses and
  withhold a flow constraint from every edge in that set, leaving them free for the stress term
  rather than forcing them backwards. Both engines here call the same `greedyFAS`.
- The run is staged, again following them: untangle first, then add flow while boxes are still
  allowed to overlap so nodes can float past each other and swap, and separate the boxes only
  at the end. Applying non-overlap earlier freezes whatever ordering the first pass happened to
  land on. Switching to this order cut drawn stress across the presets by about 40%.
- Box separation is after Gansner & Hu's PRISM, which measures itself on how little it disturbs
  the layout it was handed.

The reported stress is measured on the drawing as rendered, after every constraint pass, not on
the optimiser's internal state. It is therefore higher than the raw stress the optimiser
reaches, and it is the number that actually describes the picture.

Runs are seeded and deterministic. Changing the seed finds a different local minimum, which is
the honest way to see how stable a given graph is.

### The other optimisers

The `method` dropdown swaps the optimiser and leaves everything else alone, so the constraint
layer, the renderer and both exporters are identical across all four. Only the first two share
an objective, which is the point of putting them together.

| Method | Objective | Needs distances | Notes |
|---|---|---|---|
| stress / SGD | stress | yes | Zheng et al. Algorithm 1. No guarantee any epoch lowers stress. |
| stress / majorization | the same stress | yes | Localized SMACOF. Every sweep provably lowers stress. |
| fruchterman-reingold | none, a force balance | no | The 1991 spring embedder, `f_a = d²/k`, `f_r = k²/d`, kept as a baseline. |
| SNAP-tFDP | none, a force balance | no | Chen et al., IEEE VIS 2026 ([arXiv:2608.01907](https://arxiv.org/pdf/2608.01907)), Algorithm 1. Edge-centric negative sampling, bounded Student-t repulsion. |

Zheng et al. report SGD reaching lower stress than majorization in fewer iterations on 242 of
243 test graphs. Having both here means you can check that on your own graph instead of taking
it on faith, and at flowchart scale it does not always hold. The two implementations behave
exactly as their theory predicts, which is the strongest evidence they are right: majorization
never once raises stress, and SGD does so several times per run.

The stress figure is still reported for the two force methods, but they were never trying to
minimise it, so read it as a description rather than a score. Neither reports a per-epoch
stress, so the convergence trace stays empty for them.

The SNAP-tFDP force constants are chosen to suit flowchart-scale drawings; the paper tunes for
graphs several orders of magnitude larger. The force *forms* are as published.

`LAYOUT-ALGORITHMS.md` explains the Sugiyama choices, with pseudocode and measurements.

## Supported syntax

A practical subset of mermaid's flowchart grammar:

```
flowchart TD
  A[rectangle] --> B{decision}
  B -->|labelled| C(rounded)
  B -- also labelled --> D([stadium])
  C -.-> E[(cylinder)]
  D ==> F((circle))
  E --- G{{hexagon}}
  F ----> H[/parallelogram/]
```

Directions are `TD`, `TB`, `BT`, `LR`, and `RL`. Links can be padded to any length, so `-->`,
`--->`, and `----->` all work, as do the dotted and thick variants. Both label forms are
accepted. `subgraph`, `class`, `style`, `click`, and `linkStyle` lines are skipped rather than
rejected, so pasting a real diagram usually gets you a picture instead of an error.

Anything the parser cannot read is reported in the bar under the editor. It never silently
drops an edge.

## Exports

Nothing downloads. Each button puts the markup straight on the clipboard, so you paste it
where you want it.

| Button | Copies |
|---|---|
| `copy .drawio` | mxGraphModel with shapes, styles, and the computed waypoints. Paste into diagrams.net via Extras &gt; Edit Diagram and it opens as editable shapes. |
| `copy .svg for Office` | Flat SVG using only presentation attributes. Paste into PowerPoint, then Convert to Shape for native objects. |
| `copy .svg` | Styled SVG with ids and classes, for the web. |

The payload always goes on the clipboard as `text/plain`, because that is what Edit Diagram,
text editors, and paste-as-text read. A typed copy rides along as a web custom format for
anything that can use it. Chrome refuses `image/svg+xml` on the clipboard outright, so a
plain paste into a native drawing app gets the SVG source rather than a rendered picture.

## The comparison pane

The `compare with` dropdown fetches mermaid from jsdelivr and renders the same source beside
the local output, optionally through ELK. This is the only part that touches the network. With
no connection the pane says so and everything else keeps working.

## Not implemented

Subgraphs and clusters, port constraints, multi-line edge labels, and the non-flowchart mermaid
diagram types. `--x` and `--o` link ends parse correctly but draw as ordinary arrowheads.

The stress engine routes every edge as a straight line, so it has no orthogonal or spline mode
and no edge-crossing minimisation of its own; crossings are an emergent property there, not an
optimised one. It also computes all-pairs shortest paths, which is fine at the few hundred
nodes this is built for and would need the pivot-based sparse variant beyond that.
