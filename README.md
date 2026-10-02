# ERP·MM — Enterprise Inventory Management System

A complete SAP MM-style Materials Management ERP built **100% on Google Apps Script +
Google Sheets**. No servers, no databases to maintain — the Google Sheet is the
database, Apps Script is the application server, and the web app is the corporate UI.

## What's in this package

| File | Purpose |
|---|---|
| `Code.gs` | Web app entry point (`doGet`), app config API |
| `Utils.gs` | Sheet helpers, document numbering, **stock ledger + moving-average valuation engine** |
| `Setup.gs` | One-click database initializer, demo data seeder, reset |
| `MasterData.gs` | Material master, vendor master, customer master, plants & storage locations |
| `Purchasing.gs` | Purchase requisitions → purchase orders → goods receipts (101) |
| `InventoryMgmt.gs` | Goods issues (201/261), plant/SLoc transfers (301/311), reservations, stock queries |
| `Sales.gs` | Sales orders → deliveries / PGI (601), vendor invoices (MIRO-lite) |
| `Reports.gs` | Dashboard KPIs, stock valuation, movement history, open docs, ABC analysis |
| `Index.html` | The entire web UI (single file, works offline, no external libraries) |
| `appsscript.json` | Project manifest (timezone, scopes) — optional |

### SAP MM concept mapping

| SAP MM | This system |
|---|---|
| Material Master (MM01/MM02/MM03) | Material Master view — ROH/HALB/FERT/HAWA types, valuation class, reorder point |
| Purchase Requisition (ME51N) | Purchasing → PR tab, multi-line, Open/Converted/Closed |
| Purchase Order (ME21N) | Purchasing → PO tab, PR reference conversion, partial/full receipt tracking |
| Goods Receipt (MIGO 101) | Post GR against PO lines, updates stock + moving average price |
| Goods Issue (MIGO 201/261) | Cost-center and production-order issues with availability check |
| Transfer Posting (301/311) | Plant-to-plant and SLoc-to-SLoc transfers, value preserved at MAP |
| Reservations (MB21) | Manual reservations with consume/close |
| Stock Overview (MMBE) | Plant/SLoc stock, drill-down to material ledger |
| Sales Order / Delivery (VA01/VL01N) | Sales → Orders → Post Delivery (PGI 601) |
| Invoice Verification (MIRO) | Vendor invoices with PO/vendor 3-way match check |
| Reports (MB5B/MC.9) | Valuation, movements, open POs/PRs, ABC analysis, CSV export |

**Document numbering** is automatic (SAP-style): materials `M-001001`, vendors `V-002001`,
PRs `PR-010001`, POs `4500000001`, GRs `5000000001`, GIs `4900000001`, deliveries
`8000000001`, invoices `5100000001`. **Every stock movement writes a full audit row**
to `StockLedger` with before/after quantity and value.

## Deployment — step by step

You will upload these files manually into a **container-bound** Apps Script project
(attached to a Google Sheet).

