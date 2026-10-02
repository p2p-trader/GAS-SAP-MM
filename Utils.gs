/**
 * Utils.gs — Shared utilities for the SAP MM-style ERP (Google Apps Script, V8).
 * Container-bound: always operates on the spreadsheet the script is bound to.
 *
 * Provides: sheet schema, movement types, sheet helpers, config, numbering
 * (getNextNumber / _nextNumberNoLock), and stock posting (postStockMovement).
 */

/* ---------------------------------------------------------------------------
 * Schema: sheet names -> exact row-1 headers (column order matters).
 * ------------------------------------------------------------------------- */
const SCHEMA = {
  Materials: ['MaterialID', 'Description', 'MaterialType', 'MaterialGroup', 'BaseUOM',
    'ValuationClass', 'StdPrice', 'MovingAvgPrice', 'ReorderPoint', 'Plant', 'CreatedOn', 'CreatedBy'],
  Vendors: ['VendorID', 'Name', 'City', 'Country', 'PaymentTerms', 'Currency', 'Email', 'Phone', 'CreatedOn'],
  Customers: ['CustomerID', 'Name', 'City', 'Country', 'PaymentTerms', 'Currency', 'Email', 'Phone', 'CreatedOn'],
  Plants: ['PlantID', 'Name', 'City', 'Country'],
  StorageLocations: ['SLocID', 'PlantID', 'Description'],
  Stock: ['MaterialID', 'Plant', 'SLoc', 'Quantity', 'StockValue'],
  PurchaseRequisitions: ['PRNo', 'Line', 'MaterialID', 'Description', 'Qty', 'UOM', 'ReqDate',
    'Plant', 'SLoc', 'Status', 'CreatedOn', 'CreatedBy'],
  PurchaseOrders: ['PONo', 'Line', 'PRRef', 'VendorID', 'MaterialID', 'Description', 'Qty', 'UOM',
    'NetPrice', 'Currency', 'DeliveryDate', 'Plant', 'SLoc', 'Status', 'ReceivedQty', 'CreatedOn'],
  GoodsReceipts: ['GRNo', 'DocDate', 'PostingDate', 'PONo', 'POLine', 'MaterialID', 'Qty', 'UOM',
    'Plant', 'SLoc', 'MovementType', 'RefDoc', 'CreatedBy'],
  GoodsIssues: ['GINo', 'DocDate', 'PostingDate', 'MaterialID', 'Qty', 'UOM', 'Plant', 'SLoc',
    'MovementType', 'CostCenter', 'Reason', 'CreatedBy'],
  Reservations: ['ResNo', 'MaterialID', 'Qty', 'UOM', 'Plant', 'SLoc', 'ReqDate', 'Status', 'CreatedOn'],
  SalesOrders: ['SONo', 'Line', 'CustomerID', 'MaterialID', 'Description', 'Qty', 'UOM', 'NetPrice',
    'Currency', 'ReqDelDate', 'Plant', 'SLoc', 'Status', 'DeliveredQty', 'CreatedOn'],
  Deliveries: ['DelNo', 'DocDate', 'SONo', 'SOLine', 'MaterialID', 'Qty', 'UOM', 'Plant', 'SLoc',
    'MovementType', 'Status', 'CreatedBy'],
  VendorInvoices: ['InvNo', 'DocDate', 'PONo', 'GRNo', 'VendorID', 'GrossAmount', 'TaxAmount',
    'Currency', 'Status', 'CreatedBy'],
  StockLedger: ['LedgerID', 'Timestamp', 'DocType', 'DocNo', 'MaterialID', 'Plant', 'SLoc',
    'MovementType', 'QtyChange', 'ValueChange', 'NewQty', 'NewValue', 'UnitPrice', 'CreatedBy'],
  NumberRanges: ['DocType', 'Prefix', 'LastNumber', 'PadLength', 'Description'],
  Config: ['Key', 'Value'],
  Users: ['UserID', 'Name', 'Role', 'Email', 'Active']
};

/* ---------------------------------------------------------------------------
 * Movement types (SAP MM conventions).
 * ------------------------------------------------------------------------- */
