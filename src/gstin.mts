// Aetherwise - GSTIN verification module
// Uses only authorised data sources: local checksum, the client's own GSTR-2A/2B data, and an
// authorised API provider (gstinapi.in, which reads through licensed GSP infrastructure).
// It never scrapes the GST portal, never solves captchas and never rotates IPs or proxies.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import ExcelJS from 'exceljs';

// ---------------------------------------------------------------- local validation

const CP = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z][Z][0-9A-Z]$/;

const STATE_CODES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '25': 'Daman and Diu', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra',
  '28': 'Andhra Pradesh (old)', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu',
  '34': 'Puducherry', '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
  '97': 'Other Territory', '99': 'Centre Jurisdiction'
};

const PAN_TYPES: Record<string, string> = {
  P: 'Individual / Proprietor', F: 'Firm / LLP', C: 'Company', H: 'HUF', A: 'AOP', T: 'Trust', B: 'BOI',
  L: 'Local Authority', J: 'Artificial Juridical Person', G: 'Government', E: 'LLP'
};

export function gstinCheckDigit(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = CP.indexOf(first14[i]);
    if (v < 0) return '?';
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return CP[(36 - (sum % 36)) % 36];
}

export interface LocalCheck {
  gstin: string;
  formatOk: boolean;
  checksumOk: boolean;
  stateCode: string;
  state: string | null;
  pan: string;
  panHolderType: string | null;
  problems: string[];
}

/** gstinapi.in's documented test GSTIN: returns fixed sample data and uses no credit */
export const PROVIDER_TEST_GSTIN = '00AAAAA0000A1ZT';

export function validateGstinLocal(raw: string): LocalCheck {
  const gstin = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
  if (gstin === PROVIDER_TEST_GSTIN)
    return { gstin, formatOk: true, checksumOk: true, stateCode: '00', state: 'PROVIDER TEST GSTIN', pan: gstin.slice(2, 12), panHolderType: null, problems: [] };
  const problems: string[] = [];
  const formatOk = GSTIN_RE.test(gstin);
  if (!formatOk) problems.push('GSTIN format is invalid (expected 15 characters: 2-digit state + PAN + entity no. + Z + check digit)');
  const checksumOk = formatOk && gstinCheckDigit(gstin.slice(0, 14)) === gstin[14];
  if (formatOk && !checksumOk) problems.push('GSTIN check digit does not match (typing error or fake number)');
  const stateCode = gstin.slice(0, 2);
  const state = STATE_CODES[stateCode] || null;
  if (formatOk && !state) problems.push(`unknown state code ${stateCode}`);
  const pan = gstin.slice(2, 12);
  const panHolderType = PAN_TYPES[pan[3]] || null;
  return { gstin, formatOk, checksumOk, stateCode, state, pan, panHolderType, problems };
}

// ---------------------------------------------------------------- input list

export interface SupplierInput {
  gstin: string;
  name?: string;
  bills?: number;
  taxable?: number;
  gst?: number;
  firstDate?: string;
  lastDate?: string;
  gstr1Filed?: string;        // filing status from client's own GSTR-2A/2B (Y/N)
  fixedMonthly?: boolean;     // same amount every month (maintenance / rent pattern)
  note?: string;
}

function findCol(headers: string[], ...patterns: RegExp[]): number {
  for (const p of patterns) {
    const i = headers.findIndex(h => p.test(h));
    if (i >= 0) return i;
  }
  return -1;
}

function num(v: any): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  if (typeof v === 'object' && 'result' in v) v = v.result;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
  return isNaN(n) ? undefined : n;
}

function cellText(v: any): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v) return cellText(v.result);
    if ('text' in v) return String(v.text);
    if ('richText' in v) return v.richText.map((r: any) => r.text).join('');
  }
  return String(v).trim();
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}

