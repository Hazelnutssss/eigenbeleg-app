// api/eb-sheets.js - Sucht SKU in allen Tabellenblättern + liest Daten

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { password, sheetId, sku } = req.body || {};

  const APP_PASSWORD = process.env.APP_PASSWORD;
  if (APP_PASSWORD && password !== APP_PASSWORD) return res.status(401).json({ error: 'Falsches Passwort' });
  if (!sheetId) return res.status(400).json({ error: 'sheetId fehlt' });
  if (!sku) return res.status(400).json({ error: 'SKU fehlt' });

  try {
    const token = await getGoogleToken();
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}`;

    // Alle Tabellenblätter abrufen
    const meta = await gFetch(`${base}?fields=sheets.properties`, token);
    const sheets = meta.sheets || [];

    let foundSheet = null, foundRow = -1, rowData = null;

    // SKU in Spalte L (Index 11) in jedem Blatt suchen
    for (const sheet of sheets) {
      const title = sheet.properties.title;
      if (title === 'Belegnummern') continue; // Überspringen

      try {
        const resp = await gFetch(
          `${base}/values/${encodeURIComponent("'" + title + "'!L1:L500")}`,
          token
        );
        const rows = resp.values || [];
        for (let i = 0; i < rows.length; i++) {
          const cell = (rows[i][0] || '').toString().trim();
          if (cell.toLowerCase() === sku.toLowerCase()) {
            foundSheet = title;
            foundRow = i + 1;
            break;
          }
        }
        if (foundSheet) break;
      } catch(e) {
        // Tabellenblatt überspringen falls Fehler
        continue;
      }
    }

    if (!foundSheet) return res.status(404).json({ error: `SKU "${sku}" nicht in Tabelle gefunden` });

    // Zeile lesen für Artikel (G), Plattform (AY=51), Zahlungsart (AX=50)
    const rowResp = await gFetch(
      `${base}/values/${encodeURIComponent("'" + foundSheet + "'!A" + foundRow + ':AZ' + foundRow)}`,
      token
    );
    rowData = rowResp.values?.[0] || [];

    const artikel = rowData[6] || '';       // Spalte G = Index 6
    const zahlungsart = rowData[49] || '';  // Spalte AX = Index 49
    const plattform = rowData[50] || '';    // Spalte AY = Index 50

    // Nächste Belegnummer aus Tabellenblatt "Belegnummern" Spalte A
    let nextBelnr = 'EB-2026-001';
    try {
      const belnrResp = await gFetch(
        `${base}/values/${encodeURIComponent("'Belegnummern'!A1:A500")}`,
        token
      );
      const belnrRows = belnrResp.values || [];
      if (belnrRows.length > 0) {
        const lastVal = belnrRows[belnrRows.length - 1][0] || '';
        // Inkrementieren: EB-2026-003 → EB-2026-004
        const match = lastVal.match(/EB-(\d{4})-(\d+)/);
        if (match) {
          const year = match[1];
          const num = parseInt(match[2]) + 1;
          nextBelnr = `EB-${year}-${String(num).padStart(3, '0')}`;
        }
      }
    } catch(e) {
      // Belegnummern-Blatt noch leer oder nicht vorhanden
    }

    return res.status(200).json({
      success: true,
      sheetName: foundSheet,
      row: foundRow,
      artikel,
      zahlungsart,
      plattform,
      nextBelnr,
    });

  } catch(err) {
    console.error('eb-sheets error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function getGoogleToken() {
  const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
  if (!sa.private_key) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON fehlt');
  const now = Math.floor(Date.now() / 1000);
  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  }));
  const signInput = `${header}.${payload}`;
  const key = await importKey(sa.private_key);
  const sig = await signJWT(signInput, key);
  const jwt = `${signInput}.${sig}`;
  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  const td = await tokenResp.json();
  if (!td.access_token) throw new Error('Google Auth fehlgeschlagen');
  return td.access_token;
}

async function importKey(pem) {
  const pemContents = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n/g, '');
  const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', binaryDer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

async function signJWT(data, key) {
  const encoder = new TextEncoder();
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function gFetch(url, token, method = 'GET', body = null) {
  const opts = { method, headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(url, opts);
  const json = await resp.json();
  if (!resp.ok) throw new Error(json.error?.message || `Google API ${resp.status}`);
  return json;
}
