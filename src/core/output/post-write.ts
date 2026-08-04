/**
 * Post-write validator hook — runs after put_page / importFromContent
 * succeeds, in LINT MODE only. Findings are logged; they do not reject
 * the write.
 *
 * This is the PR 2.5 minimal integration: we want observability on how
 * many pages the brain would reject in strict mode BEFORE flipping the
 * strict-mode default (CEO plan: "follow-on release gated on BrainBench
 * regression ≤1pt + 7-day soak + zero false-positive count").
 *
 * Gated on config `writer.lint_on_put_page`. Default: false (no change to
 * current put_page behavior). When enabled, findings land in:
 *   - ingest_log (via engine.logIngest) — durable, agent-inspectable
 *   - ~/.gbrain/validator-lint.jsonl — local file for drift-over-time analysis
 *
 * Pages with `validate: false` frontmatter skip the validators entirely
 * (grandfather opt-out from PR 2 migration).
 *
 * The `citation` validator is scoped BY PAGE TYPE: it runs everywhere EXCEPT
 * operational/authored types (config `writer.citation_exempt_types`, default
 * DEFAULT_CITATION_EXEMPT_TYPES below). Citation is the only validator
 * asserting provenance, and a page authored from first-hand measurement — a
 * project's state, a decision record, a ticket — has no external source to
 * cite and fails by construction. Measured 2026-08-04 over the soak log:
 * 1,321 of 1,375 findings across 250 write events (96%) were `citation`,
 * concentrated on exactly those types. Entity and research pages keep
 * enforcement. The other three validators run on EVERY page.
 */

import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { gbrainPath } from '../config.ts';

import type { BrainEngine } from '../engine.ts';
import {
  citationValidator,
  linkValidator,
  backLinkValidator,
  tripleHrValidator,
} from './validators/index.ts';
import type { ValidationFinding, PageValidator } from './writer.ts';

const getLintLogFile = () => gbrainPath('validator-lint.jsonl');
const LINT_CONFIG_KEY = 'writer.lint_on_put_page';
const CITATION_EXEMPT_TYPES_KEY = 'writer.citation_exempt_types';

/**
 * Page types EXEMPT from the citation validator: operational and authored
 * pages, whose content is produced in-brain by the operator rather than
 * drawn from an external source.
 *
 * Deliberately an exemption list, not an allowlist of "imported" types. The
 * citation invariant — no silent factual claims — is the right default and
 * must keep applying to entity pages (`person`, `company`) and to anything
 * researched, where "X raised $5M from Sequoia" genuinely needs provenance.
 * A new page type should therefore inherit enforcement, not escape it.
 *
 * What is exempted here is the class where a citation cannot exist: a
 * project's current state, a decision record, a runbook, a ticket. These are
 * first-hand claims about the operator's own systems, and the only honest
 * "source" is the measurement in the page itself.
 *
 * Measured against the soak log 2026-08-04: 1,321 of 1,375 findings (96%)
 * across 250 write events were `citation`, concentrated on exactly these
 * types (top recurring slugs were under reference/, projects/ and tickets/).
 */
export const DEFAULT_CITATION_EXEMPT_TYPES = [
  'project', 'project-note', 'decision', 'maintenance-decision', 'reference',
  'ticket', 'concept', 'hub', 'dashboard', 'index', 'template', 'config',
  'launchd', 'crontab', 'worker', 'utility', 'tasks', 'calendar-day', 'daily',
  'prd', 'technical-design', 'architecture', 'review', 'audit', 'assessment',
  'handoff', 'area', 'command-center', 'operating-doc', 'governance-document',
  'system-governance', 'status', 'generated', 'inventory-setup', 'guide',
  'telos-core', 'telos-index', 'telos-metrics', 'telos-narratives',
  'telos-outcomes', 'telos-status', 'telos-challenges',
] as const;

export interface PostWriteLintOpts {
  /** Override config lookup; used by tests. If true, always run. */
  force?: boolean;
  /** Skip file writes; used by tests. */
  noLog?: boolean;
}

export interface PostWriteLintResult {
  ran: boolean;
  slug: string;
  findings: ValidationFinding[];
  skippedReason?: string;
}

/**
 * Read the writer.lint_on_put_page flag. Returns true only when set to an
 * explicit enable value; anything else (unset, 'false', '0') is false.
 * Fails safe on read error.
 */
