/**
 * Purchasing.gs
 * ------------------------------------------------------------------
 * Procure-to-pay backend for the SAP MM-style ERP on Google Apps Script.
 *
 * Covers: purchase requisitions (PR), purchase orders (PO) and goods
 * receipts (GR, movement type 101). UI calls these via google.script.run.
 *
 * Conventions:
 *  - Batch reads, script lock on all multi-step writes (GR is atomic).
 *  - Line numbering on PRs/POs: 10, 20, 30, ...
 *  - Dates normalized to 'yyyy-MM-dd' strings via fmtDate_.
 */

/**
 * Local date formatter: '' for empty, 'yyyy-MM-dd' for Date objects,
 * strings passed through unchanged. (Duplicated per module on purpose.)
 */
function fmtDate_(v) {
  if (v === null || v === undefined || v === '') return '';
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime())) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(v);
}

/** Copy a sheet row object, formatting the given header fields as dates. */
function pur_normDates_(row, dateFields) {
  var out = {};
  for (var k in row) out[k] = row[k];
  dateFields.forEach(function (f) {
    if (f in out) out[f] = fmtDate_(out[f]);
  });
  return out;
}

/** Lookup helpers (batch reads; caller holds results where needed). */
function pur_plantExists_(plantId) {
  return up_readAll('Plants').some(function (p) {
    return String(p.PlantID) === String(plantId);
  });
}

function pur_slocExists_(plantId, slocId) {
  return up_readAll('StorageLocations').some(function (s) {
    return String(s.PlantID) === String(plantId) && String(s.SLocID) === String(slocId);
  });
}

function pur_vendorById_(vendorId) {
  var rows = up_readAll('Vendors');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].VendorID) === String(vendorId)) return rows[i];
  }
  return null;
}

function pur_materialById_(materialId) {
  var mat = null;
  try {
    mat = up_materialById(materialId);
  } catch (e) {
    mat = null;
  }
  if (!mat) throw new Error('Material ' + materialId + ' not found');
  return mat;
}

/** Validate a plant/sloc pair for a document line. */
function pur_assertPlantSLoc_(plant, sloc, label) {
  if (!pur_plantExists_(plant)) {
    throw new Error(label + ': plant ' + plant + ' not found.');
  }
  if (!pur_slocExists_(plant, sloc)) {
    throw new Error(label + ': storage location ' + sloc + ' not found for plant ' + plant + '.');
  }
}

/**
 * Aggregate "worst" header status from line statuses:
 * any Open -> 'Open'; else any Partial -> 'Partial';
 * else any Received -> 'Received'; else 'Closed'.
 */
function pur_worstStatus_(statuses) {
  if (statuses.indexOf('Open') !== -1) return 'Open';
  if (statuses.indexOf('Partial') !== -1) return 'Partial';
  if (statuses.indexOf('Received') !== -1) return 'Received';
  return 'Closed';
}

// ------------------------------------------------------------------
// Purchase Requisitions
// ------------------------------------------------------------------

/**
 * List PR line rows (flat, all columns), newest first.
 * f = { status?, materialId?, from?, to? } — from/to filter CreatedOn.
 */
function pur_listPRs(f) {
  f = f || {};
  var from = fmtDate_(f.from), to = fmtDate_(f.to);
  var list = up_readAll('PurchaseRequisitions').map(function (r) {
    return pur_normDates_(r, ['ReqDate', 'CreatedOn']);
  }).filter(function (r) {
    if (f.status && String(r.Status) !== String(f.status)) return false;
    if (f.materialId && String(r.MaterialID) !== String(f.materialId)) return false;
    if (from && r.CreatedOn < from) return false;
    if (to && r.CreatedOn > to) return false;
    return true;
  });
  return list.reverse();
}

/**
 * Create a purchase requisition.
 * d = { lines: [{ materialId, qty, reqDate?, plant, sloc }] }
 */
