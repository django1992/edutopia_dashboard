
// api/_lib/sheetCore.js — lógica compartida de acceso a Google Sheets.
//
// Extraído de api/sheet.js para que api/sheet.js (panel individual) y
// api/portfolio.js (cartera de clientes) reutilicen exactamente la misma
// autenticación y el mismo parser de tablas diarias, sin duplicar código.
//
// Vercel NO trata los archivos dentro de api/_lib/ (prefijo "_") como
// endpoints propios — solo son módulos que otros archivos de /api pueden
// requerir. No hace falta build step ni package adicional.

const crypto = require("crypto");

const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Obtiene un access_token OAuth2 firmando un JWT con la clave privada de la cuenta de servicio.
async function getAccessToken() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let privateKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!email || !privateKey) {
    throw new Error("Faltan GOOGLE_SERVICE_ACCOUNT_EMAIL o GOOGLE_PRIVATE_KEY en las variables de entorno.");
  }
  // Si la clave viene con \n escapados (común al pegarla en Vercel), los convertimos a saltos reales.
  privateKey = privateKey.replace(/\\n/g, "\n");

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKey);
  const jwt = `${signingInput}.${base64url(signature)}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error("No se pudo obtener access_token de Google: " + JSON.stringify(json));
  }
  return json.access_token;
}

// Lista los nombres (títulos) de todas las pestañas del spreadsheet.
async function fetchSheetTitles(accessToken, sheetId) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties.title`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const json = await res.json();
  if (!res.ok) {
    throw new Error("Error listando las pestañas del Sheets: " + JSON.stringify(json));
  }
  return (json.sheets || []).map((s) => s.properties.title);
}

// Lee el rango completo de UNA pestaña (por nombre) como valores SIN formatear
// (números crudos, no "$25.870"). Se mantiene para compatibilidad/tests puntuales,
// pero readClientSheet ya NO la usa (ver fetchSheetValuesBatch) -- un cliente con muchas
// pestañas (una por mes) hacía una llamada a Google POR PESTAÑA, y eso agotaba la cuota
// de lecturas por minuto en cuanto había varios clientes cargando a la vez.
async function fetchSheetValues(accessToken, sheetId, sheetTitle) {
  const escapedTitle = sheetTitle.replace(/'/g, "''");
  const range = `'${escapedTitle}'!A1:AZ2000`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(
    range
  )}?valueRenderOption=UNFORMATTED_VALUE`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Error leyendo la pestaña "${sheetTitle}": ` + JSON.stringify(json));
  }
  return json.values || [];
}

