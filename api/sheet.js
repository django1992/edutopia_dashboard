// /api/sheet.js — Vercel Serverless Function (panel individual)
//
// Lee el Google Sheets de UN cliente usando una cuenta de servicio de Google
// (la hoja NO necesita ser pública; solo se comparte con el email de la
// cuenta de servicio, igual que se comparte con una persona).
//
// Variables de entorno requeridas (Vercel → Project Settings → Environment Variables):
//   GOOGLE_SERVICE_ACCOUNT_EMAIL   -> el "client_email" del JSON de la cuenta de servicio
//   GOOGLE_PRIVATE_KEY             -> el "private_key" del JSON (pega el bloque completo, con \n literales)
//   SHEET_ID_<CLAVE> / CLIENT_NAME_<CLAVE>  -> uno por cliente (ver getClients() en api/_lib/sheetCore.js)
//
// La lógica de autenticación y parseo vive en api/_lib/sheetCore.js, compartida con
// api/portfolio.js (endpoint agregado de la cartera de clientes) para no duplicar código.

const { getAccessToken, getClients, getParam, readClientSheet } = require("./_lib/sheetCore");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
  try {
    const clients = getClients();
    if (clients.length === 0) {
      throw new Error("No hay clientes configurados. Agrega variables SHEET_ID_<CLIENTE> en Vercel.");
    }

    // Modo lista: devuelve solo la lista de clientes (sin el sheetId) para poblar el selector.
    if (getParam(req, "list") === "1") {
      res.status(200).json({ ok: true, clients: clients.map((c) => ({ key: c.key, name: c.name })) });
      return;
    }

    // Cliente solicitado (o el primero por defecto).
    const requested = String(getParam(req, "client") || "").toLowerCase();
    const client = clients.find((c) => c.key === requested) || clients[0];

    const accessToken = await getAccessToken();
    const { daily, ultimaAgenda, debugInfo } = await readClientSheet(accessToken, client.sheetId);

    if (daily.length === 0) {
      throw new Error(
        `Se conectó al Sheets de "${client.name}" pero no se reconoció ninguna tabla diaria. Pestañas revisadas: ` +
          JSON.stringify(debugInfo)
      );
    }

    res.status(200).json({
      ok: true,
      // sheetUrl: link directo al Google Sheets de este cliente (para el botón "Ver tracker"
      // del panel individual). El sheetId en sí no es un secreto -- la hoja solo es accesible
      // para quien ya tenga permiso de Google (compartida con la cuenta de servicio y con
      // Humberto), así que exponer la URL no abre ningún acceso nuevo.
      client: { key: client.key, name: client.name, sheetUrl: `https://docs.google.com/spreadsheets/d/${client.sheetId}/edit` },
      daily,
      ultimaAgenda,
      syncedAt: new Date().toISOString(),
      debug: debugInfo,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
};
