// Modo sin IA del agente: un intérprete por palabras clave que convierte la pregunta en llamadas a las herramientas
// de `herramientas.ts` y redacta la respuesta con plantillas (`plantillas.ts`). Funciona en el navegador, sin red ni
// clave: la demo del 26-nov no depende del modelo ni de la wifi.
//
// Cómo decide (por orden): 1) ficha («qué le falta a Parla», «mi municipio»), 2) simular («¿y si la pongo en Pinto?»),
// 3) ranking («qué municipios están peor…»), 4) ubicación óptima («dónde pondrías…», «residencia en el sur»),
// 5) mover el mapa («llévame a Getafe»). Si no entiende algo, lo dice y propone preguntas que sí sabe responder:
// nunca inventa una cifra.
import {
  ejecutarHerramienta,
  type Entorno,
  type NombreHerramienta,
  type ResultadoHerramienta,
} from "./herramientas";
import { esLugar, levenshtein, lugarPorId, resolverLugar } from "./lugares";
import { redactarResultado, FRASES } from "./plantillas";
import { SERVICIO_IDS, SERVICIOS } from "./servicios";
import { sinTildes } from "../texto";
import type { Accion, ContextoAgente, LugarResuelto, MensajeAgente, PasoAgente, PeticionAgente, RespuestaAgente, ServicioId, Territorios } from "./tipos";

/** Las 4 preguntas sugeridas de la pantalla (plan, sección «Apartado 1»). */
export const PREGUNTAS_SUGERIDAS: readonly string[] = [
  "¿Dónde pondrías una residencia en el sur?",
  "¿En qué municipios de la sierra ayudaría más un hospital?",
  "¿Y si la pongo en Pinto?",
  "¿Qué servicios tiene Parla?",
];

export const MAX_CARACTERES_PREGUNTA = 500;
export const MAX_MENSAJES = 12;

// ================================================================ vocabulario
const SINONIMOS_EXTRA: Record<ServicioId, string[]> = {
  centro_salud: ["centro salud", "centros salud", "centro medico", "centros medicos", "centro sanitario", "centros sanitarios", "dispensario", "medicos", "consultorio medico"],
  hospital: ["hospital publico", "hospital general", "hospitales publicos", "centro hospitalario"],
  residencia: [
    "residencia de ancianos", "residencias de ancianos", "residencia para mayores", "residencias para mayores", "residencia geriatrica",
    "centros de mayores", "asilo", "asilos", "residencia de la tercera edad", "geriatricos",
  ],
  farmacia: ["botica", "boticas", "oficina de farmacia", "oficinas de farmacia"],
  colegio: ["centro educativo", "centros educativos", "colegio publico", "colegios publicos", "cole", "coles", "ies", "instituto de secundaria", "institutos de secundaria", "instituto publico"],
  dea: ["deas", "desfibrilador externo", "desfibriladores externos"],
};

/** Sinónimos normalizados (sin tildes) de cada servicio: los del catálogo más los del intérprete. */
const SINONIMOS: { servicio: ServicioId; palabras: string[]; clave: string }[] = (() => {
  const out: { servicio: ServicioId; palabras: string[]; clave: string }[] = [];
  const vistos = new Set<string>();
  for (const id of SERVICIO_IDS) {
    for (const s of [...SERVICIOS[id].sinonimos, ...SINONIMOS_EXTRA[id]]) {
      const clave = norm(s);
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      out.push({ servicio: id, palabras: clave.split(" "), clave });
    }
  }
  // Los más largos primero: «centro de dia» gana a «centro», «residencia de mayores» a «mayores».
  out.sort((a, b) => b.palabras.length - a.palabras.length || b.clave.length - a.clave.length);
  return out;
})();

