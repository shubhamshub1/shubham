# Tally Prime MCP Server: Aetherwise edition (7.12.2)

This is a fork of [dhananjay1405/tally-mcp-server](https://github.com/dhananjay1405/tally-mcp-server) (MIT License, © 2025 Dhananjay Gokhale).

## Changes in this fork

**New tools**

| Tool | What it does |
|---|---|
| `voucher-list` | Lists vouchers by date range, voucher type or party. Each row includes the MasterID and GUID, so a specific voucher can be identified for alteration or deletion. |
| `inspect-xml-file` | Checks a local XML file before import. It reports the company and the number of vouchers and ledgers. |
| `import-xml-file` | Imports a local Tally XML file in chunks. It returns the CREATED, ALTERED and ERRORS counts plus Tally's line errors. |
| `voucher-delete` | Deletes vouchers by MasterID or voucher number. It requires `confirm=true`. |

**Changes to existing tools**

- `ledger-create-update`:
  - The GSTIN validation was wrong (it used a date regex). It now checks the GSTIN format.
  - GST registration details can now be set even when mailing details are not given.
  - The registration type now defaults to Regular.
  - A new `gstDutyHead` option sets the tax type (Central, State or Integrated Tax) on GST duty ledgers.
  - Ledger names containing `&` now work when renaming or altering a ledger.
- A new `Voucher` collection is available in `query-collection`.
