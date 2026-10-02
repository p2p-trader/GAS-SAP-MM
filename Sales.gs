/* =========================================================================
 * Sales.gs — Sales & distribution backend (SAP MM-style).
 *
 * Sheets used: SalesOrders, Deliveries, Customers, Vendors, PurchaseOrders,
 *              VendorInvoices, Materials (via up_materialById).
 *
 * Helpers used from Utils.gs: up_readAll, up_appendRow, up_updateRow,
 * up_require, up_round2, up_today, up_materialById, up_createdBy,
 * getNextNumber, postStockMovement.
 * ========================================================================= */

/** Local date normalizer: Date/string -> 'yyyy-MM-dd'. */
function sal_fmtDate_(v) {
  if (v === null || v === undefined || v === '') return '';
  var d = (v instanceof Date) ? v : new Date(v);
  if (isNaN(d.getTime())) return '';
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/** Find first row matching predicate. Returns {sheetRow, row} or null. */
function sal_findRow_(name, pred) {
  var rows = up_readAll(name);
  for (var i = 0; i < rows.length; i++) {
    if (pred(rows[i])) return { sheetRow: i + 2, row: rows[i] };
  }
  return null;
}

/** All lines of one sales order. */
function sal_readSOLines_(soNo) {
  return up_readAll('SalesOrders').filter(function (l) { return l.SONo === soNo; });
}

/** Derived header status from line statuses. */
function sal_soStatus_(lines) {
  var anyOpen = lines.some(function (l) { return l.Status === 'Open'; });
  var anyPartial = lines.some(function (l) { return l.Status === 'Partial'; });
  return anyOpen ? 'Open' : (anyPartial ? 'Partial' : 'Delivered');
}

/**
 * Sales order header aggregates. f = {status?, customerId?, from?, to?}.
 * Newest first.
 */
function sal_listSOs(f) {
  f = f || {};
  var custName = {};
  up_readAll('Customers').forEach(function (c) { custName[c.CustomerID] = c.Name; });
  var groups = {};
  up_readAll('SalesOrders').forEach(function (l) {
    var g = groups[l.SONo];
    if (!g) {
      g = groups[l.SONo] = {
        soNo: l.SONo,
        customerId: l.CustomerID,
        currency: l.Currency,
        lineCount: 0,
        totalQty: 0,
        totalValue: 0,
        lines: [],
        reqDelDate: '',
        createdOn: sal_fmtDate_(l.CreatedOn)
      };
    }
    g.lines.push(l);
    g.lineCount++;
    g.totalQty += Number(l.Qty) || 0;
    g.totalValue += (Number(l.Qty) || 0) * (Number(l.NetPrice) || 0);
    var rdd = sal_fmtDate_(l.ReqDelDate);
    if (rdd && rdd > g.reqDelDate) g.reqDelDate = rdd;
  });
  var out = [];
  Object.keys(groups).forEach(function (k) {
    var g = groups[k];
    var status = sal_soStatus_(g.lines);
    if (f.status && status !== f.status) return;
    if (f.customerId && g.customerId !== f.customerId) return;
    if (f.from && g.createdOn < f.from) return;
    if (f.to && g.createdOn > f.to) return;
    out.push({
      soNo: g.soNo,
      customerId: g.customerId,
      customerName: custName[g.customerId] || '',
      currency: g.currency,
      lines: g.lineCount,
      totalQty: g.totalQty,
      totalValue: up_round2(g.totalValue),
      status: status,
      reqDelDate: g.reqDelDate,
      createdOn: g.createdOn
    });
  });
  out.sort(function (a, b) { return a.soNo < b.soNo ? 1 : -1; });
  return out;
}

/**
 * Create a sales order. Lines numbered 10, 20, ... Status 'Open'.
 * d = {customerId, currency?, lines:[{materialId, qty, netPrice, reqDelDate?, plant, sloc}]}
 */
function sal_createSO(d) {
  d = d || {};
  up_require(d, ['customerId', 'lines']);
  if (!Array.isArray(d.lines) || d.lines.length === 0) {
    throw new Error('lines must be a non-empty array');
  }
  var custOk = up_readAll('Customers').some(function (c) { return c.CustomerID === d.customerId; });
  if (!custOk) throw new Error('Customer not found: ' + d.customerId);
  var mats = {};
  d.lines.forEach(function (l, i) {
    up_require(l, ['materialId', 'qty', 'netPrice', 'plant', 'sloc']);
    if (!(Number(l.qty) > 0)) throw new Error('Line ' + (i + 1) + ': qty must be > 0');
    if (!(Number(l.netPrice) >= 0)) throw new Error('Line ' + (i + 1) + ': netPrice must be >= 0');
    var m = up_materialById(l.materialId);
    if (!m) throw new Error('Line ' + (i + 1) + ': Material not found: ' + l.materialId);
    mats[l.materialId] = m;
  });

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var soNo = getNextNumber('SO');
    var today = up_today();
    var currency = d.currency || 'PKR';
    d.lines.forEach(function (l, i) {
      var m = mats[l.materialId];
      up_appendRow('SalesOrders', {
        SONo: soNo,
        Line: (i + 1) * 10,
        CustomerID: d.customerId,
        MaterialID: l.materialId,
        Description: l.description || m.Description || '',
        Qty: Number(l.qty),
        UOM: m.BaseUOM,
        NetPrice: Number(l.netPrice),
        Currency: currency,
        ReqDelDate: l.reqDelDate || today,
        Plant: l.plant,
        SLoc: l.sloc,
        Status: 'Open',
        DeliveredQty: 0,
        CreatedOn: today
      });
    });
    return { ok: true, soNo: soNo };
  } finally {
    lock.releaseLock();
  }
}