const G_PONER = [
  "pon", "pone", "pones", "pongo", "pongamos", "ponemos", "poner", "ponerla", "ponerlo", "ponga", "pondria", "pondrias", "pondriamos", "pondrian",
  "colocar", "colocaria", "colocarias", "coloco", "coloca", "colocamos", "construir", "construyo", "construiria", "construirias", "construimos", "construyas",
  "abrir", "abro", "abriria", "abririas", "abrimos", "ubicar", "ubicaria", "ubicarias", "ubico", "instalar", "instalo", "instalaria", "instalarias",
  "levantar", "crear", "crearias", "creo", "situar", "situarias", "montar", "emplazar", "emplazarias", "pusiera", "pusieras", "pusieramos",
];
const G_DONDE = ["donde", "adonde"];
const G_FALTA = ["falta", "faltan", "faltaria", "faltarian", "falte", "necesita", "necesitan", "necesitaria", "necesitarian", "carece", "carecen"];
const G_RANK = ["peor", "peores", "ranking", "clasificacion", "top", "ayudaria", "ayudarian", "beneficiaria", "beneficiarian", "afectados", "desatendidos", "necesitados", "deficitarios"];
const G_PLURAL = ["municipios", "pueblos", "localidades", "ciudades", "distritos"];
const G_SINGULAR = ["municipio", "pueblo", "localidad", "ciudad", "distrito"];
const G_SIMULAR = ["simula", "simular", "simulame", "simulacion", "prueba", "probar", "probemos"];
const G_OPTIMO = ["optimo", "optima", "optimos", "optimas", "emplazamiento"];
const G_MOVER = [
  "llevame", "lleva", "ir", "ve", "vamos", "vuela", "ensename", "muestrame", "muestra", "mostrar", "ver", "centra", "centrame", "zoom",
  "acerca", "acercame", "situame", "localiza", "mira", "busca", "abre",
];
const G_OTRAS = ["mejor", "sitio", "lugar", "punto", "ubicacion", "personas", "gente", "habitantes", "vecinos", "mayores", "plazas", "ficha", "servicios", "mas", "menos", "tiene", "tienen", "hay", "que", "cual", "cuales", "como", "esta", "estan"];

/** Palabras que el intérprete entiende: las demás se intentan corregir con una letra de diferencia. */
const KEYWORDS = new Set<string>([...G_PONER, ...G_DONDE, ...G_FALTA, ...G_RANK, ...G_PLURAL, ...G_SINGULAR, ...G_SIMULAR, ...G_OPTIMO, ...G_MOVER, ...G_OTRAS]);

const ARTICULOS = new Set(["el", "la", "los", "las", "un", "una", "unos", "unas", "lo", "al", "del"]);
const STOP = new Set([
  ...ARTICULOS, "de", "en", "a", "para", "por", "con", "sin", "sobre", "entre", "hacia", "desde", "y", "o", "u", "e", "ni", "si", "no", "se", "me", "te", "le", "les", "nos",
  "mi", "mis", "tu", "su", "sus", "nuestro", "nuestra", "es", "son", "ser", "estar", "esta", "estan", "esto", "eso", "esa", "ese", "muy", "tan", "todo", "toda", "todos", "todas",
  "ahora", "aqui", "alli", "favor", "puede", "puedes", "podrias", "podria", "gracias", "hola", "quiero", "quisiera", "necesito", "dime", "dame", "vez", "cuantos", "cuantas",
  "ancianos", "mayores", "personas", "gente", "vecinos", "habitantes", "ninos", "familias", "poblacion", "tercera", "edad", "plazas", "plaza", "km", "metros", "kilometros", "m",
  "k", "q", "xq", "porque", "pues", "tambien", "mejor", "peor", "mas", "menos", "ahi", "alla", "cerca", "lejos", "hace", "hacen", "hay", "ha", "han", "tiene", "tienen", "tengo",
]);
const NUMEROS: Record<string, number> = { un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10 };