/** reads GSTINs (plus optional supporting columns) from .xlsx / .csv; header row auto-detected */
export async function readSupplierFile(filePath: string, sheetName?: string): Promise<SupplierInput[]> {
  let grid: string[][] = [];
  if (/\.csv$/i.test(filePath)) {
    grid = parseCsv(fs.readFileSync(filePath, 'utf8').replace(/^﻿/, ''));
  } else if (/\.xlsx$/i.test(filePath)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    const ws = sheetName ? wb.getWorksheet(sheetName) : wb.worksheets[0];
    if (!ws) throw new Error(`sheet not found: ${sheetName}`);
    ws.eachRow({ includeEmpty: false }, r => {
      const vals = (r.values as any[]).slice(1).map(cellText);
      grid.push(vals);
    });
  } else throw new Error('only .xlsx or .csv files are supported (save .xls as .xlsx first)');

  // header row = first row (within 30) having a cell containing "GSTIN"
  const hi = grid.slice(0, 30).findIndex(r => r.some(c => /gstin|gst\s*no|gst\s*number/i.test(c)));
  if (hi < 0) throw new Error('no column with "GSTIN" in its header found in the first 30 rows');
  const headers = grid[hi].map(h => h.toLowerCase().trim());
  const cG = findCol(headers, /^gstin/, /gstin/, /gst\s*(no|number)/);
  const cN = findCol(headers, /trade.*name|supplier|party|legal.*name/, /name/);
  const cB = findCol(headers, /^bills?$|no\.? of (bills|invoices)|invoice count/);
  const cT = findCol(headers, /taxable/);
  const cX = findCol(headers, /^(total )?gst$|total tax|^tax amount|^gst amount|^tax$/);
  const cF = findCol(headers, /first.*date|from.*date/);
  const cL = findCol(headers, /last.*date|to.*date|^invoice date|^date/);
  const cR = findCol(headers, /gstr-?1.*fil.*status|filing status/);
  const cM = findCol(headers, /fixed.*month|monthly/);
  const cNote = findCol(headers, /note|remark/);

  const out: SupplierInput[] = [];
  for (const r of grid.slice(hi + 1)) {
    const g = (r[cG] || '').trim().toUpperCase();
    if (!g) continue;
    const pick = (c: number) => (c >= 0 ? r[c] : undefined);
    out.push({
      gstin: g,
      name: pick(cN) || undefined,
      bills: num(pick(cB)),
      taxable: num(pick(cT)),
      gst: num(pick(cX)),
      firstDate: normDate(pick(cF)),
      lastDate: normDate(pick(cL)),
      gstr1Filed: pick(cR) || undefined,
      fixedMonthly: cM >= 0 ? /^(y|yes|true|1)$/i.test(pick(cM) || '') : undefined,
      note: pick(cNote) || undefined
    });
  }
  return out;
}

/** removes duplicate GSTINs; supporting numbers of duplicate rows are summed */
export function dedupeSuppliers(list: SupplierInput[]): { unique: SupplierInput[]; duplicatesRemoved: number } {
  const m = new Map<string, SupplierInput>();
  for (const s0 of list) {
    const s = { ...s0, gstin: s0.gstin.trim().toUpperCase() };
    const e = m.get(s.gstin);
    if (!e) { m.set(s.gstin, { ...s, bills: s.bills ?? 1 }); continue; }
    e.bills = (e.bills ?? 1) + (s.bills ?? 1);
    if (s.taxable !== undefined) e.taxable = round2((e.taxable ?? 0) + s.taxable);
    if (s.gst !== undefined) e.gst = round2((e.gst ?? 0) + s.gst);
    e.name = e.name || s.name;
    if (s.gstr1Filed && /^n/i.test(s.gstr1Filed)) e.gstr1Filed = s.gstr1Filed;
    else e.gstr1Filed = e.gstr1Filed || s.gstr1Filed;
    if (s.firstDate && (!e.firstDate || s.firstDate < e.firstDate)) e.firstDate = s.firstDate;
    if (s.lastDate && (!e.lastDate || s.lastDate > e.lastDate)) e.lastDate = s.lastDate;
  }
  return { unique: [...m.values()], duplicatesRemoved: list.length - m.size };
}

/** dd-mm-yyyy, dd/mm/yyyy or yyyy-mm-dd -> yyyy-mm-dd (undefined if not a date) */
export function normDate(v?: string): string | undefined {
  if (!v) return undefined;
  const t = String(v).trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return undefined;
}

function round2(n: number) { return Math.round(n * 100) / 100; }

// ---------------------------------------------------------------- provider

export interface HsnItem { code: string; description: string | null; kind: 'hsn' | 'sac'; }

export interface ProviderRecord {
  gstin: string;
  found: boolean;
  legalName?: string | null;
  tradeName?: string | null;
  status?: string | null;
  taxpayerType?: string | null;
  constitution?: string | null;
  registrationDate?: string | null;
  cancellationDate?: string | null;
  address?: string | null;
  natureOfBusiness?: string[] | null;
  einvoiceStatus?: string | null;
  profileComplete?: boolean | null;
  returns?: { type: string; period: string; status: string; date: string }[] | null;
  hsn?: HsnItem[] | null;       // goods / services the supplier declared on registration (portal page)
  jurisdiction?: string | null;
  additionalPlaces?: string[] | null;
  coreActivity?: string | null;
}

const NAME_STOP = new Set(['m', 's', 'ms', 'the', 'and', 'of', 'pvt', 'private', 'ltd', 'limited', 'llp', 'co', 'company', 'firm', 'enterprises', 'enterprise',
  'india', 'traders', 'trading', 'agency', 'agencies', 'and', 'sons', 'son', 'brothers', 'bros', 'corporation', 'corp', 'industries', 'services', 'limit', 'privat', 'lim']);
function nameTokens(s: string) { return s.toLowerCase().replace(/&/g, ' ').replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length > 1 && !NAME_STOP.has(w)); }
/** true when the books name and the registered legal / trade name share a significant word */
export function namesMatch(books: string, ...registered: (string | null | undefined)[]): boolean {
  const b = new Set(nameTokens(books));
  if (!b.size) return true;
  const r = registered.filter(Boolean).flatMap(x => nameTokens(x as string));
  if (!r.length) return true;
  return r.some(w => b.has(w) || [...b].some(x => (x.length >= 4 && w.startsWith(x)) || (w.length >= 4 && x.startsWith(w))));
}

