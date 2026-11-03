#!/usr/bin/env node
'use strict';

/**
 * One-off: exchange a Self-Client grant code for a refresh token.
 *
 * 1. https://api-console.zoho.eu → Self Client → Generate Code
 *    Scope:    ZohoBooks.fullaccess.all
 *    Duration: 10 minutes
 * 2. Put BOOKS_DC, BOOKS_CLIENT_ID, BOOKS_CLIENT_SECRET in .env
 * 3. node scripts/books-token.js <code>
 * 4. Paste the printed BOOKS_REFRESH_TOKEN into .env (never commit .env)
 *
 * Then `node scripts/books-probe.js` lists the organizations (incl. sandboxes)
 * so you can pick BOOKS_ORG_ID.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { exchangeGrantCode } = require(path.join(__dirname, '..', 'functions', 'autoscan-run', 'src', 'books', 'oauth'));

(async () => {
  const code = process.argv[2];
  if (!code) { console.error('Usage: node scripts/books-token.js <grant_code>'); process.exit(2); }
  const { BOOKS_DC = 'eu', BOOKS_CLIENT_ID, BOOKS_CLIENT_SECRET } = process.env;
  if (!BOOKS_CLIENT_ID || !BOOKS_CLIENT_SECRET) { console.error('Set BOOKS_CLIENT_ID and BOOKS_CLIENT_SECRET in .env first'); process.exit(2); }
  const res = await exchangeGrantCode({ dc: BOOKS_DC, clientId: BOOKS_CLIENT_ID, clientSecret: BOOKS_CLIENT_SECRET, code });
  console.log('\nAdd this line to .env:\n');
  console.log(`BOOKS_REFRESH_TOKEN=${res.refresh_token}\n`);
  console.log(`(api_domain reported by Zoho: ${res.api_domain || 'n/a'})`);
})().catch((err) => { console.error(err.message); process.exit(1); });