export function norm(t: string): string {
  return sinTildes(t).replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

const noEsLugar = (w: string) => STOP.has(w) || KEYWORDS.has(w) || /^\d+$/.test(w) || w in NUMEROS;

// ================================================================ servicio
function umbralTipografico(n: number): number {
  return n >= 12 ? 2 : n >= 7 ? 1 : 0;
}

interface HalladoServicio {
  servicio: ServicioId;
  desde: number;
  hasta: number;
}

/** Servicio por sinónimos, con una o dos letras de tolerancia («residensia», «farmasia»). El más largo gana. */
export function detectarServicio(tokens: string[], usado: boolean[] = tokens.map(() => false)): HalladoServicio | null {
  let mejor: (HalladoServicio & { peso: number }) | null = null;
  for (const s of SINONIMOS) {
    const k = s.palabras.length;
    const lim = umbralTipografico(s.clave.length);
    for (let i = 0; i + k <= tokens.length; i++) {
      if (usado.slice(i, i + k).some(Boolean)) continue;
      const ventana = tokens.slice(i, i + k).join(" ");
      const d = ventana === s.clave ? 0 : lim > 0 && Math.abs(ventana.length - s.clave.length) <= lim ? levenshtein(ventana, s.clave, lim) : Infinity;
      if (d > lim) continue;
      const peso = k * 100 + s.clave.length - d * 10;
      if (!mejor || peso > mejor.peso || (peso === mejor.peso && i < mejor.desde)) mejor = { servicio: s.servicio, desde: i, hasta: i + k, peso };
    }
  }
  return mejor ? { servicio: mejor.servicio, desde: mejor.desde, hasta: mejor.hasta } : null;
}

/** Servicio nombrado en un texto (para heredarlo de mensajes anteriores). */
function servicioEn(texto: string): ServicioId | null {
  return detectarServicio(norm(texto).split(" ").filter(Boolean))?.servicio ?? null;
}

// ================================================================ lugar
function claves(t: Territorios, l: LugarResuelto, alias: Record<string, string[]>): Set<string> {
  const out = new Set<string>();
  const n = norm(l.nombre);
  out.add(n);
  out.add(n.replace(/^(el|la|los|las) /, ""));
  if (l.tipo === "municipio") for (const a of alias[l.id] ?? []) out.add(norm(a));
  if (l.tipo === "zona") for (const z of t.zonas) if (l.zonas.includes(z.codigo)) { out.add(norm(z.nombre)); for (const a of z.alias) out.add(norm(a)); }
  return out;
}

interface HalladoLugar {
  lugar: LugarResuelto;
  desde: number;
  hasta: number;
}

function ventanaPareceLugar(tokens: string[], i: number, k: number): boolean {
  const w = tokens.slice(i, i + k);
  const primero = w[0] as string;
  const ultimo = w[k - 1] as string;
  if (noEsLugar(primero) || noEsLugar(ultimo)) {
    // «El Boalo», «Los Molinos»: el artículo inicial es parte del nombre; se prueba también la ventana sin él.
    return false;
  }
  if (k === 1) {
    const sig = tokens[i + 1];
    const ant = tokens[i - 1];
    if (primero === "este" && sig !== undefined && ["municipio", "distrito", "pueblo", "barrio", "lugar", "sitio", "punto", "servicio", "caso", "centro"].includes(sig)) return false;
    if (primero === "centro" && !(ant !== undefined && ["en", "distrito", "del", "al", "el"].includes(ant))) return false;
  }
  return true;
}

/** Todos los lugares nombrados, sin solaparse, de izquierda a derecha. Marca sus palabras como usadas. */
export function detectarLugares(t: Territorios, tokens: string[], usado: boolean[], alias: Record<string, string[]> = {}): HalladoLugar[] {
  const halladas: HalladoLugar[] = [];
  for (let k = Math.min(5, tokens.length); k >= 1; k--) {
    for (let i = 0; i + k <= tokens.length; i++) {
      if (usado.slice(i, i + k).some(Boolean)) continue;
      if (!ventanaPareceLugar(tokens, i, k)) continue;
      const w = tokens.slice(i, i + k).join(" ");
      const r = resolverLugar(t, w, alias);
      let lugar: LugarResuelto | null = null;
      if (esLugar(r)) {
        // Exacta, o prefijo único de una palabra larga («fuenlab»). Un prefijo corto es demasiado arriesgado.
        if (claves(t, r, alias).has(w) || w.length >= 5) lugar = r;
      } else if (k === 1 && w.length >= 6 && r.sugerencias[0]) {
        const cand = r.sugerencias[0];
        const nombre = norm(cand.nombre).replace(/^(el|la|los|las) /, "");
        if (levenshtein(w, nombre, w.length >= 9 ? 2 : 1) <= (w.length >= 9 ? 2 : 1)) {
          const x = resolverLugar(t, cand.nombre, alias);
          if (esLugar(x)) lugar = x;
        }
      }
      if (!lugar) continue;
      for (let j = i; j < i + k; j++) usado[j] = true;
      halladas.push({ lugar, desde: i, hasta: i + k });
    }
  }
  halladas.sort((a, b) => a.desde - b.desde);
  return halladas;
}

/** «Lo que va tras en/de/a» y no se reconoce: se usa para decir «no encuentro X» en vez de ignorarlo. */
function lugarDesconocido(tokens: string[], usado: boolean[]): string | null {
  const PREP = new Set(["en", "de", "del", "para", "por", "a", "al", "hacia", "desde"]);
  for (let i = 0; i < tokens.length - 1; i++) {
    if (usado[i] || !PREP.has(tokens[i] as string)) continue;
    let j = i + 1;
    while (j < tokens.length && !usado[j] && ARTICULOS.has(tokens[j] as string)) j++;
    const frase: string[] = [];
    while (j < tokens.length && frase.length < 4 && !usado[j] && !noEsLugar(tokens[j] as string)) frase.push(tokens[j++] as string);
    if (frase.length) return frase.join(" ");
  }
  return null;
}

// ================================================================ correcciones de palabras clave
function canonizar(tokens: string[], usado: boolean[]): string[] {
  const kws = [...KEYWORDS].filter((w) => w.length >= 5);
  return tokens.map((tk, i) => {
    if (usado[i]) return "_";
    if (KEYWORDS.has(tk) || tk.length < 4 || /^\d+$/.test(tk)) return tk;
    let mejor: string | null = null;
    let mejorD = 3;
    for (const kw of kws) {
      const lim = kw.length >= 9 ? 2 : 1;
      if (Math.abs(kw.length - tk.length) > lim) continue;
      const d = levenshtein(tk, kw, lim);
      if (d <= lim && d < mejorD) { mejor = kw; mejorD = d; }
    }
    return mejor ?? tk;
  });
}

const alternativas = (g: string[]) => g.join("|");
const RX = {
  poner: new RegExp(`\\b(${alternativas(G_PONER)})\\b`),
  donde: new RegExp(`\\b(${alternativas(G_DONDE)})\\b`),
  falta: new RegExp(`\\b(${alternativas(G_FALTA)})\\b`),
  rank: new RegExp(`\\b(${alternativas(G_RANK)})\\b`),
  plural: new RegExp(`\\b(${alternativas(G_PLURAL)})\\b`),
  singular: new RegExp(`\\b(${alternativas(G_SINGULAR)})\\b`),
  simular: new RegExp(`\\b(${alternativas(G_SIMULAR)})\\b`),
  optimo: new RegExp(`\\b(${alternativas(G_OPTIMO)})\\b`),
  mover: new RegExp(`\\b(${alternativas(G_MOVER)})\\b`),
  si: /\b(si|que pasa si|que pasaria si|que ganaria|que ganan|que se gana)\b/,
  mejorSitio: /\bmejor (sitio|lugar|punto|ubicacion|emplazamiento)\b/,
  menosMas: /\b(menos|mas)\b/,
  ficha: /\b(que|cuales) (le |les |nos |me |te )?((hace |hacen )?(falta|faltan)|tiene|tienen|hay|servicios)\b|\b(ficha|como (esta|estan|anda|van|va)|servicios de)\b/,
  personas: /\bmas (personas|gente|habitantes|vecinos|mayores)\b|\b(en total|numero de personas)\b/,
  plazasFaltan: /\bplazas\b/,
};

// ================================================================ números
function numeroDe(tk: string | undefined): number | null {
  if (tk === undefined) return null;
  if (/^\d{1,3}$/.test(tk)) return Number(tk);
  return NUMEROS[tk] ?? null;
}

const UNIDADES = new Set(["plazas", "plaza", "km", "metros", "m", "kilometros", "habitantes", "personas", "mayores", "anos", "%", "por"]);

/** Un número suelto (2, «dos», 3…) que no sea de plazas ni de distancia: cuántos puntos o cuántas filas. */
function numeroSuelto(tokens: string[]): number | null {
  for (let i = 0; i < tokens.length; i++) {
    const n = numeroDe(tokens[i]);
    if (n === null) continue;
    if (tokens[i] === "un" || tokens[i] === "una" || tokens[i] === "uno") continue;
    const sig = tokens[i + 1];
    if (sig !== undefined && UNIDADES.has(sig)) continue;
    return n;
  }
  return null;
}

function plazasDe(tokens: string[]): number | null {
  for (let i = 0; i < tokens.length - 1; i++) {
    if ((tokens[i + 1] === "plazas" || tokens[i + 1] === "plaza") && /^\d{1,4}$/.test(tokens[i] as string)) return Number(tokens[i]);
  }
  return null;
}

// ================================================================ interpretación
export interface LlamadaPlanificada {
  herramienta: NombreHerramienta;
  entrada: Record<string, unknown>;
}

export type Interpretacion =
  | { tipo: "llamadas"; llamadas: LlamadaPlanificada[]; servicio: ServicioId | null; servicioHeredado: boolean }
  | { tipo: "no_entendida"; mensaje: string; sugerencias: string[] };

export interface OpcionesInterpretar {
  territorios: Territorios;
  contexto?: Partial<ContextoAgente>;
  /** Mensajes anteriores del usuario (del más antiguo al más reciente), para heredar el servicio. */
  historial?: string[];
  aliasLugares?: Record<string, string[]>;
}

/** Cuatro preguntas que el modo sin IA sabe responder, con el servicio nombrado si lo hay. */
export function sugerenciasPara(servicio: ServicioId | null): string[] {
  if (!servicio) return [...PREGUNTAS_SUGERIDAS];
  const f = FRASES[servicio];
  return [`¿Dónde pondrías ${f.un} en el sur?`, `¿En qué municipios de la sierra ayudaría más ${f.un}?`, "¿Y si la pongo en Pinto?", "¿Qué servicios tiene Parla?"];
}

function noEntendida(mensaje: string, servicio: ServicioId | null = null): Interpretacion {
  return { tipo: "no_entendida", mensaje, sugerencias: sugerenciasPara(servicio) };
}

const PALABRAS_DE_COSTE = new Set([
  "cuesta", "cuestan", "costar", "costaria", "coste", "costes", "costo", "costos", "presupuesto", "presupuestos", "precio", "precios",
  "euros", "euro", "dinero", "financiar", "financiacion", "subvencion", "subvenciones", "licitacion",
]);

/** Respuesta honesta a una pregunta sobre centros de día: no están en el simulador, y por qué en una frase. */
export const MENSAJE_CENTROS_DE_DIA =
  "Los centros de día no son un servicio del simulador: el registro oficial llama «centro de día» también a los hogares y clubes de mayores, que no son atención de día, y así no sale una cifra fiable de cuántos faltan. Los puedes ver contados en «Mi municipio», en «Otros servicios sociales». Para mayores sí puedo decirte dónde faltan residencias.";

export function interpretar(texto: string, o: OpcionesInterpretar): Interpretacion {
  const t = o.territorios;
  const alias = o.aliasLugares ?? {};
  const tokens = norm(texto).split(" ").filter(Boolean);
  if (tokens.length === 0) return noEntendida("No he visto ninguna pregunta.");
  // Preguntas de dinero (costes, presupuestos, precios): no hay datos de coste y no se contestan con otra herramienta (T2-M10).
  if (tokens.some((tk) => PALABRAS_DE_COSTE.has(tk))) {
    return noEntendida("No sé calcular costes, presupuestos ni precios: no tengo esos datos. Solo sé decir dónde faltan servicios y cuánta gente ganaría acceso con un centro nuevo.");
  }
  // Los centros de día no son un servicio del simulador (decisión del 18-nov): se dice con honestidad y se ofrece lo que sí hay.
  if (/\bcentros? (de )?dia\b/.test(tokens.join(" "))) {
    return noEntendida(MENSAJE_CENTROS_DE_DIA, "residencia");
  }
  const usado = tokens.map(() => false);
  const marcar = (d: number, h: number) => { for (let i = d; i < h; i++) usado[i] = true; };

  // 1. «toda la Comunidad»
  let global = false;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "comunidad") {
      const d = i;
      let h = i + 1;
      if (tokens[h] === "de" && tokens[h + 1] === "madrid") h += 2;
      marcar(d, h);
      global = true;
    }
  }

  // 2. servicio
  const hs = detectarServicio(tokens, usado);
  if (hs) marcar(hs.desde, hs.hasta);

  // 3. «mi municipio» -> el lugar de la pantalla
  let lugarContexto: LugarResuelto | null = null;
  let pidioMiLugar = false;
  for (let i = 0; i < tokens.length - 1; i++) {
    if ((tokens[i] === "mi" || tokens[i] === "nuestro" || tokens[i] === "nuestra") && ["municipio", "pueblo", "ciudad", "barrio", "distrito", "localidad", "zona"].includes(tokens[i + 1] as string)) {
      pidioMiLugar = true;
      marcar(i, i + 2);
      if (o.contexto?.lugar) lugarContexto = lugarPorId(t, o.contexto.lugar);
    }
  }

  // 4. lugares
  const lugares = detectarLugares(t, tokens, usado, alias).map((h) => h.lugar);
  if (pidioMiLugar && lugarContexto) lugares.unshift(lugarContexto);

  const desconocido = lugares.length === 0 && !pidioMiLugar ? lugarDesconocido(tokens, usado) : null;

  // 5. palabras clave (con tolerancia a erratas)
  const c = canonizar(tokens, usado).join(" ");
  const f = {
    poner: RX.poner.test(c),
    donde: RX.donde.test(c),
    falta: RX.falta.test(c),
    rank: RX.rank.test(c),
    plural: RX.plural.test(c),
    singular: RX.singular.test(c),
    simular: RX.simular.test(c),
    optimo: RX.optimo.test(c),
    mover: RX.mover.test(c),
    si: RX.si.test(c),
    mejorSitio: RX.mejorSitio.test(c),
    menosMas: RX.menosMas.test(c),
    mas: /\bmas\b/.test(c),
    ficha: RX.ficha.test(c),
    personas: RX.personas.test(c),
  };

  const primero = lugares[0] ?? null;
  const ultimo = lugares[lugares.length - 1] ?? null;
  const esPuntual = (l: LugarResuelto | null) => l !== null && l.tipo !== "zona";
  const empiezaConY = tokens[0] === "y";

  // servicio: el del texto, el de la pantalla o el de un mensaje anterior
  let servicio: ServicioId | null = hs?.servicio ?? null;
  let heredado = false;
  if (!servicio) {
    const deContexto = o.contexto?.servicio ?? null;
    let deHistorial: ServicioId | null = null;
    for (const m of [...(o.historial ?? [])].reverse()) {
      deHistorial = servicioEn(m);
      if (deHistorial) break;
    }
    servicio = deContexto ?? deHistorial;
    heredado = servicio !== null;
  }

  const nombreLugar = (l: LugarResuelto) => l.nombre;
  const llamar = (herramienta: NombreHerramienta, entrada: Record<string, unknown>): Interpretacion => ({
    tipo: "llamadas",
    llamadas: [{ herramienta, entrada }],
    servicio,
    servicioHeredado: heredado,
  });
  const faltaLugar = (): Interpretacion | null => {
    if (pidioMiLugar && !lugarContexto && !primero) {
      return noEntendida("Todavía no sé cuál es tu municipio: abre «Mi municipio» y elige uno, o dime su nombre.", servicio);
    }
    if (desconocido) {
      const sug = resolverLugar(t, desconocido, alias);
      const lim = desconocido.length >= 9 ? 2 : 1;
      const lista = esLugar(sug)
        ? []
        : sug.sugerencias
            .filter((s) => {
              const n = norm(s.nombre).replace(/^(el|la|los|las) /, "");
              return n.startsWith(desconocido) || levenshtein(desconocido, n, lim) <= lim;
            })
            .map((s) => s.nombre);
      return noEntendida(
        `No encuentro «${desconocido}» entre los ${t.municipios.length} municipios, los ${t.distritos.length} distritos de Madrid y las ${t.zonas.length} zonas de la Comunidad.${lista.length ? ` ¿Quizá ${lista.join(", ")}?` : ""}`,
        servicio,
      );
    }
    return null;
  };
  const sinServicio = () => noEntendida("Me falta saber de qué servicio hablas (residencia, centro de salud, farmacia, hospital, colegio o desfibrilador).");

  if (lugares.length >= 2 && tokens.some((tk) => tk.startsWith("compar"))) {
    return noEntendida("No sé comparar dos lugares a la vez: pídeme la ficha de cada uno por separado (por ejemplo «¿Qué servicios tiene Getafe?»).", servicio);
  }
  const cuantasPlazas = /\bcuantas plazas\b/.test(c);

  // ---- 1) ficha
  const pideFicha =
    (f.ficha && !(hs && primero?.tipo === "zona")) ||
    (pidioMiLugar && !f.poner && !f.rank && !f.donde) ||
    (cuantasPlazas && esPuntual(primero) && !f.poner);
  if (pideFicha && !(f.donde && f.poner)) {
    if (pidioMiLugar && !lugarContexto && !primero) {
      return noEntendida("Todavía no sé cuál es tu municipio: abre «Mi municipio» y elige uno, o dime su nombre.", servicio);
    }
    const l = primero;
    if (l) return llamar("ficha_municipio", { lugar: nombreLugar(l) });
    return faltaLugar() ?? noEntendida("¿De qué municipio o distrito quieres la ficha?", servicio);
  }

  // ---- 2) simular
  const quiereSimular = (f.poner && f.si) || f.simular || (f.poner && !f.donde && esPuntual(ultimo)) || (empiezaConY && esPuntual(ultimo) && servicio !== null && !f.donde && !f.rank);
  if (quiereSimular) {
    const err = faltaLugar();
    if (err) return err;
    if (!ultimo) return noEntendida("¿En qué municipio o distrito la pondrías? Dime un nombre, por ejemplo «¿Y si la pongo en Pinto?».", servicio);
    if (!servicio) return sinServicio();
    const entrada: Record<string, unknown> = { servicio, lugar: nombreLugar(ultimo) };
    const p = plazasDe(tokens);
    if (p !== null) entrada.plazas = p;
    return llamar("simular_centro", entrada);
  }

  // ---- 3) ranking explícito
  // «¿Dónde faltan más plazas de residencia?» pide un ranking de lugares, no el mejor sitio para un centro nuevo.
  const dondeFaltaMas = f.donde && f.falta && f.mas && !f.poner && !f.optimo && !f.mejorSitio && !f.simular;
  const rankingExplicito = f.rank || dondeFaltaMas || (cuantasPlazas && primero === null) || (f.menosMas && (f.plural || f.singular) && !f.poner);
  // ---- 4) ubicación óptima
  const quiereOptimo = !dondeFaltaMas && (f.poner || f.optimo || f.mejorSitio || (f.donde && (f.falta || f.poner)));
  // ---- 5) ranking por plural («qué municipios faltan…»)
  const rankingPlural = f.plural && !f.poner;

  if (rankingExplicito || (!quiereOptimo && rankingPlural)) {
    const err = faltaLugar();
    if (err) return err;
    if (!servicio) return sinServicio();
    const entrada: Record<string, unknown> = { servicio };
    const l = lugares.find((x) => x.tipo === "zona") ?? primero;
    if (l) entrada.zona = nombreLugar(l);
    if (/\bdistritos\b/.test(c)) entrada.nivel = "distrito";
    const n = numeroSuelto(tokens);
    if (n !== null && n >= 1) entrada.limite = Math.min(10, n);
    else if (f.singular && !f.plural) entrada.limite = 1;
    if (f.personas) entrada.orden = "personas";
    else if (SERVICIOS[servicio].metrica === "plazas" && RX.plazasFaltan.test(c)) entrada.orden = "faltan";
    return llamar("ranking_deficit", entrada);
  }

  if (quiereOptimo || (hs !== null && primero !== null)) {
    const err = faltaLugar();
    if (err) return err;
    if (!servicio) return sinServicio();
    const entrada: Record<string, unknown> = { servicio };
    if (primero) entrada.zona = nombreLugar(primero);
    const n = numeroSuelto(tokens);
    if (n !== null && n >= 1) entrada.n = n;
    const p = plazasDe(tokens);
    if (p !== null) entrada.plazas = p;
    return llamar("ubicacion_optima", entrada);
  }

  // ---- mover el mapa
  if (f.mover && primero) return llamar("mover_mapa", { lugar: nombreLugar(primero) });

  // ---- un servicio con «toda la Comunidad», o nada reconocible
  if (servicio && global && !desconocido) return llamar("ubicacion_optima", { servicio });
  if (hs) {
    const err = faltaLugar();
    if (err) return err;
  }
  if (!servicio && primero && esPuntual(primero)) return llamar("ficha_municipio", { lugar: nombreLugar(primero) });
  if (servicio) {
    return noEntendida(`He entendido que hablas de ${FRASES[servicio].plural}, pero no sé qué quieres saber.`, servicio);
  }
  return noEntendida("No he entendido la pregunta.");
}

