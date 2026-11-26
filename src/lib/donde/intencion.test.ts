// Modo sin IA: de la pregunta a la herramienta y a la respuesta, con los datos reales y sin red.
import { beforeAll, describe, expect, it } from "vitest";
import referencia from "../../../pipeline/donde/referencia.json";
import { datosReales } from "./datosPrueba";
import { crearEntorno, type Entorno, type ResultadoHerramienta } from "./herramientas";
import { interpretar, PREGUNTAS_SUGERIDAS, responderSinIA, sugerenciasPara, type Interpretacion } from "./intencion";
import { ETIQUETA_MODO_REGLAS, redactarResultado } from "./plantillas";
import type { ContextoAgente, Datos, PeticionAgente, ServicioId } from "./tipos";

let datos: Datos;
let ent: Entorno;
beforeAll(async () => {
  datos = await datosReales();
  // Los casos de referencia.json (Python) usan la media de la Comunidad: se pide explícita.
  ent = crearEntorno(datos, { referencia: "media" });
});

type Ctx = Partial<ContextoAgente>;
const interp = (texto: string, contexto?: Ctx, historial?: string[]): Interpretacion =>
  interpretar(texto, { territorios: datos.territorios, contexto, historial });

function llamada(texto: string, contexto?: Ctx, historial?: string[]) {
  const r = interp(texto, contexto, historial);
  if (r.tipo !== "llamadas") throw new Error(`«${texto}» no se entendió: ${r.mensaje}`);
  expect(r.llamadas).toHaveLength(1);
  return r.llamadas[0]!;
}

const peticion = (texto: string, contexto: Ctx = {}, antes: PeticionAgente["mensajes"] = []): PeticionAgente => ({
  mensajes: [...antes, { rol: "usuario", texto }],
  contexto: { vista: "donde", servicio: null, radio_m: null, lugar: null, ...contexto },
});

