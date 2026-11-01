// node --test test/   (run after `npx tsc -p .`)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import * as g from '../dist/gstin.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstin-test-'));

// Publicly published sample GSTINs (no client data in this repo)
const VALID = ['27AAPFU0939F1ZV', '33AAACC1206D1ZN'];

function makeValid(prefix14) { return prefix14 + g.gstinCheckDigit(prefix14); }

test('check digit: published samples pass, one-character typo fails', () => {
  for (const x of VALID) assert.equal(g.validateGstinLocal(x).checksumOk, true, x);
  const typo = '27AAPFU0939F1ZW';
  const r = g.validateGstinLocal(typo);
  assert.equal(r.formatOk, true);
  assert.equal(r.checksumOk, false);
  assert.match(r.problems.join(), /check digit/);
});

test('format: wrong length / lowercase / spaces', () => {
  assert.equal(g.validateGstinLocal('27AAPFU0939F1Z').formatOk, false);
  assert.equal(g.validateGstinLocal(' 27aapfu0939f1zv ').checksumOk, true);
  const r = g.validateGstinLocal('27AAPFU0939F1ZV');
  assert.equal(r.state, 'Maharashtra');
  assert.equal(r.panHolderType, 'Firm / LLP');
});

test('provider test GSTIN is allowed through local checks', () => {
  assert.equal(g.validateGstinLocal(g.PROVIDER_TEST_GSTIN).checksumOk, true);
});

test('dedupe sums bills / amounts and keeps worst filing status', () => {
  const { unique, duplicatesRemoved } = g.dedupeSuppliers([
    { gstin: VALID[0], taxable: 100, gst: 18, gstr1Filed: 'Y' },
    { gstin: VALID[0].toLowerCase(), taxable: 50, gst: 9, gstr1Filed: 'N' },
    { gstin: VALID[1] }
  ]);
  assert.equal(duplicatesRemoved, 1);
  assert.equal(unique.length, 2);
  assert.equal(unique[0].bills, 2);
  assert.equal(unique[0].taxable, 150);
  assert.equal(unique[0].gst, 27);
  assert.equal(unique[0].gstr1Filed, 'N');
});

test('reads csv with header not on first row and dd-mm-yyyy dates', async () => {
  const f = path.join(tmp, 'in.csv');
  fs.writeFileSync(f, 'Report title,,\n"Supplier Name",GSTIN of supplier,Taxable,Invoice date,GSTR-1 filing status\n"A, B & Co",27AAPFU0939F1ZV,"1,000.50",05-04-2026,Y\n');
  const rows = await g.readSupplierFile(f);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'A, B & Co');
  assert.equal(rows[0].taxable, 1000.5);
  assert.equal(rows[0].lastDate, '2026-04-05');
  assert.equal(rows[0].gstr1Filed, 'Y');
});

test('reads xlsx', async () => {
  const f = path.join(tmp, 'in.xlsx');
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('2A');
  ws.addRow(['GSTIN', 'Trade name', 'GST']); ws.addRow([VALID[1], 'X Medical Agencies', 36]);
  await wb.xlsx.writeFile(f);
  const rows = await g.readSupplierFile(f);
  assert.deepEqual([rows[0].gstin, rows[0].name, rows[0].gst], [VALID[1], 'X Medical Agencies', 36]);
});

// ---------- provider with fake fetch
function fakeFetch(script) {
  const seen = [];
  const fn = async (url, init) => {
    seen.push({ url, init });
    const step = script.shift();
    if (step instanceof Error) throw step;
    const [status, body, headers = {}] = step;
    return { status, headers: { get: n => headers[n.toLowerCase()] ?? null }, text: async () => JSON.stringify(body) };
  };
  fn.seen = seen;
  return fn;
}
const okBody = (gstin, extra = {}) => ({ success: true, gstin, credits_remaining: 70, profile_complete: true,
  data: { gstin, legal_name: 'LEGAL', trade_name: 'TRADE', status: 'Active', taxpayer_type: 'Regular', business_constitution: 'Partnership',
    registration_date: '2018-10-19', cancellation_date: null, address: 'Somewhere', nature_of_business: ['Retail Business'], ...extra } });
const noSleep = { sleep: async () => {}, minIntervalMs: 0 };