export interface CallLog {
  at: string; gstin: string; endpoint: string; httpStatus: number | null;
  outcome: string; creditsRemaining: number | null; attempt: number; ms: number;
}

export class ProviderStop extends Error { }

export interface Provider {
  readonly name: string;
  lookup(gstin: string, opts: { returnsFy?: string }): Promise<ProviderRecord>;
  usage(): Promise<any>;
  calls: CallLog[];
  creditsRemaining: number | null;
}

type FetchFn = (url: string, init: any) => Promise<{ status: number; headers: { get(n: string): string | null }; text(): Promise<string> }>;

export class GstinApiProvider implements Provider {
  readonly name = 'gstinapi.in';
  calls: CallLog[] = [];
  creditsRemaining: number | null = null;
  private last = 0;
  constructor(private apiKey: string, private opts: {
    baseUrl?: string; minIntervalMs?: number; maxRetries?: number; fetchFn?: FetchFn; sleep?: (ms: number) => Promise<void>
  } = {}) {
    if (!apiKey) throw new Error('GSTINAPI_API_KEY is not set');
  }
  private get base() { return (this.opts.baseUrl || 'https://gstinapi.in').replace(/\/$/, ''); }
  private sleep(ms: number) { return (this.opts.sleep || (t => new Promise(r => setTimeout(r, t))))(ms); }

  /** one GET with throttle (provider limit 60/min -> default 1 call per 1.1 s) and retry on 429 / 502 / network error */
  private async get(gstin: string, endpoint: string, url: string): Promise<{ status: number; body: any }> {
    const max = this.opts.maxRetries ?? 3;
    const fetchFn: FetchFn = this.opts.fetchFn || (globalThis.fetch as any);
    for (let attempt = 1; ; attempt++) {
      const wait = (this.opts.minIntervalMs ?? 1100) - (Date.now() - this.last);
      if (wait > 0) await this.sleep(wait);
      this.last = Date.now();
      const t0 = Date.now();
      let status: number | null = null; let body: any = null; let outcome = '';
      let retryAfter = 0;
      try {
        const res = await fetchFn(url, { headers: { 'x-api-key': this.apiKey, accept: 'application/json' } });
        status = res.status;
        const txt = await res.text();
        try { body = JSON.parse(txt); } catch { body = { raw: txt.slice(0, 300) }; }
        if (body && typeof body.credits_remaining === 'number') this.creditsRemaining = body.credits_remaining;
        retryAfter = parseInt(res.headers.get('retry-after') || '0') || 0;
        outcome = status === 200 ? 'ok' : (body?.error ? String(body.error).slice(0, 120) : `http ${status}`);
      } catch (e) {
        outcome = 'network error: ' + String((e as any)?.message || e).slice(0, 120);
      }
      this.calls.push({ at: new Date().toISOString(), gstin, endpoint, httpStatus: status, outcome, creditsRemaining: this.creditsRemaining, attempt, ms: Date.now() - t0 });
      const retryable = status === null || status === 429 || status === 502 || status === 503 || status === 504;
      if (status === 401) throw new ProviderStop('API key rejected (401) - check GSTINAPI_API_KEY');
      if (status === 402) throw new ProviderStop('out of API credits (402) - remaining suppliers left unverified');
      if (status === 403) throw new ProviderStop('API account deactivated (403)');
      if (retryable && attempt < max) {
        const backoff = Math.max(retryAfter * 1000, 2000 * Math.pow(2, attempt - 1));
        await this.sleep(backoff);
        continue;
      }
      if (retryable) throw new Error(`provider unavailable after ${attempt} attempts (${outcome})`);
      return { status: status as number, body };
    }
  }

  async lookup(gstin: string, opts: { returnsFy?: string } = {}): Promise<ProviderRecord> {
    const r = await this.get(gstin, 'gstin?include=profile', `${this.base}/v1/gstin/${gstin}?include=profile`);
    if (r.status === 404) return { gstin, found: false };
    if (r.status === 400) return { gstin, found: false, status: 'Invalid format (provider)' };
    if (r.status !== 200 || !r.body?.success) throw new Error(`unexpected provider response ${r.status}`);
    const d = r.body.data || {};
    const nob = d.nature_of_business;
    const rec: ProviderRecord = {
      gstin, found: true,
      legalName: d.legal_name ?? null, tradeName: d.trade_name ?? null, status: d.status ?? null,
      taxpayerType: d.taxpayer_type ?? null, constitution: d.business_constitution ?? null,
      registrationDate: d.registration_date ?? null, cancellationDate: d.cancellation_date || null,
      address: d.address ?? null,
      natureOfBusiness: Array.isArray(nob) ? nob.map(String) : (nob ? String(nob).split(/[,;]\s*/) : null),
      einvoiceStatus: d.einvoice_status ?? null, profileComplete: r.body.profile_complete ?? null
    };
    if (opts.returnsFy) {
      const rr = await this.get(gstin, `returns?fy=${opts.returnsFy}`, `${this.base}/v1/gstin/${gstin}/returns?fy=${encodeURIComponent(opts.returnsFy)}`);
      if (rr.status === 200 && rr.body?.success) {
        rec.returns = (rr.body.returns || []).map((x: any) => ({ type: x.return_type, period: x.return_period, status: x.filing_status, date: x.filing_date }));
      }
    }
    return rec;
  }