const MOVEMENT_TYPES = {
  '101': 'Goods Receipt - Purchase Order',
  '102': 'GR Reversal',
  '201': 'Goods Issue - Cost Center',
  '261': 'Goods Issue - Production Order',
  '301': 'Transfer Posting - Plant to Plant',
  '311': 'Transfer Posting - SLoc to SLoc',
  '601': 'Goods Issue - Delivery to Customer',
  '701': 'Physical Inventory Gain (Adjustment)',
  '702': 'Physical Inventory Loss (Adjustment)'
};

/* ---------------------------------------------------------------------------
 * Spreadsheet / sheet helpers.
 * ------------------------------------------------------------------------- */

/** The active (container-bound) spreadsheet. */
function up_getSS() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

/** Returns the sheet, or throws if it does not exist. */
function up_getSheet(name) {
  const sh = up_getSS().getSheetByName(name);
  if (!sh) {
    throw new Error('Sheet ' + name + ' not found. Run setupDatabase().');
  }
  return sh;
}

/**
 * Creates the sheet with SCHEMA headers if missing; if it exists but the
 * header row is empty, writes the headers. Never touches existing data.
 */
function up_ensureSheet(name) {
  const headers = SCHEMA[name];
  if (!headers) throw new Error('Unknown sheet in schema: ' + name);
  let sh = up_getSS().getSheetByName(name);
  if (!sh) {
    sh = up_getSS().insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return sh;
}

/** Header names of the sheet as an array. */
function up_getHeaders(name) {
  const sh = up_getSheet(name);
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
}

/**
 * Batch-reads the whole sheet and returns an array of plain objects keyed by
 * header name. Skips rows whose first column is empty.
 */
function up_readAll(name) {
  const sh = up_getSheet(name);
  if (sh.getLastRow() < 1) return [];
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  const out = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (row[0] === '' || row[0] === null || row[0] === undefined) continue;
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      obj[String(headers[c])] = row[c];
    }
    out.push(obj);
  }
  return out;
}

/** Appends one row built from `obj`, in the sheet's header order. */
function up_appendRow(name, obj) {
  const sh = up_getSheet(name);
  const headers = up_getHeaders(name);
  const row = headers.map(h => (obj[h] === undefined || obj[h] === null) ? '' : obj[h]);
  sh.appendRow(row);
}

/** 1-based sheet row index of the first row where keyHeader === keyVal, else -1. */
function up_findRowIndex(name, keyHeader, keyVal) {
  const sh = up_getSheet(name);
  if (sh.getLastRow() < 2) return -1;
  const values = sh.getDataRange().getValues();
  const headers = values[0];
  const col = headers.indexOf(keyHeader);
  if (col === -1) throw new Error('Header ' + keyHeader + ' not found in sheet ' + name);
  const target = String(keyVal);
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][col]) === target) return r + 1; // 1-based
  }
  return -1;
}

/** Overwrites row at 1-based `rowIdx` while safely preserving any untouched columns. */
function up_updateRow(name, rowIdx, obj) {
  const sh = up_getSheet(name);
  const headers = up_getHeaders(name);
  const existingValues = sh.getRange(rowIdx, 1, 1, headers.length).getValues()[0];
  const row = headers.map((h, colIdx) => {
    if (obj[h] !== undefined && obj[h] !== null) {
      return obj[h];
    }
    return (existingValues[colIdx] !== undefined && existingValues[colIdx] !== null)
      ? existingValues[colIdx]
      : '';
  });
  sh.getRange(rowIdx, 1, 1, headers.length).setValues([row]);
}

/** Throws listing any fields missing/blank on `obj`. */
function up_require(obj, fields) {
  const missing = fields.filter(f => {
    const v = obj[f];
    return v === undefined || v === null || String(v).trim() === '';
  });
  if (missing.length) {
    throw new Error('Missing required field(s): ' + missing.join(', '));
  }
}

/* ---------------------------------------------------------------------------
 * Numbers, dates, config, misc.
 * ------------------------------------------------------------------------- */

function up_round2(x) {
  return Math.round(Number(x) * 100) / 100;
}

