/**
 * MasterData.gs
 * ------------------------------------------------------------------
 * Master data management for the SAP MM-style ERP on Google Apps Script.
 *
 * Entities: Materials, Vendors, Customers, Plants, Storage Locations.
 * UI calls these via google.script.run.md_*(...).
 *
 * Conventions used here:
 *  - Batch reads (one up_readAll per sheet), script lock on writes.
 *  - Validation failures throw new Error('clear message').
 *  - Returned objects are JSON-friendly; date values are normalized to
 *    'yyyy-MM-dd' strings via md_fmtDate_.
 */

/**
 * Local date formatter: '' for empty, 'yyyy-MM-dd' for Date objects,
 * strings passed through unchanged. (Duplicated per module on purpose.)
 */
function md_fmtDate_(v) {
  if (v === null || v === undefined || v === '') return '';
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime())) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(v);
}

/** Copy a sheet row object, formatting the given header fields as dates. */
function md_normDates_(row, dateFields) {
  var out = {};
  for (var k in row) out[k] = row[k];
  dateFields.forEach(function (f) {
    if (f in out) out[f] = md_fmtDate_(out[f]);
  });
  return out;
}

/** Case-insensitive contains match helper. */
function md_match_(haystack, needle) {
  return String(haystack || '').toLowerCase().indexOf(String(needle).toLowerCase()) !== -1;
}

// ------------------------------------------------------------------
// Reference data
// ------------------------------------------------------------------

/** SAP-style material type list. */
function md_getMaterialTypes() {
  return [
    { code: 'ROH',  name: 'Raw Material' },
    { code: 'HALB', name: 'Semi-Finished Goods' },
    { code: 'FERT', name: 'Finished Goods' },
    { code: 'HAWA', name: 'Trading Goods' },
    { code: 'VERP', name: 'Packaging Material' }
  ];
}

/** Allowed base units of measure. */
function md_getUOMs() {
  return ['PC', 'KG', 'G', 'M', 'L', 'BOX', 'PAL', 'SET'];
}

// ------------------------------------------------------------------
// Materials
// ------------------------------------------------------------------

/**
 * List materials; optional search string matches MaterialID or Description.
 * Newest first.
 */
function md_listMaterials(q) {
  var list = up_readAll('Materials').map(function (r) {
    return md_normDates_(r, ['CreatedOn']);
  });
  if (q && String(q).trim() !== '') {
    list = list.filter(function (r) {
      return md_match_(r.MaterialID, q) || md_match_(r.Description, q);
    });
  }
  return list.reverse();
}

/** Get one material by ID, or throw. */
function md_getMaterial(id) {
  var rows = up_readAll('Materials');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].MaterialID) === String(id)) {
      return md_normDates_(rows[i], ['CreatedOn']);
    }
  }
  throw new Error('Material ' + id + ' not found');
}

/**
 * Create or update a material.
 * m = { materialId?, description, materialType, materialGroup?,
 *       baseUOM, valuationClass?, stdPrice?, reorderPoint?, plant }
 */
