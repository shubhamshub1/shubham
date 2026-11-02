# Change log

## v7.18.0 (Aetherwise edition), 02-Nov-2026
* gstin-worklist-add now also ingests a TABULAR status export in one call: give it an .xlsx/.csv that has a GSTIN column and a registration-status column (the TallyPrime "Validate Party GSTIN/UIN" report exported with Alt+E, or any status report). Every row is matched to the worklist by GSTIN and marked done / not_found - no portal page or paste needed per supplier. readSupplierFile now also reads legal/trade name, status, registration/cancellation date, taxpayer type, constitution and address columns when present
* This is the officially-supported route: TallyPrime fetches the status from GSTN's authorised e-Way Bill / e-Invoice interface; the connector only reads the file you export (read-only, no portal access)

## v7.17.0 (Aetherwise edition), 02-Nov-2026
* New resumable worklist so no HTML/MHTML file need be saved per supplier: gstin-worklist-start (reads supplier GSTIN + name from Tally party ledgers read-only and/or a 2A file, de-dupes, marks invalid, keeps progress on disk), gstin-worklist-add (paste the portal result text - or drop a saved file - parsed offline and matched to the queue by the GSTIN on the page; a parse failure never overwrites a good result or marks a supplier non-compliant), gstin-worklist-report (one consolidated report from whatever is resolved so far; pending suppliers shown technical/not-done, never RED; lists pending GSTINs). The connector still never contacts the GST portal and runs no browser; the user searches and solves each captcha themselves

## v7.16.1 (Aetherwise edition), 02-Nov-2026
* Fix: in GSTR-2A reconciliation exports the "3B Status" column is the supplier's GSTR-3B status and "R1 Date" is the GSTR-1 filing date. They are now read as such (new category GSTR3B_PENDING = YELLOW review); they were previously treated as GSTR-1 status
* A row with a technical failure (no data from the source) can no longer be GREEN
* Batch from the client's own GSTR-2A: one file gives supplier name, GSTR-1 filing evidence and GSTR-3B status for all suppliers (gstin-verify-bulk / gstin-verify supplierFile)

## v7.16.0 (Aetherwise edition), 02-Nov-2026 - compliance release
* REMOVED the v7.15.0 browser automation of the GST portal (visible-browser bulk search, page overlay, gstin-verify-bulk-status) and the playwright-core dependency. GSTN's website policy allows access only through interfaces expressly authorised by GSTN and prohibits scraping and contravening access controls; a connector driving the public search page is not such an interface, even with the captcha typed by the user. v7.15.0 must not be installed
* Classification review: composition taxpayer is information (YELLOW only when tax appears on its bills), never RED; new Finding category column (INVALID_GSTIN / NOT_FOUND_AT_SOURCE / CANCELLED / SUSPENDED / GSTR1_NOT_FILED / TECHNICAL / REVIEW / OK); technical items never described as a supplier problem; GSTR-1 non-filing only from explicit Y/N / Filed / Not Filed values in the client's own 2A/2B (optional period column), never inferred from the taxpayer profile; fields not shown on the portal page / not public listed in "Missing / inconclusive"
* gstin-verify-bulk now builds one consolidated report from result pages the user searched and saved (any file names, matched by the GSTIN on the page, or by file name for "no records" pages), lists missing pages, compares with Tally ledger names (Export request only) and keeps technical items (PAGE_MISSING / PARSE_FAILED) separate from verified findings (new Lookup column; technical = YELLOW, never RED)

## v7.15.0 (Aetherwise edition), 02-Nov-2026
* New tools gstin-verify-bulk and gstin-verify-bulk-status: one request checks up to 50 GSTINs on the official GST portal. The connector opens one visible Edge / Chrome window, fills each GSTIN, waits while the user types the captcha, reads and parses the result, pauses 3 s and moves on. Runs in the background; one consolidated Excel report
* Books comparison: party ledger names by GSTIN from Tally (read-only) and / or a supplier file; name mismatch = YELLOW
* Technical failures (timeout, portal down, page changed, window closed) are YELLOW with the reason, never RED
* Report: new Jurisdiction column
* Dependency: playwright-core (drives the browser already installed on the PC; no browser download)
* Tests: mock portal + simulated user for bulk flow, wrong captcha, timeout, portal down, cancel, page change, MCP end to end (41 tests)