function pur_createPR(d) {
  d = d || {};
  var lines = d.lines || [];
  if (!lines.length) throw new Error('At least one PR line is required.');

  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    // ---- validate everything before writing anything
    var prepared = lines.map(function (ln, i) {
      var label = 'Line ' + (i + 1);
      var mat = pur_materialById_(ln.materialId);
      var qty = Number(ln.qty);
      if (!(qty > 0)) throw new Error(label + ': quantity must be > 0.');
      pur_assertPlantSLoc_(ln.plant, ln.sloc, label);
      return {
        materialId: String(mat.MaterialID !== undefined ? mat.MaterialID : ln.materialId),
        description: mat.Description || '',
        qty: qty,
        uom: mat.BaseUOM || '',
        reqDate: fmtDate_(ln.reqDate) || fmtDate_(up_today()),
        plant: String(ln.plant),
        sloc: String(ln.sloc)
      };
    });

    var prNo = getNextNumber('PR');
    var today = up_today();
    var createdBy = up_createdBy();
    prepared.forEach(function (ln, i) {
      up_appendRow('PurchaseRequisitions', {
        PRNo:        String(prNo),
        Line:        (i + 1) * 10,
        MaterialID:  ln.materialId,
        Description: ln.description,
        Qty:         ln.qty,
        UOM:         ln.uom,
        ReqDate:     ln.reqDate,
        Plant:       ln.plant,
        SLoc:        ln.sloc,
        Status:      'Open',
        CreatedOn:   today,
        CreatedBy:   createdBy
      });
    });
    return { ok: true, prNo: String(prNo) };
  } finally {
    lock.releaseLock();
  }
}

/** Close a PR: set all Open lines to Closed. Throws if PR not found. */
function pur_closePR(prNo) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var rows = up_readAll('PurchaseRequisitions');
    var found = false;
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].PRNo) === String(prNo)) {
        found = true;
        if (String(rows[i].Status) === 'Open') {
          up_updateRow('PurchaseRequisitions', i + 2, { Status: 'Closed' });
        }
      }
    }
    if (!found) throw new Error('Purchase requisition ' + prNo + ' not found');
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// ------------------------------------------------------------------
// Purchase Orders
// ------------------------------------------------------------------

/**
 * List PO headers as aggregates, newest first.
 * f = { status?, vendorId?, from?, to? } — from/to filter CreatedOn.
 */
function pur_listPOs(f) {
  f = f || {};
  var from = fmtDate_(f.from), to = fmtDate_(f.to);

  var vendors = {};
  up_readAll('Vendors').forEach(function (v) {
    vendors[String(v.VendorID)] = v;
  });

  var map = {}, order = [];
  up_readAll('PurchaseOrders').forEach(function (r) {
    var poNo = String(r.PONo);
    if (!map[poNo]) {
      var vend = vendors[String(r.VendorID)] || {};
      map[poNo] = {
        poNo: poNo,
        vendorId: String(r.VendorID),
        vendorName: String(vend.Name || ''),
        currency: String(r.Currency || ''),
        lines: 0,
        totalQty: 0,
        totalValue: 0,
        statuses: [],
        deliveryDate: '',
        createdOn: fmtDate_(r.CreatedOn)
      };
      order.push(poNo);
    }
    var a = map[poNo];
    var qty = Number(r.Qty) || 0;
    var price = Number(r.NetPrice) || 0;
    a.lines += 1;
    a.totalQty = up_round3(a.totalQty + qty);
    a.totalValue = up_round2(a.totalValue + qty * price);
    a.statuses.push(String(r.Status));
    var dd = fmtDate_(r.DeliveryDate);
    if (dd > a.deliveryDate) a.deliveryDate = dd;
    var co = fmtDate_(r.CreatedOn);
    if (co > a.createdOn) a.createdOn = co;
  });

  var list = order.map(function (poNo) {
    var a = map[poNo];
    return {
      poNo: a.poNo,
      vendorId: a.vendorId,
      vendorName: a.vendorName,
      currency: a.currency,
      lines: a.lines,
      totalQty: a.totalQty,
      totalValue: a.totalValue,
      status: pur_worstStatus_(a.statuses),
      deliveryDate: a.deliveryDate,
      createdOn: a.createdOn
    };
  }).filter(function (h) {
    if (f.status && h.status !== String(f.status)) return false;
    if (f.vendorId && h.vendorId !== String(f.vendorId)) return false;
    if (from && h.createdOn < from) return false;
    if (to && h.createdOn > to) return false;
    return true;
  });
  return list.reverse();
}

/**
 * Create a purchase order.
 * d = { vendorId, currency?, lines: [{ materialId, qty, netPrice,
 *       deliveryDate?, plant, sloc, prRef? }] }
 * Lines carrying prRef convert the matching open PR line to 'Converted'.
 */
