// api/eb-generate.js - PDF erstellen, in Drive speichern, Belegnummer in Sheets

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { password, sheetId, sheetName, sheetRow, belnr, sku, artikel, datum,
          betrag, plattform, zahlungsart, verkauferName, verkauferAdresse,
          kaeuferName, kaeuferStreet, kaeuferCity, files, ausstellungsdatum,
          folderDriveId } = req.body || {};

  const APP_PASSWORD = process.env.APP_PASSWORD;
  if (APP_PASSWORD && password !== APP_PASSWORD) return res.status(401).json({ error: 'Falsches Passwort' });

  const TARGET_FOLDER_NAME = 'Eigenbelege';

  try {
    const token = await getGoogleToken();

    // 1. PDF als HTML aufbauen und per Puppeteer-Alternative generieren
    // Da wir in Vercel serverless sind, nutzen wir eine HTML→PDF Methode via jsPDF-kompatibles Format
    // Wir bauen das PDF als base64 manuell auf (vereinfachte PDF-Struktur)
    const pdfBase64 = buildPDF({
      belnr, sku, artikel, datum, betrag, plattform, zahlungsart,
      verkauferName, verkauferAdresse, kaeuferName, kaeuferStreet, kaeuferCity,
      ausstellungsdatum, files
    });

    const filename = `${belnr}_${sku}.pdf`;

    // 2. Zielordner "Eigenbelege" in Drive finden
    const folderSearch = await gFetch(
      `https://www.googleapis.com/drive/v3/files?q=name='${TARGET_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false&fields=files(id,name)`,
      token
    );
    if (!folderSearch.files?.length) throw new Error(`Ordner "${TARGET_FOLDER_NAME}" nicht gefunden in Drive`);
    const targetFolder = folderSearch.files[0];

    // 3. PDF in Drive hochladen (Multipart Upload)
    const boundary = '-------314159265358979323846';
    const metadata = JSON.stringify({ name: filename, parents: [targetFolder.id] });
    const pdfBytes = Uint8Array.from(atob(pdfBase64), c => c.charCodeAt(0));

    const multipartBody = [
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
      `--${boundary}\r\nContent-Type: application/pdf\r\nContent-Transfer-Encoding: base64\r\n\r\n${pdfBase64}\r\n`,
      `--${boundary}--`
    ].join('');

    const uploadResp = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary="${boundary}"`,
        },
        body: multipartBody
      }
    );
    const uploadData = await uploadResp.json();
    if (!uploadResp.ok) throw new Error(uploadData.error?.message || 'Drive Upload fehlgeschlagen');

    // 4. Belegnummer in Sheets Spalte K der SKU-Zeile eintragen
    await gFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`,
      token, 'POST', {
        valueInputOption: 'USER_ENTERED',
        data: [{
          range: `'${sheetName}'!K${sheetRow}`,
          values: [[belnr]]
        }]
      }
    );

    // 5. Belegnummer in "Belegnummern" Spalte A nächste leere Zeile eintragen
    const belnrResp = await gFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent("'Belegnummern'!A1:A500")}`,
      token
    );
    const belnrRows = belnrResp.values || [];
    const nextRow = belnrRows.length + 1;

    await gFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`,
      token, 'POST', {
        valueInputOption: 'USER_ENTERED',
        data: [{
          range: `'Belegnummern'!A${nextRow}`,
          values: [[belnr]]
        }]
      }
    );

    // 6. Quellordner nach "abgearbeitet" verschieben
    if (folderDriveId) {
      const DONE_FOLDER = 'Screenshots + weiteres - Ankauf - abgearbeitet';
      // Zielordner suchen oder erstellen
      const doneFolderSearch = await gFetch(
        `https://www.googleapis.com/drive/v3/files?q=name='${DONE_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false&fields=files(id,name)`,
        token
      );
      let doneFolderId;
      if (doneFolderSearch.files?.length) {
        doneFolderId = doneFolderSearch.files[0].id;
      } else {
        // Ordner erstellen falls nicht vorhanden
        const createResp = await fetch('https://www.googleapis.com/drive/v3/files', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: DONE_FOLDER, mimeType: 'application/vnd.google-apps.folder' })
        });
        const createData = await createResp.json();
        doneFolderId = createData.id;
      }

      // Ordner verschieben (Parent wechseln)
      const folderMeta = await gFetch(
        `https://www.googleapis.com/drive/v3/files/${folderDriveId}?fields=parents`,
        token
      );
      const oldParents = (folderMeta.parents || []).join(',');
      await fetch(
        `https://www.googleapis.com/drive/v3/files/${folderDriveId}?addParents=${doneFolderId}&removeParents=${oldParents}&fields=id`,
        { method: 'PATCH', headers: { 'Authorization': `Bearer ${token}` } }
      );
    }

    return res.status(200).json({ success: true, filename, belnr, driveFileId: uploadData.id });

  } catch(err) {
    console.error('eb-generate error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─── PDF Builder ──────────────────────────────────────────────────────────────
function buildPDF({ belnr, sku, artikel, datum, betrag, plattform, zahlungsart,
                    verkauferName, verkauferAdresse, kaeuferName, kaeuferStreet,
                    kaeuferCity, ausstellungsdatum, files }) {

  // PDF als strukturiertes Dokument mit eingebetteten Bildern
  // Verwendet jsPDF-style Aufbau als base64-encodiertes PDF

  const today = ausstellungsdatum || new Date().toLocaleDateString('de-DE');

  // Seite 1: Deckblatt
  const deckblatt = `
EIGENBELEG
Belegnummer: ${belnr}
Ausstellungsdatum: ${today}

KÄUFER / AUSSTELLER
${kaeuferName}
${kaeuferStreet}
${kaeuferCity}

ANGABEN ZUM KAUF
SKU: ${sku}
Artikelbeschreibung: ${artikel}
Kaufdatum: ${datum}
Betrag: ${betrag}
Plattform: ${plattform}
Zahlungsart: ${zahlungsart}
Verkäufer: ${verkauferName || '–'}
${verkauferAdresse ? 'Adresse: ' + verkauferAdresse : ''}
`;

  // Seite 2: Formaler Eigenbeleg
  const eigenbeleg = `
EIGENBELEG
Belegnummer: ${belnr}
Ausstellungsdatum: ${today}

Käufer / Aussteller:
${kaeuferName}
${kaeuferStreet}
${kaeuferCity}

Zahlungsempfänger (Verkäufer):
${verkauferName || '–'}
${verkauferAdresse || ''}

ANGABEN ZUR AUFWENDUNG
Datum der Zahlung: ${datum}
Art der Aufwendung: Ankauf Gebrauchtware für Wiederverkauf
Artikelbeschreibung: ${artikel}
SKU: ${sku}
Plattform: ${plattform}
Zahlungsart: ${zahlungsart}
Gesamtbetrag: ${betrag}

BEGRÜNDUNG
Ankauf von Privatperson (nicht gewerblich);
Verkäufer stellt üblicherweise keine Rechnung/Quittung aus.

Unterschrift Käufer / Aussteller:

___________________________
${kaeuferName} · ${today}
`;

  // Einfaches PDF mit Text und Bildern konstruieren
  return createSimplePDF(deckblatt, eigenbeleg, files || []);
}

function createSimplePDF(deckblatt, eigenbeleg, files) {
  // Minimal-PDF Struktur die von allen Readern geöffnet werden kann
  const objects = [];
  let objCount = 0;

  function addObj(content) {
    objCount++;
    objects.push({ id: objCount, content });
    return objCount;
  }

  // Catalog
  const catalogId = addObj(`<< /Type /Catalog /Pages 2 0 R >>`);
  const pagesId = addObj(''); // Wird später gefüllt

  // Seite 1: Deckblatt
  const font1Id = addObj(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);
  const page1ContentStr = pdfTextPage(deckblatt);
  const p1cId = addObj(`<< /Length ${page1ContentStr.length} >>\nstream\n${page1ContentStr}\nendstream`);
  const page1Id = addObj(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${p1cId} 0 R /Resources << /Font << /F1 ${font1Id} 0 R >> >> >>`);

  // Seite 2: Eigenbeleg
  const page2ContentStr = pdfTextPage(eigenbeleg);
  const p2cId = addObj(`<< /Length ${page2ContentStr.length} >>\nstream\n${page2ContentStr}\nendstream`);
  const page2Id = addObj(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${p2cId} 0 R /Resources << /Font << /F1 ${font1Id} 0 R >> >> >>`);

  const pageIds = [page1Id, page2Id];

  // Bildseiten (eine pro Datei)
  for (const file of files) {
    if (!file.mimeType?.startsWith('image/')) continue;
    const subtype = file.mimeType.includes('png') ? 'PNG' : 'DCTDecode';
    const colorspace = file.mimeType.includes('png') ? '/DeviceRGB' : '/DeviceRGB';
    const imgData = file.thumbnail || '';
    const imgBytes = atob(imgData).length;

    const xObjId = addObj(`<< /Type /XObject /Subtype /Image /Width 595 /Height 842 /ColorSpace ${colorspace} /BitsPerComponent 8 /Filter /${subtype} /Length ${imgBytes} >>\nstream\n${imgData}\nendstream`);
    const imgContentStr = `q 595 0 0 842 0 0 cm /Im1 Do Q`;
    const imgCId = addObj(`<< /Length ${imgContentStr.length} >>\nstream\n${imgContentStr}\nendstream`);
    const imgPageId = addObj(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${imgCId} 0 R /Resources << /XObject << /Im1 ${xObjId} 0 R >> >> >>`);
    pageIds.push(imgPageId);
  }

  // Pages aktualisieren
  objects[1].content = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  // PDF zusammenbauen
  let pdf = '%PDF-1.4\n';
  const offsets = [];

  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += `${obj.id} 0 obj\n${obj.content}\nendobj\n`;
  }

  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objCount + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += String(offset).padStart(10, '0') + ' 00000 n \n';
  }
  pdf += `trailer\n<< /Size ${objCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return btoa(unescape(encodeURIComponent(pdf)));
}

function pdfTextPage(text) {
  const lines = text.split('\n').slice(0, 45);
  let ops = 'BT\n/F1 11 Tf\n50 800 Td\n12 TL\n';
  for (const line of lines) {
    const safe = line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    ops += `(${safe}) Tj T*\n`;
  }
  ops += 'ET';
  return ops;
}

// ─── Google Helpers ───────────────────────────────────────────────────────────
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
