// Aetherwise - consolidated GSTIN report from GST portal result pages that the USER searched and saved
// in their own browser. No portal access, no browser automation: the connector only reads local files.

import fs from 'node:fs';
import path from 'node:path';
import * as g from './gstin.mjs';
import { listPortalFiles, parsePortalText, readPortalFile, toProviderRecord, PORTAL_SOURCE, type TaxpayerResult } from './portal.mjs';

export type BulkLookup = 'RESULT' | 'NOT_FOUND' | 'PAGE_MISSING' | 'PARSE_FAILED' | 'NOT_CHECKED (invalid GSTIN)';

export interface BulkArgs {
  gstins: string[]; folderPath: string; clientName: string; profile: g.ClientProfile;
  books: Map<string, Partial<g.SupplierInput>>; booksSource: string; outputPath: string; saveToCache: boolean;
}

export async function bulkFromSavedPages(a: BulkArgs) {
  if (!fs.existsSync(a.folderPath) || !fs.statSync(a.folderPath).isDirectory()) throw new Error(`folder not found: ${a.folderPath}`);
  const { unique, duplicatesRemoved } = g.dedupeSuppliers(a.gstins.map(x => ({ gstin: x })));

  // parse every saved page once; index by the GSTIN shown on the page (not by file name)
  const pages = new Map<string, TaxpayerResult>(); const unreadable: { file: string; error: string }[] = []; const extra: string[] = [];
  for (const f of listPortalFiles(a.folderPath)) {
    try {
      const { text, retrievedAt } = readPortalFile(f);
      const hint = path.basename(f).toUpperCase().match(/\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]/)?.[0];
      const r = parsePortalText(text, { sourceFile: path.basename(f), retrievedAt });
      const key = r.gstin || hint;
      if (!key) { unreadable.push({ file: path.basename(f), error: r.error || 'no GSTIN on page' }); continue; }
      if (!r.gstin) r.gstin = key;   // e.g. a 'no records' page shows no GSTIN - taken from the file name
      const prev = pages.get(key);
      if (!prev || (!prev.success && r.success) || (r.success && prev.success && (r.retrieved_at || '') > (prev.retrieved_at || ''))) pages.set(key, r);
    } catch (e) { unreadable.push({ file: path.basename(f), error: String((e as any)?.message || e) }); }
  }
  const wanted = new Set(unique.map(u => u.gstin));
  for (const k of pages.keys()) if (!wanted.has(k)) extra.push(k);

  const results: g.Result[] = []; const rows: any[] = []; const lookups = new Map<string, BulkLookup>();
  const cache = a.saveToCache ? new g.GstinCache(path.join(g.dataDir(), 'gstin-cache.json')) : null;
  for (const u of unique) {
    const local = g.validateGstinLocal(u.gstin);
    const b = a.books.get(local.gstin) || {};
    let lookup: BulkLookup; let rec: g.ProviderRecord | null = null; let techErr: string | undefined; let page: TaxpayerResult | undefined;
    if (!local.formatOk || !local.checksumOk) lookup = 'NOT_CHECKED (invalid GSTIN)';
    else {
      page = pages.get(local.gstin);
      if (!page) { lookup = 'PAGE_MISSING'; techErr = 'no saved portal page for this GSTIN in the folder - search it on the portal and save the result'; }
      else if (page.page_state === 'NOT_FOUND') { lookup = 'NOT_FOUND'; rec = toProviderRecord(page); }
      else if (page.success) { lookup = 'RESULT'; rec = toProviderRecord(page); }
      else { lookup = 'PARSE_FAILED'; techErr = `page ${page.source_file}: ${page.error}`; }
    }
    const c = g.classify({ gstin: local.gstin, ...b }, local, rec, a.profile, techErr);
    if (techErr) c.reasons.unshift(`TECHNICAL (${lookup}): ${techErr}`);
    if (!b.name) c.missing.push(`books-to-portal comparison not possible (${a.booksSource})`);
    const verifiedAt = rec ? (page?.retrieved_at || null) : null;
    const source = page ? `${PORTAL_SOURCE}: ${page.source_file}` : lookup === 'PAGE_MISSING' ? 'no page saved' : 'local check only';
    results.push({ ...c, source, verifiedAt, fromCache: false, lookup });
    lookups.set(local.gstin, lookup);
    if (cache && rec?.found && verifiedAt) cache.put({ record: rec, source: PORTAL_SOURCE, verifiedAt });
  }
  cache?.save();

  const count = (c: g.Colour) => results.filter(r => r.colour === c).length;
  const technical = [...lookups.values()].filter(v => v === 'PAGE_MISSING' || v === 'PARSE_FAILED').length;
  const summary: g.RunSummary & { technicalFailures: number; pagesRead: number; unreadableFiles: number } = {
    client: a.clientName, profile: a.profile.name, provider: 'GST portal result pages searched and saved by the user (parsed offline)', ranAt: new Date().toISOString(),
    inputRows: a.gstins.length, duplicatesRemoved, unique: unique.length, invalidLocally: [...lookups.values()].filter(v => v.startsWith('NOT_CHECKED')).length,
    fromCache: 0, apiLookups: 0, notLookedUpBudget: 0, green: count('GREEN'), yellow: count('YELLOW'), red: count('RED'), creditsRemaining: null,
    stoppedReason: null, technicalFailures: technical, pagesRead: pages.size, unreadableFiles: unreadable.length
  };
  const calls: g.CallLog[] = results.map(r => ({ at: summary.ranAt, gstin: r.local.gstin, endpoint: 'saved portal page (offline)', httpStatus: null, outcome: lookups.get(r.local.gstin)!, creditsRemaining: null, attempt: 1, ms: 0 }));
  await g.writeReport(a.outputPath, results, summary, calls);
  g.appendAudit(path.join(g.dataDir(), 'gstin-audit.jsonl'), a.clientName, calls);

  for (const r of results) {
    const lookup = lookups.get(r.local.gstin)!;
    rows.push({
      gstin: r.local.gstin, books_name: r.input.name ?? null, colour: r.colour,
      finding_type: lookup === 'PAGE_MISSING' || lookup === 'PARSE_FAILED' ? 'technical (not a compliance finding)' : r.colour === 'GREEN' ? 'no issue' : 'verified / review',
      lookup, legal_name: r.record?.legalName ?? null, trade_name: r.record?.tradeName ?? null,
      status: r.record ? (r.record.found ? r.record.status : 'NOT FOUND') : null, registration_date: r.record?.registrationDate ?? null,
      cancellation_date: r.record?.cancellationDate ?? null, address: r.record?.address ?? null, jurisdiction: r.record?.jurisdiction ?? null,
      nature_of_business: r.record?.natureOfBusiness ?? null, hsn_sac: r.record?.hsn?.map(h => `${h.code} ${h.description ?? ''}`.trim()) ?? null,
      verified_at: r.verifiedAt, source: r.source, reasons: r.reasons, missing: r.missing
    });
  }
  return { summary, rows, report: a.outputPath, missingPages: rows.filter(r => r.lookup === 'PAGE_MISSING').map(r => r.gstin), unreadable, pagesForOtherGstins: extra };
}
