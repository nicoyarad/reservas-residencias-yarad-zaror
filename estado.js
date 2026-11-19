/**
 * Estado compartido del calendario de reservas.
 *
 *  GET  /api/estado
 *    cabeceras: x-codigo (obligatoria), x-admin (opcional)
 *    -> 200 { rev, estado, admin, log? }   el log solo se envia a administradores
 *    -> 401 codigo_invalido
 *    -> 503 sin_almacenamiento
 *
 *  POST /api/estado
 *    cabeceras: x-codigo (obligatoria), x-admin (opcional)
 *    cuerpo: { base, estado, autor, entradas[], codigoNuevo?, adminNuevo? }
 *    -> 200 { rev, admin }
 *    -> 400 datos invalidos (incluye autor ausente)
 *    -> 401 codigo_invalido
 *    -> 403 admin_requerido  (config, claves, o reservas de terceros)
 *    -> 409 conflicto        (otro guardo primero; devuelve rev y estado vigentes)
 *
 * El documento guardado es { rev, codigo, admin, log[], estado{} }.
 * El log vive fuera de `estado` para que el cliente no pueda borrarlo al guardar.
 */

const CLAVE = "calendario:estado";
const PREFIJO = "calendario/estado-";
const LOG_MAX = 800;

/* Claves: la guardada en el documento manda; la variable de entorno es el
   respaldo maestro y siempre es valida. */
const CODIGO_MAESTRO = process.env.CODIGO_ACCESO || "1962";
const ADMIN_MAESTRO = process.env.CODIGO_ADMIN || "1989";

function cabecera(req, nombre, qs) {
  const h = req.headers[nombre];
  if (h) return String(h).trim();
  if (req.query && req.query[qs]) return String(req.query[qs]).trim();
  return "";
}
function claveValida(v) {
  return typeof v === "string" && /^[0-9A-Za-z._-]{4,24}$/.test(v.trim());
}

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

async function almacen() {
  if (REDIS_URL && REDIS_TOKEN) {
    const { Redis } = await import("@upstash/redis");
    const redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
    return {
      tipo: "redis",
      async leer() {
        const v = await redis.get(CLAVE);
        if (!v) return null;
        return typeof v === "string" ? JSON.parse(v) : v;
      },
      async escribir(doc) {
        await redis.set(CLAVE, JSON.stringify(doc));
      },
    };
  }

  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const { put, list, del } = await import("@vercel/blob");
    const recientes = async () => {
      const { blobs } = await list({ prefix: PREFIJO });
      blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
      return blobs;
    };
    return {
      tipo: "blob",
      async leer() {
        const blobs = await recientes();
        if (!blobs.length) return null;
        const r = await fetch(blobs[0].url, { cache: "no-store" });
        if (!r.ok) return null;
        return await r.json();
      },
      async escribir(doc) {
        await put(PREFIJO + doc.rev + ".json", JSON.stringify(doc), {
          access: "public",
          contentType: "application/json",
          addRandomSuffix: false,
          allowOverwrite: true,
          cacheControlMaxAge: 0,
        });
        const blobs = await recientes();
        const viejos = blobs.slice(6);
        if (viejos.length) await del(viejos.map((b) => b.url));
      },
    };
  }

  return null;
}

/* --- comparaciones para decidir si hace falta la clave de administrador --- */

function configIgual(a, b) {
  const norm = (e) =>
    JSON.stringify({
      titulo: (e && e.titulo) || "",
      lugares: (e && e.lugares) || [],
      asistentes: (e && e.asistentes) || [],
    });
  return norm(a) === norm(b);
}

function porId(lista) {
  const m = {};
  ((lista && lista.reservas) || []).forEach((r) => {
    if (r && r.id) m[r.id] = r;
  });
  return m;
}

/* Devuelve true si el autor toco reservas registradas por otra persona.
   Las reservas sin autor (datos de ejemplo o previos) quedan libres. */
function tocaAjenas(anterior, nuevo, autor) {
  const A = porId(anterior);
  const B = porId(nuevo);
  const mismo = (x) => {
    const d = String((x && x.por) || "").trim().toLowerCase();
    return !d || d === String(autor || "").trim().toLowerCase();
  };
  for (const id in A) {
    if (!B[id]) {
      if (!mismo(A[id])) return true; /* eliminada */
    } else if (JSON.stringify(A[id]) !== JSON.stringify(B[id])) {
      if (!mismo(A[id])) return true; /* modificada */
    }
  }
  return false;
}

/* Devuelve true si el nuevo estado elimina reservas que ya existian. */
function hayEliminadas(anterior, nuevo) {
  const A = porId(anterior);
  const B = porId(nuevo);
  for (const id in A) if (!B[id]) return true;
  return false;
}

