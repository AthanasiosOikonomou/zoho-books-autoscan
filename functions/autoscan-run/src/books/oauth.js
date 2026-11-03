'use strict';

/**
 * Zoho OAuth refresh-token flow. Access tokens are cached in memory for the
 * life of the process (one Catalyst invocation) and refreshed 60s before
 * expiry. Nothing here is ever logged.
 */
function accountsHost(dc) {
  // Zoho accounts hosts are not always derivable from the API host; cover the common ones.
  const map = { eu: 'accounts.zoho.eu', com: 'accounts.zoho.com', in: 'accounts.zoho.in', 'com.au': 'accounts.zoho.com.au', jp: 'accounts.zoho.jp', ca: 'accounts.zohocloud.ca', sa: 'accounts.zoho.sa', 'com.cn': 'accounts.zoho.com.cn' };
  return map[dc] || `accounts.zoho.${dc}`;
}

function createTokenProvider({ dc, clientId, clientSecret, refreshToken, fetchImpl = fetch, now = Date.now }) {
  let cached = null; // { token, expiresAt }

  async function refresh() {
    const url = `https://${accountsHost(dc)}/oauth/v2/token`;
    const body = new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    });
    const res = await fetchImpl(url, { method: 'POST', body });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) {
      const err = new Error(`Zoho OAuth refresh failed: ${json.error || res.status}`);
      err.code = 'OAUTH_REFRESH_FAILED';
      throw err;
    }
    const ttl = (Number(json.expires_in) || 3600) * 1000;
    cached = { token: json.access_token, expiresAt: now() + ttl - 60000 };
    return cached.token;
  }

  return {
    async getAccessToken() {
      if (cached && cached.expiresAt > now()) return cached.token;
      return refresh();
    },
    invalidate() { cached = null; },
  };
}

/**
 * One-off exchange of a Self-Client grant code for a refresh token.
 * Used by scripts/books-token.js, never at runtime.
 */
async function exchangeGrantCode({ dc, clientId, clientSecret, code, fetchImpl = fetch }) {
  const url = `https://${accountsHost(dc)}/oauth/v2/token`;
  const body = new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code' });
  const res = await fetchImpl(url, { method: 'POST', body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.refresh_token) {
    throw new Error(`Grant exchange failed: ${json.error || res.status} — ${JSON.stringify(json)}`);
  }
  return json; // { access_token, refresh_token, expires_in, api_domain, ... }
}

module.exports = { createTokenProvider, exchangeGrantCode, accountsHost };
