#!/usr/bin/env bun
// scripts/frontmatter-backfill-orphan-recovery.ts
//
// One-time backfill: materialize frontmatter slug references as links rows.
// Many pages carry frontmatter fields like `parent: "projects/foo"` or
// `related: ["decisions/bar", ...]` that were never inserted into the
// links table. This script reads every page's frontmatter, extracts slug
// references, and inserts the missing links via `addLinksBatch` (which
// handles dead-ref skipping via INNER JOIN and idempotency via ON CONFLICT
// DO NOTHING).
//
// v1 scope: SLUG-FORM fields only. Display-name fields (company, companies)
// require fuzzy resolve to companies/* — those are dumped to a CSV for
// manual review and a future v2 pass.
//
// Provenance: link_source='manual', context='backfill-2026-05-17'.
//   - 'manual' makes these links survive put_page reconciliation (which only
//     touches link_source IN ('markdown', NULL, 'frontmatter')) so the backfill
//     is durable across vault re-syncs.
//   - 'context' marker enables a precise rollback:
//     DELETE FROM links WHERE link_source='manual' AND context='backfill-2026-05-17';
//
// Source-id correctness: pages.slug is unique per source_id, so the script
// queries each page's source_id and passes it through. For the target page,
// looks up source_id via a separate SELECT (NULL when target doesn't exist
// — addLinksBatch's INNER JOIN then drops the row, no dead-link risk).
//
// Run:
//   DATABASE_URL=postgresql://...:6543/... bun run scripts/frontmatter-backfill-orphan-recovery.ts [--dry-run]
//
// Outputs:
//   stdout: per-field breakdown + total new inserts
//   scripts/frontmatter-backfill-namematch-deferred.csv: name-form refs for v2

import { writeFileSync } from 'node:fs';

import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { LinkBatchInput } from '../src/core/engine.ts';

const DRY_RUN = process.argv.includes('--dry-run');
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error('Set DATABASE_URL');
  process.exit(1);
}

const LINK_SOURCE = 'manual';
const CONTEXT_MARKER = 'backfill-2026-05-17';

// Field → canonical link_type mapping. Where gbrain's normal extractor uses
// a canonical type (e.g., `related`/`see_also` → `related_to` per
// link-extraction.ts:630), match it so this backfill aligns semantically.
// For fields gbrain's extractor doesn't cover, use clear semantic types.
const SLUG_STRING_FIELDS: Array<{ field: string; type: string }> = [
  { field: 'parent', type: 'parent_of' },
  { field: 'parent_slug', type: 'parent_of' },
];

const SLUG_ARRAY_FIELDS: Array<{ field: string; type: string }> = [
  { field: 'related', type: 'related_to' },  // canonical (link-extraction.ts:630)
  { field: 'see_also', type: 'related_to' }, // canonical
  { field: 'workstreams', type: 'workstream_of' },
  { field: 'children', type: 'child_of' },
  { field: 'tickets', type: 'ticket_of' },
  { field: 'decisions', type: 'decision_of' },
];

const SLUG_POLY_FIELDS: Array<{ field: string; type: string }> = [
  { field: 'project', type: 'project_of' },
  { field: 'projects', type: 'project_of' },
];

const NAME_STRING_FIELDS = ['company'];
const NAME_ARRAY_FIELDS = ['companies'];

function looksLikeSlug(s: string): boolean {
  // Slugs are kebab-case with at least one '/' separator. Display names
  // have spaces, capital letters, or no slash. Conservative regex —
  // false-negatives (rejecting slugs with underscores/dots) are safer
  // than false-positives.
  return /^[a-z0-9][a-z0-9\-/]*$/.test(s) && s.includes('/');
}

