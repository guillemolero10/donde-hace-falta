// `POST /api/agente`: el agente con IA de «¿Dónde hace falta?». La lógica es independiente de Vercel (recibe el método, el cuerpo
// y la IP; devuelve estado y JSON), así se prueba en Node con el proveedor simulado y la usan igual la función desplegada
// (`servidor/vercel.ts`) y el servidor de desarrollo (`servidor/vite.ts`).
//
// Cómo funciona (plan, sección IA):
//  1. Comprueba que está activo y que hay clave (si no, 503 limpio y la web responde con el modo sin IA).
//  2. Valida la petición (≤ 12 mensajes de ≤ 500 caracteres, contexto conocido) y aplica los límites por visitante y de gasto.
//  3. Bucle de tool calling: el modelo SOLO puede llamar a las 5 herramientas del motor (`herramientas.ts`, las mismas del modo
//     sin IA); el servidor valida los argumentos, las ejecuta sobre los JSON de `public/donde/` y acumula las `Accion`.
//  4. Valida el texto final (`validador.ts`): cada cifra debe salir de las herramientas. Si no, responde con la plantilla del modo
//     reglas a partir de las mismas salidas (`modo: "reglas"`: el texto no lo ha escrito la IA).
// No se registra el texto del usuario ni el de la respuesta; solo herramientas, tokens, coste y tiempos.
import { aviso2030, REFERENCIA_NOMBRES } from "./textos";
import { ALIAS_LUGARES } from "../src/lib/aliasLugares";
import { crearEntorno, ejecutarHerramienta, ESQUEMAS_HERRAMIENTAS, NOMBRES_HERRAMIENTAS, type Entorno, type ResultadoHerramienta } from "../src/lib/donde/herramientas";
import { MAX_CARACTERES_PREGUNTA, MAX_MENSAJES, responderSinIA } from "../src/lib/donde/intencion";
import { lugarPorId } from "../src/lib/donde/lugares";
import { radioEs } from "../src/lib/donde/panelDonde";
import { redactarResultado } from "../src/lib/donde/plantillas";
import { esServicioId, SERVICIOS } from "../src/lib/donde/servicios";
import type { Accion, ContextoAgente, MensajeAgente, PasoAgente, PeticionAgente, RespuestaAgente } from "../src/lib/donde/tipos";
import type { Cargador } from "./datos";
import { PROMPT_VERSION, promptAgente } from "./prompts/agente-v4";
import { ErrorPresupuesto, limiteIpDia, proximoReinicio, topeDiarioUsd, type Presupuesto } from "./presupuesto";
import { ErrorProveedor, ErrorTiempo, llamarModelo, proveedorDesdeEntorno, type HerramientaModelo, type MensajeModelo } from "./proveedor";
import { numerosPermitidos, paraElModelo, validarTexto } from "./validador";
import { vistaParaModelo } from "./vista-modelo";

export { PROMPT_VERSION };

/**
 * El servidor corta a los 40 s (26-nov; antes 26 s, R5): la web espera 45 s y la función tiene `maxDuration` de 60 s. El reloj empieza después del
 * arranque en frío y de leer el cuerpo, así que quedan ~5 s de margen frente a la web y ~20 s frente a Vercel.
 */
export const TIEMPO_TURNO_MS = 40_000; // 26-nov: 40 s (web 45 s, maxDuration 60 s) para que Meta lento no dispare el respaldo
export const MAX_VUELTAS = 5;
export const MAX_LLAMADAS_POR_VUELTA = 3;
export const MAX_LLAMADAS_TOTALES = 6;
/** Mensajes del historial que se mandan al modelo (la web puede enviar hasta 12). */
export const MAX_MENSAJES_AL_MODELO = 6;
export const MAX_CUERPO_CARACTERES = 20_000;
/** Un resultado de herramienta más largo que esto no se manda entero al modelo. */
export const MAX_RESULTADO_AL_MODELO = 12_000;

type Env = Record<string, string | undefined>;

