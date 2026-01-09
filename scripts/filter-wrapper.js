#!/usr/bin/env node
/**
 * Wrapper script for filter-schema.js that simplifies usage
 * 
 * Usage:
 *   npm run filter BBR
 *   npm run filter BBR DAR
 *   npm run filter BBR DAR MAT
 */

const { spawn } = require('child_process');
const path = require('path');

// Get register arguments from command line (skip 'node' and script name)
const registers = process.argv.slice(2);

if (registers.length === 0) {
  console.error('Error: Please provide at least one register name (e.g., BBR, DAR)');
  console.error('Usage: npm run filter BBR [DAR] [MAT] ...');
  process.exit(1);
}

// Default input file
const inputFile = './FLEXCURRENT_V001.schema.graphql';

// Generate output filename: schema/FLEXCURRENT_BBR_DAR.schema.graphql
const outputFile = `schema/FLEXCURRENT_${registers.join('_')}.schema.graphql`;

// Build the command arguments
const args = [
  path.join(__dirname, 'filter-schema.js'),
  '--registers', registers.join(','),
  '--input', inputFile,
  '--output', outputFile
];

console.log(`Filtering schema for registers: ${registers.join(', ')}`);
console.log(`Input:  ${inputFile}`);
console.log(`Output: ${outputFile}`);
console.log('');

// Spawn the filter-schema.js script
const child = spawn('node', args, {
  stdio: 'inherit',
  cwd: path.join(__dirname, '..')
});

child.on('error', (error) => {
  console.error(`Error spawning process: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code) => {
  process.exit(code || 0);
});
