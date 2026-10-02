/* =========================================================================
 * InventoryMgmt.gs — Inventory management backend (SAP MM-style).
 *
 * Sheets used: Stock, Materials, Plants, GoodsIssues, Reservations,
 *              StockLedger (via postStockMovement).
 *
 * Helpers used from Utils.gs: up_readAll, up_appendRow, up_updateRow,
 * up_require, up_round2, up_today, up_materialById, up_createdBy,
 * getNextNumber, postStockMovement.
 * ========================================================================= */

/** Local date normalizer: Date/string -> 'yyyy-MM-dd'. */
function im_fmtDate_(v) {
  if (v === null || v === undefined || v === '') return '';
  var d = (v instanceof Date) ? v : new Date(v);
  if (isNaN(d.getTime())) return '';
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/** Find first row matching keyHeader==keyVal. Returns {sheetRow, row} or null. */
function im_findRow_(name, keyHeader, keyVal) {
  var rows = up_readAll(name);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i][keyHeader] === keyVal) return { sheetRow: i + 2, row: rows[i] };
  }
  return null;
}

/**
 * Stock overview joined with material master.
 * f = {plant?, sloc?, materialId?, q?, lowStockOnly?}
 */
function inv_listStock(f) {
  f = f || {};
  var stock = up_readAll('Stock');
  var byId = {};
  up_readAll('Materials').forEach(function (m) { byId[m.MaterialID] = m; });
  var q = (f.q || '').toString().toLowerCase();
  var out = [];
  stock.forEach(function (s) {
    var m = byId[s.MaterialID];
    if (!m) return;
    if (f.plant && s.Plant !== f.plant) return;
    if (f.sloc && s.SLoc !== f.sloc) return;
    if (f.materialId && s.MaterialID !== f.materialId) return;
    var qty = Number(s.Quantity) || 0;
    var map = Number(m.MovingAvgPrice) || 0;
    var rp = Number(m.ReorderPoint) || 0;
    var low = qty <= rp;
    if (f.lowStockOnly && !low) return;
    if (q) {
      var hay = (s.MaterialID + ' ' + (m.Description || '')).toLowerCase();
      if (hay.indexOf(q) === -1) return;
    }
    out.push({
      materialId: s.MaterialID,
      description: m.Description || '',
      materialType: m.MaterialType || '',
      plant: s.Plant,
      sloc: s.SLoc,
      qty: qty,
      uom: m.BaseUOM || '',
      map: map,
      value: up_round2(qty * map),
      reorderPoint: rp,
      lowStock: low
    });
  });
  out.sort(function (a, b) {
    return a.materialId < b.materialId ? -1 : (a.materialId > b.materialId ? 1 : 0);
  });
  return out;
}

