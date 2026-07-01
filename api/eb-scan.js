// api/eb-scan.js - Scannt Drive nach SKU-Ordnern ohne Eigenbeleg (Spalte K leer)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { password, sheetId } = req.body || {};

  const APP_PASSWORD = process.env.APP_PASSWORD;
  if (APP_PASSWORD && password !== APP_PASSWORD) return res.status(401).json({ error: 'Falsches Passwort' });
  if (!sheetId) return res.status(400).json({ error: 'sheetId fehlt' });

  const SOURCE_FOLDER = 'Screenshots + weiteres - Ankauf';

  try {
    const token = await getGoogleToken();

    // 1. Quellordner in Drive finden
    const folderSearch = await gFetch(
      `https://www.googleapis.com/drive/v3/files?q=name='${encodeURIComponent(SOURCE_FOLDER)}' and mimeType='application/vnd.google-apps.folder' and trashed=false&fields=files(id,name)`,
      token
    );
    if (!folderSearch.files?.length) throw new Error(`Ordner "${SOURCE_FOLDER}" nicht gefunden`);
    const sourceFolder = folderSearch.files[0];

    // 2. Alle Unterordner im Quellordner abrufen
    const subFolders = await gFetch(
      `https://www.googleapis.com/drive/v3/files?q='${sourceFolder.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false&fields=files(id,name)`,
      token
    );
    const folders = subFolders.files || [];
    if (!folders.length) return res.status(200).json({ success: true, skus: [] });

    // 3. SKUs aus Ordnernamen extrahieren (letzten 5 Ziffern suchen)
    const skuPattern = /([A-Z]+-[A-Z]+-\d{5})/i;
    const folderSkus = folders
      .map(f => {
        const match = f.name.match(skuPattern);
        return match ? { sku: match[1].toUpperCase(), folderName: f.name, folderId: f.id } : null;
      })
      .filter(Boolean);

    if (!folderSkus.length) return res.status(200).json({ success: true, skus: [] });

    // 4. Alle Tabellenblätter lesen – SKUs in Spalte L finden, Spalte K prüfen
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}`;
    const meta = await gFetch(`${base}?fields=sheets.properties`, token);
    const sheets = meta.sheets || [];

    // Sheets-Index aufbauen: SKU → { sheetName, row, belnr, artikel, plattform, zahlungsart }
    const sheetsIndex = {};

    for (const sheet of sheets) {
      const title = sheet.properties.title;
      if (title === 'Belegnummern') continue;
      try {
        const resp = await gFetch(
          `${base}/values/${encodeURIComponent("'" + title + "'!A1:AZ500")}`,
          token
        );
        const rows = resp.values || [];
        for (let i = 0; i < rows.length; i++) {
          const skuCell = (rows[i][11] || '').toString().trim(); // Spalte L = Index 11
          if (!skuCell) continue;
          sheetsIndex[skuCell.toUpperCase()] = {
            sheetName: title,
            row: i + 1,
            belnr: (rows[i][10] || '').toString().trim(),  // Spalte K = Index 10
            artikel: (rows[i][6] || '').toString().trim(),  // Spalte G = Index 6
            zahlungsart: (rows[i][49] || '').toString().trim(), // Spalte AX = Index 49
            plattform: (rows[i][50] || '').toString().trim(),   // Spalte AY = Index 50
          };
        }
      } catch(e) { continue; }
    }

    // 5. Nächste Belegnummer aus "Belegnummern" Spalte A
    let nextBelnr = 'EB-2026-001';
    try {
      const belnrResp = await gFetch(
        `${base}/values/${encodeURIComponent("'Belegnummern'!A1:A500")}`,
        token
      );
      const belnrRows = belnrResp.values || [];
      if (belnrRows.length > 0) {
        const lastVal = belnrRows[belnrRows.length - 1][0] || '';
        const match = lastVal.match(/EB-(\d{4})-(\d+)/);
        if (match) {
          nextBelnr = `EB-${match[1]}-${String(parseInt(match[2]) + 1).padStart(3, '0')}`;
        }
      }
    } catch(e) {}

    // 6. Nur SKUs ohne Belegnummer (Spalte K leer) zurückgeben
    const openSkus = folderSkus
      .filter(f => {
        const entry = sheetsIndex[f.sku];
        return entry && !entry.belnr; // In Sheets vorhanden aber Spalte K leer
      })
      .map(f => ({
        ...f,
        ...sheetsIndex[f.sku],
        nextBelnr,
      }))
      // Nach letzten 5 Ziffern der SKU sortieren (aufsteigend)
      .sort((a, b) => {
        const numA = parseInt(a.sku.slice(-5));
        const numB = parseInt(b.sku.slice(-5));
        return numA - numB;
      });

    return res.status(200).json({ success: true, skus: openSkus, total: folderSkus.length });

  } catch(err) {
    console.error('eb-scan error:', err);
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
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function gFetch(url, token, method = 'GET', body = null) {
  const opts = { method, headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(url, opts);
  const json = await resp.json();
  if (!resp.ok) throw new Error(json.error?.message || `Google API ${resp.status}`);
  return json;
}