// ---------------------------------------------------------------- frases -> herramienta y entrada
const RESIDENCIA: Ctx = { servicio: "residencia" };
const CASOS: { frase: string; ctx?: Ctx; herramienta: string; entrada: Record<string, unknown> }[] = [
  // las 4 preguntas sugeridas del plan
  { frase: "¿Dónde pondrías una residencia en el sur?", herramienta: "ubicacion_optima", entrada: { servicio: "residencia", zona: "Sur Metropolitano" } },
  { frase: "¿En qué municipios de la sierra ayudaría más un hospital?", herramienta: "ranking_deficit", entrada: { servicio: "hospital", zona: "Sierra" } },
  { frase: "¿Y si la pongo en Pinto?", ctx: RESIDENCIA, herramienta: "simular_centro", entrada: { servicio: "residencia", lugar: "Pinto" } },
  { frase: "¿Qué le falta a Parla?", herramienta: "ficha_municipio", entrada: { lugar: "Parla" } },
  // variantes: sinónimos, sin verbo, sin tildes, faltas, mayúsculas, números
  { frase: "geriátrico en el sur", herramienta: "ubicacion_optima", entrada: { servicio: "residencia", zona: "Sur Metropolitano" } },
  { frase: "ambulatorio sierra", herramienta: "ubicacion_optima", entrada: { servicio: "centro_salud", zona: "Sierra" } },
  { frase: "¿dónde faltan farmacias en Getafe?", herramienta: "ubicacion_optima", entrada: { servicio: "farmacia", zona: "Getafe" } },
  { frase: "donde pondrias una residensia en el sur", herramienta: "ubicacion_optima", entrada: { servicio: "residencia", zona: "Sur Metropolitano" } },
  { frase: "DONDE PONDRIAS UN HOSPITAL EN EL OESTE", herramienta: "ubicacion_optima", entrada: { servicio: "hospital", zona: "Oeste Metropolitano" } },
  { frase: "pon una farmasia en el este", herramienta: "ubicacion_optima", entrada: { servicio: "farmacia", zona: "Este Metropolitano" } },
  { frase: "dos residencias en el sur", herramienta: "ubicacion_optima", entrada: { servicio: "residencia", zona: "Sur Metropolitano", n: 2 } },
  { frase: "¿Dónde falta un desfibrilador en Leganes?", herramienta: "ubicacion_optima", entrada: { servicio: "dea", zona: "Leganés" } },
  { frase: "donde construirias un instituto en el sudeste", herramienta: "ubicacion_optima", entrada: { servicio: "colegio", zona: "Sudeste Comunidad" } },
  { frase: "¿Dónde falta un IES en Getafe?", herramienta: "ubicacion_optima", entrada: { servicio: "colegio", zona: "Getafe" } },
  { frase: "FARMACIAS EN FUENLABRADA", herramienta: "ubicacion_optima", entrada: { servicio: "farmacia", zona: "Fuenlabrada" } },
  { frase: "¿Dónde hace falta un colegio en Alcalá de Henares?", herramienta: "ubicacion_optima", entrada: { servicio: "colegio", zona: "Alcalá de Henares" } },
  { frase: "¿Dónde pondrías una residencia de 150 plazas en el norte?", herramienta: "ubicacion_optima", entrada: { servicio: "residencia", zona: "Norte", plazas: 150 } },
  { frase: "¿Dónde hace falta un centro de salud en la Comunidad de Madrid?", herramienta: "ubicacion_optima", entrada: { servicio: "centro_salud" } },
  { frase: "k municipios de la sierra estan peor en sentros de salud", herramienta: "ranking_deficit", entrada: { servicio: "centro_salud", zona: "Sierra" } },
  { frase: "ranking de farmacias en el sur", herramienta: "ranking_deficit", entrada: { servicio: "farmacia", zona: "Sur Metropolitano" } },
  { frase: "los 3 peores municipios en colegios", herramienta: "ranking_deficit", entrada: { servicio: "colegio", limite: 3 } },
  { frase: "¿Qué distritos de Madrid están peor en centros de salud?", herramienta: "ranking_deficit", entrada: { servicio: "centro_salud", zona: "Madrid", nivel: "distrito" } },
  { frase: "¿En qué municipios faltan más farmacias?", herramienta: "ranking_deficit", entrada: { servicio: "farmacia" } },
  { frase: "¿Qué pueblo tiene menos farmacias en el oeste?", herramienta: "ranking_deficit", entrada: { servicio: "farmacia", zona: "Oeste Metropolitano", limite: 1 } },
  { frase: "municipios con más personas sin hospital cerca", herramienta: "ranking_deficit", entrada: { servicio: "hospital", orden: "personas" } },
  { frase: "y si pongo una residencia de 120 plazas en Pinto", herramienta: "simular_centro", entrada: { servicio: "residencia", lugar: "Pinto", plazas: 120 } },
  { frase: "¿Y si en vez de en Parla la pongo en Pinto?", ctx: RESIDENCIA, herramienta: "simular_centro", entrada: { servicio: "residencia", lugar: "Pinto" } },
  { frase: "pon un centro de salud en Pinto", herramienta: "simular_centro", entrada: { servicio: "centro_salud", lugar: "Pinto" } },
  { frase: "y en Getafe?", ctx: { servicio: "farmacia" }, herramienta: "simular_centro", entrada: { servicio: "farmacia", lugar: "Getafe" } },
  { frase: "que falta en Alcalá de Henares", herramienta: "ficha_municipio", entrada: { lugar: "Alcalá de Henares" } },
  { frase: "qué le falta a la acebeda", herramienta: "ficha_municipio", entrada: { lugar: "La Acebeda" } },
  { frase: "¿Qué servicios tiene el distrito Centro?", herramienta: "ficha_municipio", entrada: { lugar: "Centro" } },
  { frase: "Parla", herramienta: "ficha_municipio", entrada: { lugar: "Parla" } },
  { frase: "qué le falta a mi municipio", ctx: { lugar: "mun:28065" }, herramienta: "ficha_municipio", entrada: { lugar: "Getafe" } },
  { frase: "residencias en el centro", herramienta: "ubicacion_optima", entrada: { servicio: "residencia", zona: "Centro" } },
  { frase: "¿Cuántas plazas faltan en residencias en Leganés?", herramienta: "ficha_municipio", entrada: { lugar: "Leganés" } },
  { frase: "¿Cuántas plazas de residencia faltan?", herramienta: "ranking_deficit", entrada: { servicio: "residencia", orden: "faltan" } },
  { frase: "llévame a Rascafría", herramienta: "mover_mapa", entrada: { lugar: "Rascafría" } },
  { frase: "enseñame el sur", herramienta: "mover_mapa", entrada: { lugar: "Sur Metropolitano" } },
];

