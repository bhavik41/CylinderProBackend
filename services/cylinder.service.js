const Cylinder = require('../models/Cylinder');
const Bill = require('../models/Bill');
const HttpError = require('../utils/HttpError');
const { normalizeGasType, normalizeCapacity } = require('../config/gasCapacities');
const { insertInBatches } = require('../utils/bulkInsert');

// Cylinder Aging Report — every in-rotation cylinder joined with its latest "Given" record.
async function getAgingReport(uid, { mode, minDays, maxDays, thresholdDays, sortBy, sortOrder }) {
  const cylinders = await Cylinder.find({ user_id: uid, status: 'in-rotation' });

  // Build a map of rotational_number -> latest GIVEN line (with its bill + customer)
  const bills = await Bill.find({ user_id: uid })
    .populate('customer_id')
    .sort('-bill_date -createdAt');

  // Current holder = most recent GIVEN line that has NOT been returned.
  const latestGiven = {};
  for (const bill of bills) {
    for (const li of bill.line_items) {
      if (li.direction === 'GIVEN' && !li.returned_via && latestGiven[li.serial_number] === undefined) {
        latestGiven[li.serial_number] = { bill, line: li };
      }
    }
  }

  const now = Date.now();
  const daysBetween = (d) => Math.floor((now - new Date(d).getTime()) / 86400000);

  let rows = cylinders.map(c => {
    const rec = latestGiven[c.rotational_number];
    if (!rec) {
      // Edge case: cylinder is in-rotation but no matching GIVEN transaction was found.
      return {
        rotational_number: c.rotational_number,
        physical_number: c.physical_number,
        gas_type: c.gas_type,
        capacity: c.capacity,
        customer_name: null,
        customer_phone: null,
        customer_address: null,
        date_given: null,
        days_out: null,
        bill_number: null,
        challan_no: null,
        rate: null,
        no_given_record: true
      };
    }
    const cust = rec.bill.customer_id || {};
    return {
      rotational_number: c.rotational_number,
      physical_number: c.physical_number,
      gas_type: c.gas_type,
      capacity: c.capacity,
      customer_name: cust.company_name || null,
      customer_phone: cust.phone_primary || null,
      customer_address: cust.address || null,
      date_given: rec.bill.bill_date,
      days_out: daysBetween(rec.bill.bill_date),
      bill_number: rec.bill.bill_number,
      challan_no: rec.bill.challan_no || '',
      rate: rec.line.rate || 0,
      no_given_record: false
    };
  });

  // Day filter (only applied to rows that have a date; anomaly rows are always kept so they surface)
  const min = minDays !== undefined && minDays !== '' ? Number(minDays) : null;
  const max = maxDays !== undefined && maxDays !== '' ? Number(maxDays) : null;
  const threshold = thresholdDays !== undefined && thresholdDays !== '' ? Number(thresholdDays) : null;

  rows = rows.filter(r => {
    if (r.days_out === null) return true; // keep anomalies
    if (mode === 'gte') {
      if (threshold !== null && r.days_out < threshold) return false;
    } else if (mode === 'range') {
      if (min !== null && r.days_out < min) return false;
      if (max !== null && r.days_out > max) return false;
    }
    return true;
  });

  // Sorting (null day values always sort last)
  const order = sortOrder === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    if (sortBy === 'customer') {
      const an = (a.customer_name || '').toLowerCase();
      const bn = (b.customer_name || '').toLowerCase();
      if (an === bn) return 0;
      return an < bn ? -order : order;
    }
    // default: daysOut
    if (a.days_out === null) return 1;
    if (b.days_out === null) return -1;
    return (a.days_out - b.days_out) * order;
  });

  return rows;
}

async function listCylinders(uid, { search, status }) {
  const query = { user_id: uid };

  if (status) query.status = status;

  if (search) {
    const re = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.$or = [
      { rotational_number: re },
      { physical_number: re },
      { gas_type: re }
    ];
  }

  return Cylinder.find(query).sort('rotational_number');
}

// All cylinders currently in-rotation (out of plant), each annotated with its CURRENT holder
// (the customer of its most recent not-yet-returned GIVEN line). Used for the "Received" / swap-return
// dropdown and for client-side cross-customer mismatch detection.
async function listInRotation(uid) {
  const inRotation = await Cylinder.find({ user_id: uid, status: 'in-rotation' }).sort('rotational_number');
  if (!inRotation.length) return [];

  const bills = await Bill.find({ user_id: uid })
    .populate('customer_id')
    .sort('-bill_date -createdAt');

  // Current holder per rotational number = most recent GIVEN that hasn't been returned.
  const holder = {};
  for (const bill of bills) {
    for (const li of bill.line_items) {
      if (li.direction === 'GIVEN' && !li.returned_via && holder[li.serial_number] === undefined) {
        holder[li.serial_number] = bill.customer_id || null;
      }
    }
  }

  return inRotation.map(c => {
    const h = holder[c.rotational_number];
    const obj = c.toObject();
    obj.holder_id = h ? String(h._id) : null;
    obj.holder_name = h ? h.company_name : null;
    return obj;
  });
}

