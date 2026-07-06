// api/eb-generate.js - PDF erstellen (mit pdf-lib), in Drive speichern, Belegnummer in Sheets

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { password, sheetId, sheetName, sheetRow, belnr, sku, artikel, datum,
          betrag, plattform, zahlungsart, verkauferName, verkauferAdresse,
          kaeuferName, kaeuferStreet, kaeuferCity, files, ausstellungsdatum,
          folderDriveId, rueckzahlungBetrag, rueckzahlungDatum, rueckzahlungGrund } = req.body || {};

  const APP_PASSWORD = process.env.APP_PASSWORD;
  if (APP_PASSWORD && password !== APP_PASSWORD) return res.status(401).json({ error: 'Falsches Passwort' });

  const TARGET_FOLDER_NAME = 'Eigenbelege';

  try {
    const token = await getGoogleToken();
    const userToken = await getUserDriveToken();

    // 1. PDF bauen: Deckblatt + Eigenbeleg-Seite + alle Anhänge (Bilder eingebettet, PDFs echt kopiert)
    const pdfBytes = await buildPDF({
      belnr, sku, artikel, datum, betrag, plattform, zahlungsart,
      verkauferName, verkauferAdresse, kaeuferName, kaeuferStreet, kaeuferCity,
      ausstellungsdatum, files: files || [], token,
      rueckzahlungBetrag, rueckzahlungDatum, rueckzahlungGrund
    });

    const filename = `${belnr}_${sku}.pdf`;
    const pdfBase64 = Buffer.from(pdfBytes).toString('base64');

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
          'Authorization': `Bearer ${userToken}`,
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
      const doneFolderSearch = await gFetch(
        `https://www.googleapis.com/drive/v3/files?q=name='${DONE_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false&fields=files(id,name)`,
        token
      );
      let doneFolderId;
      if (doneFolderSearch.files?.length) {
        doneFolderId = doneFolderSearch.files[0].id;
      } else {
        const createResp = await fetch('https://www.googleapis.com/drive/v3/files', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: DONE_FOLDER, mimeType: 'application/vnd.google-apps.folder' })
        });
        const createData = await createResp.json();
        doneFolderId = createData.id;
      }

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

// ─── Helpers: Betrag / Formatierung ────────────────────────────────────────────
function parseEuro(str) {
  if (!str) return null;
  const num = String(str).replace(/[€\s]/g, '').replace(/\./g, '').replace(',', '.');
  const val = parseFloat(num);
  return isNaN(val) ? null : val;
}
function formatEuro(val) {
  return val.toFixed(2).replace('.', ',') + ' €';
}

