// /api/finanzas.js — Vercel Serverless Function (control financiero de Edutopia)
//
// Lee la planilla de Ingresos/Egresos de LA EMPRESA (no de un cliente) usando la MISMA cuenta
// de servicio ya configurada para api/sheet.js y api/portfolio.js -- basta con compartir esa
// hoja puntual con el mismo email de GOOGLE_SERVICE_ACCOUNT_EMAIL (Viewer alcanza, el scope
// que se pide es de solo lectura).
//
// Variable de entorno nueva a agregar en Vercel:
//   FINANZAS_SHEET_ID   -> el ID del Google Sheets de Ingresos/Egresos (el que va en la URL,
//                          entre /d/ y /edit)
//
// Si esa variable todavía no está configurada, este endpoint responde ok:false con un mensaje
// claro en vez de reventar -- cartera.html usa ese mensaje para mostrar un estado de "todavía
// no configurado" en la pestaña Finanzas en vez de una pantalla rota.

const { getAccessToken } = require("./_lib/sheetCore");
const { readFinanzas } = require("./_lib/finanzasCore");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=120");
  try {
    const sheetId = process.env.FINANZAS_SHEET_ID;
    if (!sheetId) {
      res.status(200).json({
        ok: false,
        notConfigured: true,
        error: "Falta la variable de entorno FINANZAS_SHEET_ID en Vercel (el ID del Google Sheets de Ingresos/Egresos, compartido con la misma cuenta de servicio que ya usan tus clientes).",
      });
      return;
    }

    const accessToken = await getAccessToken();
    const { ingresos, egresos } = await readFinanzas(accessToken, sheetId);

    res.status(200).json({
      ok: true,
      syncedAt: new Date().toISOString(),
      ingresos,
      egresos,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
};
