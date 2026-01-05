## Datafordeler GraphQL schema filter

This repo contains a small CLI that filters a very large Datafordeler GraphQL SDL schema down to only selected **registers** (by prefix, e.g. `BBR_`, `DAR_`, `CVR_`) **plus all transitive dependencies**, and prunes `Query`/`Mutation`/`Subscription` fields accordingly.

### Setup

```bash
npm install
```

### Usage

Filter the big FLEX schema to only include BBR + DAR:

```bash
node scripts/filter-schema.js --registers BBR,DAR --input schema/FLEX_V001.schema.graphql --output schema/FLEX_BBR_DAR.schema.graphql
```

If you want to **keep** cross-register joins (bigger output), disable foreign pruning:

```bash
node scripts/filter-schema.js --no-prune-foreign --registers BBR,DAR --input schema/FLEX_V001.schema.graphql --output schema/FLEX_BBR_DAR_fulljoins.schema.graphql
```

Filter the CVR-only schema:

```bash
node scripts/filter-schema.js --registers CVR --input schema/CVR_V001.schema.graphql --output schema/CVR_only.schema.graphql
```

### Notes

- The filter keeps **all directive definitions** and **all scalar definitions** (small overhead, improves schema validity).
- `Query`/`Mutation`/`Subscription` are **pruned** to keep only fields that match selected register prefixes (or whose return type matches).
- For very large schemas you can skip validation for speed:

```bash
node scripts/filter-schema.js --no-validate --registers BBR,DAR --input schema/FLEX_V001.schema.graphql --output schema/FLEX_BBR_DAR.schema.graphql
```


