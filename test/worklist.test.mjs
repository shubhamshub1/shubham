// Resumable worklist, fully offline (no portal access, no browser). Fixtures are synthetic portal pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import * as wl from '../dist/worklist.mjs';
import * as g from '../dist/gstin.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(here, 'fixtures');
const ACTIVE = '27AAPFU0939F1ZV', CANC = '33AAACC1206D1ZN', SVC = '06AAPFU0939F1ZZ';
const MISS = '06AAAAA1111A1Z' + g.gstinCheckDigit('06AAAAA1111A1Z');
const activeText = fs.readFileSync(path.join(FX, 'portal_active.html'), 'utf8');

function freshData() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-')); process.env.AETHERWISE_DATA_DIR = d; return d; }

test('start builds queue, marks invalid, dedupes; progress counts pending', () => {
  freshData();
  const books = new Map([[ACTIVE, { name: 'Sample Medical Agencies', gstr1Date: '13-May-26' }]]);
  const w = wl.startWorklist({ client: 'C', profile: 'pharmacy', gstins: [ACTIVE, CANC, '06ABCDE1234F1Z9', ACTIVE], books, booksSource: '2A' });
  const p = wl.progress(w);
  assert.equal(p.total, 3);              // dupe removed
  assert.equal(p.invalid, 1);
  assert.equal(p.pending, 2);
  assert.equal(w.items[ACTIVE].books.name, 'Sample Medical Agencies');
});

test('add by pasted text marks the matching item done and advances progress; resume persists', async () => {
  const d = freshData();
  wl.startWorklist({ client: 'C', profile: 'pharmacy', gstins: [ACTIVE, CANC, MISS], books: new Map(), booksSource: 'none' });
  const { worklist, outcomes } = await wl.addResults('C', { text: activeText });
  assert.equal(outcomes[0].gstin, ACTIVE); assert.equal(outcomes[0].status, 'done'); assert.equal(outcomes[0].matchedToWorklist, true);
  assert.equal(wl.progress(worklist).done, 1);
  // simulate a restart: reload from disk only
  const reloaded = wl.load('C');
  assert.equal(reloaded.items[ACTIVE].status, 'done');
  assert.equal(reloaded.items[ACTIVE].record.legalName, 'SAMPLE & SONS HEALTHCARE LLP');
  assert.equal(wl.progress(reloaded).pending, 2);
  assert.ok(fs.existsSync(path.join(d, 'worklist_C.json')));
});

test('re-start after progress keeps done items and only adds new pending ones', async () => {
  freshData();
  wl.startWorklist({ client: 'C', profile: 'pharmacy', gstins: [ACTIVE, CANC], books: new Map(), booksSource: 'x' });
  await wl.addResults('C', { text: activeText });
  const w2 = wl.startWorklist({ client: 'C', profile: 'pharmacy', gstins: [ACTIVE, CANC, SVC], books: new Map(), booksSource: 'x' });
  assert.equal(w2.items[ACTIVE].status, 'done');   // preserved
  assert.equal(w2.items[SVC].status, 'pending');   // newly added
  assert.equal(wl.progress(w2).total, 3);
});

test('reset=true discards earlier progress', async () => {
  freshData();
  wl.startWorklist({ client: 'C', profile: 'pharmacy', gstins: [ACTIVE], books: new Map(), booksSource: 'x' });
  await wl.addResults('C', { text: activeText });
  const w = wl.startWorklist({ client: 'C', profile: 'pharmacy', gstins: [ACTIVE], books: new Map(), booksSource: 'x', reset: true });
  assert.equal(w.items[ACTIVE].status, 'pending');
});

test('a later parse failure does not overwrite a good result; unknown GSTIN reported, not forced in', async () => {
  freshData();
  wl.startWorklist({ client: 'C', profile: 'generic', gstins: [ACTIVE], books: new Map(), booksSource: 'x' });
  await wl.addResults('C', { text: activeText });
  const { worklist, outcomes } = await wl.addResults('C', { text: 'garbage that mentions ' + ACTIVE + ' but is not a result page' });
  assert.equal(worklist.items[ACTIVE].status, 'done', 'stays done');
  // a page for a GSTIN not in the worklist
  const { outcomes: o2 } = await wl.addResults('C', { text: fs.readFileSync(path.join(FX, 'portal_cancelled_copied.txt'), 'utf8') });
  assert.equal(o2[0].matchedToWorklist, false);
  assert.match(o2[0].error, /not in this worklist/);
});

test('report is safe before completion: pending shown technical, not RED; verified cancelled is RED', async () => {
  const d = freshData();
  const books = new Map([[ACTIVE, { name: 'Sample Medical Agencies', gstr1Date: '13-May-26' }], [CANC, { name: 'Sample Buildcon', lastDate: '2026-07-01' }]]);
  wl.startWorklist({ client: 'Jetaa', profile: 'pharmacy', gstins: [ACTIVE, CANC, MISS], books, booksSource: 'client 2A' });
  await wl.addResults('Jetaa', { text: activeText });
  await wl.addResults('Jetaa', { folderPath: FX });   // brings in the cancelled page too
  const out = path.join(d, 'rep.xlsx');
  const r = await wl.buildReport('Jetaa', out, false);
  const row = x => r.rows.find(z => z.gstin === x);
  assert.equal(row(ACTIVE).colour, 'GREEN', row(ACTIVE).reasons.join());
  assert.equal(row(CANC).colour, 'RED'); assert.equal(row(CANC).category, 'CANCELLED');
  assert.equal(row(MISS).colour, 'YELLOW'); assert.equal(row(MISS).category, 'TECHNICAL'); assert.equal(row(MISS).worklist_status, 'pending');
  assert.ok(row(MISS).reasons[0].startsWith('TECHNICAL'));
  assert.deepEqual(r.pending, [MISS]);
  assert.equal(r.summary.pending, 1);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(out);
  assert.equal(wb.getWorksheet('Suppliers').rowCount, 4);
});

