// Bulk interactive portal workflow, tested against a LOCAL mock of the portal page (no real GST portal access).
// The "user" typing the captcha is simulated by the test; the connector code itself never types or reads captchas.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { chromium } from 'playwright-core';
import { startMockPortal, CAPTCHA } from './mockportal.mjs';
import * as pb from '../dist/portalbrowser.mjs';
import * as bj from '../dist/bulkjob.mjs';
import * as g from '../dist/gstin.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const mk = p => p + g.gstinCheckDigit(p);
const A = mk('06AAAAA1111A1Z'), B = mk('06BBBBB2222B1Z'), C = mk('06CCCCC3333C1Z'), D = mk('06DDDDD4444D1Z'), E = mk('06EEEEE5555E1Z'), F = mk('06FFFFF6666F1Z');
const DATA = {
  [A]: { legal: 'ALPHA PHARMA DISTRIBUTORS PRIVATE LIMITED', trade: 'ALPHA PHARMA', reg: '01/07/2017', cons: 'Private Limited Company', status: 'Active', addr: 'Shop 1, Test Market, Gurugram, Haryana, 122001', core: 'Wholesaler', nob: ['Wholesale Business'], hsn: [['3004', 'MEDICAMENTS'], ['9018', 'MEDICAL INSTRUMENTS']] },
  [B]: { legal: 'BETA FACILITY SERVICES LLP', trade: 'BETA FACILITY', reg: '10/01/2019', cons: 'Limited Liability Partnership', status: 'Active', addr: 'Tower B, Gurugram', core: 'Service Provider and Others', nob: ['Supplier of Services', 'Works Contract'], hsn: [['00440245', 'MAINTENANCE OR REPAIR SERVICE']] },
  [C]: { legal: 'GAMMA TRADERS', trade: 'GAMMA TRADERS', reg: '05/05/2018', cons: 'Proprietorship', status: 'Cancelled suo-moto', cancel: '31/05/2026', addr: 'X', core: 'Retail', nob: ['Retail Business'], hsn: [['6907', 'CERAMIC TILES']] },
  [E]: 'hang', [F]: 'garbage'
};
let portal, browser;
before(async () => { portal = await startMockPortal(DATA); browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--disable-background-networking', '--disable-component-update', '--no-first-run'] }); });
after(async () => { await browser?.close(); await portal?.close(); });

/** BrowserLike over a test browser + a simulated user who types the captcha when the captcha box is visible */
function withSimulatedUser(captcha = CAPTCHA, wrongFirst = false) {
  let typed = 0;
  return {
    async newPage() {
      const ctx = await browser.newContext(); const page = await ctx.newPage();
      const loop = async () => {
        while (!page.isClosed()) {
          try {
            if (await page.isVisible('#fo-captcha') && (await page.inputValue('#fo-captcha')) === '' && !(await page.evaluate(() => document.getElementById('out').innerHTML))) {
              await page.fill('#fo-captcha', wrongFirst && typed === 0 ? '000000' : captcha); typed++; await page.click('#lotsearch');
              if (wrongFirst && typed === 1) { await page.waitForTimeout(300); await page.fill('#fo-captcha', ''); }
            }
          } catch { }
          await new Promise(r => setTimeout(r, 150));
        }
      };
      loop();
      return page;
    },
    async close() { }
  };
}
const quick = { minGapMs: 10, perGstinTimeoutMs: 4000 };

test('session: active, services, cancelled, not found, timeout, changed page - each with the right status', async () => {
  const events = [];
  const out = await pb.runPortalSession(withSimulatedUser(), [A, B, C, D, E, F], { ...quick, portalUrl: portal.url, onProgress: e => events.push(e) });
  assert.deepEqual(out.map(o => o.status), ['RESULT', 'RESULT', 'RESULT', 'NOT_FOUND', 'TIMEOUT', 'PARSE_FAILED']);
  const a = out[0].result;
  assert.equal(a.taxpayer.legal_name, 'ALPHA PHARMA DISTRIBUTORS PRIVATE LIMITED');
  assert.equal(a.taxpayer.einvoice_status, null, 'site menu text not taken as a field');
  assert.deepEqual(a.taxpayer.hsn_details.map(h => h.code), ['3004', '9018']);
  assert.equal(a.taxpayer.jurisdiction.state, 'State - Haryana, Ward - Test Ward');
  assert.match(a.source, /interactive session/);
  assert.equal(out[2].result.taxpayer.cancellation_date, '2026-05-31');
  assert.ok(events.some(e => e.state === 'waiting_for_user'));
  assert.equal(portal.state.searches, 6, 'one search per GSTIN, no extra requests');
});

test('session: wrong captcha first, user retries, result still read', async () => {
  const out = await pb.runPortalSession(withSimulatedUser(CAPTCHA, true), [A], { ...quick, portalUrl: portal.url });
  assert.equal(out[0].status, 'RESULT');
});

test('session: portal down -> PORTAL_ERROR (not invalid, not RED), next GSTIN continues', async () => {
  portal.state.down = true;
  const out = await pb.runPortalSession(withSimulatedUser(), [A], { minGapMs: 10, perGstinTimeoutMs: 3000, portalUrl: portal.url });
  portal.state.down = false;
  assert.equal(out[0].status, 'PORTAL_ERROR');
  const c = g.classify({ gstin: A }, g.validateGstinLocal(A), null, g.CLIENT_PROFILES.pharmacy, 'PORTAL_ERROR: down');
  assert.equal(c.colour, 'YELLOW');
});

test('session: cancel stops further lookups', async () => {
  let n = 0;
  const out = await pb.runPortalSession(withSimulatedUser(), [A, B, C], { ...quick, portalUrl: portal.url, isCancelled: () => n++ > 0 });
  assert.deepEqual(out.map(o => o.status), ['RESULT', 'CANCELLED', 'CANCELLED']);
});

test('session: minimum gap between searches is applied', async () => {
  const waits = [];
  await pb.runPortalSession(withSimulatedUser(), [A, B], { perGstinTimeoutMs: 4000, minGapMs: 3000, portalUrl: portal.url, sleep: async ms => { waits.push(ms); } });
  assert.deepEqual(waits, [3000]);
});

test('bulk job: invalid GSTIN not sent, books comparison, technical failure YELLOW, report with one row per supplier', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-')); process.env.AETHERWISE_DATA_DIR = data;
  const out = path.join(data, 'r.xlsx');
  const books = new Map([[A, { name: 'Alpha Pharma Distributors' }], [B, { name: 'Shree Ram Medical Store' }], [C, { name: 'Gamma Traders', lastDate: '2026-07-01' }]]);
  const job = bj.startBulk({ gstins: [A, B, C, D, E, '06ABCDE1234F1Z9', A], clientName: 'Test', profile: g.CLIENT_PROFILES.pharmacy, books, booksSource: 'test books',
    outputPath: out, saveToCache: false, perGstinTimeoutMs: 4000, minGapMs: 10, launch: async () => withSimulatedUser(), portalUrl: portal.url });
  assert.equal(job.total, 5); assert.equal(job.invalid.length, 1); assert.equal(job.duplicatesRemoved, 1);
  while (bj.getJob().state === 'running') await new Promise(r => setTimeout(r, 200));
  const j = bj.getJob();
  assert.equal(j.state, 'done', j.error);
  const row = x => j.rows.find(r => r.gstin === x);
  assert.equal(row(A).colour, 'GREEN', row(A).reasons.join());
  assert.equal(row(B).colour, 'YELLOW'); assert.ok(row(B).reasons.some(r => /does not match registered name/.test(r)));
  assert.equal(row(C).colour, 'RED');
  assert.equal(row(D).colour, 'RED'); assert.equal(row(D).lookup, 'NOT_FOUND');
  assert.equal(row(E).colour, 'YELLOW'); assert.equal(row(E).lookup, 'TIMEOUT'); assert.equal(row(E).verified_at, null);
  assert.equal(row('06ABCDE1234F1Z9').lookup, 'NOT_SENT (invalid GSTIN)');
  assert.equal(j.summary.lookupFailures, 1);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(out);
  assert.equal(wb.getWorksheet('Suppliers').rowCount, 7);
  const hdr = wb.getWorksheet('Suppliers').getRow(1).values.join('|');
  for (const h of ['Legal name', 'Trade name', 'Status', 'Reg. date', 'Address', 'Jurisdiction', 'HSN / SAC', 'Verified at', 'Source', 'Reasons']) assert.ok(hdr.includes(h), h);
  assert.ok(!fs.existsSync(path.join(data, 'gstin-cache.json')), 'nothing cached unless asked');
  const slow = { newPage: () => new Promise((_, rej) => setTimeout(() => rej(new Error('test')), 300)), close: async () => { } };
  const base = { gstins: [A], clientName: 'x', profile: g.CLIENT_PROFILES.generic, books: new Map(), booksSource: '', outputPath: path.join(data, 'r2.xlsx'), saveToCache: false, perGstinTimeoutMs: 1000, minGapMs: 0, portalUrl: portal.url };
  bj.startBulk({ ...base, launch: async () => slow });
  assert.throws(() => bj.startBulk({ ...base, launch: async () => slow }), /already running/);
  while (bj.getJob().state === 'running') await new Promise(r => setTimeout(r, 100));
  assert.equal(bj.getJob().rows[0].lookup, 'PORTAL_ERROR');
});

// ---------- MCP end to end through the real server process + real browser launch (mock portal that needs no captcha)
function mcp(messages, env, waitIds) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(here, '..', 'dist', 'index.mjs')], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = ''; const got = new Map(); let sent = 0;
    const timer = setTimeout(() => { proc.kill(); reject(new Error('timeout ' + buf.slice(0, 500))); }, 60000);
    const pump = () => { while (sent < messages.length) { const m = messages[sent]; if (typeof m === 'function') { const r = m(got); if (!r) return; proc.stdin.write(JSON.stringify(r) + '\n'); } else proc.stdin.write(JSON.stringify(m) + '\n'); sent++; } };
    proc.stdout.on('data', d => {
      buf += d; for (const l of buf.split('\n')) { try { const j = JSON.parse(l); if (j.id !== undefined) got.set(j.id, j); } catch { } }
      pump();
      if (waitIds.every(i => got.has(i))) { clearTimeout(timer); proc.kill(); resolve(got); }
    });
    pump();
  });
}

