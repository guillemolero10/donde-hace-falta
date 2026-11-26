// Cliente del agente de la web: llama a `POST /api/agente` y, si no hay IA (503 sin clave, apagado o sin presupuesto,
// 504 por tiempo, 429 por límite), si no hay red o si `/api` ni siquiera existe (con `npm run dev` no existe), responde
// en el navegador con el modo sin IA (`responderSinIA`). La demo no depende de una clave ni de la wifi.
//
// Sin DOM ni React: `fetch` y la respuesta local se inyectan, así se prueba en Node.
import type { Accion, PeticionAgente, RespuestaAgente } from "./tipos";

/** Por qué se ha usado el modo sin IA en lugar del servidor. */
export type MotivoRespaldo =
  | "sin_api" // `/api/agente` no existe (servidor de desarrollo) o no devuelve lo esperado
  | "sin_red"
  | "apagado"
  | "sin_clave"
  | "presupuesto"
  | "proveedor"
  | "no_disponible" // 503 sin motivo conocido
  | "tiempo" // 504 o más de 28 s
  | "limite" // 429
  | "peticion"; // 400

export interface ResultadoPregunta {
  respuesta: RespuestaAgente;
  /** `api`: la respuesta es del servidor. `local`: calculada aquí con reglas. */
  via: "api" | "local";
  motivo: MotivoRespaldo | null;
  /** Frase para el usuario cuando se ha pasado al modo sin IA. */
  aviso: string | null;
}

/** Preguntas con IA por visitante y día (100 desde el 26-nov; en Vercel, `AGENTE_LIMITE_IP_DIA`). El de reserva del servidor (`LIMITE_IP_POR_DEFECTO`, sin variable) sigue en 3. Solo se usa hasta que el servidor dice su límite real (`limite` en el 200 y en el 429). */
export const PREGUNTAS_IA_BETA = 100;

/** «te quedan 2 preguntas» / «te queda 1 pregunta». */
export function textoRestantes(n: number): string {
  return n === 1 ? "te queda 1 pregunta con IA hoy" : `te quedan ${n} preguntas con IA hoy`;
}

/** Frase que acompaña a «Modo sin IA» según el motivo. Sin tecnicismos. */
export function avisoDeMotivo(m: MotivoRespaldo, limite: number = PREGUNTAS_IA_BETA): string {
  switch (m) {
    case "sin_api":
      return "El agente de IA no está disponible en esta versión; respondo con reglas.";
    case "sin_red":
      return "No hay conexión con el agente de IA; respondo con reglas, sin red.";
    case "apagado":
      return "El agente de IA está apagado por ahora; respondo con reglas.";
    case "sin_clave":
      return "El agente de IA no está configurado; respondo con reglas.";
    case "presupuesto":
      return "El agente de IA ha agotado su límite de gasto de hoy; respondo con reglas.";
    case "proveedor":
      return "El servicio de IA ha fallado; respondo con reglas.";
    case "tiempo":
      return "El agente de IA ha tardado demasiado; respondo con reglas.";
    case "limite":
      return `Cada conexión puede hacer ${limite} ${limite === 1 ? "pregunta" : "preguntas"} con IA al día y ya se han usado las de hoy. Sigo respondiendo con reglas, con los mismos datos.`;
    case "peticion":
    case "no_disponible":
      return "El agente de IA no está disponible ahora; respondo con reglas.";
  }
}

/** Frase cuando el servidor ha descartado el texto del modelo por seguridad y da la respuesta calculada (`motivo: "revisada"`). */
export const AVISO_RESPUESTA_REVISADA = "El agente propuso una cifra o un enlace que no sale del cálculo; te doy la respuesta calculada con los datos.";

/** Tiempo máximo de espera: el servidor corta a los 26 s (504; `TIEMPO_TURNO_MS` en `servidor/agente.ts`). */
export const TIEMPO_MAXIMO_MS = 28_000;
/** Tras un fallo no se vuelve a pedir al servidor durante un rato (no se espera dos veces un tiempo agotado ni se pide algo que no existe). */
export const ESPERA_SIN_API_MS = 10 * 60_000;
export const ESPERA_TRAS_FALLO_MS = 60_000;

