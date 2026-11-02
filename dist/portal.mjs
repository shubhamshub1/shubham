// Aetherwise - GST portal "Search Taxpayer" result parser (user-assisted, offline)
//
// How it stays within the portal's permitted access:
// - The connector never sends a request to the GST portal. The user opens the official page
//   (https://services.gst.gov.in/services/searchtp) in their own browser, types the GSTIN and the
//   captcha themselves, and then saves the result page (Ctrl+S, "Webpage, Single File" .mhtml or
//   "Webpage, Complete" .html) or copies its text (Ctrl+A, Ctrl+C).
// - This module only parses that locally saved / copied content. No captcha solving, no scraping,
//   no network access, no GST login, no OTP.
import fs from 'node:fs';
import path from 'node:path';
import { validateGstinLocal } from './gstin.mjs';
export const PORTAL_URL = 'https://services.gst.gov.in/services/searchtp';
export const PORTAL_SOURCE = 'GST portal - Search Taxpayer (page saved / copied by user)';
// ---------------------------------------------------------------- content -> text
function decodeQuotedPrintable(s) {
    const soft = s.replace(/=\r?\n/g, '');
    const bytes = [];
    for (let i = 0; i < soft.length; i++) {
        const c = soft[i];
        if (c === '=' && /^[0-9A-F]{2}$/i.test(soft.substr(i + 1, 2))) {
            bytes.push(parseInt(soft.substr(i + 1, 2), 16));
            i += 2;
        }
        else {
            const b = Buffer.from(c, 'utf8');
            for (const x of b)
                bytes.push(x);
        }
    }
    return Buffer.from(bytes).toString('utf8');
}
/** extracts the text/html part of an .mhtml ("Webpage, Single File") */
export function mhtmlToHtml(raw) {
    const m = raw.match(/boundary="?([^"\r\n;]+)"?/i);
    const parts = m ? raw.split('--' + m[1]) : [raw];
    for (const p of parts) {
        if (!/content-type:\s*text\/html/i.test(p))
            continue;
        const idx = p.search(/\r?\n\r?\n/);
        const head = p.slice(0, idx);
        let body = p.slice(idx).replace(/^\s+/, '');
        if (/quoted-printable/i.test(head))
            body = decodeQuotedPrintable(body);
        else if (/base64/i.test(head))
            body = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
        return body;
    }
    return raw;
}
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
/** HTML -> text with one block element per line; scripts / styles / hidden inputs dropped */
export function htmlToText(html) {
    let s = html
        .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<(br|hr)\b[^>]*>/gi, '\n')
        .replace(/<\/?(p|div|tr|li|h[1-6]|table|tbody|thead|section|article|header|footer|ul|ol|dl|dt|dd|label|strong|form)\b[^>]*>/gi, '\n')
        .replace(/<\/?(td|th|span)\b[^>]*>/gi, '\t')
        .replace(/<[^>]+>/g, ' ');
    s = s.replace(/&(#x?[0-9a-f]+|[a-z]+|#39);/gi, (all, e) => {
        if (e[0] === '#') {
            const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return isNaN(n) ? all : String.fromCodePoint(n);
        }
        return ENT[e.toLowerCase()] ?? all;
    });
    return s;
}
function toLines(text) {
    return text.replace(/\r/g, '').split(/\n/)
        .map(l => l.replace(/\t+/g, '\t').replace(/[  ]+/g, ' ').trim())
        .flatMap(l => l.split('\t').map(x => x.trim()))
        .filter(l => l.length > 0);
}
const LABELS = [
    { key: 'gstin', re: /^gstin\s*\/\s*uin\s*:?$|^gstin\s*\/\s*uin\s*:/i },
    { key: 'legal_name', re: /^legal name of business/i },
    { key: 'trade_name', re: /^trade name/i },
    { key: 'registration_date', re: /^effective date of registration|^date of registration/i },
    { key: 'constitution_of_business', re: /^constitution of business/i },
    { key: 'registration_status', re: /^gstin\s*\/\s*uin status|^gstin status/i },
    { key: 'taxpayer_type', re: /^taxpayer type/i },
    { key: 'cancellation_date', re: /^(effective )?date of cancellation/i },
    { key: 'centre_jurisdiction', re: /^cent(re|er) jurisdiction/i },
    { key: 'state_jurisdiction', re: /^state jurisdiction/i },
    { key: 'admin_office', re: /^administrative office/i },
    { key: 'other_office', re: /^other office/i },
    { key: 'principal_place', re: /^principal place of business/i },
    { key: 'additional_place', re: /^additional place of business/i },
    { key: 'aadhaar_authenticated', re: /^whether aadhaa?r authenticated/i },
    { key: 'ekyc_verified', re: /^whether e-?kyc verified/i },
    { key: 'core_activity', re: /^nature of core business activity/i },
    { key: 'business_activities', re: /^nature of business activit(y|ies)/i },
    { key: 'einvoice_status', re: /^e-?invoice/i }
];
const ANY_LABEL = (l) => LABELS.some(x => x.re.test(l)) || /^(dealing in goods|goods and services$|goods$|services$|hsn$|sac$|description$|hsn\s+description|show filing table|filing table|search result|close)/i.test(l);
function labelValue(lines, i, re) {
    const l = lines[i];
    const rest = l.replace(re, '').replace(/^[\s:?\-–]+/, '').trim();
    if (rest && !ANY_LABEL(rest))
        return { value: rest, next: i + 1 };
    const nx = lines[i + 1];
    if (nx !== undefined && !ANY_LABEL(nx))
        return { value: nx.replace(/^[:\s]+/, ''), next: i + 2 };
    return { value: null, next: i + 1 };
}
/** gathers the lines following a label until the next known label (multi-line values) */
function blockAfter(lines, i, re) {
    const out = [];
    const first = lines[i].replace(re, '').replace(/^[\s:?\-–]+/, '').trim();
    if (first)
        out.push(first);
    for (let j = i + 1; j < lines.length && !ANY_LABEL(lines[j]); j++)
        out.push(lines[j]);
    return out;
}
export function toIsoDate(v) {
    if (!v)
        return null;
    const m = v.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
    if (m)
        return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    const n = v.match(/(\d{4})-(\d{2})-(\d{2})/);
    return n ? `${n[1]}-${n[2]}-${n[3]}` : null;
}
function statusCategory(s) {
    if (!s)
        return null;
    if (/^active/i.test(s))
        return 'ACTIVE';
    if (/cancel/i.test(s))
        return 'CANCELLED';
    if (/suspend/i.test(s))
        return 'SUSPENDED';
    if (/inactive/i.test(s))
        return 'INACTIVE';
    if (/provisional/i.test(s))
        return 'PROVISIONAL';
    return 'OTHER';
}
function parseHsnSection(lines) {
    const goods = [];
    const services = [];
    let start = lines.findIndex(l => /dealing in goods/i.test(l));
    if (start < 0)
        start = lines.findIndex(l => /^goods and services$/i.test(l));
    if (start < 0)
        return { goods, services };
    for (let j = start + 1; j < lines.length; j++) {
        const l = lines[j];
        if (LABELS.some(x => x.re.test(l)) || /^(show filing table|filing table|close|back|hsn:)$/i.test(l))
            break;
        if (/^(services?|goods)$/i.test(l))
            continue;
        const m = l.match(/^(\d{4,8})\s*[-:]?\s*(.*)$/);
        if (!m)
            continue;
        let desc = m[2].trim();
        if (!desc && lines[j + 1] && !/^\d{4,8}\b/.test(lines[j + 1]) && !ANY_LABEL(lines[j + 1])) {
            desc = lines[j + 1];
            j++;
        }
        const code = m[1];
        // services: SAC 99xxxx, or the old service-tax accounting codes 0044xxxx still shown for pre-2017 registrations
        const isSac = (code.startsWith('99') && code.length === 6) || /^0044\d{4}$/.test(code);
        const item = { code, description: desc || null, kind: isSac ? 'sac' : 'hsn' };
        (isSac ? services : goods).push(item);
    }
    return { goods, services };
}
export function parsePortalText(text, opts = {}) {
    let lines = toLines(text);
    const warnings = [];
    const t = {
        legal_name: null, trade_name: null, registration_status: null, status_category: null, registration_date: null,
        cancellation_date: null, constitution_of_business: null, taxpayer_type: null,
        principal_place_of_business: { address: null, state: null, state_code: null }, additional_places_of_business: [],
        jurisdiction: { centre: null, state: null }, nature_of_core_business_activity: null, nature_of_business: [],
        aadhaar_authenticated: null, ekyc_verified: null, einvoice_status: null, hsn_details: [], sac_details: []
    };
    const res = {
        success: false, gstin: null, source: PORTAL_SOURCE, source_file: opts.sourceFile ?? null, retrieved_at: opts.retrievedAt ?? null,
        parsed_at: new Date().toISOString(), verification_method: 'user-assisted: official GST portal search done by the user in their own browser; page parsed locally',
        page_state: 'UNRECOGNISED', taxpayer: t, field_availability: {}, warnings, error: null
    };
    if (!lines.length) {
        res.page_state = 'EMPTY';
        res.error = 'no text found in the page / input';
        return finish(res, opts.expectedGstin);
    }
    const joined = lines.join('\n');
    const hasResult = /legal name of business/i.test(joined) && /(gstin\s*\/\s*uin status|gstin status)/i.test(joined);
    if (!hasResult) {
        if (/no records? found|invalid gstin|gstin\s*\/\s*uin.*(is invalid|does not exist)|not a valid gstin/i.test(joined)) {
            res.page_state = 'NOT_FOUND';
            res.error = 'portal page says no record / invalid GSTIN';
        }
        else if (/captcha|type the characters|enter characters as displayed/i.test(joined)) {
            res.page_state = 'CAPTCHA_PENDING';
            res.error = 'the saved page is the search form (captcha not yet submitted) - complete the search in the browser, then save / copy the RESULT page';
        }
        else {
            res.error = 'page not recognised as a GST "Search Taxpayer" result (portal layout may have changed, or wrong page saved)';
        }
        const g = joined.match(/\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/);
        res.gstin = g ? g[0] : null;
        return finish(res, opts.expectedGstin);
    }
    res.page_state = 'RESULT';
    // only the result block: from "Search Result based on ..." (or the first label) to "Show Filing Table" / footer
    let rs = lines.findIndex(l => /^search result based on/i.test(l));
    if (rs < 0)
        rs = Math.max(0, lines.findIndex(l => /^legal name of business/i.test(l)) - 1);
    let re = lines.findIndex((l, k) => k > rs && /^(show filing table|show return filing frequency|about gst|website polic)/i.test(l));
    if (re < 0)
        re = lines.length;
    const all = lines;
    const lines2 = all.slice(rs, re);
    const gm = lines2[0]?.match(/\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/);
    if (gm)
        res.gstin = gm[0];
    lines = lines2;
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        const lab = LABELS.find(x => x.re.test(l));
        if (!lab)
            continue;
        if (lab.key === 'admin_office' || lab.key === 'other_office') {
            const blk = blockAfter(lines, i, lab.re);
            const txt = blk.join(', ');
            const isCentre = /jurisdiction\s*-\s*cent(er|re)/i.test(txt) || (!/jurisdiction\s*-\s*state/i.test(txt) && lab.key === 'other_office');
            const val = blk.filter(x => !/^\(?jurisdiction\s*-/i.test(x)).join(', ') || null;
            if (isCentre)
                t.jurisdiction.centre ??= val;
            else
                t.jurisdiction.state ??= val;
            continue;
        }
        if (lab.key === 'principal_place' || lab.key === 'additional_place' || lab.key === 'business_activities') {
            const blk = blockAfter(lines, i, lab.re);
            if (lab.key === 'principal_place')
                t.principal_place_of_business.address = blk.join(', ').replace(/,\s*,/g, ',') || null;
            else if (lab.key === 'additional_place')
                t.additional_places_of_business.push(...blk.filter(x => x.length > 3));
            else
                t.nature_of_business.push(...blk.flatMap(x => x.replace(/^\d+\.\s*/, '').split(/\s*[,;]\s*/)).map(x => x.trim()).filter(Boolean));
            continue;
        }
        const { value } = labelValue(lines, i, lab.re);
        if (value === null)
            continue;
        switch (lab.key) {
            case 'gstin': {
                const m = value.match(/\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/);
                if (m && !res.gstin)
                    res.gstin = m[0];
                break;
            }
            case 'legal_name':
                t.legal_name ??= value;
                break;
            case 'trade_name':
                t.trade_name ??= value;
                break;
            case 'registration_date':
                t.registration_date ??= toIsoDate(value);
                if (!toIsoDate(value))
                    warnings.push(`registration date not understood: "${value}"`);
                break;
            case 'constitution_of_business':
                t.constitution_of_business ??= value;
                break;
            case 'registration_status':
                t.registration_status ??= value;
                break;
            case 'taxpayer_type':
                t.taxpayer_type ??= value;
                break;
            case 'cancellation_date':
                t.cancellation_date ??= toIsoDate(value);
                break;
            case 'centre_jurisdiction':
                t.jurisdiction.centre ??= value;
                break;
            case 'state_jurisdiction':
                t.jurisdiction.state ??= value;
                break;
            case 'aadhaar_authenticated':
                t.aadhaar_authenticated ??= value;
                break;
            case 'ekyc_verified':
                t.ekyc_verified ??= value;
                break;
            case 'core_activity':
                t.nature_of_core_business_activity ??= value;
                break;
            case 'einvoice_status':
                t.einvoice_status ??= value;
                break;
        }
    }
    if (!res.gstin) {
        const g = joined.match(/\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/);
        res.gstin = g ? g[0] : null;
    }
    const hs = parseHsnSection(lines);
    t.hsn_details = hs.goods;
    t.sac_details = hs.services;
    t.status_category = statusCategory(t.registration_status);
    if (res.gstin) {
        const lc = validateGstinLocal(res.gstin);
        t.principal_place_of_business.state_code = lc.stateCode;
        t.principal_place_of_business.state = lc.state;
    }
    if (!t.legal_name || !t.registration_status) {
        res.error = 'result page found but key fields (legal name / status) could not be read - portal layout may have changed';
        warnings.push('parse incomplete');
    }
    return finish(res, opts.expectedGstin);
}
function finish(res, expected) {
    const t = res.taxpayer;
    if (expected) {
        const e = expected.trim().toUpperCase();
        if (res.gstin && res.gstin !== e) {
            res.error = `the page is for ${res.gstin}, not the expected ${e}`;
            res.page_state = res.page_state === 'RESULT' ? 'UNRECOGNISED' : res.page_state;
        }
        res.gstin = res.gstin || e;
    }
    res.success = res.page_state === 'RESULT' && !res.error;
    const ok = res.page_state === 'RESULT';
    const av = (v, naIf = false) => !ok ? 'lookup_failed' : naIf ? 'not_applicable' : (v === null || v === undefined || (Array.isArray(v) && !v.length)) ? 'not_provided_by_source' : 'retrieved';
    const cancelled = t.status_category === 'CANCELLED';
    res.field_availability = {
        legal_name: av(t.legal_name), trade_name: av(t.trade_name), registration_status: av(t.registration_status),
        registration_date: av(t.registration_date), constitution_of_business: av(t.constitution_of_business), taxpayer_type: av(t.taxpayer_type),
        cancellation_date: ok && !cancelled && !t.cancellation_date ? 'not_applicable' : av(t.cancellation_date),
        principal_place_of_business: av(t.principal_place_of_business.address), additional_places_of_business: av(t.additional_places_of_business),
        centre_jurisdiction: av(t.jurisdiction.centre), state_jurisdiction: av(t.jurisdiction.state),
        nature_of_core_business_activity: av(t.nature_of_core_business_activity), nature_of_business: av(t.nature_of_business),
        hsn_details: av(t.hsn_details), sac_details: av(t.sac_details),
        // the public search shows filing data only behind a further click / login; not parsed from this page
        return_filing_history: ok ? 'not_provided_by_source' : 'lookup_failed',
        contact_details_email_mobile: ok ? 'unavailable_access_restricted' : 'lookup_failed'
    };
    return res;
}
// ---------------------------------------------------------------- files
const MAX_BYTES = 15 * 1024 * 1024;
export function readPortalFile(filePath) {
    if (!/\.(html?|mhtml?|txt)$/i.test(filePath))
        throw new Error('supported files: .html / .htm (Webpage, Complete), .mhtml / .mht (Webpage, Single File) or .txt (copied text)');
    const st = fs.statSync(filePath);
    if (!st.isFile())
        throw new Error('not a file');
    if (st.size > MAX_BYTES)
        throw new Error('file larger than 15 MB - not a saved search result page');
    let raw = fs.readFileSync(filePath, 'utf8');
    if (/\.mht(ml)?$/i.test(filePath))
        raw = mhtmlToHtml(raw);
    const text = /\.txt$/i.test(filePath) ? raw : htmlToText(raw);
    return { text, retrievedAt: st.mtime.toISOString() };
}
export function listPortalFiles(folder) {
    return fs.readdirSync(folder).filter(f => /\.(html?|mhtml?|txt)$/i.test(f)).map(f => path.join(folder, f)).sort();
}
/** converts a parsed portal result into the record shape used by gstin-verify / its cache */
export function toProviderRecord(r) {
    if (!r.gstin)
        return null;
    if (r.page_state === 'NOT_FOUND')
        return { gstin: r.gstin, found: false };
    if (!r.success)
        return null;
    const t = r.taxpayer;
    return {
        gstin: r.gstin, found: true, legalName: t.legal_name, tradeName: t.trade_name, status: t.registration_status,
        taxpayerType: t.taxpayer_type, constitution: t.constitution_of_business, registrationDate: t.registration_date,
        cancellationDate: t.cancellation_date, address: t.principal_place_of_business.address,
        natureOfBusiness: t.nature_of_business.length ? t.nature_of_business : null, einvoiceStatus: t.einvoice_status,
        profileComplete: true, hsn: [...t.hsn_details, ...t.sac_details]
    };
}
//# sourceMappingURL=portal.mjs.map