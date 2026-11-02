// Aetherwise - background job for gstin-verify-bulk (one job at a time, progress polled by gstin-verify-bulk-status)

import path from 'node:path';
import * as g from './gstin.mjs';
import { toProviderRecord } from './portal.mjs';
import { runPortalSession, type BrowserLike, type LookupOutcome, type ProgressEvent } from './portalbrowser.mjs';

export interface BulkJob {
  id: string; client: string; startedAt: string; finishedAt: string | null;
  state: 'running' | 'done' | 'failed' | 'cancelled';
  total: number; done: number; current: ProgressEvent | null; log: ProgressEvent[];
  invalid: { gstin: string; problems: string[] }[]; duplicatesRemoved: number;
  booksSource: string; outcomes: LookupOutcome[]; report: string | null; error: string | null;
  summary: any; rows: any[]; cancel: boolean;
}

let current: BulkJob | null = null;
export function getJob() { return current; }

export interface StartArgs {
  gstins: string[]; clientName: string; profile: g.ClientProfile; books: Map<string, { name?: string; gst?: number; bills?: number }>;
  booksSource: string; outputPath: string; saveToCache: boolean; perGstinTimeoutMs: number; minGapMs: number;
  launch: () => Promise<BrowserLike>; portalUrl?: string;
}

export function startBulk(a: StartArgs): BulkJob {
  if (current && current.state === 'running') throw new Error(`a bulk verification is already running (${current.done}/${current.total}) - wait or cancel it`);
  const { unique, duplicatesRemoved } = g.dedupeSuppliers(a.gstins.map(x => ({ gstin: x })));
  const valid: string[] = []; const invalid: BulkJob['invalid'] = [];
  for (const s of unique) { const l = g.validateGstinLocal(s.gstin); (l.formatOk && l.checksumOk ? valid.push(l.gstin) : invalid.push({ gstin: l.gstin, problems: l.problems })); }
  const job: BulkJob = {
    id: 'B' + Date.now().toString(36), client: a.clientName, startedAt: new Date().toISOString(), finishedAt: null, state: 'running',
    total: valid.length, done: 0, current: null, log: [], invalid, duplicatesRemoved, booksSource: a.booksSource, outcomes: [], report: null,
    error: null, summary: null, rows: [], cancel: false
  };
  current = job;
  (async () => {
    let browser: BrowserLike | null = null;
    try {
      if (valid.length) {
        browser = await a.launch();
        job.outcomes = await runPortalSession(browser, valid, {
          portalUrl: a.portalUrl, perGstinTimeoutMs: a.perGstinTimeoutMs, minGapMs: a.minGapMs, isCancelled: () => job.cancel,
          onProgress: p => { job.current = p; job.log.push(p); if (p.state === 'parsed' || p.state === 'failed' || p.state === 'skipped') job.done++; }
        });
      }
      await finish(job, a);
      job.state = job.cancel ? 'cancelled' : 'done';
    } catch (e) {
      job.error = String((e as any)?.message || e).split('\n')[0].slice(0, 300); job.state = 'failed';
      try { await finish(job, a); } catch { }
    } finally {
      job.finishedAt = new Date().toISOString();
      try { await browser?.close(); } catch { }
    }
  })();
  return job;
}

async function finish(job: BulkJob, a: StartArgs) {
  const results: g.Result[] = [];
  const cache = a.saveToCache ? new g.GstinCache(path.join(g.dataDir(), 'gstin-cache.json')) : null;
  for (const inv of job.invalid) {
    const b = a.books.get(inv.gstin) || {};
    results.push({ ...g.classify({ gstin: inv.gstin, ...b }, g.validateGstinLocal(inv.gstin), null, a.profile), source: 'local check (not sent to portal)', verifiedAt: null, fromCache: false });
  }
  for (const o of job.outcomes) {
    const b = a.books.get(o.gstin) || {};
    const rec = o.result ? toProviderRecord(o.result) : null;
    const techErr = rec ? undefined : `${o.status}: ${o.error || 'lookup failed'}`;
    const c = g.classify({ gstin: o.gstin, ...b }, g.validateGstinLocal(o.gstin), rec, a.profile, techErr);
    if (!b.name) c.missing.push(`books-to-portal comparison not possible (${a.booksSource})`);
    results.push({ ...c, source: o.result?.source || 'GST portal (lookup not completed)', verifiedAt: rec ? o.at : null, fromCache: false });
    if (cache && rec?.found) cache.put({ record: rec, source: o.result!.source, verifiedAt: o.at });
  }
  cache?.save();
  const count = (c: g.Colour) => results.filter(r => r.colour === c).length;
  const failures = job.outcomes.filter(o => !['RESULT', 'NOT_FOUND'].includes(o.status)).length;
  const summary: g.RunSummary & { lookupFailures: number } = {
    client: job.client, profile: a.profile.name, provider: 'GST portal - interactive session (captcha by user)', ranAt: job.startedAt,
    inputRows: a.gstins.length, duplicatesRemoved: job.duplicatesRemoved, unique: job.total + job.invalid.length, invalidLocally: job.invalid.length,
    fromCache: 0, apiLookups: job.outcomes.filter(o => o.status === 'RESULT' || o.status === 'NOT_FOUND').length, notLookedUpBudget: 0,
    green: count('GREEN'), yellow: count('YELLOW'), red: count('RED'), creditsRemaining: null,
    stoppedReason: job.cancel ? 'cancelled by user' : job.error, lookupFailures: failures
  };
  const calls: g.CallLog[] = job.outcomes.map(o => ({ at: o.at, gstin: o.gstin, endpoint: 'portal searchtp (user captcha)', httpStatus: null, outcome: o.status + (o.error ? ': ' + o.error : ''), creditsRemaining: null, attempt: 1, ms: 0 }));
  await g.writeReport(a.outputPath, results, summary, calls);
  g.appendAudit(path.join(g.dataDir(), 'gstin-audit.jsonl'), job.client, calls);
  job.report = a.outputPath; job.summary = summary;
  job.rows = results.map(r => ({
    gstin: r.local.gstin, books_name: r.input.name ?? null, colour: r.colour,
    lookup: job.outcomes.find(o => o.gstin === r.local.gstin)?.status ?? 'NOT_SENT (invalid GSTIN)',
    legal_name: r.record?.legalName ?? null, trade_name: r.record?.tradeName ?? null, status: r.record ? (r.record.found ? r.record.status : 'NOT FOUND') : null,
    registration_date: r.record?.registrationDate ?? null, cancellation_date: r.record?.cancellationDate ?? null, constitution: r.record?.constitution ?? null,
    taxpayer_type: r.record?.taxpayerType ?? null, address: r.record?.address ?? null, jurisdiction: r.record?.jurisdiction ?? null,
    nature_of_business: r.record?.natureOfBusiness ?? null, hsn_sac: r.record?.hsn?.map(h => `${h.code} ${h.description ?? ''}`.trim()) ?? null,
    verified_at: r.verifiedAt, source: r.source, reasons: r.reasons, missing: r.missing
  }));
}

export function publicView(j: BulkJob, withRows: boolean) {
  const { cancel, outcomes, log, rows, ...rest } = j;
  return { ...rest, recent: log.slice(-5), rows: withRows ? rows : undefined };
}