function pur_createPO(d) {
  d = d || {};
  var lines = d.lines || [];
  if (!lines.length) throw new Error('At least one PO line is required.');

  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var vendor = pur_vendorById_(d.vendorId);
    if (!vendor) throw new Error('Vendor ' + d.vendorId + ' not found');
    var currency = d.currency || vendor.Currency || 'PKR';

    // ---- validate all lines before writing
    var prepared = lines.map(function (ln, i) {
      var label = 'Line ' + (i + 1);
      var mat = pur_materialById_(ln.materialId);
      var qty = Number(ln.qty);
      var price = Number(ln.netPrice);
      if (!(qty > 0)) throw new Error(label + ': quantity must be > 0.');
      if (!(price >= 0)) throw new Error(label + ': net price must be >= 0.');
      pur_assertPlantSLoc_(ln.plant, ln.sloc, label);
      return {
        materialId: String(mat.MaterialID !== undefined ? mat.MaterialID : ln.materialId),
        description: mat.Description || '',
        qty: qty,
        uom: mat.BaseUOM || '',
        netPrice: up_round2(price),
        deliveryDate: fmtDate_(ln.deliveryDate) || '',
        plant: String(ln.plant),
        sloc: String(ln.sloc),
        prRef: ln.prRef ? String(ln.prRef) : ''
      };
    });

    var poNo = getNextNumber('PO');
    var today = up_today();

    prepared.forEach(function (ln, i) {
      up_appendRow('PurchaseOrders', {
        PONo:         String(poNo),
        Line:         (i + 1) * 10,
        PRRef:        ln.prRef,
        VendorID:     String(d.vendorId),
        MaterialID:   ln.materialId,
        Description:  ln.description,
        Qty:          ln.qty,
        UOM:          ln.uom,
        NetPrice:     ln.netPrice,
        Currency:     currency,
        DeliveryDate: ln.deliveryDate,
        Plant:        ln.plant,
        SLoc:         ln.sloc,
        Status:       'Open',
        ReceivedQty:  0,
        CreatedOn:    today
      });

      // Convert the referenced PR line (PRNo + MaterialID, currently Open).
      if (ln.prRef) {
        var prRows = up_readAll('PurchaseRequisitions');
        var converted = false;
        for (var j = 0; j < prRows.length; j++) {
          if (String(prRows[j].PRNo) === ln.prRef &&
              String(prRows[j].MaterialID) === ln.materialId &&
              String(prRows[j].Status) === 'Open') {
            up_updateRow('PurchaseRequisitions', j + 2, { Status: 'Converted' });
            converted = true;
            break;
          }
        }
        if (!converted) {
          throw new Error('PR line not found or not open: PR ' + ln.prRef +
            ' / material ' + ln.materialId);
        }
      }
    });

    return { ok: true, poNo: String(poNo) };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Get a PO: header plus full line rows with openQty = Qty - ReceivedQty.
 */
function pur_getPO(poNo) {
  var rows = up_readAll('PurchaseOrders').filter(function (r) {
    return String(r.PONo) === String(poNo);
  });
  if (!rows.length) throw new Error('Purchase order ' + poNo + ' not found');

  var vendor = pur_vendorById_(rows[0].VendorID) || {};
  var header = {
    poNo: String(poNo),
    vendorId: String(rows[0].VendorID),
    vendorName: String(vendor.Name || ''),
    currency: String(rows[0].Currency || ''),
    status: pur_worstStatus_(rows.map(function (r) { return String(r.Status); })),
    createdOn: fmtDate_(rows[0].CreatedOn)
  };
  var lines = rows.map(function (r) {
    var ln = pur_normDates_(r, ['DeliveryDate', 'CreatedOn']);
    ln.openQty = up_round3((Number(r.Qty) || 0) - (Number(r.ReceivedQty) || 0));
    return ln;
  });
  return { header: header, lines: lines };
}

/**
 * Post a goods receipt against a PO (movement type 101). Atomic: the whole
 * batch — stock movements, GR rows and PO line updates — is under one lock.
 * d = { poNo, postingDate?, lines: [{ line, qty }] }
 */
function pur_postGR(d) {
  d = d || {};
  var grLines = d.lines || [];
  if (!d.poNo) throw new Error('poNo is required.');
  if (!grLines.length) throw new Error('At least one GR line is required.');

  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var poRows = up_readAll('PurchaseOrders');
    var today = fmtDate_(up_today());
    var postingDate = fmtDate_(d.postingDate) || today;
    var createdBy = up_createdBy();

    // ---- validate all lines first
    var prepared = grLines.map(function (ln, i) {
      var label = 'GR line ' + (i + 1);
      var qty = Number(ln.qty);
      if (!(qty > 0)) throw new Error(label + ': quantity must be > 0.');
      var rowIdx = -1, poLine = null;
      for (var j = 0; j < poRows.length; j++) {
        if (String(poRows[j].PONo) === String(d.poNo) &&
            String(poRows[j].Line) === String(ln.line)) {
          rowIdx = j; poLine = poRows[j]; break;
        }
      }
      if (!poLine) {
        throw new Error(label + ': PO ' + d.poNo + ' line ' + ln.line + ' not found.');
      }
      if (String(poLine.Status) === 'Closed') {
        throw new Error(label + ': PO ' + d.poNo + ' line ' + ln.line + ' is closed.');
      }
      var received = Number(poLine.ReceivedQty) || 0;
      var ordered = Number(poLine.Qty) || 0;
      var newReceived = up_round3(received + qty);
      if (newReceived > ordered) {
        throw new Error('Over-receipt on PO ' + d.poNo + ' line ' + ln.line +
          ': ordered ' + ordered + ', already received ' + received +
          ', attempting ' + qty + '.');
      }
      return { rowIdx: rowIdx, poLine: poLine, qty: qty, newReceived: newReceived };
    });

    var grNo = getNextNumber('GR');

    // ---- post everything
    prepared.forEach(function (p) {
      var poLine = p.poLine;
      postStockMovement({
        materialId: String(poLine.MaterialID),
        plant: String(poLine.Plant),
        sloc: String(poLine.SLoc),
        qtyChange: p.qty,
        movementType: '101',
        docType: 'GR',
        docNo: String(grNo),
        unitPrice: Number(poLine.NetPrice) || 0,
        createdBy: createdBy
      });

      up_appendRow('GoodsReceipts', {
        GRNo: String(grNo),
        DocDate: today,
        PostingDate: postingDate,
        PONo: String(d.poNo),
        POLine: poLine.Line,
        MaterialID: poLine.MaterialID,
        Qty: p.qty,
        UOM: poLine.UOM,
        Plant: poLine.Plant,
        SLoc: poLine.SLoc,
        MovementType: '101',
        RefDoc: String(d.poNo),
        CreatedBy: createdBy
      });

      var newStatus = p.newReceived >= (Number(poLine.Qty) || 0) ? 'Received' : 'Partial';
      up_updateRow('PurchaseOrders', p.rowIdx + 2, {
        ReceivedQty: p.newReceived,
        Status: newStatus
      });
    });

    return { ok: true, grNo: String(grNo), lines: prepared.length };
  } finally {
    lock.releaseLock();
  }
}

