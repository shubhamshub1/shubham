# gstin-verify (Aetherwise edition)

Verifies supplier GSTINs before purchases from GSTR-2A / 2B are booked.

## Data sources (authorised only)
1. **Local checks**: GSTIN format, check digit, state code, PAN holder type. Free, offline.
2. **Client's own GSTR-2A / 2B**: GSTR-1 filing status column, if present in the input file.
3. **gstinapi.in API** (optional): live registration data read through licensed GSP infrastructure:
   status, legal / trade name, taxpayer type, constitution, registration and cancellation date, address,
   nature of business (`include=profile`), and optionally GSTR-1 / 3B filing history (`returnsFy`).

The tool never scrapes the GST portal, never solves captchas and never rotates IPs or proxies.
GSTN's website policy prohibits scraping and allows access only through interfaces it authorises.

## Setup
- Claude Desktop > Extensions > Tally Prime (Aetherwise edition) > settings: paste the gstinapi.in key.
  It is stored as a secret and passed to the server as `GSTINAPI_API_KEY`. Never commit it.
- Without a key the tool runs offline checks only.
- Data folder: `%USERPROFILE%\.aetherwise` (override with `AETHERWISE_DATA_DIR`):
  - `gstin-cache.json` - verified records with source and timestamp (default reuse 30 days)
  - `gstin-audit.jsonl` - one line per API call (time, client, GSTIN, endpoint, HTTP status, outcome, credits left). No key is logged.

## Input
`.xlsx` or `.csv` with a header containing **GSTIN** (header row auto-detected in the first 30 rows). Optional columns:
name / trade name, bills, taxable, gst, first date, last date, GSTR-1 filing status, fixed monthly (Y/N), remarks.
Duplicate GSTINs are merged before any API call.

## Rules
| Result | When |
|---|---|
| RED | invalid format / check digit; cancelled (bills after cancellation) or suspended; composition taxpayer charging GST; GSTR-1 not filed (2A/2B); not found on GST network |
| YELLOW | services / works-contract-only registration; name suggests non-trade or 17(5) item; same amount every month; first bill before registration; status other than Active; data not available |
| GREEN | live record Active and no flag; offline GREEN only if name matches the client's trade AND GSTR-1 filed |

Missing data is shown in its own column and is never treated as proof that a supplier is fake.

## Credits
- `dryRun=true` shows credits needed. `maxApiLookups` (default 25) caps a run. Cached GSTINs cost nothing.
- Provider rate limit is 60/min; the tool sends at most one call per 1.1 s and retries 429 / 502 / network errors with backoff (Retry-After honoured). 401 / 402 / 403 stop the run.

## No-key route: official GST portal, user-assisted (v7.14)
1. Ask Claude: "GST portal kholo" → tool `gstin-portal-open` opens https://services.gst.gov.in/services/searchtp in your default browser.
2. You type the GSTIN and the captcha yourself and click SEARCH (the connector never solves or sees the captcha).
3. On the result page press **Ctrl+S → "Webpage, Single File (*.mhtml)"** and save into one folder, e.g. `Downloads\GSTIN_Jetaa\06AANCS6595E1ZV.mhtml`.
   Alternatively Ctrl+A, Ctrl+C and paste into a .txt file, or paste the text to Claude.
4. Ask Claude to run `gstin-search-taxpayer` with `folderPath` (and `saveToCache: true` to reuse the records in `gstin-verify`).

Example invocation:
```json
{ "folderPath": "C:\\Users\\<you>\\Downloads\\GSTIN_Jetaa", "saveToCache": true }
```

Returned per page: `success`, `gstin`, `source`, `source_file`, `retrieved_at` (file save time), `parsed_at`, `verification_method`,
`page_state` (RESULT / NOT_FOUND / CAPTCHA_PENDING / UNRECOGNISED / EMPTY), `taxpayer` {legal_name, trade_name, registration_status,
status_category, registration_date, cancellation_date, constitution_of_business, taxpayer_type, principal_place_of_business,
additional_places_of_business, jurisdiction {centre, state}, nature_of_core_business_activity, nature_of_business, aadhaar_authenticated,
ekyc_verified, einvoice_status, hsn_details, sac_details}, `field_availability`, `warnings`, `error`.

Not available from this route: return filing history (shown only behind a further click; use the client's GSTR-2A/2B filing status column),
supplier e-mail / mobile (not public). Parsing is label based; if GSTN changes the page layout the tool reports UNRECOGNISED instead of guessing.

Privacy: no network request is made by these tools; nothing is stored unless `saveToCache` is true (local cache file only).
Review of sunilhm68/GST_Status_Checker: it automates the portal with Playwright and solves the captcha with a CNN, which GSTN's website
policy prohibits (scraping / access only through authorised interfaces), so its access mechanism is not used. It also overwrites the
input Excel keeping only Sheet1, saves full-page screenshots of results, pins no dependency versions and sends nothing except to the portal.
