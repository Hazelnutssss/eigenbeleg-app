// api/eb-extract.js - Claude Vision extrahiert Verkäufer, Datum, Betrag

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { password, files } = req.body || {};

  const APP_PASSWORD = process.env.APP_PASSWORD;
  if (APP_PASSWORD && password !== APP_PASSWORD) return res.status(401).json({ error: 'Falsches Passwort' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY fehlt' });
  if (!files?.length) return res.status(400).json({ error: 'Keine Dateien übergeben' });

  const prompt = `Analysiere diese Bilder. Es sind Dokumente zu einem Privatankauf (Zahlungsnachweis, Versandetikett, Anzeige, Chat).

Extrahiere folgende Felder als JSON-Objekt. Antworte NUR mit dem JSON, ohne Erklärung, ohne Markdown.

{
  "verkauferName": "Vollständiger Name des Verkäufers (Priorität: Zahlungsnachweis/PayPal/Überweisung, dann Versandetikett Absender)",
  "verkauferAdresse": "Straße Hausnr, PLZ Stadt des Verkäufers vom Versandetikett Absenderfeld (leer lassen wenn nicht erkennbar)",
  "datum": "Datum der Zahlung im Format TT. Mon JJJJ (z.B. 21. Jun 2026)",
  "betrag": "Gezahlter Betrag mit € (z.B. 34,99 €)"
}

Wichtig:
- Verkäufername aus Zahlungsnachweis hat höchste Priorität da er rechtlich gesichert ist
- Adresse nur vom Versandetikett Absenderfeld, nicht vom Empfängerfeld
- Falls ein Feld nicht erkennbar ist: leeren String zurückgeben`;

  try {
    // Nur Bilder (keine PDFs) an Claude senden, max 5
    const imageFiles = files
      .filter(f => f.mimeType.startsWith('image/'))
      .slice(0, 5);

    if (!imageFiles.length) {
      return res.status(200).json({
        success: true,
        verkauferName: '',
        verkauferAdresse: '',
        datum: '',
        betrag: '',
        note: 'Keine Bilddateien gefunden'
      });
    }

    const content = [
      ...imageFiles.map(f => ({
        type: 'image',
        source: { type: 'base64', media_type: f.mimeType, data: f.thumbnail }
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
