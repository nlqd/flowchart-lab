#!/usr/bin/env node
/* Inlines the three scripts into a single portable file.
   The site itself serves index.html; this build exists so the whole workbench
   can be handed over as one attachment that runs from a file:// URL. */
'use strict';
var fs = require('fs'), path = require('path');

var here = __dirname;
var html = fs.readFileSync(path.join(here, 'index.html'), 'utf8');

var out = html.replace(/<script src="([^"]+)"><\/script>/g, function (whole, src) {
  var file = path.join(here, src);
  if (!fs.existsSync(file)) throw new Error('index.html references a missing script: ' + src);
  return '<script>/* ' + src + ' */\n' + fs.readFileSync(file, 'utf8') + '</script>';
});

if (out.indexOf('<script src=') >= 0) throw new Error('some script tags were left external');

fs.writeFileSync(path.join(here, 'flowchart-lab.html'), out);
console.log('flowchart-lab.html  ' + (out.length / 1024).toFixed(0) + 'kB');