function up_round3(x) {
  return Math.round(Number(x) * 1000) / 1000;
}

/** Today as 'yyyy-MM-dd' string. */
function up_today() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/** Now as 'yyyy-MM-dd HH:mm:ss' string. */
function up_now() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
}

/** Read a Config key, returning `def` when absent. */
function up_getConfig(key, def) {
  try {
    const row = up_readAll('Config').find(r => String(r.Key) === String(key));
    return row ? row.Value : def;
  } catch (e) {
    return def; // Config sheet may not exist yet
  }
}

/** Insert or update a Config key/value pair. */
function up_setConfig(key, val) {
  const idx = up_findRowIndex('Config', 'Key', key);
  if (idx === -1) {
    up_appendRow('Config', { Key: key, Value: val });
  } else {
    up_updateRow('Config', idx, { Key: key, Value: val });
  }
}

/** Material master record by ID, or null. */
function up_materialById(id) {
  const found = up_readAll('Materials').find(r => String(r.MaterialID) === String(id));
  return found || null;
}

/** Email of the active user, falling back to 'system'. */
function up_createdBy() {
  try {
    return Session.getActiveUser().getEmail() || 'system';
  } catch (e) {
    return 'system';
  }
}

/* ---------------------------------------------------------------------------
 * Number ranges. getNextNumber() acquires the script lock; _nextNumberNoLock()
 * assumes the caller already holds it (e.g. postStockMovement).
 * ------------------------------------------------------------------------- */

/**
 * Increments the range for `docType` and returns the formatted document
 * number: Prefix + String(last).padStart(pad, '0').
 * Caller must already hold the script lock.
 */
function _nextNumberNoLock(docType) {
  const idx = up_findRowIndex('NumberRanges', 'DocType', docType);
  if (idx === -1) throw new Error('Unknown document type in NumberRanges: ' + docType);
  const row = up_readAll('NumberRanges').find(r => String(r.DocType) === String(docType));
  const last = Number(row.LastNumber) + 1;
  const pad = Number(row.PadLength) || 0;
  up_updateRow('NumberRanges', idx, {
    DocType: row.DocType,
    Prefix: row.Prefix,
    LastNumber: last,
    PadLength: row.PadLength,
    Description: row.Description
  });
  return String(row.Prefix) + String(last).padStart(pad, '0');
}

/** Locking wrapper around _nextNumberNoLock. */
function getNextNumber(docType) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    return _nextNumberNoLock(docType);
  } finally {
    lock.releaseLock();
  }
}

/* ---------------------------------------------------------------------------
 * Stock posting: single place where Stock quantities/values and the
 * StockLedger are updated. Acquires the script lock itself.
 * ------------------------------------------------------------------------- */

/**
 * p = { materialId, plant, sloc, qtyChange, movementType, docType, docNo,
 *       unitPrice (optional, for receipts), createdBy (optional) }
 * Returns { newQty, newValue, map }.
 */
