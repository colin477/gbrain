#!/usr/bin/env bun
// scripts/orphan-hub-backfill-2026-06-16.ts
//
// Generalized de-island backfill for the brain_score "orphan" metric.
// Gives every counted-orphan page ONE outbound link to a real anchor so it
// stops being islanded (orphan = no inbound AND no outbound). Raising the
// linked share lifts both no_orphans_score and link_density_score.
//
// Generalizes scripts/contacts-hub-backfill-2026-06-01.ts (which handled only
// the 3-resources/contacts/people/ prefix → personal/_index) to ALL namespaces,
// using a tiered resolver instead of a single hardcoded hub.
//
// PREDICATE — mirrors postgres-engine.ts getHealth orphan_pages EXACTLY so the
// set we fix is the set the score counts:
//   no inbound link AND no outbound link, deleted_at IS NULL,
//   slug NOT LIKE emails/ attachments/ 0-daily/ 4-archive/ calendar/
//                 templates/ navigation/
//
// RESOLVER (per orphan, first match wins):
//   1. parent-slug   — nearest existing ancestor page (drop trailing /segments;
//                      also try <ancestor>/_index). link_type 'child_of'.
//                      Semantically exact for workstream/sub-page → parent.
//   2. namespace-hub — first EXISTING candidate among a small per-namespace hub
//                      list (e.g. 3-resources/contacts/* → personal/_index;
//                      concepts → concepts/pai-lessons; <ns>/_index). 'hub_member'.
//   3. unresolved    — reported, skipped (never invents a target).
//
// Direction: orphan -> anchor (de-island only). Never anchor -> orphan: a hub
// linking to everyone would hollow-inflate inbound link_coverage (same rationale
// as the 2026-06-01 script).
//
// Provenance (precise rollback):
//   link_source='manual', context='orphan-hub-backfill-2026-06-16'
//   DELETE FROM links WHERE link_source='manual'
//     AND context='orphan-hub-backfill-2026-06-16';
//
// Idempotent: addLinksBatch is ON CONFLICT DO NOTHING; we also pre-exclude
// orphans that already have ANY link (they would no longer match the predicate).
//
// Run (dry-run default):
//   bun run scripts/orphan-hub-backfill-2026-06-16.ts
//   bun run scripts/orphan-hub-backfill-2026-06-16.ts --apply
//   bun run scripts/orphan-hub-backfill-2026-06-16.ts --limit 50
//
// NOTE: decisions/ orphans are better served by MaterializeDecisionLinks.ts
// (decides-for → project, per CLAUDE.md). This script will hub-link any that
// remain, but run that tool first for semantically richer decision edges.

import { loadConfig } from '../src/core/config.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { LinkBatchInput } from '../src/core/engine.ts';

const APPLY = process.argv.includes('--apply');
const LIMIT = (() => {
  const i = process.argv.indexOf('--limit');
  if (i < 0 || i + 1 >= process.argv.length) return Infinity;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
})();

const LINK_SOURCE = 'manual';
const CONTEXT_MARKER = 'orphan-hub-backfill-2026-06-16';
const BATCH_SIZE = 500;

// Per-namespace hub candidates, tried in order; first that EXISTS is used.
// Keep these to real, durable anchor pages. {prefix} rules match by slug LIKE.
const NS_HUBS: Record<string, string[]> = {
  '3-resources': ['3-resources/_index', 'personal/_index'],
  projects: ['projects/_index'],
  '2-projects': ['projects/_index'],
  companies: ['companies/_index', '2-areas/_index'],
  reference: ['reference/_index', 'concepts/pai-lessons'],
  concepts: ['concepts/pai-lessons', 'concepts/_index'],
  '2-areas': ['2-areas/_index'],
  decisions: ['decisions/_index'],
  programs: ['programs/_index'],
  tickets: ['tickets/_index'],
  telos: ['telos/_index', 'telos-core/_index'],
  people: ['personal/_index', 'people/_index'],
  personal: ['personal/_index'],
};
// Prefix-specific overrides (checked before NS_HUBS): contact stubs → personal hub.
const PREFIX_HUBS: Array<{ like: string; hubs: string[] }> = [
  { like: '3-resources/contacts/', hubs: ['personal/_index'] },
  { like: '3-resources/ai-resources/', hubs: ['3-resources/ai-resources/_index', '3-resources/_index'] },
];

function ancestorCandidates(slug: string): string[] {
  const parts = slug.split('/');
  const out: string[] = [];
  // drop trailing segments one at a time: a/b/c -> a/b, a/b/_index, a, a/_index
  for (let cut = parts.length - 1; cut >= 1; cut--) {
    const anc = parts.slice(0, cut).join('/');
    out.push(anc);
    out.push(`${anc}/_index`);
  }
  return out;
}

