'use strict';

const { createRateLimiter } = require('../util/limiter');

/**
 * Zoho Books v3 client — only the calls AutoScan needs.
 *
 *  - every call goes through the rate limiter (org cap 100/min)
 *  - 429 / 5xx / network errors are retried with backoff
 *  - Books envelope `code != 0` becomes a BooksError with the Books code
 *  - a daily-limit response raises BooksError{code:'BOOKS_DAILY_LIMIT'} so the
 *    run can stop cleanly instead of hammering the API
 *
 * The Documents endpoints are undocumented by Zoho; the shapes below are the
 * ones proven by the previous implementation on this org.
 */
class BooksError extends Error {
  constructor(message, { code, httpStatus, booksCode, path } = {}) {
    super(message);
    this.name = 'BooksError';
    this.code = code || 'BOOKS_ERROR';
    this.httpStatus = httpStatus;
    this.booksCode = booksCode;
    this.path = path;
  }
}

function createBooksClient({ config, tokenProvider, logger, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const base = `https://www.zohoapis.${config.dc}/books/v3`;
  const orgId = config.orgId;
  const limiter = createRateLimiter({ perMinute: config.ratePerMin });
  const stats = { calls: 0, retries: 0 };

  function url(path, query = {}) {
    const u = new URL(base + path);
    u.searchParams.set('organization_id', orgId);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  /**
   * Core request. opts: { method, query, json, form, raw }
   *  raw=true → returns { buffer, contentType, fileName } instead of parsed JSON
   */
  async function request(path, opts = {}) {
    const method = opts.method || 'GET';
    const maxRetries = config.maxRetries ?? 3;
    let attempt = 0;

    for (;;) {
      await limiter.take();
      stats.calls += 1;
      const token = await tokenProvider.getAccessToken();
      const headers = { Authorization: `Zoho-oauthtoken ${token}` };
      let body;
      if (opts.json) {
        // Books accepts JSON either as raw body or as JSONString form field; raw JSON works for v3.
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(opts.json);
      } else if (opts.form) {
        body = opts.form; // FormData (multipart)
      }

      let res;
      try {
        res = await fetchImpl(url(path, opts.query), { method, headers, body });
      } catch (netErr) {
        if (attempt < maxRetries) { attempt++; stats.retries++; await sleep(backoff(attempt)); continue; }
        throw new BooksError(`Network error calling Books ${path}: ${netErr.message}`, { code: 'BOOKS_NETWORK', path });
      }

      if (res.status === 401 && attempt === 0) {
        tokenProvider.invalidate();
        attempt++; stats.retries++;
        continue;
      }

      if (res.status === 429 || res.status >= 500) {
        const text = await res.text().catch(() => '');
        if (isDailyLimit(res.status, text)) {
          throw new BooksError('Zoho Books daily API limit reached', { code: 'BOOKS_DAILY_LIMIT', httpStatus: res.status, path });
        }
        if (attempt < maxRetries) { attempt++; stats.retries++; await sleep(backoff(attempt)); continue; }
        throw new BooksError(`Books ${path} failed with HTTP ${res.status}`, { code: 'BOOKS_HTTP', httpStatus: res.status, path });
      }

      if (opts.raw) {
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new BooksError(`Books ${path} HTTP ${res.status}: ${text.slice(0, 200)}`, { code: 'BOOKS_HTTP', httpStatus: res.status, path });
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        return { buffer, contentType: res.headers.get('content-type') || '', fileName: parseFileName(res.headers.get('content-disposition')) };
      }

      const json = await res.json().catch(() => null);
      if (!json) {
        throw new BooksError(`Books ${path} returned non-JSON (HTTP ${res.status})`, { code: 'BOOKS_HTTP', httpStatus: res.status, path });
      }
      if (typeof json.code === 'number' && json.code !== 0) {
        throw new BooksError(`Books ${path}: ${json.message || 'error'} (code ${json.code})`, { code: 'BOOKS_API', httpStatus: res.status, booksCode: json.code, path });
      }
      if (!res.ok) {
        throw new BooksError(`Books ${path} HTTP ${res.status}`, { code: 'BOOKS_HTTP', httpStatus: res.status, path });
      }
      return json;
    }
  }

  function backoff(attempt) { return Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250); }

  // ---------------------------------------------------------------- Documents (undocumented API)
  async function listInboxDocuments({ page = 1, perPage = config.inboxPageSize } = {}) {
    const json = await request('/documents', { query: { view: 'inbox', page, per_page: perPage } });
    return { documents: json.documents || [], pageContext: json.page_context || {} };
  }

  async function listAllInboxDocuments() {
    const all = [];
    let page = 1;
    for (;;) {
      const { documents, pageContext } = await listInboxDocuments({ page });
      all.push(...documents);
      if (!pageContext.has_more_page || documents.length === 0) break;
      page += 1;
      if (page > 200) break; // safety: 40k docs
    }
    return all;
  }

  async function downloadDocument(documentId) {
    return request(`/documents/${documentId}`, { raw: true });
  }

  async function deleteDocument(documentId) {
    return request(`/documents/${documentId}`, { method: 'DELETE' });
  }

  // ---------------------------------------------------------------- Purchase orders
  async function searchPurchaseOrders(query) {
    // query: { purchaseorder_number } | { reference_number } | { purchaseorder_number_contains }
    const json = await request('/purchaseorders', { query });
    return json.purchaseorders || [];
  }

  async function getPurchaseOrder(id) {
    const json = await request(`/purchaseorders/${id}`);
    return json.purchaseorder;
  }

  // ---------------------------------------------------------------- Bills
  async function searchBills(query) {
    // query: { vendor_id, bill_number } | { purchaseorder_id }
    const json = await request('/bills', { query });
    return json.bills || [];
  }

  async function getBillFromPurchaseOrders(purchaseOrderId) {
    const json = await request('/bills/editpage/frompurchaseorders', { query: { purchaseorder_ids: purchaseOrderId } });
    return json.bill;
  }

  async function createBill(payload) {
    const json = await request('/bills', { method: 'POST', json: payload });
    return json.bill;
  }

  async function markBillOpen(billId) {
    return request(`/bills/${billId}/status/open`, { method: 'POST' });
  }

  async function getBill(billId) {
    const json = await request(`/bills/${billId}`);
    return json.bill;
  }

  async function attachToBill(billId, buffer, fileName, mime) {
    const form = new FormData();
    form.append('attachment', new Blob([buffer], { type: mime }), fileName);
    return request(`/bills/${billId}/attachment`, { method: 'POST', form });
  }

  // ---------------------------------------------------------------- Vendor credits (supplier credit notes)
  async function searchVendorCredits(query) {
    // query: { vendor_id, vendor_credit_number }
    const json = await request('/vendorcredits', { query });
    return json.vendor_credits || json.vendorcredits || [];
  }
  async function createVendorCredit(payload) {
    const json = await request('/vendorcredits', { method: 'POST', json: payload });
    return json.vendor_credit;
  }
  async function markVendorCreditOpen(id) {
    return request(`/vendorcredits/${id}/status/open`, { method: 'POST' });
  }
  async function deleteVendorCredit(id) {
    return request(`/vendorcredits/${id}`, { method: 'DELETE' });
  }
  /** Apply (part of) a vendor credit to a bill. */
  async function applyVendorCreditToBill(creditId, billId, amount) {
    return request(`/vendorcredits/${creditId}/bills`, { method: 'POST', json: { bills: [{ bill_id: billId, amount_applied: amount }] } });
  }
  async function attachToVendorCredit(id, buffer, fileName, mime) {
    const form = new FormData();
    form.append('attachment', new Blob([buffer], { type: mime }), fileName);
    return request(`/vendorcredits/${id}/attachment`, { method: 'POST', form });
  }

  // ---------------------------------------------------------------- Settings / contacts / items
  async function getPaymentTerms() {
    // The list key differs between DCs/versions (payment_terms | paymentterms | payment_terms_settings…): take the first array of term objects.
    const json = await request('/settings/paymentterms');
    const data = json.data && typeof json.data === 'object' ? json.data : {};
    const candidates = [json.payment_terms, data.payment_terms, json.paymentterms, ...Object.values(json), ...Object.values(data)].filter(Array.isArray);
    const list = candidates.find((a) => a.some((t) => t && (t.payment_terms_label !== undefined || t.payment_terms !== undefined))) || [];
    return list.map((t) => ({ ...t, payment_terms: Number(t.payment_terms) }));
  }

  async function getContact(contactId) {
    const json = await request(`/contacts/${contactId}`);
    return json.contact;
  }
  async function getItem(itemId) {
    const json = await request(`/items/${itemId}`);
    return json.item;
  }

  async function listOrganizations() {
    const json = await request('/organizations');
    return json.organizations || [];
  }

  return {
    request,
    stats,
    listInboxDocuments,
    listAllInboxDocuments,
    downloadDocument,
    deleteDocument,
    searchPurchaseOrders,
    getPurchaseOrder,
    searchBills,
    getBillFromPurchaseOrders,
    createBill,
    markBillOpen,
    getBill,
    attachToBill,
    searchVendorCredits,
    createVendorCredit,
    markVendorCreditOpen,
    deleteVendorCredit,
    applyVendorCreditToBill,
    attachToVendorCredit,
    getPaymentTerms,
    getContact,
    getItem,
    listOrganizations,
  };
}

function isDailyLimit(status, text) {
  const t = (text || '').toLowerCase();
  return status === 429 && (t.includes('day') || t.includes('daily') || t.includes('limit'));
}

function parseFileName(cd) {
  if (!cd) return '';
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  return m ? decodeURIComponent(m[1]) : '';
}

module.exports = { createBooksClient, BooksError };
