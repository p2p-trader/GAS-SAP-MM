/**
 * Code.gs — Web entry point and thin JSON API for the ERP web app.
 * All business logic lives in the other .gs modules; this file only
 * wires up HtmlService and exposes get/set config used by the UI.
 */

/**
 * Web-app entry: renders the 'Index' HTML template.
 */
function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('ERP · Inventory Management')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Health-check ping function for connectivity verification.
 */
function ping() {
  return { ok: true, timestamp: up_now(), user: up_createdBy() };
}

/**
 * Template helper: inlines another HTML file into the template.
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * App-level config consumed by the UI (company name, currency, user email).
 * Returns a plain JSON-friendly object.
 */
function getAppConfig() {
  return {
    company: up_getConfig('CompanyName', 'Acme Corporation'),
    currency: up_getConfig('Currency', 'PKR'),
    version: '1.0.0',
    email: up_createdBy()
  };
}

/**
 * Persists company/currency settings from the UI and returns the refreshed config.
 */
function saveAppConfig(cfg) {
  cfg = cfg || {};
  if (cfg.company !== undefined && cfg.company !== null) {
    up_setConfig('CompanyName', String(cfg.company));
  }
  if (cfg.currency !== undefined && cfg.currency !== null) {
    up_setConfig('Currency', String(cfg.currency));
  }
  return getAppConfig();
}

/**
 * Custom Menu for Google Sheets when container-bound.
 */
function onOpen(e) {
  try {
    var ui = SpreadsheetApp.getUi();
    ui.createMenu('ERP · Materials Management')
      .addItem('🚀 Launch ERP Web App', 'menu_openWebApp')
      .addItem('🖨️ Print Document by Number...', 'menu_printDocument')
      .addSeparator()
      .addItem('📊 Export ABC Analysis to Sheet', 'menu_exportABC')
      .addItem('⚠️ Export Low Stock Report to Sheet', 'menu_exportLowStock')
      .addItem('📈 Export Stock Valuation to Sheet', 'menu_exportValuation')
      .addItem('🔄 Audit Stock vs Ledger', 'menu_auditStock')
      .addItem('📧 Send Low Stock Alert Email', 'menu_sendLowStockAlert')
      .addSeparator()
      .addItem('⏰ Schedule Daily Low Stock Digest (8 AM)', 'menu_scheduleDailyDigest')
      .addItem('⏹️ Disable Daily Digest Trigger', 'menu_disableDailyDigest')
      .addSeparator()
      .addItem('🛠️ Initialize Database Sheets', 'menu_setupDatabase')
      .addItem('📦 Seed Demo Dataset', 'menu_seedDemoData')
      .addToUi();
  } catch (err) {
    // If not container-bound to a sheet, getUi() may not be available
  }
}

/** Opens dialog with ERP web app launch information. */
function menu_openWebApp() {
  var url = ScriptApp.getService().getUrl();
  var html = '<div style="font-family:Arial,sans-serif;padding:12px;line-height:1.6;">' +
    '<h3 style="margin-top:0;color:#12294d;">ERP &middot; MM Web Application</h3>' +
    '<p>Access the full SAP MM-style enterprise interface for purchasing, inventory movements, stock valuation, and invoices.</p>' +
    (url ? '<p><a href="' + url + '" target="_blank" style="display:inline-block;padding:10px 18px;background:#0a6ed1;color:#fff;text-decoration:none;border-radius:4px;font-weight:bold;">Open ERP Web App &rarr;</a></p>'
         : '<p style="color:#666;">Deploy this project as a Web App (<b>Deploy &rarr; New deployment &rarr; Web app</b>) to access the URL.</p>') +
    '</div>';
  var output = HtmlService.createHtmlOutput(html).setWidth(420).setHeight(220);
  SpreadsheetApp.getUi().showModalDialog(output, 'ERP · Materials Management');
}

