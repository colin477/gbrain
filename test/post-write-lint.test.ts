/**
 * Post-write validator lint tests (PR 2.5 minimal integration).
 *
 * Feature-flag gated; default OFF means zero behavior change to put_page.
 * When ON, runs the 4 BrainWriter validators and logs findings without
 * rejecting the write. Strict-mode flip is out of scope; deferred per
 * CEO plan.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { runPostWriteLint, isLintOnPutPageEnabled, getCitationExemptTypes } from '../src/core/output/post-write.ts';

let engine: BrainEngine;
let dbDir: string;

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'postwrite-'));
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
  await engine.executeRaw(`DELETE FROM config WHERE key = 'writer.lint_on_put_page'`);
}

describe('isLintOnPutPageEnabled', () => {
  beforeEach(async () => { await reset(); });

  test('defaults false when config unset', async () => {
    expect(await isLintOnPutPageEnabled(engine)).toBe(false);
  });

  test('true when config = true', async () => {
    await engine.setConfig('writer.lint_on_put_page', 'true');
    expect(await isLintOnPutPageEnabled(engine)).toBe(true);
  });

  test('true when config = 1', async () => {
    await engine.setConfig('writer.lint_on_put_page', '1');
    expect(await isLintOnPutPageEnabled(engine)).toBe(true);
  });

  test('false for any other value', async () => {
    await engine.setConfig('writer.lint_on_put_page', 'maybe');
    expect(await isLintOnPutPageEnabled(engine)).toBe(false);
  });

  test('false when config = false', async () => {
    await engine.setConfig('writer.lint_on_put_page', 'false');
    expect(await isLintOnPutPageEnabled(engine)).toBe(false);
  });
});

describe('runPostWriteLint', () => {
  beforeEach(async () => { await reset(); });

  test('flag disabled → returns ran=false, no findings', async () => {
    await engine.putPage('people/x', {
      type: 'person', title: 'X', compiled_truth: 'X has a bare factual paragraph without a citation.',
      frontmatter: {},
    });
    const r = await runPostWriteLint(engine, 'people/x');
    expect(r.ran).toBe(false);
    expect(r.skippedReason).toBe('flag_disabled');
    expect(r.findings).toEqual([]);
  });

  test('page not found → returns ran=false', async () => {
    const r = await runPostWriteLint(engine, 'people/ghost', { force: true });
    expect(r.ran).toBe(false);
    expect(r.skippedReason).toBe('page_not_found');
  });

  test('validate:false frontmatter → skipped (grandfather)', async () => {
    await engine.putPage('people/old', {
      type: 'person', title: 'Old', compiled_truth: 'Lots of factual paragraphs without citations.',
      frontmatter: { validate: false },
    });
    const r = await runPostWriteLint(engine, 'people/old', { force: true });
    expect(r.ran).toBe(false);
    expect(r.skippedReason).toBe('validate_false_frontmatter');
  });

  test('forces run even when flag is off', async () => {
    await engine.putPage('people/y', {
      type: 'person', title: 'Y', compiled_truth: 'Y raised money [Source: X, 2026-04-18](https://x.com/y).',
      frontmatter: {},
    });
    const r = await runPostWriteLint(engine, 'people/y', { force: true, noLog: true });
    expect(r.ran).toBe(true);
  });

  test('flag on + bad page → findings include citation error', async () => {
    await engine.setConfig('writer.lint_on_put_page', 'true');
    await engine.putPage('people/bad', {
      type: 'person', title: 'Bad', compiled_truth: 'Bad raised $5M in Series A from Sequoia without citation.',
      frontmatter: {},
    });
    const r = await runPostWriteLint(engine, 'people/bad', { noLog: true });
    expect(r.ran).toBe(true);
    expect(r.findings.length).toBeGreaterThan(0);
    const citationError = r.findings.find(f => f.validator === 'citation' && f.severity === 'error');
    expect(citationError).toBeDefined();
  });

  test('flag on + clean page → zero findings', async () => {
    await engine.setConfig('writer.lint_on_put_page', 'true');
    await engine.putPage('people/clean', {
      type: 'person', title: 'Clean',
      compiled_truth: '## See Also\n- [Source: X/clean, 2026-04-18](https://x.com/clean/status/1)',
      frontmatter: {},
    });
    const r = await runPostWriteLint(engine, 'people/clean', { noLog: true });
    expect(r.ran).toBe(true);
    expect(r.findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Citation scoping by page type
//
// The citation validator asserts provenance. Operational/authored pages have
// no external source to cite and failed by construction, producing 96% of all
// soak findings (1,321 of 1,375 across 250 events, measured 2026-08-04).
// They are exempt; everything else — entity and research pages especially —
// keeps enforcement.
// ---------------------------------------------------------------------------

describe('citation scoping by page type', () => {
  beforeEach(async () => {
    await reset();
    await engine.executeRaw(`DELETE FROM config WHERE key = 'writer.citation_exempt_types'`);
  });

  const UNCITED = 'The pipeline has 43,457 rows and the unique index was verified valid.';

  test('exempt type (project) → no citation findings', async () => {
    await engine.putPage('projects/comms', {
      type: 'project', title: 'Comms', compiled_truth: UNCITED, frontmatter: {},
    });
    const r = await runPostWriteLint(engine, 'projects/comms', { force: true, noLog: true });
    expect(r.ran).toBe(true);
    expect(r.findings.filter(f => f.validator === 'citation')).toEqual([]);
  });

  test('exempt type (decision) → no citation findings', async () => {
    // NOTE: 'decision' is deliberately cast. The PageType union in
    // src/core/types.ts carries 22 values and does NOT include 'decision',
    // 'reference' or 'ticket' — but production stores 78 distinct type
    // strings, including 67 'decision' pages. Pages are persisted with
    // arbitrary type strings, so the exemption matches on the stored value.
    // Casting here keeps the test honest about the real-world case that
    // motivated this scoping rather than substituting a union-legal type.
    await engine.putPage('decisions/adr-1', {
      type: 'decision' as any, title: 'ADR 1', compiled_truth: UNCITED, frontmatter: {},
    });
    const r = await runPostWriteLint(engine, 'decisions/adr-1', { force: true, noLog: true });
    expect(r.findings.filter(f => f.validator === 'citation')).toEqual([]);
  });

  test('exempt non-union type strings (reference, ticket) are honoured at runtime', async () => {
    for (const [slug, type] of [['reference/x', 'reference'], ['tickets/x', 'ticket']]) {
      await engine.putPage(slug, {
        type: type as any, title: 'X', compiled_truth: UNCITED, frontmatter: {},
      });
      const r = await runPostWriteLint(engine, slug, { force: true, noLog: true });
      expect(r.findings.filter(f => f.validator === 'citation')).toEqual([]);
    }
  });

  test('REGRESSION GUARD: entity pages still require citations', async () => {
    // person/company are researched, not authored — provenance still matters.
    for (const [slug, type] of [['people/z', 'person'], ['companies/z', 'company']] as const) {
      await engine.putPage(slug, {
        type, title: 'Z',
        compiled_truth: 'Z raised $5M in Series A from Sequoia without citation.',
        frontmatter: {},
      });
      const r = await runPostWriteLint(engine, slug, { force: true, noLog: true });
      expect(r.findings.some(f => f.validator === 'citation')).toBe(true);
    }
  });

  test('imported type (source) still requires citations', async () => {
    await engine.putPage('sources/article', {
      type: 'source', title: 'Article', compiled_truth: UNCITED, frontmatter: {},
    });
    const r = await runPostWriteLint(engine, 'sources/article', { force: true, noLog: true });
    expect(r.findings.some(f => f.validator === 'citation')).toBe(true);
  });

  test('structural validators still run on exempt types', async () => {
    // The exemption must lift ONLY citation — integrity checks are
    // type-independent and must survive.
    await engine.putPage('projects/structural', {
      type: 'project', title: 'S', compiled_truth: UNCITED, frontmatter: {},
    });
    const r = await runPostWriteLint(engine, 'projects/structural', { force: true, noLog: true });
    expect(r.ran).toBe(true);
    expect(r.findings.every(f => f.validator !== 'citation')).toBe(true);
  });

  test('config override replaces the default set entirely', async () => {
    await engine.setConfig('writer.citation_exempt_types', 'person');
    // person now exempt...
    await engine.putPage('people/override', {
      type: 'person', title: 'O', compiled_truth: UNCITED, frontmatter: {},
    });
    const rp = await runPostWriteLint(engine, 'people/override', { force: true, noLog: true });
    expect(rp.findings.filter(f => f.validator === 'citation')).toEqual([]);
    // ...and project is NOT, because the override replaces rather than merges.
    await engine.putPage('projects/override', {
      type: 'project', title: 'O', compiled_truth: UNCITED, frontmatter: {},
    });
    const rj = await runPostWriteLint(engine, 'projects/override', { force: true, noLog: true });
    expect(rj.findings.some(f => f.validator === 'citation')).toBe(true);
  });

  test('empty config value restores enforcement everywhere', async () => {
    await engine.setConfig('writer.citation_exempt_types', '');
    await engine.putPage('projects/strict', {
      type: 'project', title: 'Strict', compiled_truth: UNCITED, frontmatter: {},
    });
    const r = await runPostWriteLint(engine, 'projects/strict', { force: true, noLog: true });
    expect(r.findings.some(f => f.validator === 'citation')).toBe(true);
  });

  test('getCitationExemptTypes defaults when config unset', async () => {
    const s = await getCitationExemptTypes(engine);
    expect(s.has('project')).toBe(true);
    expect(s.has('decision')).toBe(true);
    expect(s.has('person')).toBe(false);
    expect(s.has('source')).toBe(false);
  });
});
