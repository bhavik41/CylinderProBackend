const Bill = require('../models/Bill');
const Customer = require('../models/Customer');
const Cylinder = require('../models/Cylinder');
const GasType = require('../models/GasType');
const CylinderSize = require('../models/CylinderSize');
const HttpError = require('../utils/HttpError');

// ─── Personal cylinders (quantity-only) ───
// personalCylindersIn/Out on each line item are the customer's OWN cylinders (not our inventory).
// Net contribution of a set of line items to "held at plant" = sum(In) − sum(Out).
function billPersonalDelta(lineItems) {
  return (lineItems || []).reduce(
    (s, li) => s + (Number(li.personalCylindersIn) || 0) - (Number(li.personalCylindersOut) || 0), 0);
}
// Total personal cylinders we hold for a customer across ALL their bills (optionally excluding one,
// e.g. the bill currently being edited, whose new value is added separately).
async function totalPersonalForCustomer(owner, customerId, excludeBillId) {
  const bills = await Bill.find({ user_id: owner, customer_id: customerId }, { line_items: 1 });
  let t = 0;
  for (const b of bills) {
    if (excludeBillId && String(b._id) === String(excludeBillId)) continue;
    t += billPersonalDelta(b.line_items);
  }
  return t;
}

// Bill numbers are globally sequential (not per-user)
async function generateBillNumber() {
  const lastBill = await Bill.findOne().sort('-createdAt');
  const nextId = lastBill ? parseInt(lastBill.bill_number.split('-')[1]) + 1 : 1;
  return `BILL-${String(nextId).padStart(4, '0')}`;
}

// Find the current holder of a cylinder = the most recent GIVEN line for that rotational number
// that has NOT yet been marked returned. Returns { bill, line } (bill.customer_id populated) or null.
// excludeBillId skips the just-created bill (so a swap round-trip's own GIVEN line isn't treated as the holder).
async function findCurrentGiven(userId, serial, excludeBillId) {
  const bills = await Bill.find({
    user_id: userId,
    line_items: { $elemMatch: { direction: 'GIVEN', serial_number: serial } }
  }).populate('customer_id').sort('-bill_date -createdAt');

  for (const b of bills) {
    if (excludeBillId && String(b._id) === String(excludeBillId)) continue;
    const line = b.line_items.find(li =>
      li.direction === 'GIVEN' && li.serial_number === serial && !li.returned_via);
    if (line) return { bill: b, line };
  }
  return null;
}

// ─── Real-time per-cylinder validation (Edit Bill popup + New Transaction form) ───
// Returns: { valid, warningOnly, message, heldBy?: { customerName, billNo } }
//
// Edit context differs from a brand-new transaction: a cylinder that is already on the bill being
// edited (same direction) is correctly in its current status BECAUSE of this bill, so it is exempt
// from re-validation. Only newly-added cylinders are checked.
async function validateCylinder(uid, { cylinderNo, direction, transactionId, customerId }) {
  const rot = String(cylinderNo || '').trim();
  if (!rot) return { valid: true };

  const cyl = await Cylinder.findOne({ user_id: uid, rotational_number: rot });
  if (!cyl) return { valid: true }; // not in inventory → manual/personal cylinder, skip

  // Original-bill exemption: a cylinder already on this bill (same direction) needs no re-check.
  let editingBill = null;
  if (transactionId) {
    editingBill = await Bill.findOne({ _id: transactionId, user_id: uid });
    if (editingBill) {
      const dirUpper = direction === 'received' ? 'RECEIVED' : 'GIVEN';
      const inOriginal = editingBill.line_items.some(li => li.direction === dirUpper && li.serial_number === rot);
      if (inOriginal) return { valid: true };
    }
  }

  const billCustomerId = editingBill ? String(editingBill.customer_id) : (customerId ? String(customerId) : null);

  if (direction === 'given') {
    if (cyl.status === 'at-plant') return { valid: true }; // will be set in-rotation on save
    // in-rotation → blocked only if ANOTHER bill currently holds it (excluding the bill being edited).
    const holderRec = await findCurrentGiven(uid, rot, transactionId || null);
    if (holderRec && holderRec.bill && holderRec.bill.customer_id) {
      const h = holderRec.bill.customer_id;
      return {
        valid: false,
        warningOnly: false,
        message: `${rot} is currently held by ${h.company_name} (${holderRec.bill.bill_number}). Cannot add until returned.`,
        heldBy: { customerName: h.company_name, billNo: holderRec.bill.bill_number }
      };
    }
    // in-rotation but no other open holder → held by this bill (or orphaned); giving it here is fine.
    return { valid: true };
  }

  // direction === 'received'
  if (cyl.status === 'at-plant') {
    return {
      valid: false,
      warningOnly: false,
      message: `${rot} is currently at the plant — it hasn't been given out, so it cannot be received.`
    };
  }
  // in-rotation → allowed; if held by a DIFFERENT customer than this bill, it's a cross-customer return (warning).
  const holderRec = await findCurrentGiven(uid, rot, transactionId || null);
  if (holderRec && holderRec.bill && holderRec.bill.customer_id) {
    const h = holderRec.bill.customer_id;
    if (billCustomerId && String(h._id) !== billCustomerId) {
      return {
        valid: true,
        warningOnly: true,
        message: `${rot} is currently held by ${h.company_name} — this will be recorded as returned on their behalf.`,
        heldBy: { customerName: h.company_name, billNo: holderRec.bill.bill_number }
      };
    }
  }
  return { valid: true };
}

