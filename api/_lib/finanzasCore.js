// api/_lib/finanzasCore.js — lógica compartida para leer la planilla de Ingresos/Egresos de
// la EMPRESA (Edutopia), no de los clientes. Vive aparte de sheetCore.js (que es sobre las
// hojas de cada cliente) pero reutiliza sus mismos helpers de bajo nivel (auth, lectura batch,
// parseo de fechas/montos de Sheets) para no duplicar código.
//
// Formato real de la planilla (visto en el Excel que Humberto compartió, "Balance_2026.xlsx"):
//
//  Pestaña "Ingresos" -- una fila por pago/oportunidad, con una fila de "TOTAL" del mes
//  intercalada antes del primer pago de ese mes (se identifica porque esa fila NO tiene fecha
//  en la columna B, a diferencia de las filas de pago reales):
//    A: Estado ("Pago realizado" | "Pago pendiente" | "Perdido" | "Peligrando" | "Caliente")
//    B: Fecha, C: Mes (texto: "Enero", "Febrero", ...), D: Concepto,
//    E: Monto CLP, F: Monto USD, G: Monto Total (ojo: esta columna no siempre cuadra --
//       ver nota en parseIngresos), H: Fuente de pago, I: Programa
//
//  Pestaña "Egresos" -- una fila por gasto, incluye salarios, impuestos, herramientas/SaaS,
//  publicidad propia, honorarios, bancario, etc. No tiene columna de categoría, así que
//  categorizeEgreso() la infiere por palabras clave del Concepto (ver ahí las reglas exactas):
//    A: Fecha, B: Mes, C: Concepto, D: Monto CLP, E: Fuente (medio de pago)
//
// IMPORTANTE -- por qué agrupamos por la columna "Mes" (texto) y no por la fecha real:
// en los datos reales de Humberto, la columna Fecha de Egresos trae años desactualizados
// (2024/2025) que no coinciden con el año en curso, mientras que "Mes" ("Enero".."Diciembre")
// sí es confiable y es lo que él mismo usa para ubicarse en la planilla. Agrupando por ese
// texto evitamos que un año mal tipeado rompa los totales mensuales -- la Fecha real solo se
// expone para poder ordenar/mostrar el detalle de cada movimiento, nunca para decidir a qué
// mes pertenece.

const { fetchSheetTitles, fetchSheetValuesBatch, isoFromCell, toNum } = require("./sheetCore");

const TAB_INGRESOS = "Ingresos";
const TAB_EGRESOS = "Egresos";

// Reglas de categorización de gastos por palabras clave del Concepto (normalizado: sin
// tildes, minúsculas). Se evalúan EN ORDEN y gana la primera que matchee -- por eso, por
// ejemplo, "sobregiro" se revisa antes que "impuesto" (si no, "Impuesto sobregiro" caería
// en Impuestos en vez de en Bancario, que es lo correcto: es un cargo del banco, no un
// impuesto real). Esto es una aproximación de v1 -- si alguna categoría queda mal armada,
// se ajusta esta lista, o Humberto puede pedir agregar una columna "Categoría" en el sheet
// para que el dashboard la use directo en vez de adivinar.
const CATEGORY_RULES = [
  { rx: /sobregiro|comision|mantenc|amortizaci|mercury|banco|tdc|dasban|bookkiping|bookkeeping/, label: "Bancario y contable" },
  { rx: /salario|sueldo|honorari|imposicion/, label: "Nómina y honorarios" },
  { rx: /\biva\b|impuesto|operaci.n renta/, label: "Impuestos" },
  { rx: /facebook|meta ads|instagram|google ads/, label: "Publicidad" },
  { rx: /gsuite|g suite|openai|chatgpt|calendly|skool|railway|canva|bunny|software|suscripcion|wom\b/, label: "Herramientas y software" },
  { rx: /mentoria/, label: "Mentorías y formación" },
];
const OTHER_CATEGORY = "Otros";

function norm(s) {
  return String(s == null ? "" : s)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}

function categorizeEgreso(concepto) {
  const t = norm(concepto);
  const rule = CATEGORY_RULES.find((r) => r.rx.test(t));
  return rule ? rule.label : OTHER_CATEGORY;
}

// Estados de "Ingresos" que representan pago YA cobrado (caja real). Todo lo demás
// (pendiente/perdido/peligrando/caliente) es pipeline de ventas, no ingreso real.
const ESTADO_REALIZADO = "Pago realizado";
const ESTADO_PENDIENTE = "Pago pendiente";
const ESTADOS_RIESGO = ["Perdido", "Peligrando", "Caliente"];

// Fila de pago real (no la fila de TOTAL del mes, que no trae fecha en la columna B).
function parseIngresos(rows) {
  const out = [];
  for (const row of rows) {
    const fecha = isoFromCell(row[1]);
    if (!fecha) continue; // fila de encabezado, de TOTAL del mes, o vacía -- se descarta
    out.push({
      estado: row[0] || null,
      fecha,
      mes: row[2] || null,
      concepto: row[3] || null,
      montoCLP: toNum(row[4]),
      montoUSD: toNum(row[5]),
      fuente: row[7] || null,
      programa: row[8] || null,
    });
  }
  return out;
}

// Fila de gasto real (no la fila de TOTAL del mes, que no trae fecha en la columna A).
function parseEgresos(rows) {
  const out = [];
  for (const row of rows) {
    const fecha = isoFromCell(row[0]);
    if (!fecha) continue;
    const concepto = row[2] || null;
    out.push({
      fecha,
      mes: row[1] || null,
      concepto,
      montoCLP: toNum(row[3]),
      fuente: row[4] || null,
      categoria: categorizeEgreso(concepto),
    });
  }
  return out;
}

// Lee las pestañas "Ingresos" y "Egresos" de la planilla de finanzas de la empresa (distinta
// de las de cada cliente) y devuelve las filas ya parseadas de ambas. Solo pide a Google las
// pestañas que realmente existen en el spreadsheet (por si algún nombre viene con mayúsculas
// o espacios distintos), para no reventar con un rango inválido.
async function readFinanzas(accessToken, sheetId) {
  const titles = await fetchSheetTitles(accessToken, sheetId);
  const findTab = (wanted) => titles.find((t) => norm(t) === norm(wanted));
  const tabIngresos = findTab(TAB_INGRESOS);
  const tabEgresos = findTab(TAB_EGRESOS);
  const wanted = [tabIngresos, tabEgresos].filter(Boolean);
  if (wanted.length === 0) {
    throw new Error(`No se encontraron las pestañas "${TAB_INGRESOS}" ni "${TAB_EGRESOS}" en el spreadsheet. Pestañas disponibles: ${titles.join(", ")}`);
  }

  const batches = await fetchSheetValuesBatch(accessToken, sheetId, wanted);
  const byTitle = {};
  batches.forEach(({ title, values }) => { byTitle[title] = values; });

  const ingresos = tabIngresos ? parseIngresos(byTitle[tabIngresos] || []) : [];
  const egresos = tabEgresos ? parseEgresos(byTitle[tabEgresos] || []) : [];
  return { ingresos, egresos };
}

module.exports = {
  categorizeEgreso,
  parseIngresos,
  parseEgresos,
  readFinanzas,
  ESTADO_REALIZADO,
  ESTADO_PENDIENTE,
  ESTADOS_RIESGO,
  TAB_INGRESOS,
  TAB_EGRESOS,
};
