#!/usr/bin/env node
/**
 * Datafordeler GraphQL Schema Filter (AST-based)
 *
 * Filters a large GraphQL SDL schema to only include specified registers
 * (by type/field prefix like "BBR_" / "DAR_") and their transitive dependencies.
 *
 * Usage:
 *   node scripts/filter-schema.js --registers BBR,DAR --input schema/FLEX_V001.schema.graphql --output schema/FLEX_BBR_DAR.schema.graphql
 *
 * Options:
 *   --registers, -r       Comma-separated register prefixes (e.g. BBR,CVR,DAR) [required]
 *   --input, -i           Input SDL file path [required]
 *   --output, -o          Output SDL file path [required]
 *   --keep-root-fields    Comma-separated root fields to always keep (e.g. version,health)
 *   --no-prune-foreign    Keep cross-register fields (default is to prune them)
 *   --allow-prefixes      Comma-separated additional underscore-prefixes to allow (e.g. MAT,EJF)
 *   --no-validate         Skip validation/build step (faster for huge schemas)
 *   --help, -h            Show help
 */

const fs = require("fs");
const path = require("path");

const {
  parse,
  print,
  visit,
  Kind,
  buildASTSchema,
} = require("graphql");

const BUILTIN_SCALARS = new Set(["String", "Int", "Float", "Boolean", "ID"]);