/** Close a PO: set all Open/Partial lines to Closed. */
function pur_closePO(poNo) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var rows = up_readAll('PurchaseOrders');
    var found = false;
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].PONo) === String(poNo)) {
        found = true;
        var st = String(rows[i].Status);
        if (st === 'Open' || st === 'Partial') {
          up_updateRow('PurchaseOrders', i + 2, { Status: 'Closed' });
        }
      }
    }
    if (!found) throw new Error('Purchase order ' + poNo + ' not found');
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/**
 * List goods receipt rows (flat), newest first.
 * f = { poNo?, materialId?, from?, to? } — from/to filter PostingDate.
 */
function pur_listGRs(f) {
  f = f || {};
  var from = fmtDate_(f.from), to = fmtDate_(f.to);
  var list = up_readAll('GoodsReceipts').map(function (r) {
    return pur_normDates_(r, ['DocDate', 'PostingDate']);
  }).filter(function (r) {
    if (f.poNo && String(r.PONo) !== String(f.poNo)) return false;
    if (f.materialId && String(r.MaterialID) !== String(f.materialId)) return false;
    if (from && r.PostingDate < from) return false;
    if (to && r.PostingDate > to) return false;
    return true;
  });
  return list.reverse();
}

/**
 * Automated Reorder Planning / MRP (SAP MD01-lite).
 * Scans all materials where total stock <= ReorderPoint.
 * Suggests reorder quantities to bring stock to safety level.
 */