async function listBills(userId, { date, customer_id }) {
  const query = { user_id: userId };

  if (date) {
    const startDate = new Date(date);
    const endDate = new Date(date);
    endDate.setHours(23, 59, 59, 999);
    query.bill_date = { $gte: startDate, $lte: endDate };
  }

  if (customer_id) {
    query.customer_id = customer_id;
  }

  const bills = await Bill.find(query)
    .populate('customer_id')
    .sort('-bill_date -createdAt');

  return bills.map(bill => ({
    ...bill.toObject(),
    company_name: bill.customer_id.company_name,
    phone_primary: bill.customer_id.phone_primary
  }));
}

async function getBill(userId, billId) {
  const bill = await Bill.findOne({ _id: billId, user_id: userId })
    .populate('customer_id')
    .populate('line_items.gas_type_id')
    .populate('line_items.cylinder_size_id');

  if (!bill) {
    throw new HttpError(404, 'Bill not found');
  }

  const billData = bill.toObject();
  billData.company_name = bill.customer_id.company_name;
  billData.contact_person = bill.customer_id.contact_person;
  billData.phone_primary = bill.customer_id.phone_primary;
  billData.phone_alternate = bill.customer_id.phone_alternate;
  billData.address = bill.customer_id.address;
  billData.gst_number = bill.customer_id.gst_number;

  billData.line_items = billData.line_items.map(item => ({
    ...item,
    gas_type_name: item.gas_type_id.gas_type_name,
    size_label: item.cylinder_size_id.size_label
  }));

  billData.given_items = billData.line_items.filter(item => item.direction === 'GIVEN');
  billData.received_items = billData.line_items.filter(item => item.direction === 'RECEIVED');

  return billData;
}