  async usage() {
    const r = await this.get('-', 'stats/me', `${this.base}/v1/gstin/stats/me`);
    return r.body;
  }
}

/** deterministic offline provider for tests and sample reports - never presents data as real */
export class MockProvider implements Provider {
  readonly name = 'mock (TEST DATA - not real)';
  calls: CallLog[] = [];
  creditsRemaining: number | null = 75;
  constructor(private data: Record<string, ProviderRecord | 'error' | 'stop'> = {}) { }
  async lookup(gstin: string): Promise<ProviderRecord> {
    const d = this.data[gstin];
    const log = (outcome: string, st: number) => this.calls.push({ at: new Date().toISOString(), gstin, endpoint: 'mock', httpStatus: st, outcome, creditsRemaining: this.creditsRemaining, attempt: 1, ms: 0 });
    if (d === 'stop') { log('out of credits', 402); throw new ProviderStop('out of API credits (402) - remaining suppliers left unverified'); }
    if (d === 'error') { log('provider unavailable', 502); throw new Error('provider unavailable after 3 attempts'); }
    if (!d) { log('not found', 404); return { gstin, found: false }; }
    this.creditsRemaining = (this.creditsRemaining ?? 0) - 1; log('ok', 200);
    return d;
  }
  async usage() { return { mock: true, credits_remaining: this.creditsRemaining }; }
}

// ---------------------------------------------------------------- cache + audit

export interface CacheEntry { record: ProviderRecord; source: string; verifiedAt: string; }

export function dataDir(): string {
  const d = process.env.AETHERWISE_DATA_DIR || path.join(os.homedir(), '.aetherwise');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export class GstinCache {
  private map: Record<string, CacheEntry> = {};
  constructor(private file: string) {
    try { this.map = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.map = {}; }
  }
  get(gstin: string, maxAgeDays: number): CacheEntry | null {
    const e = this.map[gstin];
    if (!e) return null;
    const age = (Date.now() - Date.parse(e.verifiedAt)) / 86400000;
    return age <= maxAgeDays ? e : null;
  }
  put(e: CacheEntry) { this.map[e.record.gstin] = e; }
  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.map, null, 1));
    fs.renameSync(tmp, this.file);
  }
  get size() { return Object.keys(this.map).length; }
}

export function appendAudit(file: string, client: string, calls: CallLog[]) {
  if (!calls.length) return;
  fs.appendFileSync(file, calls.map(c => JSON.stringify({ client, ...c })).join('\n') + '\n');
}

// ---------------------------------------------------------------- classification

export interface ClientProfile {
  name: string;
  okKeywords: string[];        // supplier name words typical of the client's own trade
  reviewKeywords: string[];    // words that suggest blocked credit u/s 17(5) or personal / capital use
  okHsnPrefixes?: string[];    // HSN / SAC prefixes typical of the client's purchases
}

// HSN / SAC prefixes that usually point to 17(5) / capital / personal items (review, not a conclusion)
export const REVIEW_HSN: { prefix: string; label: string }[] = [
  { prefix: '2523', label: 'cement' }, { prefix: '68', label: 'stone / cement articles' }, { prefix: '69', label: 'tiles / ceramics / sanitaryware' },
  { prefix: '72', label: 'iron & steel' }, { prefix: '73', label: 'iron / steel articles' }, { prefix: '7610', label: 'aluminium structures' },
  { prefix: '3208', label: 'paints' }, { prefix: '3209', label: 'paints' }, { prefix: '4410', label: 'boards / plywood' }, { prefix: '4412', label: 'plywood' },
  { prefix: '94', label: 'furniture / lighting' }, { prefix: '8415', label: 'air conditioners' }, { prefix: '87', label: 'vehicles / parts' },
  { prefix: '7113', label: 'jewellery' }, { prefix: '61', label: 'garments' }, { prefix: '62', label: 'garments' }, { prefix: '64', label: 'footwear' },
  { prefix: '9954', label: 'construction services / works contract' }, { prefix: '9972', label: 'real estate services' },
  { prefix: '998521', label: 'security services' }, { prefix: '998533', label: 'cleaning / housekeeping' }, { prefix: '998534', label: 'facility / maintenance' },
  { prefix: '9987', label: 'repair & maintenance services' }, { prefix: '9963', label: 'hotel / restaurant' }, { prefix: '9964', label: 'passenger transport' },
  { prefix: '9971', label: 'insurance / financial' }, { prefix: '9997', label: 'other personal services' }
];

// description words (also covers the old service-tax codes 0044xxxx that have no SAC prefix)
const REVIEW_DESC = /maintenance|repair|renting of immovable|works contract|construction|manpower|security|cleaning|housekeeping|catering|outdoor catering|rent.?a.?cab|tour operator|beauty|health club|fitness|interior decorat|architect|real estate/i;

