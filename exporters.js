/* renderers + exporters for the flowchart layout engine */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FlowExport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function f(n) { return Math.round(n * 100) / 100; }

  var THEME = {
    light: {
      bg: '#ffffff', nodeFill: '#ffffff', nodeStroke: '#3f4650', text: '#12161c',
      edge: '#5a626e', edgeLabelBg: '#ffffff', edgeLabel: '#3f4650',
      accentFill: '#eef2f9', accentStroke: '#2f6fd0'
    }
  };

  /* ---------- shape geometry, shared by every renderer ---------- */
  function shapeGeom(n) {
    var x = n.x - n.w / 2, y = n.y - n.h / 2, w = n.w, h = n.h;
    switch (n.shape) {
      case 'diamond':
        return { kind: 'poly', pts: [[n.x, y], [x + w, n.y], [n.x, y + h], [x, n.y]] };
      case 'circle':
        return { kind: 'ellipse', cx: n.x, cy: n.y, rx: w / 2, ry: h / 2 };
      case 'stadium':
        return { kind: 'rect', x: x, y: y, w: w, h: h, rx: h / 2 };
      case 'round':
        return { kind: 'rect', x: x, y: y, w: w, h: h, rx: Math.min(12, h / 3) };
      case 'hexagon':
        var k = Math.min(18, w / 5);
        return { kind: 'poly', pts: [[x + k, y], [x + w - k, y], [x + w, n.y],
                                     [x + w - k, y + h], [x + k, y + h], [x, n.y]] };
      case 'parallelogram':
        var s = Math.min(18, w / 5);
        return { kind: 'poly', pts: [[x + s, y], [x + w, y], [x + w - s, y + h], [x, y + h]] };
      case 'cylinder':
        var e = Math.min(12, h / 4);
        return { kind: 'path', d:
          'M' + f(x) + ' ' + f(y + e) +
          'A' + f(w / 2) + ' ' + f(e) + ' 0 0 1 ' + f(x + w) + ' ' + f(y + e) +
          'L' + f(x + w) + ' ' + f(y + h - e) +
          'A' + f(w / 2) + ' ' + f(e) + ' 0 0 1 ' + f(x) + ' ' + f(y + h - e) + 'Z',
          cap: 'M' + f(x) + ' ' + f(y + e) +
               'A' + f(w / 2) + ' ' + f(e) + ' 0 0 0 ' + f(x + w) + ' ' + f(y + e) };
      default:
        return { kind: 'rect', x: x, y: y, w: w, h: h, rx: 3 };
    }
  }

  function shapeSVG(n, g, fill, stroke, sw) {
    var a = 'fill="' + fill + '" stroke="' + stroke + '" stroke-width="' + sw + '"';
    if (g.kind === 'rect')
      return '<rect x="' + f(g.x) + '" y="' + f(g.y) + '" width="' + f(g.w) + '" height="' + f(g.h) +
             '" rx="' + f(g.rx) + '" ry="' + f(g.rx) + '" ' + a + '/>';
    if (g.kind === 'ellipse')
      return '<ellipse cx="' + f(g.cx) + '" cy="' + f(g.cy) + '" rx="' + f(g.rx) + '" ry="' + f(g.ry) + '" ' + a + '/>';
    if (g.kind === 'poly')
      return '<polygon points="' + g.pts.map(function (p) { return f(p[0]) + ',' + f(p[1]); }).join(' ') + '" ' + a + '/>';
    return '<path d="' + g.d + '" ' + a + '/>' +
           (g.cap ? '<path d="' + g.cap + '" fill="none" stroke="' + stroke + '" stroke-width="' + sw + '"/>' : '');
  }

  function nodeText(n, color, fontSize, fontFamily) {
    var lines = n.lines || [n.label];
    var lh = fontSize * 1.32;
    var startY = n.y + (n.textDy || 0) - ((lines.length - 1) * lh) / 2;
    var out = '<text x="' + f(n.x) + '" y="' + f(startY) + '" text-anchor="middle" ' +
              'dominant-baseline="central" font-family="' + fontFamily + '" font-size="' + fontSize +
              '" font-weight="500" fill="' + color + '">';
    lines.forEach(function (l, i) {
      out += '<tspan x="' + f(n.x) + '"' + (i ? ' dy="' + f(lh) + '"' : '') + '>' + esc(l) + '</tspan>';
    });
    return out + '</text>';
  }

  /* ------------------------------------------------------------------ *
   * SVG renderer.  mode 'app' adds ids/classes for interactivity,
   * mode 'flat' emits only presentation attributes so PowerPoint /
   * Illustrator / Visio can convert it into native editable shapes.
   * ------------------------------------------------------------------ */
  function toSVG(L, opts) {
    var o = opts || {};
    var t = THEME.light;
    var flat = o.mode === 'flat';
    var ff = flat ? 'Arial, Helvetica, sans-serif' : 'ui-sans-serif, system-ui, sans-serif';
    var fs = o.fontSize || 14, efs = o.edgeFontSize || 12;
    var s = [];

    s.push('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ' +
           'width="' + L.width + '" height="' + L.height + '" ' +
           'viewBox="0 0 ' + L.width + ' ' + L.height + '">');
    s.push('<defs><marker id="fl-arrow" viewBox="0 0 10 10" refX="9" refY="5" ' +
           'markerWidth="7" markerHeight="7" orient="auto-start-reverse" markerUnits="strokeWidth">' +
           '<path d="M0 0 L10 5 L0 10 z" fill="' + t.edge + '"/></marker></defs>');
    if (flat) s.push('<rect x="0" y="0" width="' + L.width + '" height="' + L.height + '" fill="#ffffff"/>');

    // edges first so nodes sit on top
    L.edges.forEach(function (e) {
      var dash = e.style === 'dashed' ? ' stroke-dasharray="6 4"' : '';
      var sw = e.style === 'thick' ? 2.6 : 1.5;
      var head = e.arrow === 'none' ? '' : ' marker-end="url(#fl-arrow)"';
      s.push('<path ' + (flat ? '' : 'class="fl-edge" data-id="' + esc(e.id) + '" ') +
             'd="' + e.path + '" fill="none" stroke="' + t.edge + '" stroke-width="' + sw +
             '" stroke-linecap="round" stroke-linejoin="round"' + dash + head + '/>');
    });

    L.edges.forEach(function (e) {
      if (!e.label || !e.labelPos) return;
      var w = e.label.length * efs * 0.58 + 10, h = efs * 1.5;
      s.push('<rect x="' + f(e.labelPos.x - w / 2) + '" y="' + f(e.labelPos.y - h / 2) +
             '" width="' + f(w) + '" height="' + f(h) + '" rx="3" fill="' + t.edgeLabelBg +
             '" stroke="none"/>');
      s.push('<text x="' + f(e.labelPos.x) + '" y="' + f(e.labelPos.y) +
             '" text-anchor="middle" dominant-baseline="central" font-family="' + ff +
             '" font-size="' + efs + '" fill="' + t.edgeLabel + '">' + esc(e.label) + '</text>');
    });

    L.nodes.forEach(function (n) {
      var g = shapeGeom(n);
      var fill = n.shape === 'diamond' ? t.accentFill : t.nodeFill;
      var stroke = n.shape === 'diamond' ? t.accentStroke : t.nodeStroke;
      if (!flat) s.push('<g class="fl-node" data-id="' + esc(n.id) + '">');
      s.push(shapeSVG(n, g, fill, stroke, 1.5));
      s.push(nodeText(n, t.text, fs, ff));
      if (!flat) s.push('</g>');
    });

    s.push('</svg>');
    return s.join('\n');
  }

  /* ------------------------------------------------------------------ *
   * draw.io / diagrams.net  mxGraphModel
   * ------------------------------------------------------------------ */
  var DRAWIO_STYLE = {
    rect: 'rounded=0;whiteSpace=wrap;html=1;',
    round: 'rounded=1;whiteSpace=wrap;html=1;arcSize=20;',
    stadium: 'rounded=1;whiteSpace=wrap;html=1;arcSize=50;',
    diamond: 'rhombus;whiteSpace=wrap;html=1;',
    circle: 'ellipse;whiteSpace=wrap;html=1;',
    cylinder: 'shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=12;',
    hexagon: 'shape=hexagon;whiteSpace=wrap;html=1;perimeter=hexagonPerimeter2;',
    parallelogram: 'shape=parallelogram;perimeter=parallelogramPerimeter;whiteSpace=wrap;html=1;'
  };

  function toDrawio(L, opts) {
    var o = opts || {};
    var routing = o.routing || 'orthogonal';
    var edgeStyle = routing === 'orthogonal' ? 'edgeStyle=orthogonalEdgeStyle;rounded=1;'
                  : routing === 'spline' ? 'edgeStyle=none;curved=1;rounded=0;'
                  : 'edgeStyle=none;rounded=0;';
    var x = [];
    x.push('<mxfile host="flowchart-lab" modified="' + new Date().toISOString() +
           '" agent="flowchart-lab" version="21.0.0" type="device">');
    x.push('  <diagram id="flowchart-lab-1" name="Flowchart">');
    x.push('    <mxGraphModel dx="' + (L.width + 200) + '" dy="' + (L.height + 200) +
           '" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" ' +
           'page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">');
    x.push('      <root>');
    x.push('        <mxCell id="0" />');
    x.push('        <mxCell id="1" parent="0" />');

    var idMap = {};
    L.nodes.forEach(function (n, i) {
      var cid = 'node' + i;
      idMap[n.id] = cid;
      var style = DRAWIO_STYLE[n.shape] || DRAWIO_STYLE.rect;
      if (n.shape === 'diamond') style += 'fillColor=#eef2f9;strokeColor=#2f6fd0;';
      else style += 'fillColor=#ffffff;strokeColor=#3f4650;';
      style += 'fontSize=13;fontColor=#12161c;';
      x.push('        <mxCell id="' + cid + '" value="' + esc(String(n.label).replace(/\n/g, '<br>')) +
             '" style="' + style + '" vertex="1" parent="1">');
      x.push('          <mxGeometry x="' + f(n.x - n.w / 2) + '" y="' + f(n.y - n.h / 2) +
             '" width="' + f(n.w) + '" height="' + f(n.h) + '" as="geometry" />');
      x.push('        </mxCell>');
    });

    L.edges.forEach(function (e, i) {
      var st = edgeStyle + 'html=1;strokeColor=#5a626e;fontSize=11;fontColor=#3f4650;';
      if (e.style === 'dashed') st += 'dashed=1;';
      if (e.style === 'thick') st += 'strokeWidth=2.5;';
      if (e.arrow === 'none') st += 'endArrow=none;';
      var src = idMap[e.from], dst = idMap[e.to];
      x.push('        <mxCell id="edge' + i + '" value="' + esc(e.label || '') + '" style="' + st +
             '" edge="1" parent="1" source="' + src + '" target="' + dst + '">');
      x.push('          <mxGeometry relative="1" as="geometry">');
      // interior waypoints preserve the computed route exactly
      var mids = (e.points || []).slice(1, -1);
      if (mids.length && !e.selfLoop) {
        x.push('            <Array as="points">');
        mids.forEach(function (p) {
          x.push('              <mxPoint x="' + f(p.x) + '" y="' + f(p.y) + '" />');
        });
        x.push('            </Array>');
      }
      x.push('          </mxGeometry>');
      x.push('        </mxCell>');
    });

    x.push('      </root>');
    x.push('    </mxGraphModel>');
    x.push('  </diagram>');
    x.push('</mxfile>');
    return x.join('\n');
  }

  return { toSVG: toSVG, toDrawio: toDrawio, shapeGeom: shapeGeom, esc: esc };
});