// Lee VARIAS pestañas en una sola llamada a la API (values:batchGet) -- así un cliente con,
// por ejemplo, 12 pestañas (una por mes) gasta 1 lectura en vez de 12. Esto es lo que evita
// chocar con "Read requests per minute per user" cuando la cartera carga varios clientes
// en paralelo (cada uno con su propia tanda de meses).
async function fetchSheetValuesBatch(accessToken, sheetId, sheetTitles) {
  const params = new URLSearchParams();
  sheetTitles.forEach((title) => {
    const escapedTitle = title.replace(/'/g, "''");
    params.append("ranges", `'${escapedTitle}'!A1:AZ2000`);
  });
  params.append("valueRenderOption", "UNFORMATTED_VALUE");
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchGet?${params.toString()}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const json = await res.json();
  if (!res.ok) {
    throw new Error("Error leyendo las pestañas del Sheets (batch): " + JSON.stringify(json));
  }
  const valueRanges = json.valueRanges || [];
  // Google devuelve valueRanges en el MISMO ORDEN en que se pidieron los `ranges` -- por eso
  // podemos emparejar por índice con la lista de títulos original.
  return sheetTitles.map((title, i) => ({ title, values: (valueRanges[i] && valueRanges[i].values) || [] }));
}

const NEEDED_HEADERS = [
  "Inversión",
  "Impresiones",
  "Clicks",
  "CMI",
  "Agendas",
  "Citas",
  "Asistencias",
  "Unidades",
  "Ventas",
  "Facturado",
];
const HEADER_TO_KEY = {
  "Inversión": "inv",
  "Impresiones": "imp",
  "Clicks": "clk",
  "CMI": "cmi",
  "Agendas": "ag",
  "Citas": "ci",
  "Asistencias": "asi",
  "Unidades": "cie",
  "Ventas": "ven",
  "Facturado": "fac",
};
const DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/;

// Con valueRenderOption=UNFORMATTED_VALUE, Google devuelve las fechas como número de serie
// (días desde el 30/12/1899). Ej: 46023 = 01/01/2026. Convertimos ese número a fecha ISO.
const SHEETS_EPOCH_MS = Date.UTC(1899, 11, 30);
function isoFromSerial(n) {
  if (typeof n !== "number" || !isFinite(n)) return null;
  if (n < 43831 || n > 51500) return null; // solo fechas plausibles 2020-2041 (evita confundir montos con fechas)
  if (n % 1 !== 0) return null; // las fechas puras son enteros; decimales son montos/porcentajes
  const ms = SHEETS_EPOCH_MS + Math.round(n) * 86400000;
  const d = new Date(ms);
  return d.toISOString().slice(0, 10);
}

function norm(s) {
  return String(s == null ? "" : s)
    .replace(/ /g, " ") // espacios "non-breaking"
    .trim()
    .toLowerCase();
}

// Marcador que identifica una fila de encabezado de tabla diaria. Se acepta con o sin
// guion/espacio ("scr-%", "scr %", "scr%") para tolerar pequeñas variaciones de formato.
function looksLikeScrHeader(cellText) {
  const t = norm(cellText).replace(/[\s-]/g, "");
  return t === "scr%";
}

function toNum(v) {
  if (v === undefined || v === null || v === "") return 0;
  if (typeof v === "number") return v;
  const n = parseFloat(String(v).replace(/[^0-9.-]/g, ""));
  return isNaN(n) ? 0 : n;
}

function isoFromCell(v) {
  // Caso 1: número de serie de Google Sheets (lo que devuelve UNFORMATTED_VALUE para fechas).
  const fromSerial = isoFromSerial(v);
  if (fromSerial) return fromSerial;
  // Caso 2: texto tipo "01/01/26" o "01/01/2026".
  const m = DATE_RE.exec(String(v).trim());
  if (!m) return null;
  const [, dd, mm, yRaw] = m;
  const yyyy = yRaw.length === 2 ? `20${yRaw}` : yRaw;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

// Parsea las tablas diarias apiladas dentro de una pestaña: busca filas de encabezado
// (identificadas por una celda tipo "SCR-%"), mapea columnas por texto de encabezado,
// y luego lee filas siguientes mientras alguna columna tenga una fecha DD/MM/YY válida.
function parseDaily(rows) {
  const out = [];
  const seen = new Set();

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    const hasScr = row.some((c) => looksLikeScrHeader(c));
    if (!hasScr) continue;

    // Mapear columnas de este bloque por texto de encabezado (comparación normalizada).
    const colOf = {};
    row.forEach((cell, idx) => {
      const text = norm(cell);
      const match = NEEDED_HEADERS.find((h) => norm(h) === text);
      if (match && colOf[match] === undefined) {
        colOf[match] = idx;
      }
    });
    if (Object.keys(colOf).length < 5) continue; // bloque no reconocido, seguir buscando

    // Leer filas siguientes hasta que ya no haya una fecha DD/MM/YY válida en las primeras columnas.
    let rr = r + 1;
    while (rr < rows.length) {
      const dataRow = rows[rr] || [];
      let iso = null;
      for (let c = 0; c < Math.min(4, dataRow.length); c++) {
        iso = isoFromCell(dataRow[c]);
        if (iso) break;
      }
      if (!iso) break; // fin de este bloque de días

      if (!seen.has(iso)) {
        seen.add(iso);
        const entry = { d: iso, inv: 0, imp: 0, clk: 0, cmi: 0, ag: 0, ci: 0, asi: 0, cie: 0, ven: 0, fac: 0 };
        NEEDED_HEADERS.forEach((h) => {
          if (colOf[h] !== undefined) {
            entry[HEADER_TO_KEY[h]] = toNum(dataRow[colOf[h]]);
          }
        });
        out.push(entry);
      }
      rr++;
    }
  }

  out.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  return out;
}

// Nombre exacto de la pestaña con el registro fila-por-fila de pacientes.
const REGISTRY_TAB = "Registro de pacientes";

// Encuentra la agenda MÁS RECIENTE (mayor fecha en la columna "Agenda") en el registro de pacientes,
// y devuelve { nombre, agenda, cita } de esa fila. Columnas: G=Nombre y apellido, E=Agenda, F=Cita.
function parseUltimaAgenda(rows) {
  // 1) Ubicar la fila de encabezados (la que tiene "Nombre y apellido", "Agenda" y "Cita").
  let cols = {};
  let headerIdx = -1;
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const row = rows[r] || [];
    const texts = row.map((c) => norm(c));
    const hasNombre = texts.some((t) => t === norm("Nombre y apellido"));
    const hasAgenda = texts.some((t) => t === norm("Agenda"));
    const hasCita = texts.some((t) => t === norm("Cita"));
    if (hasNombre && hasAgenda && hasCita) {
      headerIdx = r;
      row.forEach((cell, idx) => {
        const t = norm(cell);
        if (t === norm("Nombre y apellido") && cols.nombre === undefined) cols.nombre = idx;
        if (t === norm("Agenda") && cols.agenda === undefined) cols.agenda = idx;
        if (t === norm("Cita") && cols.cita === undefined) cols.cita = idx;
      });
      break;
    }
  }
  if (headerIdx === -1 || cols.nombre === undefined || cols.agenda === undefined) return null;

  // 2) Recorrer las filas de datos y quedarnos con la de mayor fecha de agenda (con nombre válido).
  let best = null;
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const agendaISO = isoFromCell(row[cols.agenda]);
    if (!agendaISO) continue;
    const nombre = String(row[cols.nombre] == null ? "" : row[cols.nombre]).trim();
    if (!nombre) continue;
    const citaISO = cols.cita !== undefined ? isoFromCell(row[cols.cita]) : null;
    // >= para que, ante empates de fecha, gane la fila más abajo (la ingresada más recientemente).
    if (!best || agendaISO >= best.agenda) {
      best = { nombre, agenda: agendaISO, cita: citaISO };
    }
  }
  return best;
}

