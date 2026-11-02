// Aetherwise - resumable GSTIN verification worklist.
//
// The connector NEVER contacts the GST portal and runs no browser. The user searches each GSTIN in their
// own browser (typing the captcha themselves) and pastes the result text (or drops a saved file); the
// connector parses it locally, tracks progress on disk so the job survives interruption, and builds one
// consolidated report. The only Tally access is a read (Export) of party ledger GSTIN + name.

import fs from 'node:fs';
import path from 'node:path';
import * as g from './gstin.mjs';
import { parsePortalText, readPortalFile, listPortalFiles, toProviderRecord, htmlToText, mhtmlToHtml, PORTAL_SOURCE, PORTAL_URL, type TaxpayerResult } from './portal.mjs';

/** accept either the visible page text (Ctrl+A copy) or pasted HTML / MHTML source */
function textFromPaste(s: string): string {
  if (/^\s*(from|mime-version|content-type):/im.test(s) && /boundary=/i.test(s)) s = mhtmlToHtml(s);
  return /<(html|body|div|table|p|h\d|br|span)[\s>]/i.test(s) ? htmlToText(s) : s;
}

export type ItemStatus = 'pending' | 'done' | 'not_found' | 'failed' | 'invalid';

export interface WorkItem {
  gstin: string;
  books: Partial<g.SupplierInput>;        // name / amounts / 2A filing evidence
  status: ItemStatus;
  record: g.ProviderRecord | null;        // parsed registration record, when obtained
  verifiedAt: string | null;              // page date / parse time
  source: string | null;
  error: string | null;
  updatedAt: string;
}

export interface Worklist {
  version: 1;
  client: string;
  profile: 'pharmacy' | 'trader' | 'generic';
  booksSource: string;
  createdAt: string;
  items: Record<string, WorkItem>;
}

function safe(name: string) { return name.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 60); }
function fileFor(client: string) { return path.join(g.dataDir(), `worklist_${safe(client)}.json`); }

export function load(client: string): Worklist | null {
  try { return JSON.parse(fs.readFileSync(fileFor(client), 'utf8')); } catch { return null; }
}
export function save(w: Worklist) {
  const f = fileFor(client0(w)); const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(w, null, 1)); fs.renameSync(tmp, f);
}
function client0(w: Worklist) { return w.client; }

export function progress(w: Worklist) {
  const items = Object.values(w.items);
  const by = (s: ItemStatus) => items.filter(i => i.status === s).length;
  const resolved = items.filter(i => i.status !== 'pending').length;
  return {
    total: items.length, resolved, pending: by('pending'),
    done: by('done'), not_found: by('not_found'), failed: by('failed'), invalid: by('invalid'),
    nextPending: items.filter(i => i.status === 'pending').map(i => ({ gstin: i.gstin, name: i.books.name ?? null })).slice(0, 5),
    label: `${resolved}/${items.length} resolved`
  };
}

/** create or extend a worklist; books come from a 2A/supplier file and/or Tally (both optional) */
export function startWorklist(a: {
  client: string; profile: 'pharmacy' | 'trader' | 'generic'; gstins: string[];
  books: Map<string, Partial<g.SupplierInput>>; booksSource: string; reset?: boolean;
}): Worklist {
  let w = a.reset ? null : load(a.client);
  if (!w) w = { version: 1, client: a.client, profile: a.profile, booksSource: a.booksSource, createdAt: new Date().toISOString(), items: {} };
  else { w.profile = a.profile; if (a.booksSource) w.booksSource = a.booksSource; }
  const { unique } = g.dedupeSuppliers(a.gstins.map(x => ({ gstin: x })));
  for (const u of unique) {
    const local = g.validateGstinLocal(u.gstin);
    const b = a.books.get(local.gstin) || {};
    const ex = w.items[local.gstin];
    if (ex) { ex.books = { ...b, ...ex.books, ...(b.name ? { name: b.name } : {}) }; continue; }  // keep existing progress; refresh books
    w.items[local.gstin] = {
      gstin: local.gstin, books: b, status: (!local.formatOk || !local.checksumOk) ? 'invalid' : 'pending',
      record: null, verifiedAt: null, error: (!local.formatOk || !local.checksumOk) ? local.problems.join('; ') : null, updatedAt: new Date().toISOString(), source: null
    };
  }
  save(w);
  return w;
}

export interface AddOutcome { gstin: string | null; status: ItemStatus; category: string | null; error: string | null; source_file: string | null; matchedToWorklist: boolean; }

