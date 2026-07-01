// api/eb-extract.js - Lädt Dateien direkt aus Drive und extrahiert mit Claude Vision

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { password, fileIds } = req.body || {};

  const APP_PASSWORD = process.env.APP_PASSWORD;
  if (APP_PASSWORD && password !== APP_PASSWORD) return res.status(401).json({ error: 'Falsches Passwort' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY fehlt' });
  if (!fileIds?.length) return res.status(400).json({ error: 'Keine Dateien übergeben' });

  try {
    const token = await getGoogleToken();

    // Dateien direkt aus Drive laden (max 4)
    const imageFiles = [];
    for (const fileId of fileIds.slice(0, 4)) {
      try {
        // Datei-Metadaten laden
        const meta = await fetch(
          `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType`,
          { headers: { 'Authorization': `Bearer ${token}` } }
        );
        const metaData = await meta.json();
        if (!metaData.mimeType?.startsWith('image/')) continue;

        // Datei herunterladen
        const fileResp = await fetch(
          `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
          { headers: { 'Authorization': `Bearer ${token}` } }
        );
        const buffer = await fileResp.arrayBuffer();
        const b64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
        imageFiles.push({ mimeType: metaData.mimeType, data: b64 });
      } catch(e) {
        continue;
      }
    }

    if (!imageFiles.length) {
      return res.status(200).json({
        success: true,
        verkauferName: '', verkauferAdresse: '', datum: '', betrag: '',
        note: 'Keine Bilddateien geladen'
      });
    }

    const prompt = `Analysiere diese Bilder. Es sind Dokumente zu einem Privatankauf (Zahlungsnachweis, Versandetikett, Anzeige, Chat).

Extrahiere folgende Felder als JSON-Objekt. Antworte NUR mit dem JSON, ohne Erklärung, ohne Markdown.

{
  "verkauferName": "Vollständiger Name des Verkäufers (Priorität: Zahlungsnachweis/PayPal/Überweisung, dann Versandetikett Absender)",
  "verkauferAdresse": "Straße Hausnr, PLZ Stadt des Verkäufers vom Versandetikett Absenderfeld (leer lassen wenn nicht erkennbar)",
  "datum": "Datum der Zahlung im Format TT. Mon JJJJ (z.B. 21. Jun 2026)",
  "betrag": "Gezahlter Betrag mit € (z.B. 34,99 €)"
}

Wichtig:
- Verkäufername aus Zahlungsnachweis hat höchste Priorität
- Adresse nur vom Versandetikett Absenderfeld
- Falls ein Feld nicht erkennbar ist: leeren String zurückgeben`;

    const content = [
      ...imageFiles.map(f => ({
        type: 'image',
        source: { type: 'base64', media_type: f.mimeType, data: f.data }
      })),
      { type: 'text', text: prompt }
    ];

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        messages: [{ role: 'user', content }]
      })
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error?.message || `Claude API ${resp.status}`);

    const text = data.content[0].text.replace(/```json|```/g, '').trim();
    const extracted = JSON.parse(text);

    return res.status(200).json({ success: true, ...extracted });

  } catch(err) {
    console.error('eb-extract error:', err);
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
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
