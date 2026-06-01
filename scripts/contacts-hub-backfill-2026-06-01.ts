#!/usr/bin/env bun
// scripts/contacts-hub-backfill-2026-06-01.ts
//
// One-time backfill: link every ISLANDED page under `3-resources/contacts/people/`
// to the `personal/_index` hub. Mirrors scripts/personal-hub-backfill-2026-05-17.ts
// (which handled the `people/*` population) for the contact stubs that re-landed
// under the 3-resources/contacts/people/ prefix and were never linked.
//
// Why: orphan-crisis follow-up (2026-06-01). After restoring the orphan-metric
// exclusions, ~1,009 islanded `person` stubs remained under
// 3-resources/contacts/people/ — auto-extracted contact stubs ("Stub — no notes
// yet.") with no inbound or outbound links. They belong to the personal contact
// network hub by location; linking de-islands them.
//
// Direction: contact -> hub (link_type 'hub_member', "X is a member of the
// Personal hub"). Deliberately NOT hub -> contact: a hub that links to everyone
// would hollow-inflate the inbound link_coverage metric. De-island only.
//
// DB-driven (not vault-scanned): the canonical script scanned vault files for
// [[Personal]] and derived people/{slug}; this population already exists as
// gbrain pages at the contacts/people/ prefix, so we select them directly.
//
// Provenance: link_source='manual' (survives put_page reconciliation,
// operations.ts), context='contacts-hub-backfill-2026-06-01' (precise rollback):
//   DELETE FROM links WHERE link_source='manual'
//     AND context='contacts-hub-backfill-2026-06-01';
//
// Idempotent: addLinksBatch is ON CONFLICT DO NOTHING; we also pre-exclude
// already-linked (contact, hub) edges. Safe to re-run.
//
// Run:
//   DATABASE_URL=postgresql://...:6543/... bun run scripts/contacts-hub-backfill-2026-06-01.ts          # dry-run (default)
//   DATABASE_URL=... bun run scripts/contacts-hub-backfill-2026-06-01.ts --apply                        # write
//   ... --limit N   process only first N (slug-sorted)

import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { LinkBatchInput } from '../src/core/engine.ts';

const APPLY = process.argv.includes('--apply');
const LIMIT = (() => {
  const i = process.argv.indexOf('--limit');
  if (i < 0 || i + 1 >= process.argv.length) return Infinity;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
})();

const DB_URL = process.env.DATABASE_URL || process.env.GBRAIN_DIRECT_DATABASE_URL;
if (!DB_URL) { console.error('Set DATABASE_URL (or GBRAIN_DIRECT_DATABASE_URL)'); process.exit(1); }

const LINK_SOURCE = 'manual';
const CONTEXT_MARKER = 'contacts-hub-backfill-2026-06-01';
const HUB_SLUG = 'personal/_index';
const LINK_TYPE = 'hub_member';
const PREFIX = '3-resources/contacts/people/%';
const BATCH_SIZE = 500;

async function main(): Promise<void> {
  const eng = new PostgresEngine();
  await eng.connect({ database_url: DB_URL });
  try {
    const sql = eng.sql;
    console.log(`[contacts-hub-backfill] mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN'}  limit: ${LIMIT === Infinity ? 'none' : LIMIT}`);
    console.log(`[contacts-hub-backfill] hub: ${HUB_SLUG}  link_source: '${LINK_SOURCE}'  context: '${CONTEXT_MARKER}'`);

    // 1. Hub source_id (required for source-qualified addLinksBatch).
    const hubRows = await sql<Array<{ source_id: string }>>`
      SELECT source_id FROM pages WHERE slug = ${HUB_SLUG} AND deleted_at IS NULL LIMIT 1
    `;
    if (hubRows.length === 0) { console.error(`FATAL: hub '${HUB_SLUG}' not found`); process.exit(2); }
    const hubSourceId = hubRows[0].source_id;
    console.log(`[contacts-hub-backfill] hub source_id='${hubSourceId}'`);

    // 2. Select ISLANDED contact pages under the prefix (no inbound AND no outbound).
    const candidates = await sql<Array<{ slug: string; source_id: string }>>`
      SELECT p.slug, p.source_id
      FROM pages p
      WHERE p.deleted_at IS NULL
        AND p.slug LIKE ${PREFIX}
        AND NOT EXISTS (SELECT 1 FROM links l WHERE l.to_page_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM links l WHERE l.from_page_id = p.id)
      ORDER BY p.slug
      ${LIMIT === Infinity ? sql`` : sql`LIMIT ${LIMIT}`}
    `;
    console.log(`[contacts-hub-backfill] islanded candidates under ${PREFIX}: ${candidates.length}`);
    if (candidates.length === 0) { console.log('nothing to do.'); return; }

    // 3. Pre-exclude any already-linked (contact -> hub) edges (idempotency clarity).
    const slugList = candidates.map(c => c.slug);
    const existing = await sql<Array<{ from_slug: string; from_source_id: string }>>`
      SELECT f.slug AS from_slug, f.source_id AS from_source_id
      FROM links l
      JOIN pages f ON l.from_page_id = f.id
      JOIN pages t ON l.to_page_id = t.id
      WHERE t.slug = ${HUB_SLUG} AND t.source_id = ${hubSourceId} AND f.slug = ANY(${slugList})
    `;
    const alreadyLinked = new Set(existing.map(r => `${r.from_slug} ${r.from_source_id}`));

    // 4. Stage batch.
    const batch: LinkBatchInput[] = [];
    let skippedAlready = 0;
    for (const c of candidates) {
      if (alreadyLinked.has(`${c.slug} ${c.source_id}`)) { skippedAlready++; continue; }
      batch.push({
        from_slug: c.slug,
        to_slug: HUB_SLUG,
        link_type: LINK_TYPE,
        context: CONTEXT_MARKER,
        link_source: LINK_SOURCE,
        from_source_id: c.source_id,
        to_source_id: hubSourceId,
      });
    }
    console.log(`[contacts-hub-backfill] plan: will link ${batch.length}, skip (already linked) ${skippedAlready}`);
    if (batch.length) console.log(`  sample: ${batch.slice(0,5).map(b => b.from_slug).join(', ')}`);

    if (!APPLY) { console.log('[contacts-hub-backfill] DRY-RUN: no writes. Re-run with --apply.'); return; }
    if (batch.length === 0) { console.log('nothing to write.'); return; }

    // 5. Write in chunks. ON CONFLICT DO NOTHING.
    let inserted = 0;
    for (let i = 0; i < batch.length; i += BATCH_SIZE) {
      inserted += await eng.addLinksBatch(batch.slice(i, i + BATCH_SIZE));
    }
    console.log(`[contacts-hub-backfill] inserted ${inserted} link rows.`);
    console.log(`[contacts-hub-backfill] rollback: DELETE FROM links WHERE link_source='manual' AND context='${CONTEXT_MARKER}';`);
  } finally {
    await eng.disconnect();
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