function applyParsed(w: Worklist, r: TaxpayerResult): AddOutcome {
  const gstin = r.gstin;
  const item = gstin ? w.items[gstin] : undefined;
  const base: AddOutcome = { gstin, status: 'failed', category: null, error: r.error, source_file: r.source_file, matchedToWorklist: !!item };
  if (!gstin) return base;
  if (!item) return { ...base, status: r.page_state === 'NOT_FOUND' ? 'not_found' : r.success ? 'done' : 'failed', error: (r.error ? r.error + '; ' : '') + 'GSTIN not in this worklist' };
  if (r.page_state === 'NOT_FOUND') { item.status = 'not_found'; item.record = toProviderRecord(r); item.source = r.source; item.verifiedAt = r.retrieved_at || r.parsed_at; item.error = 'no record at source'; }
  else if (r.success) { item.status = 'done'; item.record = toProviderRecord(r); item.source = r.source; item.verifiedAt = r.retrieved_at || r.parsed_at; item.error = null; }
  else {
    // a parse failure must not overwrite an already-good result or mark the supplier non-compliant
    if (item.status !== 'done' && item.status !== 'not_found') { item.status = 'failed'; item.error = r.error; }
    return { gstin, status: item.status, category: 'TECHNICAL', error: r.error, source_file: r.source_file, matchedToWorklist: true };
  }
  item.updatedAt = new Date().toISOString();
  return { gstin, status: item.status, category: item.status === 'not_found' ? 'NOT_FOUND_AT_SOURCE' : null, error: item.error, source_file: r.source_file, matchedToWorklist: true };
}

/** build a registration record from a status-export row (Tally validation export / status report) */
function recordFromRow(s: g.SupplierInput): g.ProviderRecord | null {
  const st = (s.portalStatus ?? '').trim();
  if (!st) return null;
  if (/no record|not found|invalid|does not exist/i.test(st)) return { gstin: s.gstin, found: false };
  return {
    gstin: s.gstin, found: true, status: st, legalName: s.portalLegalName ?? null, tradeName: s.portalTradeName ?? null,
    registrationDate: s.portalRegDate ?? null, cancellationDate: s.portalCancelDate ?? null, taxpayerType: s.portalTaxpayerType ?? null,
    constitution: s.portalConstitution ?? null, address: s.portalAddress ?? null, natureOfBusiness: null, hsn: null
  };
}

/** ingest a tabular status export (.xlsx/.csv) - one row per GSTIN carrying the portal registration status */
export async function ingestTable(w: Worklist, filePath: string, source: string): Promise<AddOutcome[]> {
  const rows = g.dedupeSuppliers(await g.readSupplierFile(filePath)).unique;
  const out: AddOutcome[] = [];
  for (const s of rows) {
    const item = w.items[s.gstin];
    const rec = recordFromRow(s);
    if (!rec) continue;                       // row has no status column value -> skip (not a status export row)
    if (!item) { out.push({ gstin: s.gstin, status: rec.found ? 'done' : 'not_found', category: null, error: 'GSTIN not in this worklist', source_file: path.basename(filePath), matchedToWorklist: false }); continue; }
    item.record = rec; item.source = source; item.verifiedAt = new Date().toISOString();
    item.status = rec.found ? 'done' : 'not_found'; item.error = rec.found ? null : 'no record at source';
    if (s.portalLegalName || s.portalTradeName) { /* name present */ }
    item.updatedAt = item.verifiedAt;
    out.push({ gstin: s.gstin, status: item.status, category: item.status === 'not_found' ? 'NOT_FOUND_AT_SOURCE' : null, error: item.error, source_file: path.basename(filePath), matchedToWorklist: true });
  }
  return out;
}

/** add one or more portal results from pasted text and/or saved files */
export async function addResults(client: string, input: { text?: string; filePath?: string; folderPath?: string; expectedGstin?: string }): Promise<{ worklist: Worklist; outcomes: AddOutcome[] }> {
  const w = load(client);
  if (!w) throw new Error(`no worklist for "${client}" - run gstin-worklist-start first`);
  const outcomes: AddOutcome[] = [];
  // a tabular status export (Tally "Validate Party GSTIN/UIN" export, or a status report) rather than a portal page
  if (input.filePath && /\.(xlsx|csv)$/i.test(input.filePath)) {
    outcomes.push(...await ingestTable(w, input.filePath, 'TallyPrime / status export: ' + path.basename(input.filePath)));
    save(w);
    return { worklist: w, outcomes };
  }
  const files = [...(input.filePath ? [input.filePath] : []), ...(input.folderPath ? listPortalFiles(input.folderPath) : [])];
  for (const f of files) {
    try {
      const { text, retrievedAt } = readPortalFile(f);
      const hint = path.basename(f).toUpperCase().match(/\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]/)?.[0];
      const r = parsePortalText(text, { sourceFile: path.basename(f), retrievedAt });
      if (!r.gstin && hint) r.gstin = hint;
      outcomes.push(applyParsed(w, r));
    } catch (e) { outcomes.push({ gstin: null, status: 'failed', category: 'TECHNICAL', error: 'could not read file: ' + String((e as any)?.message || e), source_file: path.basename(f), matchedToWorklist: false }); }
  }
  if (input.text) outcomes.push(applyParsed(w, parsePortalText(textFromPaste(input.text), { expectedGstin: input.expectedGstin, sourceFile: null, retrievedAt: null })));
  save(w);
  return { worklist: w, outcomes };
}