export function hsnReview(items: HsnItem[], profile: ClientProfile): { ok: string[]; review: string[] } {
  const ok = items.filter(h => (profile.okHsnPrefixes || []).some(p => h.code.startsWith(p))).map(h => h.code);
  const review = items.flatMap(h => {
    const byCode = REVIEW_HSN.filter(r => h.code.startsWith(r.prefix)).map(r => `${h.code} ${r.label}`);
    if (byCode.length) return byCode;
    return h.description && REVIEW_DESC.test(h.description) ? [`${h.code} ${h.description.toLowerCase()}`] : [];
  });
  return { ok, review };
}

const COMMON_REVIEW = ['construction', 'builder', 'buildcon', 'infra', 'cement', 'tiles', 'marble', 'sanitary', 'hardware', 'paint',
  'plywood', 'interior', 'furniture', 'furnish', 'electrical', 'electricals', 'facility', 'faciliteez', 'maintenance', 'housekeeping',
  'security', 'restaurant', 'hotel', 'caterer', 'catering', 'sweets', 'bakery', 'travels', 'tours', 'motors', 'automobile', 'auto',
  'insurance', 'club', 'gym', 'fitness', 'salon', 'spa', 'jewel', 'garments', 'fashion', 'mobile', 'realty', 'estate', 'developers'];

export const CLIENT_PROFILES: Record<string, ClientProfile> = {
  pharmacy: {
    name: 'Pharmacy / medical store',
    okKeywords: ['pharma', 'pharmaceutical', 'medical', 'medicos', 'medicose', 'medicine', 'drug', 'chemist', 'surgical', 'healthcare',
      'health care', 'life science', 'lifescience', 'biotech', 'remedies', 'labs', 'laboratories', 'distributor', 'agencies', 'agency',
      'ayurved', 'herbal', 'diagnostic', 'nutrition', 'wellness', 'hospital'],
    reviewKeywords: COMMON_REVIEW,
    // medicines, nutrition, cosmetics / toiletries, surgical & medical devices, gloves, packing, diapers / sanitary
    okHsnPrefixes: ['30', '2106', '2202', '1901', '0402', '3304', '3305', '3306', '3307', '3401', '3402', '3005', '3006', '3822',
      '9018', '9019', '9020', '9021', '9025', '9027', '4014', '4015', '3926', '4818', '4819', '4823', '3923', '6307', '9619', '2936', '2941', '3002', '3003']
  },
  trader: { name: 'General trader', okKeywords: ['traders', 'trading', 'distributor', 'agencies', 'wholesale'], reviewKeywords: COMMON_REVIEW },
  generic: { name: 'Generic', okKeywords: [], reviewKeywords: COMMON_REVIEW }
};

export type Colour = 'GREEN' | 'YELLOW' | 'RED';

export interface Result {
  input: SupplierInput;
  local: LocalCheck;
  record: ProviderRecord | null;
  source: string;                 // where the verified facts came from
  verifiedAt: string | null;
  fromCache: boolean;
  colour: Colour;
  reasons: string[];              // why this colour
  verifiedFacts: string[];
  missing: string[];              // information not available / inconclusive
  lookup?: string;                // how the live data was obtained / why not (technical status)
}

function words(s: string) { return ' ' + s.toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' '; }
function hasWord(text: string, kw: string) { return words(text).includes(' ' + kw.toLowerCase() + ' '); }

const SERVICE_NOB = /service|works contract|leasing|office \/ sale office/i;

