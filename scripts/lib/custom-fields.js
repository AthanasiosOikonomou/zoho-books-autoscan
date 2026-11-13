'use strict';

/** Books custom fields by LABEL — shared by the sandbox seeding scripts (api names differ between a sandbox and a live organization). */

/**
 * Custom-field definitions per entity. Books omits a custom field from an entity's `custom_fields` while it has no
 * value, so the definitions come from Settings (several endpoint spellings exist across DCs/versions); as a last
 * resort the api_name is derived from the label the way Books does (`cf_<slug>`, sandbox: `cf__sb_<org>_<slug>`).
 */
async function customFieldDefs(books, entity, orgId) {
  const defs = new Map(); // label (lower) → { id, api_name, data_type }
  const add = (f) => { if (f && f.label) defs.set(String(f.label).trim().toLowerCase(), { id: f.customfield_id || f.field_id || null, api_name: f.api_name || f.placeholder || null, data_type: f.data_type || null }); };
  for (const p of [`/settings/preferences/customfields?entity=${entity}`, `/settings/customfields?entity=${entity}`, `/settings/preferences/${entity}`]) {
    try {
      const json = await books.request(p);
      const list = json.custom_fields || (json.customfields) || (json[entity] && json[entity].custom_fields) || [];
      for (const f of list) add(f);
      if (defs.size) break;
    } catch (_) { /* try the next spelling */ }
  }
  return {
    resolve(label) {
      const l = String(label).trim().toLowerCase();
      if (defs.has(l)) return defs.get(l);
      const slug = l.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      const sb = /sandbox/i.test(String(orgId.name || '')) || orgId.sandbox;
      return { id: null, api_name: `cf_${sb ? `_sb_${orgId.id}_` : ''}${slug}`, data_type: null, guessed: true };
    },
  };
}

/** Build the custom_fields update for the labels whose value differs from what the entity carries. */
function customFieldValues(existing, wanted, defs) {
  const changes = []; const missing = []; const guessed = [];
  const list = existing || [];
  for (const [label, value] of Object.entries(wanted)) {
    const onEntity = list.find((x) => String(x.label || '').trim().toLowerCase() === label);
    const def = onEntity ? { id: onEntity.customfield_id || onEntity.field_id, api_name: onEntity.api_name, data_type: onEntity.data_type } : defs.resolve(label);
    if (!def || (!def.id && !def.api_name)) { missing.push(label); continue; }
    const want = value === null || value === undefined ? '' : String(value);
    const have = onEntity && onEntity.value !== null && onEntity.value !== undefined ? String(onEntity.value) : '';
    const isNum = def.data_type === 'decimal' || def.data_type === 'number' || (!def.data_type && want !== '' && !Number.isNaN(Number(want)) && /tolerance/.test(label));
    if (want === have || (isNum && Number(want) === Number(have))) continue;
    const upd = { value: isNum ? Number(want) : want };
    if (def.id) upd.customfield_id = def.id; else upd.api_name = def.api_name;
    if (def.guessed) guessed.push(def.api_name);
    changes.push(upd);
  }
  return { changes, missing, guessed };
}

module.exports = { customFieldDefs, customFieldValues };
