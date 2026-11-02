// Fixtures in test/fixtures are SYNTHETIC pages modelled on the GST portal "Search Taxpayer" result layout.
// They contain no real taxpayer data. No test contacts the GST portal or any other network service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as p from '../dist/portal.mjs';
import * as g from '../dist/gstin.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = f => path.join(here, 'fixtures', f);
const parseFile = (f, o = {}) => { const { text, retrievedAt } = p.readPortalFile(fx(f)); return p.parsePortalText(text, { sourceFile: f, retrievedAt, ...o }); };

test('active result (.html): all main fields, jurisdiction split, HSN and SAC', () => {
  const r = parseFile('portal_active.html');
  assert.equal(r.success, true); assert.equal(r.page_state, 'RESULT'); assert.equal(r.gstin, '27AAPFU0939F1ZV');
  const t = r.taxpayer;
  assert.equal(t.legal_name, 'SAMPLE & SONS HEALTHCARE LLP');
  assert.equal(t.trade_name, 'SAMPLE MEDICAL AGENCIES');
  assert.equal(t.status_category, 'ACTIVE');
  assert.equal(t.registration_date, '2017-07-01');
  assert.equal(t.constitution_of_business, 'Limited Liability Partnership');
  assert.equal(t.taxpayer_type, 'Regular');
  assert.match(t.jurisdiction.state, /Ward 1/);
  assert.match(t.jurisdiction.centre, /PUNE I/);
  assert.equal(t.nature_of_core_business_activity, 'Wholesaler');
  assert.deepEqual(t.nature_of_business, ['Wholesale Business', 'Retail Business', 'Warehouse / Depot']);
  assert.deepEqual(t.hsn_details.map(h => h.code), ['3004', '30049099', '9018']);
  assert.deepEqual(t.sac_details.map(h => [h.code, h.kind]), [['996511', 'sac']]);
  assert.equal(t.aadhaar_authenticated, 'Yes');
  assert.equal(r.field_availability.cancellation_date, 'not_applicable');
  assert.equal(r.field_availability.additional_places_of_business, 'not_provided_by_source');
  assert.equal(r.field_availability.return_filing_history, 'not_provided_by_source');
  assert.ok(r.retrieved_at, 'file date kept as retrieval date');
  assert.ok(!JSON.stringify(r).includes('analytics'), 'script content dropped');
});

test('.mhtml (Webpage, Single File, quoted-printable) gives the same result as .html', () => {
  const a = parseFile('portal_active.html').taxpayer, b = parseFile('portal_active.mhtml').taxpayer;
  assert.deepEqual(b, a);
});

test('copied text with tabs: cancelled with cancellation date, multi-line address, construction HSN', () => {
  const r = parseFile('portal_cancelled_copied.txt');
  assert.equal(r.success, true);
  assert.equal(r.taxpayer.status_category, 'CANCELLED');
  assert.equal(r.taxpayer.cancellation_date, '2026-05-31');
  assert.equal(r.field_availability.cancellation_date, 'retrieved');
  assert.equal(r.taxpayer.principal_place_of_business.address, 'Plot 9, Sample Nagar, Chennai, Tamil Nadu, 600001');
  assert.deepEqual(r.taxpayer.hsn_details.map(h => h.code), ['2523', '6907']);
  assert.equal(r.taxpayer.sac_details[0].code, '995411');
});

test('captcha form saved instead of result -> CAPTCHA_PENDING, not success', () => {
  const r = parseFile('portal_captcha.html');
  assert.equal(r.success, false); assert.equal(r.page_state, 'CAPTCHA_PENDING');
  assert.equal(r.field_availability.legal_name, 'lookup_failed');
});

test('portal "no records" page -> NOT_FOUND (not a network error, not invalid)', () => {
  const r = parseFile('portal_notfound.html', { expectedGstin: '27AAPFU0939F1ZW' });
  assert.equal(r.page_state, 'NOT_FOUND'); assert.equal(r.success, false); assert.equal(r.gstin, '27AAPFU0939F1ZW');
  assert.deepEqual(p.toProviderRecord(r), { gstin: '27AAPFU0939F1ZW', found: false });
});

test('changed page layout -> UNRECOGNISED with clear error, nothing invented', () => {
  const r = parseFile('portal_changed_layout.html');
  assert.equal(r.success, false); assert.equal(r.page_state, 'UNRECOGNISED');
  assert.equal(r.taxpayer.legal_name, null);
  assert.match(r.error, /layout may have changed/);
  assert.equal(p.toProviderRecord(r), null);
});

test('missing / empty field values -> not success, missing fields marked not_provided', () => {
  const r = parseFile('portal_partial.html');
  assert.equal(r.success, false);
  assert.equal(r.taxpayer.legal_name, 'ONLY NAME PVT LTD');
  assert.equal(r.taxpayer.registration_status, null);
  assert.equal(r.field_availability.registration_status, 'not_provided_by_source');
});