function md_saveMaterial(m) {
  m = m || {};
  if (!m.description || String(m.description).trim() === '') {
    throw new Error('Description is required.');
  }
  var typeCodes = md_getMaterialTypes().map(function (t) { return t.code; });
  if (typeCodes.indexOf(String(m.materialType)) === -1) {
    throw new Error('Invalid material type: ' + m.materialType);
  }
  if (md_getUOMs().indexOf(String(m.baseUOM)) === -1) {
    throw new Error('Invalid base UOM: ' + m.baseUOM);
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var rows = up_readAll('Materials');

    if (m.materialId) {
      // ---- update existing (preserve CreatedOn / CreatedBy / MovingAvgPrice)
      var idx = -1, existing = null;
      for (var i = 0; i < rows.length; i++) {
        if (String(rows[i].MaterialID) === String(m.materialId)) {
          idx = i; existing = rows[i]; break;
        }
      }
      if (!existing) throw new Error('Material ' + m.materialId + ' not found');

      var upd = {};
      for (var k in existing) upd[k] = existing[k];
      upd.Description    = m.description;
      upd.MaterialType   = m.materialType;
      upd.MaterialGroup  = m.materialGroup || '';
      upd.BaseUOM        = m.baseUOM;
      upd.ValuationClass = m.valuationClass || '';
      upd.StdPrice       = (m.stdPrice === undefined || m.stdPrice === '') ? 0 : up_round2(Number(m.stdPrice));
      upd.ReorderPoint   = (m.reorderPoint === undefined || m.reorderPoint === '') ? 0 : Number(m.reorderPoint);
      upd.Plant          = m.plant || '';
      up_updateRow('Materials', idx + 2, upd);
      return { ok: true, materialId: String(existing.MaterialID) };
    }

    // ---- create new
    var newId = getNextNumber('MAT');
    var stdPrice = (m.stdPrice === undefined || m.stdPrice === '') ? 0 : up_round2(Number(m.stdPrice));
    up_appendRow('Materials', {
      MaterialID:     newId,
      Description:    m.description,
      MaterialType:   m.materialType,
      MaterialGroup:  m.materialGroup || '',
      BaseUOM:        m.baseUOM,
      ValuationClass: m.valuationClass || '',
      StdPrice:       stdPrice,
      MovingAvgPrice: stdPrice,
      ReorderPoint:   (m.reorderPoint === undefined || m.reorderPoint === '') ? 0 : Number(m.reorderPoint),
      Plant:          m.plant || '',
      CreatedOn:      up_today(),
      CreatedBy:      up_createdBy()
    });
    return { ok: true, materialId: String(newId) };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Delete a material. Blocked when stock exists (Qty <> 0) or when an
 * Open/Partial purchase order references it.
 */
function md_deleteMaterial(id) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var stock = up_readAll('Stock');
    var hasStock = stock.some(function (r) {
      return String(r.MaterialID) === String(id) && Number(r.Quantity) !== 0;
    });
    if (hasStock) {
      throw new Error('Cannot delete material ' + id + ': stock exists (Quantity <> 0).');
    }
    var pos = up_readAll('PurchaseOrders');
    var openPO = pos.some(function (r) {
      return String(r.MaterialID) === String(id) &&
        ['Open', 'Partial'].indexOf(String(r.Status)) !== -1;
    });
    if (openPO) {
      throw new Error('Cannot delete material ' + id + ': referenced by an open or partially received purchase order.');
    }
    var idx = up_findRowIndex('Materials', 'MaterialID', String(id));
    if (idx === -1) throw new Error('Material ' + id + ' not found');
    up_getSheet('Materials').deleteRow(idx);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// ------------------------------------------------------------------
// Vendors
// ------------------------------------------------------------------

/** List vendors; optional search matches VendorID or Name. Newest first. */
function md_listVendors(q) {
  var list = up_readAll('Vendors').map(function (r) {
    return md_normDates_(r, ['CreatedOn']);
  });
  if (q && String(q).trim() !== '') {
    list = list.filter(function (r) {
      return md_match_(r.VendorID, q) || md_match_(r.Name, q);
    });
  }
  return list.reverse();
}

/**
 * Create or update a vendor.
 * v = { vendorId?, name, city?, country?, paymentTerms?, currency?, email?, phone? }
 */
function md_saveVendor(v) {
  v = v || {};
  if (!v.name || String(v.name).trim() === '') {
    throw new Error('Vendor name is required.');
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    if (v.vendorId) {
      var rows = up_readAll('Vendors');
      var idx = -1, existing = null;
      for (var i = 0; i < rows.length; i++) {
        if (String(rows[i].VendorID) === String(v.vendorId)) {
          idx = i; existing = rows[i]; break;
        }
      }
      if (!existing) throw new Error('Vendor ' + v.vendorId + ' not found');
      var upd = {};
      for (var k in existing) upd[k] = existing[k];
      upd.Name         = v.name;
      upd.City         = v.city || '';
      upd.Country      = v.country || '';
      upd.PaymentTerms = v.paymentTerms || '';
      upd.Currency     = v.currency || '';
      upd.Email        = v.email || '';
      upd.Phone        = v.phone || '';
      up_updateRow('Vendors', idx + 2, upd);
      return { ok: true, vendorId: String(existing.VendorID) };
    }
    var newId = getNextNumber('VND');
    up_appendRow('Vendors', {
      VendorID:     newId,
      Name:         v.name,
      City:         v.city || '',
      Country:      v.country || '',
      PaymentTerms: v.paymentTerms || '',
      Currency:     v.currency || '',
      Email:        v.email || '',
      Phone:        v.phone || '',
      CreatedOn:    up_today()
    });
    return { ok: true, vendorId: String(newId) };
  } finally {
    lock.releaseLock();
  }
}

/** Delete a vendor; blocked when an Open/Partial PO references it. */
function md_deleteVendor(id) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var pos = up_readAll('PurchaseOrders');
    var openPO = pos.some(function (r) {
      return String(r.VendorID) === String(id) &&
        ['Open', 'Partial'].indexOf(String(r.Status)) !== -1;
    });
    if (openPO) {
      throw new Error('Cannot delete vendor ' + id + ': referenced by an open or partially received purchase order.');
    }
    var idx = up_findRowIndex('Vendors', 'VendorID', String(id));
    if (idx === -1) throw new Error('Vendor ' + id + ' not found');
    up_getSheet('Vendors').deleteRow(idx);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// ------------------------------------------------------------------
// Customers
// ------------------------------------------------------------------

/** List customers; optional search matches CustomerID or Name. Newest first. */
function md_listCustomers(q) {
  var list = up_readAll('Customers').map(function (r) {
    return md_normDates_(r, ['CreatedOn']);
  });
  if (q && String(q).trim() !== '') {
    list = list.filter(function (r) {
      return md_match_(r.CustomerID, q) || md_match_(r.Name, q);
    });
  }
  return list.reverse();
}

/**
 * Create or update a customer.
 * c = { customerId?, name, city?, country?, paymentTerms?, currency?, email?, phone? }
 */
function md_saveCustomer(c) {
  c = c || {};
  if (!c.name || String(c.name).trim() === '') {
    throw new Error('Customer name is required.');
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    if (c.customerId) {
      var rows = up_readAll('Customers');
      var idx = -1, existing = null;
      for (var i = 0; i < rows.length; i++) {
        if (String(rows[i].CustomerID) === String(c.customerId)) {
          idx = i; existing = rows[i]; break;
        }
      }
      if (!existing) throw new Error('Customer ' + c.customerId + ' not found');
      var upd = {};
      for (var k in existing) upd[k] = existing[k];
      upd.Name         = c.name;
      upd.City         = c.city || '';
      upd.Country      = c.country || '';
      upd.PaymentTerms = c.paymentTerms || '';
      upd.Currency     = c.currency || '';
      upd.Email        = c.email || '';
      upd.Phone        = c.phone || '';
      up_updateRow('Customers', idx + 2, upd);
      return { ok: true, customerId: String(existing.CustomerID) };
    }
    var newId = getNextNumber('CUST');
    up_appendRow('Customers', {
      CustomerID:   newId,
      Name:         c.name,
      City:         c.city || '',
      Country:      c.country || '',
      PaymentTerms: c.paymentTerms || '',
      Currency:     c.currency || '',
      Email:        c.email || '',
      Phone:        c.phone || '',
      CreatedOn:    up_today()
    });
    return { ok: true, customerId: String(newId) };
  } finally {
    lock.releaseLock();
  }
}

/** True when the (future) SalesOrders sheet is present in this spreadsheet. */
function md_salesOrdersSheetExists_() {
  try {
    return !!up_getSheet('SalesOrders');
  } catch (e) {
    return false;
  }
}

/**
 * Delete a customer. Blocked when an open sales order references the
 * customer (checked only if a SalesOrders sheet exists — the sales module
 * is not part of this delivery).
 */
function md_deleteCustomer(id) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    if (md_salesOrdersSheetExists_()) {
      var sos = up_readAll('SalesOrders');
      var openSO = sos.some(function (r) {
        return String(r.CustomerID) === String(id) &&
          ['Open', 'Partial'].indexOf(String(r.Status)) !== -1;
      });
      if (openSO) {
        throw new Error('Cannot delete customer ' + id + ': referenced by an open sales order.');
      }
    }
    var idx = up_findRowIndex('Customers', 'CustomerID', String(id));
    if (idx === -1) throw new Error('Customer ' + id + ' not found');
    up_getSheet('Customers').deleteRow(idx);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// ------------------------------------------------------------------
// Plants & Storage Locations
// ------------------------------------------------------------------

/** All plants. */
function md_listPlants() {
  return up_readAll('Plants');
}

/**
 * Storage locations; when plantId is given, only locations of that plant.
 */
function md_listSLocs(plantId) {
  var list = up_readAll('StorageLocations');
  if (plantId && String(plantId).trim() !== '') {
    list = list.filter(function (r) {
      return String(r.PlantID) === String(plantId);
    });
  }
  return list;
}

/**
 * Create or update a storage location (keyed by SLocID + PlantID).
 * s = { slocId, plantId, description }
 */
function md_saveSLoc(s) {
  s = s || {};
  if (!s.slocId || String(s.slocId).trim() === '') {
    throw new Error('Storage location ID is required.');
  }
  var plants = up_readAll('Plants');
  var plantOk = plants.some(function (p) { return String(p.PlantID) === String(s.plantId); });
  if (!plantOk) throw new Error('Plant ' + s.plantId + ' not found');

  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var rows = up_readAll('StorageLocations');
    var idx = -1;
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].SLocID) === String(s.slocId) &&
          String(rows[i].PlantID) === String(s.plantId)) {
        idx = i; break;
      }
    }
    if (idx !== -1) {
      up_updateRow('StorageLocations', idx + 2, { Description: s.description || '' });
    } else {
      up_appendRow('StorageLocations', {
        SLocID:      String(s.slocId),
        PlantID:     String(s.plantId),
        Description: s.description || ''
      });
    }
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Bulk import materials from an array of plain objects.
 * rows = [{ description, materialType, baseUom, stdPrice?, movingAvgPrice?, reorderPoint?, plant?, materialGroup? }]
 */