// ---- Multi-cliente ----
// Cada cliente se define con dos variables de entorno en Vercel:
//   SHEET_ID_<CLAVE>     -> el ID del Google Sheets de ese cliente
//   CLIENT_NAME_<CLAVE>  -> el nombre a mostrar (opcional; si falta, se usa la clave)
// Ej: SHEET_ID_ODONTOVIDA = 1gLQ...   CLIENT_NAME_ODONTOVIDA = Clínica Odontovida
// Agregar un cliente nuevo = agregar esas 2 variables + Redeploy. No hay que tocar el código.
function getClients() {
  const clients = [];
  const seen = new Set();
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("SHEET_ID_") && process.env[k]) {
      const suffix = k.slice("SHEET_ID_".length); // clave original, ej "ODONTOVIDA"
      const key = suffix.toLowerCase();
      const name = process.env["CLIENT_NAME_" + suffix] || key;
      clients.push({ key, name, sheetId: process.env[k] });
      seen.add(key);
    }
  }
  // Compatibilidad: si existe la variable antigua SHEET_ID, se incluye como "odontovida".
  if (process.env.SHEET_ID && !seen.has("odontovida")) {
    clients.push({
      key: "odontovida",
      name: process.env.CLIENT_NAME_ODONTOVIDA || "Clínica Odontovida",
      sheetId: process.env.SHEET_ID,
    });
  }
  clients.sort((a, b) => a.name.localeCompare(b.name, "es"));
  return clients;
}

function getParam(req, name) {
  if (req.query && req.query[name] !== undefined) return req.query[name];
  try {
    return new URL(req.url, "http://x").searchParams.get(name);
  } catch (e) {
    return null;
  }
}

// Lee TODAS las pestañas de un Sheets y devuelve { daily, ultimaAgenda }, igual que hacía
// el handler de api/sheet.js. Compartido entre el endpoint individual y el de cartera.
async function readClientSheet(accessToken, sheetId) {
  const titles = await fetchSheetTitles(accessToken, sheetId);
  if (titles.length === 0) throw new Error("El Sheets no tiene ninguna pestaña visible.");

  // 1 sola llamada batchGet para TODAS las pestañas (en vez de una llamada por pestaña) --
  // esto es lo que mantiene el consumo de cuota de Google bajo aunque un cliente tenga
  // muchos meses de pestañas y haya varios clientes cargando a la vez.
  const batches = await fetchSheetValuesBatch(accessToken, sheetId, titles);

  let daily = [];
  const debugInfo = [];
  let registryRows = null;
  for (const { title, values: rows } of batches) {
    if (title === REGISTRY_TAB) registryRows = rows;
    const found = parseDaily(rows);
    debugInfo.push({ pestaña: title, filas_leidas: rows.length, dias_encontrados: found.length });
    daily = daily.concat(found);
  }
  // Por si el mismo día aparece en más de una pestaña, nos quedamos con una sola entrada por fecha.
  const byDate = {};
  daily.forEach((d) => { byDate[d.d] = d; });
  daily = Object.values(byDate).sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));

  let ultimaAgenda = null;
  try {
    if (registryRows) ultimaAgenda = parseUltimaAgenda(registryRows);
  } catch (e) {
    ultimaAgenda = null;
  }

  return { daily, ultimaAgenda, debugInfo };
}

module.exports = {
  getAccessToken,
  fetchSheetTitles,
  fetchSheetValues,
  fetchSheetValuesBatch,
  parseDaily,
  parseUltimaAgenda,
  getClients,
  getParam,
  readClientSheet,
  REGISTRY_TAB,
};