// ─── PDF Builder (pdf-lib) ──────────────────────────────────────────────────────
async function buildPDF({ belnr, sku, artikel, datum, betrag, plattform, zahlungsart,
                          verkauferName, verkauferAdresse, kaeuferName, kaeuferStreet,
                          kaeuferCity, ausstellungsdatum, files, token,
                          rueckzahlungBetrag, rueckzahlungDatum, rueckzahlungGrund }) {

  const today = ausstellungsdatum || new Date().toLocaleDateString('de-DE');

  const hatRueckzahlung = !!(rueckzahlungBetrag && parseEuro(rueckzahlungBetrag) !== null);
  let rueckzahlungLinesDeckblatt = [];
  let rueckzahlungLinesBeleg = [];
  let begruendungLines = [
    'Ankauf von Privatperson (nicht gewerblich);',
    'Verkäufer stellt üblicherweise keine Rechnung/Quittung aus.'
  ];

  if (hatRueckzahlung) {
    const urspruenglich = parseEuro(betrag);
    const rueckzahlung = parseEuro(rueckzahlungBetrag);
    const tatsaechlich = (urspruenglich !== null) ? (urspruenglich - rueckzahlung) : null;
    const tatsaechlichStr = tatsaechlich !== null ? formatEuro(tatsaechlich) : '–';

    rueckzahlungLinesDeckblatt = [
      '',
      'TEILRÜCKZAHLUNG (Mängel / Abweichung von Beschreibung)',
      `Ursprünglicher Kaufpreis: ${betrag}  (gezahlt am ${datum})`,
      `Teilrückzahlung: -${rueckzahlungBetrag}  (erhalten am ${rueckzahlungDatum || '–'})`,
      `Tatsächlicher Einkaufspreis: ${tatsaechlichStr}`,
    ];
    rueckzahlungLinesBeleg = [
      '',
      'TEILRÜCKZAHLUNG',
      `Ursprünglicher Kaufpreis: ${betrag}  (gezahlt am ${datum})`,
      `Teilrückzahlung: -${rueckzahlungBetrag}  (erhalten am ${rueckzahlungDatum || '–'})`,
      `Tatsächlicher Einkaufspreis (maßgeblich für §25a-Marge): ${tatsaechlichStr}`,
    ];
    begruendungLines = [
      'Ankauf von Privatperson (nicht gewerblich);',
      'Verkäufer stellt üblicherweise keine Rechnung/Quittung aus.',
      '',
      ...wrapText(rueckzahlungGrund ||
        `Ware entsprach nicht der Beschreibung; Verkäufer leistete am ${rueckzahlungDatum || '–'} eine Teilerstattung von ${rueckzahlungBetrag} zurück.`, 78)
    ];
  }

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  // Seite 1: Deckblatt
  drawTextPage(doc, font, fontBold, 'EIGENBELEG', [
    { label: 'Belegnummer', value: belnr },
    { label: 'Ausstellungsdatum', value: today },
    { blank: true },
    { heading: 'KÄUFER / AUSSTELLER' },
    { text: kaeuferName },
    { text: kaeuferStreet },
    { text: kaeuferCity },
    { blank: true },
    { heading: 'ANGABEN ZUM KAUF' },
    { label: 'SKU', value: sku },
    { label: 'Artikelbeschreibung', value: artikel },
    { label: 'Kaufdatum', value: datum },
    { label: 'Betrag', value: betrag },
    { label: 'Plattform', value: plattform },
    { label: 'Zahlungsart', value: zahlungsart },
    { label: 'Verkäufer', value: verkauferName || '–' },
    ...(verkauferAdresse ? [{ label: 'Adresse', value: verkauferAdresse }] : []),
    ...rueckzahlungLinesDeckblatt.map(l => l === '' ? { blank: true } : (l.startsWith('TEILRÜCKZAHLUNG') ? { heading: l } : { text: l })),
  ]);

  // Seite 2: Formaler Eigenbeleg
  drawTextPage(doc, font, fontBold, 'EIGENBELEG', [
    { label: 'Belegnummer', value: belnr },
    { label: 'Ausstellungsdatum', value: today },
    { blank: true },
    { heading: 'Käufer / Aussteller' },
    { text: kaeuferName },
    { text: kaeuferStreet },
    { text: kaeuferCity },
    { blank: true },
    { heading: 'Zahlungsempfänger (Verkäufer)' },
    { text: verkauferName || '–' },
    ...(verkauferAdresse ? [{ text: verkauferAdresse }] : []),
    { blank: true },
    { heading: 'ANGABEN ZUR AUFWENDUNG' },
    { label: 'Datum der Zahlung', value: datum },
    { label: 'Art der Aufwendung', value: 'Ankauf Gebrauchtware für Wiederverkauf' },
    { label: 'Artikelbeschreibung', value: artikel },
    { label: 'SKU', value: sku },
    { label: 'Plattform', value: plattform },
    { label: 'Zahlungsart', value: zahlungsart },
    { label: 'Gesamtbetrag', value: betrag },
    ...rueckzahlungLinesBeleg.map(l => l === '' ? { blank: true } : (l.startsWith('TEILRÜCKZAHLUNG') ? { heading: l } : { text: l })),
    { blank: true },
    { heading: 'BEGRÜNDUNG' },
    ...begruendungLines.map(l => l === '' ? { blank: true } : { text: l }),
    { blank: true },
    { blank: true },
    { text: 'Unterschrift Käufer / Aussteller:' },
    { blank: true },
    { text: '___________________________' },
    { text: `${kaeuferName} · ${today}` },
  ]);

  // Seite 3+: Anhänge (Bilder eingebettet, PDFs mit echten Seiten kopiert)
  for (const file of files) {
    try {
      const bytes = await downloadDriveFile(file.id, token);
      if (!bytes) continue;

      if (file.mimeType === 'application/pdf') {
        const srcDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
        const copiedPages = await doc.copyPages(srcDoc, srcDoc.getPageIndices());
        copiedPages.forEach(p => doc.addPage(p));
      } else if (file.mimeType?.startsWith('image/')) {
        const isPng = file.mimeType.includes('png');
        const img = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
        const page = doc.addPage([595, 842]);
        const scale = Math.min(535 / img.width, 782 / img.height, 1);
        const w = img.width * scale;
        const h = img.height * scale;
        page.drawImage(img, {
          x: (595 - w) / 2,
          y: (842 - h) / 2,
          width: w,
          height: h,
        });
      }
    } catch(e) {
      console.error(`Anhang ${file.name} konnte nicht eingebettet werden:`, e.message);
      continue;
    }
  }

  return doc.save();
}

function drawTextPage(doc, font, fontBold, title, lines) {
  const page = doc.addPage([595, 842]);
  const marginX = 55;
  let y = 790;
  const lineHeight = 15;

  page.drawText(title, { x: marginX, y, size: 16, font: fontBold, color: rgb(0,0,0) });
  y -= 30;

  for (const item of lines) {
    if (y < 50) break; // einfache Absicherung gegen Seitenüberlauf
    if (item.blank) { y -= lineHeight * 0.6; continue; }
    if (item.heading) {
      y -= 4;
      page.drawText(item.heading, { x: marginX, y, size: 11, font: fontBold, color: rgb(0.15,0.15,0.15) });
      y -= lineHeight;
      continue;
    }
    if (item.label) {
      page.drawText(`${item.label}:`, { x: marginX, y, size: 10.5, font, color: rgb(0.35,0.35,0.35) });
      page.drawText(String(item.value ?? ''), { x: marginX + 150, y, size: 10.5, font, color: rgb(0,0,0) });
      y -= lineHeight;
      continue;
    }
    page.drawText(String(item.text ?? ''), { x: marginX, y, size: 10.5, font, color: rgb(0,0,0) });
    y -= lineHeight;
  }
}

function wrapText(text, maxChars) {
  const words = String(text || '').split(' ');
  const lines = [];
  let current = '';
  for (const w of words) {
    if ((current + ' ' + w).trim().length > maxChars) {
      lines.push(current.trim());
      current = w;
    } else {
      current += ' ' + w;
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines;
}

async function downloadDriveFile(fileId, token) {
  const resp = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  if (!resp.ok) return null;
  const buffer = await resp.arrayBuffer();
  return new Uint8Array(buffer);
}

// ─── Google Helpers ───────────────────────────────────────────────────────────
async function getUserDriveToken() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN fehlt – einmaliger Login via /api/oauth-start nötig');
  }
  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    }).toString()
  });
  const td = await tokenResp.json();
  if (!td.access_token) throw new Error('OAuth Token-Refresh fehlgeschlagen: ' + (td.error_description || td.error || 'unbekannt'));
  return td.access_token;
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