function saneaEntradas(entradas, autor, ahora) {
  if (!Array.isArray(entradas)) return [];
  return entradas.slice(0, 40).map((e) => ({
    t: ahora,
    por: String((e && e.por) || autor).slice(0, 80),
    acc: String((e && e.acc) || "cambio").slice(0, 24),
    ref: String((e && e.ref) || "").slice(0, 160),
    det: String((e && e.det) || "").slice(0, 400),
    camb: Array.isArray(e && e.camb)
      ? e.camb.slice(0, 20).map((c) => ({
          c: String((c && c.c) || "").slice(0, 40),
          a: String((c && c.a) == null ? "" : c.a).slice(0, 120),
          d: String((c && c.d) == null ? "" : c.d).slice(0, 120),
        }))
      : [],
  }));
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  const dado = cabecera(req, "x-codigo", "codigo");
  const dadoAdmin = cabecera(req, "x-admin", "admin");

  const st = await almacen();

  /* Sin almacenamiento no hay claves guardadas: se validan contra las maestras,
     de modo que la puerta funciona igual desde el primer momento. */
  if (!st) {
    if (!dado || dado !== CODIGO_MAESTRO) {
      return res.status(401).json({ error: "codigo_invalido" });
    }
    return res.status(503).json({
      error: "sin_almacenamiento",
      mensaje:
        "Falta conectar un almacenamiento. En Vercel: Storage > Create Database > Upstash for Redis, conectarlo al proyecto y volver a desplegar.",
    });
  }

  try {
    const doc0 = await st.leer();
    const codigoVigente = doc0 && doc0.codigo ? String(doc0.codigo) : CODIGO_MAESTRO;
    const adminVigente = doc0 && doc0.admin ? String(doc0.admin) : ADMIN_MAESTRO;

    if (!dado || (dado !== codigoVigente && dado !== CODIGO_MAESTRO)) {
      return res.status(401).json({ error: "codigo_invalido" });
    }
    const esAdmin = !!dadoAdmin && (dadoAdmin === adminVigente || dadoAdmin === ADMIN_MAESTRO);
    const logActual = (doc0 && Array.isArray(doc0.log) && doc0.log) || [];

    if (req.method === "GET") {
      const cuerpo = {
        rev: doc0 ? doc0.rev || 0 : 0,
        estado: doc0 ? doc0.estado : null,
        admin: esAdmin,
      };
      if (esAdmin) cuerpo.log = logActual;
      if (dadoAdmin && !esAdmin) cuerpo.adminError = true;
      return res.status(200).json(cuerpo);
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      if (!body.estado || typeof body.estado !== "object") {
        return res.status(400).json({ error: "estado_invalido" });
      }
      const autor = String(body.autor || "").trim();
      if (!autor) {
        return res.status(400).json({
          error: "autor_requerido",
          mensaje: "Indique el nombre de quien registra el cambio.",
        });
      }

      const revActual = doc0 ? doc0.rev || 0 : 0;
      if (body.base != null && Number(body.base) !== revActual) {
        const conf = { error: "conflicto", rev: revActual, estado: doc0 ? doc0.estado : null };
        if (esAdmin) conf.log = logActual;
        return res.status(409).json(conf);
      }

      const anterior = doc0 ? doc0.estado : null;
      /* La primera carga (documento inexistente) siembra la configuracion inicial. */
      const cambiaConfig = !!anterior && !configIgual(anterior, body.estado);
      const cambiaClaves = body.codigoNuevo != null || body.adminNuevo != null;
      const ajenas = tocaAjenas(anterior, body.estado, autor);
      const borra = !!anterior && hayEliminadas(anterior, body.estado);

      if ((cambiaConfig || cambiaClaves || ajenas || borra) && !esAdmin) {
        return res.status(403).json({
          error: "admin_requerido",
          motivo: cambiaClaves ? "claves" : cambiaConfig ? "configuracion" : borra ? "eliminacion" : "reservas_ajenas",
          mensaje: borra
            ? "Eliminar reservas requiere la clave de administrador."
            : ajenas
            ? "Modificar o eliminar reservas registradas por otra persona requiere la clave de administrador."
            : "Este cambio requiere la clave de administrador.",
        });
      }

      let codigo = codigoVigente;
      if (body.codigoNuevo != null && String(body.codigoNuevo).trim() !== "") {
        if (!claveValida(String(body.codigoNuevo))) {
          return res.status(400).json({
            error: "clave_no_valida",
            mensaje: "El codigo debe tener entre 4 y 24 caracteres (numeros o letras sin espacios).",
          });
        }
        codigo = String(body.codigoNuevo).trim();
      }
      let admin = adminVigente;
      if (body.adminNuevo != null && String(body.adminNuevo).trim() !== "") {
        if (!claveValida(String(body.adminNuevo))) {
          return res.status(400).json({
            error: "clave_no_valida",
            mensaje: "La clave de administrador debe tener entre 4 y 24 caracteres (numeros o letras sin espacios).",
          });
        }
        admin = String(body.adminNuevo).trim();
      }

      const ahora = Date.now();
      const nuevas = saneaEntradas(body.entradas, autor, ahora);
      const log = logActual.concat(nuevas).slice(-LOG_MAX);

      const doc = { rev: ahora, codigo: codigo, admin: admin, log: log, estado: body.estado };
      await st.escribir(doc);
      return res.status(200).json({ rev: doc.rev, almacen: st.tipo, admin: esAdmin });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "metodo_no_permitido" });
  } catch (e) {
    const causa = (e && e.cause && (e.cause.code || e.cause.message)) || "";
    const host = String(REDIS_URL || "").replace(/^https?:\/\//, "").split("/")[0];
    const salida = { error: "fallo_almacenamiento", mensaje: String((e && e.message) || e) };
    if (dado === CODIGO_MAESTRO) { salida.causa = causa; salida.destino = host; }
    return res.status(500).json(salida);
  }
}