test('provider: parses profile response, sends key only in header', async () => {
  const f = fakeFetch([[200, okBody(VALID[0])]]);
  const p = new g.GstinApiProvider('SECRET-KEY', { fetchFn: f, ...noSleep });
  const r = await p.lookup(VALID[0]);
  assert.equal(r.found, true); assert.equal(r.constitution, 'Partnership'); assert.deepEqual(r.natureOfBusiness, ['Retail Business']);
  assert.equal(f.seen[0].init.headers['x-api-key'], 'SECRET-KEY');
  assert.ok(!f.seen[0].url.includes('SECRET'));
  assert.ok(f.seen[0].url.endsWith('?include=profile'));
  assert.equal(p.creditsRemaining, 70);
  assert.ok(!JSON.stringify(p.calls).includes('SECRET'), 'key must never be in call log');
});

test('provider: 429 then 502 then 200 is retried with backoff honouring Retry-After', async () => {
  const waits = [];
  const f = fakeFetch([[429, { success: false, error: 'rate' }, { 'retry-after': '7' }], [502, { success: false }], [200, okBody(VALID[0])]]);
  const p = new g.GstinApiProvider('k', { fetchFn: f, minIntervalMs: 0, sleep: async ms => { waits.push(ms); } });
  const r = await p.lookup(VALID[0]);
  assert.equal(r.found, true);
  assert.equal(p.calls.length, 3);
  assert.ok(waits.includes(7000), 'Retry-After respected');
  assert.ok(waits.includes(4000), 'exponential backoff on 2nd failure');
});

test('provider: retries exhausted -> error, network error is retryable', async () => {
  const f = fakeFetch([new Error('ECONNRESET'), [502, {}], [502, {}]]);
  const p = new g.GstinApiProvider('k', { fetchFn: f, ...noSleep });
  await assert.rejects(p.lookup(VALID[0]), /unavailable after 3/);
});

test('provider: 404 = not found (no throw), 401/402 stop the batch', async () => {
  const p404 = new g.GstinApiProvider('k', { fetchFn: fakeFetch([[404, { success: false, error: 'not registered' }]]), ...noSleep });
  assert.equal((await p404.lookup(VALID[0])).found, false);
  const p401 = new g.GstinApiProvider('k', { fetchFn: fakeFetch([[401, {}]]), ...noSleep });
  await assert.rejects(p401.lookup(VALID[0]), g.ProviderStop);
  const p402 = new g.GstinApiProvider('k', { fetchFn: fakeFetch([[402, {}]]), ...noSleep });
  await assert.rejects(p402.lookup(VALID[0]), /credits/);
});

test('provider: throttle waits between calls', async () => {
  const waits = [];
  const f = fakeFetch([[200, okBody(VALID[0])], [200, okBody(VALID[1])]]);
  const p = new g.GstinApiProvider('k', { fetchFn: f, minIntervalMs: 1100, sleep: async ms => { waits.push(ms); } });
  await p.lookup(VALID[0]); await p.lookup(VALID[1]);
  assert.ok(waits.some(w => w > 1000), 'second call throttled');
});

// ---------- classification
const P = g.CLIENT_PROFILES.pharmacy;
const rec = (o = {}) => ({ gstin: VALID[0], found: true, status: 'Active', taxpayerType: 'Regular', legalName: 'L', natureOfBusiness: ['Wholesale Business'], ...o });
const L0 = g.validateGstinLocal(VALID[0]);

test('classify: active trade supplier = GREEN', () => {
  assert.equal(g.classify({ gstin: VALID[0], name: 'ABC Pharma Distributors', gstr1Filed: 'Y' }, L0, rec(), P).colour, 'GREEN');
});
test('classify: cancelled = RED; cancelled after last bill = YELLOW', () => {
  assert.equal(g.classify({ gstin: VALID[0] }, L0, rec({ status: 'Cancelled', cancellationDate: '2026-05-01' }), P).colour, 'RED');
  assert.equal(g.classify({ gstin: VALID[0], lastDate: '2026-04-10' }, L0, rec({ status: 'Cancelled', cancellationDate: '2026-05-01' }), P).colour, 'YELLOW');
});
test('classify: composition charging GST = RED', () => {
  const c = g.classify({ gstin: VALID[0], gst: 50 }, L0, rec({ taxpayerType: 'Composition' }), P);
  assert.equal(c.colour, 'RED'); assert.match(c.reasons.join(), /COMPOSITION/);
});
test('classify: GSTR-1 not filed in 2A = RED', () => {
  assert.equal(g.classify({ gstin: VALID[0], gstr1Filed: 'N' }, L0, rec(), P).colour, 'RED');
});
test('classify: not found is RED but never called fake', () => {
  const c = g.classify({ gstin: VALID[0] }, L0, { gstin: VALID[0], found: false }, P);
  assert.equal(c.colour, 'RED'); assert.match(c.reasons.join(), /does not mean the supplier is fake/);
});
test('classify: services / works contract, facility name, fixed monthly = YELLOW with reasons', () => {
  const c = g.classify({ gstin: VALID[0], name: 'Preserve Faciliteez Pvt Ltd', fixedMonthly: true }, L0, rec({ natureOfBusiness: ['Supplier of Services', 'Works Contract'] }), P);
  assert.equal(c.colour, 'YELLOW');
  assert.equal(c.reasons.length, 3);
});
test('classify: API unavailable -> YELLOW with missing info, not RED', () => {
  const c = g.classify({ gstin: VALID[0], name: 'Some Enterprises' }, L0, null, P, 'provider unavailable');
  assert.equal(c.colour, 'YELLOW'); assert.match(c.missing.join(), /provider unavailable/);
});
test('classify: offline GREEN needs trade name AND GSTR-1 filed', () => {
  assert.equal(g.classify({ gstin: VALID[0], name: 'Om Medical Agencies', gstr1Filed: 'Y' }, L0, null, P).colour, 'GREEN');
  assert.equal(g.classify({ gstin: VALID[0], name: 'Om Medical Agencies' }, L0, null, P).colour, 'YELLOW');
});