/** Menu action: Export ABC analysis to a sheet tab. */
function menu_exportABC() {
  var ui = SpreadsheetApp.getUi();
  try {
    var res = rep_exportReportToSheet('ABC');
    ui.alert('Success', 'ABC Analysis exported to sheet: ' + res.sheetName + ' (' + res.rowCount + ' items).', ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Error', 'Failed to export ABC analysis: ' + e.message, ui.ButtonSet.OK);
  }
}

/** Menu action: Export low stock items to a sheet tab. */
function menu_exportLowStock() {
  var ui = SpreadsheetApp.getUi();
  try {
    var res = rep_exportReportToSheet('LOW_STOCK');
    ui.alert('Success', 'Low stock report exported to sheet: ' + res.sheetName + ' (' + res.rowCount + ' items).', ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Error', 'Failed to export low stock report: ' + e.message, ui.ButtonSet.OK);
  }
}

/** Menu action: Export stock valuation to a sheet tab. */
function menu_exportValuation() {
  var ui = SpreadsheetApp.getUi();
  try {
    var res = rep_exportReportToSheet('VALUATION');
    ui.alert('Success', 'Valuation report exported to sheet: ' + res.sheetName + ' (' + res.rowCount + ' items).', ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Error', 'Failed to export valuation report: ' + e.message, ui.ButtonSet.OK);
  }
}

/** Menu action: Run stock ledger audit and display outcome. */
function menu_auditStock() {
  var ui = SpreadsheetApp.getUi();
  try {
    var res = rep_auditStockLedger();
    if (res.verified) {
      ui.alert('Audit Passed', 'All ' + res.totalChecked + ' stock balances perfectly match the transaction ledger.', ui.ButtonSet.OK);
    } else {
      var btn = ui.alert('Discrepancies Detected', 'Found ' + res.discrepancyCount + ' discrepancy(ies) out of ' + res.totalChecked + ' balances. Would you like to automatically reconcile them from the transaction ledger?', ui.ButtonSet.YES_NO);
      if (btn === ui.Button.YES) {
        var fixRes = rep_reconcileAndFixStock();
        ui.alert('Reconciliation Complete', fixRes.message, ui.ButtonSet.OK);
      }
    }
  } catch (e) {
    ui.alert('Audit Error', e.message, ui.ButtonSet.OK);
  }
}

/** Menu action: Send email alert for low stock. */
function menu_sendLowStockAlert() {
  var ui = SpreadsheetApp.getUi();
  try {
    var res = alert_sendLowStockDigest();
    ui.alert('Email Sent', 'Low stock digest sent to ' + res.sentTo + ' (' + res.count + ' items flagged).', ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Email Error', 'Failed to send alert: ' + e.message, ui.ButtonSet.OK);
  }
}

/** Menu action: Run database setup with confirmation. */
function menu_setupDatabase() {
  var ui = SpreadsheetApp.getUi();
  try {
    setupDatabase();
    ui.alert('Database Ready', 'All ERP sheets and number ranges are initialized and ready.', ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Setup Error', e.message, ui.ButtonSet.OK);
  }
}

/** Menu action: Seed demo data with confirmation. */
function menu_seedDemoData() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.alert('Load Demo Dataset', 'This will populate demo materials, vendors, customers, and transactions. Continue?', ui.ButtonSet.YES_NO);
  if (resp === ui.Button.YES) {
    try {
      var r = seedDemoData();
      ui.alert('Demo Data Loaded', r.message, ui.ButtonSet.OK);
    } catch (e) {
      ui.alert('Demo Data Error', e.message, ui.ButtonSet.OK);
    }
  }
}

/**
 * Daily low-stock trigger automation.
 */
function setupDailyLowStockTrigger() {
  removeLowStockTrigger(); // Avoid duplicate triggers
  ScriptApp.newTrigger('alert_sendLowStockDigest')
    .timeBased()
    .everyDays(1)
    .atHour(8)
    .create();
  return { ok: true, message: 'Automated daily low-stock digest trigger scheduled for 08:00 AM.' };
}

function removeLowStockTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  triggers.forEach(function (t) {
    if (t.getHandlerFunction() === 'alert_sendLowStockDigest') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  return { ok: true, removed: removed };
}

function getTriggerStatus() {
  try {
    var triggers = ScriptApp.getProjectTriggers();
    var hasLowStock = triggers.some(function (t) {
      return t.getHandlerFunction() === 'alert_sendLowStockDigest';
    });
    return { dailyAlertScheduled: hasLowStock, totalTriggers: triggers.length };
  } catch (e) {
    return { dailyAlertScheduled: false, totalTriggers: 0 };
  }
}

/** Menu action: Setup daily trigger. */
function menu_scheduleDailyDigest() {
  var ui = SpreadsheetApp.getUi();
  try {
    var res = setupDailyLowStockTrigger();
    ui.alert('Trigger Enabled', res.message, ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Trigger Error', 'Failed to schedule trigger: ' + e.message, ui.ButtonSet.OK);
  }
}

/** Menu action: Remove daily trigger. */
function menu_disableDailyDigest() {
  var ui = SpreadsheetApp.getUi();
  try {
    var res = removeLowStockTrigger();
    ui.alert('Trigger Disabled', 'Automated daily alert trigger has been removed (' + res.removed + ' trigger(s) cleared).', ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Trigger Error', 'Failed to remove trigger: ' + e.message, ui.ButtonSet.OK);
  }
}

/** Menu action: Prompt user for document number to print. */
function menu_printDocument() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.prompt('🖨️ Print ERP Document', 'Enter Document Number (e.g. 4500000001, 5000000001, SO-020001, 8000000001, 5100000001, PR-010001):', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var docNo = resp.getResponseText().trim();
  if (!docNo) {
    ui.alert('Empty Input', 'Please enter a document number.', ui.ButtonSet.OK);
    return;
  }
  try {
    var doc = doc_getDocumentForPrint(docNo);
    var html = doc_buildPrintHtml_(doc);
    var output = HtmlService.createHtmlOutput(html).setWidth(820).setHeight(650);
    ui.showModalDialog(output, 'Print ' + doc.docType + ' ' + doc.docNo);
  } catch (e) {
    ui.alert('Document Search', e.message, ui.ButtonSet.OK);
  }
}

/**
 * Normalizes document numbers for comparison, supporting prefixes and raw numbers.
 */
function doc_matchNo_(val, target) {
  if (!val || !target) return false;
  var sVal = String(val).trim().toLowerCase();
  var sTarget = String(target).trim().toLowerCase();
  if (sVal === sTarget) return true;
  var cleanVal = sVal.replace(/^(po|so|gr|gi|del|dn|inv|pr|tr|tp|res|adj)[-_#\s]*/i, '');
  var cleanTarget = sTarget.replace(/^(po|so|gr|gi|del|dn|inv|pr|tr|tp|res|adj)[-_#\s]*/i, '');
  return Boolean(cleanVal && cleanVal === cleanTarget);
}

/**
 * Universal document search and retrieval for printing by document number.
 * Looks up any document (PO, SO, GR, GI, DN, INV, PR, RES, TR, ADJ) across ERP sheets.
 */
function doc_getDocumentForPrint(docNo) {
  if (!docNo) throw new Error('Document number is required.');
  var target = String(docNo).trim();

  // 1. Try Purchase Order (45...)
  try {
    var poRows = up_readAll('PurchaseOrders').filter(function (r) {
      return doc_matchNo_(r.PONo, target);
    });
    if (poRows.length > 0) {
      var poNo = String(poRows[0].PONo);
      var po = pur_getPO(poNo);
      if (po && po.header && (po.lines || []).length > 0) {
        return { ok: true, docType: 'PO', docNo: poNo, data: po };
      }
    }
  } catch (e) {}

  // 2. Try Sales Order (SO-...)
  try {
    var soRows = up_readAll('SalesOrders').filter(function (r) {
      return doc_matchNo_(r.SONo, target);
    });
    if (soRows.length > 0) {
      var soNo = String(soRows[0].SONo);
      var so = sal_getSO(soNo);
      if (so && so.header && (so.lines || []).length > 0) {
        return { ok: true, docType: 'SO', docNo: soNo, data: so };
      }
    }
  } catch (e) {}

  // 3. Try Goods Receipt (50...)
  try {
    var grs = up_readAll('GoodsReceipts').filter(function (r) {
      return doc_matchNo_(r.GRNo, target);
    });
    if (grs.length > 0) {
      var matMap = {};
      up_readAll('Materials').forEach(function (m) { matMap[m.MaterialID] = m.Description; });
      var lines = grs.map(function (g) {
        return {
          grNo: g.GRNo,
          poNo: g.PONo,
          line: g.POLine,
          materialId: g.MaterialID,
          description: matMap[g.MaterialID] || '',
          qty: Number(g.Qty) || 0,
          uom: g.UOM || '',
          plant: g.Plant,
          sloc: g.SLoc,
          movementType: g.MovementType || '101',
          docDate: g.DocDate,
          postingDate: g.PostingDate,
          refDoc: g.RefDoc
        };
      });
      return { ok: true, docType: 'GR', docNo: grs[0].GRNo, data: { header: lines[0], lines: lines } };
    }
  } catch (e) {}

  // 4. Try Goods Issue (49...)
  try {
    var gi = up_readAll('GoodsIssues').find(function (r) {
      return doc_matchNo_(r.GINo, target);
    });
    if (gi) {
      var m = up_materialById(gi.MaterialID);
      return {
        ok: true,
        docType: 'GI',
        docNo: gi.GINo,
        data: {
          giNo: gi.GINo,
          docDate: gi.DocDate,
          postingDate: gi.PostingDate,
          materialId: gi.MaterialID,
          description: m ? m.Description : '',
          qty: Number(gi.Qty) || 0,
          uom: gi.UOM,
          plant: gi.Plant,
          sloc: gi.SLoc,
          movementType: gi.MovementType || '201',
          costCenter: gi.CostCenter || '',
          reason: gi.Reason || '',
          createdBy: gi.CreatedBy || ''
        }
      };
    }
  } catch (e) {}

  // 5. Try Delivery Note (80...)
  try {
    var dels = up_readAll('Deliveries').filter(function (r) {
      return doc_matchNo_(r.DelNo, target);
    });
    if (dels.length > 0) {
      var matMap2 = {};
      up_readAll('Materials').forEach(function (m) { matMap2[m.MaterialID] = m.Description; });
      var delLines = dels.map(function (d) {
        return {
          delNo: d.DelNo,
          soNo: d.SONo,
          line: d.SOLine,
          materialId: d.MaterialID,
          description: matMap2[d.MaterialID] || '',
          qty: Number(d.Qty) || 0,
          uom: d.UOM || '',
          plant: d.Plant,
          sloc: d.SLoc,
          docDate: d.DocDate,
          movementType: d.MovementType || '601'
        };
      });
      return { ok: true, docType: 'DN', docNo: dels[0].DelNo, data: { header: delLines[0], lines: delLines } };
    }
  } catch (e) {}

  // 6. Try Vendor Invoice (51...)
  try {
    var inv = up_readAll('VendorInvoices').find(function (r) {
      return doc_matchNo_(r.InvNo, target);
    });
    if (inv) {
      var vend = pur_vendorById_(inv.VendorID);
      return {
        ok: true,
        docType: 'INV',
        docNo: inv.InvNo,
        data: {
          invNo: inv.InvNo,
          docDate: inv.DocDate,
          poNo: inv.PONo,
          grNo: inv.GRNo,
          vendorId: inv.VendorID,
          vendorName: vend ? vend.Name : inv.VendorID,
          grossAmount: Number(inv.GrossAmount) || 0,
          taxAmount: Number(inv.TaxAmount) || 0,
          currency: inv.Currency || 'PKR',
          status: inv.Status
        }
      };
    }
  } catch (e) {}

  // 7. Try Purchase Requisition (PR-...)
  try {
    var prs = up_readAll('PurchaseRequisitions').filter(function (r) {
      return doc_matchNo_(r.PRNo, target);
    });
    if (prs.length > 0) {
      return {
        ok: true,
        docType: 'PR',
        docNo: prs[0].PRNo,
        data: {
          header: { prNo: prs[0].PRNo, createdOn: prs[0].CreatedOn, status: prs[0].Status },
          lines: prs.map(function (l) {
            return {
              line: l.Line,
              materialId: l.MaterialID,
              description: l.Description,
              qty: Number(l.Qty) || 0,
              uom: l.UOM,
              reqDate: l.ReqDate,
              plant: l.Plant,
              sloc: l.SLoc,
              status: l.Status
            };
          })
        }
      };
    }
  } catch (e) {}

  // 8. Try Reservation (RS-...)
  try {
    var res = up_readAll('Reservations').find(function (r) {
      return doc_matchNo_(r.ResNo, target);
    });
    if (res) {
      var mRes = up_materialById(res.MaterialID);
      return {
        ok: true,
        docType: 'RES',
        docNo: res.ResNo,
        data: {
          resNo: res.ResNo,
          materialId: res.MaterialID,
          description: mRes ? mRes.Description : '',
          qty: Number(res.Qty) || 0,
          uom: res.UOM,
          plant: res.Plant,
          sloc: res.SLoc,
          reqDate: res.ReqDate,
          status: res.Status,
          createdOn: res.CreatedOn
        }
      };
    }
  } catch (e) {}

  // 9. Try StockLedger for Transfers (TR-...)
  try {
    var trs = up_readAll('StockLedger').filter(function (l) {
      return (String(l.DocType) === 'TR' || String(l.DocType) === 'ADJ') && doc_matchNo_(l.DocNo, target);
    });
    if (trs.length > 0) {
      var mTr = up_materialById(trs[0].MaterialID);
      return {
        ok: true,
        docType: trs[0].DocType,
        docNo: trs[0].DocNo,
        data: {
          docNo: trs[0].DocNo,
          docType: trs[0].DocType,
          timestamp: trs[0].Timestamp,
          materialId: trs[0].MaterialID,
          description: mTr ? mTr.Description : '',
          lines: trs
        }
      };
    }
  } catch (e) {}

  throw new Error('Document "' + target + '" was not found across ERP records. Please check the document number.');
}

/**
 * Returns a list of recent documents with metadata for the printout center table.
 */
function doc_getRecentDocuments() {
  var list = [];
  var seen = {};

  try {
    // 1. POs
    var pos = up_readAll('PurchaseOrders');
    for (var p = pos.length - 1; p >= 0 && list.length < 6; p--) {
      var poNo = String(pos[p].PONo);
      if (!seen['PO_' + poNo]) {
        seen['PO_' + poNo] = true;
        var poVal = (Number(pos[p].Qty) || 0) * (Number(pos[p].NetPrice) || 0);
        list.push({
          docNo: poNo,
          docType: 'PO',
          date: pos[p].CreatedOn || '',
          ref: pos[p].Description || pos[p].VendorID,
          value: poVal,
          status: pos[p].Status
        });
      }
    }

    // 2. GRs
    var grs = up_readAll('GoodsReceipts');
    for (var g = grs.length - 1; g >= 0 && list.length < 12; g--) {
      var grNo = String(grs[g].GRNo);
      if (!seen['GR_' + grNo]) {
        seen['GR_' + grNo] = true;
        list.push({
          docNo: grNo,
          docType: 'GR',
          date: grs[g].PostingDate || grs[g].DocDate || '',
          ref: 'PO ' + grs[g].PONo + ' · ' + grs[g].MaterialID,
          value: grs[g].Qty + ' ' + (grs[g].UOM || ''),
          status: 'Posted'
        });
      }
    }

    // 3. GIs
    var gis = up_readAll('GoodsIssues');
    for (var gi = gis.length - 1; gi >= 0 && list.length < 16; gi--) {
      var giNo = String(gis[gi].GINo);
      if (!seen['GI_' + giNo]) {
        seen['GI_' + giNo] = true;
        list.push({
          docNo: giNo,
          docType: 'GI',
          date: gis[gi].PostingDate || gis[gi].DocDate || '',
          ref: (gis[gi].CostCenter || gis[gi].Reason || 'Stock Issue') + ' · ' + gis[gi].MaterialID,
          value: gis[gi].Qty + ' ' + (gis[gi].UOM || ''),
          status: 'Posted'
        });
      }
    }

    // 4. SOs
    var sos = up_readAll('SalesOrders');
    for (var s = sos.length - 1; s >= 0 && list.length < 20; s--) {
      var soNo = String(sos[s].SONo);
      if (!seen['SO_' + soNo]) {
        seen['SO_' + soNo] = true;
        var soVal = (Number(sos[s].Qty) || 0) * (Number(sos[s].NetPrice) || 0);
        list.push({
          docNo: soNo,
          docType: 'SO',
          date: sos[s].CreatedOn || '',
          ref: sos[s].Description || sos[s].CustomerID,
          value: soVal,
          status: sos[s].Status
        });
      }
    }

    // 5. Deliveries
    var dels = up_readAll('Deliveries');
    for (var d = dels.length - 1; d >= 0 && list.length < 24; d--) {
      var delNo = String(dels[d].DelNo);
      if (!seen['DEL_' + delNo]) {
        seen['DEL_' + delNo] = true;
        list.push({
          docNo: delNo,
          docType: 'DN',
          date: dels[d].DocDate || '',
          ref: 'SO ' + dels[d].SONo + ' · ' + dels[d].MaterialID,
          value: dels[d].Qty + ' ' + (dels[d].UOM || ''),
          status: 'Dispatched'
        });
      }
    }

    // 6. Invoices
    var invs = up_readAll('VendorInvoices');
    for (var i = invs.length - 1; i >= 0 && list.length < 28; i--) {
      var invNo = String(invs[i].InvNo);
      if (!seen['INV_' + invNo]) {
        seen['INV_' + invNo] = true;
        list.push({
          docNo: invNo,
          docType: 'INV',
          date: invs[i].DocDate || '',
          ref: 'PO ' + invs[i].PONo + ' · ' + invs[i].VendorID,
          value: Number(invs[i].GrossAmount) || 0,
          status: invs[i].Status
        });
      }
    }

    // 7. PRs
    var prs = up_readAll('PurchaseRequisitions');
    for (var pr = prs.length - 1; pr >= 0 && list.length < 32; pr--) {
      var prNo = String(prs[pr].PRNo);
      if (!seen['PR_' + prNo]) {
        seen['PR_' + prNo] = true;
        list.push({
          docNo: prNo,
          docType: 'PR',
          date: prs[pr].CreatedOn || '',
          ref: prs[pr].Description || prs[pr].MaterialID,
          value: prs[pr].Qty + ' ' + (prs[pr].UOM || ''),
          status: prs[pr].Status
        });
      }
    }
  } catch (e) {}

  return list;
}

/**
 * Builds HTML printable voucher for display inside Google Sheets UI dialogs.
 */
function doc_buildPrintHtml_(doc) {
  var comp = up_getConfig('CompanyName') || 'Enterprise';
  var curr = up_getConfig('Currency') || 'PKR';
  var title = '';
  var metaRows = '';
  var tableHeaders = '';
  var tableRows = '';
  var d = doc.data;

  if (doc.docType === 'PO') {
    title = 'Purchase Order — ' + doc.docNo;
    var h = d.header || {};
    metaRows = '<tr><td><b>Vendor:</b> ' + (h.vendorName || h.vendorId) + '</td><td><b>Date:</b> ' + (h.createdOn || '') + '</td></tr>' +
               '<tr><td><b>Currency:</b> ' + (h.currency || curr) + '</td><td><b>Status:</b> ' + (h.status || '') + '</td></tr>';
    tableHeaders = '<tr><th>Line</th><th>Material</th><th>Description</th><th style="text-align:right">Qty</th><th>UOM</th><th style="text-align:right">Unit Price</th><th style="text-align:right">Line Total</th></tr>';
    var poTot = 0;
    (d.lines || []).forEach(function (l) {
      var val = (Number(l.Qty) || 0) * (Number(l.NetPrice) || 0);
      poTot += val;
      tableRows += '<tr><td>' + (l.Line || '') + '</td><td><b>' + (l.MaterialID || '') + '</b></td><td>' + (l.Description || '') + '</td><td style="text-align:right">' + (l.Qty || 0) + '</td><td>' + (l.UOM || '') + '</td><td style="text-align:right">' + (l.NetPrice || 0) + '</td><td style="text-align:right"><b>' + val.toFixed(2) + '</b></td></tr>';
    });
    tableRows += '<tr style="background:#f1f5f9;font-weight:bold"><td colspan="6" style="text-align:right">Total (' + (h.currency || curr) + '):</td><td style="text-align:right">' + poTot.toFixed(2) + '</td></tr>';
  } else if (doc.docType === 'GR') {
    title = 'Goods Receipt Note — ' + doc.docNo;
    var grHead = d.header || {};
    metaRows = '<tr><td><b>PO Number:</b> ' + (grHead.poNo || '') + '</td><td><b>Posting Date:</b> ' + (grHead.postingDate || grHead.docDate || '') + '</td></tr>' +
               '<tr><td><b>Plant / SLoc:</b> Plant ' + (grHead.plant || '') + ' / SLoc ' + (grHead.sloc || '') + '</td><td><b>Movement:</b> ' + (grHead.movementType || '101') + ' (GR to Stock)</td></tr>';
    tableHeaders = '<tr><th>Material ID</th><th>Description</th><th style="text-align:right">Received Qty</th><th>UOM</th><th>Plant</th><th>SLoc</th></tr>';
    (d.lines || []).forEach(function (l) {
      tableRows += '<tr><td><b>' + (l.materialId || '') + '</b></td><td>' + (l.description || '') + '</td><td style="text-align:right"><b>' + (l.qty || 0) + '</b></td><td>' + (l.uom || '') + '</td><td>' + (l.plant || '') + '</td><td>' + (l.sloc || '') + '</td></tr>';
    });
  } else if (doc.docType === 'GI') {
    title = 'Goods Issue Voucher — ' + doc.docNo;
    metaRows = '<tr><td><b>Cost Center:</b> ' + (d.costCenter || 'N/A') + '</td><td><b>Posting Date:</b> ' + (d.postingDate || d.docDate || '') + '</td></tr>' +
               '<tr><td><b>Movement Type:</b> ' + (d.movementType || '201') + '</td><td><b>Reason:</b> ' + (d.reason || 'General Issue') + '</td></tr>';
    tableHeaders = '<tr><th>Material ID</th><th>Description</th><th style="text-align:right">Issued Qty</th><th>UOM</th><th>Plant</th><th>SLoc</th></tr>';
    tableRows = '<tr><td><b>' + (d.materialId || '') + '</b></td><td>' + (d.description || '') + '</td><td style="text-align:right"><b>' + (d.qty || 0) + '</b></td><td>' + (d.uom || '') + '</td><td>' + (d.plant || '') + '</td><td>' + (d.sloc || '') + '</td></tr>';
  } else if (doc.docType === 'SO') {
    title = 'Sales Order — ' + doc.docNo;
    var soH = d.header || {};
    metaRows = '<tr><td><b>Customer:</b> ' + (soH.customerName || soH.customerId) + '</td><td><b>Created Date:</b> ' + (soH.createdOn || '') + '</td></tr>' +
               '<tr><td><b>Currency:</b> ' + (soH.currency || curr) + '</td><td><b>Status:</b> ' + (soH.status || '') + '</td></tr>';
    tableHeaders = '<tr><th>Line</th><th>Material</th><th>Description</th><th style="text-align:right">Order Qty</th><th>UOM</th><th style="text-align:right">Unit Price</th><th style="text-align:right">Line Total</th></tr>';
    var soTot = 0;
    (d.lines || []).forEach(function (l) {
      var val = (Number(l.qty) || 0) * (Number(l.netPrice) || 0);
      soTot += val;
      tableRows += '<tr><td>' + (l.line || '') + '</td><td><b>' + (l.materialId || '') + '</b></td><td>' + (l.description || '') + '</td><td style="text-align:right">' + (l.qty || 0) + '</td><td>' + (l.uom || '') + '</td><td style="text-align:right">' + (l.netPrice || 0) + '</td><td style="text-align:right"><b>' + val.toFixed(2) + '</b></td></tr>';
    });
    tableRows += '<tr style="background:#f1f5f9;font-weight:bold"><td colspan="6" style="text-align:right">Total (' + (soH.currency || curr) + '):</td><td style="text-align:right">' + soTot.toFixed(2) + '</td></tr>';
  } else if (doc.docType === 'DN') {
    title = 'Delivery Packing Slip — ' + doc.docNo;
    var dnHead = d.header || {};
    metaRows = '<tr><td><b>SO Reference:</b> ' + (dnHead.soNo || '') + '</td><td><b>Dispatch Date:</b> ' + (dnHead.docDate || '') + '</td></tr>' +
               '<tr><td><b>Plant / SLoc:</b> Plant ' + (dnHead.plant || '') + ' / SLoc ' + (dnHead.sloc || '') + '</td><td><b>Movement:</b> ' + (dnHead.movementType || '601') + ' (Goods Dispatch)</td></tr>';
    tableHeaders = '<tr><th>Material ID</th><th>Description</th><th style="text-align:right">Delivered Qty</th><th>UOM</th><th>Plant</th><th>SLoc</th></tr>';
    (d.lines || []).forEach(function (l) {
      tableRows += '<tr><td><b>' + (l.materialId || '') + '</b></td><td>' + (l.description || '') + '</td><td style="text-align:right"><b>' + (l.qty || 0) + '</b></td><td>' + (l.uom || '') + '</td><td>' + (l.plant || '') + '</td><td>' + (l.sloc || '') + '</td></tr>';
    });
  } else if (doc.docType === 'INV') {
    title = 'Vendor Invoice — ' + doc.docNo;
    metaRows = '<tr><td><b>Vendor:</b> ' + (d.vendorName || d.vendorId) + '</td><td><b>Invoice Date:</b> ' + (d.docDate || '') + '</td></tr>' +
               '<tr><td><b>PO Reference:</b> ' + (d.poNo || '') + '</td><td><b>Payment Status:</b> ' + (d.status || '') + '</td></tr>';
    tableHeaders = '<tr><th>Description</th><th style="text-align:right">Amount (' + (d.currency || curr) + ')</th></tr>';
    var gross = Number(d.grossAmount) || 0;
    var tax = Number(d.taxAmount) || 0;
    var net = gross - tax;
    tableRows = '<tr><td>Net Verified Goods Value</td><td style="text-align:right">' + net.toFixed(2) + '</td></tr>' +
                '<tr><td>Taxes &amp; Surcharges</td><td style="text-align:right">' + tax.toFixed(2) + '</td></tr>' +
                '<tr style="background:#f1f5f9;font-weight:bold"><td>Total Payable (Gross)</td><td style="text-align:right">' + gross.toFixed(2) + ' ' + (d.currency || curr) + '</td></tr>';
  } else if (doc.docType === 'PR') {
    title = 'Purchase Requisition Slip — ' + doc.docNo;
    var prHead = d.header || {};
    metaRows = '<tr><td><b>PR Number:</b> ' + (prHead.prNo || '') + '</td><td><b>Created Date:</b> ' + (prHead.createdOn || '') + '</td></tr>' +
               '<tr><td><b>Status:</b> ' + (prHead.status || '') + '</td><td><b>Document:</b> Purchase Requisition (Internal)</td></tr>';
    tableHeaders = '<tr><th>Line</th><th>Material ID</th><th>Description</th><th style="text-align:right">Req Qty</th><th>UOM</th><th>Target Date</th><th>Plant/SLoc</th></tr>';
    (d.lines || []).forEach(function (l) {
      tableRows += '<tr><td>' + (l.line || '') + '</td><td><b>' + (l.materialId || '') + '</b></td><td>' + (l.description || '') + '</td><td style="text-align:right"><b>' + (l.qty || 0) + '</b></td><td>' + (l.uom || '') + '</td><td>' + (l.reqDate || '') + '</td><td>' + (l.plant || '') + '/' + (l.sloc || '') + '</td></tr>';
    });
  } else {
    title = 'Document Voucher — ' + doc.docNo;
    metaRows = '<tr><td><b>Document Number:</b> ' + doc.docNo + '</td><td><b>Type:</b> ' + doc.docType + '</td></tr>';
    tableHeaders = '<tr><th>Field</th><th>Value</th></tr>';
    tableRows = '<tr><td>Data</td><td>' + JSON.stringify(d) + '</td></tr>';
  }

  return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<style>' +
    'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;margin:0;padding:20px;color:#1e293b;background:#fff}' +
    '.slip-box{border:1px solid #cbd5e1;border-radius:8px;padding:24px;max-width:760px;margin:0 auto;box-shadow:0 2px 10px rgba(0,0,0,.08)}' +
    '.hdr{display:flex;justify-content:space-between;border-bottom:2px solid #0f172a;padding-bottom:12px;margin-bottom:16px}' +
    '.brand{font-size:18px;font-weight:bold;color:#0f172a}' +
    '.title{font-size:16px;font-weight:bold;color:#0284c7;text-align:right}' +
    'table.meta{width:100%;margin-bottom:16px;font-size:13px;border-collapse:collapse}' +
    'table.meta td{padding:4px 8px;vertical-align:top}' +
    'table.items{width:100%;border-collapse:collapse;margin:16px 0;font-size:13px}' +
    'table.items th, table.items td{border:1px solid #e2e8f0;padding:8px 10px}' +
    'table.items th{background:#f8fafc;font-weight:600;text-align:left}' +
    '.signs{display:flex;justify-content:space-between;margin-top:40px;padding-top:12px;border-top:1px dashed #cbd5e1;font-size:12px;color:#64748b}' +
    '.sign-box{flex:1;max-width:200px;border-top:1px solid #334155;text-align:center;padding-top:6px;color:#0f172a}' +
    '.btn-bar{text-align:right;margin-bottom:16px}' +
    '.btn{background:#0284c7;color:#fff;border:none;padding:8px 16px;border-radius:6px;font-size:13px;font-weight:bold;cursor:pointer}' +
    '@media print{.btn-bar{display:none}.slip-box{border:none;box-shadow:none;padding:0}}' +
    '</style></head><body>' +
    '<div class="btn-bar"><button class="btn" onclick="window.print()">🖨️ Print This Document</button></div>' +
    '<div class="slip-box">' +
      '<div class="hdr">' +
        '<div><div class="brand">ERP&middot;MM &mdash; ' + comp + '</div><div style="font-size:12px;color:#64748b">Materials Management &amp; Inventory Suite</div></div>' +
        '<div><div class="title">' + title + '</div><div style="font-size:12px;color:#64748b;text-align:right">Printed: ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd') + '</div></div>' +
      '</div>' +
      '<table class="meta">' + metaRows + '</table>' +
      '<table class="items"><thead>' + tableHeaders + '</thead><tbody>' + tableRows + '</tbody></table>' +
      '<div class="signs">' +
        '<div class="sign-box">Prepared / Issued By</div>' +
        '<div class="sign-box">Verified / Approved By</div>' +
        '<div class="sign-box">Received By / Stamp</div>' +
      '</div>' +
    '</div></body></html>';
}