const TIPOS_ACCION = new Set<Accion["tipo"]>(["elegir_servicio", "mover_mapa", "marcar_puntos", "mostrar_ranking", "abrir_ficha"]);

/** Límite por visitante que manda el servidor: entero >= 1. */
function esLimite(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x) && x >= 1;
}

/** ¿Es el JSON de una `RespuestaAgente`? Lo mínimo para no romper la pantalla; cada acción se valida otra vez al ejecutarla. */
export function esRespuestaAgente(x: unknown): x is RespuestaAgente {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  if (typeof r.texto !== "string" || !r.texto.trim()) return false;
  if (!Array.isArray(r.acciones) || !Array.isArray(r.pasos)) return false;
  if (r.modo !== "ia" && r.modo !== "reglas") return false;
  if (r.restantes !== null && r.restantes !== undefined && (typeof r.restantes !== "number" || !Number.isFinite(r.restantes))) return false;
  if (r.limite !== undefined && !esLimite(r.limite)) return false;
  if (!r.acciones.every((a) => typeof a === "object" && a !== null && TIPOS_ACCION.has((a as { tipo: Accion["tipo"] }).tipo))) return false;
  return r.pasos.every((p) => typeof p === "object" && p !== null && typeof (p as { herramienta?: unknown }).herramienta === "string" && typeof (p as { resumen?: unknown }).resumen === "string");
}

export interface OpcionesCliente {
  /** Respuesta en el navegador (modo sin IA). */
  local: (peticion: PeticionAgente) => Promise<RespuestaAgente>;
  fetch?: typeof fetch;
  url?: string;
  tiempoMaximoMs?: number;
  /** Reloj (para probar las esperas). */
  ahora?: () => number;
}

export interface ClienteAgente {
  preguntar(peticion: PeticionAgente, senal?: AbortSignal): Promise<ResultadoPregunta>;
  /** Olvida los fallos anteriores y vuelve a probar con el servidor en la siguiente pregunta. */
  olvidarFallos(): void;
}

function motivoDe503(cuerpo: unknown): MotivoRespaldo {
  const m = typeof cuerpo === "object" && cuerpo !== null ? (cuerpo as { motivo?: unknown }).motivo : undefined;
  return m === "apagado" || m === "sin_clave" || m === "presupuesto" || m === "proveedor" ? m : "no_disponible";
}