## v7.14.1 (Aetherwise edition), 02-Nov-2026
* gstin-search-taxpayer tested on a real portal result page: reads only the result block (site menu "e-Invoice" no longer mistaken for a field), Goods / Services classified by code (SAC 99xxxx and old service-tax codes 0044xxxx = services)
* gstin-verify: service descriptions (maintenance / repair, renting of immovable property, works contract, manpower, security...) flagged for 17(5) review

## v7.14.0 (Aetherwise edition), 02-Nov-2026
* New tools gstin-portal-open and gstin-search-taxpayer: user-assisted lookup on the official GST portal (user enters GSTIN + captcha in own browser, saves / copies the result page); the connector parses it offline into structured fields incl. jurisdiction, nature of business and declared HSN / SAC, with field_availability per field. No API key, no request to any service
* gstin-verify: uses declared HSN / SAC (pharmacy HSN = trade, construction / facility / repair SAC = review) and shows them in the report
* gstin-api-usage: message clarifies the gstinapi.in key is optional

## v7.13.0 (Aetherwise edition), 01-Nov-2026
* New tool gstin-verify: GSTIN format + check digit, GSTR-1 filing status from the client's own 2A/2B, live registration data through the authorised gstinapi.in API (optional key), local cache, credit budget, throttle + retry, JSONL audit log and a GREEN / YELLOW / RED Excel report
* New tool gstin-api-usage
* New optional setting: gstinapi.in API key (stored as a secret by Claude Desktop)
* Tests: `npm test`

## v7.12.2 (Aetherwise edition), 01-Nov-2026
* New tool voucher-delete-filtered (date range + voucher type, dry run by default)

## v7.12.1 (Aetherwise edition), 01-Nov-2026
* New tools: import-xml-file, inspect-xml-file, voucher-list and voucher-delete
* ledger-create-update: fixed the GSTIN validation; GST registration details can be set without mailing details; new gstDutyHead option; ledger names with & now work


### Version: v7.12 [25-Oct-2026]

Fixed:
* Special characters `&`, `<` and `>` in ledger and stock item names were not escaped for the *ledger-account* and *stock-item-account* tools, which broke the Tally XML request. These characters are now escaped, including filters and opening balances.
* *query-collection* was not handling the same special characters in field expressions (for example `Reserves & Surplus`), which broke the collection request. Expressions are now escaped so the request is valid XML.

### Version: v7.11 [24-Oct-2026]

Fixed:
* Fixed double quote escaping in ledger and stock item names for the *ledger-account* and *stock-item-account* tools, including filters and opening balances.

### Version: v7.10 [23-Oct-2026]
Fixed:
* Some tools were returing blank output due to TDL expression breaking, now resolved

### Version: v7.9 [18-Oct-2026]

Fixed:
* Special character like double quotes was not being handled correctly in filter expression leading of crashing of tally.exe process. Proper escaping now put into the place

### Version: v7.8 [11-Oct-2026]

Added:
* Documentation for the support of ChatGPT Desktop connectivity with Tally MCP Server locally

Fixed:
* Costing Method property was included twice in collection due to which Tally process was crashing

### Version: v7.7 [01-Oct-2026]

Added:
* Tool *voucher-journal* introduced to create Journal vouchers directly in Tally Prime

### Version: v7.6 [04-Sep-2026]
Fixed:
* Tool *ledger-account* with instance where the target ledger being queried is used multiple times in a single voucher was not being aggregated leading to incorret data being returned as reporting in is now fixed

### Version: v7.5 [10-Aug-2026]

Added:
* Add many fields into collection definition to make query-collection even more robust
* Introduced feature of blocking access to Write functionality tool by introduction of environment variable BLOCK_WRITE
* MCP was unable to connect to tally running of PC other than local, as localhost was hard-coded in Tally Host setting. environment variable TALLY_HOST was introduced to allow setting of IP address to connect Tally running on different computer

Fixed:
* House-keeping task like upgrading of depedencies (node packages)
* Improvement in the documentation

### Version: v7.4 [03-Jul-2026]

Added:
* Tool delete-master introduce to delete master type collection

Fixed:
* Date was being shifted by 1 day due to UTC offset. Fixed applied addressing issue

### Version: v7.3 [31-May-2026]

Fixed:
* Tool query-collection was crashing Tally instance when the all of the fields requested did not exists in Tally, due to which bad Tally XML request was being generated, (fixed)

### Version: v7.2 [13-May-2026]

Added:
* Bundled version of Tally MCP Server for Claude Desktop i.e. Extension, for one-click installation

