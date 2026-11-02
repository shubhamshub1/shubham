// Aetherwise - interactive bulk lookup on the official GST portal "Search Taxpayer" page.
//
// What is automated and what is not:
// - The connector opens ONE visible browser window (Edge / Chrome already on the PC), fills the GSTIN,
//   presses Enter so the portal shows its captcha, and puts the cursor in the captcha box.
// - The USER reads and types every captcha and clicks SEARCH. The connector never reads, sends or solves
//   the captcha image, never runs headless and never runs lookups in parallel.
// - When the result appears the connector reads the visible page text, parses it locally and moves to
//   the next GSTIN after a pause. Nothing is sent anywhere except the user's own browser traffic to the portal.

import { parsePortalText, PORTAL_URL, type TaxpayerResult } from './portal.mjs';

export interface PageLike {
  goto(url: string, o?: any): Promise<any>;
  waitForSelector(sel: string, o?: any): Promise<any>;
  fill(sel: string, v: string): Promise<void>;
  press(sel: string, key: string): Promise<void>;
  focus(sel: string): Promise<void>;
  evaluate(fn: any, arg?: any): Promise<any>;
  waitForFunction(fn: any, arg?: any, o?: any): Promise<any>;
  isClosed(): boolean;
}
export interface BrowserLike { newPage(): Promise<PageLike>; close(): Promise<void>; }

export interface SessionOptions {
  portalUrl?: string;
  perGstinTimeoutMs?: number;     // time the user has to type the captcha (incl. retries after a wrong captcha)
  minGapMs?: number;              // pause between two searches
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (p: ProgressEvent) => void;
  isCancelled?: () => boolean;
}
export interface ProgressEvent { index: number; total: number; gstin: string; state: 'opening' | 'waiting_for_user' | 'parsed' | 'failed' | 'skipped'; message?: string; }

export interface LookupOutcome {
  gstin: string;
  status: 'RESULT' | 'NOT_FOUND' | 'TIMEOUT' | 'PORTAL_ERROR' | 'PARSE_FAILED' | 'BROWSER_CLOSED' | 'CANCELLED';
  result: TaxpayerResult | null;
  error: string | null;
  at: string;
}

export const SEL = { gstin: '#for_gstin', captcha: '#fo-captcha' };

