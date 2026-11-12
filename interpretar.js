// Vercel Serverless Function: interpreta texto o fotos de tickets con Claude.
// La clave ANTHROPIC_API_KEY vive solo en Vercel (nunca llega al navegador).
const SUPABASE_URL = "https://excrczznrjevdosmlhmy.supabase.co";
const SUPABASE_KEY = "sb_publishable_bg0Fgc8i4VGhQ1IZhAUtcA_2vOpoylC";
const MODEL = "claude-haiku-5-5";

const CATS_OUT = ["Súper/comida","Delivery/salidas","Transporte","Alquiler/expensas","Servicios","Celu/internet","Suscripciones","Ropa","Salud","Educación","Regalos","Insumos emprendimiento","Cuotas/préstamos","Intereses/comisiones","Ahorro/inversión","Otros"];
const CATS_IN = ["Sueldo","Emprendimiento","Changas/extras","Otros"];
const MEDIOS = ["Efectivo","Billetera virtual","Banco","Crédito"];

function normMedio(v) {
  v = String(v || "");
  if (MEDIOS.includes(v)) return v;
  if (/mercado ?pago|ual[aá]|naranja|brubank|lemon|personal ?pay|modo|billetera|cuenta dni/i.test(v)) return "Billetera virtual";
  if (/cr[eé]dito|tarjeta|visa|master|amex/i.test(v)) return "Crédito";
  if (/d[eé]bito|transf|banco|cbu/i.test(v)) return "Banco";
  return "Efectivo";
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });
  const token = (req.headers.authorization || "").replace(/^Bearer /, "");
  if (!token) return res.status(401).json({ error: "Tenés que iniciar sesión" });

  // 1) Verificar usuario y descontar 1 uso del día (límite en la base de datos)
  const rpc = await fetch(`${SUPABASE_URL}/rest/v1/rpc/usar_ia`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: "{}",
  });
  if (rpc.status === 401 || rpc.status === 403) return res.status(401).json({ error: "Sesión vencida, volvé a entrar" });
  const usados = await rpc.json().catch(() => null);
  if (!rpc.ok) {
    const msg = JSON.stringify(usados || "");
    if (msg.includes("limite")) return res.status(429).json({ error: "Llegaste al límite de 20 lecturas por hoy. Mañana se renueva." });
    return res.status(500).json({ error: "No se pudo verificar el uso" });
  }

  // 2) Armar el pedido
  const { texto = "", imagenes = [], hoy } = req.body || {};
  const imgs = (Array.isArray(imagenes) ? imagenes : []).slice(0, 4)
    .filter(i => i && /^image\/(jpeg|png|webp)$/.test(i.media_type) && typeof i.data === "string" && i.data.length < 3_000_000);
  const t = String(texto).slice(0, 1500);
  if (!t.trim() && !imgs.length) return res.status(400).json({ error: "Mandá un texto o una foto" });
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(hoy || "") ? hoy : new Date().toISOString().slice(0, 10);

  const prompt = `Convertí esto en movimientos de plata de una persona en Argentina. Hoy es ${fecha}.
Texto del usuario: """${t || "(ver imágenes)"}"""
${imgs.length ? `Hay ${imgs.length} imagen(es). Si es un TICKET o factura: un solo gasto por el TOTAL. Si es un RESUMEN DE TARJETA: cada consumo es un gasto con medio "Crédito" (en cuotas, el monto de la cuota), ignorá pagos y saldos anteriores, impuestos/intereses van como "Intereses/comisiones". Si es un comprobante de transferencia: un movimiento con medio "Banco" o "Billetera virtual".` : ""}
Reglas:
- "luca"/"lucas" = mil (20 lucas = 20000). Montos en pesos, número sin símbolos.
- tipo "out" si gastó/pagó/compró; "in" si cobró/vendió/le pagaron.
- cat para "out", una de: ${CATS_OUT.join(", ")}.
- cat para "in", una de: ${CATS_IN.join(", ")}.
- medio, uno de: ${MEDIOS.join(", ")}. Mercado Pago, Ualá, Naranja X, etc. = "Billetera virtual". Débito o transferencia = "Banco". Si no se sabe: "Efectivo".
- fecha AAAA-MM-DD: la del ticket si se ve, si no hoy (o "ayer" si lo dice).
- desc: comercio o detalle corto (máx 40 caracteres).
Respondé SOLO con JSON válido, sin texto extra: {"movs":[{"tipo":"out","monto":3500,"cat":"Súper/comida","medio":"Efectivo","fecha":"${fecha}","desc":"Súper"}]}. Si no hay montos: {"movs":[]}.`;

  const content = [...imgs.map(i => ({ type: "image", source: { type: "base64", media_type: i.media_type, data: i.data } })), { type: "text", text: prompt }];

  // 3) Llamar a Claude
  const KEY = String(process.env.ANTHROPIC_API_KEY || "").trim();
  if (!KEY) { console.error("Falta ANTHROPIC_API_KEY"); return res.status(500).json({ error: "Falta configurar la clave de la IA en Vercel" }); }
  let r;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 2000, messages: [{ role: "user", content }] }),
    });
  } catch (e) { console.error("Error llamando a la IA:", e); return res.status(502).json({ error: "No se pudo conectar con la IA: " + String(e && (e.cause?.message || e.message) || e).slice(0, 120) }); }
  const out = await r.json().catch(() => null);
  if (!r.ok) {
    console.error("La IA respondió", r.status, JSON.stringify(out).slice(0, 500));
    const t = out?.error?.type || "";
    if (r.status === 429 || /rate|limit|credit|billing/i.test(JSON.stringify(out))) return res.status(503).json({ error: "La IA no está disponible ahora (límite o crédito agotado). Cargalo a mano." });
    return res.status(502).json({ error: "La IA respondió con error " + r.status + (t ? " (" + t + ")" : "") });
  }
  const txt = (out.content || []).filter(c => c.type === "text").map(c => c.text).join("");
  let data; try { data = JSON.parse((txt.match(/\{[\s\S]*\}/) || ["{}"])[0]); } catch { data = {}; }

  // 4) Limpiar y devolver
  const movs = (Array.isArray(data.movs) ? data.movs : []).slice(0, 40).map(m => {
    const tipo = m.tipo === "in" ? "in" : "out", cats = tipo === "in" ? CATS_IN : CATS_OUT;
    return {
      tipo, monto: Math.abs(Math.round((+m.monto || 0) * 100) / 100),
      cat: cats.includes(m.cat) ? m.cat : "Otros",
      medio: normMedio(m.medio),
      fecha: /^\d{4}-\d{2}-\d{2}$/.test(m.fecha || "") ? m.fecha : fecha,
      desc: String(m.desc || "").slice(0, 60),
    };
  }).filter(m => m.monto > 0);
  return res.status(200).json({ movs, usados_hoy: usados });
}