describe("preguntas -> herramienta y entrada esperadas", () => {
  for (const c of CASOS) {
    it(`«${c.frase}»`, () => {
      const l = llamada(c.frase, c.ctx);
      expect(l.herramienta).toBe(c.herramienta);
      expect(l.entrada).toEqual(c.entrada);
    });
  }

  it("las 4 preguntas sugeridas son exactamente las del plan", () => {
    expect(PREGUNTAS_SUGERIDAS).toHaveLength(4);
    expect(sugerenciasPara(null)).toEqual([...PREGUNTAS_SUGERIDAS]);
    expect(sugerenciasPara("farmacia")[0]).toBe("¿Dónde pondrías una farmacia en el sur?");
  });

  it("hereda el servicio de un mensaje anterior si la pantalla no lo da", () => {
    const l = llamada("¿Y si la pongo en Pinto?", undefined, ["¿Dónde pondrías una farmacia en el sur?"]);
    expect(l.entrada).toEqual({ servicio: "farmacia", lugar: "Pinto" });
  });

  it("el servicio del texto gana al de la pantalla", () => {
    const l = llamada("¿Y si pongo una farmacia en Pinto?", RESIDENCIA);
    expect(l.entrada).toEqual({ servicio: "farmacia", lugar: "Pinto" });
  });

  it("«este» demostrativo no es la zona Este, pero «en el este» sí", () => {
    const a = interp("¿qué le falta a este municipio?");
    expect(a.tipo).toBe("no_entendida");
    expect(llamada("farmacias en el este").entrada).toEqual({ servicio: "farmacia", zona: "Este Metropolitano" });
  });

  it("«pon un centro» no confunde «centro» con el distrito Centro", () => {
    const r = interp("pon un centro en el sur", RESIDENCIA);
    expect(r.tipo === "llamadas" ? r.llamadas[0]!.entrada : null).toMatchObject({ servicio: "residencia", zona: "Sur Metropolitano" });
  });
});