// ================================================================ «¿Y en 2030?»
/** «¿Y en 2030?», «en 2030», «¿y hoy?»: solo pide cambiar el año del simulador (como mucho una palabra más, «ahora» o «la proyección»). */
export function anioPedido(texto: string): 2025 | 2030 | null {
  const tokens = norm(texto).split(" ").filter(Boolean);
  if (tokens.length === 0 || tokens.length > 6) return null;
  const relleno = new Set(["y", "en", "para", "con", "el", "ano", "a", "ya", "que", "pasa", "pasaria", "seria", "como", "queda", "quedaria", "la", "proyeccion", "ahora", "mismo", "lo"]);
  const clave = tokens.filter((tk) => !relleno.has(tk));
  if (clave.length !== 1) return null;
  if (clave[0] === "2030") return 2030;
  if (clave[0] === "hoy" || clave[0] === "2025" || clave[0] === "actual") return 2025;
  return null;
}

// ================================================================ respuesta completa (modo sin IA)
function respuesta(texto: string, acciones: Accion[] = [], pasos: PasoAgente[] = []): RespuestaAgente {
  return { texto, acciones, pasos, modo: "reglas", restantes: null };
}

function textoNoEntendida(i: Extract<Interpretacion, { tipo: "no_entendida" }>): string {
  const lista = i.sugerencias.map((s) => `«${s}»`);
  const y = lista.length > 1 ? `${lista.slice(0, -1).join(", ")} o ${lista[lista.length - 1]}` : (lista[0] ?? "");
  return `${i.mensaje} Solo sé responder a preguntas sobre un servicio y un lugar, y no invento cifras. Prueba con: ${y}.`;
}