async function createBill(userId, body) {
  const {
    customer_id,
    customer_type,
    one_time_customer,
    bill_date,
    transaction_type,
    challan_no,
    remarks,
    given_items,
    received_items
  } = body;

  if (!customer_id && customer_type !== 'ONE_TIME') {
    throw new HttpError(400, 'Customer ID is required for regular customers');
  }

  if (customer_type === 'ONE_TIME' && !one_time_customer) {
    throw new HttpError(400, 'One-time customer details are required');
  }

  if (!given_items && !received_items) {
    throw new HttpError(400, 'At least one cylinder must be in the cart');
  }

  // Challan number is mandatory for new transactions (item 4).
  if (!challan_no || !String(challan_no).trim()) {
    throw new HttpError(400, 'Challan number is required');
  }

  const allItems = [...(given_items || []), ...(received_items || [])];
  for (const item of allItems) {
    const nSerials = (item.serial_numbers || []).length;
    const personal = (Number(item.personalCylindersIn) || 0) + (Number(item.personalCylindersOut) || 0);
    // A line is valid if it has inventory cylinders OR a personal-cylinder count.
    if (nSerials === 0 && personal === 0) {
      throw new HttpError(400, 'Each cylinder line needs at least one cylinder number or a personal cylinder count.');
    }
    if (nSerials > 0 && nSerials !== item.quantity) {
      throw new HttpError(400, 'Number of serial numbers must match quantity');
    }
  }

  // ─── Cylinder availability & duplicate re-validation ───
  const givenSerials = (given_items || []).flatMap(i => i.serial_numbers.map(s => String(s).trim()));
  const receivedSerials = (received_items || []).flatMap(i => i.serial_numbers.map(s => String(s).trim()));

  // No duplicates within the same section
  const findDup = (arr) => arr.find((s, idx) => arr.indexOf(s) !== idx);
  const givenDup = findDup(givenSerials);
  if (givenDup) {
    throw new HttpError(400, `Cylinder "${givenDup}" appears more than once in the Given section`);
  }
  const receivedDup = findDup(receivedSerials);
  if (receivedDup) {
    throw new HttpError(400, `Cylinder "${receivedDup}" appears more than once in the Received section`);
  }

  // A rotational number may appear in BOTH given and received ONLY for a SWAP (round-trip)
  if (transaction_type !== 'SWAP') {
    const overlap = givenSerials.find(s => receivedSerials.includes(s));
    if (overlap) {
      throw new HttpError(400, `Cylinder "${overlap}" cannot be both given and received in a non-swap transaction`);
    }
  }

  // Look up the inventory status of every referenced cylinder (unmapped numbers are allowed as a fallback)
  const allSerials = [...new Set([...givenSerials, ...receivedSerials])];
  const inventory = await Cylinder.find({ user_id: userId, rotational_number: { $in: allSerials } });
  const statusByRot = {};
  const cylByRot = {};
  inventory.forEach(c => { statusByRot[c.rotational_number] = c.status; cylByRot[c.rotational_number] = c; });
  const receivedSet = new Set(receivedSerials);

  // ─── Per-line gas-type + size consistency re-validation ───
  // Every serial within a single line item must match that line's gas type and size
  // (the frontend locks this per line, but the backend must enforce it independently).
  // Unmapped serials (not in inventory) are skipped — they're a manual-entry fallback.
  const gasIds = [...new Set(allItems.map(i => String(i.gas_type_id)).filter(Boolean))];
  const sizeIds = [...new Set(allItems.map(i => String(i.cylinder_size_id)).filter(Boolean))];
  const [gasDocs, sizeDocs] = await Promise.all([
    GasType.find({ _id: { $in: gasIds } }),
    CylinderSize.find({ _id: { $in: sizeIds } })
  ]);
  const gasNameById = {}; gasDocs.forEach(g => { gasNameById[String(g._id)] = g.gas_type_name; });
  const sizeLabelById = {}; sizeDocs.forEach(s => { sizeLabelById[String(s._id)] = s.size_label; });

  for (const item of allItems) {
    const lineGas = gasNameById[String(item.gas_type_id)];
    const lineSize = sizeLabelById[String(item.cylinder_size_id)];
    if (!lineGas || !lineSize) {
      throw new HttpError(400, 'Each cylinder line must have a valid gas type and size.');
    }
    for (const raw of item.serial_numbers) {
      const s = String(raw).trim();
      const cyl = cylByRot[s];
      if (!cyl) continue; // unmapped — allow
      if (cyl.gas_type !== lineGas || cyl.capacity !== lineSize) {
        throw new HttpError(400, `Cylinder "${s}" is ${cyl.gas_type} / ${cyl.capacity} — it doesn't match this line (${lineGas} / ${lineSize}). Put it in its own cylinder line.`);
      }
    }
  }

  for (const s of givenSerials) {
    const status = statusByRot[s];
    if (status === undefined) continue; // unmapped — allow with frontend warning
    const isSwapRoundTrip = transaction_type === 'SWAP' && receivedSet.has(s);
    if (status !== 'at-plant' && !isSwapRoundTrip) {
      throw new HttpError(400, `Cylinder "${s}" is not available to give out (status: ${status}). Only cylinders at-plant can be given.`);
    }
  }
  for (const s of receivedSerials) {
    const status = statusByRot[s];
    if (status === undefined) continue; // unmapped — allow with frontend warning
    if (status !== 'in-rotation') {
      throw new HttpError(400, `Cylinder "${s}" is not in rotation (status: ${status}) and cannot be received.`);
    }
  }

  let finalCustomerId = customer_id;

  if (customer_type === 'ONE_TIME') {
    const newCustomer = new Customer({
      customer_type: 'ONE_TIME',
      user_id: userId,
      ...one_time_customer
    });
    await newCustomer.save();
    finalCustomerId = newCustomer._id;
  }

  const billNumber = await generateBillNumber();

  // Recompute totals server-side — never trust client `amount`. Personal cylinders RETURNED
  // (personalCylindersOut) are refilled service items charged at the same line rate:
  //   amount = rate × (inventory cylinders + personalCylindersOut)
  // Personal cylinders TAKEN (personalCylindersIn, Empty section) are never charged.
  const total_given_qty = given_items ? given_items.reduce((sum, item) => sum + (item.serial_numbers || []).length, 0) : 0;
  const total_received_qty = received_items ? received_items.reduce((sum, item) => sum + (item.serial_numbers || []).length, 0) : 0;
  const total_bill_amount = given_items
    ? given_items.reduce((sum, item) =>
        sum + (Number(item.rate) || 0) * ((item.serial_numbers || []).length + (Number(item.personalCylindersOut) || 0)), 0)
    : 0;

  const lineItems = [];

  // Personal counts are per gas-type block; attach to the FIRST expanded line of the block
  // (or a single quantity-0 line when the block has personal cylinders but no inventory serials).
  if (given_items) {
    given_items.forEach(item => {
      const serials = item.serial_numbers || [];
      const pOut = Number(item.personalCylindersOut) || 0;
      const rate = Number(item.rate) || 0;
      // Personal-only Filled line: still billable — amount = rate × personal count.
      if (serials.length === 0) {
        lineItems.push({
          direction: 'GIVEN', gas_type_id: item.gas_type_id, cylinder_size_id: item.cylinder_size_id,
          serial_number: '', quantity: 0, rate, amount: rate * pOut, personalCylindersOut: pOut
        });
        return;
      }
      // Per-serial lines; the first line of the block carries the personal count and its charge,
      // so each stored line's amount = rate × (quantity + personalCylindersOut).
      serials.forEach((serialNumber, idx) => {
        const p = idx === 0 ? pOut : 0;
        lineItems.push({
          direction: 'GIVEN', gas_type_id: item.gas_type_id, cylinder_size_id: item.cylinder_size_id,
          serial_number: serialNumber, quantity: 1, rate, amount: rate * (1 + p),
          personalCylindersOut: p
        });
      });
    });
  }

  if (received_items) {
    received_items.forEach(item => {
      const serials = item.serial_numbers || [];
      const pIn = Number(item.personalCylindersIn) || 0;
      if (serials.length === 0) {
        lineItems.push({
          direction: 'RECEIVED', gas_type_id: item.gas_type_id, cylinder_size_id: item.cylinder_size_id,
          serial_number: '', quantity: 0, rate: 0, amount: 0, personalCylindersIn: pIn
        });
        return;
      }
      serials.forEach((serialNumber, idx) => {
        lineItems.push({
          direction: 'RECEIVED', gas_type_id: item.gas_type_id, cylinder_size_id: item.cylinder_size_id,
          serial_number: serialNumber, quantity: 1, rate: 0, amount: 0,
          personalCylindersIn: idx === 0 ? pIn : 0
        });
      });
    });
  }

  // ─── Personal-cylinder guard: we can never hold a negative count for a customer ───
  const thisPersonalDelta = billPersonalDelta(lineItems);
  if (finalCustomerId) {
    const basePersonal = await totalPersonalForCustomer(userId, finalCustomerId);
    if (basePersonal + thisPersonalDelta < 0) {
      throw new HttpError(400, `Cannot return ${-thisPersonalDelta} personal cylinder(s) — this customer only has ${basePersonal} at the plant.`);
    }
  }

  const bill = new Bill({
    user_id: userId,
    bill_number: billNumber,
    customer_id: finalCustomerId,
    bill_date,
    transaction_type,
    challan_no: challan_no || '',
    total_given_qty,
    total_received_qty,
    total_bill_amount,
    remarks,
    line_items: lineItems
  });

  await bill.save();

  // ─── Cross-customer return settlement ───
  // For each received cylinder whose current holder differs from the customer on THIS bill,
  // record it as returned on the holder's (Customer A's) behalf, and mark A's original GIVEN
  // line as returned so A's holding is reduced — exactly as if A had returned it directly.
  const crossReturns = []; // for the response: which cylinders settled / couldn't be settled
  if (received_items && received_items.length) {
    const me = await Customer.findById(finalCustomerId); // Customer B (on this bill)
    let billDirty = false;

    for (const rline of bill.line_items) {
      if (rline.direction !== 'RECEIVED') continue;

      const holderRec = await findCurrentGiven(userId, rline.serial_number, bill._id);
      if (!holderRec) continue; // no original GIVEN found (legacy/unmapped) — cylinder already at-plant

      const holder = holderRec.bill.customer_id; // Customer A
      if (!holder || String(holder._id) === String(finalCustomerId)) continue; // same customer — normal return

      // Cross-customer return on behalf of Customer A
      rline.returned_on_behalf_of = holder._id;
      rline.returned_on_behalf_of_name = holder.company_name;
      billDirty = true;

      // Mark A's original GIVEN line as returned via B
      holderRec.line.returned_via = finalCustomerId;
      holderRec.line.returned_via_name = me ? me.company_name : '';
      holderRec.line.returned_date = bill.bill_date;
      await holderRec.bill.save();

      crossReturns.push({ serial: rline.serial_number, on_behalf_of: holder.company_name });
    }

    if (billDirty) await bill.save();
  }

  // ── Personal cylinders: recompute this customer's running at-plant count from all their bills. ──
  try {
    const newTotal = await totalPersonalForCustomer(userId, finalCustomerId);
    await Customer.updateOne({ _id: finalCustomerId, user_id: userId }, { personalCylindersAtPlant: Math.max(0, newTotal) });
  } catch (e) { /* non-fatal */ }

  return {
    bill_id: bill._id,
    bill_number: billNumber,
    challan_no: bill.challan_no,
    cross_returns: crossReturns,
    message: 'Bill created successfully'
  };
}

