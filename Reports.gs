/* =========================================================================
 * Reports.gs — Reporting & analytics backend (SAP MM-style).
 *
 * Sheets used: Materials, Vendors, Customers, PurchaseRequisitions,
 *              PurchaseOrders, SalesOrders, Stock, StockLedger.
 *
 * Helpers used from Utils.gs: up_readAll, up_round2, up_today,
 * and inv_listStock (from InventoryMgmt.gs) for rep_lowStock.
 * ========================================================================= */

/** Local date normalizer: Date/string -> 'yyyy-MM-dd'. */
function rep_fmtDate_(v) {
  if (v === null || v === undefined || v === '') return '';
  var d = (v instanceof Date) ? v : new Date(v);
  if (isNaN(d.getTime())) return '';
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/** MaterialID -> material row lookup. */
function rep_materialMap_() {
  var byId = {};
  up_readAll('Materials').forEach(function (m) { byId[m.MaterialID] = m; });
  return byId;
}

/** Dashboard KPIs + recent movements. */
function rep_dashboardStats() {
  var mats = up_readAll('Materials');
  var byId = rep_materialMap_();
  var openPRs = {}, openPOs = {}, openSOs = {};
  up_readAll('PurchaseRequisitions').forEach(function (l) {
    if (l.Status === 'Open') openPRs[l.PRNo] = 1;
  });
  up_readAll('PurchaseOrders').forEach(function (l) {
    if (l.Status === 'Open' || l.Status === 'Partial') openPOs[l.PONo] = 1;
  });
  up_readAll('SalesOrders').forEach(function (l) {
    if (l.Status === 'Open' || l.Status === 'Partial') openSOs[l.SONo] = 1;
  });
  var stockValue = 0, lowStock = 0;
  up_readAll('Stock').forEach(function (s) {
    stockValue += Number(s.StockValue) || 0;
    var m = byId[s.MaterialID];
    var rp = m ? (Number(m.ReorderPoint) || 0) : 0;
    if ((Number(s.Quantity) || 0) <= rp) lowStock++;
  });
  var recent = up_readAll('StockLedger').slice(-10).reverse().map(function (r) {
    var m = byId[r.MaterialID];
    return {
      ledgerId: r.LedgerID,
      timestamp: rep_fmtDate_(r.Timestamp),
      docType: r.DocType,
      docNo: r.DocNo,
      materialId: r.MaterialID,
      description: m ? (m.Description || '') : '',
      plant: r.Plant,
      sloc: r.SLoc,
      movementType: r.MovementType,
      qtyChange: Number(r.QtyChange) || 0,
      valueChange: up_round2(Number(r.ValueChange) || 0),
      newQty: Number(r.NewQty) || 0,
      createdBy: r.CreatedBy || ''
    };
  });
  return {
    materials: mats.length,
    vendors: up_readAll('Vendors').length,
    customers: up_readAll('Customers').length,
    openPRs: Object.keys(openPRs).length,
    openPOs: Object.keys(openPOs).length,
    openSOs: Object.keys(openSOs).length,
    stockValue: up_round2(stockValue),
    lowStock: lowStock,
    recentMovements: recent
  };
}

/**
 * Stock valuation: rows sorted by value desc + totalValue.
 * plant: optional plant filter.
 */
function rep_stockValuation(plant) {
  var byId = rep_materialMap_();
  var rows = [];
  up_readAll('Stock').forEach(function (s) {
    if (plant && s.Plant !== plant) return;
    var m = byId[s.MaterialID];
    if (!m) return;
    var qty = Number(s.Quantity) || 0;
    var map = Number(m.MovingAvgPrice) || 0;
    rows.push({
      materialId: s.MaterialID,
      description: m.Description || '',
      materialType: m.MaterialType || '',
      plant: s.Plant,
      sloc: s.SLoc,
      qty: qty,
      uom: m.BaseUOM || '',
      map: map,
      value: up_round2(qty * map)
    });
  });
  rows.sort(function (a, b) { return b.value - a.value; });
  var totalValue = rows.reduce(function (t, r) { return t + r.value; }, 0);
  return { rows: rows, totalValue: up_round2(totalValue) };
}

/**
 * Stock ledger movements. f = {from?, to?, materialId?, movementType?, docType?}.
 * Newest first, limited to 500 rows, enriched with description.
 */
function rep_movements(f) {
  f = f || {};
  var byId = rep_materialMap_();
  return up_readAll('StockLedger')
    .filter(function (r) {
      if (f.materialId && r.MaterialID !== f.materialId) return false;
      if (f.movementType && r.MovementType !== f.movementType) return false;
      if (f.docType && r.DocType !== f.docType) return false;
      if (f.from && rep_fmtDate_(r.Timestamp) < f.from) return false;
      if (f.to && rep_fmtDate_(r.Timestamp) > f.to) return false;
      return true;
    })
    .reverse()
    .slice(0, 500)
    .map(function (r) {
      var m = byId[r.MaterialID];
      return {
        ledgerId: r.LedgerID,
        timestamp: rep_fmtDate_(r.Timestamp),
        docType: r.DocType,
        docNo: r.DocNo,
        materialId: r.MaterialID,
        description: m ? (m.Description || '') : '',
        plant: r.Plant,
        sloc: r.SLoc,
        movementType: r.MovementType,
        qtyChange: Number(r.QtyChange) || 0,
        valueChange: up_round2(Number(r.ValueChange) || 0),
        newQty: Number(r.NewQty) || 0,
        newValue: up_round2(Number(r.NewValue) || 0),
        unitPrice: up_round2(Number(r.UnitPrice) || 0),
        createdBy: r.CreatedBy || ''
      };
    });
}

/** Open/Partial purchase orders as header aggregates with per-line openQty. */
function rep_openPOs() {
  var vendName = {};
  up_readAll('Vendors').forEach(function (v) { vendName[v.VendorID] = v.Name; });
  var groups = {};
  up_readAll('PurchaseOrders')
    .filter(function (l) { return l.Status === 'Open' || l.Status === 'Partial'; })
    .forEach(function (l) {
      if (!groups[l.PONo]) groups[l.PONo] = [];
      groups[l.PONo].push(l);
    });
  var out = Object.keys(groups).map(function (poNo) {
    var ls = groups[poNo];
    var first = ls[0];
    var totalValue = 0;
    var detail = ls.map(function (l) {
      var qty = Number(l.Qty) || 0;
      var rec = Number(l.ReceivedQty) || 0;
      totalValue += qty * (Number(l.NetPrice) || 0);
      return {
        line: Number(l.Line),
        materialId: l.MaterialID,
        description: l.Description || '',
        qty: qty,
        receivedQty: rec,
        openQty: qty - rec,
        uom: l.UOM || '',
        netPrice: Number(l.NetPrice) || 0,
        deliveryDate: rep_fmtDate_(l.DeliveryDate),
        plant: l.Plant,
        sloc: l.SLoc,
        status: l.Status
      };
    });
    detail.sort(function (a, b) { return a.line - b.line; });
    var status = ls.some(function (l) { return l.Status === 'Open'; }) ? 'Open' : 'Partial';
    return {
      poNo: poNo,
      vendorId: first.VendorID,
      vendorName: vendName[first.VendorID] || '',
      currency: first.Currency,
      status: status,
      totalValue: up_round2(totalValue),
      lines: detail,
      createdOn: rep_fmtDate_(first.CreatedOn)
    };
  });
  out.sort(function (a, b) { return a.poNo < b.poNo ? 1 : -1; });
  return out;
}

/** Open purchase requisition lines, enriched with material description. */
function rep_openPRs() {
  var byId = rep_materialMap_();
  return up_readAll('PurchaseRequisitions')
    .filter(function (l) { return l.Status === 'Open'; })
    .map(function (l) {
      var m = byId[l.MaterialID];
      return {
        prNo: l.PRNo,
        line: Number(l.Line),
        materialId: l.MaterialID,
        description: (m && m.Description) || l.Description || '',
        qty: Number(l.Qty) || 0,
        uom: l.UOM || '',
        reqDate: rep_fmtDate_(l.ReqDate),
        plant: l.Plant,
        sloc: l.SLoc,
        status: l.Status,
        createdOn: rep_fmtDate_(l.CreatedOn)
      };
    });
}

/**
 * ABC analysis on stock value (qty * moving avg price).
 * class: cumPct <= 80 -> 'A', <= 95 -> 'B', else 'C'.
 */
function rep_abc() {
  var byId = rep_materialMap_();
  var rows = [];
  up_readAll('Stock').forEach(function (s) {
    var m = byId[s.MaterialID];
    if (!m) return;
    var qty = Number(s.Quantity) || 0;
    var map = Number(m.MovingAvgPrice) || 0;
    rows.push({
      materialId: s.MaterialID,
      description: m.Description || '',
      qty: qty,
      uom: m.BaseUOM || '',
      map: map,
      value: up_round2(qty * map)
    });
  });
  rows.sort(function (a, b) { return b.value - a.value; });
  var total = rows.reduce(function (t, r) { return t + r.value; }, 0);
  var cum = 0;
  var counts = { A: 0, B: 0, C: 0 };
  rows.forEach(function (r) {
    cum += r.value;
    var pct = total > 0 ? (cum / total) * 100 : 0;
    r.cumPct = up_round2(pct);
    r.class = pct <= 80 ? 'A' : (pct <= 95 ? 'B' : 'C');
    counts[r.class]++;
  });
  return { rows: rows, totalValue: up_round2(total), counts: counts };
}

/** Low-stock report: same as inv_listStock({lowStockOnly:true}). */
function rep_lowStock() {
  return inv_listStock({ lowStockOnly: true });
}

/** Comprehensive inventory health & valuation analytics. */
function rep_inventoryHealth() {
  var stock = up_readAll('Stock');
  var byId = rep_materialMap_();
  
  var totalVal = 0;
  var valByType = {};
  var stockStatus = { normal: 0, low: 0, critical: 0 };
  var topValued = [];

  stock.forEach(function (s) {
    var m = byId[s.MaterialID];
    if (!m) return;
    var qty = Number(s.Quantity) || 0;
    var map = Number(m.MovingAvgPrice) || 0;
    var val = up_round2(qty * map);
    var rp = Number(m.ReorderPoint) || 0;
    var type = m.MaterialType || 'OTHER';

    totalVal += val;
    valByType[type] = up_round2((valByType[type] || 0) + val);

    if (qty <= 0) stockStatus.critical++;
    else if (qty <= rp) stockStatus.low++;
    else stockStatus.normal++;

    topValued.push({
      materialId: s.MaterialID,
      description: m.Description || '',
      type: type,
      qty: qty,
      uom: m.BaseUOM || 'PC',
      value: val
    });
  });

  topValued.sort(function (a, b) { return b.value - a.value; });

  return {
    totalValue: up_round2(totalVal),
    valuationByType: valByType,
    stockStatus: stockStatus,
    topItems: topValued.slice(0, 5)
  };
}

/**
 * Slow-moving and stagnant inventory report (SAP MM MC46).
 * Analyzes materials with positive stock but no consumption (GI 201/261 or Delivery 601)
 * within `thresholdDays` (defaults to 60 days).
 */
function rep_slowMovingStock(thresholdDays) {
  thresholdDays = Number(thresholdDays) || 60;
  var cutoff = new Date(new Date().getTime() - thresholdDays * 24 * 60 * 60 * 1000);
  var cutoffStr = Utilities.formatDate(cutoff, Session.getScriptTimeZone(), 'yyyy-MM-dd');

  var byId = rep_materialMap_();
  var stock = up_readAll('Stock');
  var ledger = up_readAll('StockLedger');

  // Find latest issue timestamp per material
  var lastIssueDate = {};
  ledger.forEach(function (l) {
    var mt = String(l.MovementType);
    if (mt === '201' || mt === '261' || mt === '601') {
      var ts = rep_fmtDate_(l.Timestamp);
      if (!lastIssueDate[l.MaterialID] || ts > lastIssueDate[l.MaterialID]) {
        lastIssueDate[l.MaterialID] = ts;
      }
    }
  });

  var rows = [];
  var totalSlowValue = 0;
  var today = new Date();

  stock.forEach(function (s) {
    var qty = Number(s.Quantity) || 0;
    if (qty <= 0) return;
    var m = byId[s.MaterialID];
    if (!m) return;
    var map = Number(m.MovingAvgPrice) || 0;
    var val = up_round2(qty * map);
    var lastDate = lastIssueDate[s.MaterialID] || '';

    // Check if idle longer than thresholdDays or never issued
    var isSlow = false;
    var daysIdle = 999;
    if (!lastDate) {
      isSlow = true;
      daysIdle = 999;
    } else {
      var diffMs = today.getTime() - new Date(lastDate).getTime();
      daysIdle = Math.floor(diffMs / (24 * 60 * 60 * 1000));
      if (daysIdle >= thresholdDays) isSlow = true;
    }

    if (isSlow) {
      totalSlowValue += val;
      rows.push({
        materialId: s.MaterialID,
        description: m.Description || '',
        materialType: m.MaterialType || '',
        plant: s.Plant,
        sloc: s.SLoc,
        qty: qty,
        uom: m.BaseUOM || '',
        map: map,
        value: val,
        lastIssueDate: lastDate || 'Never',
        daysIdle: daysIdle === 999 ? 'No recorded issue' : daysIdle
      });
    }
  });

  rows.sort(function (a, b) { return b.value - a.value; });
  return {
    rows: rows,
    totalSlowValue: up_round2(totalSlowValue),
    thresholdDays: thresholdDays
  };
}

/**
 * Vendor spend and procurement performance analysis.
 * Aggregates PO spend, PO count, delivered vs open amounts.
 */
function rep_vendorSpendAnalysis() {
  var vendors = up_readAll('Vendors');
  var pos = up_readAll('PurchaseOrders');
  var invs = up_readAll('VendorInvoices');

  var spendByVend = {};
  vendors.forEach(function (v) {
    spendByVend[v.VendorID] = {
      vendorId: v.VendorID,
      vendorName: v.Name || '',
      city: v.City || '',
      currency: v.Currency || 'PKR',
      poCount: 0,
      totalPoValue: 0,
      invoicedValue: 0,
      paidValue: 0
    };
  });

  var countedPOs = {};
  pos.forEach(function (p) {
    var v = spendByVend[p.VendorID];
    if (!v) return;
    if (!countedPOs[p.PONo]) {
      countedPOs[p.PONo] = true;
      v.poCount++;
    }
    var lineVal = (Number(p.Qty) || 0) * (Number(p.NetPrice) || 0);
    v.totalPoValue += lineVal;
  });

  invs.forEach(function (inv) {
    var v = spendByVend[inv.VendorID];
    if (!v) return;
    var gross = Number(inv.GrossAmount) || 0;
    v.invoicedValue += gross;
    if (inv.Status === 'Paid') {
      v.paidValue += gross;
    }
  });

  var rows = Object.keys(spendByVend).map(function (k) {
    var r = spendByVend[k];
    r.totalPoValue = up_round2(r.totalPoValue);
    r.invoicedValue = up_round2(r.invoicedValue);
    r.paidValue = up_round2(r.paidValue);
    return r;
  }).filter(function (r) {
    return r.poCount > 0 || r.invoicedValue > 0;
  });

  rows.sort(function (a, b) { return b.totalPoValue - a.totalPoValue; });
  return { rows: rows };
}

/**
 * Stock Ledger Audit & Integrity Check.
 * Verifies that the Stock sheet balances equal the cumulative sum of StockLedger QtyChange.
 */
function rep_auditStockLedger() {
  var stock = up_readAll('Stock');
  var ledger = up_readAll('StockLedger');
  var byId = rep_materialMap_();

  // Ledger cumulative sum per material+plant+sloc
  var ledgerSums = {};
  ledger.forEach(function (l) {
    var key = l.MaterialID + '|' + l.Plant + '|' + l.SLoc;
    ledgerSums[key] = (ledgerSums[key] || 0) + (Number(l.QtyChange) || 0);
  });

  var results = [];
  var hasDiscrepancy = false;
  var processedKeys = {};

  stock.forEach(function (s) {
    var key = s.MaterialID + '|' + s.Plant + '|' + s.SLoc;
    processedKeys[key] = true;
    var stockQty = up_round3(Number(s.Quantity) || 0);
    var ledgerQty = up_round3(ledgerSums[key] || 0);
    var diff = up_round3(stockQty - ledgerQty);
    var m = byId[s.MaterialID];
    var isMatch = Math.abs(diff) < 0.0001;
    if (!isMatch) hasDiscrepancy = true;

    results.push({
      materialId: s.MaterialID,
      description: m ? (m.Description || '') : '',
      plant: s.Plant,
      sloc: s.SLoc,
      stockQty: stockQty,
      ledgerQty: ledgerQty,
      diff: diff,
      status: isMatch ? 'VERIFIED' : 'DISCREPANCY'
    });
  });

  // Check if any ledger keys exist with no stock row
  Object.keys(ledgerSums).forEach(function (key) {
    if (!processedKeys[key]) {
      hasDiscrepancy = true;
      var parts = key.split('|');
      var m = byId[parts[0]];
      results.push({
        materialId: parts[0],
        description: m ? (m.Description || '') : '',
        plant: parts[1],
        sloc: parts[2],
        stockQty: 0,
        ledgerQty: up_round3(ledgerSums[key]),
        diff: up_round3(0 - ledgerSums[key]),
        status: 'DISCREPANCY'
      });
    }
  });

  return {
    verified: !hasDiscrepancy,
    totalChecked: results.length,
    discrepancyCount: results.filter(function (r) { return r.status === 'DISCREPANCY'; }).length,
    rows: results
  };
}

/**
 * Reconciles and synchronizes the Stock table with the ground-truth StockLedger.
 */
function rep_reconcileAndFixStock() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var audit = rep_auditStockLedger();
    if (audit.verified) {
      return { ok: true, message: 'Stock is already 100% consistent with ledger.', fixedCount: 0 };
    }

    var byId = rep_materialMap_();
    var fixedCount = 0;

    audit.rows.filter(function (r) { return r.status === 'DISCREPANCY'; }).forEach(function (d) {
      var m = byId[d.materialId];
      var map = m ? (Number(m.MovingAvgPrice) || Number(m.StdPrice) || 0) : 0;
      var newQty = d.ledgerQty;
      var newVal = up_round2(newQty * map);

      var stockSh = up_getSheet('Stock');
      var stockIdx = -1;
      var stockVals = stockSh.getDataRange().getValues();
      var hdr = stockVals[0];
      var cM = hdr.indexOf('MaterialID'), cP = hdr.indexOf('Plant'), cS = hdr.indexOf('SLoc');

      for (var r = 1; r < stockVals.length; r++) {
        if (String(stockVals[r][cM]) === String(d.materialId) &&
            String(stockVals[r][cP]) === String(d.plant) &&
            String(stockVals[r][cS]) === String(d.sloc)) {
          stockIdx = r + 1;
          break;
        }
      }

      if (stockIdx !== -1) {
        up_updateRow('Stock', stockIdx, { Quantity: newQty, StockValue: newVal });
      } else {
        up_appendRow('Stock', {
          MaterialID: d.materialId,
          Plant: d.plant,
          SLoc: d.sloc,
          Quantity: newQty,
          StockValue: newVal
        });
      }
      fixedCount++;
    });

    return { ok: true, message: 'Successfully reconciled ' + fixedCount + ' stock balances.', fixedCount: fixedCount };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Exports a generated report directly as a formatted tab in the Google Spreadsheet.
 * reportType: 'ABC' | 'LOW_STOCK' | 'VALUATION' | 'AUDIT'
 */
function rep_exportReportToSheet(reportType) {
  var ss = up_getSS();
  var sheetName = 'Report_' + (reportType || 'EXPORT').toUpperCase();
  var sh = ss.getSheetByName(sheetName);
  if (sh) {
    sh.clear();
  } else {
    sh = ss.insertSheet(sheetName);
  }

  var today = up_today();
  var headers = [];
  var data = [];

  if (reportType === 'ABC') {
    var abc = rep_abc();
    headers = ['Material ID', 'Description', 'Current Stock', 'UOM', 'Moving Avg Price', 'Stock Value', 'Cum %', 'ABC Class'];
    data = abc.rows.map(function (r) {
      return [r.materialId, r.description, r.qty, r.uom, r.map, r.value, r.cumPct + '%', r.class];
    });
  } else if (reportType === 'LOW_STOCK') {
    var low = rep_lowStock();
    headers = ['Material ID', 'Description', 'Plant', 'Storage Location', 'Current Qty', 'Reorder Point', 'Base UOM', 'Moving Avg Price', 'Stock Value'];
    data = low.map(function (r) {
      return [r.materialId, r.description, r.plant, r.sloc, r.qty, r.reorderPoint, r.uom, r.map, r.value];
    });
  } else if (reportType === 'AUDIT') {
    var audit = rep_auditStockLedger();
    headers = ['Material ID', 'Description', 'Plant', 'SLoc', 'Stock Qty', 'Ledger Qty', 'Difference', 'Audit Status'];
    data = audit.rows.map(function (r) {
      return [r.materialId, r.description, r.plant, r.sloc, r.stockQty, r.ledgerQty, r.diff, r.status];
    });
  } else {
    var val = rep_stockValuation();
    headers = ['Material ID', 'Description', 'Material Type', 'Plant', 'SLoc', 'Quantity', 'UOM', 'Moving Avg Price', 'Stock Value'];
    data = val.rows.map(function (r) {
      return [r.materialId, r.description, r.materialType, r.plant, r.sloc, r.qty, r.uom, r.map, r.value];
    });
  }

  // Title row + timestamp
  sh.getRange(1, 1).setValue('ERP·MM — ' + sheetName.replace('_', ' '));
  sh.getRange(1, 1).setFontSize(14).setFontWeight('bold');
  sh.getRange(2, 1).setValue('Generated: ' + today + ' by ' + up_createdBy());
  sh.getRange(2, 1).setFontStyle('italic').setFontColor('#555555');

  // Header row
  if (headers.length > 0) {
    sh.getRange(4, 1, 1, headers.length).setValues([headers]);
    sh.getRange(4, 1, 1, headers.length)
      .setBackground('#12294d')
      .setFontColor('#ffffff')
      .setFontWeight('bold');
  }

  // Data rows
  if (data.length > 0) {
    sh.getRange(5, 1, data.length, headers.length).setValues(data);
  }

  // Auto-resize
  for (var c = 1; c <= headers.length; c++) {
    sh.autoResizeColumn(c);
  }

  return { ok: true, sheetName: sheetName, rowCount: data.length };
}

/**
 * Sends a low-stock digest alert email to targetEmail (or current user).
 */
function alert_sendLowStockDigest(targetEmail) {
  var recipient = targetEmail || up_createdBy();
  if (!recipient || recipient === 'system') {
    recipient = Session.getActiveUser().getEmail();
  }
  if (!recipient) {
    throw new Error('No valid recipient email available. Please provide targetEmail.');
  }

  var low = rep_lowStock();
  var company = up_getConfig('CompanyName', 'Acme Corporation');
  var currency = up_getConfig('Currency', 'PKR');
  var subject = '⚠️ [' + company + ' ERP] Low Stock Inventory Alert (' + low.length + ' Items)';

  if (low.length === 0) {
    var body = 'Good news! All materials in inventory are currently above their reorder points as of ' + up_today() + '.';
    MailApp.sendEmail(recipient, subject, body);
    return { ok: true, sentTo: recipient, count: 0 };
  }

  var htmlTable = '<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;border-color:#d7e0ea;">' +
    '<tr style="background:#12294d;color:#fff;text-align:left;">' +
    '<th>Material ID</th><th>Description</th><th>Plant</th><th>SLoc</th><th>Current Qty</th><th>Reorder Point</th><th>UOM</th><th>Shortage</th></tr>';

  low.forEach(function (r) {
    var shortage = Math.max(0, (Number(r.reorderPoint) || 0) - (Number(r.qty) || 0));
    htmlTable += '<tr>' +
      '<td><b>' + r.materialId + '</b></td>' +
      '<td>' + r.description + '</td>' +
      '<td>' + r.plant + '</td>' +
      '<td>' + r.sloc + '</td>' +
      '<td style="color:#c0392b;font-weight:bold;">' + r.qty + '</td>' +
      '<td>' + r.reorderPoint + '</td>' +
      '<td>' + r.uom + '</td>' +
      '<td style="color:#c0392b;font-weight:bold;">' + shortage + '</td></tr>';
  });
  htmlTable += '</table>';

  var htmlBody = '<div style="font-family:Arial,sans-serif;color:#1c2733;max-width:700px;">' +
    '<h2 style="color:#12294d;margin-bottom:4px;">' + company + ' &mdash; Materials Management</h2>' +
    '<p style="color:#666;font-size:12px;margin-top:0;">Inventory Alert &middot; ' + up_now() + '</p>' +
    '<p>The following <b>' + low.length + ' material(s)</b> have fallen to or below their configured reorder points and require replenishment:</p>' +
    htmlTable +
    '<p style="margin-top:20px;font-size:12px;color:#888;">Generated automatically by ERP&middot;MM on Google Apps Script.</p>' +
    '</div>';

  MailApp.sendEmail({
    to: recipient,
    subject: subject,
    htmlBody: htmlBody
  });

  return { ok: true, sentTo: recipient, count: low.length };
}