async function main(): Promise<void> {
  const eng = new PostgresEngine();
  await eng.connect({ database_url: DB_URL });
  try {
    const sql = eng.sql;

    console.log(`[frontmatter-backfill] mode: ${DRY_RUN ? 'DRY-RUN' : 'WET'}`);
    console.log(`[frontmatter-backfill] link_source: '${LINK_SOURCE}'  context: '${CONTEXT_MARKER}'`);
    console.log(`[frontmatter-backfill] loading pages with non-empty frontmatter...`);

    const rows = await sql<Array<{ slug: string; source_id: string; frontmatter: Record<string, unknown> }>>`
      SELECT slug, source_id, frontmatter
      FROM pages
      WHERE deleted_at IS NULL
        AND frontmatter IS NOT NULL
        AND frontmatter::text != '{}'
    `;
    console.log(`[frontmatter-backfill] scanned ${rows.length} pages`);

    // Build slug → source_id map for target lookups. A target slug may exist
    // in multiple sources; pick the first match here (script is one-off, single
    // 'default' source on this brain). Production multi-source brains should
    // pass source_id through callers instead.
    const slugSources = new Map<string, string>();
    {
      const allPageRows = await sql<Array<{ slug: string; source_id: string }>>`
        SELECT slug, source_id FROM pages WHERE deleted_at IS NULL
      `;
      for (const r of allPageRows) {
        if (!slugSources.has(r.slug)) slugSources.set(r.slug, r.source_id);
      }
    }
    console.log(`[frontmatter-backfill] indexed ${slugSources.size} active page slugs for target resolution`);

    const staged: LinkBatchInput[] = [];
    const fieldCounts: Record<string, number> = {};
    const skippedNonSlug: Record<string, number> = {};
    const skippedDeadTarget: Record<string, number> = {};
    const deferredNames: Array<{ from_slug: string; field: string; value: string }> = [];

    for (const row of rows) {
      const fromSlug = row.slug;
      const fromSourceId = row.source_id ?? 'default';
      const fm = row.frontmatter;
      if (!fm || typeof fm !== 'object') continue;

      const addRef = (rawValue: unknown, field: string, linkType: string): void => {
        if (typeof rawValue !== 'string') return;
        const value = rawValue.trim();
        if (!value) return;
        if (!looksLikeSlug(value)) {
          skippedNonSlug[field] = (skippedNonSlug[field] ?? 0) + 1;
          return;
        }
        const toSourceId = slugSources.get(value);
        if (!toSourceId) {
          skippedDeadTarget[field] = (skippedDeadTarget[field] ?? 0) + 1;
          return;
        }
        staged.push({
          from_slug: fromSlug,
          to_slug: value,
          link_type: linkType,
          context: CONTEXT_MARKER,
          link_source: LINK_SOURCE,
          origin_slug: fromSlug,
          origin_field: field,
          from_source_id: fromSourceId,
          to_source_id: toSourceId,
          origin_source_id: fromSourceId,
        });
        fieldCounts[field] = (fieldCounts[field] ?? 0) + 1;
      };

      for (const { field, type } of SLUG_STRING_FIELDS) addRef(fm[field], field, type);

      for (const { field, type } of SLUG_POLY_FIELDS) {
        const v = fm[field];
        if (typeof v === 'string') addRef(v, field, type);
        else if (Array.isArray(v)) for (const x of v) addRef(x, field, type);
      }

      for (const { field, type } of SLUG_ARRAY_FIELDS) {
        const v = fm[field];
        if (Array.isArray(v)) for (const x of v) addRef(x, field, type);
      }

      for (const f of NAME_STRING_FIELDS) {
        const v = fm[f];
        if (typeof v === 'string' && v.trim() !== '') {
          deferredNames.push({ from_slug: fromSlug, field: f, value: v.trim() });
        }
      }
      for (const f of NAME_ARRAY_FIELDS) {
        const v = fm[f];
        if (Array.isArray(v)) {
          for (const x of v) {
            if (typeof x === 'string' && x.trim() !== '') {
              deferredNames.push({ from_slug: fromSlug, field: f, value: x.trim() });
            }
          }
        }
      }
    }

    console.log(`\n[frontmatter-backfill] staged ${staged.length} slug-form links`);
    console.log(`  by field:`);
    for (const [f, n] of Object.entries(fieldCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${f}: ${n}`);
    }

    const nonSlugTotal = Object.values(skippedNonSlug).reduce((a, b) => a + b, 0);
    if (nonSlugTotal > 0) {
      console.log(`\n[frontmatter-backfill] skipped ${nonSlugTotal} non-slug values in slug fields:`);
      for (const [f, n] of Object.entries(skippedNonSlug).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${f}: ${n}`);
      }
    }

    const deadTargetTotal = Object.values(skippedDeadTarget).reduce((a, b) => a + b, 0);
    if (deadTargetTotal > 0) {
      console.log(`\n[frontmatter-backfill] skipped ${deadTargetTotal} refs to non-existent target pages:`);
      for (const [f, n] of Object.entries(skippedDeadTarget).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${f}: ${n}`);
      }
    }

    console.log(`\n[frontmatter-backfill] deferred ${deferredNames.length} name-form refs (v2 fuzzy match)`);
    const csvPath = 'scripts/frontmatter-backfill-namematch-deferred.csv';
    const csvLines = ['from_slug,field,value'];
    for (const d of deferredNames) {
      const v = d.value.replace(/"/g, '""');
      csvLines.push(`${d.from_slug},${d.field},"${v}"`);
    }
    writeFileSync(csvPath, csvLines.join('\n') + '\n');
    console.log(`  written: ${csvPath}`);

    if (DRY_RUN) {
      console.log(`\n[frontmatter-backfill] DRY-RUN — no INSERTs performed`);
      return;
    }

    console.log(`\n[frontmatter-backfill] wet-inserting via addLinksBatch in chunks of 500...`);
    let requested = 0;
    let inserted = 0;
    const CHUNK = 500;
    for (let i = 0; i < staged.length; i += CHUNK) {
      const chunk = staged.slice(i, i + CHUNK);
      requested += chunk.length;
      const n = await eng.addLinksBatch(chunk);
      inserted += n;
      console.log(`  chunk ${i / CHUNK + 1}: requested ${chunk.length}, inserted ${n}`);
    }

    console.log(`\n[frontmatter-backfill] DONE`);
    console.log(`  requested: ${requested}`);
    console.log(`  inserted (new): ${inserted}`);
    console.log(`  duplicates (already present): ${requested - inserted}`);
    console.log(`\n  Rollback: DELETE FROM links WHERE link_source='${LINK_SOURCE}' AND context='${CONTEXT_MARKER}';`);
  } finally {
    await eng.disconnect();
  }
}

main().catch((e) => {
  console.error('[frontmatter-backfill] FATAL', e);
  process.exit(1);
});