// ---------------------------------------------------------------- lo que no entiende
describe("preguntas que no se entienden", () => {
  const NO: [string, RegExp][] = [
        ["hola", /No he entendido/],
    ["dame la receta de la paella", /No he entendido/],
    ["¿cuántos habitantes tiene España?", /No he entendido/],
    ["residencias", /no sé qué quieres saber/],
    ["¿Dónde pondrías una residencia en Villaquerida?", /No encuentro «villaquerida»/],
    ["¿Y si la pongo en mi barrio?", /Todavía no sé cuál es tu municipio/],
    ["¿Y si la pongo por ahí?", /(¿En qué municipio|No encuentro|Me falta saber)/],
    ["¿Qué municipios están peor?", /Me falta saber de qué servicio/],
    ["farmacias", /no sé qué quieres saber/],
    ["compara Getafe y Leganés en farmacias", /no sé comparar/i],
    ["pon farmacias en Pozuelo", /¿Quizá Pozuelo de Alarcón/],
    // T2-M10: de dinero no se sabe nada, y no se responde con otra herramienta.
    ["cuanto cuesta construir un hospital", /No sé calcular costes/],
    ["¿Cuál es el presupuesto para una residencia en Parla?", /No sé calcular costes/],
    ["precio de poner un centro de salud en Pinto", /No sé calcular costes/],
  ];
  for (const [frase, rx] of NO) {
    it(`«${frase}»`, async () => {
      const r = await responderSinIA(peticion(frase), ent);
      expect(r.modo).toBe("reglas");
      expect(r.acciones).toEqual([]);
      expect(r.pasos).toEqual([]);
      expect(r.texto).toMatch(rx);
      // Honesta: ni una cifra (salvo el recuento de lugares al decir «no encuentro»).
      const sinRecuento = r.texto.replace(/los \d+ municipios, los \d+ distritos de Madrid y las \d+ zonas/, "");
      expect(sinRecuento).not.toMatch(/\d/);
      // y con sugerencias
      expect(r.texto).toMatch(/Prueba con: «/);
    });
  }

  it("la pregunta del lugar desconocido sugiere un nombre parecido si lo hay", async () => {
    const r = await responderSinIA(peticion("¿Dónde faltan farmacias en Fuenlabrda?"), ent);
    expect(r.acciones.length).toBeGreaterThan(0); // «Fuenlabrda» se corrige a Fuenlabrada
    const q = await responderSinIA(peticion("¿Dónde faltan farmacias en Alcala Henares?"), ent);
    expect(q.texto.length).toBeGreaterThan(0);
  });

  it("pregunta vacía", async () => {
    expect((await responderSinIA(peticion("   "), ent)).texto).toMatch(/ninguna pregunta/);
  });

  it("peticiones mal formadas: sin mensajes, texto largo o demasiados mensajes", async () => {
    expect((await responderSinIA({ mensajes: [], contexto: peticion("x").contexto }, ent)).texto).toMatch(/ninguna pregunta/);
    expect((await responderSinIA(peticion("a".repeat(501)), ent)).texto).toMatch(/demasiado larga/);
    const muchos = Array.from({ length: 12 }, () => ({ rol: "usuario" as const, texto: "hola" }));
    expect((await responderSinIA(peticion("hola", {}, muchos), ent)).texto).toMatch(/demasiado larga/);
    expect((await responderSinIA({ mensajes: [{ rol: "asistente", texto: "hola" }], contexto: peticion("x").contexto }, ent)).texto).toMatch(/ninguna pregunta/);
  });
});

// ---------------------------------------------------------------- respuesta completa
describe("respuesta del modo sin IA", () => {
  it("«¿Dónde pondrías una residencia en el sur?» devuelve el punto del caso 4 (Leganés, 93,8 de 94 plazas) en menos de 1 s", async () => {
    const t0 = performance.now();
    const r = await responderSinIA(peticion("¿Dónde pondrías una residencia en el sur?", RESIDENCIA), ent);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(r.modo).toBe("reglas");
    expect(r.restantes).toBeNull();
    expect(ETIQUETA_MODO_REGLAS).toMatch(/Modo sin IA/);
    const marcar = r.acciones.find((a) => a.tipo === "marcar_puntos");
    expect(marcar && marcar.tipo === "marcar_puntos" && marcar.puntos[0]).toMatchObject({ etiqueta: "Opción 1", plazas: 94 });
    expect(marcar && marcar.tipo === "marcar_puntos" && Math.abs(marcar.puntos[0]!.reduce! - referencia.caso4.reduce_faltan)).toBeLessThan(0.006);
    const p = marcar && marcar.tipo === "marcar_puntos" ? marcar.puntos[0]! : null;
    expect(Math.abs(p!.lat - referencia.caso4.lat)).toBeLessThan(1e-4);
    expect(Math.abs(p!.lon - referencia.caso4.lon)).toBeLessThan(1e-4);
    expect(r.acciones.map((a) => a.tipo)).toEqual(["elegir_servicio", "marcar_puntos", "mover_mapa"]);
    expect(r.pasos).toHaveLength(1);
    expect(r.pasos[0]!.herramienta).toBe("ubicacion_optima");
    expect(r.texto).toMatch(/Leganés/);
    expect(r.texto).toMatch(/cubre 93,8 plazas más/);
  });

  it("la conversación completa de la demo: óptimo, simulación con el servicio heredado y ficha", async () => {
    const m1 = peticion("¿Dónde pondrías una residencia en el sur?");
    const r1 = await responderSinIA(m1, ent);
    const m2 = peticion("¿Y si la pongo en Pinto?", {}, [...m1.mensajes, { rol: "asistente", texto: r1.texto.slice(0, 500) }]);
    const r2 = await responderSinIA(m2, ent);
    expect(r2.pasos[0]!.herramienta).toBe("simular_centro");
    expect(r2.texto).toMatch(/cubre \d+,\d plazas más/);
    expect(r2.texto).toMatch(/aprovecha 93,8 de 94 en Leganés/);
    expect(r2.texto).toMatch(/68 % del óptimo/);
    const r3 = await responderSinIA(peticion("¿Qué le falta a Parla?"), ent);
    expect(r3.acciones).toEqual([{ tipo: "abrir_ficha", lugar: "mun:28106" }]);
    expect(r3.texto).toMatch(/^Parla tiene 138\.012 habitantes/);
  });

  it("la ficha de un municipio con déficit de plazas dice cuántas le faltan", async () => {
    const r = await responderSinIA(peticion("¿Cuántas plazas faltan en residencias en Leganés?"), ent);
    expect(r.texto).toMatch(/habría sitio para unas [\d.]+ plazas más/);
  });

  it("un error de herramienta se cuenta en claro, sin acciones", async () => {
    const r = await responderSinIA(peticion("¿qué municipios de Getafe están peor en farmacias?"), ent);
    expect(r.texto).toMatch(/un solo municipio/);
    expect(r.acciones).toEqual([]);
  });

  it("las 4 sugeridas funcionan sin servidor y todas devuelven acciones o ficha", async () => {
    for (const q of PREGUNTAS_SUGERIDAS) {
      const r = await responderSinIA(peticion(q, RESIDENCIA), ent);
      expect(r.pasos.length).toBeGreaterThan(0);
      expect(r.acciones.length).toBeGreaterThan(0);
      expect(r.texto.length).toBeGreaterThan(40);
    }
  });
});