test('real portal layout (2026): nav e-Invoice ignored, side-by-side Goods/Services headers, old 0044 service codes = SAC', () => {
  const r = parseFile('portal_real_layout.txt');
  assert.equal(r.success, true); assert.equal(r.gstin, '06AAPFU0939F1ZZ');
  assert.equal(r.taxpayer.einvoice_status, null);
  assert.equal(r.taxpayer.jurisdiction.centre, 'State - CBIC, Range - R-1');
  assert.equal(r.taxpayer.jurisdiction.state, 'State - Haryana, Ward - Sample Ward 1');
  assert.deepEqual(r.taxpayer.nature_of_business, ['Service Provision', 'Works Contract']);
  assert.equal(r.taxpayer.hsn_details.length, 0);
  assert.deepEqual(r.taxpayer.sac_details.map(h => [h.code, h.kind]), [['00440245', 'sac'], ['00440406', 'sac']]);
  const rec = p.toProviderRecord(r);
  const c = g.classify({ gstin: rec.gstin, name: 'Sample Facility Services' }, g.validateGstinLocal(rec.gstin), rec, g.CLIENT_PROFILES.pharmacy);
  assert.equal(c.colour, 'YELLOW');
  assert.ok(c.reasons.some(x => /renting of immovable/.test(x)));
});

test('empty / garbage input', () => {
  assert.equal(p.parsePortalText('').page_state, 'EMPTY');
  assert.equal(p.parsePortalText('\u0000\u0001 binary %%%').page_state, 'UNRECOGNISED');
});

test('page for a different GSTIN than expected is rejected', () => {
  const r = parseFile('portal_active.html', { expectedGstin: '33AAACC1206D1ZN' });
  assert.equal(r.success, false); assert.match(r.error, /not the expected/);
});

test('file type and size guards', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-'));
  const exe = path.join(tmp, 'x.exe'); fs.writeFileSync(exe, 'MZ');
  assert.throws(() => p.readPortalFile(exe), /supported files/);
  const big = path.join(tmp, 'big.html'); fs.writeFileSync(big, Buffer.alloc(16 * 1024 * 1024, 32));
  assert.throws(() => p.readPortalFile(big), /15 MB/);
  assert.deepEqual(p.listPortalFiles(path.join(here, 'fixtures')).length, 8);
});

test('portal record feeds gstin-verify: pharmacy HSN = GREEN, construction HSN cancelled = RED', () => {
  const P = g.CLIENT_PROFILES.pharmacy;
  const a = p.toProviderRecord(parseFile('portal_active.html'));
  const ca = g.classify({ gstin: a.gstin, name: 'Sample Medical Agencies', gstr1Filed: 'Y' }, g.validateGstinLocal(a.gstin), a, P);
  assert.equal(ca.colour, 'GREEN', ca.reasons.join());
  assert.ok(ca.verifiedFacts.some(f => /declared HSN match/.test(f)));
  const b = p.toProviderRecord(parseFile('portal_cancelled_copied.txt'));
  const cb = g.classify({ gstin: b.gstin, name: 'Sample Buildcon', lastDate: '2026-07-01' }, g.validateGstinLocal(b.gstin), b, P);
  assert.equal(cb.colour, 'RED');
  assert.ok(cb.reasons.some(x => /cement/.test(x)));
  // facility / maintenance SAC alone -> YELLOW
  const c = { gstin: a.gstin, found: true, status: 'Active', taxpayerType: 'Regular', hsn: [{ code: '998534', description: null, kind: 'sac' }] };
  assert.equal(g.classify({ gstin: a.gstin, name: 'X Services' }, g.validateGstinLocal(a.gstin), c, P).colour, 'YELLOW');
});

// ---------- MCP server: registration, invocation, regression of existing tools, no key needed
function mcp(messages, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(here, '..', 'dist', 'index.mjs')], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; const got = new Map();
    const want = messages.filter(m => m.id !== undefined).length;
    const timer = setTimeout(() => { proc.kill(); reject(new Error('timeout; got ' + out.slice(0, 300))); }, 15000);
    proc.stdout.on('data', d => {
      out += d;
      for (const l of out.split('\n')) { try { const j = JSON.parse(l); if (j.id !== undefined) got.set(j.id, j); } catch { } }
      if (got.size >= want) { clearTimeout(timer); proc.kill(); resolve(got); }
    });
    for (const m of messages) proc.stdin.write(JSON.stringify(m) + '\n');
  });
}

test('MCP: tools registered (old + new) and gstin-search-taxpayer works without any API key', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'awd-'));
  const got = await mcp([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gstin-search-taxpayer', arguments: { folderPath: path.join(here, 'fixtures'), saveToCache: true } } }
  ], { GSTINAPI_API_KEY: '', AETHERWISE_DATA_DIR: data });
  const names = got.get(2).result.tools.map(t => t.name);
  for (const n of ['trial-balance', 'ledger-account', 'list-master', 'import-xml-file', 'voucher-list', 'voucher-delete-filtered', 'ledger-create-update', 'gstin-verify', 'gstin-api-usage', 'gstin-portal-open', 'gstin-search-taxpayer'])
    assert.ok(names.includes(n), 'missing tool ' + n);
  const body = JSON.parse(got.get(3).result.content[0].text);
  assert.deepEqual(body.summary, { pages: 8, parsed_ok: 4, not_found: 1, failed: 3, saved_to_cache: 3 });
  const cache = JSON.parse(fs.readFileSync(path.join(data, 'gstin-cache.json'), 'utf8'));
  assert.equal(cache['27AAPFU0939F1ZV'].source, p.PORTAL_SOURCE);
  assert.ok(!JSON.stringify(body).match(/at .*\.mjs:\d+/), 'no stack traces to client');
});
