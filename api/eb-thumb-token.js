// api/eb-thumb-token.js - Gibt ein kurzlebiges (15 Min), signiertes Token aus,
// das statt des echten Passworts in <img>-URLs für eb-thumbnail verwendet wird.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { password } = req.body || {};
  const APP_PASSWORD = process.env.APP_PASSWORD;
  if (APP_PASSWORD && password !== APP_PASSWORD) return res.status(401).json({ error: 'Falsches Passwort' });

  const expires = Date.now() + 15 * 60 * 1000; // 15 Minuten gültig
  const token = await signToken(expires);

  return res.status(200).json({ token, expires });
}

async function signToken(expires) {
  const secret = process.env.APP_PASSWORD || process.env.ANTHROPIC_API_KEY || 'fallback-secret';
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(expires)));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${expires}.${sigB64}`;
}
