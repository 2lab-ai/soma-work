#!/usr/bin/env node

require('@resvg/resvg-js');

const targetName = process.argv[2] || 'local';
console.log(`resvg native binary OK on ${targetName}`);