/** Full sales order: {header, lines:[with openQty]}. Throws if missing. */
function sal_getSO(soNo) {
  if (!soNo) throw new Error('soNo is required');
  var lines = sal_readSOLines_(soNo);
  if (lines.length === 0) throw new Error('Sales order not found: ' + soNo);
  var custName = '';
  var cust = up_readAll('Customers').filter(function (c) { return c.CustomerID === lines[0].CustomerID; })[0];
  if (cust) custName = cust.Name || '';
  var totalValue = 0, totalQty = 0, reqDelDate = '';
  lines.forEach(function (l) {
    totalQty += Number(l.Qty) || 0;
    totalValue += (Number(l.Qty) || 0) * (Number(l.NetPrice) || 0);
    var rdd = sal_fmtDate_(l.ReqDelDate);
    if (rdd && rdd > reqDelDate) reqDelDate = rdd;
  });
  var header = {
    soNo: soNo,
    customerId: lines[0].CustomerID,
    customerName: custName,
    currency: lines[0].Currency,
    lines: lines.length,
    totalQty: totalQty,
    totalValue: up_round2(totalValue),
    status: sal_soStatus_(lines),
    reqDelDate: reqDelDate,
    createdOn: sal_fmtDate_(lines[0].CreatedOn)
  };
  var detail = lines.map(function (l) {
    var qty = Number(l.Qty) || 0;
    var del = Number(l.DeliveredQty) || 0;
    return {
      soNo: l.SONo,
      line: Number(l.Line),
      customerId: l.CustomerID,
      materialId: l.MaterialID,
      description: l.Description || '',
      qty: qty,
      uom: l.UOM || '',
      netPrice: Number(l.NetPrice) || 0,
      currency: l.Currency,
      reqDelDate: sal_fmtDate_(l.ReqDelDate),
      plant: l.Plant,
      sloc: l.SLoc,
      status: l.Status,
      deliveredQty: del,
      openQty: qty - del,
      createdOn: sal_fmtDate_(l.CreatedOn)
    };
  });
  detail.sort(function (a, b) { return a.line - b.line; });
  return { header: header, lines: detail };
}

/**
 * Post a delivery against a sales order (goods issue, movement type 601).
 * d = {soNo, postingDate?, lines:[{line, qty}]}
 * Atomicity relies on postStockMovement's internal locking (no extra lock here).
 */
function sal_postDelivery(d) {
  d = d || {};
  up_require(d, ['soNo', 'lines']);
  if (!Array.isArray(d.lines) || d.lines.length === 0) {
    throw new Error('lines must be a non-empty array');
  }
  var soNo = d.soNo;
  var soLines = sal_readSOLines_(soNo);
  if (soLines.length === 0) throw new Error('Sales order not found: ' + soNo);
  var byLine = {};
  soLines.forEach(function (l) { byLine[Number(l.Line)] = l; });

  // Validate everything before posting anything.
  d.lines.forEach(function (item) {
    up_require(item, ['line', 'qty']);
    var ln = byLine[Number(item.line)];
    if (!ln) throw new Error('Line ' + item.line + ' not found on SO ' + soNo);
    var qty = Number(item.qty);
    if (!(qty > 0)) throw new Error('Line ' + item.line + ': qty must be > 0');
    var already = Number(ln.DeliveredQty) || 0;
    if (already + qty > (Number(ln.Qty) || 0)) {
      throw new Error('Over-delivery on line ' + item.line);
    }
  });

  var delNo = getNextNumber('DN');
  var today = up_today();
  var createdBy = up_createdBy();
  d.lines.forEach(function (item) {
    var ln = byLine[Number(item.line)];
    var qty = Number(item.qty);
    var m = up_materialById(ln.MaterialID);
    var r = postStockMovement({
      materialId: ln.MaterialID,
      plant: ln.Plant,
      sloc: ln.SLoc,
      qtyChange: -qty,
      movementType: '601',
      docType: 'DN',
      docNo: delNo,
      createdBy: createdBy
    });
    up_appendRow('Deliveries', {
      DelNo: delNo,
      DocDate: today,
      SONo: soNo,
      SOLine: Number(item.line),
      MaterialID: ln.MaterialID,
      Qty: qty,
      UOM: ln.UOM || (m && m.BaseUOM) || '',
      Plant: ln.Plant,
      SLoc: ln.SLoc,
      MovementType: '601',
      Status: 'Posted',
      CreatedBy: createdBy
    });
    var newDel = (Number(ln.DeliveredQty) || 0) + qty;
    var newStatus = newDel >= (Number(ln.Qty) || 0) ? 'Delivered' : 'Partial';
    var hit = sal_findRow_('SalesOrders', function (x) {
      return x.SONo === soNo && Number(x.Line) === Number(item.line);
    });
    if (!hit) throw new Error('Line ' + item.line + ' not found on SO ' + soNo);
    up_updateRow('SalesOrders', hit.sheetRow, { DeliveredQty: newDel, Status: newStatus });
  });
  return { ok: true, delNo: delNo };
}