async function main(): Promise<void> {
  const cfg: any = loadConfig();
  const url = cfg?.database_url || process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) { console.error('FATAL: no database_url in ~/.gbrain/config.json or env'); process.exit(1); }

  const eng = new PostgresEngine();
  await eng.connect({ database_url: url });
  try {
    const sql = eng.sql;
    console.log(`[orphan-hub-backfill] mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN'}  limit: ${LIMIT === Infinity ? 'none' : LIMIT}`);
    console.log(`[orphan-hub-backfill] link_source='${LINK_SOURCE}'  context='${CONTEXT_MARKER}'`);

    // Map slug -> source_id for every live page (for anchor existence + qualification).
    const allPages = await sql<Array<{ slug: string; source_id: string }>>`
      SELECT slug, source_id FROM pages WHERE deleted_at IS NULL
    `;
    const pageSource = new Map<string, string>();
    for (const p of allPages) pageSource.set(p.slug, p.source_id);
    const exists = (slug: string) => pageSource.has(slug);

    const stats = await eng.getStats();
    const pageCount = stats.page_count;
    const linkCount = stats.link_count;

    // Counted-orphans — EXACT score predicate.
    const orphans = await sql<Array<{ slug: string; source_id: string }>>`
      SELECT p.slug, p.source_id
      FROM pages p
      WHERE NOT EXISTS (SELECT 1 FROM links l WHERE l.to_page_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM links l WHERE l.from_page_id = p.id)
        AND p.deleted_at IS NULL
        AND p.slug NOT LIKE 'emails/%'
        AND p.slug NOT LIKE 'attachments/%'
        AND p.slug NOT LIKE '0-daily/%'
        AND p.slug NOT LIKE '4-archive/%'
        AND p.slug NOT LIKE 'calendar/%'
        AND p.slug NOT LIKE 'templates/%'
        AND p.slug NOT LIKE 'navigation/%'
      ORDER BY p.slug
      ${LIMIT === Infinity ? sql`` : sql`LIMIT ${LIMIT}`}
    `;
    console.log(`[orphan-hub-backfill] counted-orphans: ${orphans.length}  (page_count=${pageCount}, link_count=${linkCount})`);

    // Resolve each orphan to an anchor.
    const batch: LinkBatchInput[] = [];
    let viaParent = 0, viaHub = 0;
    const unresolved: string[] = [];
    const hubUse = new Map<string, number>();

    for (const o of orphans) {
      let target: string | null = null;
      let linkType = 'hub_member';

      // 1. parent-slug
      for (const anc of ancestorCandidates(o.slug)) {
        if (anc !== o.slug && exists(anc)) { target = anc; linkType = 'child_of'; break; }
      }
      // 2. namespace hub (prefix overrides first, then NS_HUBS)
      if (!target) {
        const ns = o.slug.split('/')[0];
        let candidates: string[] = [];
        for (const pr of PREFIX_HUBS) if (o.slug.startsWith(pr.like)) { candidates = pr.hubs; break; }
        if (candidates.length === 0) candidates = NS_HUBS[ns] || [];
        for (const h of candidates) {
          if (h !== o.slug && exists(h)) { target = h; linkType = 'hub_member'; break; }
        }
      }

      if (!target) { unresolved.push(o.slug); continue; }
      hubUse.set(target, (hubUse.get(target) || 0) + 1);
      if (linkType === 'child_of') viaParent++; else viaHub++;
      batch.push({
        from_slug: o.slug,
        to_slug: target,
        link_type: linkType,
        context: CONTEXT_MARKER,
        link_source: LINK_SOURCE,
        from_source_id: o.source_id,
        to_source_id: pageSource.get(target)!,
      });
    }

    // Report.
    const resolved = batch.length;
    console.log(`\n[resolution] resolved ${resolved}/${orphans.length}  (parent ${viaParent}, hub ${viaHub}, unresolved ${unresolved.length})`);
    const topHubs = [...hubUse.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    console.log('[top anchors]'); for (const [h, n] of topHubs) console.log(`  ${String(n).padStart(4)}  ${h}`);
    if (unresolved.length) {
      const byNs = new Map<string, number>();
      for (const s of unresolved) byNs.set(s.split('/')[0], (byNs.get(s.split('/')[0]) || 0) + 1);
      console.log('[unresolved by namespace]');
      for (const [ns, n] of [...byNs.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${ns}`);
      console.log(`  sample: ${unresolved.slice(0, 8).join(', ')}`);
    }

    // Projected score deltas (orphan + link_density components only).
    const newOrphans = Math.max(0, 803 /*baseline metric set*/ - resolved); // approximate; engine recomputes on next get_health
    const projOrphanSet = orphans.length - resolved;
    const noOrphansNow = Math.round((1 - orphans.length / pageCount) * 15);
    const noOrphansAfter = Math.round((1 - projOrphanSet / pageCount) * 15);
    const ldNow = Math.round(Math.min(linkCount / pageCount, 1) * 25);
    const ldAfter = Math.round(Math.min((linkCount + resolved) / pageCount, 1) * 25);
    console.log(`\n[projection] no_orphans_score ${noOrphansNow}->${noOrphansAfter}   link_density_score ${ldNow}->${ldAfter}`);
    console.log(`[projection] counted-orphans ${orphans.length}->${projOrphanSet}   links ${linkCount}->${linkCount + resolved}`);

    if (!APPLY) { console.log('\n[orphan-hub-backfill] DRY-RUN: no writes. Re-run with --apply.'); return; }
    if (batch.length === 0) { console.log('nothing to write.'); return; }

    let inserted = 0;
    for (let i = 0; i < batch.length; i += BATCH_SIZE) {
      inserted += await eng.addLinksBatch(batch.slice(i, i + BATCH_SIZE));
    }
    console.log(`\n[orphan-hub-backfill] inserted ${inserted} link rows.`);
    console.log(`[orphan-hub-backfill] rollback: DELETE FROM links WHERE link_source='manual' AND context='${CONTEXT_MARKER}';`);
  } finally {
    await eng.disconnect();
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