/** Material ledger movements, newest first. n defaults to 50. */
function inv_getLedger(materialId, n) {
  if (!materialId) throw new Error('materialId is required');
  n = n || 50;
  var m = up_materialById(materialId);
  var desc = m ? (m.Description || '') : '';
  return up_readAll('StockLedger')
    .filter(function (r) { return r.MaterialID === materialId; })
    .reverse()
    .slice(0, n)
    .map(function (r) {
      return {
        ledgerId: r.LedgerID,
        timestamp: im_fmtDate_(r.Timestamp),
        docType: r.DocType,
        docNo: r.DocNo,
        materialId: r.MaterialID,
        description: desc,
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

/**
 * Post a goods issue (consumption). movementType must be '201' or '261'.
 * d = {materialId, qty, plant, sloc, movementType, costCenter?, reason?, postingDate?}
 */
function inv_postGI(d) {
  d = d || {};
  up_require(d, ['materialId', 'qty', 'plant', 'sloc', 'movementType']);
  var qty = Number(d.qty);
  if (!(qty > 0)) throw new Error('qty must be > 0');
  if (d.movementType !== '201' && d.movementType !== '261') {
    throw new Error('movementType must be 201 or 261');
  }
  var m = up_materialById(d.materialId);
  if (!m) throw new Error('Material not found: ' + d.materialId);
  var plantOk = up_readAll('Plants').some(function (p) { return p.PlantID === d.plant; });
  if (!plantOk) throw new Error('Plant not found: ' + d.plant);

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var giNo = getNextNumber('GI');
    var today = up_today();
    var createdBy = up_createdBy();
    var r = postStockMovement({
      materialId: d.materialId,
      plant: d.plant,
      sloc: d.sloc,
      qtyChange: -qty,
      movementType: d.movementType,
      docType: 'GI',
      docNo: giNo,
      createdBy: createdBy
    });
    up_appendRow('GoodsIssues', {
      GINo: giNo,
      DocDate: today,
      PostingDate: d.postingDate || today,
      MaterialID: d.materialId,
      Qty: qty,
      UOM: m.BaseUOM,
      Plant: d.plant,
      SLoc: d.sloc,
      MovementType: d.movementType,
      CostCenter: d.costCenter || '',
      Reason: d.reason || '',
      CreatedBy: createdBy
    });
    return { ok: true, giNo: giNo, newQty: r.newQty };
  } finally {
    lock.releaseLock();
  }
}

/** List goods issue documents. f = {materialId?, movementType?, from?, to?}. Newest first. */
function inv_listGIs(f) {
  f = f || {};
  return up_readAll('GoodsIssues')
    .filter(function (r) {
      if (f.materialId && r.MaterialID !== f.materialId) return false;
      if (f.movementType && r.MovementType !== f.movementType) return false;
      if (f.from && im_fmtDate_(r.DocDate) < f.from) return false;
      if (f.to && im_fmtDate_(r.DocDate) > f.to) return false;
      return true;
    })
    .reverse()
    .map(function (r) {
      return {
        giNo: r.GINo,
        docDate: im_fmtDate_(r.DocDate),
        postingDate: im_fmtDate_(r.PostingDate),
        materialId: r.MaterialID,
        qty: Number(r.Qty) || 0,
        uom: r.UOM || '',
        plant: r.Plant,
        sloc: r.SLoc,
        movementType: r.MovementType,
        costCenter: r.CostCenter || '',
        reason: r.Reason || '',
        createdBy: r.CreatedBy || ''
      };
    });
}

/**
 * Transfer stock between storage locations/plants.
 * d = {materialId, qty, fromPlant, fromSloc, toPlant, toSloc, postingDate?}
 * Uses movement type 301 (plant-to-plant) or 311 (SLoc-to-SLoc).
 * Atomicity relies on postStockMovement's internal locking (no extra lock here).
 */
function inv_transferStock(d) {
  d = d || {};
  up_require(d, ['materialId', 'qty', 'fromPlant', 'fromSloc', 'toPlant', 'toSloc']);
  var qty = Number(d.qty);
  if (!(qty > 0)) throw new Error('qty must be > 0');
  if (d.fromPlant === d.toPlant && d.fromSloc === d.toSloc) {
    throw new Error('Source and destination must differ');
  }
  var m = up_materialById(d.materialId);
  if (!m) throw new Error('Material not found: ' + d.materialId);

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var trNo = getNextNumber('TR');
    var mt = (d.fromPlant !== d.toPlant) ? '301' : '311';
    var map = Number(m.MovingAvgPrice) || Number(m.StdPrice) || 0;
    var createdBy = up_createdBy();

    // Leg 1: issue from source — value derived from MAP internally (no unitPrice).
    postStockMovement({
      materialId: d.materialId,
      plant: d.fromPlant,
      sloc: d.fromSloc,
      qtyChange: -qty,
      movementType: mt,
      docType: 'TR',
      docNo: trNo,
      createdBy: createdBy
    });
    // Leg 2: receipt at destination at MAP to preserve value.
    postStockMovement({
      materialId: d.materialId,
      plant: d.toPlant,
      sloc: d.toSloc,
      qtyChange: qty,
      movementType: mt,
      docType: 'TR',
      docNo: trNo,
      unitPrice: map,
      createdBy: createdBy
    });
    return { ok: true, trNo: trNo };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Create a material reservation (Status 'Open').
 * d = {materialId, qty, plant, sloc, reqDate?}
 */
function inv_createReservation(d) {
  d = d || {};
  up_require(d, ['materialId', 'qty', 'plant', 'sloc']);
  var qty = Number(d.qty);
  if (!(qty > 0)) throw new Error('qty must be > 0');
  var m = up_materialById(d.materialId);
  if (!m) throw new Error('Material not found: ' + d.materialId);

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var resNo = getNextNumber('RES');
    var today = up_today();
    up_appendRow('Reservations', {
      ResNo: resNo,
      MaterialID: d.materialId,
      Qty: qty,
      UOM: m.BaseUOM,
      Plant: d.plant,
      SLoc: d.sloc,
      ReqDate: d.reqDate || today,
      Status: 'Open',
      CreatedOn: today
    });
    return { ok: true, resNo: resNo };
  } finally {
    lock.releaseLock();
  }
}

/** All reservations, newest first. */
function inv_listReservations() {
  return up_readAll('Reservations')
    .reverse()
    .map(function (r) {
      return {
        resNo: r.ResNo,
        materialId: r.MaterialID,
        qty: Number(r.Qty) || 0,
        uom: r.UOM || '',
        plant: r.Plant,
        sloc: r.SLoc,
        reqDate: im_fmtDate_(r.ReqDate),
        status: r.Status,
        createdOn: im_fmtDate_(r.CreatedOn)
      };
    });
}

/** Update a reservation: status must be 'Consumed' or 'Closed', only from 'Open'. */
function inv_updateReservation(resNo, status) {
  if (!resNo) throw new Error('resNo is required');
  if (status !== 'Consumed' && status !== 'Closed') {
    throw new Error('status must be Consumed or Closed');
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var hit = im_findRow_('Reservations', 'ResNo', resNo);
    if (!hit) throw new Error('Reservation not found: ' + resNo);
    if (hit.row.Status !== 'Open') {
      throw new Error('Only Open reservations can be updated');
    }
    up_updateRow('Reservations', hit.sheetRow, { Status: status });
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Post physical inventory count adjustment (SAP MM MI07 / MIGO).
 * Movement 701 (Physical Inventory Gain) if counted > current
 * Movement 702 (Physical Inventory Loss) if counted < current
 * d = { materialId, plant, sloc, countedQty, reason? }
 */
function inv_postStockAdjustment(d) {
  d = d || {};
  up_require(d, ['materialId', 'plant', 'sloc', 'countedQty']);
  var counted = Number(d.countedQty);
  if (isNaN(counted) || counted < 0) throw new Error('Counted quantity must be >= 0');
  
  var m = up_materialById(d.materialId);
  if (!m) throw new Error('Material not found: ' + d.materialId);

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var stockRows = up_readAll('Stock');
    var current = 0;
    for (var i = 0; i < stockRows.length; i++) {
      if (String(stockRows[i].MaterialID) === String(d.materialId) &&
          String(stockRows[i].Plant) === String(d.plant) &&
          String(stockRows[i].SLoc) === String(d.sloc)) {
        current = Number(stockRows[i].Quantity) || 0;
        break;
      }
    }
    var diff = up_round3(counted - current);
    if (Math.abs(diff) < 0.0001) {
      return { ok: true, message: 'Stock already matches physical count.', diffQty: 0, newQty: counted };
    }
    var mt = diff > 0 ? '701' : '702';
    var adjNo = getNextNumber('ADJ');
    var map = Number(m.MovingAvgPrice) || Number(m.StdPrice) || 0;
    var createdBy = up_createdBy();

    postStockMovement({
      materialId: d.materialId,
      plant: d.plant,
      sloc: d.sloc,
      qtyChange: diff,
      movementType: mt,
      docType: 'ADJ',
      docNo: adjNo,
      unitPrice: diff > 0 ? map : undefined,
      createdBy: createdBy
    });

    return {
      ok: true,
      adjNo: adjNo,
      diffQty: diff,
      newQty: counted,
      movementType: mt,
      reason: d.reason || ''
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Reverse a Goods Issue (SAP MM Movement 202/262).
 * Restores stock back to inventory and records a reversal document.
 */
function inv_reverseGI(giNo, reason) {
  if (!giNo) throw new Error('giNo is required');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var hit = im_findRow_('GoodsIssues', 'GINo', giNo);
    if (!hit) throw new Error('Goods issue not found: ' + giNo);
    var gi = hit.row;
    var mt = String(gi.MovementType);
    if (mt === '202' || mt === '262') {
      throw new Error('Document ' + giNo + ' is already a reversal.');
    }

    var revMT = mt === '261' ? '262' : '202';
    var qty = Number(gi.Qty) || 0;
    var m = up_materialById(gi.MaterialID);
    var map = m ? (Number(m.MovingAvgPrice) || Number(m.StdPrice) || 0) : 0;
    var today = up_today();
    var createdBy = up_createdBy();
    var revGiNo = getNextNumber('GI');

    postStockMovement({
      materialId: String(gi.MaterialID),
      plant: String(gi.Plant),
      sloc: String(gi.SLoc),
      qtyChange: qty,
      movementType: revMT,
      docType: 'GI',
      docNo: revGiNo,
      unitPrice: map,
      createdBy: createdBy
    });

    up_appendRow('GoodsIssues', {
      GINo: revGiNo,
      DocDate: today,
      PostingDate: today,
      MaterialID: gi.MaterialID,
      Qty: qty,
      UOM: gi.UOM,
      Plant: gi.Plant,
      SLoc: gi.SLoc,
      MovementType: revMT,
      CostCenter: gi.CostCenter || '',
      Reason: 'Reversal of ' + giNo + (reason ? ' (' + reason + ')' : ''),
      CreatedBy: createdBy
    });

    return { ok: true, giNo: revGiNo, message: 'Goods issue ' + giNo + ' successfully reversed with ' + revGiNo + '.' };
  } finally {
    lock.releaseLock();
  }
}