function postStockMovement(p) {
  up_require(p, ['materialId', 'plant', 'sloc', 'qtyChange', 'movementType', 'docType', 'docNo']);

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    // 2. Validate material.
    const matIdx = up_findRowIndex('Materials', 'MaterialID', p.materialId);
    if (matIdx === -1) throw new Error('Material ' + p.materialId + ' not found');

    // 3. Current moving-average (fallback: standard price).
    const matRows = up_readAll('Materials');
    const mat = matRows.find(r => String(r.MaterialID) === String(p.materialId));
    const map = Number(mat.MovingAvgPrice) || Number(mat.StdPrice) || 0;

    // 4. Find (by composite key) or create the Stock row.
    const stockSh = up_getSheet('Stock');
    let stockIdx = -1;   // 1-based sheet row
    let stockRow = null;
    const stockVals = stockSh.getLastRow() > 1 ? stockSh.getDataRange().getValues() : [];
    if (stockVals.length > 1) {
      const hdr = stockVals[0];
      const cM = hdr.indexOf('MaterialID'), cP = hdr.indexOf('Plant'),
            cS = hdr.indexOf('SLoc'), cQ = hdr.indexOf('Quantity'), cV = hdr.indexOf('StockValue');
      for (let r = 1; r < stockVals.length; r++) {
        if (String(stockVals[r][cM]) === String(p.materialId) &&
            String(stockVals[r][cP]) === String(p.plant) &&
            String(stockVals[r][cS]) === String(p.sloc)) {
          stockIdx = r + 1;
          stockRow = {
            MaterialID: p.materialId,
            Plant: String(p.plant),
            SLoc: String(p.sloc),
            Quantity: stockVals[r][cQ],
            StockValue: stockVals[r][cV]
          };
          break;
        }
      }
    }
    if (stockIdx === -1) {
      up_appendRow('Stock', { MaterialID: p.materialId, Plant: String(p.plant), SLoc: String(p.sloc), Quantity: 0, StockValue: 0 });
      stockIdx = up_getSheet('Stock').getLastRow();
      stockRow = { MaterialID: p.materialId, Plant: String(p.plant), SLoc: String(p.sloc), Quantity: 0, StockValue: 0 };
    }

    const oldQty = Number(stockRow.Quantity) || 0;
    const oldValue = Number(stockRow.StockValue) || 0;

    // 5. New quantity, with negative-stock guard.
    const qtyChange = Number(p.qtyChange);
    const newQty = up_round3(oldQty + qtyChange);
    if (newQty < -0.0001) {
      throw new Error('Insufficient stock for material ' + p.materialId +
        ' in plant/sloc ' + p.plant + '/' + p.sloc + ' (available ' + oldQty + ')');
    }

    // 6. Valuation (SAP MM standard Moving Average formula: (Total Current Value + Receipt Value) / (Total Current Qty + Receipt Qty))
    let newMAP;
    let effPrice;
    let valueChange;
    if (qtyChange > 0 && p.unitPrice !== undefined && p.unitPrice !== null) {
      const unitPrice = Number(p.unitPrice);
      valueChange = up_round2(qtyChange * unitPrice);
      const allStock = up_readAll('Stock').filter(s => String(s.MaterialID) === String(p.materialId));
      const totalMatQty = allStock.reduce((acc, s) => acc + (Number(s.Quantity) || 0), 0);
      const totalMatVal = allStock.reduce((acc, s) => acc + (Number(s.StockValue) || 0), 0);
      const combinedQty = up_round3(totalMatQty + qtyChange);
      newMAP = combinedQty > 0 ? up_round2((totalMatVal + valueChange) / combinedQty) : unitPrice;
      effPrice = unitPrice;
      // Update material moving average price
      up_updateRow('Materials', matIdx, { MovingAvgPrice: newMAP });
    } else {
      effPrice = map;
      valueChange = up_round2(qtyChange * map);
    }

    // 7. Persist stock row.
    const newValue = up_round2(oldValue + valueChange);
    const fullStock = {};
    up_getHeaders('Stock').forEach(h => { fullStock[h] = stockRow[h] !== undefined ? stockRow[h] : ''; });
    fullStock.MaterialID = p.materialId;
    fullStock.Plant = String(p.plant);
    fullStock.SLoc = String(p.sloc);
    fullStock.Quantity = newQty;
    fullStock.StockValue = newValue;
    up_updateRow('Stock', stockIdx, fullStock);

    // 8. Ledger entry (uses the no-lock numbering: we already hold the lock).
    const ledgerId = _nextNumberNoLock('LED');
    up_appendRow('StockLedger', {
      LedgerID: ledgerId,
      Timestamp: up_now(),
      DocType: p.docType,
      DocNo: p.docNo,
      MaterialID: p.materialId,
      Plant: String(p.plant),
      SLoc: String(p.sloc),
      MovementType: p.movementType,
      QtyChange: up_round3(qtyChange),
      ValueChange: valueChange,
      NewQty: newQty,
      NewValue: newValue,
      UnitPrice: up_round2(effPrice),
      CreatedBy: p.createdBy || up_createdBy()
    });

    return { newQty: newQty, newValue: newValue, map: up_round2(newMAP !== undefined ? newMAP : map) };
  } finally {
    lock.releaseLock();
  }
}