test('MCP: gstin-verify-bulk + gstin-verify-bulk-status end to end, existing tools still registered', async () => {
  const p2 = await startMockPortal(DATA, { noCaptcha: true });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-'));
  try {
    const got = await mcp([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gstin-verify-bulk', arguments: { gstins: [A, B, D], clientName: 'E2E', clientProfile: 'pharmacy', compareWithTally: false } } },
      got => got.has(3) ? { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'gstin-verify-bulk-status', arguments: { waitSeconds: 40 } } } : null
    ], { AETHERWISE_DATA_DIR: data, AETHERWISE_BROWSER_PATH: CHROME, AETHERWISE_BROWSER_HEADLESS_TEST: '1', AETHERWISE_PORTAL_URL_TEST: p2.url, GSTINAPI_API_KEY: '' }, [2, 3, 4]);
    const names = got.get(2).result.tools.map(t => t.name);
    for (const n of ['trial-balance', 'import-xml-file', 'voucher-list', 'gstin-verify', 'gstin-search-taxpayer', 'gstin-verify-bulk', 'gstin-verify-bulk-status']) assert.ok(names.includes(n), n);
    const st = JSON.parse(got.get(4).result.content[0].text);
    assert.equal(st.state, 'done', JSON.stringify(st).slice(0, 1500));
    assert.deepEqual(st.rows.map(r => [r.gstin, r.lookup]), [[A, 'RESULT'], [B, 'RESULT'], [D, 'NOT_FOUND']]);
    assert.ok(fs.existsSync(st.report));
    assert.ok(!JSON.stringify(st).match(/cookie|wsEndpoint|ws:\/\//i), 'no browser session details exposed');
  } finally { await p2.close(); }
});
