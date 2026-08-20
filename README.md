# Flowchart Lab

A Sugiyama layout engine for mermaid-style flowcharts, with the pipeline exposed as controls
so you can see what each phase costs. Swap the layering algorithm and watch the dummy count
move. Turn crossing minimisation off and watch the picture fall apart. Put the result next to
mermaid's own output and judge for yourself.

No build step, no dependencies, no server. It is three JavaScript files and an HTML page.

## Running it

Open `index.html`. Any static host works, including a local one:

```sh
python3 -m http.server 8000
```

For a copy you can email or drop on a shared drive, `flowchart-lab.html` is the same app
inlined into one file that runs from `file://`. Regenerate it after changing anything:

```sh
node build-standalone.js
```

## What it does

The engine implements the four classical Sugiyama phases plus routing and wrapping:

1. Cycle removal with greedy feedback arc set (Eades, Lin & Smyth 1993)
2. Layering with longest path, Coffman-Graham, or network simplex (GKNV 1993), with optional
   node promotion (Nikolov & Tarassov 2006)
3. Ordering with weighted median and transpose, scored by accumulator-tree crossing counting
   (Barth, Jünger & Mutzel 2002)
4. X coordinates with Brandes & Köpf (2002), made size-aware for variable-width boxes
5. Cut-and-stack wrapping to hit a target aspect ratio
6. Orthogonal, polyline, or spline routing, with edges attaching to faces and sharing tracks

`LAYOUT-ALGORITHMS.md` explains why each of these was chosen, with pseudocode and measurements.

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

| Button | Produces |
|---|---|
| `.drawio` | mxGraphModel with shapes, styles, and the computed waypoints. Opens in diagrams.net as editable shapes. |
| `.svg for Office` | Flat SVG using only presentation attributes. PowerPoint's Convert to Shape turns it into native objects. |
| `.svg` | Styled SVG with ids and classes, for the web. |
| `copy xml` | The draw.io XML on the clipboard, for Extras &gt; Edit Diagram. |

## The comparison pane

The `compare with` dropdown fetches mermaid from jsdelivr and renders the same source beside
the local output, optionally through ELK. This is the only part that touches the network. With
no connection the pane says so and everything else keeps working.

## Not implemented

Subgraphs and clusters, port constraints, multi-line edge labels, and the non-flowchart mermaid
diagram types. `--x` and `--o` link ends parse correctly but draw as ordinary arrowheads.