### Version: v7.1 [13-May-2026]

Fixed:
* Internal TDL syntax in XML request were breaking when double quote was specified in input for tools, which is now escaped properly
* Faulty handling for 0 and blank string is fixed
* In v7 tool chart-of-accounts was modified to extract only group, due to which response cycle was getting longer consuming more tokens. This behavious is reverted back to orginal
* In tool **ledger-account** field displaying alternate ledger is introduced, since party name field is found empty for journal type vouchers

### Version: v7 [12-May-2026]

Added:
* Tools **set-period** and **set-company** which can act as extra safeguard if user wants to set it as default for subsequent tool calls
* Tool **query-collection** to quickly query various fields of collection dynamically for ad-hoc information gathering
* Tools **metadata-collection** and **metadata-fields** to be used as helper functionality to gather listing of available collections and their fields for *query-collection* tool
* Tool **query-option-values** to gather listing of drop-down values from Tally for various data-entry screens
* Tool **ledger-create-update** to create or update ledger(s) on-the-fly in Tally

Fixed:
* Database of in-memory query was changed from **DuckDB** to **PgLite** for better cross-platform experience. Justification behind this change was increasing adoption of this MCP server in Mac OS []
* Migrated many reports to use tool query-collection internally to reduce static XML templates. As a result many of XML template files are now removed in favour of internal tool call. Reports are left only for few tools which have complex TDL expression which is difficult to accommodate in query collection functionality.
* Tool usage for reports were found to be reading template file from disk for every tool call. Caching of these templates was implemented by storing minified XML of these template in key-value variables
* TSV (Tab Separated Value) format was facing issue for few AI agents, which are designed to work only with JSON output. TSV has been removed in favour of introduction of 4 output format CSV, Markdown, JSON Array of Objects, JSON Schema and Rows

### Version: v6 [11-Nov-2025]

Added:
* Introducing of DuckDB based in-memory database caching of tabular output into temporary table (which persists for 15 min), for quick and accurate aggregation, filtering, sorting, calculation (which LLM is not capable of). This feature helps to do away with context size limitation of LLM for MCP output, which often produced error or hallucination. LLM now smartly handles by using SQL query to get this done.

Fixed:
* Renaming of column names for better readability and SQL querying by MCP
* Fixed few prompt description
* Amount was coming as 0 for *ledger-account* tool for few scenario, is now fixed by relevant XML TDL expression changes
* Quantity fetched by *stock-item-balance* tool was in absolute number ignoring negative balance scenario, is fixed by applying changes to XML
* Debit / Credit total in *trial-balance* tool was suppose to be positive for net Debit or net Credit respetively, is now fixed by applying changes on XML

### Version: v5 [06-Nov-2025]

Added:
* Stock Item Account tool

Fixed:
* ledger-account tool was ignoring Debit / Credit sign for opening balance. XML was fixed to prefix Dr / Cr sign


### Version: v4 [30-Oct-2025]

Added:
* Ease of configuration of setting via **.env** file instead of environment variables
* Balance Sheet and Profit Loss tools

Fixed:
* Ability to fetch from specific targetCompany was not working, which is now fixed
* ledger-account tool was skipping vouchers for some scenario. XML was fixed to query it and optimize it further as per Tally Solution TDL blog for best practise
* Unnecessary XML files used during initial development phase were removed


### Version: v3 [09-Oct-2025]

Added:
* Tool **chart-of-accounts** to grab group hierarchy structure
* Tool **stock-summary** to pull summary of all stock items with opening / inward / outward / closing values of quantity and amount

Fixed:
* Revamped MCP code to enhance connectivity with ChatGPT
* Minor fixes in Tally XML handling
* Tool **ledger-account** was skipping opening balance, which is not added into it
* Converted output of all the possible tools to tab separated format for optimization and light-weight response


### Version: v2 [04-Oct-2025]

Added:
* Tool **ledger-account** to grab ledger account
* Support for **ChatGPT** platform remote MCP

Fixed:
* oAuth implementation was revamped to adhere better to specification 2.1. These fixes allowed ChatGPT connectivity.
* Tabular response format was changed from JSON (which is heavy) to tab-separated for optimization. This allowed fitting of more data in response context.
* CLIENT_SECRET term was mistakenly used in entire code base, which was renamed as PASSWORD which is precise description of it.


### Version: v1 [02-Sep-2025]

Added:
* Entire implementation of Local &amp; Remote MCP