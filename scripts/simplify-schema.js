#!/usr/bin/env node
/**
 * GraphQL Schema Simplifier for Visualization
 *
 * Creates a minimal schema showing only domain entities and their relationships,
 * removing all the pagination/connection bloat.
 *
 * Usage:
 *   node scripts/simplify-schema.js --input schema.graphql --output simplified.graphql --mappings domain-mappings.json
 *
 * Options:
 *   --input, -i           Input SDL file path [required]
 *   --output, -o          Output SDL file path [required]
 *   --mappings, -m        Domain mappings JSON file [required]
 *   --help, -h            Show help
 */

const fs = require("fs");
const path = require("path");
const { parse, print, visit, Kind } = require("graphql");

function printHelp() {
  console.log(`
GraphQL Schema Simplifier for Visualization

Creates a minimal schema showing only domain entities and their relationships.

Usage:
  node scripts/simplify-schema.js --input <file> --output <file> --mappings <file>

Options:
  -i, --input <file>      Input schema SDL file
  -o, --output <file>     Output simplified SDL file
  -m, --mappings <file>   Domain mappings JSON file
  -h, --help              Show this help

Example:
  node scripts/simplify-schema.js -i FLEXCURRENT_V001.schema.graphql -o simplified.graphql -m FLEXCURRENT_V001.schema-domain-mappings.json
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const config = {
    input: null,
    output: null,
    mappings: null,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--input":
      case "-i":
        config.input = args[++i];
        break;
      case "--output":
      case "-o":
        config.output = args[++i];
        break;
      case "--mappings":
      case "-m":
        config.mappings = args[++i];
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        if (a.startsWith("-")) {
          console.warn(`Warning: unknown argument: ${a}`);
        }
        break;
    }
  }

  if (!config.input || !config.output || !config.mappings) {
    printHelp();
    throw new Error("Missing required arguments: --input, --output, --mappings");
  }

  return config;
}

// Types to simplify (replace with String)
const SIMPLIFY_TO_STRING = new Set([
  // Spatial/Geometry types
  "SpatialInterfaceType",
  "SpatialLineStringEpsg25832Type",
  "SpatialLineStringZEpsg25832Type",
  "SpatialMultiLineStringEpsg25832Type",
  "SpatialMultiLineStringZEpsg25832Type",
  "SpatialMultiPointEpsg25832Type",
  "SpatialMultiPointZEpsg25832Type",
  "SpatialMultiPolygonEpsg25832Type",
  "SpatialPointEpsg25832Type",
  "SpatialPointEpsg4326Type",
  "SpatialPointZEpsg25832Type",
  "SpatialPointZEpsg4326Type",
  "SpatialPolygonEpsg25832Type",
  "SpatialPolygonEpsg4326Type",
  "SpatialPolygonZEpsg25832Type",
  // Date/Time types - keep as scalars but ensure they exist
  "DafDateTime",
  "LocalDate",
  "UUID",
  "Long",
]);

// Types to completely skip
const SKIP_TYPES = new Set([
  "PageInfo",
  "Query",
  "Mutation",
  "Subscription",
]);

// Suffixes that indicate infrastructure types to remove
const INFRASTRUCTURE_SUFFIXES = ["Connection", "Edge", "FilterInput", "SortInput"];

function getNamedType(typeNode) {
  let t = typeNode;
  while (t && (t.kind === Kind.NON_NULL_TYPE || t.kind === Kind.LIST_TYPE)) {
    t = t.type;
  }
  return t && t.kind === Kind.NAMED_TYPE ? t.name.value : null;
}

function defName(def) {
  return def && def.name && def.name.value ? def.name.value : null;
}

function isInfrastructureType(typeName) {
  return INFRASTRUCTURE_SUFFIXES.some((suffix) => typeName.endsWith(suffix));
}

function extractEntityFromConnection(connectionTypeName) {
  // BBR_BygningConnection -> BBR_Bygning
  if (connectionTypeName.endsWith("Connection")) {
    return connectionTypeName.slice(0, -"Connection".length);
  }
  return null;
}

function shouldSimplifyToString(typeName) {
  return SIMPLIFY_TO_STRING.has(typeName) || typeName.startsWith("Spatial");
}

function createSimplifiedNamedType(name, isNonNull = false, isList = false) {
  let typeNode = {
    kind: Kind.NAMED_TYPE,
    name: { kind: Kind.NAME, value: name },
  };

  if (isList) {
    typeNode = {
      kind: Kind.LIST_TYPE,
      type: typeNode,
    };
  }

  if (isNonNull) {
    typeNode = {
      kind: Kind.NON_NULL_TYPE,
      type: typeNode,
    };
  }

  return typeNode;
}

function simplifyFieldType(typeNode, entityTypes) {
  const namedType = getNamedType(typeNode);
  if (!namedType) return null;

  // Check if it's a Connection type -> extract the entity and make it a list
  const entityFromConnection = extractEntityFromConnection(namedType);
  if (entityFromConnection && entityTypes.has(entityFromConnection)) {
    // Return [EntityType] (list of the entity)
    return createSimplifiedNamedType(entityFromConnection, false, true);
  }

  // Check if it's a type we should simplify to String
  if (shouldSimplifyToString(namedType)) {
    return createSimplifiedNamedType("String", false, false);
  }

  // Check if it's a known entity type - keep as is
  if (entityTypes.has(namedType)) {
    return typeNode;
  }

  // Check if it's a basic scalar
  const basicScalars = new Set(["String", "Int", "Float", "Boolean", "ID"]);
  if (basicScalars.has(namedType)) {
    return typeNode;
  }

  // For enum types that are used (like status enums), simplify to String
  // This catches things like SpatialDimensionEnumType, etc.
  if (namedType.includes("Enum") || namedType.endsWith("Type")) {
    return createSimplifiedNamedType("String", false, false);
  }

  // Unknown type - simplify to String
  return createSimplifiedNamedType("String", false, false);
}

function main() {
  const cfg = parseArgs(process.argv);

  const inputPath = path.resolve(cfg.input);
  const outputPath = path.resolve(cfg.output);
  const mappingsPath = path.resolve(cfg.mappings);

  console.log("GraphQL Schema Simplifier");
  console.log("=========================");
  console.log(`Input:     ${inputPath}`);
  console.log(`Output:    ${outputPath}`);
  console.log(`Mappings:  ${mappingsPath}`);
  console.log("");

  // Load domain mappings
  const mappingsContent = fs.readFileSync(mappingsPath, "utf8");
  const domainMappings = JSON.parse(mappingsContent);

  // Identify entity types (not Connection/Edge types)
  const entityTypes = new Set();
  const entityToDomain = new Map();

  for (const [typeName, domain] of Object.entries(domainMappings)) {
    if (!isInfrastructureType(typeName)) {
      entityTypes.add(typeName);
      entityToDomain.set(typeName, domain);
    }
  }

  console.log(`Found ${entityTypes.size} entity types across ${new Set(Object.values(domainMappings)).size} domains`);

  // Load and parse schema
  const sdl = fs.readFileSync(inputPath, "utf8");
  console.log(`Read ${(sdl.length / 1024 / 1024).toFixed(2)} MB schema file`);

  console.log("Parsing SDL to AST...");
  const doc = parse(sdl, { noLocation: true });

  // Build map of type definitions
  const typeDefsByName = new Map();
  for (const def of doc.definitions) {
    const name = defName(def);
    if (name && def.kind === Kind.OBJECT_TYPE_DEFINITION) {
      typeDefsByName.set(name, def);
    }
  }

  console.log("Processing entity types...");

  // Process each entity type
  const simplifiedTypes = [];
  const relationshipEdges = []; // Track relationships for summary

  for (const entityName of entityTypes) {
    const typeDef = typeDefsByName.get(entityName);
    if (!typeDef) {
      console.warn(`Warning: Entity type ${entityName} not found in schema`);
      continue;
    }

    const simplifiedFields = [];
    const fields = typeDef.fields || [];

    for (const field of fields) {
      const fieldName = field.name.value;
      const namedType = getNamedType(field.type);

      // Skip certain field patterns
      if (fieldName.startsWith("datafordeler")) continue; // Internal metadata
      if (fieldName === "id_namespace") continue; // Namespace metadata
      if (namedType && namedType.endsWith("FilterInput")) continue; // Filter inputs

      // Simplify the field type
      const simplifiedType = simplifyFieldType(field.type, entityTypes);
      if (!simplifiedType) continue;

      const simplifiedTypeName = getNamedType(simplifiedType);

      // Track relationships
      if (simplifiedTypeName && entityTypes.has(simplifiedTypeName) && simplifiedTypeName !== entityName) {
        relationshipEdges.push({
          from: entityName,
          to: simplifiedTypeName,
          field: fieldName,
        });
      }

      // Create simplified field (no arguments, no directives)
      const simplifiedField = {
        kind: Kind.FIELD_DEFINITION,
        name: { kind: Kind.NAME, value: fieldName },
        arguments: [],
        type: simplifiedType,
        directives: [],
      };

      simplifiedFields.push(simplifiedField);
    }

    // Only include types that have fields
    if (simplifiedFields.length > 0) {
      // Add domain as a comment in the description
      const domain = entityToDomain.get(entityName);
      const description = domain
        ? { kind: Kind.STRING, value: `Domain: ${domain}`, block: false }
        : null;

      const simplifiedTypeDef = {
        kind: Kind.OBJECT_TYPE_DEFINITION,
        description,
        name: { kind: Kind.NAME, value: entityName },
        interfaces: [],
        directives: [],
        fields: simplifiedFields,
      };

      simplifiedTypes.push(simplifiedTypeDef);
    }
  }

  console.log(`Simplified ${simplifiedTypes.length} entity types`);
  console.log(`Found ${relationshipEdges.length} relationships`);

  // Create output document with schema declaration
  const schemaDefinition = {
    kind: Kind.SCHEMA_DEFINITION,
    operationTypes: [
      {
        kind: Kind.OPERATION_TYPE_DEFINITION,
        operation: "query",
        type: { kind: Kind.NAMED_TYPE, name: { kind: Kind.NAME, value: "Query" } },
      },
    ],
  };

  // Create a simple Query type with one field per entity type (ALL of them)
  const queryFields = simplifiedTypes.map((typeDef) => ({
    kind: Kind.FIELD_DEFINITION,
    name: { kind: Kind.NAME, value: defName(typeDef) },
    arguments: [],
    type: createSimplifiedNamedType(defName(typeDef), false, true),
    directives: [],
  }));

  const queryType = {
    kind: Kind.OBJECT_TYPE_DEFINITION,
    name: { kind: Kind.NAME, value: "Query" },
    interfaces: [],
    directives: [],
    fields: queryFields,
  };

  const outDoc = {
    kind: Kind.DOCUMENT,
    definitions: [schemaDefinition, queryType, ...simplifiedTypes],
  };

  const outSDL = print(outDoc) + "\n";

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, outSDL, "utf8");
  console.log(`Wrote ${(outSDL.length / 1024).toFixed(2)} KB to ${outputPath}`);

  // Print relationship summary
  console.log("\n=== RELATIONSHIP SUMMARY ===");
  const relationshipsByDomain = new Map();
  for (const edge of relationshipEdges) {
    const fromDomain = entityToDomain.get(edge.from);
    const toDomain = entityToDomain.get(edge.to);
    const key = `${fromDomain} -> ${toDomain}`;
    relationshipsByDomain.set(key, (relationshipsByDomain.get(key) || 0) + 1);
  }

  for (const [key, count] of Array.from(relationshipsByDomain.entries()).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${key}: ${count} relationships`);
  }

  console.log("\n✓ Done");
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error("Error:", err && err.message ? err.message : err);
    process.exit(1);
  }
}