export async function isLintOnPutPageEnabled(engine: BrainEngine): Promise<boolean> {
  try {
    const v = await engine.getConfig(LINT_CONFIG_KEY);
    if (v === null || v === undefined) return false;
    const lc = v.toLowerCase();
    return lc === 'true' || lc === '1' || lc === 'yes' || lc === 'on';
  } catch {
    return false;
  }
}

/**
 * Resolve the set of page types exempt from the citation validator.
 *
 * Config `writer.citation_exempt_types` is a comma-separated list and
 * OVERRIDES the default entirely (not merged), so an operator can widen or
 * narrow the exemption without a code change. An explicitly empty value
 * restores citation enforcement on every type. Fails safe to the default on
 * read error — a config outage must not silently re-enable 96% noise.
 */
export async function getCitationExemptTypes(engine: BrainEngine): Promise<Set<string>> {
  try {
    const v = await engine.getConfig(CITATION_EXEMPT_TYPES_KEY);
    if (v !== null && v !== undefined) {
      return new Set(
        v.split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
      );
    }
  } catch {
    // fall through to default
  }
  return new Set<string>(DEFAULT_CITATION_EXEMPT_TYPES);
}

/**
 * Run the built-in validators on a freshly-written page.
 * Returns empty findings when:
 *   - flag disabled
 *   - page not found (shouldn't happen in normal put_page flow)
 *   - page has frontmatter.validate === false
 */
export async function runPostWriteLint(
  engine: BrainEngine,
  slug: string,
  opts: PostWriteLintOpts = {},
): Promise<PostWriteLintResult> {
  const enabled = opts.force ?? await isLintOnPutPageEnabled(engine);
  if (!enabled) {
    return { ran: false, slug, findings: [], skippedReason: 'flag_disabled' };
  }

  const page = await engine.getPage(slug);
  if (!page) {
    return { ran: false, slug, findings: [], skippedReason: 'page_not_found' };
  }

  if (page.frontmatter?.validate === false) {
    return { ran: false, slug, findings: [], skippedReason: 'validate_false_frontmatter' };
  }

  // Structural validators (link / back-link / triple-hr) run on every page —
  // they check integrity, which is type-independent. Citation asserts
  // provenance and is lifted off operational/authored types where no external
  // source can exist (see DEFAULT_CITATION_EXEMPT_TYPES).
  const validators: PageValidator[] = [linkValidator, backLinkValidator, tripleHrValidator];
  const exemptTypes = await getCitationExemptTypes(engine);
  if (!exemptTypes.has(String(page.type ?? '').toLowerCase())) {
    validators.unshift(citationValidator);
  }
  const ctx = {
    slug,
    type: page.type,
    compiledTruth: page.compiled_truth,
    timeline: page.timeline,
    frontmatter: page.frontmatter ?? {},
    engine,
  };

  const findings: ValidationFinding[] = [];
  for (const v of validators) {
    try {
      const out = await v.validate(ctx);
      for (const f of out) findings.push(f);
    } catch {
      // Validator-level failure shouldn't break the main put_page flow;
      // swallow and continue with other validators.
    }
  }

  if (findings.length > 0 && !opts.noLog) {
    writeLocalLintLog(slug, findings);
    await writeIngestLog(engine, slug, findings);
  }

  return { ran: true, slug, findings };
}

// ---------------------------------------------------------------------------
// Loggers
// ---------------------------------------------------------------------------

function writeLocalLintLog(slug: string, findings: ValidationFinding[]): void {
  try {
    const lintLogFile = getLintLogFile();
    const dir = dirname(lintLogFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      slug,
      error_count: findings.filter(f => f.severity === 'error').length,
      warning_count: findings.filter(f => f.severity === 'warning').length,
      findings: findings.slice(0, 20), // cap to prevent runaway log size
    }) + '\n';
    appendFileSync(lintLogFile, line, 'utf-8');
  } catch {
    // Non-fatal; logging failure shouldn't break the main flow.
  }
}

async function writeIngestLog(engine: BrainEngine, slug: string, findings: ValidationFinding[]): Promise<void> {
  try {
    const errorCount = findings.filter(f => f.severity === 'error').length;
    const warningCount = findings.filter(f => f.severity === 'warning').length;
    const summary = `post-write lint: ${errorCount} error, ${warningCount} warning` +
      (errorCount > 0 ? ` (top: ${findings.find(f => f.severity === 'error')!.message.slice(0, 80)})` : '');
    await engine.logIngest({
      source_type: 'writer_lint',
      source_ref: slug,
      pages_updated: [slug],
      summary,
    });
  } catch {
    // Non-fatal.
  }
}