export function classify(input: SupplierInput, local: LocalCheck, record: ProviderRecord | null, profile: ClientProfile, lookupError?: string): Omit<Result, 'source' | 'verifiedAt' | 'fromCache'> {
  const red: string[] = []; const yellow: string[] = []; const facts: string[] = []; const missing: string[] = [];

  // local
  if (!local.formatOk || !local.checksumOk) red.push(...local.problems);
  else if (!local.state) yellow.push(...local.problems);
  else facts.push(`GSTIN format and check digit valid (state ${local.stateCode} ${local.state}; PAN holder type: ${local.panHolderType ?? 'unknown'})`);

  // client's own 2A / 2B data
  if (input.gstr1Filed !== undefined && input.gstr1Filed !== '') {
    if (/^n/i.test(input.gstr1Filed)) red.push('supplier GSTR-1 not filed for at least one bill as per client 2A/2B (as on its download date - re-check latest 2B) - ITC at risk u/s 16(2)(aa)');
    else facts.push(`GSTR-1 filing status in client 2A/2B: ${input.gstr1Filed}`);
  } else missing.push('GSTR-1 filing status (not in input file)');

  // provider
  if (record && record.found) {
    const st = record.status || '';
    facts.push(`Registration status: ${st || 'n/a'}`);
    if (record.legalName) facts.push(`Legal name: ${record.legalName}${record.tradeName && record.tradeName !== record.legalName ? ' / Trade name: ' + record.tradeName : ''}`);
    if (record.registrationDate) facts.push(`Registered on ${record.registrationDate}`);
    if (record.constitution) facts.push(`Constitution: ${record.constitution}`);
    if (record.taxpayerType) facts.push(`Taxpayer type: ${record.taxpayerType}`);
    if (record.address) facts.push(`Address: ${record.address}`);
    if (record.natureOfBusiness?.length) facts.push(`Nature of business: ${record.natureOfBusiness.join(', ')}`);
    else missing.push('nature of business (provider returned none)');

    if (/cancel/i.test(st)) {
      const cd = record.cancellationDate;
      if (cd && input.lastDate && input.lastDate < cd) yellow.push(`registration cancelled w.e.f. ${cd}; all bills in the input are dated before that - confirm`);
      else red.push(`registration CANCELLED${cd ? ' w.e.f. ' + cd : ''} - ITC not available on bills after cancellation`);
    } else if (/suspend/i.test(st)) red.push('registration SUSPENDED - confirm before claiming ITC');
    else if (st && !/^active/i.test(st)) yellow.push(`registration status "${st}" - confirm`);

    if (record.taxpayerType && /composition/i.test(record.taxpayerType) && (input.gst ?? 0) > 0)
      red.push('supplier is a COMPOSITION taxpayer but GST appears on the bills - composition dealers cannot charge GST, ITC not available');
    if (record.registrationDate && input.firstDate && input.firstDate < record.registrationDate)
      yellow.push(`first bill (${input.firstDate}) is before registration date (${record.registrationDate})`);
    if (record.natureOfBusiness?.some(n => SERVICE_NOB.test(n)) && !record.natureOfBusiness?.some(n => /retail|wholesale|supplier of goods|distributor/i.test(n)))
      yellow.push('supplier is registered for services / works contract only - check whether it is for the business and not blocked u/s 17(5) (works contract, repairs to immovable property, personal use)');
    if (record.returns && record.returns.length === 0) yellow.push('no returns found for the requested financial year');
  } else if (record && !record.found) {
    red.push('GSTIN not found on the GST network (provider) - confirm the number with the supplier; this alone does not mean the supplier is fake');
  } else {
    missing.push(lookupError ? `live registration data not available: ${lookupError}` : 'live registration data not fetched (no API key / API disabled)');
  }

  // patterns from the client's own data
  if (record?.found && input.name && (record.legalName || record.tradeName)) {
    if (namesMatch(input.name, record.legalName, record.tradeName)) facts.push(`books name "${input.name}" matches registered name`);
    else yellow.push(`books name "${input.name}" does not match registered name "${record.legalName}${record.tradeName && record.tradeName !== record.legalName ? ' / ' + record.tradeName : ''}" - check that the GSTIN in books is the right party`);
  } else if (record?.found && !input.name) missing.push('books-to-portal name comparison not possible (no supplier name in books / input)');
  const nameText = [input.name, record?.legalName, record?.tradeName].filter(Boolean).join(' ');
  const ok = profile.okKeywords.filter(k => hasWord(nameText, k));
  const rv = profile.reviewKeywords.filter(k => hasWord(nameText, k));
  if (rv.length && !ok.length) yellow.push(`name suggests non-trade purchase (${rv.join(', ')}) - confirm business use / 17(5)`);
  if (ok.length) facts.push(`name matches client trade (${ok.join(', ')})`);
  if (record?.hsn?.length) {
    const h = hsnReview(record.hsn, profile);
    facts.push(`declared HSN / SAC: ${record.hsn.map(x => x.code + (x.description ? ' ' + x.description : '')).join('; ')}`);
    if (h.review.length && !h.ok.length) yellow.push(`supplier's declared HSN / SAC point to non-trade items (${h.review.join(', ')}) - confirm business use / 17(5)`);
    else if (h.review.length) yellow.push(`supplier deals in trade items and also in ${h.review.join(', ')} - check what was billed`);
    else if (profile.okHsnPrefixes?.length && h.ok.length) facts.push(`declared HSN match client trade (${h.ok.join(', ')})`);
    else if (profile.okHsnPrefixes?.length) yellow.push('declared HSN / SAC do not match the client\'s usual purchases - check what was billed');
  } else if (record?.found) missing.push('declared HSN / SAC (not in this source)');
  if (input.fixedMonthly) yellow.push('same amount billed every month (maintenance / rent / AMC pattern) - confirm the premises is the business premises');

  // without a live record GREEN needs: name matches the client's trade AND GSTR-1 filed as per 2A/2B
  const offlineOk = !record && ok.length > 0 && !!input.gstr1Filed && /^y/i.test(input.gstr1Filed);
  const colour: Colour = red.length ? 'RED' : (yellow.length || (!record && !offlineOk)) ? 'YELLOW' : 'GREEN';
  const reasons = red.length ? red.concat(yellow) : yellow.length ? yellow
    : colour === 'YELLOW' ? ['registration not verified live and the name alone does not show the nature of business - verify before relying on ITC']
      : record ? ['no issue found in the checks performed']
        : ['offline checks passed (format, check digit, GSTR-1 filed, name matches trade); live registration NOT checked'];
  return { input, local, record, colour, reasons, verifiedFacts: facts, missing };
}

// ---------------------------------------------------------------- run

export interface RunOptions {
  clientName: string;
  profile: ClientProfile;
  provider: Provider | null;
  cache: GstinCache | null;
  maxAgeDays: number;
  maxApiLookups: number;          // credit budget for this run
  returnsFy?: string;
  dryRun?: boolean;
}