function md_bulkImportMaterials(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('rows must be a non-empty array');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var createdCount = 0;
    var today = up_today();
    var createdBy = up_createdBy();

    rows.forEach(function (m) {
      if (!m.description || String(m.description).trim() === '') return;
      var newId = getNextNumber('MAT');
      var std = Number(m.stdPrice) || 0;
      var map = (m.movingAvgPrice !== undefined && m.movingAvgPrice !== '') ? Number(m.movingAvgPrice) : std;
      var rp = Number(m.reorderPoint) || 0;

      up_appendRow('Materials', {
        MaterialID:     newId,
        Description:    String(m.description).trim(),
        MaterialType:   m.materialType || 'ROH',
        MaterialGroup:  m.materialGroup || '',
        BaseUOM:        m.baseUom || m.uom || 'PC',
        ValuationClass: m.valuationClass || '3000',
        StdPrice:       up_round2(std),
        MovingAvgPrice: up_round2(map),
        ReorderPoint:   up_round2(rp),
        Plant:          m.plant || '1000',
        CreatedOn:      today,
        CreatedBy:      createdBy
      });
      createdCount++;
    });

    return { ok: true, count: createdCount };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Bulk import vendors from an array of objects.
 * rows = [{ name, city, country?, paymentTerms?, currency?, email?, phone? }]
 */
function md_bulkImportVendors(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('rows must be a non-empty array');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var count = 0;
    var today = up_today();
    rows.forEach(function (v) {
      if (!v.name || String(v.name).trim() === '') return;
      var newId = getNextNumber('VND');
      up_appendRow('Vendors', {
        VendorID:     newId,
        Name:         String(v.name).trim(),
        City:         v.city || '',
        Country:      v.country || '',
        PaymentTerms: v.paymentTerms || 'Net 30',
        Currency:     v.currency || 'PKR',
        Email:        v.email || '',
        Phone:        v.phone || '',
        CreatedOn:    today
      });
      count++;
    });
    return { ok: true, count: count };
  } finally {
    lock.releaseLock();
  }
}