test('MCP end to end: start -> add (paste) -> report, with Tally unreachable (read-only, no crash)', async () => {
  const d = freshData();
  const got = await new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(here, '..', 'dist', 'index.mjs')], { env: { ...process.env, AETHERWISE_DATA_DIR: d, TALLY_PORT: '1', GSTINAPI_API_KEY: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = ''; const res = new Map();
    const t = setTimeout(() => { proc.kill(); reject(new Error('timeout ' + buf.slice(0, 300))); }, 30000);
    const send = m => proc.stdin.write(JSON.stringify(m) + '\n');
    proc.stdout.on('data', x => {
      buf += x; for (const l of buf.split('\n')) { try { const j = JSON.parse(l); if (j.id) res.set(j.id, j); } catch {} }
      if (res.has(2) && !res.has(3)) send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gstin-worklist-start', arguments: { clientName: 'E2E', gstins: [ACTIVE, CANC], clientProfile: 'pharmacy' } } });
      if (res.has(3) && !res.has(4)) send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'gstin-worklist-add', arguments: { clientName: 'E2E', text: activeText } } });
      if (res.has(4) && !res.has(5)) send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'gstin-worklist-report', arguments: { clientName: 'E2E', outputPath: path.join(d, 'e2e.xlsx') } } });
      if (res.has(5)) { clearTimeout(t); proc.kill(); resolve(res); }
    });
    for (const m of [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' }
    ]) send(m);
  });
  const names = got.get(2).result.tools.map(t => t.name);
  for (const n of ['trial-balance', 'import-xml-file', 'gstin-worklist-start', 'gstin-worklist-add', 'gstin-worklist-report']) assert.ok(names.includes(n), n);
  const add = JSON.parse(got.get(4).result.content[0].text);
  assert.equal(add.outcomes[0].status, 'done'); assert.equal(add.progress.done, 1); assert.equal(add.progress.pending, 1);
  const rep = JSON.parse(got.get(5).result.content[0].text);
  assert.equal(rep.rows.find(r => r.gstin === ACTIVE).colour, 'GREEN');
  assert.deepEqual(rep.pending, [CANC]);
  assert.ok(fs.existsSync(path.join(d, 'e2e.xlsx')));
});

test('worklist code performs no network and no browser automation', () => {
  const s = fs.readFileSync(path.join(here, '..', 'src', 'worklist.mts'), 'utf8');
  assert.ok(!/playwright|puppeteer|child_process|fetch\(|node:https?/.test(s));
});

test('ingest a tabular status export (Tally "Validate Party GSTIN/UIN" style) - all rows in one call', async () => {
  const d = freshData();
  wl.startWorklist({ client: 'T', profile: 'pharmacy', gstins: [ACTIVE, CANC, SVC], books: new Map([[ACTIVE, { name: 'X' }]]), booksSource: 'x' });
  const f = path.join(d, 'tally_validate_export.xlsx');
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Sheet1');
  ws.addRow(['GSTIN/UIN', 'Legal Name', 'Trade Name', 'GSTIN/UIN Status', 'Registration Date', 'Date of Cancellation', 'Taxpayer Type']);
  ws.addRow([ACTIVE, 'ALPHA PHARMA DISTRIBUTORS PVT LTD', 'ALPHA PHARMA', 'Active', '01/07/2017', '', 'Regular']);
  ws.addRow([CANC, 'GAMMA INFRA', 'GAMMA', 'Cancelled', '05/05/2018', '31/05/2026', 'Regular']);
  ws.addRow([SVC, '', '', 'No record found', '', '', '']);
  await wb.xlsx.writeFile(f);
  const { worklist, outcomes } = await wl.addResults('T', { filePath: f });
  assert.equal(outcomes.length, 3);
  assert.equal(worklist.items[ACTIVE].status, 'done');
  assert.equal(worklist.items[ACTIVE].record.status, 'Active');
  assert.equal(worklist.items[ACTIVE].record.legalName, 'ALPHA PHARMA DISTRIBUTORS PVT LTD');
  assert.equal(worklist.items[ACTIVE].record.registrationDate, '2017-07-01');
  assert.equal(worklist.items[CANC].status, 'done');
  assert.equal(worklist.items[CANC].record.cancellationDate, '2026-05-31');
  assert.equal(worklist.items[SVC].status, 'not_found');
  assert.equal(wl.progress(worklist).resolved, 3);
  // report: active pharma GREEN, cancelled RED, no-record RED
  const out = path.join(d, 'r.xlsx');
  const r = await wl.buildReport('T', out, false);
  assert.equal(r.rows.find(x => x.gstin === ACTIVE).colour, 'GREEN');
  assert.equal(r.rows.find(x => x.gstin === CANC).category, 'CANCELLED');
  assert.equal(r.rows.find(x => x.gstin === SVC).category, 'NOT_FOUND_AT_SOURCE');
});

test('status export: a row for a GSTIN not in the worklist is reported, not forced in', async () => {
  const d = freshData();
  wl.startWorklist({ client: 'T2', profile: 'generic', gstins: [ACTIVE], books: new Map(), booksSource: 'x' });
  const f = path.join(d, 's.csv');
  fs.writeFileSync(f, 'GSTIN,GSTIN/UIN Status,Legal Name\n' + CANC + ',Active,SOME CO\n');
  const { worklist, outcomes } = await wl.addResults('T2', { filePath: f });
  assert.equal(outcomes[0].matchedToWorklist, false);
  assert.equal(worklist.items[ACTIVE].status, 'pending', 'unrelated row does not touch pending item');
});
