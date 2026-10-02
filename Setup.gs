/**
 * Setup.gs — Database bootstrap, demo data, reset and status for the ERP.
 *
 * setupDatabase() : idempotent creation of all sheets + seed ranges/config.
 * seedDemoData()  : one-click demo dataset (materials, vendors, customers,
 *                   POs + GRs, initial stock, PR, SO + delivery, invoice,
 *                   reservation). Guarded so it can only run on an empty DB.
 * resetDatabase() : clears all data rows below the header (Config preserved).
 * getSetupStatus(): JSON-friendly health check for the UI.
 */

/* ---------------------------------------------------------------------------
 * Internal helpers (seed_-prefixed so names stay globally unique).
 * ------------------------------------------------------------------------- */

/** 1-based row index matching all key/value pairs, or -1 (batch read). */
function seed_findRow(name, keyPairs) {
  const sh = up_getSheet(name);
  if (sh.getLastRow() < 2) return -1;
  const values = sh.getDataRange().getValues();
  const headers = values[0];
  const cols = Object.keys(keyPairs).map(k => {
    const c = headers.indexOf(k);
    if (c === -1) throw new Error('Header ' + k + ' not found in sheet ' + name);
    return c;
  });
  const keys = Object.keys(keyPairs);
  for (let r = 1; r < values.length; r++) {
    let match = true;
    for (let i = 0; i < keys.length; i++) {
      if (String(values[r][cols[i]]) !== String(keyPairs[keys[i]])) { match = false; break; }
    }
    if (match) return r + 1;
  }
  return -1;
}

/** Merges `patch` into the existing row at 1-based `rowIdx` and writes it back. */
function seed_patchRow(name, rowIdx, patch) {
  const sh = up_getSheet(name);
  const headers = up_getHeaders(name);
  const cur = sh.getRange(rowIdx, 1, 1, headers.length).getValues()[0];
  const obj = {};
  for (let c = 0; c < headers.length; c++) obj[headers[c]] = cur[c];
  Object.keys(patch).forEach(k => { obj[k] = patch[k]; });
  up_updateRow(name, rowIdx, obj);
}

/** Date string 'yyyy-MM-dd', `days` in the future from today. */
function seed_plusDays(days) {
  const tz = Session.getScriptTimeZone();
  const d = new Date(new Date().getTime() + days * 24 * 60 * 60 * 1000);
  return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
}

/* ---------------------------------------------------------------------------
 * setupDatabase(): create all sheets + seed static data. Idempotent.
 * ------------------------------------------------------------------------- */
function setupDatabase() {
  const names = Object.keys(SCHEMA);
  names.forEach(up_ensureSheet);

  // Number ranges — only when the sheet has no data rows yet.
  if (up_readAll('NumberRanges').length === 0) {
    const ranges = [
      ['MAT',  'M-',   1000, 6, 'Material master'],
      ['VND',  'V-',   2000, 6, 'Vendor master'],
      ['CUST', 'C-',   3000, 6, 'Customer master'],
      ['PR',   'PR-',  10000, 6, 'Purchase requisition'],
      ['PO',   '45',   0,    8, 'Purchase order'],
      ['GR',   '50',   0,    8, 'Goods receipt'],
      ['GI',   '49',   0,    8, 'Goods issue'],
      ['TR',   'TR-',  7000, 6, 'Stock transfer'],
      ['RES',  'RS-',  5000, 6, 'Reservation'],
      ['SO',   'SO-',  20000, 6, 'Sales order'],
      ['DN',   '80',   0,    8, 'Delivery note'],
      ['INV',  '51',   0,    8, 'Vendor invoice'],
      ['ADJ',  'AD-',  6000, 6, 'Physical inventory adjustment'],
      ['LED',  'L-',   0,    8, 'Stock ledger entry']
    ];
    ranges.forEach(r => up_appendRow('NumberRanges', {
      DocType: r[0], Prefix: r[1], LastNumber: r[2], PadLength: r[3], Description: r[4]
    }));
  }

  // Config — only when empty.
  if (up_readAll('Config').length === 0) {
    up_appendRow('Config', { Key: 'CompanyName', Value: 'Acme Corporation' });
    up_appendRow('Config', { Key: 'Currency', Value: 'PKR' });
    up_appendRow('Config', { Key: 'FiscalYear', Value: '2026' });
  }

  // Plants — only when empty.
  if (up_readAll('Plants').length === 0) {
    up_appendRow('Plants', { PlantID: '1000', Name: 'Karachi Plant', City: 'Karachi', Country: 'Pakistan' });
    up_appendRow('Plants', { PlantID: '2000', Name: 'Lahore Plant', City: 'Lahore', Country: 'Pakistan' });
  }

  // Storage locations — only when empty.
  if (up_readAll('StorageLocations').length === 0) {
    up_appendRow('StorageLocations', { SLocID: '0001', PlantID: '1000', Description: 'Raw Material Store' });
    up_appendRow('StorageLocations', { SLocID: '0002', PlantID: '1000', Description: 'Finished Goods Store' });
    up_appendRow('StorageLocations', { SLocID: '0001', PlantID: '2000', Description: 'RM Store - Lahore' });
  }

  return {
    ok: true,
    message: 'Database initialized: ' + names.length + ' sheets ready. Number ranges, config, plants and storage locations seeded.',
    sheets: names
  };
}