// ---------------------------------------------------------------- ninguna cifra inventada
/** Números de un texto en formato español: «1.581», «4,1», «100,0 %», «10 km». */
function numerosDelTexto(texto: string): number[] {
  const limpio = texto.replace(/\b\d+\)/g, "").replace(/«[^»]*»/g, "");
  return [...limpio.matchAll(/\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:,\d+)?/g)].map((m) => Number(m[0].replace(/\./g, "").replace(",", ".")));
}

function numerosDe(x: unknown, out: Set<number> = new Set()): Set<number> {
  if (typeof x === "number" && Number.isFinite(x)) { out.add(x); out.add(x / 1000); }
  else if (typeof x === "string") for (const n of numerosDelTexto(x)) out.add(n);
  else if (Array.isArray(x)) { out.add(x.length); for (const v of x) numerosDe(v, out); }
  else if (x && typeof x === "object") for (const v of Object.values(x)) numerosDe(v, out);
  return out;
}

describe("las cifras del texto salen solo de las herramientas", () => {
  const FRASES_CIFRAS = [
    "¿Dónde pondrías una residencia en el sur?",
    "dos farmacias en el este",
    "¿Dónde falta un hospital en el oeste?",
    "¿Dónde faltan farmacias en Getafe?",
    "¿En qué municipios de la sierra ayudaría más un hospital?",
    "los 5 peores municipios en residencias",
    "¿Qué distritos de Madrid están peor en farmacias?",
    "¿Y si la pongo en Pinto?",
    "y si pongo un centro de salud en Leganés",
    "¿Qué le falta a Parla?",
    "¿Qué le falta a La Acebeda?",
    "¿Qué le falta al distrito Centro?",
    "¿Qué le falta a Leganés?",
    "¿Cuántas plazas de residencia faltan?",
  ];
  for (const frase of FRASES_CIFRAS) {
    it(`«${frase}»`, async () => {
      const i = interpretar(frase, { territorios: datos.territorios, contexto: RESIDENCIA });
      if (i.tipo !== "llamadas") throw new Error("no entendida");
      const { ejecutarHerramienta } = await import("./herramientas");
      const resultados: ResultadoHerramienta[] = [];
      for (const l of i.llamadas) resultados.push(await ejecutarHerramienta(l.herramienta, l.entrada, ent.conContexto(RESIDENCIA)));
      const permitidos = new Set<number>();
      for (const r of resultados) {
        expect(r.ok).toBe(true);
        if (r.ok) numerosDe(r.salida, permitidos);
      }
      const texto = resultados.map((r) => redactarResultado(r)).join(" ");
      for (const n of numerosDelTexto(texto)) {
        const hay = [...permitidos].some((p) => Math.abs(p - n) <= 0.051 || Math.abs(Math.round(p) - n) <= 1);
        expect(hay, `«${n}» no sale de las herramientas en: ${texto}`).toBe(true);
      }
    });
  }
});