/**
 * Pregunta -> respuesta, sin red ni claves: interpreta, llama a las herramientas y redacta con plantillas. Nunca lanza.
 * Valida la petición igual que la función `/api/agente` (hasta 12 mensajes y 500 caracteres por texto).
 */
export async function responderSinIA(peticion: PeticionAgente, entorno: Entorno): Promise<RespuestaAgente> {
  const mensajes: MensajeAgente[] = Array.isArray(peticion?.mensajes) ? peticion.mensajes : [];
  const ultimo = mensajes[mensajes.length - 1];
  if (!ultimo || ultimo.rol !== "usuario" || typeof ultimo.texto !== "string" || !ultimo.texto.trim()) {
    return respuesta("No he recibido ninguna pregunta.");
  }
  if (mensajes.length > MAX_MENSAJES || mensajes.some((m) => typeof m.texto !== "string" || m.texto.length > MAX_CARACTERES_PREGUNTA)) {
    return respuesta(`La conversación es demasiado larga: usa como máximo ${MAX_MENSAJES} mensajes de ${MAX_CARACTERES_PREGUNTA} caracteres.`);
  }
  const contexto = peticion.contexto ?? undefined;
  const anio = anioPedido(ultimo.texto);
  if (anio !== null) {
    const sid = contexto?.servicio ?? "residencia";
    const accion: Accion = { tipo: "elegir_servicio", servicio: sid, ...(contexto?.radio_m ? { radio_m: contexto.radio_m } : {}), anio };
    return respuesta(
      anio === 2030
        ? "Pongo el simulador en 2030: población proyectada por el INE (el reparto por sección es un modelo) y los centros que hay hoy. Pregúntame otra vez lo de antes y te responderé con esas cifras."
        : "Pongo el simulador en hoy (censo de 2025). Pregúntame otra vez lo de antes y te responderé con esas cifras.",
      [accion],
    );
  }
  const ent = entorno.conContexto(contexto);
  const historial = mensajes.slice(0, -1).filter((m) => m.rol === "usuario").map((m) => m.texto);
  const interp = interpretar(ultimo.texto, {
    territorios: ent.datos.territorios,
    contexto,
    historial,
    aliasLugares: ent.opciones.aliasLugares,
  });
  if (interp.tipo === "no_entendida") return respuesta(textoNoEntendida(interp));

  const resultados: ResultadoHerramienta[] = [];
  for (const l of interp.llamadas) resultados.push(await ejecutarHerramienta(l.herramienta, l.entrada, ent));
  const acciones = resultados.flatMap((r) => (r.ok ? r.acciones : []));
  const pasos = resultados.flatMap((r) => (r.ok ? [r.paso] : []));
  const fallo = resultados.find((r) => !r.ok);
  if (fallo && !fallo.ok) {
    const sug = fallo.error.codigo === "lugar" || fallo.error.codigo === "zona_no_agrupa" ? ` Prueba con: «${sugerenciasPara(interp.servicio)[0]}».` : "";
    return respuesta(`${fallo.error.mensaje}${sug}`, [], []);
  }
  return respuesta(resultados.map((r) => redactarResultado(r)).join(" "), acciones, pasos);
}