function pur_getReorderSuggestions() {
  var mats = up_readAll('Materials');
  var stock = up_readAll('Stock');
  var slocs = up_readAll('StorageLocations');
  
  var qtyByMat = {};
  stock.forEach(function (s) {
    var id = String(s.MaterialID);
    qtyByMat[id] = (qtyByMat[id] || 0) + (Number(s.Quantity) || 0);
  });

  var suggestions = [];
  mats.forEach(function (m) {
    var rp = Number(m.ReorderPoint) || 0;
    if (rp <= 0) return;
    var current = qtyByMat[String(m.MaterialID)] || 0;
    if (current <= rp) {
      var suggestedQty = up_round3(Math.max(rp * 2 - current, rp));
      var plantSloc = slocs.filter(function (s) { return String(s.PlantID) === String(m.Plant); })[0];
      var slocId = plantSloc ? String(plantSloc.SLocID) : '0001';
      suggestions.push({
        materialId: String(m.MaterialID),
        description: m.Description || '',
        currentStock: current,
        reorderPoint: rp,
        suggestedQty: suggestedQty,
        uom: m.BaseUOM || 'PC',
        plant: m.Plant || '1000',
        sloc: slocId
      });
    }
  });
  return suggestions;
}

/**
 * Reverse a Goods Receipt (SAP MM Movement 102).
 * Decrements Stock, decreases PO received quantity, and returns PO to Open/Partial.
 */
function pur_reverseGR(grNo, reason) {
  if (!grNo) throw new Error('grNo is required');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var grRows = up_readAll('GoodsReceipts').filter(function (r) {
      return String(r.GRNo) === String(grNo) && String(r.MovementType) === '101';
    });
    if (!grRows.length) throw new Error('Goods receipt not found or already reversed: ' + grNo);

    var poRows = up_readAll('PurchaseOrders');
    var stockRows = up_readAll('Stock');
    var today = fmtDate_(up_today());
    var createdBy = up_createdBy();

    // Verify stock availability for all lines
    grRows.forEach(function (gr) {
      var qty = Number(gr.Qty) || 0;
      var stock = stockRows.find(function (s) {
        return String(s.MaterialID) === String(gr.MaterialID) &&
               String(s.Plant) === String(gr.Plant) &&
               String(s.SLoc) === String(gr.SLoc);
      });
      var curQty = stock ? (Number(stock.Quantity) || 0) : 0;
      if (curQty < qty) {
        throw new Error('Cannot reverse GR: insufficient on-hand stock for ' + gr.MaterialID +
          ' at Plant ' + gr.Plant + ' SLoc ' + gr.SLoc + ' (has ' + curQty + ', need ' + qty + ')');
      }
    });

    // Execute reversal
    grRows.forEach(function (gr) {
      var qty = Number(gr.Qty) || 0;
      var poNo = String(gr.PONo);
      var poLineNo = String(gr.POLine);

      // Find PO Line
      var poRowIdx = -1, poLine = null;
      for (var j = 0; j < poRows.length; j++) {
        if (String(poRows[j].PONo) === poNo && String(poRows[j].Line) === poLineNo) {
          poRowIdx = j; poLine = poRows[j]; break;
        }
      }

      var unitPrice = poLine ? (Number(poLine.NetPrice) || 0) : 0;

      // Post stock movement 102 (negative qtyChange)
      postStockMovement({
        materialId: String(gr.MaterialID),
        plant: String(gr.Plant),
        sloc: String(gr.SLoc),
        qtyChange: -qty,
        movementType: '102',
        docType: 'GR',
        docNo: String(grNo),
        unitPrice: unitPrice,
        createdBy: createdBy
      });

      // Update PO line received quantity
      if (poLine && poRowIdx !== -1) {
        var oldRec = Number(poLine.ReceivedQty) || 0;
        var newRec = up_round3(Math.max(0, oldRec - qty));
        var newStatus = newRec <= 0 ? 'Open' : (newRec < (Number(poLine.Qty) || 0) ? 'Partial' : 'Received');
        up_updateRow('PurchaseOrders', poRowIdx + 2, {
          ReceivedQty: newRec,
          Status: newStatus
        });
      }

      // Append reversal entry to GoodsReceipts
      var revGrNo = getNextNumber('GR');
      up_appendRow('GoodsReceipts', {
        GRNo: revGrNo,
        DocDate: today,
        PostingDate: today,
        PONo: poNo,
        POLine: gr.POLine,
        MaterialID: gr.MaterialID,
        Qty: qty,
        UOM: gr.UOM,
        Plant: gr.Plant,
        SLoc: gr.SLoc,
        MovementType: '102',
        RefDoc: 'REV:' + grNo + (reason ? ' (' + reason + ')' : ''),
        CreatedBy: createdBy
      });
    });

    return { ok: true, message: 'Goods receipt ' + grNo + ' reversed successfully.', linesReversed: grRows.length };
  } finally {
    lock.releaseLock();
  }
}

