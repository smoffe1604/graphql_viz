#!/usr/bin/env node
/**
 * Domain Mappings Generator
 * 
 * Genererer domain mappings fra en GraphQL schema fil
 * 
 * Usage:
 *   npm run domain-mappings
 *   npm run domain-mappings <sti-til-schema-fil>
 */

const fs = require('fs');
const path = require('path');

// Definer domænerne uden version
// Note: EJF kan starte med både "EJF_" og "EJF" (uden underscore)
const DOMAINS = {
  'BBR_': 'BBR',
  'CPR_': 'CPR',
  'CVR_': 'CVR',
  'DAGI_': 'DAGI',
  'DAR_': 'DAR',
  'DHMHoejdekurver_': 'DHMHoejdekurver',
  'DHMOprindelse_': 'DHMOprindelse',
  'DS_': 'DS',
  'EBR_': 'EBR',
  'EJF_': 'EJF',
  'EJF': 'EJF',  // EJF kan også starte uden underscore
  'FIKSPUNKT_': 'FIKSPUNKT',
  'GEODKV_': 'GEODKV',
  'HISTKORT_': 'HISTKORT',
  'MAT_': 'MAT',
  'SVR_': 'SVR',
  'VUR_': 'VUR'
};

// Brug argument eller default til FLEXCURRENT_V001
const schemaPath = process.argv[2] || './FLEXCURRENT_V001.schema.graphql';
const resolvedSchemaPath = path.resolve(schemaPath);

if (!fs.existsSync(resolvedSchemaPath)) {
  console.error(`Fejl: Kunne ikke finde filen: ${resolvedSchemaPath}`);
  console.log('Brug: npm run domain-mappings [sti-til-schema-fil]');
  process.exit(1);
}

console.log(`Læser schema fra: ${resolvedSchemaPath}\n`);

const schemaContent = fs.readFileSync(resolvedSchemaPath, 'utf-8');

// Find alle type definitions
const typeRegex = /type\s+([A-Z_][A-Za-z0-9_]*)/g;
const types = [];
let match;

while ((match = typeRegex.exec(schemaContent)) !== null) {
  types.push(match[1]);
}

// Generer domain mappings
const domainMappings = {};

types.forEach(typeName => {
  // Find hvilket domæne typen hører til
  // Sorter prefixes efter længde (længste først) for at matche mere specifikke først
  const sortedPrefixes = Object.keys(DOMAINS).sort((a, b) => b.length - a.length);
  
  for (const prefix of sortedPrefixes) {
    if (typeName.startsWith(prefix)) {
      domainMappings[typeName] = DOMAINS[prefix];
      break;
    }
  }
});

// Sorter mappings alfabetisk
const sortedMappings = Object.keys(domainMappings)
  .sort()
  .reduce((acc, key) => {
    acc[key] = domainMappings[key];
    return acc;
  }, {});

// Output i forskellige formater
console.log('=== DOMAIN MAPPINGS (Key-Value Format) ===\n');
Object.entries(sortedMappings).forEach(([type, domain]) => {
  console.log(`${type}: ${domain}`);
});

console.log('\n\n=== DOMAIN MAPPINGS (JSON Format) ===\n');
console.log(JSON.stringify(sortedMappings, null, 2));

console.log('\n\n=== STATISTIK ===');
const stats = {};
Object.values(sortedMappings).forEach(domain => {
  stats[domain] = (stats[domain] || 0) + 1;
});

Object.entries(stats).sort((a, b) => b[1] - a[1]).forEach(([domain, count]) => {
  console.log(`${domain}: ${count} typer`);
});

console.log(`\nTotal: ${Object.keys(sortedMappings).length} typer`);

// Gem til fil baseret på input filnavn
const inputBasename = path.basename(resolvedSchemaPath, path.extname(resolvedSchemaPath));
const outputPath = `${inputBasename}-domain-mappings.txt`;
const outputContent = Object.entries(sortedMappings)
  .map(([type, domain]) => `${type}: ${domain}`)
  .join('\n');

fs.writeFileSync(outputPath, outputContent, 'utf-8');
console.log(`\nMappings gemt til: ${outputPath}`);

// Gem også JSON version
const jsonOutputPath = `${inputBasename}-domain-mappings.json`;
fs.writeFileSync(jsonOutputPath, JSON.stringify(sortedMappings, null, 2), 'utf-8');
console.log(`JSON mappings gemt til: ${jsonOutputPath}`);
