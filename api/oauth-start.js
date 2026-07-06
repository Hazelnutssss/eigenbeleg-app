// api/oauth-start.js - Einmaliger Login-Flow: leitet zu Googles Consent-Screen weiter.
// Aufruf im Browser: https://eigenbeleg-app.vercel.app/api/oauth-start?password=DEIN_PASSWORT

export default async function handler(req, res) {
  const { password } = req.query || {};
  const APP_PASSWORD = process.env.APP_PASSWORD;
  if (APP_PASSWORD && password !== APP_PASSWORD) return res.status(401).send('Falsches Passwort');

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!clientId) return res.status(500).send('GOOGLE_OAUTH_CLIENT_ID fehlt in den Umgebungsvariablen');

  const redirectUri = `https://${req.headers.host}/api/oauth-callback`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/drive.file',
    access_type: 'offline',
    prompt: 'consent'
  });

  res.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` });
  res.end();
}