function banner(page: PageLike, text: string) {
  return page.evaluate((t: string) => {
    let d = document.getElementById('aetherwise-banner');
    if (!d) {
      d = document.createElement('div'); d.id = 'aetherwise-banner';
      d.setAttribute('style', 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#0b5;color:#fff;font:600 15px Arial;padding:8px 12px;text-align:center');
      document.body.appendChild(d);
    }
    d.textContent = t;
  }, text).catch(() => { });
}

/** waits until the page shows the result for this GSTIN or a no-record message (user types the captcha meanwhile) */
async function waitForOutcome(page: PageLike, gstin: string, timeoutMs: number) {
  return page.waitForFunction((g: string) => {
    const t = document.body ? document.body.innerText : '';
    if (/legal name of business/i.test(t) && t.includes(g)) return 'RESULT';
    if (/no records? found|does not exist|not a valid gstin/i.test(t)) return 'NOT_FOUND';
    return false;
  }, gstin, { timeout: timeoutMs, polling: 1000 });
}

export async function runPortalSession(browser: BrowserLike, gstins: string[], o: SessionOptions = {}): Promise<LookupOutcome[]> {
  const url = o.portalUrl || PORTAL_URL;
  const sleep = o.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const out: LookupOutcome[] = [];
  const now = () => new Date().toISOString();
  let page: PageLike | null = null;
  for (let i = 0; i < gstins.length; i++) {
    const g = gstins[i];
    const ev = (state: ProgressEvent['state'], message?: string) => o.onProgress?.({ index: i + 1, total: gstins.length, gstin: g, state, message });
    if (o.isCancelled?.()) { out.push({ gstin: g, status: 'CANCELLED', result: null, error: 'cancelled by user', at: now() }); ev('skipped', 'cancelled'); continue; }
    if (page && page.isClosed()) { out.push({ gstin: g, status: 'BROWSER_CLOSED', result: null, error: 'browser window was closed', at: now() }); ev('skipped', 'browser closed'); continue; }
    try {
      if (!page) page = await browser.newPage();
      if (i > 0) await sleep(o.minGapMs ?? 3000);
      ev('opening');
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector(SEL.gstin, { state: 'visible', timeout: 30000 });
      await page.fill(SEL.gstin, g);
      await page.press(SEL.gstin, 'Enter');
      // wait until the captcha box is shown OR a result is already there (a session may not ask again)
      try {
        const st = await (await page.waitForFunction((a: { sel: string; g: string }) => {
          const c = document.querySelector(a.sel) as HTMLElement | null;
          if (c && c.offsetParent !== null) return 'captcha';
          const t = document.body ? document.body.innerText : '';
          return (/legal name of business/i.test(t) && t.includes(a.g)) || /no records? found/i.test(t) ? 'result' : false;
        }, { sel: SEL.captcha, g }, { timeout: 15000, polling: 300 })).jsonValue();
        if (st === 'captcha') await page.focus(SEL.captcha);
      } catch { /* neither appeared yet - keep waiting below */ }
      await banner(page, `Aetherwise: supplier ${i + 1} of ${gstins.length} (${g}) - please type the captcha and click SEARCH`);
      ev('waiting_for_user');
      let kind: string;
      try { kind = await (await waitForOutcome(page, g, o.perGstinTimeoutMs ?? 180000)).jsonValue(); }
      catch (e) {
        if (page.isClosed()) { out.push({ gstin: g, status: 'BROWSER_CLOSED', result: null, error: 'browser window was closed', at: now() }); ev('failed', 'browser closed'); continue; }
        out.push({ gstin: g, status: 'TIMEOUT', result: null, error: 'no result within the time limit (captcha not entered / portal slow)', at: now() }); ev('failed', 'timeout'); continue;
      }
      await banner(page, `Aetherwise: reading result for ${g}...`);
      const text: string = await page.evaluate(() => { const b = document.getElementById('aetherwise-banner'); if (b) b.remove(); return document.body.innerText; });
      const at = now();
      const r = parsePortalText(text, { expectedGstin: g, sourceFile: null, retrievedAt: at });
      r.source = 'GST portal - Search Taxpayer (interactive session, captcha entered by user)';
      r.verification_method = 'connector filled the GSTIN in a visible browser on the official portal; the user typed the captcha; result text parsed locally';
      const status = r.page_state === 'NOT_FOUND' || kind === 'NOT_FOUND' ? 'NOT_FOUND' : r.success ? 'RESULT' : 'PARSE_FAILED';
      out.push({ gstin: g, status, result: r, error: r.error, at });
      ev(status === 'PARSE_FAILED' ? 'failed' : 'parsed', r.error || undefined);
    } catch (e) {
      const msg = String((e as any)?.message || e).split('\n')[0].slice(0, 200);
      if (page?.isClosed()) { out.push({ gstin: g, status: 'BROWSER_CLOSED', result: null, error: 'browser window was closed', at: now() }); ev('failed', 'browser closed'); continue; }
      out.push({ gstin: g, status: 'PORTAL_ERROR', result: null, error: 'portal did not load / changed: ' + msg, at: now() }); ev('failed', msg);
    }
  }
  return out;
}

/** opens a visible browser: AETHERWISE_BROWSER_PATH, else Microsoft Edge, else Google Chrome (no browser download) */
export async function launchVisibleBrowser(): Promise<BrowserLike & { _b: any }> {
  const { chromium } = await import('playwright-core');
  const exe = process.env.AETHERWISE_BROWSER_PATH;
  const headless = process.env.AETHERWISE_BROWSER_HEADLESS_TEST === '1';   // automated tests only; a human cannot type a captcha in a hidden window
  const tries: any[] = exe ? [{ executablePath: exe }] : [{ channel: 'msedge' }, { channel: 'chrome' }];
  let lastErr: any;
  for (const t of tries) {
    try {
      const b = await chromium.launch({ ...t, headless, args: ['--start-maximized', '--no-first-run', '--no-default-browser-check'] });
      const ctx = await b.newContext({ viewport: null });
      return { _b: b, newPage: () => ctx.newPage() as any, close: () => b.close() };
    } catch (e) { lastErr = e; }
  }
  throw new Error('no Edge / Chrome found to open the portal (set AETHERWISE_BROWSER_PATH): ' + String(lastErr?.message || lastErr).split('\n')[0]);
}