export interface Dependencias {
  env: Env;
  cargador: Cargador;
  presupuesto: Presupuesto;
  /** El `fetch` hacia el proveedor (se simula en los tests). */
  fetch?: typeof fetch;
  ahora?: () => number;
  espera?: (ms: number) => Promise<void>;
  /** Una línea de registro por pregunta (sin texto del usuario). Por defecto `console.info`. */
  registrar?: (linea: Record<string, unknown>) => void;
}

export interface EntradaHttp {
  metodo: string;
  /** Cuerpo en bruto (texto) o null. */
  cuerpo: string | null;
  ip: string;
}

export interface SalidaHttp {
  status: number;
  cuerpo: unknown;
}

const NO_DISPONIBLE = (motivo: "sin_clave" | "apagado" | "presupuesto" | "proveedor"): SalidaHttp => ({
  status: 503,
  cuerpo: { error: "agente_no_disponible", motivo },
});

// ---------------------------------------------------------------- validación de la petición
const VISTAS = new Set(["donde", "municipio"]);
const REFERENCIAS = new Set(["media", "imserso_espana", "imserso_madrid"]);

function esObjeto(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export type PeticionValidada = { ok: true; peticion: PeticionAgente } | { ok: false; motivo: string };

/** Valida a mano (sin zod) lo que envía la web. Cualquier cosa rara es un 400. */
export function validarPeticion(x: unknown): PeticionValidada {
  const mal = (motivo: string): PeticionValidada => ({ ok: false, motivo });
  if (!esObjeto(x)) return mal("cuerpo");
  const ms = x.mensajes;
  if (!Array.isArray(ms) || ms.length === 0) return mal("sin_mensajes");
  if (ms.length > MAX_MENSAJES) return mal("demasiados_mensajes");
  const mensajes: MensajeAgente[] = [];
  for (const m of ms) {
    if (!esObjeto(m) || (m.rol !== "usuario" && m.rol !== "asistente") || typeof m.texto !== "string") return mal("mensaje");
    if (m.texto.length > MAX_CARACTERES_PREGUNTA) return mal("mensaje_largo");
    mensajes.push({ rol: m.rol, texto: m.texto });
  }
  const ultimo = mensajes[mensajes.length - 1]!;
  if (ultimo.rol !== "usuario" || !ultimo.texto.trim()) return mal("ultimo_no_usuario");

  const c = x.contexto ?? {};
  if (!esObjeto(c)) return mal("contexto");
  const vista = c.vista ?? "donde";
  if (typeof vista !== "string" || !VISTAS.has(vista)) return mal("vista");
  const servicio = c.servicio ?? null;
  if (servicio !== null && !esServicioId(servicio)) return mal("servicio");
  const radio = c.radio_m ?? null;
  if (radio !== null && (typeof radio !== "number" || !Number.isFinite(radio) || radio <= 0 || radio > 100_000)) return mal("radio");
  const lugar = c.lugar ?? null;
  if (lugar !== null && (typeof lugar !== "string" || !/^(mun|dis|zona):[0-9A-Za-z,]{1,20}$/.test(lugar))) return mal("lugar");
  if (c.anio !== undefined && c.anio !== 2025 && c.anio !== 2030) return mal("anio");
  if (c.referencia !== undefined && (typeof c.referencia !== "string" || !REFERENCIAS.has(c.referencia))) return mal("referencia");
  const zona = c.zona ?? null;
  if (zona !== null && (typeof zona !== "string" || !/^[0-9]{2}(,[0-9]{2}){0,10}$/.test(zona))) return mal("zona");

  const contexto: ContextoAgente = {
    vista: vista as ContextoAgente["vista"],
    servicio,
    radio_m: radio,
    lugar,
    ...(c.anio ? { anio: c.anio as 2025 | 2030 } : {}),
    ...(c.referencia ? { referencia: c.referencia as NonNullable<ContextoAgente["referencia"]> } : {}),
    ...(zona ? { zona } : {}),
  };
  return { ok: true, peticion: { mensajes, contexto } };
}

// ---------------------------------------------------------------- herramientas para el modelo
/**
 * Lo que ve el modelo: los esquemas del motor, SIN coordenadas. `simular_centro` admite `lat`/`lon` para el «Tú decides» de la web
 * (el usuario arrastra un pin), pero el modelo debe indicar un lugar por su nombre: así ni un modelo equivocado ni una inyección de
 * prompt pueden colocar pines donde quieran (T4-9). El servidor además rechaza `lat`/`lon` si llegan en una llamada (`ejecutarLlamada`).
 */
/** Descripciones neutras para el modelo (las del motor dicen «déficit» y el modelo las repite). */
const DESCRIPCION_PARA_EL_MODELO: Record<string, string> = {
  ranking_deficit: "Ranking de municipios (o distritos de Madrid) donde un centro nuevo ayudaría más, para un servicio. Devuelve cifras calculadas con datos oficiales, ya formateadas: cópialas tal cual.",
  ubicacion_optima: "Mejor sitio (o los n mejores, hasta 3) para un centro nuevo de un servicio: en servicios por distancia, el que más personas acerca al centro; en residencias, el que más plazas pasa a cubrir. Lo calcula el modelo; no pongas cifras tú.",
  simular_centro: "Qué consigue un centro nuevo en un lugar (personas que ganan acceso, o plazas que pasan a estar cubiertas en residencias), comparado con el mejor punto del modelo en su zona.",
  ficha_municipio: "Qué servicios tiene un municipio o distrito de Madrid y dónde ayudaría más un centro nuevo, frente a la media y a municipios de su tamaño. Úsala también para comparar dos lugares (una llamada por lugar).",
};

export function esquemaParaElModelo(e: (typeof ESQUEMAS_HERRAMIENTAS)[number]): HerramientaModelo {
  const parametros = { ...(e.input_schema as unknown as Record<string, unknown>) };
  if (e.name === "simular_centro") {
    const { lat: _lat, lon: _lon, ...resto } = e.input_schema.properties as Record<string, unknown>;
    parametros.properties = resto;
    parametros.required = ["servicio", "lugar"];
  }
  return { type: "function", function: { name: e.name, description: DESCRIPCION_PARA_EL_MODELO[e.name] ?? e.description, parameters: parametros } };
}

export const HERRAMIENTAS_MODELO: HerramientaModelo[] = ESQUEMAS_HERRAMIENTAS.map(esquemaParaElModelo);

const NOMBRES = new Set<string>(NOMBRES_HERRAMIENTAS);

function resultadoParaModelo(r: ResultadoHerramienta): string {
  const t = JSON.stringify(paraElModelo(vistaParaModelo(r)));
  if (t.length <= MAX_RESULTADO_AL_MODELO) return t;
  return JSON.stringify({ ok: false, error: { codigo: "datos", mensaje: "El resultado es demasiado largo; pide menos filas o un ámbito más pequeño." } });
}

async function ejecutarLlamada(nombre: string, argumentos: string, entorno: Entorno): Promise<ResultadoHerramienta> {
  if (!NOMBRES.has(nombre)) {
    return { ok: false, herramienta: "mover_mapa", error: { codigo: "entrada", mensaje: `La herramienta «${nombre.slice(0, 40)}» no existe.` } };
  }
  let entrada: unknown;
  try {
    entrada = argumentos.trim() ? JSON.parse(argumentos) : {};
  } catch {
    return { ok: false, herramienta: nombre as ResultadoHerramienta["herramienta"], error: { codigo: "entrada", mensaje: "Los argumentos no son un JSON válido." } };
  }
  // El modelo no escribe coordenadas (T4-9): solo nombres de lugar. Las coordenadas son del «Tú decides» de la web, no de esta ruta.
  if (typeof entrada === "object" && entrada !== null && ("lat" in entrada || "lon" in entrada)) {
    return { ok: false, herramienta: nombre as ResultadoHerramienta["herramienta"], error: { codigo: "entrada", mensaje: "No se admiten coordenadas: indica el lugar por su nombre." } };
  }
  return ejecutarHerramienta(nombre, entrada, entorno);
}

function deduplicar(acciones: Accion[]): Accion[] {
  const vistas = new Set<string>();
  return acciones.filter((a) => {
    const k = JSON.stringify(a);
    if (vistas.has(k)) return false;
    vistas.add(k);
    return true;
  });
}

// ---------------------------------------------------------------- el manejador
export async function manejarAgente(entrada: EntradaHttp, deps: Dependencias): Promise<SalidaHttp> {
  const ahora = deps.ahora ?? (() => Date.now());
  const registrar = deps.registrar ?? ((l: Record<string, unknown>) => console.info(JSON.stringify(l)));
  const inicio = ahora();

  if (entrada.metodo !== "POST") return { status: 405, cuerpo: { error: "metodo" } };
  if (deps.env.AGENTE_ACTIVO?.trim() !== "1") return NO_DISPONIBLE("apagado");
  const proveedor = proveedorDesdeEntorno(deps.env);
  if (!proveedor) return NO_DISPONIBLE("sin_clave");
  const tope = topeDiarioUsd(deps.env);
  try {
    deps.presupuesto.comprobar(tope);
  } catch {
    return NO_DISPONIBLE("presupuesto");
  }

  // ---- petición
  if (entrada.cuerpo === null || entrada.cuerpo.length > MAX_CUERPO_CARACTERES) return { status: 400, cuerpo: { error: "peticion" } };
  let crudo: unknown;
  try {
    crudo = JSON.parse(entrada.cuerpo);
  } catch {
    return { status: 400, cuerpo: { error: "peticion" } };
  }
  const v = validarPeticion(crudo);
  if (!v.ok) return { status: 400, cuerpo: { error: "peticion" } };
  const peticion = v.peticion;

  // ---- límite por visitante
  const limite = limiteIpDia(deps.env);
  const cupo = deps.presupuesto.consumirPregunta(entrada.ip, limite);
  if (!cupo) return { status: 429, cuerpo: { error: "limite", reinicio: proximoReinicio(ahora()), limite } };
  const devolverCupo = () => deps.presupuesto.devolverPregunta(entrada.ip);

  const gasto = { entrada: 0, salida: 0, razonamiento: 0, costeUsd: 0, llamadas: 0 };
  const llamadasHerramienta: string[] = [];
  const resultados: ResultadoHerramienta[] = [];
  let validacion: string = "no_aplica";
  let detalleValidacion: string | undefined;
  let modoFinal: "ia" | "reglas" = "ia";

  try {
    // ---- datos y entorno
    const ctx = peticion.contexto;
    const anio = ctx.anio ?? 2025;
    const datosHoy = await deps.cargador.datos(2025);
    const datos = anio === 2030 ? await deps.cargador.datos(2030) : datosHoy;
    const entorno = crearEntorno(datos, {
      cargarServicio: deps.cargador.cargarServicio,
      aliasLugares: ALIAS_LUGARES,
      contexto: ctx,
      ...(ctx.referencia ? { referencia: ctx.referencia } : {}),
      seccionesHoy: datosHoy.secciones,
      datosHoy,
    });

    const nombreZona = ctx.zona ? ctx.zona.split(",").map((c) => datos.territorios.zonas.find((z) => z.codigo === c)?.nombre ?? c).join(", ") : null;
    const sistema = promptAgente({
      vista: ctx.vista,
      servicio: ctx.servicio ? SERVICIOS[ctx.servicio].nombre : null,
      radioTexto: ctx.servicio && ctx.radio_m ? radioEs(ctx.radio_m) : null,
      lugar: ctx.lugar ? (lugarPorId(datos.territorios, ctx.lugar)?.nombre ?? null) : null,
      zona: nombreZona,
      anio,
      referencia: ctx.referencia ? REFERENCIA_NOMBRES[ctx.referencia] : null,
    });

    const historial = peticion.mensajes.slice(-MAX_MENSAJES_AL_MODELO);
    while (historial.length > 1 && historial[0]!.rol !== "usuario") historial.shift();
    const mensajes: MensajeModelo[] = [
      { role: "system", content: sistema },
      ...historial.map((m): MensajeModelo => (m.rol === "usuario" ? { role: "user", content: m.texto } : { role: "assistant", content: m.texto })),
    ];

    const limiteTiempo = inicio + TIEMPO_TURNO_MS;
    let textoModelo: string | null = null;
    let totalLlamadas = 0;
    /** Llamadas ya ejecutadas en este turno (nombre + argumentos): si el modelo repite una, se le devuelve lo mismo sin duplicar pasos ni acciones. */
    const yaEjecutadas = new Map<string, ResultadoHerramienta>();

    try {
      for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
        // En la última vuelta no se ofrecen herramientas: el modelo tiene que redactar con lo que ya tiene.
        const conHerramientas = vuelta < MAX_VUELTAS - 1 && totalLlamadas < MAX_LLAMADAS_TOTALES;
        const r = await llamarModelo(proveedor, mensajes, {
          ...(conHerramientas ? { herramientas: HERRAMIENTAS_MODELO } : {}),
          limite: limiteTiempo,
          antes: () => deps.presupuesto.reservar(tope), // reserva el coste estimado hasta que llegue (o falle) la respuesta: el tope corta también en concurrencia
          despues: (uso) => {
            deps.presupuesto.anotar(uso);
            gasto.entrada += uso.entrada;
            gasto.salida += uso.salida;
            gasto.razonamiento += uso.razonamiento;
            gasto.costeUsd += uso.costeUsd;
            gasto.llamadas++;
          },
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
          ...(deps.ahora ? { ahora: deps.ahora } : {}),
          ...(deps.espera ? { espera: deps.espera } : {}),
        });
        if (r.llamadas.length === 0 || !conHerramientas) {
          textoModelo = r.contenido;
          break;
        }
        mensajes.push({ role: "assistant", content: r.contenido, tool_calls: r.llamadas.map((l) => ({ id: l.id, type: "function", function: l.function })) });
        for (const [i, l] of r.llamadas.entries()) {
          let resultado: ResultadoHerramienta;
          if (i >= MAX_LLAMADAS_POR_VUELTA || totalLlamadas >= MAX_LLAMADAS_TOTALES) {
            resultado = { ok: false, herramienta: "mover_mapa", error: { codigo: "entrada", mensaje: "Demasiadas llamadas a la vez: haz menos y vuelve a intentarlo." } };
          } else {
            const clave = `${l.function.name}|${l.function.arguments}`;
            const previa = yaEjecutadas.get(clave);
            if (previa) {
              resultado = previa;
            } else {
              totalLlamadas++;
              llamadasHerramienta.push(l.function.name);
              resultado = await ejecutarLlamada(l.function.name, l.function.arguments, entorno);
              yaEjecutadas.set(clave, resultado);
              if (resultado.ok) resultados.push(resultado);
            }
          }
          mensajes.push({ role: "tool", tool_call_id: l.id, content: resultadoParaModelo(resultado) });
        }
      }
    } catch (e) {
      // Con algo calculado ya, se responde con las plantillas en vez de perderlo; sin nada, el error llega a la web (503/504 -> modo sin IA).
      if (resultados.length === 0) throw e;
      textoModelo = null;
      validacion = e instanceof ErrorTiempo ? "tiempo" : e instanceof ErrorPresupuesto ? "presupuesto" : "proveedor";
    }

    // ---- validar el texto y componer la respuesta
    const salidasOk = resultados.filter((r): r is Extract<ResultadoHerramienta, { ok: true }> => r.ok);
    // Cuentan como verificadas las cifras de las herramientas de ESTA petición, las que escribió el usuario y las del contexto de la
    // pantalla. Las de mensajes «asistente» del historial las manda el cliente y no se pueden verificar (T4-10).
    const delUsuario = peticion.mensajes.filter((m) => m.rol === "usuario").map((m) => m.texto);
    const delContexto = { radio_m: ctx.radio_m, anio }; // los códigos de zona y de lugar no cuentan: no son cifras para citar
    const permitidos = numerosPermitidos([...salidasOk.map((r) => r.salida), delContexto], delUsuario);
    const veredicto = textoModelo === null ? null : validarTexto(textoModelo, permitidos);
    let respuesta: RespuestaAgente;
    const descartado = veredicto !== null && !veredicto.ok;
    if (veredicto?.ok && textoModelo !== null) {
      validacion = "ok";
      const es2030 = salidasOk.some((r) => (r.salida as { anio_poblacion?: number }).anio_poblacion === 2030);
      const texto = es2030 && !/2030/.test(textoModelo) ? `${aviso2030()} ${textoModelo.trim()}` : textoModelo.trim();
      respuesta = {
        texto,
        acciones: deduplicar(salidasOk.flatMap((r) => r.acciones)),
        pasos: salidasOk.map((r): PasoAgente => r.paso),
        modo: "ia",
        restantes: cupo.restantes,
        limite,
      };
    } else {
      if (veredicto && !veredicto.ok) {
        validacion = `rechazado_${veredicto.motivo}`;
        detalleValidacion = veredicto.detalle; // solo las cifras sobrantes que escribió el modelo (nunca el texto del usuario)
      }
      modoFinal = "reglas";
      if (salidasOk.length > 0) {
        respuesta = {
          texto: salidasOk.map((r) => redactarResultado(r)).join(" "),
          acciones: deduplicar(salidasOk.flatMap((r) => r.acciones)),
          pasos: salidasOk.map((r): PasoAgente => r.paso),
          modo: "reglas",
          restantes: cupo.restantes,
          limite,
          ...(descartado ? { motivo: "revisada" as const } : {}),
        };
      } else {
        // Sin resultados que redactar: el intérprete por reglas responde a la pregunta entera, con el mismo motor.
        const r = await responderSinIA(peticion, entorno);
        respuesta = { ...r, modo: "reglas", restantes: cupo.restantes, limite }; // sin «revisada»: el texto es 100 % de reglas (R9)
      }
    }
    registrar({
      evento: "agente",
      prompt: PROMPT_VERSION,
      modo: modoFinal,
      validacion,
      ...(detalleValidacion ? { validacion_detalle: detalleValidacion } : {}),
      herramientas: llamadasHerramienta,
      llamadas_modelo: gasto.llamadas,
      tokens_entrada: gasto.entrada,
      tokens_salida: gasto.salida,
      tokens_razonamiento: gasto.razonamiento,
      coste_usd: Number(gasto.costeUsd.toFixed(5)),
      ms: ahora() - inicio,
    });
    return { status: 200, cuerpo: respuesta };
  } catch (e) {
    // El cupo solo se devuelve si no se ha pagado ninguna llamada al modelo (R2-I1): si no, forzar errores tras una llamada
    // pagada permitiría preguntar sin límite y vaciar el tope del día.
    if (gasto.llamadas === 0) devolverCupo();
    let salida: SalidaHttp;
    let tipo: string;
    if (e instanceof ErrorPresupuesto) {
      salida = NO_DISPONIBLE("presupuesto");
      tipo = "presupuesto";
    } else if (e instanceof ErrorTiempo) {
      salida = { status: 504, cuerpo: { error: "tiempo" } };
      tipo = "tiempo";
    } else if (e instanceof ErrorProveedor) {
      salida = NO_DISPONIBLE("proveedor");
      tipo = `proveedor_${e.codigo}`;
    } else {
      salida = { status: 500, cuerpo: { error: "interno" } };
      tipo = `interno_${e instanceof Error ? e.name : "desconocido"}`;
    }
    registrar({ evento: "agente_error", tipo, llamadas_modelo: gasto.llamadas, coste_usd: Number(gasto.costeUsd.toFixed(5)), ms: ahora() - inicio });
    return salida;
  }
}
