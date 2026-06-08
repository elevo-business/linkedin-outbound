#!/usr/bin/env node
// Import leads from a CSV file into the database.
//   node scripts/import-leads.js leads.csv
//
// Expected header columns (case-insensitive, order-free):
//   linkedin_url, name, headline, company, role, location, email, notes
// Only linkedin_url is required. `email` enables the optional email fallback channel.

import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { Db } from '../src/db/db.js';
import { Leads } from '../src/db/leads.js';

// Minimal RFC-4180-ish CSV parser (handles quotes, commas, newlines in fields).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* ignore */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/import-leads.js <leads.csv>');
    process.exit(1);
  }
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  if (rows.length < 2) {
    console.error('CSV has no data rows.');
    process.exit(1);
  }
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (name) => header.indexOf(name);
  const urlCol = idx('linkedin_url');
  if (urlCol === -1) {
    console.error('CSV must have a "linkedin_url" column.');
    process.exit(1);
  }

  const config = loadConfig();
  const db = new Db(config.dbPath);
  const leads = new Leads(db);

  let imported = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const url = (row[urlCol] || '').trim();
    if (!url) continue;
    leads.upsert({
      linkedin_url: url,
      name: pick(row, idx('name')),
      headline: pick(row, idx('headline')),
      company: pick(row, idx('company')),
      role: pick(row, idx('role')),
      location: pick(row, idx('location')),
      email: pick(row, idx('email')),
      notes: pick(row, idx('notes')),
    });
    imported++;
  }
  console.log(`Imported/updated ${imported} leads into ${config.dbPath}`);
  db.close();
}

const pick = (row, i) => (i === -1 ? null : (row[i] || '').trim() || null);

main();
