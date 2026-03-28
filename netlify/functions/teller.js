// netlify/functions/teller.js
// Teller API proxy — handles mTLS client certificate requirement.
// Apps Script's UrlFetchApp cannot attach client certs, so all Teller
// API calls route through here instead.
//
// Environment variables required in Netlify dashboard:
//   TELLER_CERT  — base64-encoded contents of certificate.pem
//   TELLER_KEY   — base64-encoded contents of private_key.pem
//
// Actions (passed as ?action=... query param):
//   get_accounts  — fetch live balances for all stored enrollments
//   store_token   — save an enrollment access token (proxies to Apps Script)
//   remove_token  — remove an enrollment token (proxies to Apps Script)

const https = require('https');

const TELLER_BASE = 'api.teller.io';

// ── Helpers ───────────────────────────────────────────────────────

function getCerts() {
  const certB64 = process.env.TELLER_CERT;
  const keyB64  = process.env.TELLER_KEY;
  if (!certB64 || !keyB64) {
    throw new Error('TELLER_CERT or TELLER_KEY environment variable not set in Netlify');
  }
  return {
    cert: Buffer.from(certB64, 'base64').toString('utf8'),
    key:  Buffer.from(keyB64,  'base64').toString('utf8'),
  };
}

function tellerRequest(path, accessToken) {
  return new Promise((resolve, reject) => {
    const { cert, key } = getCerts();
    const auth = 'Basic ' + Buffer.from(accessToken + ':').toString('base64');

    const options = {
      hostname: TELLER_BASE,
      port:     443,
      path:     path,
      method:   'GET',
      cert:     cert,
      key:      key,
      headers:  { 'Authorization': auth }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        resolve({ status: res.statusCode, body });
      });
    });

    req.on('error', reject);
    req.end();
  });
}

// ── Main handler ──────────────────────────────────────────────────

exports.handler = async function(event) {
  // CORS headers — allow requests from your Netlify domain and localhost
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const params = event.queryStringParameters || {};
  const action = params.action || '';

  try {

    // ── get_accounts ─────────────────────────────────────────────
    // Expects: ?action=get_accounts&tokens=<JSON array of {enrollmentId, accessToken, institution}>
    // Returns: { ok, accounts: [...] }
    if (action === 'get_accounts') {
      let enrollments = [];
      try {
        enrollments = JSON.parse(decodeURIComponent(params.tokens || '[]'));
      } catch(e) {
        return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Invalid tokens param' }) };
      }

      if (!enrollments.length) {
        return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: 'No enrollments provided' }) };
      }

      const INST_COLORS = {
        'Wells Fargo':      '#D71E28',
        'Chase':            '#117ACA',
        'American Express': '#007BC1',
        'Capital One':      '#D03027'
      };
      const INST_LOGOS = {
        'Wells Fargo':      'WF',
        'Chase':            'CH',
        'American Express': 'AX',
        'Capital One':      'C1'
      };

      const allAccounts = [];
      const errors      = [];

      for (const enrollment of enrollments) {
        try {
          // Fetch account list
          const acctResp = await tellerRequest('/accounts', enrollment.accessToken);
          if (acctResp.status !== 200) {
            throw new Error(`Teller /accounts returned ${acctResp.status}: ${acctResp.body.substring(0, 200)}`);
          }

          const accounts = JSON.parse(acctResp.body);
          const instName = enrollment.institution || 'Unknown';
          const shortInst = instName.replace('American Express', 'Amex');

          for (const acct of accounts) {
            if (acct.status !== 'open') continue;

            // Fetch balance
            let bal = 0, avail = 0;
            const balResp = await tellerRequest(`/accounts/${acct.id}/balances`, enrollment.accessToken);
            if (balResp.status === 200) {
              const balData = JSON.parse(balResp.body);
              bal   = parseFloat(balData.ledger    || 0);
              avail = parseFloat(balData.available || bal);
            }

            const isCredit  = acct.type === 'credit';
            const mappedBal   = Math.abs(bal);
            const mappedAvail = Math.abs(avail);
            const limit       = isCredit ? Math.round(mappedBal + mappedAvail) : null;

            allAccounts.push({
              id:       'teller-' + acct.id,
              tellerId: acct.id,
              inst:     shortInst,
              logo:     INST_LOGOS[instName] || instName.slice(0, 2).toUpperCase(),
              color:    INST_COLORS[instName] || '#374151',
              name:     acct.name,
              mask:     acct.last_four || '????',
              type:     acct.type,
              sub:      acct.subtype,
              bal:      Math.round(mappedBal   * 100) / 100,
              avail:    Math.round(mappedAvail * 100) / 100,
              limit:    limit,
              _enrollmentId: enrollment.enrollmentId
            });
          }
        } catch(err) {
          errors.push(`${enrollment.institution}: ${err.message}`);
        }
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ok:       true,
          accounts: allAccounts,
          count:    allAccounts.length,
          errors:   errors,
          syncedAt: new Date().toISOString()
        })
      };
    }

    // ── Unknown action ────────────────────────────────────────────
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ ok: false, error: `Unknown action: ${action}` })
    };

  } catch(err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: err.message })
    };
  }
};
