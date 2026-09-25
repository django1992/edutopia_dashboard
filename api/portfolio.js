// /api/portfolio.js — Vercel Serverless Function (cartera de clientes)
//
// Devuelve TODOS los clientes en una sola llamada, para la vista de cartera:
//   GET /api/portfolio  ->  { ok, syncedAt, clients: [{ key, name, city, ok, daily, ultimaAgenda }] }
//
// Reglas (ver README del handoff de diseño):
//   1. Nunca hace los 12 fetch en serie: usa Promise.allSettled.
//   2. Reutiliza getAccessToken() UNA sola vez para todos los clientes (el token sirve para los 12).
//   3. Un cliente que falla no rompe la respuesta completa: vuelve con { ok:false, error }.
//   4. La ciudad no vive en el Sheet — sale de clients.json (ver ese archivo).
//
// Cache: s-maxage más alto que api/sheet.js porque esta llamada hace bastante más trabajo
// (12 clientes × ~5 pestañas cada uno). Si en producción esto se acerca al límite de tiempo
// de la función serverless, el siguiente paso es cachear el resultado agregado en Vercel KV /
// Upstash con un cron que lo recalcule cada 15 min, en vez de recalcularlo en cada visita.

const { getAccessToken, getClients, readClientSheet } = require("./_lib/sheetCore");

let CLIENT_INFO = {};
try {
  CLIENT_INFO = require("../clients.json");
} catch (e) {
  CLIENT_INFO = {};
}

function cityFor(key) {
  const entry = CLIENT_INFO[key];
  return (entry && entry.city) || null;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=120");
  try {
    const clients = getClients();
    if (clients.length === 0) {
      throw new Error("No hay clientes configurados. Agrega variables SHEET_ID_<CLIENTE> en Vercel.");
    }

    const accessToken = await getAccessToken();

    const results = await Promise.allSettled(
      clients.map(async (client) => {
        const { daily, ultimaAgenda } = await readClientSheet(accessToken, client.sheetId);
        if (daily.length === 0) {
          throw new Error(`No se reconoció ninguna tabla diaria en el Sheets de "${client.name}".`);
        }
        return {
          key: client.key,
          name: client.name,
          city: cityFor(client.key),
          ok: true,
          daily,
          ultimaAgenda,
          // Link directo al Google Sheets del cliente (botón "Ver tracker" en cartera.html).
          sheetUrl: `https://docs.google.com/spreadsheets/d/${client.sheetId}/edit`,
        };
      })
    );

    const clientsOut = results.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      return {
        key: clients[i].key,
        name: clients[i].name,
        city: cityFor(clients[i].key),
        ok: false,
        error: String(r.reason && r.reason.message ? r.reason.message : r.reason),
        daily: [],
        // El link al tracker no depende de que la lectura del Sheets haya funcionado -- sigue
        // siendo útil para que Humberto vaya a revisar manualmente por qué falló.
        sheetUrl: `https://docs.google.com/spreadsheets/d/${clients[i].sheetId}/edit`,
      };
    });

    res.status(200).json({
      ok: true,
      syncedAt: new Date().toISOString(),
      clients: clientsOut,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
};