/* ---------------------------------------------------------------------------
 * seedDemoData(): builds a full demo company on an empty database.
 * ------------------------------------------------------------------------- */
function seedDemoData() {
  if (up_readAll('Materials').length > 0) {
    throw new Error('Demo data already loaded. Run Reset Data first.');
  }
  const today = up_today();
  const by = up_createdBy();

  // --- Materials (5) ---
  const materials = [
    ['M-001001', 'Steel Coil',        'ROH',  'RM-STEEL',   'KG', '3000', 185,  185, 200, '1000'],
    ['M-001002', 'Copper Wire',       'ROH',  'RM-COPPER',  'M',  '3000', 95,   95,  500, '1000'],
    ['M-001003', 'Ball Bearing',      'HALB', 'SM-BEARING', 'PC', '3100', 240,  240, 100, '1000'],
    ['M-001004', 'Gear Box Assembly', 'FERT', 'FG-GEAR',    'PC', '3200', 1450, 1450, 20,  '1000'],
    ['M-001005', 'Packing Box',       'HAWA', 'PM-PACK',    'PC', '3300', 45,   45,  300, '1000']
  ];
  materials.forEach(m => up_appendRow('Materials', {
    MaterialID: m[0], Description: m[1], MaterialType: m[2], MaterialGroup: m[3],
    BaseUOM: m[4], ValuationClass: m[5], StdPrice: m[6], MovingAvgPrice: m[7],
    ReorderPoint: m[8], Plant: m[9], CreatedOn: today, CreatedBy: by
  }));

  // --- Vendors (2) ---
  up_appendRow('Vendors', { VendorID: 'V-002001', Name: 'Karachi Steel Traders', City: 'Karachi',
    Country: 'Pakistan', PaymentTerms: 'Net 30', Currency: 'PKR',
    Email: 'info@ksteel.pk', Phone: '+92-21-1111111', CreatedOn: today });
  up_appendRow('Vendors', { VendorID: 'V-002002', Name: 'Lahore Metals Co', City: 'Lahore',
    Country: 'Pakistan', PaymentTerms: 'Net 45', Currency: 'PKR',
    Email: 'info@lahoremetals.pk', Phone: '+92-42-2222222', CreatedOn: today });

  // --- Customers (2) ---
  up_appendRow('Customers', { CustomerID: 'C-003001', Name: 'AutoParts Industries', City: 'Karachi',
    Country: 'Pakistan', PaymentTerms: 'Net 30', Currency: 'PKR', Email: '', Phone: '', CreatedOn: today });
  up_appendRow('Customers', { CustomerID: 'C-003002', Name: 'MegaMart Retail', City: 'Lahore',
    Country: 'Pakistan', PaymentTerms: 'Net 15', Currency: 'PKR', Email: '', Phone: '', CreatedOn: today });

  // --- Purchase Order 1: 4500000001 (fully received via GR 5000000001) ---
  const po1 = getNextNumber('PO'); // -> '4500000001'
  const po1Lines = [
    { line: 10, materialId: 'M-001001', description: 'Steel Coil',  qty: 1000, uom: 'KG', price: 185 },
    { line: 20, materialId: 'M-001002', description: 'Copper Wire', qty: 2000, uom: 'M',  price: 95 }
  ];
  po1Lines.forEach(l => up_appendRow('PurchaseOrders', {
    PONo: po1, Line: l.line, PRRef: '', VendorID: 'V-002001', MaterialID: l.materialId,
    Description: l.description, Qty: l.qty, UOM: l.uom, NetPrice: l.price, Currency: 'PKR',
    DeliveryDate: seed_plusDays(14), Plant: '1000', SLoc: '0001',
    Status: 'Open', ReceivedQty: 0, CreatedOn: today
  }));

  // Full goods receipt against PO1.
  const gr1 = getNextNumber('GR'); // -> '5000000001'
  po1Lines.forEach(l => {
    postStockMovement({
      materialId: l.materialId, plant: '1000', sloc: '0001',
      qtyChange: l.qty, movementType: '101', docType: 'GR', docNo: gr1,
      unitPrice: l.price, createdBy: by
    });
    up_appendRow('GoodsReceipts', {
      GRNo: gr1, DocDate: today, PostingDate: today, PONo: po1, POLine: l.line,
      MaterialID: l.materialId, Qty: l.qty, UOM: l.uom, Plant: '1000', SLoc: '0001',
      MovementType: '101', RefDoc: po1, CreatedBy: by
    });
    const idx = seed_findRow('PurchaseOrders', { PONo: po1, Line: l.line });
    seed_patchRow('PurchaseOrders', idx, { ReceivedQty: l.qty, Status: 'Received' });
  });

  // --- Purchase Order 2: 4500000002 (left Open for reports) ---
  const po2 = getNextNumber('PO'); // -> '4500000002'
  up_appendRow('PurchaseOrders', {
    PONo: po2, Line: 10, PRRef: '', VendorID: 'V-002002', MaterialID: 'M-001003',
    Description: 'Ball Bearing', Qty: 150, UOM: 'PC', NetPrice: 240, Currency: 'PKR',
    DeliveryDate: seed_plusDays(14), Plant: '1000', SLoc: '0001',
    Status: 'Open', ReceivedQty: 0, CreatedOn: today
  });

  // --- Initial stock (GR 5000000002, RefDoc 'Initial stock') ---
  const grInit = getNextNumber('GR'); // -> '5000000002'
  const initLines = [
    { materialId: 'M-001004', qty: 50,  uom: 'PC', price: 1450, sloc: '0002' },
    { materialId: 'M-001005', qty: 500, uom: 'PC', price: 45,   sloc: '0002' },
    { materialId: 'M-001003', qty: 200, uom: 'PC', price: 240,  sloc: '0001' }
  ];
  initLines.forEach(l => {
    postStockMovement({
      materialId: l.materialId, plant: '1000', sloc: l.sloc,
      qtyChange: l.qty, movementType: '101', docType: 'INIT', docNo: grInit,
      unitPrice: l.price, createdBy: by
    });
    up_appendRow('GoodsReceipts', {
      GRNo: grInit, DocDate: today, PostingDate: today, PONo: '', POLine: '',
      MaterialID: l.materialId, Qty: l.qty, UOM: l.uom, Plant: '1000', SLoc: l.sloc,
      MovementType: '101', RefDoc: 'Initial stock', CreatedBy: by
    });
  });

  // --- Purchase Requisition PR-010001 (Open) ---
  const prNo = getNextNumber('PR'); // -> 'PR-010001'
  up_appendRow('PurchaseRequisitions', {
    PRNo: prNo, Line: 10, MaterialID: 'M-001003', Description: 'Ball Bearing',
    Qty: 150, UOM: 'PC', ReqDate: seed_plusDays(7), Plant: '1000', SLoc: '0001',
    Status: 'Open', CreatedOn: today, CreatedBy: by
  });

  // --- Sales Order SO-020001 (fully delivered -> 'Delivered') ---
  const soNo = getNextNumber('SO'); // -> 'SO-020001'
  const soLines = [
    { line: 10, materialId: 'M-001004', description: 'Gear Box Assembly', qty: 10,  uom: 'PC', price: 1650 },
    { line: 20, materialId: 'M-001005', description: 'Packing Box',       qty: 100, uom: 'PC', price: 60 }
  ];
  soLines.forEach(l => up_appendRow('SalesOrders', {
    SONo: soNo, Line: l.line, CustomerID: 'C-003001', MaterialID: l.materialId,
    Description: l.description, Qty: l.qty, UOM: l.uom, NetPrice: l.price, Currency: 'PKR',
    ReqDelDate: seed_plusDays(10), Plant: '1000', SLoc: '0002',
    Status: 'Open', DeliveredQty: 0, CreatedOn: today
  }));

  const dnNo = getNextNumber('DN'); // -> '8000000001'
  soLines.forEach(l => {
    postStockMovement({
      materialId: l.materialId, plant: '1000', sloc: '0002',
      qtyChange: -l.qty, movementType: '601', docType: 'DN', docNo: dnNo,
      createdBy: by
    });
    up_appendRow('Deliveries', {
      DelNo: dnNo, DocDate: today, SONo: soNo, SOLine: l.line, MaterialID: l.materialId,
      Qty: l.qty, UOM: l.uom, Plant: '1000', SLoc: '0002',
      MovementType: '601', Status: 'Posted', CreatedBy: by
    });
    const idx = seed_findRow('SalesOrders', { SONo: soNo, Line: l.line });
    seed_patchRow('SalesOrders', idx, { DeliveredQty: l.qty, Status: 'Delivered' });
  });

  // --- Vendor invoice 5100000001 against PO1/GR1 (Posted) ---
  const invNo = getNextNumber('INV'); // -> '5100000001'
  up_appendRow('VendorInvoices', {
    InvNo: invNo, DocDate: today, PONo: po1, GRNo: gr1, VendorID: 'V-002001',
    GrossAmount: 375000, TaxAmount: 0, Currency: 'PKR', Status: 'Posted', CreatedBy: by
  });

  // --- Reservation RS-005001 (Open) ---
  const resNo = getNextNumber('RES'); // -> 'RS-005001'
  up_appendRow('Reservations', {
    ResNo: resNo, MaterialID: 'M-001001', Qty: 100, UOM: 'KG',
    Plant: '1000', SLoc: '0001', ReqDate: seed_plusDays(3), Status: 'Open', CreatedOn: today
  });

  // Advance manual-ID ranges past the demo IDs so future auto-numbering never collides.
  [['MAT', 1005], ['VND', 2002], ['CUST', 3002]].forEach(pair => {
    const idx = up_findRowIndex('NumberRanges', 'DocType', pair[0]);
    const rows = up_readAll('NumberRanges');
    const row = rows.find(r => String(r.DocType) === pair[0]);
    up_updateRow('NumberRanges', idx, {
      DocType: row.DocType, Prefix: row.Prefix, LastNumber: pair[1],
      PadLength: row.PadLength, Description: row.Description
    });
  });

  return {
    ok: true,
    message: 'Demo data loaded',
    counts: {
      materials: 5, vendors: 2, customers: 2,
      purchaseOrders: 2, goodsReceipts: 3, purchaseRequisitions: 1,
      salesOrders: 1, deliveries: 2, vendorInvoices: 1, reservations: 1
    },
    documents: { po1: po1, po2: po2, gr1: gr1, grInit: grInit, prNo: prNo, soNo: soNo, dnNo: dnNo, invNo: invNo, resNo: resNo }
  };
}