function printHelp() {
  console.log(`
Datafordeler GraphQL Schema Filter (AST-based)

Usage:
  node scripts/filter-schema.js --registers <list> --input <file> --output <file>

Options:
  -r, --registers <list>       Comma-separated register prefixes (e.g. BBR,CVR,DAR)
  -i, --input <file>           Input schema SDL file
  -o, --output <file>          Output filtered SDL file
  --keep-root-fields <list>    Comma-separated root fields to always keep (in Query/Mutation/Subscription)
  --no-prune-foreign           Keep cross-register fields/types (larger output)
  --allow-prefixes <list>      Comma-separated underscore-prefixes to allow even if not selected (e.g. MAT,EJF)
  --no-validate                Skip building the schema to validate output
  -h, --help                   Show this help

Examples:
  node scripts/filter-schema.js -r BBR,DAR -i schema/FLEX_V001.schema.graphql -o schema/FLEX_BBR_DAR.schema.graphql
  node scripts/filter-schema.js -r CVR -i schema/CVR_V001.schema.graphql -o schema/CVR_only.schema.graphql
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const config = {
    registers: [],
    input: null,
    output: null,
    keepRootFields: new Set(),
    pruneForeign: true,
    allowPrefixes: new Set(),
    validate: true,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--registers":
      case "-r": {
        const v = args[++i];
        if (!v) throw new Error("Missing value for --registers");
        config.registers = v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      }
      case "--input":
      case "-i": {
        config.input = args[++i];
        break;
      }
      case "--output":
      case "-o": {
        config.output = args[++i];
        break;
      }
      case "--keep-root-fields": {
        const v = args[++i] || "";
        v.split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .forEach((f) => config.keepRootFields.add(f));
        break;
      }
      case "--no-prune-foreign": {
        config.pruneForeign = false;
        break;
      }
      case "--allow-prefixes": {
        const v = args[++i] || "";
        v.split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .forEach((p) => config.allowPrefixes.add(p));
        break;
      }
      case "--no-validate": {
        config.validate = false;
        break;
      }
      case "--help":
      case "-h": {
        printHelp();
        process.exit(0);
      }
      default:
        // tolerate unknown args to keep it flexible, but warn
        if (a.startsWith("-")) {
          console.warn(`Warning: unknown argument: ${a}`);
        }
        break;
    }
  }

  if (!config.registers.length || !config.input || !config.output) {
    printHelp();
    throw new Error("Missing required arguments: --registers, --input, --output");
  }

  return config;
}

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

function isRootTypeName(name) {
  return name === "Query" || name === "Mutation" || name === "Subscription";
}

function underscorePrefix(name) {
  const idx = name.indexOf("_");
  if (idx <= 0) return null;
  return name.slice(0, idx);
}

function makePrefixMatcher(registers) {
  const prefixes = registers.map((r) => `${r}_`);
  return (name) => prefixes.some((p) => name.startsWith(p));
}

function collectNamedTypesFromNode(node) {
  const out = new Set();
  visit(node, {
    NamedType(n) {
      out.add(n.name.value);
    },
  });
  return out;
}

function pruneRootObjectTypeDef(def, matchesRegisterOrKeep) {
  if (
    def.kind !== Kind.OBJECT_TYPE_DEFINITION &&
    def.kind !== Kind.OBJECT_TYPE_EXTENSION
  ) {
    return def;
  }
  const name = defName(def);
  if (!name || !isRootTypeName(name)) return def;

  const fields = def.fields || [];
  const kept = fields.filter((f) => {
    if (matchesRegisterOrKeep(f.name.value)) return true;
    const ret = getNamedType(f.type);
    if (ret && matchesRegisterOrKeep(ret)) return true;
    return false;
  });

  return {
    ...def,
    fields: kept,
  };
}

function pruneForeignRefs(def, isAllowedTypeName) {
  // Prune fields/inputFields/union members that reference "foreign" underscore-prefixed types.
  // This keeps the output schema focused on the selected registers and common (no-underscore) types.
  switch (def.kind) {
    case Kind.OBJECT_TYPE_DEFINITION:
    case Kind.OBJECT_TYPE_EXTENSION:
    case Kind.INTERFACE_TYPE_DEFINITION:
    case Kind.INTERFACE_TYPE_EXTENSION: {
      const fields = def.fields || [];
      const keptFields = fields.filter((f) => {
        const names = new Set();
        const ret = getNamedType(f.type);
        if (ret) names.add(ret);
        for (const arg of f.arguments || []) {
          const an = getNamedType(arg.type);
          if (an) names.add(an);
        }
        for (const n of names) {
          if (!isAllowedTypeName(n)) return false;
        }
        return true;
      });

      // Also drop implements that are foreign
      const ifaces = def.interfaces || [];
      const keptIfaces = ifaces.filter((i) => isAllowedTypeName(i.name.value));

      return { ...def, fields: keptFields, interfaces: keptIfaces };
    }
    case Kind.INPUT_OBJECT_TYPE_DEFINITION:
    case Kind.INPUT_OBJECT_TYPE_EXTENSION: {
      const fields = def.fields || [];
      const keptFields = fields.filter((f) => {
        const n = getNamedType(f.type);
        return !n || isAllowedTypeName(n);
      });
      return { ...def, fields: keptFields };
    }
    case Kind.UNION_TYPE_DEFINITION:
    case Kind.UNION_TYPE_EXTENSION: {
      const types = def.types || [];
      const keptTypes = types.filter((t) => isAllowedTypeName(t.name.value));
      return { ...def, types: keptTypes };
    }
    default:
      return def;
  }
}

function updateSchemaDefinitionOps(schemaDef, rootTypeNamesToKeep) {
  // rootTypeNamesToKeep: Set of operationType kinds to keep, e.g. {"query","subscription"}
  if (!schemaDef) return null;
  const ops = schemaDef.operationTypes || [];
  const kept = ops.filter((op) => rootTypeNamesToKeep.has(op.operation));
  return { ...schemaDef, operationTypes: kept };
}

function main() {
  const cfg = parseArgs(process.argv);

  const inputPath = path.resolve(cfg.input);
  const outputPath = path.resolve(cfg.output);

  console.log("Datafordeler Schema Filter");
  console.log("=========================");
  console.log(`Registers: ${cfg.registers.join(", ")}`);
  console.log(`Input:     ${inputPath}`);
  console.log(`Output:    ${outputPath}`);
  console.log(`Validate:  ${cfg.validate ? "yes" : "no"}`);
  console.log(`Prune foreign: ${cfg.pruneForeign ? "yes" : "no"}`);
  if (cfg.allowPrefixes.size) {
    console.log(`Allow prefixes: ${Array.from(cfg.allowPrefixes).join(", ")}`);
  }
  if (cfg.keepRootFields.size) {
    console.log(`Keep root fields: ${Array.from(cfg.keepRootFields).join(", ")}`);
  }
  console.log("");

  const sdl = fs.readFileSync(inputPath, "utf8");
  console.log(`Read ${(sdl.length / 1024 / 1024).toFixed(2)} MB`);

  console.log("Parsing SDL to AST...");
  const doc = parse(sdl, { noLocation: true });

  // Build definition indices
  const defs = doc.definitions;
  const defsByName = new Map(); // name -> [defs...]
  const scalarDefs = [];
  const directiveDefs = [];
  let schemaDef = null;
  const schemaExts = [];

  for (const d of defs) {
    if (d.kind === Kind.SCHEMA_DEFINITION) schemaDef = d;
    if (d.kind === Kind.SCHEMA_EXTENSION) schemaExts.push(d);
    if (d.kind === Kind.SCALAR_TYPE_DEFINITION) scalarDefs.push(d);
    if (d.kind === Kind.DIRECTIVE_DEFINITION) directiveDefs.push(d);

    const name = defName(d);
    if (name) {
      const arr = defsByName.get(name) || [];
      arr.push(d);
      defsByName.set(name, arr);
    }
  }

  const matchesRegister = makePrefixMatcher(cfg.registers);
  const matchesRegisterOrKeep = (name) =>
    matchesRegister(name) || cfg.keepRootFields.has(name);

  const isAllowedTypeName = (name) => {
    if (!name) return true;
    if (BUILTIN_SCALARS.has(name)) return true;
    if (isRootTypeName(name)) return true;
    const p = underscorePrefix(name);
    if (!p) return true; // no underscore => treat as shared/common
    if (cfg.allowPrefixes.has(p)) return true;
    return cfg.registers.includes(p);
  };

  // Helpful warnings when registers aren't present in the input schema
  const registerPresence = new Map(
    cfg.registers.map((r) => [r, { typeDefs: 0, rootFields: 0 }])
  );
  for (const [name] of defsByName) {
    for (const r of cfg.registers) {
      if (name.startsWith(`${r}_`)) registerPresence.get(r).typeDefs++;
    }
  }
  for (const d of defs) {
    const name = defName(d);
    if (!name || !isRootTypeName(name)) continue;
    const fields = d.fields || [];
    for (const f of fields) {
      for (const r of cfg.registers) {
        if (f.name.value.startsWith(`${r}_`)) {
          registerPresence.get(r).rootFields++;
          continue;
        }
        const ret = getNamedType(f.type);
        if (ret && ret.startsWith(`${r}_`)) registerPresence.get(r).rootFields++;
      }
    }
  }
  const missing = [];
  for (const [r, p] of registerPresence.entries()) {
    if (p.typeDefs === 0 && p.rootFields === 0) missing.push(r);
  }
  if (missing.length) {
    console.warn(
      `Warning: no types or root fields found for register(s): ${missing.join(
        ", "
      )}. They may not exist in this input schema.`
    );
  }

  // Create "effective" pruned nodes for root operation types (and remember mapping)
  const prunedNodeByOriginal = new Map();
  const rootTypeFieldCounts = new Map(); // Query/Mutation/Subscription -> fields count after prune across defs/exts

  for (const d of defs) {
    const name = defName(d);
    if (!name || !isRootTypeName(name)) continue;
    let pruned = pruneRootObjectTypeDef(d, matchesRegisterOrKeep);
    if (cfg.pruneForeign) pruned = pruneForeignRefs(pruned, isAllowedTypeName);
    prunedNodeByOriginal.set(d, pruned);
    const count = (pruned.fields || []).length;
    rootTypeFieldCounts.set(name, (rootTypeFieldCounts.get(name) || 0) + count);
  }

  if (rootTypeFieldCounts.has("Query") && (rootTypeFieldCounts.get("Query") || 0) === 0) {
    throw new Error(
      `After pruning, Query has 0 fields. Are the registers correct? (${cfg.registers.join(
        ", "
      )})`
    );
  }

  // Decide which schema operations to keep based on root type field counts
  const keepOps = new Set();
  if ((rootTypeFieldCounts.get("Query") || 0) > 0) keepOps.add("query");
  if ((rootTypeFieldCounts.get("Mutation") || 0) > 0) keepOps.add("mutation");
  if ((rootTypeFieldCounts.get("Subscription") || 0) > 0) keepOps.add("subscription");

  const effectiveSchemaDef = schemaDef ? updateSchemaDefinitionOps(schemaDef, keepOps) : null;

  // Seed keep-set with:
  // - all types whose name matches register prefix
  // - root types referenced by schema (query/mutation/subscription)
  const keepTypeNames = new Set();
  for (const [name] of defsByName) {
    if (matchesRegister(name)) keepTypeNames.add(name);
  }

  // Always keep root type names if present in schema ops
  for (const op of keepOps) {
    if (op === "query") keepTypeNames.add("Query");
    if (op === "mutation") keepTypeNames.add("Mutation");
    if (op === "subscription") keepTypeNames.add("Subscription");
  }

  // Also keep types referenced by the kept root fields (return + arg types)
  // We'll discover these via dependency closure below, starting from root types.

  // Dependency closure
  const queue = Array.from(keepTypeNames);
  const seen = new Set(queue);

  const enqueue = (t) => {
    if (!t || BUILTIN_SCALARS.has(t)) return;
    if (seen.has(t)) return;
    seen.add(t);
    queue.push(t);
  };

  // Keep directive-definition dependencies too (important for federation/join directives etc.)
  for (const dd of directiveDefs) {
    const refs = collectNamedTypesFromNode(dd);
    for (const r of refs) enqueue(r);
  }
  // Also include any named types referenced by schema definition / extensions (rare but safe)
  if (effectiveSchemaDef) {
    const refs = collectNamedTypesFromNode(effectiveSchemaDef);
    for (const r of refs) enqueue(r);
  }
  for (const se of schemaExts) {
    const refs = collectNamedTypesFromNode(se);
    for (const r of refs) enqueue(r);
  }

  console.log("Collecting transitive dependencies...");
  while (queue.length) {
    const typeName = queue.pop();
    const typeDefs = defsByName.get(typeName) || [];
    for (const originalDef of typeDefs) {
      let effectiveDef = prunedNodeByOriginal.get(originalDef) || originalDef;
      if (cfg.pruneForeign) effectiveDef = pruneForeignRefs(effectiveDef, isAllowedTypeName);
      const refs = collectNamedTypesFromNode(effectiveDef);
      for (const r of refs) enqueue(r);
    }
  }

  // seen now contains all required named types (including enums/inputs/interfaces/etc)
  const selectedTypeNames = seen;

  console.log(`Selected named types: ${selectedTypeNames.size}`);
  console.log(`Directive defs:       ${directiveDefs.length} (kept all)`);
  console.log(`Scalar defs:          ${scalarDefs.length} (kept all)`);

  // Emit filtered document in original order, but:
  // - schema definition is replaced with pruned ops
  // - root operation type defs are replaced with pruned defs
  // - only include named type defs where name is in selectedTypeNames
  const outDefs = [];
  for (const d of defs) {
    if (d.kind === Kind.SCHEMA_DEFINITION) {
      if (effectiveSchemaDef && effectiveSchemaDef.operationTypes.length) outDefs.push(effectiveSchemaDef);
      continue;
    }

    if (d.kind === Kind.SCHEMA_EXTENSION) {
      // Keep schema extensions only if they still reference kept ops (rare here). For safety, keep as-is.
      outDefs.push(d);
      continue;
    }

    if (d.kind === Kind.DIRECTIVE_DEFINITION) {
      outDefs.push(d);
      continue;
    }

    if (d.kind === Kind.SCALAR_TYPE_DEFINITION) {
      outDefs.push(d);
      continue;
    }

    const name = defName(d);
    if (!name) {
      // e.g. schema-less definitions; keep them (rare)
      outDefs.push(d);
      continue;
    }

    if (!selectedTypeNames.has(name)) continue;

    let effective = prunedNodeByOriginal.get(d) || d;
    if (cfg.pruneForeign) effective = pruneForeignRefs(effective, isAllowedTypeName);

    // If root object ended up with 0 fields (e.g. Subscription) skip it entirely
    if (isRootTypeName(name)) {
      const fields = effective.fields || [];
      if (!fields.length) continue;
    }

    // Drop unions that end up with no member types
    if (
      (effective.kind === Kind.UNION_TYPE_DEFINITION ||
        effective.kind === Kind.UNION_TYPE_EXTENSION) &&
      (effective.types || []).length === 0
    ) {
      continue;
    }

    outDefs.push(effective);
  }

  const outDoc = { ...doc, definitions: outDefs };
  const outSDL = print(outDoc) + "\n";

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, outSDL, "utf8");
  console.log(`Wrote ${(outSDL.length / 1024 / 1024).toFixed(2)} MB`);

  if (cfg.validate) {
    console.log("Validating by building schema...");
    // This will throw if directives/types are missing or invalid.
    buildASTSchema(outDoc, { assumeValidSDL: false });
    console.log("✓ Valid SDL");
  } else {
    console.log("Skipped validation.");
  }

  console.log("✓ Done");
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error("Error:", err && err.message ? err.message : err);
    process.exit(1);
  }
}


