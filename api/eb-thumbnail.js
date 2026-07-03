// api/eb-thumbnail.js - Liefert eine einzelne Drive-Datei (Bild) als Vorschau aus
// Wird per <img src="/api/eb-thumbnail?fileId=...&password=..."> lazy nachgeladen,
// damit die Galerie nicht alle Bilder auf einmal per JSON/Base64 laden muss.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  const { fileId, token } = req.query || {};

  if (!fileId) return res.status(400).end();
  const valid = await verifyToken(token);
  if (!valid) return res.status(401).end();

  try {
    const token = await getGoogleToken();

    const meta = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,mimeType`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const metaData = await meta.json();
    if (!metaData.mimeType?.startsWith('image/')) return res.status(415).end();

    const fileResp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    if (!fileResp.ok) return res.status(502).end();

    const buffer = await fileResp.arrayBuffer();

    res.setHeader('Content-Type', metaData.mimeType);
    // 1 Tag Browser-Cache – Dateien in Drive ändern sich für diese Pipeline nicht mehr,
    // sobald ein Ordner "abgearbeitet" ist ohnehin nicht mehr relevant
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.status(200).send(Buffer.from(buffer));

  } catch(err) {
    console.error('eb-thumbnail error:', err);
    return res.status(500).end();
  }
}

async function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [expiresStr, sig] = token.split('.');
  const expires = parseInt(expiresStr, 10);
  if (!expires || isNaN(expires) || Date.now() > expires) return false;

  const secret = process.env.APP_PASSWORD || process.env.ANTHROPIC_API_KEY || 'fallback-secret';
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const expectedSigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(expires)));
  const expectedSig = btoa(String.fromCharCode(...new Uint8Array(expectedSigBuf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  return expectedSig === sig;
}

async function getGoogleToken() {
  const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
  if (!sa.private_key) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON fehlt');
  const now = Math.floor(Date.now() / 1000);
  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
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
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
