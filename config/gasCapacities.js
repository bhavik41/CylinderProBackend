// Single backend source of truth for the gas-type → valid-capacity catalog.
// MUST stay in sync with GAS_CAPACITIES in frontend/app.js (same data, same order).
// Required by config/mongodb.js (seed) and the bulk-import routes (validation), so there is
// exactly ONE backend copy.
const GAS_CAPACITIES = {
  'Oxygen':            ['1.5 m3', '6 m3', '7 m3', '10 m3'],
  'Nitrogen':          ['1.5 m3', '6 m3', '7 m3', '10 m3'],
  'Argon':             ['7 m3', '10 m3'],
  'CO2':               ['2 KG', '4.5 KG', '6 KG', '9 KG', '15 KG', '18 KG', '22 KG', '30 KG', '45 KG'],
  'Nitrous Oxide':     ['2 KG', '17 m3', '30 KG'],
  'Acetylene':         ['7 m3'],
  'Helium':            ['1.5 m3', '7 m3', '10 m3'],
  'HCL':               ['5 KG', '32 KG'],
  'MIX':               ['7 m3']
};

const _gasByLower = {};
Object.keys(GAS_CAPACITIES).forEach(g => { _gasByLower[g.toLowerCase()] = g; });

// Resolve a (possibly mis-cased) gas-type name to its canonical form, or null if unknown.
function normalizeGasType(name) {
  const k = String(name == null ? '' : name).trim().toLowerCase();
  return _gasByLower[k] || null;
}

// Resolve a capacity to its canonical form for the given (already-canonical) gas type, or null.
// Case- and whitespace-insensitive (e.g. "7  M3" → "7 m3").
function normalizeCapacity(gasCanonical, cap) {
  if (!gasCanonical || !GAS_CAPACITIES[gasCanonical]) return null;
  const target = String(cap == null ? '' : cap).trim().toLowerCase().replace(/\s+/g, ' ');
  return GAS_CAPACITIES[gasCanonical].find(c => c.toLowerCase().replace(/\s+/g, ' ') === target) || null;
}

module.exports = { GAS_CAPACITIES, normalizeGasType, normalizeCapacity };