async function getCylinder(uid, id) {
  const cylinder = await Cylinder.findOne({ _id: id, user_id: uid });
  if (!cylinder) throw new HttpError(404, 'Cylinder not found');
  return cylinder;
}

function translateDuplicateKeyError(error) {
  if (error.code === 11000) {
    const field = Object.keys(error.keyPattern || {}).find(k => k !== 'user_id') || 'number';
    const label = field === 'physical_number' ? 'physical number' : 'rotational number';
    return new HttpError(400, `A cylinder with this ${label} already exists`);
  }
  return null;
}

async function createCylinder(uid, { rotational_number, physical_number, gas_type, capacity, status }) {
  if (!rotational_number || !gas_type || !capacity) {
    throw new HttpError(400, 'Rotational number, gas type, and capacity are all required');
  }

  const cylinder = new Cylinder({
    user_id: uid,
    rotational_number,
    // physical_number is optional; store undefined when blank so the partial unique index ignores it
    physical_number: (physical_number && physical_number.trim()) ? physical_number.trim() : undefined,
    gas_type,
    capacity,
    status: status === 'in-rotation' ? 'in-rotation' : 'at-plant'
  });

  try {
    await cylinder.save();
  } catch (error) {
    throw translateDuplicateKeyError(error) || error;
  }

  return { cylinder_id: cylinder._id, message: 'Cylinder added successfully' };
}

// ─── One-time bulk import (onboarding) ───
// rows: [{ __row, rotational_number, physical_number, gas_type, capacity, status }].
// Re-validated server-side: required fields, valid gas_type + capacity-for-gas, in-file uniqueness.
// Inserts scoped to uid; duplicates vs existing records are reported as `skipped`.
async function importCylinders(uid, rows) {
  if (!Array.isArray(rows) || !rows.length) {
    throw new HttpError(400, 'No rows to import');
  }

  const str = (v) => String(v == null ? '' : v).trim();

  const items = [];
  const failed = [];
  const seenRot = new Set();
  const seenPhy = new Set();

  rows.forEach((r, i) => {
    const row = r.__row || (i + 2);
    const rotational_number = str(r.rotational_number);
    const physical_number = str(r.physical_number);
    if (!rotational_number) { failed.push({ row, reason: 'rotational_number is required' }); return; }

    const gas = normalizeGasType(r.gas_type);
    if (!gas) { failed.push({ row, reason: `Invalid gas_type "${str(r.gas_type)}"` }); return; }
    const capacity = normalizeCapacity(gas, r.capacity);
    if (!capacity) { failed.push({ row, reason: `Invalid capacity "${str(r.capacity)}" for ${gas}` }); return; }

    const rotKey = rotational_number.toLowerCase();
    if (seenRot.has(rotKey)) { failed.push({ row, reason: `Duplicate rotational_number "${rotational_number}" within file` }); return; }
    seenRot.add(rotKey);
    if (physical_number) {
      const phyKey = physical_number.toLowerCase();
      if (seenPhy.has(phyKey)) { failed.push({ row, reason: `Duplicate physical_number "${physical_number}" within file` }); return; }
      seenPhy.add(phyKey);
    }

    const st = str(r.status).toLowerCase().replace(/[\s_]+/g, '-');
    items.push({
      __row: row,
      doc: {
        user_id: uid,
        rotational_number,
        physical_number: physical_number || undefined, // omit so the partial unique index ignores it
        gas_type: gas,
        capacity,
        status: st === 'in-rotation' ? 'in-rotation' : 'at-plant'
      }
    });
  });

  const result = await insertInBatches(Cylinder, items);
  return {
    created: result.created,
    skipped: result.skipped,
    failed: [...failed, ...result.failed]
  };
}

async function updateCylinder(uid, id, body) {
  const allowed = ['rotational_number', 'physical_number', 'gas_type', 'capacity', 'status'];
  const updates = {};
  const unset = {};
  allowed.forEach(field => {
    if (body[field] !== undefined) updates[field] = body[field];
  });
  // physical_number is optional: clearing it removes the field so the partial unique index ignores it
  if (updates.physical_number !== undefined && !String(updates.physical_number).trim()) {
    delete updates.physical_number;
    unset.physical_number = '';
  } else if (updates.physical_number !== undefined) {
    updates.physical_number = String(updates.physical_number).trim();
  }
  const mutation = Object.keys(unset).length ? { $set: updates, $unset: unset } : updates;

  let cylinder;
  try {
    cylinder = await Cylinder.findOneAndUpdate(
      { _id: id, user_id: uid },
      mutation,
      { new: true, runValidators: true }
    );
  } catch (error) {
    throw translateDuplicateKeyError(error) || error;
  }

  if (!cylinder) throw new HttpError(404, 'Cylinder not found');
  return { cylinder_id: cylinder._id, message: 'Cylinder updated successfully' };
}

async function deleteCylinder(uid, id) {
  const result = await Cylinder.deleteOne({ _id: id, user_id: uid });
  if (result.deletedCount === 0) throw new HttpError(404, 'Cylinder not found');
  return { message: 'Cylinder deleted successfully' };
}

module.exports = {
  getAgingReport,
  listCylinders,
  listInRotation,
  getCylinder,
  createCylinder,
  importCylinders,
  updateCylinder,
  deleteCylinder
};