export interface RunSummary {
  client: string; profile: string; provider: string; ranAt: string;
  inputRows: number; duplicatesRemoved: number; unique: number;
  invalidLocally: number; fromCache: number; apiLookups: number; notLookedUpBudget: number;
  green: number; yellow: number; red: number; creditsRemaining: number | null; stoppedReason: string | null;
  apiCallsRequiredIfRun?: number;
}

export async function runVerification(inputRows: SupplierInput[], o: RunOptions): Promise<{ results: Result[]; summary: RunSummary; calls: CallLog[] }> {
  const { unique, duplicatesRemoved } = dedupeSuppliers(inputRows);
  const results: Result[] = [];
  let apiLookups = 0, fromCache = 0, invalid = 0, budgetSkipped = 0, needed = 0;
  let stopped: string | null = null;
  for (const s of unique) {
    const local = validateGstinLocal(s.gstin);
    s.gstin = local.gstin;
    let record: ProviderRecord | null = null; let source = 'local checks + client 2A/2B'; let verifiedAt: string | null = null; let cached = false; let err: string | undefined;
    if (!local.formatOk || !local.checksumOk) { invalid++; }
    else {
      const c = o.cache?.get(local.gstin, o.maxAgeDays);
      if (c) { record = c.record; source = c.source + ' (cache)'; verifiedAt = c.verifiedAt; cached = true; fromCache++; }
      else if (o.provider && !stopped) {
        needed++;
        if (o.dryRun) err = 'dry run - not looked up';
        else if (apiLookups >= o.maxApiLookups) { budgetSkipped++; err = `credit budget for this run (${o.maxApiLookups}) reached`; }
        else {
          try {
            apiLookups++;
            record = await o.provider.lookup(local.gstin, { returnsFy: o.returnsFy });
            verifiedAt = new Date().toISOString(); source = o.provider.name;
            if (record.found) o.cache?.put({ record, source: o.provider.name, verifiedAt });
          } catch (e) {
            if (e instanceof ProviderStop) { stopped = e.message; err = e.message; }
            else err = String((e as any)?.message || e);
          }
        }
      } else if (stopped) err = stopped;
    }
    const cl = classify(s, local, record, o.profile, err);
    results.push({ ...cl, source, verifiedAt, fromCache: cached });
  }
  o.cache?.save();
  const count = (c: Colour) => results.filter(r => r.colour === c).length;
  const summary: RunSummary = {
    client: o.clientName, profile: o.profile.name, provider: o.provider?.name || 'none (offline checks only)', ranAt: new Date().toISOString(),
    inputRows: inputRows.length, duplicatesRemoved, unique: unique.length, invalidLocally: invalid, fromCache, apiLookups,
    notLookedUpBudget: budgetSkipped, green: count('GREEN'), yellow: count('YELLOW'), red: count('RED'),
    creditsRemaining: o.provider?.creditsRemaining ?? null, stoppedReason: stopped
  };
  if (o.dryRun) summary.apiCallsRequiredIfRun = needed * (o.returnsFy ? 2 : 1);
  return { results, summary, calls: o.provider?.calls || [] };
}

// ---------------------------------------------------------------- Excel report

const FILL: Record<Colour, string> = { GREEN: 'FFC6EFCE', YELLOW: 'FFFFEB9C', RED: 'FFFFC7CE' };