async function jsonODefecto(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export function crearClienteAgente(o: OpcionesCliente): ClienteAgente {
  const url = o.url ?? "/api/agente";
  const tiempoMax = o.tiempoMaximoMs ?? TIEMPO_MAXIMO_MS;
  const ahora = o.ahora ?? (() => Date.now());
  let sinServidorHasta = 0;
  let ultimoMotivo: MotivoRespaldo | null = null;
  /** Último límite por visitante que ha dicho el servidor (puede no ser 3 si se cambia `AGENTE_LIMITE_IP_DIA`). */
  let limiteServidor: number | undefined;

  async function enLocal(peticion: PeticionAgente, motivo: MotivoRespaldo): Promise<ResultadoPregunta> {
    let respuesta: RespuestaAgente;
    try {
      respuesta = await o.local(peticion);
    } catch (e) {
      respuesta = {
        texto: `No he podido calcular la respuesta${e instanceof Error && e.message ? `: ${e.message}` : ""}. Inténtalo de nuevo.`,
        acciones: [],
        pasos: [],
        modo: "reglas",
        restantes: null,
      };
    }
    return { respuesta: { ...respuesta, modo: "reglas" }, via: "local", motivo, aviso: avisoDeMotivo(motivo, limiteServidor) };
  }

  function recordar(motivo: MotivoRespaldo, reinicio?: unknown): void {
    ultimoMotivo = motivo;
    let espera = motivo === "sin_api" ? ESPERA_SIN_API_MS : ESPERA_TRAS_FALLO_MS;
    if (motivo === "limite" && typeof reinicio === "string") {
      const t = Date.parse(reinicio) - ahora();
      if (Number.isFinite(t) && t > 0) espera = Math.min(t, 6 * 3_600_000);
    }
    sinServidorHasta = ahora() + espera;
  }

  return {
    olvidarFallos() {
      sinServidorHasta = 0;
      ultimoMotivo = null;
    },

    async preguntar(peticion, senal) {
      if (ultimoMotivo && ahora() < sinServidorHasta) return enLocal(peticion, ultimoMotivo);

      const f = o.fetch ?? (typeof fetch === "function" ? fetch.bind(globalThis) : undefined);
      if (!f) {
        recordar("sin_api");
        return enLocal(peticion, "sin_api");
      }

      const control = new AbortController();
      let porTiempo = false;
      const reloj = setTimeout(() => {
        porTiempo = true;
        control.abort();
      }, tiempoMax);
      const alCancelar = () => control.abort();
      senal?.addEventListener("abort", alCancelar, { once: true });

      try {
        let res: Response;
        try {
          res = await f(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(peticion),
            signal: control.signal,
          });
        } catch (e) {
          if (senal?.aborted) throw e; // lo ha cancelado quien preguntó: no hay respaldo
          const motivo: MotivoRespaldo = porTiempo ? "tiempo" : "sin_red";
          recordar(motivo);
          return await enLocal(peticion, motivo);
        }

        if (res.status === 200) {
          const cuerpo = await jsonODefecto(res);
          if (esRespuestaAgente(cuerpo)) {
            ultimoMotivo = null;
            sinServidorHasta = 0;
            if (cuerpo.limite !== undefined) limiteServidor = cuerpo.limite;
            const revisada = cuerpo.modo === "reglas" && cuerpo.motivo === "revisada";
            return { respuesta: { ...cuerpo, restantes: cuerpo.restantes ?? null }, via: "api", motivo: null, aviso: revisada ? AVISO_RESPUESTA_REVISADA : null };
          }
          // 200 con otra cosa (el servidor de desarrollo devuelve la página de inicio): `/api` no existe.
          recordar("sin_api");
          return await enLocal(peticion, "sin_api");
        }

        const cuerpo = await jsonODefecto(res);
        let motivo: MotivoRespaldo;
        if (res.status === 503) motivo = motivoDe503(cuerpo);
        else if (res.status === 504) motivo = "tiempo";
        else if (res.status === 429) motivo = "limite";
        else if (res.status === 400) motivo = "peticion";
        else if (res.status === 404 || res.status === 405 || res.status === 501) motivo = "sin_api";
        else motivo = "proveedor";
        // Un 400 es un problema de esta pregunta, no del servidor: no se apaga el agente para las siguientes.
        if (motivo === "peticion") return await enLocal(peticion, motivo);
        if (motivo === "limite" && typeof cuerpo === "object" && cuerpo !== null) {
          const l = (cuerpo as { limite?: unknown }).limite;
          if (esLimite(l)) limiteServidor = l;
        }
        recordar(motivo, typeof cuerpo === "object" && cuerpo !== null ? (cuerpo as { reinicio?: unknown }).reinicio : undefined);
        return await enLocal(peticion, motivo);
      } finally {
        clearTimeout(reloj);
        senal?.removeEventListener("abort", alCancelar);
      }
    },
  };
}

// ---------------------------------------------------------------- historial
/** Mensajes que se envían: los últimos `max` (el servidor admite 12), con los textos recortados a 500 caracteres. */
export function mensajesParaEnviar(
  historial: readonly { rol: "usuario" | "asistente"; texto: string }[],
  max = 12,
  maxCaracteres = 500,
): { rol: "usuario" | "asistente"; texto: string }[] {
  const recortar = (t: string) => (t.length <= maxCaracteres ? t : `${t.slice(0, maxCaracteres - 1).trimEnd()}…`);
  let ventana = historial.slice(-max).map((m) => ({ rol: m.rol, texto: recortar(m.texto) }));
  // Tiene que empezar por una pregunta del usuario.
  while (ventana.length > 1 && ventana[0]?.rol !== "usuario") ventana = ventana.slice(1);
  return ventana;
}