### 1. Create the database sheet
1. Go to [sheets.google.com](https://sheets.google.com) and create a **blank spreadsheet**.
   Name it e.g. `ERP-MM Database`.
2. Open **Extensions → Apps Script**. A new script project opens (delete the default
   `Code.gs` content — you'll replace it).

### 2. Upload the script files
For each `.gs` file in this zip (`Code.gs`, `Utils.gs`, `Setup.gs`, `MasterData.gs`,
`Purchasing.gs`, `InventoryMgmt.gs`, `Sales.gs`, `Reports.gs`):
1. In the Apps Script editor click **＋ next to "Files" → Script**.
2. Rename it to match the file (e.g. `Utils`).
3. Copy-paste the entire contents of the `.gs` file from this zip.
4. Save (Ctrl/Cmd+S).

Then the UI file:
1. Click **＋ next to "Files" → HTML**.
2. Rename it to `Index`.
3. Paste the entire contents of `Index.html`.

(Optional) Replace the manifest: click **Project Settings → check "Show
'appsscript.json' manifest file in editor"**, open `appsscript.json`, paste ours.

### 3. Initialize the database
1. In the editor's function dropdown select **`setupDatabase`** and click **Run**.
2. Authorize when asked (Google will warn it's unverified — this is your own code;
   click Advanced → Go to project → Allow).
3. Switch back to your Google Sheet: you should now see 18 tabs
   (Materials, Vendors, Stock, StockLedger, NumberRanges, …).
4. (Optional, recommended) Run **`seedDemoData`** — loads 5 materials, vendors,
   customers, a PO with goods receipt, a delivered sales order, an invoice, etc.,
   so you can explore immediately. To wipe everything later, run `resetDatabase`.

### 4. Deploy as a web app
1. In Apps Script click **Deploy → New deployment**.
2. Type: **Web app**. Description: `ERP-MM v1.0`.
3. **Execute as:** Me. **Who has access:** Anyone (or Anyone with Google account —
   your choice).
4. Click **Deploy**, authorize again, and copy the **Web app URL**.

### 5. Open the app
Open the URL — the ERP dashboard loads. If the database wasn't initialized, the app
routes you to **Setup** where you can initialize with one click.

## Suggested test walkthrough (5 minutes)

1. **Material Master** → New Material → create e.g. `Copper Rod / ROH / M`.
2. **Purchasing → PR** → New PR for 500 M of it → note the `PR-xxxxxx` number.
3. **Purchasing → PO** → New PO for a vendor, reference the PR → PR line becomes *Converted*.
4. **PO → View → Post Goods Receipt** → receive 500 → check **Stock Overview**: quantity
   and moving average price updated; **Reports → Movement History** shows the 101 row.
5. **Inventory → Goods Issue** → issue 50 (201) → stock drops, ledger grows.
6. **Sales → New Sales Order → Deliver** → 601 movement reduces stock.
7. **Reports → Stock Valuation / ABC Analysis** → export CSV.

## Key Improvements & Architecture Highlights (v1.3)

1. **Goods Receipt Reversal & Return to Vendor (`pur_reverseGR`, Movement 102)**:
   Added full support for reversing posted Goods Receipts. Decrements on-hand stock, automatically adjusts the Purchase Order's `ReceivedQty`, restores the PO line status back to `Open` or `Partial`, and posts an audited movement 102 entry to `StockLedger` and `GoodsReceipts`.

2. **Goods Issue Reversal (`inv_reverseGI`, Movement 202/262)**:
   Supports 1-click reversals for goods issues (cost-center issue 201 reversed via 202, production issue 261 reversed via 262). Restores material stock at the current moving-average valuation and logs full audit trails.

3. **Bulk Material & Vendor Import (`md_bulkImportMaterials`, `md_bulkImportVendors`)**:
   Enables batch creation of materials and vendors via a simple CSV text import modal in the Material Master view. Validates headers, parses descriptions, types, UOMs, and reorder points, and writes records with atomic script locking.

4. **Time-Driven Background Trigger Automation (`setupDailyLowStockTrigger`)**:
   Provides one-click scheduling of daily time-driven Google Apps Script triggers to automatically run `alert_sendLowStockDigest()` every morning at 08:00 AM, scanning inventory and sending email alerts when stock breaches reorder thresholds.

5. **Global Quick-Find / Command Search**:
   An SAP-style topbar quick-search bar allows users to instantly search and navigate to PO numbers, material IDs, vendor IDs, or sales orders with keyboard shortcut support (Enter key jump).

6. **Google Sheets Custom Menu & Direct UI Integration (`onOpen`)**:
   When opened in Google Sheets, a custom top-level menu **ERP · Materials Management** is automatically created with quick actions:
   - 🚀 Launch ERP Web App (modal dialog with direct launch link)
   - 📊 Export ABC Analysis directly to a styled Google Sheet tab
   - ⚠️ Export Low Stock Report directly to a sheet tab
   - 📈 Export Stock Valuation to a sheet tab
   - 🔄 Audit Stock vs Ledger (verifies balance integrity)
   - 📧 Send Low Stock Alert Email digest to user
   - ⏰ Schedule / Disable Daily Low Stock Digest Trigger
   - 🛠️ Initialize / Verify Database Sheets & Seed Demo Dataset

7. **Stock Ledger Integrity Audit & Reconciliation (`rep_auditStockLedger`, `rep_reconcileAndFixStock`)**:
   A reconciliation audit tool compares the balances in the `Stock` table against the verified cumulative sum of transactional changes in `StockLedger`. If any discrepancy occurs, an automatic 1-click reconciliation syncs the current stock balances back to the ground truth.

8. **Slow-Moving & Dead Stock Analysis (`rep_slowMovingStock`)**:
   Implements SAP MM MC46 stagnant inventory analysis: identifies materials with on-hand stock but no consumption (goods issues 201/261 or delivery 601) past a customizable threshold (e.g. 30, 60, or 90 days), calculating idle duration and total tied-up capital.

9. **Vendor Spend & Procurement Analysis (`rep_vendorSpendAnalysis`)**:
   Consolidates purchase volume, total purchase order commitments, invoice disbursements, and pending liabilities grouped by vendor partner.

10. **Direct Sheet Tab Report Export (`rep_exportReportToSheet`)**:
    Users can generate styled report tabs (`Report_ABC`, `Report_LOW_STOCK`, `Report_VALUATION`, `Report_AUDIT`) directly inside the Google Spreadsheet with navy headers, bold text, and auto-fitted columns.

11. **Low Stock Email Digest Notifications (`alert_sendLowStockDigest`)**:
    Uses `MailApp.sendEmail` to compile and send clean HTML email summaries of all materials that have breached their reorder thresholds, with plant, location, current quantity, and shortage amounts.

12. **Safe Partial Row Updates (`up_updateRow`)**:
    Fixed a critical data preservation issue where updating specific fields (such as PR conversion, PO closure, or invoice payment) previously risked wiping other row columns. Row updates now automatically merge patches while strictly preserving existing spreadsheet values.

13. **Accurate Moving-Average Valuation (MAP)**:
    Valuation updates upon goods receipts (movement 101) now strictly calculate the weighted moving average price across the material's total stock:
    `New MAP = (Current Total Stock Value + Receipt Value) / (Current Total Quantity + Receipt Quantity)`

14. **Atomic Stock Transfers (`inv_transferStock`)**:
    Two-legged transfer postings (301 Plant-to-Plant and 311 SLoc-to-SLoc) are now guarded by script locks across both legs, ensuring complete atomicity without stock limbo states.

15. **Universal Document Printout by Number (`doc_getDocumentForPrint`)**:
    - **Dedicated Document Printout Center**: Navigate to **Print Documents** or click **🖨️ Print Doc** in the top bar (or press `Alt+P`) to enter any document number (Purchase Order, Goods Receipt Note, Goods Issue Voucher, Sales Order, Delivery Packing Slip, Vendor Invoice, Purchase Requisition, or Transfer Posting).
    - **Fuzzy Prefix Matching**: Accepts standard ERP numbers (`4500000001`, `5000000001`, `8000000001`, `5100000001`, `10001`) as well as prefixed strings (`PO-4500000001`, `GR-5000000001`, `GI-4900000001`, `SO-020001`, `DEL-8000000001`, `INV-5100000001`, `PR-010001`).
    - **Live Embedded Previews & Direct Printing**: Preview full vouchers directly on the page or trigger the print modal with `@media print` formatting and company signature sections.
    - **Recent Documents Table**: One-click print buttons for all recent documents across modules.
    - **Google Sheets Menu Integration**: Added **ERP · Materials Management → 🖨️ Print Document by Number...** to print directly from within Google Sheets.

16. **Dual Mode (Apps Script Live & Standalone Preview)**:
    The UI automatically detects whether it is running inside Google Apps Script (`google.script.run`) or standalone (e.g. in a browser preview or local environment). When standalone, it provides an in-memory/localStorage simulator pre-seeded with demo records so users can test every feature without backend errors.

12. **Responsive Tablet & Mobile Drawer**:
    A collapsible sidebar navigation with backdrop overlay enables seamless use on phones and tablets.

13. **Iframe & Portal Embedding**:
    `Code.gs` sets `XFrameOptionsMode.ALLOWALL`, allowing the web app to be safely embedded in company intranets, Google Sites, or client dashboards.

## Notes & limits

- Built for the **V8 runtime**. All writes use `LockService` for safe concurrent use.
- Google Sheets caps (~10M cells) are the practical DB limit — fine for SME use; for
  very high volumes, archive `StockLedger` periodically.
- Dates are stored as `yyyy-MM-dd` strings; money is rounded to 2 decimals.
- `resetDatabase()` clears all data rows but keeps Config (company name/currency).
- The UI calls the backend with `google.script.run` — everything runs under the
  deploying user's Google account.

## Customizing

- Company name/currency: **Setup → Company settings** (or the `Config` sheet).
- Number ranges: edit the `NumberRanges` sheet (`LastNumber`) — never reuse numbers.
- New plants/storage locations: **Setup → Plants & Storage Locations**, or the sheets.
- Movement-type labels: `MOVEMENT_TYPES` in `Utils.gs` (+ `MT_LABELS` in `Index.html`).

---
Built 2026-09-29 · v1.2.0