describe("coherencia con el servicio", () => {
  it("todas las frases de FRASES nombran un servicio distinto y el intérprete las reconoce", () => {
    const vistos = new Set<ServicioId>();
    for (const [texto, id] of [
      ["residencias de mayores", "residencia"],
      ["centros de salud o consultorios", "centro_salud"],
      ["hospitales generales públicos", "hospital"],
      ["farmacias", "farmacia"],
      ["colegios e institutos", "colegio"],
      ["desfibriladores", "dea"],
    ] as [string, ServicioId][]) {
      const l = llamada(`¿Dónde pondrías ${texto} en el sur?`);
      expect(l.entrada.servicio).toBe(id);
      vistos.add(id);
    }
    expect(vistos.size).toBe(6);
  });
});

describe("T3: F-3 y F-8", () => {
  it("«¿Dónde faltan más plazas de residencia?» da el ranking, no la ubicación óptima", () => {
    expect(llamada("¿Dónde faltan más plazas de residencia?").herramienta).toBe("ranking_deficit");
    expect(llamada("¿Dónde faltan más residencias?").herramienta).toBe("ranking_deficit");
    // lo de siempre sigue igual
    expect(llamada("¿Dónde pondrías una residencia en el sur?").herramienta).toBe("ubicacion_optima");
  });
  it("«¿Y en 2030?» cambia el año del simulador (y «¿y hoy?» lo devuelve), sin inventar cifras", async () => {
    for (const [frase, anio] of [["¿Y en 2030?", 2030], ["en 2030", 2030], ["¿Y hoy?", 2025]] as const) {
      const r = await responderSinIA(peticion(frase, { servicio: "residencia", radio_m: 10000 }), ent);
      expect(r.acciones).toEqual([{ tipo: "elegir_servicio", servicio: "residencia", radio_m: 10000, anio }]);
      expect(r.texto).not.toMatch(/\d{2,}\.\d{3}/);
    }
    // una pregunta con más contenido no se toma por un cambio de año
    const r = await responderSinIA(peticion("¿Qué le falta a Parla en 2030?"), ent);
    expect(r.acciones.some((a) => a.tipo === "elegir_servicio")).toBe(false);
  });
  it("con 2030 en el simulador, la ficha del agente es la de hoy y lo dice", async () => {
    const hoy = datos;
    const s30 = { ...datos.secciones, anio_poblacion: 2030 as const };
    const d30: Datos = { ...datos, secciones: s30, servicios: { ...datos.servicios } };
    const e30 = crearEntorno(d30, { seccionesHoy: hoy.secciones, datosHoy: hoy });
    const r = await responderSinIA(peticion("¿Qué le falta a Parla?", { servicio: "residencia" }), e30);
    expect(r.texto).toContain("censo de 2025");
    expect(r.texto).toContain("es siempre de hoy");
    expect(r.texto).not.toContain("Cifras de 2030");
  });
});

describe("T5: preguntas sugeridas en positivo", () => {
  it("«¿En qué municipios de la sierra ayudaría más un hospital?» es un ranking de hospitales en la sierra", () => {
    const l = llamada("¿En qué municipios de la sierra ayudaría más un hospital?");
    expect(l.herramienta).toBe("ranking_deficit");
    expect(l.entrada).toMatchObject({ servicio: "hospital" });
  });
  it("«¿Qué servicios tiene Parla?» es la ficha de Parla", () => {
    const l = llamada("¿Qué servicios tiene Parla?");
    expect(l.herramienta).toBe("ficha_municipio");
    expect(l.entrada).toMatchObject({ lugar: "Parla" });
  });
});
