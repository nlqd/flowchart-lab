#!/usr/bin/env node
/* Inlines each page's stylesheet and scripts into a single portable file.
   The site serves the split versions; these builds exist so a whole workbench
   can be handed over as one attachment that runs from a file:// URL. */
'use strict';
var fs = require('fs'), path = require('path');

var here = __dirname;
var PAGES = [
  { src: 'index.html', out: 'flowchart-lab.html' },
  { src: 'sgd.html',   out: 'stress-lab.html' }
];

function read(rel) {
  var file = path.join(here, rel);
  if (!fs.existsSync(file)) throw new Error(rel + ' references a missing file: ' + rel);
  return fs.readFileSync(file, 'utf8');
}

PAGES.forEach(function (page) {
  var html = read(page.src);

  html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, function (whole, href) {
    return '<style>/* ' + href + ' */\n' + read(href) + '</style>';
  });
  html = html.replace(/<script src="([^"]+)"><\/script>/g, function (whole, src) {
    return '<script>/* ' + src + ' */\n' + read(src) + '</script>';
  });

  // the sibling links point at the split pages, which will not exist next to a
  // single-file copy; send both to the page that is actually bundled
  html = html.replace(/<a href="(index|sgd)\.html"([^>]*)>/g, function (whole, name, rest) {
    return '<a href="https://nlqd.github.io/flowchart-lab/' + name + '.html"' + rest + '>';
  });

  if (html.indexOf('<script src=') >= 0) throw new Error(page.src + ': a script tag was left external');
  if (html.indexOf('<link rel="stylesheet"') >= 0) throw new Error(page.src + ': a stylesheet was left external');

  fs.writeFileSync(path.join(here, page.out), html);
  console.log(page.out.padEnd(22) + (html.length / 1024).toFixed(0) + 'kB');
});
