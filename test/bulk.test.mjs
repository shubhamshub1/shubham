// Consolidated report from user-saved portal pages. Fully offline: no portal access, no browser automation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import * as bj from '../dist/bulkjob.mjs';
import * as g from '../dist/gstin.mjs';
import { xmlQueryCollection } from '../dist/definition.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(here, 'fixtures');
const ACTIVE = '27AAPFU0939F1ZV', CANC = '33AAACC1206D1ZN', SVC = '06AAPFU0939F1ZZ', TYPO = '27AAPFU0939F1ZW';
const NF = '27AAAAA2222A1Z' + g.gstinCheckDigit('27AAAAA2222A1Z');
const MISSING = '06AAAAA1111A1Z' + g.gstinCheckDigit('06AAAAA1111A1Z');

test('bulk from saved pages: one row per GSTIN, technical vs verified kept apart, books comparison, report', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-')); process.env.AETHERWISE_DATA_DIR = data;
  const out = path.join(data, 'report.xlsx');
  const dir = path.join(data, 'pages'); fs.mkdirSync(dir);
  for (const f of fs.readdirSync(FX)) fs.copyFileSync(path.join(FX, f), path.join(dir, f));
  fs.copyFileSync(path.join(FX, 'portal_notfound.html'), path.join(dir, NF + '.html'));   // not-found page has no GSTIN in its text -> file name used
  const books = new Map([[ACTIVE, { name: 'Sample Medical Agencies', gstr1Filed: 'Y' }], [SVC, { name: 'Shree Ram Medicos' }]]);
  const r = await bj.bulkFromSavedPages({ gstins: [ACTIVE, CANC, SVC, NF, MISSING, TYPO, ACTIVE], folderPath: dir, clientName: 'Test',
    profile: g.CLIENT_PROFILES.pharmacy, books, booksSource: 'test books', outputPath: out, saveToCache: false });
  const row = x => r.rows.find(z => z.gstin === x);
  assert.equal(r.summary.duplicatesRemoved, 1);
  assert.equal(row(ACTIVE).colour, 'GREEN', row(ACTIVE).reasons.join());
  assert.equal(row(ACTIVE).lookup, 'RESULT');
  assert.ok(row(ACTIVE).verified_at, 'page date used as verification time');
  assert.equal(row(CANC).colour, 'RED');
  assert.equal(row(SVC).colour, 'YELLOW'); assert.ok(row(SVC).reasons.some(x => /does not match registered name/.test(x)));
  assert.equal(row(NF).lookup, 'NOT_FOUND'); assert.equal(row(NF).colour, 'RED');
  assert.equal(row(MISSING).lookup, 'PAGE_MISSING'); assert.equal(row(MISSING).colour, 'YELLOW');
  assert.match(row(MISSING).finding_type, /technical/); assert.match(row(MISSING).reasons[0], /^TECHNICAL \(PAGE_MISSING\)/); assert.equal(row(MISSING).verified_at, null);
  assert.equal(row(TYPO).lookup, 'NOT_CHECKED (invalid GSTIN)'); assert.equal(row(TYPO).colour, 'RED');
  assert.deepEqual(r.missingPages, [MISSING]);
  assert.equal(r.summary.technicalFailures, 1);
  assert.ok(row(CANC).missing.some(x => /comparison not possible/.test(x)));
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(out);
  const ws = wb.getWorksheet('Suppliers');
  assert.equal(ws.rowCount, 7);
  const hdr = ws.getRow(1).values.join('|');
  for (const h of ['Lookup', 'Legal name', 'Trade name', 'Status', 'Reg. date', 'Address', 'Jurisdiction', 'HSN / SAC', 'Verified at', 'Source', 'Reasons']) assert.ok(hdr.includes(h), h);
  const missRow = ws.getRows(2, 6).find(x => x.getCell(3).value === MISSING);
  assert.equal(missRow.getCell(1).value, 'YELLOW'); assert.equal(missRow.getCell(2).value, 'PAGE_MISSING');
  assert.ok(!fs.existsSync(path.join(data, 'gstin-cache.json')));
});

