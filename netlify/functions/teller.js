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
const fs    = require('fs');
const path  = require('path');

const TELLER_BASE = 'api.teller.io';

// ── Helpers ───────────────────────────────────────────────────────

function getCerts() {
  // Cert files are bundled alongside this function in netlify/functions/
  const dir  = path.join(__dirname);
  const cert = fs.readFileSync(path.join(dir, 'certificate.pem'), 'utf8');
  const key  = fs.readFileSync(path.join(dir, 'private_key.pem'),  'utf8');
  return { cert, key };
}

function tellerRequest(path, accessToken, timeoutMs = 20000) {
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
      headers:  { 'Authorization': auth },
      timeout:  timeoutMs
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        resolve({ status: res.statusCode, body });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 408, body: '{"error":{"message":"Request timed out","code":"timeout"}}' });
    });

    req.on('error', (err) => {
      if (err.code === 'ECONNRESET' || err.message.includes('socket hang up')) {
        resolve({ status: 408, body: '{"error":{"message":"Connection reset","code":"timeout"}}' });
      } else {
        reject(err);
      }
    });
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

      // Fetch all enrollments in parallel — faster and prevents one slow bank blocking others
      const results = await Promise.all(enrollments.map(async (enrollment) => {
        const instName  = enrollment.institution || 'Unknown';
        const shortInst = instName.replace('American Express', 'Amex');
        const accounts  = [];
        let   error     = null;
        let   disconnected = false;

        try {
          const acctResp = await tellerRequest('/accounts', enrollment.accessToken);
          if (acctResp.status !== 200) {
            const body = JSON.parse(acctResp.body);
            const code = body?.error?.code || '';
            disconnected = code.startsWith('enrollment.disconnected');
            throw new Error(`${instName}: Teller /accounts returned ${acctResp.status}: ${acctResp.body.substring(0, 200)}`);
          }

          const acctList = JSON.parse(acctResp.body);

          // Fetch all balances in parallel within this enrollment
          await Promise.all(acctList.map(async (acct) => {
            if (acct.status !== 'open') return;

            let bal = 0, avail = 0;
            try {
              const balResp = await tellerRequest(`/accounts/${acct.id}/balances`, enrollment.accessToken, 15000);
              if (balResp.status === 200) {
                const balData = JSON.parse(balResp.body);
                bal   = parseFloat(balData.ledger    || 0);
                avail = parseFloat(balData.available || bal);
              }
            } catch(balErr) { /* show $0 if balance fetch fails */ }

            const isCredit    = acct.type === 'credit';
            const mappedBal   = Math.abs(bal);
            const mappedAvail = Math.abs(avail);

            accounts.push({
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
              limit:    isCredit ? Math.round(mappedBal + mappedAvail) : null,
              _enrollmentId: enrollment.enrollmentId
            });
          }));

        } catch(err) {
          error = { institution: instName, enrollmentId: enrollment.enrollmentId, message: err.message, disconnected };
        }

        return { accounts, error };
      }));

      const allAccounts = results.flatMap(r => r.accounts);
      const disconnected = results.filter(r => r.error && r.error.disconnected).map(r => r.error);
      const otherErrors  = results.filter(r => r.error && !r.error.disconnected).map(r => `${r.error.institution}: ${r.error.message}`);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ok:           true,
          accounts:     allAccounts,
          count:        allAccounts.length,
          errors:       otherErrors,
          disconnected: disconnected,
          syncedAt:     new Date().toISOString()
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