/** build the consolidated report from whatever is resolved so far (safe to call any time) */
export async function buildReport(client: string, outputPath: string, saveToCache: boolean) {
  const w = load(client);
  if (!w) throw new Error(`no worklist for "${client}"`);
  const profile = g.CLIENT_PROFILES[w.profile];
  const results: g.Result[] = []; const rows: any[] = [];
  const cache = saveToCache ? new g.GstinCache(path.join(g.dataDir(), 'gstin-cache.json')) : null;
  for (const it of Object.values(w.items)) {
    const local = g.validateGstinLocal(it.gstin);
    const techErr = (it.status === 'pending') ? 'not yet searched / pasted' : (it.status === 'failed') ? (it.error || 'parse failed') : undefined;
    const c = g.classify({ gstin: it.gstin, ...it.books }, local, it.record, profile, techErr);
    if (techErr) c.reasons.unshift(`TECHNICAL (${it.status.toUpperCase()}): ${techErr} - no conclusion about the supplier`);
    if (!it.books.name) c.missing.push(`books-to-portal name comparison not possible (${w.booksSource})`);
    results.push({ ...c, source: it.source || (it.status === 'pending' ? 'not searched yet' : 'local check only'), verifiedAt: it.verifiedAt, fromCache: false, lookup: it.status.toUpperCase() });
    if (cache && it.record?.found && it.verifiedAt) cache.put({ record: it.record, source: PORTAL_SOURCE, verifiedAt: it.verifiedAt });
    rows.push({
      gstin: it.gstin, books_name: it.books.name ?? null, colour: c.colour, category: c.category, findings: c.findings,
      finding_type: c.category === 'TECHNICAL' ? 'technical (not a compliance finding)' : c.colour === 'GREEN' ? 'no issue' : c.colour === 'RED' ? 'verified finding' : 'review',
      worklist_status: it.status, legal_name: it.record?.legalName ?? null, trade_name: it.record?.tradeName ?? null,
      status: it.record ? (it.record.found ? it.record.status : 'NOT FOUND') : null, registration_date: it.record?.registrationDate ?? null,
      cancellation_date: it.record?.cancellationDate ?? null, address: it.record?.address ?? null, jurisdiction: it.record?.jurisdiction ?? null,
      nature_of_business: it.record?.natureOfBusiness ?? null, hsn_sac: it.record?.hsn?.map(h => `${h.code} ${h.description ?? ''}`.trim()) ?? null,
      verified_at: it.verifiedAt, source: it.source, reasons: c.reasons, missing: c.missing
    });
  }
  cache?.save();
  const count = (c: g.Colour) => results.filter(r => r.colour === c).length;
  const p = progress(w);
  const summary: g.RunSummary & { pending: number; technicalFailures: number } = {
    client: w.client, profile: profile.name, provider: 'GST portal pages the user searched & pasted / saved (parsed offline); filing evidence from client 2A/2B', ranAt: new Date().toISOString(),
    inputRows: p.total, duplicatesRemoved: 0, unique: p.total, invalidLocally: p.invalid, fromCache: 0, apiLookups: 0, notLookedUpBudget: 0,
    green: count('GREEN'), yellow: count('YELLOW'), red: count('RED'), creditsRemaining: null, stoppedReason: p.pending ? `${p.pending} supplier(s) still pending` : null,
    pending: p.pending, technicalFailures: results.filter(r => r.category === 'TECHNICAL').length
  };
  const calls: g.CallLog[] = Object.values(w.items).map(it => ({ at: it.updatedAt, gstin: it.gstin, endpoint: 'worklist (offline)', httpStatus: null, outcome: it.status, creditsRemaining: null, attempt: 1, ms: 0 }));
  await g.writeReport(outputPath, results, summary, calls);
  g.appendAudit(path.join(g.dataDir(), 'gstin-audit.jsonl'), w.client, calls);
  return { summary, rows, report: outputPath, pending: Object.values(w.items).filter(i => i.status === 'pending').map(i => i.gstin), progress: p };
}

export { PORTAL_URL };