export async function writeReport(file: string, results: Result[], summary: RunSummary, calls: CallLog[]) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Aetherwise gstin-verify';
  const bold = { bold: true };

  const s = wb.addWorksheet('Summary');
  s.columns = [{ width: 38 }, { width: 60 }];
  const rows: [string, any][] = [
    ['Aetherwise - Supplier GSTIN verification', ''],
    ['Client', summary.client], ['Client profile', summary.profile], ['Run at (UTC)', summary.ranAt],
    ['Data source for live data', summary.provider],
    ['Input rows', summary.inputRows], ['Duplicate GSTIN rows removed', summary.duplicatesRemoved], ['Unique GSTINs', summary.unique],
    ['Failed local format / check digit', summary.invalidLocally], ['Taken from cache', summary.fromCache],
    ['Live API lookups this run', summary.apiLookups], ['Skipped - run credit budget reached', summary.notLookedUpBudget],
    ['API credits remaining (as reported)', summary.creditsRemaining ?? 'n/a'],
    ['Stopped early', summary.stoppedReason ?? 'No'],
    ['GREEN', summary.green], ['YELLOW', summary.yellow], ['RED', summary.red]
  ];
  if (summary.apiCallsRequiredIfRun !== undefined) rows.push(['DRY RUN - API credits needed for a real run', summary.apiCallsRequiredIfRun]);
  rows.forEach(r => s.addRow(r));
  s.getRow(1).font = { bold: true, size: 14 };
  (['GREEN', 'YELLOW', 'RED'] as Colour[]).forEach(c => {
    s.eachRow(r => { if (r.getCell(1).value === c) r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL[c] } }; });
  });
  s.addRow([]);
  s.addRow(['Legend']).font = bold;
  s.addRow(['GREEN', 'All checks performed passed. Still keep the bill on record.']);
  s.addRow(['YELLOW', 'Needs confirmation (use, 17(5), pattern, or data not available). Not an adverse finding.']);
  s.addRow(['RED', 'A verified problem: invalid number, cancelled / suspended, composition charging GST, GSTR-1 not filed, or not found. Confirm with supplier before claiming ITC.']);
  s.addRow(['Note', 'A missing or unavailable record is never treated as proof that a supplier is fake.']);
  s.addRow(['Lookup column', 'RESULT / NOT_FOUND = data read from the source. PAGE_MISSING / PARSE_FAILED / NO LIVE DATA = technical, not a compliance finding (always YELLOW).']);

  const w = wb.addWorksheet('Suppliers', { views: [{ state: 'frozen', ySplit: 1 }] });
  w.columns = [
    { header: 'Result', key: 'c', width: 9 }, { header: 'Lookup', key: 'lk', width: 16 }, { header: 'GSTIN', key: 'g', width: 18 }, { header: 'Supplier (input)', key: 'n', width: 32 },
    { header: 'Bills', key: 'b', width: 7 }, { header: 'Taxable', key: 't', width: 12 }, { header: 'GST', key: 'x', width: 11 },
    { header: 'Reasons for result', key: 'r', width: 70 },
    { header: 'Legal name (verified)', key: 'ln', width: 30 }, { header: 'Trade name (verified)', key: 'tn', width: 30 },
    { header: 'Status (verified)', key: 'st', width: 12 }, { header: 'Taxpayer type', key: 'tt', width: 13 },
    { header: 'Constitution', key: 'co', width: 18 }, { header: 'Reg. date', key: 'rd', width: 11 }, { header: 'Cancel date', key: 'cd', width: 11 },
    { header: 'Nature of business (verified)', key: 'nb', width: 40 }, { header: 'Declared HSN / SAC (verified)', key: 'hs', width: 40 }, { header: 'Address (verified)', key: 'ad', width: 40 }, { header: 'Jurisdiction (verified)', key: 'ju', width: 40 },
    { header: 'GSTR-1 filed (2A/2B)', key: 'r1', width: 10 },
    { header: 'Verified facts', key: 'vf', width: 60 }, { header: 'Missing / inconclusive', key: 'ms', width: 50 },
    { header: 'Source', key: 'src', width: 28 }, { header: 'Verified at (UTC)', key: 'va', width: 22 }
  ];
  w.getRow(1).font = bold;
  const order: Record<Colour, number> = { RED: 0, YELLOW: 1, GREEN: 2 };
  for (const r of [...results].sort((a, b) => order[a.colour] - order[b.colour] || (b.input.gst ?? 0) - (a.input.gst ?? 0))) {
    const rec = r.record;
    const row = w.addRow({
      c: r.colour, lk: r.lookup ?? (r.record ? 'RESULT' : r.local.checksumOk ? 'NO LIVE DATA' : 'INVALID GSTIN'), g: r.local.gstin, n: r.input.name ?? '', b: r.input.bills ?? '', t: r.input.taxable ?? '', x: r.input.gst ?? '',
      r: r.reasons.join(' | '),
      ln: rec?.legalName ?? '', tn: rec?.tradeName ?? '', st: rec ? (rec.found ? rec.status ?? '' : 'NOT FOUND') : '',
      tt: rec?.taxpayerType ?? '', co: rec?.constitution ?? '', rd: rec?.registrationDate ?? '', cd: rec?.cancellationDate ?? '',
      nb: rec?.natureOfBusiness?.join(', ') ?? '', ju: rec?.jurisdiction ?? '', hs: rec?.hsn?.map(h => h.code + (h.description ? ' ' + h.description : '')).join('; ') ?? '', ad: rec?.address ?? '', r1: r.input.gstr1Filed ?? '',
      vf: r.verifiedFacts.join(' | '), ms: r.missing.join(' | '), src: r.source, va: r.verifiedAt ?? ''
    });
    row.getCell('c').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL[r.colour] } };
    row.alignment = { vertical: 'top', wrapText: true };
    ['t', 'x'].forEach(k => row.getCell(k).numFmt = '#,##0.00');
  }
  w.autoFilter = { from: 'A1', to: 'X1' };

  const a = wb.addWorksheet('API calls (audit)');
  a.columns = [{ header: 'Time (UTC)', key: 'at', width: 24 }, { header: 'GSTIN', key: 'gstin', width: 18 }, { header: 'Endpoint', key: 'endpoint', width: 22 },
  { header: 'HTTP', key: 'httpStatus', width: 7 }, { header: 'Outcome', key: 'outcome', width: 40 }, { header: 'Attempt', key: 'attempt', width: 8 },
  { header: 'Credits left', key: 'creditsRemaining', width: 12 }, { header: 'ms', key: 'ms', width: 8 }];
  a.getRow(1).font = bold;
  calls.forEach(c => a.addRow(c));

  fs.mkdirSync(path.dirname(file), { recursive: true });
  await wb.xlsx.writeFile(file);
}