// Edit an existing bill (item 11). Computes a human-readable diff, appends to edit_history
// (unless same_session), re-syncs cylinder statuses for added/removed cylinders.
// `user` = req.user ({ id, name, email, ... }) — name/email are used in the edit_history entry.
async function updateBill(user, billId, body) {
  const uid = user.id;
  const bill = await Bill.findOne({ _id: billId, user_id: uid });
  if (!bill) throw new HttpError(404, 'Bill not found');

  // logEdit=true → record an editHistory entry (edits from the Transaction History popup).
  // logEdit=false → silent same-session correction from the success screen (no audit entry).
  const { bill_date, challan_no, transaction_type, line_items, logEdit } = body;
  if (!Array.isArray(line_items) || line_items.length === 0) {
    throw new HttpError(400, 'At least one cylinder line is required');
  }
  if (!challan_no || !String(challan_no).trim()) {
    throw new HttpError(400, 'Challan number is required');
  }

  // Resolve gas/size names (old + new) for the human-readable diff.
  const allGasIds = [...new Set([...bill.line_items.map(l => String(l.gas_type_id)), ...line_items.map(l => String(l.gas_type_id))].filter(Boolean))];
  const allSizeIds = [...new Set([...bill.line_items.map(l => String(l.cylinder_size_id)), ...line_items.map(l => String(l.cylinder_size_id))].filter(Boolean))];
  const [gasDocs, sizeDocs] = await Promise.all([
    GasType.find({ _id: { $in: allGasIds } }),
    CylinderSize.find({ _id: { $in: allSizeIds } })
  ]);
  const gasName = {}; gasDocs.forEach(g => { gasName[String(g._id)] = g.gas_type_name; });
  const sizeName = {}; sizeDocs.forEach(s => { sizeName[String(s._id)] = s.size_label; });

  const d2 = (d) => new Date(d).toLocaleDateString('en-GB');
  const oldSnap = {
    bill_date: bill.bill_date, challan_no: bill.challan_no || '', transaction_type: bill.transaction_type,
    amount: bill.total_bill_amount || 0,
    lines: bill.line_items.map(l => ({ key: l.direction + '|' + l.serial_number, serial: l.serial_number, direction: l.direction, rate: l.rate || 0 }))
  };

  const newLines = line_items.map(l => {
    const rate = l.direction === 'GIVEN' ? (Number(l.rate) || 0) : 0;
    const serial = String(l.serial_number || '').trim();
    const pOut = Number(l.personalCylindersOut) || 0;
    const quantity = serial ? 1 : 0;
    return {
      direction: l.direction, gas_type_id: l.gas_type_id, cylinder_size_id: l.cylinder_size_id,
      serial_number: serial, quantity, rate,
      // Personal cylinders returned are charged at the same rate: rate × (inventory + personal).
      amount: rate * (quantity + pOut),
      // Preserve personal-cylinder counts across edits (Edit Bill has no UI for them yet).
      personalCylindersIn: Number(l.personalCylindersIn) || 0,
      personalCylindersOut: pOut
    };
  });

  // Personal-cylinder guard (exclude THIS bill's old value; add its new value).
  const basePersonal = await totalPersonalForCustomer(uid, bill.customer_id, bill._id);
  if (basePersonal + billPersonalDelta(newLines) < 0) {
    throw new HttpError(400, `This edit would make the customer's personal cylinders at plant negative (they have ${basePersonal} on other bills).`);
  }

  // ── Compute diff ──
  const changes = [];
  if (bill_date && d2(bill_date) !== d2(oldSnap.bill_date)) changes.push(`Bill Date changed from ${d2(oldSnap.bill_date)} to ${d2(bill_date)}`);
  if (challan_no !== undefined && String(challan_no) !== oldSnap.challan_no) changes.push(`Challan No. changed from ${oldSnap.challan_no || '(none)'} to ${challan_no || '(none)'}`);
  if (transaction_type && transaction_type !== oldSnap.transaction_type) changes.push(`Transaction Type changed from ${oldSnap.transaction_type} to ${transaction_type}`);

  const oldByKey = {}; oldSnap.lines.forEach(l => { oldByKey[l.key] = l; });
  const newByKey = {}; newLines.forEach(l => { newByKey[l.direction + '|' + l.serial_number] = l; });
  oldSnap.lines.forEach(l => { if (!newByKey[l.key]) changes.push(`Cylinder ${l.serial} removed`); });
  newLines.forEach(l => {
    const key = l.direction + '|' + l.serial_number;
    const old = oldByKey[key];
    const g = gasName[String(l.gas_type_id)] || 'gas', s = sizeName[String(l.cylinder_size_id)] || 'size';
    if (!old) changes.push(`Cylinder ${l.serial_number} added (${g}, ${s}${l.direction === 'GIVEN' ? `, ₹${l.rate}` : ''})`);
    else if (l.direction === 'GIVEN' && Number(old.rate) !== Number(l.rate)) changes.push(`Rate changed from ₹${old.rate} to ₹${l.rate} for ${g} ${s}`);
  });

  // ── Apply ──
  if (bill_date) bill.bill_date = bill_date;
  if (challan_no !== undefined) bill.challan_no = challan_no;
  if (transaction_type) bill.transaction_type = transaction_type;
  bill.line_items = newLines;
  bill.total_given_qty = newLines.filter(l => l.direction === 'GIVEN').reduce((s, l) => s + l.quantity, 0);
  bill.total_received_qty = newLines.filter(l => l.direction === 'RECEIVED').reduce((s, l) => s + l.quantity, 0);
  bill.total_bill_amount = newLines.filter(l => l.direction === 'GIVEN').reduce((s, l) => s + l.amount, 0);

  const amountChanged = (oldSnap.amount || 0) !== bill.total_bill_amount;
  if (amountChanged) changes.push(`Bill amount changed from ₹${oldSnap.amount.toFixed(2)} to ₹${bill.total_bill_amount.toFixed(2)}`);

  if (logEdit && changes.length) {
    bill.edit_history.push({ edited_at: new Date(), edited_by: user.name || user.email || 'user', changes });
  }

  await bill.save(); // post-save hook re-applies statuses for the CURRENT line items

  // Re-sync any serials that were on the bill before but are now removed.
  const newSerials = new Set(newLines.map(l => l.serial_number));
  const oldSerials = [...new Set(oldSnap.lines.map(l => l.serial))];
  for (const s of oldSerials) {
    if (newSerials.has(s)) continue;
    const holder = await findCurrentGiven(uid, s, bill._id);
    await Cylinder.updateMany({ user_id: uid, rotational_number: s }, { status: holder ? 'in-rotation' : 'at-plant' });
  }

  // Recompute this customer's personal-cylinder at-plant count from all their bills.
  try {
    const newTotal = await totalPersonalForCustomer(uid, bill.customer_id);
    await Customer.updateOne({ _id: bill.customer_id, user_id: uid }, { personalCylindersAtPlant: Math.max(0, newTotal) });
  } catch (e) { /* non-fatal */ }

  return {
    bill_id: bill._id,
    amount_changed: amountChanged,
    old_amount: oldSnap.amount,
    new_amount: bill.total_bill_amount,
    audited: !!(logEdit && changes.length),
    changes,
    message: 'Bill updated successfully'
  };
}

async function getTodayStats(userId) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  const count = await Bill.countDocuments({
    user_id: userId,
    bill_date: { $gte: startOfDay, $lte: endOfDay }
  });

  return { today_transactions: count };
}

module.exports = {
  billPersonalDelta,
  totalPersonalForCustomer,
  generateBillNumber,
  findCurrentGiven,
  validateCylinder,
  listBills,
  getBill,
  createBill,
  updateBill,
  getTodayStats
};