/** List deliveries. f = {soNo?, materialId?, from?, to?}. Newest first. */
function sal_listDeliveries(f) {
  f = f || {};
  return up_readAll('Deliveries')
    .filter(function (r) {
      if (f.soNo && r.SONo !== f.soNo) return false;
      if (f.materialId && r.MaterialID !== f.materialId) return false;
      if (f.from && sal_fmtDate_(r.DocDate) < f.from) return false;
      if (f.to && sal_fmtDate_(r.DocDate) > f.to) return false;
      return true;
    })
    .reverse()
    .map(function (r) {
      return {
        delNo: r.DelNo,
        docDate: sal_fmtDate_(r.DocDate),
        soNo: r.SONo,
        soLine: Number(r.SOLine),
        materialId: r.MaterialID,
        qty: Number(r.Qty) || 0,
        uom: r.UOM || '',
        plant: r.Plant,
        sloc: r.SLoc,
        movementType: r.MovementType,
        status: r.Status,
        createdBy: r.CreatedBy || ''
      };
    });
}

/**
 * Post a vendor invoice against a purchase order (logistics invoice verification).
 * d = {poNo, grNo?, vendorId, grossAmount, taxAmount?, currency?, docDate?}
 */
function sal_postInvoice(d) {
  d = d || {};
  up_require(d, ['poNo', 'vendorId', 'grossAmount']);
  var gross = Number(d.grossAmount);
  if (!(gross > 0)) throw new Error('grossAmount must be > 0');
  var poLines = up_readAll('PurchaseOrders').filter(function (l) { return l.PONo === d.poNo; });
  if (poLines.length === 0) throw new Error('Purchase order not found: ' + d.poNo);
  if (poLines[0].VendorID !== d.vendorId) throw new Error('Vendor mismatch');

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var invNo = getNextNumber('INV');
    up_appendRow('VendorInvoices', {
      InvNo: invNo,
      DocDate: d.docDate || up_today(),
      PONo: d.poNo,
      GRNo: d.grNo || '',
      VendorID: d.vendorId,
      GrossAmount: gross,
      TaxAmount: Number(d.taxAmount) || 0,
      Currency: d.currency || 'PKR',
      Status: 'Posted',
      CreatedBy: up_createdBy()
    });
    return { ok: true, invNo: invNo };
  } finally {
    lock.releaseLock();
  }
}

/** All vendor invoices, newest first, enriched with vendorName. */
function sal_listInvoices() {
  var vendName = {};
  up_readAll('Vendors').forEach(function (v) { vendName[v.VendorID] = v.Name; });
  return up_readAll('VendorInvoices')
    .reverse()
    .map(function (r) {
      return {
        invNo: r.InvNo,
        docDate: sal_fmtDate_(r.DocDate),
        poNo: r.PONo,
        grNo: r.GRNo || '',
        vendorId: r.VendorID,
        vendorName: vendName[r.VendorID] || '',
        grossAmount: up_round2(Number(r.GrossAmount) || 0),
        taxAmount: up_round2(Number(r.TaxAmount) || 0),
        currency: r.Currency,
        status: r.Status,
        createdBy: r.CreatedBy || ''
      };
    });
}

/** Mark an invoice Posted -> Paid. */
function sal_markInvoicePaid(invNo) {
  if (!invNo) throw new Error('invNo is required');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var hit = sal_findRow_('VendorInvoices', function (x) { return x.InvNo === invNo; });
    if (!hit) throw new Error('Invoice not found: ' + invNo);
    if (hit.row.Status !== 'Posted') {
      throw new Error('Only Posted invoices can be marked paid');
    }
    up_updateRow('VendorInvoices', hit.sheetRow, { Status: 'Paid' });
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}
