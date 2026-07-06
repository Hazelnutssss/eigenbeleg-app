// api/oauth-callback.js - Tauscht den Google-Authorization-Code gegen ein Refresh-Token
// und zeigt es einmalig zum Kopieren an. Dieses Token dann als GOOGLE_OAUTH_REFRESH_TOKEN
// in Vercel eintragen.

export default async function handler(req, res) {
  const { code, error } = req.query || {};

  if (error) {
    return res.status(400).send(`<pre>Fehler von Google: ${error}</pre>`);
  }
  if (!code) {
    return res.status(400).send('<pre>Kein Code erhalten</pre>');
  }

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(500).send('<pre>GOOGLE_OAUTH_CLIENT_ID oder GOOGLE_OAUTH_CLIENT_SECRET fehlt</pre>');
  }

  const redirectUri = `https://${req.headers.host}/api/oauth-callback`;

  try {
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      }).toString()
    });

    const tokenData = await tokenResp.json();

    if (!tokenData.refresh_token) {
      return res.status(400).send(`<pre>Kein Refresh-Token erhalten. Antwort von Google:
${JSON.stringify(tokenData, null, 2)}

Häufigste Ursache: Du hattest der App schon einmal zugestimmt (Google gibt Refresh-Token
nur beim ERSTEN Consent zurück). Fix: Gehe zu https://myaccount.google.com/permissions,
entferne "Eigenbeleg App" aus der Liste, und rufe /api/oauth-start erneut auf.</pre>`);
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(`
      <html><body style="font-family:sans-serif;max-width:600px;margin:40px auto;line-height:1.6">
        <h2>✅ Erfolgreich!</h2>
        <p>Trag folgenden Wert als neue Umgebungsvariable <b>GOOGLE_OAUTH_REFRESH_TOKEN</b> in Vercel ein:</p>
        <textarea style="width:100%;height:80px;font-family:monospace;padding:10px">${tokenData.refresh_token}</textarea>
        <p>Danach diese Seite schließen. Das Token wird nirgends gespeichert außer in deiner Vercel-Umgebungsvariable.</p>
      </body></html>
    `);
  } catch(err) {
    return res.status(500).send(`<pre>Fehler: ${err.message}</pre>`);
  }
}
