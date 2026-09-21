// lib/aggregate.js — helpers compartidos entre index.html (panel individual) y
// cartera.html (vista de cartera). No hay build step en este proyecto, así que
// esto se carga con un <script src="/lib/aggregate.js"></script> normal ANTES del
// bloque JSX de cada página (que Babel transforma en el navegador) — queda disponible
// como funciones globales, igual que si estuvieran declaradas en el mismo archivo.
(function (global) {
  "use strict";

  // Suma EXACTA día por día dentro de [start, end] sobre el array `daily` dado, y recalcula
  // todas las tasas/costos desde esos totales reales (nunca prorrateando ni promediando tasas).
  // Fecha de "ayer" en hora LOCAL del navegador (nunca con toISOString/UTC, que puede
  // adelantar o atrasar un día según el huso horario del visitante).
  function yesterdayISO() {
    const now = new Date();
    const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    return `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
  }

  function aggregateExact(daily, start, end) {
    const rows = daily.filter((r) => r.d >= start && r.d <= end);
    const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
    const inversion = sum("inv");
    const impresiones = sum("imp");
    const clicks = sum("clk");
    const cmi = sum("cmi");
    const agendas = sum("ag");
    const citas = sum("ci");
    const asistencias = sum("asi");
    const cierres = sum("cie");
    const ventas = sum("ven");
    const recoleccion = sum("fac");

    // % de asistencia: solo cuenta días ya transcurridos (hasta ayer). La planilla ya trae
    // "citas" agendadas para los próximos días del mes en curso, pero esos días todavía no
    // tuvieron oportunidad de confirmarse como asistencia o no -- si se incluyen, inflan el
    // denominador y el % baja de forma artificial mientras el mes sigue corriendo.
    const pastEnd = end < yesterdayISO() ? end : yesterdayISO();
    const pastRows = rows.filter((r) => r.d <= pastEnd);
    const citasPasadas = pastRows.reduce((a, r) => a + r.ci, 0);
    const asistenciasPasadas = pastRows.reduce((a, r) => a + r.asi, 0);

    return {
      inversion, impresiones, clicks, cmi, agendas, citas, asistencias, cierres, ventas, recoleccion,
      cpm: impresiones ? (inversion / impresiones) * 1000 : null,
      ctr: impresiones ? (clicks / impresiones) * 100 : null,
      cmiLP: clicks ? (cmi / clicks) * 100 : null,
      cpcmi: cmi ? inversion / cmi : null,
      scr: cmi ? (agendas / cmi) * 100 : null,
      asisPct: citasPasadas ? (asistenciasPasadas / citasPasadas) * 100 : null,
      // Bases ya acotadas a "hasta ayer" -- expuestas para que quien sume asisPct entre
      // varios clientes (p.ej. el total de la cartera) use los mismos conteos corregidos
      // en vez de volver a sumar `citas`/`asistencias` completos (que sí incluyen futuro).
      citasPasadas, asistenciasPasadas,
      asisCost: asistencias ? inversion / asistencias : null,
      ccPct: asistencias ? (cierres / asistencias) * 100 : null,
      cac: cierres ? inversion / cierres : null,
      cpa: cierres ? inversion / cierres : null,
      roas: inversion ? recoleccion / inversion : null,
      croi: inversion ? (recoleccion - inversion) / inversion : null,
    };
  }

  const clp = (n) => "$" + Math.round(n).toLocaleString("es-CL");
  const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) + "%" : "—");
  const money2 = (n) => (n === null || n === undefined ? "—" : clp(n));
  const num2 = (n) => (n === null || n === undefined ? "—" : n.toLocaleString("es-CL"));
  const rate2 = (n) => (n === null || n === undefined ? "—" : n.toFixed(2).replace(".", ",") + "%");
  const mult2 = (n) => (n === null || n === undefined ? "—" : n.toFixed(2) + "×");
  const fmtDate = (iso) => {
    const [y, m, d] = iso.split("-");
    return `${d}/${m}/${y}`;
  };
  const MONTH_LABELS = { "01": "Ene", "02": "Feb", "03": "Mar", "04": "Abr", "05": "May", "06": "Jun", "07": "Jul", "08": "Ago", "09": "Sep", "10": "Oct", "11": "Nov", "12": "Dic" };

  function timeAgo(iso) {
    if (!iso) return "";
    const diffMs = Date.now() - new Date(iso).getTime();
    const mins = Math.round(diffMs / 60000);
    if (mins < 1) return "justo ahora";
    if (mins < 60) return `hace ${mins} min`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `hace ${hrs} h`;
    return `hace ${Math.round(hrs / 24)} d`;
  }

  // Formato compacto para tablas/tarjetas de la cartera: "$6,4M" sobre 1M, "$480k" bajo 1M.
  const m1 = (n) => "$" + (n / 1e6).toFixed(1).replace(".", ",") + "M";
  const k1 = (n) => (Math.abs(n) >= 1e6 ? m1(n) : "$" + Math.round(n / 1000) + "k");

  // Quita tildes y pasa a minúsculas — para búsquedas que no distingan acentos.
  function norm(s) {
    return String(s == null ? "" : s)
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .trim()
      .toLowerCase();
  }

  // Todas las claves de mes ("2026-07") presentes en `daily`, ordenadas, con sus límites
  // [start, end] reales dentro del array (no asume que el mes está completo).
  function monthsIn(daily) {
    const keys = Array.from(new Set(daily.map((r) => r.d.slice(0, 7)))).sort();
    return keys.map((key) => {
      const rows = daily.filter((r) => r.d.startsWith(key));
      return { key, start: rows[0].d, end: rows[rows.length - 1].d };
    });
  }

  // ---- Umbrales (semáforo) por métrica, compartidos entre cartera.html e index.html ----
  // Cada métrica tiene su propio par {risk, warn}: por debajo de `risk` => rojo (riesgo),
  // entre `risk` y `warn` => amarillo (atención), desde `warn` hacia arriba => verde (bien).
  const THRESHOLDS_KEY = "cartera:thresholds";
  const DEFAULT_THRESHOLDS = {
    roas: { risk: 5, warn: 8 },
    scr: { risk: 7, warn: 10 },
    asisPct: { risk: 40, warn: 50 },
    ccPct: { risk: 50, warn: 60 },
  };

  function loadThresholds() {
    try {
      const raw = global.localStorage ? global.localStorage.getItem(THRESHOLDS_KEY) : null;
      if (!raw) return JSON.parse(JSON.stringify(DEFAULT_THRESHOLDS));
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return JSON.parse(JSON.stringify(DEFAULT_THRESHOLDS));
      // Formato viejo: {risk, warn} plano, aplicaba solo a ROAS. Se migra preservando lo
      // que el usuario ya haya personalizado para ROAS y completando el resto con defaults.
      if (typeof parsed.risk === "number" && typeof parsed.warn === "number" && !parsed.roas) {
        return {
          ...JSON.parse(JSON.stringify(DEFAULT_THRESHOLDS)),
          roas: { risk: parsed.risk, warn: parsed.warn },
        };
      }
      // Formato nuevo, pero puede faltar alguna métrica (versión anterior de esta función,
      // o localStorage editado a mano) -- se completa con los defaults por métrica.
      const merged = {};
      for (const key of Object.keys(DEFAULT_THRESHOLDS)) {
        const m = parsed[key];
        merged[key] =
          m && typeof m.risk === "number" && typeof m.warn === "number"
            ? { risk: m.risk, warn: m.warn }
            : { ...DEFAULT_THRESHOLDS[key] };
      }
      return merged;
    } catch (e) {
      return JSON.parse(JSON.stringify(DEFAULT_THRESHOLDS));
    }
  }

  function saveThresholds(thresholds) {
    try {
      if (global.localStorage) global.localStorage.setItem(THRESHOLDS_KEY, JSON.stringify(thresholds));
    } catch (e) {
      /* localStorage puede fallar (modo privado, cuota) -- no es crítico */
    }
  }

  // value: número o null/undefined. t: {risk, warn} de una métrica puntual.
  function classifyThreshold(value, t) {
    if (value === null || value === undefined || !t) return "muted";
    if (value < t.risk) return "risk";
    if (value < t.warn) return "warn";
    return "healthy";
  }

  global.aggregateExact = aggregateExact;
  global.clp = clp;
  global.pct = pct;
  global.money2 = money2;
  global.num2 = num2;
  global.rate2 = rate2;
  global.mult2 = mult2;
  global.fmtDate = fmtDate;
  global.MONTH_LABELS = MONTH_LABELS;
  global.timeAgo = timeAgo;
  global.m1 = m1;
  global.k1 = k1;
  global.normText = norm;
  global.monthsIn = monthsIn;
  global.THRESHOLDS_KEY = THRESHOLDS_KEY;
  global.DEFAULT_THRESHOLDS = DEFAULT_THRESHOLDS;
  global.loadThresholds = loadThresholds;
  global.saveThresholds = saveThresholds;
  global.classifyThreshold = classifyThreshold;
})(window);
