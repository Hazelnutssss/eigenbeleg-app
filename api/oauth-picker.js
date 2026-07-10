// api/oauth-picker.js - Liefert die Ordner-Auswahl-Seite (Google Picker) als HTML aus.
// Als API-Route gebaut, damit die Catch-All-Rewrite-Regel in vercel.json sie nicht abfängt.
// Aufruf: https://eigenbeleg-app.vercel.app/api/oauth-picker

export default async function handler(req, res) {
  const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
  const API_KEY = process.env.GOOGLE_PICKER_API_KEY || '';

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(`<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ordner freigeben</title>
<style>
  body { background:#111318; color:#eef0f4; font-family:-apple-system,sans-serif; max-width:480px; margin:0 auto; padding:24px 20px; line-height:1.6; }
  h2 { font-size:18px; margin-bottom:8px; }
  p { color:#9aa3b5; font-size:14px; }
  button { width:100%; padding:15px; background:#6d8cff; border:none; border-radius:12px; color:#fff; font-size:15px; font-weight:600; cursor:pointer; margin-top:16px; }
  button:disabled { opacity:0.4; }
  .status { margin-top:20px; padding:14px; border-radius:10px; font-size:13px; display:none; }
  .status.ok { background:rgba(52,211,153,0.1); border:1px solid rgba(52,211,153,0.25); color:#34d399; display:block; }
  .status.err { background:rgba(248,113,113,0.1); border:1px solid rgba(248,113,113,0.25); color:#f87171; display:block; }
</style>
</head>
<body>
  <h2>&#128193; Ordner freigeben</h2>
  <p>W&auml;hle im n&auml;chsten Schritt genau den Ordner <b>"Eigenbelege"</b> in deinem Google Drive aus. Nur dieser Ordner (und was du sonst noch bewusst ausw&auml;hlst) wird f&uuml;r die App zug&auml;nglich &ndash; nicht dein restliches Drive.</p>
  <button id="btn" onclick="startPicker()">Google-Login &amp; Ordner ausw&auml;hlen</button>
  <div class="status" id="status"></div>

<script src="https://accounts.google.com/gsi/client"></script>
<script src="https://apis.google.com/js/api.js"></script>
<script>
  const CLIENT_ID = '${CLIENT_ID}';
  const API_KEY = '${API_KEY}';
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';

  let tokenClient;

  window.addEventListener('load', () => {
    gapi.load('picker', () => {});
  });

  function startPicker() {
    if (!CLIENT_ID) {
      showStatus('err', 'GOOGLE_OAUTH_CLIENT_ID fehlt in den Vercel-Umgebungsvariablen.');
      return;
    }
    if (!API_KEY) {
      showStatus('err', 'GOOGLE_PICKER_API_KEY fehlt in den Vercel-Umgebungsvariablen.');
      return;
    }
    document.getElementById('btn').disabled = true;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: (resp) => {
        if (resp.error) {
          showStatus('err', 'Fehler beim Login: ' + resp.error);
          document.getElementById('btn').disabled = false;
          return;
        }
        showPicker(resp.access_token);
      }
    });
    tokenClient.requestAccessToken({ prompt: 'consent' });
  }

  function showPicker(accessToken) {
    const view = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
      .setSelectFolderEnabled(true)
      .setIncludeFolders(true);

    const picker = new google.picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(accessToken)
      .setDeveloperKey(API_KEY)
      .setCallback((data) => {
        console.log('Picker callback:', JSON.stringify(data));
        const action = data.action;
        if (action === google.picker.Action.PICKED || action === 'picked') {
          const folder = data.docs && data.docs[0];
          const name = folder ? folder.name : '(unbekannt)';
          showStatus('ok', '\u2705 Zugriff erteilt f\u00fcr: "' + name + '". Du kannst dieses Fenster jetzt schlie\u00dfen und mit /api/oauth-start fortfahren.');
        } else if (action === google.picker.Action.CANCEL || action === 'cancel') {
          document.getElementById('btn').disabled = false;
        } else {
          console.log('Unbekannte Aktion:', action);
        }
      })
      .build();
    picker.setVisible(true);
  }

  function showStatus(type, msg) {
    const el = document.getElementById('status');
    el.className = 'status ' + type;
    el.textContent = msg;
  }
</script>
</body>
</html>`);
}