test('bulk: page chosen by GSTIN on the page, not by file name; missing folder is a clear error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-'));
  fs.copyFileSync(path.join(FX, 'portal_active.html'), path.join(dir, 'random name.html'));
  const r = await bj.bulkFromSavedPages({ gstins: [ACTIVE], folderPath: dir, clientName: 'T', profile: g.CLIENT_PROFILES.generic, books: new Map(), booksSource: 'none', outputPath: path.join(dir, 'r.xlsx'), saveToCache: false });
  assert.equal(r.rows[0].lookup, 'RESULT');
  await assert.rejects(bj.bulkFromSavedPages({ gstins: [ACTIVE], folderPath: path.join(dir, 'nope'), clientName: 'T', profile: g.CLIENT_PROFILES.generic, books: new Map(), booksSource: '', outputPath: 'x.xlsx', saveToCache: false }), /folder not found/);
});

test('Tally access used by the GSTIN tools is an Export (read) request only', () => {
  assert.match(xmlQueryCollection, /<TALLYREQUEST>Export<\/TALLYREQUEST>/);
  assert.doesNotMatch(xmlQueryCollection, /Import Data/);
  const src = fs.readFileSync(path.join(here, '..', 'src', 'mcp.mts'), 'utf8');
  const block = src.slice(src.indexOf("'gstin-verify-bulk'"), src.indexOf("'gstin-api-usage'"));
  assert.ok(block.includes('queryCollection('));
  for (const w of ['importMastersTransactions', 'importXmlFile', 'deleteMasters', 'deleteVouchers', 'invokeTallyAction']) assert.ok(!block.includes(w), w);
  for (const f of ['gstin.mts', 'portal.mts', 'bulkjob.mts']) {
    const s = fs.readFileSync(path.join(here, '..', 'src', f), 'utf8');
    assert.ok(!/playwright|puppeteer|child_process/.test(s), f + ' has no browser automation');
  }
});

test('MCP: gstin-verify-bulk end to end (Tally not running -> comparison reported as not possible)', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-'));
  const got = await new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(here, '..', 'dist', 'index.mjs')], { env: { ...process.env, AETHERWISE_DATA_DIR: data, TALLY_PORT: '1', GSTINAPI_API_KEY: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = ''; const res = new Map();
    const t = setTimeout(() => { proc.kill(); reject(new Error('timeout ' + buf.slice(0, 300))); }, 30000);
    proc.stdout.on('data', d => { buf += d; for (const l of buf.split('\n')) { try { const j = JSON.parse(l); if (j.id) res.set(j.id, j); } catch { } } if (res.has(2) && res.has(3)) { clearTimeout(t); proc.kill(); resolve(res); } });
    for (const m of [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gstin-verify-bulk', arguments: { gstins: [ACTIVE, MISSING], folderPath: FX, clientName: 'E2E', clientProfile: 'pharmacy', outputPath: path.join(data, 'r.xlsx') } } }
    ]) proc.stdin.write(JSON.stringify(m) + '\n');
  });
  const names = got.get(2).result.tools.map(t => t.name);
  for (const n of ['trial-balance', 'import-xml-file', 'voucher-list', 'gstin-verify', 'gstin-search-taxpayer', 'gstin-portal-open', 'gstin-verify-bulk']) assert.ok(names.includes(n), n);
  assert.ok(!names.includes('gstin-verify-bulk-status'));
  const body = JSON.parse(got.get(3).result.content[0].text);
  assert.deepEqual(body.rows.map(r => [r.gstin, r.lookup]), [[ACTIVE, 'RESULT'], [MISSING, 'PAGE_MISSING']]);
  assert.ok(body.rows[0].missing.some(x => /Tally not reachable|comparison not possible/.test(x)));
  assert.ok(fs.existsSync(path.join(data, 'r.xlsx')));
});