/* ---------------------------------------------------------------------------
 * resetDatabase(): clears every sheet except Config (headers kept).
 * ------------------------------------------------------------------------- */
function resetDatabase() {
  Object.keys(SCHEMA).forEach(name => {
    if (name === 'Config') return;
    const sh = up_getSS().getSheetByName(name);
    if (!sh) return;
    const lastRow = sh.getLastRow();
    const lastCol = sh.getLastColumn();
    if (lastRow > 1 && lastCol > 0) {
      sh.getRange(2, 1, lastRow - 1, lastCol).clearContent();
    }
  });
  return { ok: true, message: 'All data cleared (Config preserved). Run Seed Demo Data to reload.' };
}

/* ---------------------------------------------------------------------------
 * getSetupStatus(): health check for the UI setup screen.
 * ------------------------------------------------------------------------- */
function getSetupStatus() {
  let initialized = false;
  try {
    up_getSheet('Materials');
    const headers = up_getHeaders('Materials');
    initialized = headers.length > 0 && String(headers[0]) === 'MaterialID';
  } catch (e) {
    initialized = false;
  }

  const counts = {};
  Object.keys(SCHEMA).forEach(name => {
    try {
      counts[name] = up_readAll(name).length;
    } catch (e) {
      counts[name] = 0;
    }
  });

  return {
    initialized: initialized,
    counts: counts,
    company: up_getConfig('CompanyName', ''),
    currency: up_getConfig('Currency', '')
  };
}
