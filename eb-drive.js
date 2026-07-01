// api/eb-drive.js - Findet SKU-Ordner in Google Drive und gibt Dateien zurück

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { password, sku } = req.body || {};

  const APP_PASSWORD = process.env.APP_PASSWORD;
  if (APP_PASSWORD && password !== APP_PASSWORD) return res.status(401).json({ error: 'Falsches Passwort' });
  if (!sku) return res.status(400).json({ error: 'SKU fehlt' });

  const SOURCE_FOLDER_NAME = 'Screenshots + weiteres - Ankauf';

  try {
    const token = await getGoogleToken();

    // 1. Quellordner finden
    const folderSearch = await gFetch(
      `https://www.googleapis.com/drive/v3/files?q=name='${SOURCE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false&fields=files(id,name)`,
      token
    );
    if (!folderSearch.files?.length) throw new Error(`Ordner "${SOURCE_FOLDER_NAME}" nicht gefunden`);
    const sourceFolder = folderSearch.files[0];

    // 2. SKU-Unterordner suchen (Name enthält SKU)
    const subSearch = await gFetch(
      `https://www.googleapis.com/drive/v3/files?q=name contains '${sku}' and '${sourceFolder.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false&fields=files(id,name)`,
      token
    );
    if (!subSearch.files?.length) throw new Error(`Kein Ordner mit SKU "${sku}" gefunden`);
    const skuFolder = subSearch.files[0];

    // 3. Alle Dateien im SKU-Ordner abrufen
    const filesSearch = await gFetch(
      `https://www.googleapis.com/drive/v3/files?q='${skuFolder.id}' in parents and trashed=false&fields=files(id,name,mimeType)&orderBy=name`,
      token
    );
    const files = filesSearch.files || [];
    if (!files.length) throw new Error(`Keine Dateien in Ordner "${skuFolder.name}"`);

    // 4. Dateien als Base64 herunterladen (für Vorschau und PDF)
    const filesWithData = await Promise.all(
      files
        .filter(f => f.mimeType.startsWith('image/') || f.mimeType === 'application/pdf')
        .map(async (f) => {
          try {
            const fileResp = await fetch(
              `https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`,
              { headers: { 'Authorization': `Bearer ${token}` } }
            );
            const buffer = await fileResp.arrayBuffer();
            const b64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
            return { id: f.id, name: f.name, mimeType: f.mimeType, thumbnail: b64 };
          } catch(e) {
            return null;
          }
        })
    );

    const validFiles = filesWithData.filter(Boolean);

    return res.status(200).json({
      success: true,
      folderName: skuFolder.name,
      folderId: skuFolder.id,
      files: validFiles,
    });

  } catch(err) {
    console.error('eb-drive error:', err);
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
