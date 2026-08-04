/**
 * page_type_drift doctor check.
 *
 * `pages.type` is TEXT with no enum and no CHECK, so any string persists.
 * That is deliberate (StoredPageType), but it let the canonical PageType
 * union drift out of sync with the data silently — 66 non-canonical types
 * across 3,031 pages by 2026-08-04, discovered only by hand-grepping.
 * This check makes the gap self-reporting.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { pageTypeDriftCheck, PAGE_TYPE_DRIFT_MIN_PAGES } from '../src/commands/doctor.ts';

let engine: BrainEngine;
let dbDir: string;

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'pagetypedrift-'));
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: dbDir });
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(dbDir, { recursive: true, force: true });
});

async function reset(): Promise<void> {
  await engine.executeRaw('TRUNCATE pages, links, content_chunks, timeline_entries, tags, raw_data, page_versions, ingest_log RESTART IDENTITY CASCADE');
}

/** Write n pages of a given type. Slugs must satisfy the projects/ namespace CHECK. */
async function seed(type: string, n: number, prefix = 'x'): Promise<void> {
  for (let i = 0; i < n; i++) {
    const slug = type === 'project' ? `projects/${prefix}-${i}` : `${prefix}-${type}/${i}`;
    await engine.putPage(slug, {
      type: type as any,
      title: `${type} ${i}`,
      compiled_truth: 'body',
      frontmatter: {},
    });
  }
}

describe('pageTypeDriftCheck', () => {
  beforeEach(async () => { await reset(); });

  test('empty brain → ok', async () => {
    const c = await pageTypeDriftCheck(engine);
    expect(c.name).toBe('page_type_drift');
    expect(c.status).toBe('ok');
    expect(c.message).toContain('No pages yet');
  });

  test('all canonical types → ok', async () => {
    await seed('person', 3);
    await seed('concept', 2);
    const c = await pageTypeDriftCheck(engine);
    expect(c.status).toBe('ok');
    expect(c.message).toContain('all canonical');
  });

  test('non-canonical below threshold → ok, reported as one-offs not taxonomy', async () => {
    await seed('person', 5);
    await seed('crontab', PAGE_TYPE_DRIFT_MIN_PAGES - 1);
    const c = await pageTypeDriftCheck(engine);
    expect(c.status).toBe('ok');
    expect(c.message).toContain('one-offs');
  });

  test('non-canonical at threshold → warn, names the type and the fix', async () => {
    await seed('person', 5);
    await seed('decision', PAGE_TYPE_DRIFT_MIN_PAGES);
    const c = await pageTypeDriftCheck(engine);
    expect(c.status).toBe('warn');
    expect(c.message).toContain('decision');
    expect(c.message).toContain(`${PAGE_TYPE_DRIFT_MIN_PAGES}`);
    // The message must say what to DO, not just that something is wrong.
    expect(c.message).toContain('src/core/types.ts');
  });

  test('never fails — unknown types break nothing at runtime', async () => {
    // A doctor that fails on a benign condition trains people to ignore it.
    await seed('decision', 40);
    await seed('reference', 30);
    await seed('ticket', 20);
    const c = await pageTypeDriftCheck(engine);
    expect(c.status).toBe('warn');
    expect(c.status).not.toBe('fail');
  });

  test('soft-deleted pages are excluded from the census', async () => {
    await seed('person', 3);
    await seed('decision', PAGE_TYPE_DRIFT_MIN_PAGES);
    const before = await pageTypeDriftCheck(engine);
    expect(before.status).toBe('warn');

    await engine.executeRaw(`UPDATE pages SET deleted_at = now() WHERE type = 'decision'`);
    const after = await pageTypeDriftCheck(engine);
    expect(after.status).toBe('ok');
    expect(after.message).toContain('all canonical');
  });

  test('reports percentage of pages on non-canonical types', async () => {
    await seed('person', 10);
    await seed('decision', 10);
    const c = await pageTypeDriftCheck(engine);
    expect(c.status).toBe('warn');
    expect(c.message).toContain('50.0%');
  });
});