// ---------- run, cache, budget, report
test('run: cache avoids repeat calls, budget and stop are respected, report is written', async () => {
  process.env.AETHERWISE_DATA_DIR = tmp;
  const cacheFile = path.join(tmp, 'c.json');
  const a = makeValid('06AAAAA1111A1Z'), b = makeValid('06BBBBB2222B1Z'), c = makeValid('06CCCCC3333C1Z');
  const mock = new g.MockProvider({ [a]: rec({ gstin: a }), [b]: rec({ gstin: b }), [c]: 'stop' });
  const rows = [{ gstin: a, name: 'A Pharma' }, { gstin: a }, { gstin: b, name: 'B Medical' }, { gstin: c }, { gstin: 'BADGSTIN' }];

  const r1 = await g.runVerification(rows, { clientName: 'Test', profile: P, provider: mock, cache: new g.GstinCache(cacheFile), maxAgeDays: 30, maxApiLookups: 10 });
  assert.equal(r1.summary.duplicatesRemoved, 1);
  assert.equal(r1.summary.invalidLocally, 1);
  assert.equal(r1.summary.apiLookups, 3);
  assert.match(r1.summary.stoppedReason, /credits/);

  const mock2 = new g.MockProvider({});
  const r2 = await g.runVerification(rows, { clientName: 'Test', profile: P, provider: mock2, cache: new g.GstinCache(cacheFile), maxAgeDays: 30, maxApiLookups: 0 });
  assert.equal(r2.summary.fromCache, 2);
  assert.equal(mock2.calls.length, 0, 'cached GSTINs not re-queried; budget 0 blocks the rest');
  assert.equal(r2.summary.notLookedUpBudget, 1);

  const dry = await g.runVerification(rows, { clientName: 'Test', profile: P, provider: new g.MockProvider({}), cache: null, maxAgeDays: 30, maxApiLookups: 10, dryRun: true, returnsFy: '2026-27' });
  assert.equal(dry.summary.apiCallsRequiredIfRun, 6);
  assert.equal(dry.summary.apiLookups, 0);

  const out = path.join(tmp, 'report.xlsx');
  await g.writeReport(out, r1.results, r1.summary, r1.calls);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(out);
  assert.deepEqual(wb.worksheets.map(w => w.name), ['Summary', 'Suppliers', 'API calls (audit)']);
  assert.equal(wb.getWorksheet('Suppliers').rowCount, 5);
  assert.equal(wb.getWorksheet('Suppliers').getRow(2).getCell(1).value, 'RED');
});

test('audit log is append-only JSONL without the key', () => {
  const f = path.join(tmp, 'audit.jsonl');
  g.appendAudit(f, 'C1', [{ at: 'x', gstin: VALID[0], endpoint: 'gstin', httpStatus: 200, outcome: 'ok', creditsRemaining: 1, attempt: 1, ms: 3 }]);
  g.appendAudit(f, 'C1', [{ at: 'y', gstin: VALID[1], endpoint: 'gstin', httpStatus: 404, outcome: 'nf', creditsRemaining: 1, attempt: 1, ms: 3 }]);
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2); assert.equal(JSON.parse(lines[1]).client, 'C1');
});
