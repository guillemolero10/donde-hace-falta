// T7 (tester): pruebas del bloque «Meta directo» + I3 con el proveedor SIMULADO. Ni red ni claves reales.
// Incluye la simulación de latencia: un reloj falso y un fetch que respeta el límite como lo haría `AbortSignal.timeout`.
import { describe, expect, it } from "vitest";
import { MAX_RESULTADO_AL_MODELO, manejarAgente, TIEMPO_TURNO_MS, type Dependencias } from "./agente";
import { crearCargadorNode } from "./datos";
import { crearPresupuesto, limiteIpDia, topeDiarioUsd } from "./presupuesto";
import { COSTE_LLAMADA_CORTADA_USD, ErrorTiempo, llamarModelo, proveedorDesdeEntorno } from "./proveedor";
import { historialDelInforme, informeMarkdown } from "./evaluacion";
import { vistaParaModelo } from "./vista-modelo";
import { validarTexto, numerosPermitidos } from "./validador";

const cargador = crearCargadorNode(process.cwd(), import.meta.url);
const CLAVE_META = "meta-clave-SECRETA-123456";
const CLAVE_BASETEN = "baseten-clave-SECRETA-654321";
const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });
const USO = { prompt_tokens: 2000, completion_tokens: 400, completion_tokens_details: { reasoning_tokens: 100 } };
const texto = (t: string) => json({ choices: [{ message: { content: t }, finish_reason: "stop" }], usage: USO });
const herramienta = (name: string, args: unknown) =>
  json({ choices: [{ message: { content: null, tool_calls: [{ id: "c0", type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }], usage: USO });
const pet = (t: string) => ({ mensajes: [{ rol: "usuario", texto: t }], contexto: { vista: "donde", servicio: null, radio_m: null, lugar: null } });

/**
 * Reloj falso + fetch con retardo por llamada. Replica `AbortSignal.timeout(queda)`: si el retardo supera lo que queda hasta el límite,
 * el reloj salta al límite y el fetch falla con TimeoutError (la respuesta nunca llega).
 */
function escenario(retardos: number[], respuestas: (n: number) => Response) {
  let t = 0;
  const llamadas: { url: string; auth: string }[] = [];
  const f = ((url: string, init: RequestInit) => {
    const n = llamadas.length;
    llamadas.push({ url, auth: (init.headers as Record<string, string>).Authorization! });
    const d = (retardos[n] ?? 1000) as number;
    const limite = TIEMPO_TURNO_MS; // inicio = 0
    if (t + d > limite) {
      t = limite;
      return Promise.reject(Object.assign(new Error("timeout"), { name: "TimeoutError" }));
    }
    t += d;
    return Promise.resolve(respuestas(n));
  }) as unknown as typeof fetch;
  return { fetch: f, ahora: () => t, llamadas };
}

describe("T7: selección de proveedor y clave", () => {
  const casos: [string, Record<string, string>, string | null][] = [
    ["solo Meta", { META_API_KEY: CLAVE_META }, "meta"],
    ["solo Baseten", { BASETEN_API_KEY: CLAVE_BASETEN }, "baseten"],
    ["las dos", { META_API_KEY: CLAVE_META, BASETEN_API_KEY: CLAVE_BASETEN }, "meta"],
    ["ninguna", {}, null],
    ["valor raro con las dos", { AGENTE_PROVEEDOR: "gpt", META_API_KEY: CLAVE_META, BASETEN_API_KEY: CLAVE_BASETEN }, "meta"],
    ["forzar baseten sin su clave", { AGENTE_PROVEEDOR: "baseten", META_API_KEY: CLAVE_META }, null],
    ["clave con espacios", { META_API_KEY: `  ${CLAVE_META}  ` }, "meta"],
  ];
  for (const [nombre, env, esperado] of casos) {
    it(nombre, () => {
      const p = proveedorDesdeEntorno(env);
      expect(p?.id ?? null).toBe(esperado);
      if (p?.id === "meta") {
        expect(p.baseUrl).toBe("https://api.meta.ai/v1");
        expect(p.modelo).toBe("muse-spark-1.3");
        expect(p.apiKey).toBe(CLAVE_META);
      }
    });
  }

  for (const activo of ["0", "1", undefined, "", " 1 ", "true", "si"]) {
    it(`AGENTE_ACTIVO=${JSON.stringify(activo)}`, async () => {
      const e = escenario([1000, 1000], (n) => (n === 0 ? herramienta("ranking_deficit", { servicio: "farmacia" }) : texto("Hola.")));
      const env = { META_API_KEY: CLAVE_META, ...(activo === undefined ? {} : { AGENTE_ACTIVO: activo }) };
      const r = await manejarAgente({ metodo: "POST", cuerpo: JSON.stringify(pet("hola")), ip: "1.1.1.1" }, { env, cargador, presupuesto: crearPresupuesto(), fetch: e.fetch, ahora: e.ahora, registrar: () => {} });
      const activa = activo?.trim() === "1";
      expect(r.status === 503).toBe(!activa);
      if (!activa) expect(e.llamadas).toHaveLength(0);
    });
  }

  it("la petición va a Meta con Bearer y el coste usa 1,25/4,25 $ por millón; la clave no sale en registros ni respuestas", async () => {
    const e = escenario([1000], () => texto("Solo puedo ayudarte con servicios públicos de la Comunidad de Madrid"));
    const lineas: Record<string, unknown>[] = [];
    const presupuesto = crearPresupuesto();
    const r = await manejarAgente({ metodo: "POST", cuerpo: JSON.stringify(pet("hola")), ip: "1.1.1.1" }, { env: { AGENTE_ACTIVO: "1", META_API_KEY: CLAVE_META }, cargador, presupuesto, fetch: e.fetch, ahora: e.ahora, registrar: (l) => lineas.push(l) });
    expect(r.status).toBe(200);
    expect(e.llamadas[0]!.url).toBe("https://api.meta.ai/v1/chat/completions");
    expect(e.llamadas[0]!.auth).toBe(`Bearer ${CLAVE_META}`);
    expect(lineas[0]!.coste_usd).toBeCloseTo((2000 * 1.25 + 400 * 4.25) / 1e6, 6);
    expect(presupuesto.gastadoHoyUsd()).toBeCloseTo(0.0042, 6);
    expect(JSON.stringify([lineas, r])).not.toContain("SECRETA");
  });

  it("un error de red cuyo mensaje contiene la clave no se filtra al cliente ni al registro", async () => {
    const lineas: Record<string, unknown>[] = [];
    const f = (async () => {
      throw new Error(`fallo conectando con Authorization: Bearer ${CLAVE_META}`);
    }) as unknown as typeof fetch;
    const r = await manejarAgente({ metodo: "POST", cuerpo: JSON.stringify(pet("hola")), ip: "2.2.2.2" }, { env: { AGENTE_ACTIVO: "1", META_API_KEY: CLAVE_META }, cargador, presupuesto: crearPresupuesto(), fetch: f, registrar: (l) => lineas.push(l), espera: async () => {} });
    expect(r.status).toBe(503);
    expect(JSON.stringify([lineas, r])).not.toContain("SECRETA");
  });

  it("topes: AI_DAILY_BUDGET_USD y AGENTE_LIMITE_IP_DIA", () => {
    expect(topeDiarioUsd({})).toBe(3);
    expect(topeDiarioUsd({ AI_DAILY_BUDGET_USD: "0" })).toBe(0);
    expect(topeDiarioUsd({ AI_DAILY_BUDGET_USD: "abc" })).toBe(0);
    expect(topeDiarioUsd({ AI_DAILY_BUDGET_USD: "0,5" })).toBe(0); // coma decimal: falla cerrado
    expect(limiteIpDia({ AGENTE_LIMITE_IP_DIA: "50" })).toBe(50);
    expect(limiteIpDia({ AGENTE_LIMITE_IP_DIA: "0" })).toBe(3);
    expect(limiteIpDia({ AGENTE_LIMITE_IP_DIA: "2.5" })).toBe(3);
  });

  it("el tope diario corta: con 0,05 $ de tope, la 2.ª pregunta recibe 503 presupuesto", async () => {
    const deps = (e: ReturnType<typeof escenario>): Dependencias => ({ env: { AGENTE_ACTIVO: "1", META_API_KEY: CLAVE_META, AI_DAILY_BUDGET_USD: "0.05" }, cargador, presupuesto: pres, fetch: e.fetch, ahora: e.ahora, registrar: () => {}, espera: async () => {} });
    const pres = crearPresupuesto();
    const mk = () => escenario([1000], () => texto("Solo puedo ayudarte con servicios públicos de la Comunidad de Madrid"));
    const a = await manejarAgente({ metodo: "POST", cuerpo: JSON.stringify(pet("hola")), ip: "3.3.3.3" }, deps(mk()));
    expect(a.status).toBe(200);
    // 0,0042 $ gastado + nada en vuelo: aún cabe; con tope 0,004 ya no
    const b = await manejarAgente({ metodo: "POST", cuerpo: JSON.stringify(pet("hola")), ip: "3.3.3.4" }, { ...deps(mk()), env: { AGENTE_ACTIVO: "1", META_API_KEY: CLAVE_META, AI_DAILY_BUDGET_USD: "0.004" } });
    expect(b.status).toBe(503);
    expect((b.cuerpo as { motivo: string }).motivo).toBe("presupuesto");
  });
});

describe(`T7: latencia (TIEMPO_TURNO_MS = ${TIEMPO_TURNO_MS / 1000} s)`, () => {
  const SEGUIR = "Hoy el modelo propone un punto.";
  /** Un turno con 1 llamada: sin herramientas (p. ej. pregunta de método). */
  async function turnoSimple(d: number) {
    const e = escenario([d], () => texto("Solo puedo ayudarte con servicios públicos de la Comunidad de Madrid"));
    const presupuesto = crearPresupuesto();
    const r = await manejarAgente({ metodo: "POST", cuerpo: JSON.stringify(pet("hola")), ip: "9.9.9.9" }, { env: { AGENTE_ACTIVO: "1", META_API_KEY: CLAVE_META, AGENTE_LIMITE_IP_DIA: "1" }, cargador, presupuesto, fetch: e.fetch, ahora: e.ahora, registrar: () => {}, espera: async () => {} });
    const gasto = presupuesto.gastadoHoyUsd();
    const otra = await manejarAgente({ metodo: "POST", cuerpo: JSON.stringify(pet("hola")), ip: "9.9.9.9" }, { env: { AGENTE_ACTIVO: "1", META_API_KEY: CLAVE_META, AGENTE_LIMITE_IP_DIA: "1" }, cargador, presupuesto, fetch: escenario([100], () => texto("Solo puedo ayudarte con servicios públicos de la Comunidad de Madrid")).fetch, registrar: () => {} });
    return { status: r.status, modo: (r.cuerpo as { modo?: string }).modo, gasto, cupoDevuelto: otra.status !== 429 };
  }
  /** Un turno con herramienta: 1.ª llamada tarda d1 y la 2.ª (redactar) d2. */
  async function turnoConHerramienta(d1: number, d2: number) {
    const e = escenario([d1, d2], (n) => (n === 0 ? herramienta("ranking_deficit", { servicio: "farmacia" }) : texto(SEGUIR)));
    const presupuesto = crearPresupuesto();
    const lineas: Record<string, unknown>[] = [];
    const r = await manejarAgente({ metodo: "POST", cuerpo: JSON.stringify(pet("¿dónde faltan farmacias?")), ip: "8.8.8.8" }, { env: { AGENTE_ACTIVO: "1", META_API_KEY: CLAVE_META, AGENTE_LIMITE_IP_DIA: "1" }, cargador, presupuesto, fetch: e.fetch, ahora: e.ahora, registrar: (l) => lineas.push(l), espera: async () => {} });
    const gasto = presupuesto.gastadoHoyUsd();
    const otra = await manejarAgente({ metodo: "POST", cuerpo: JSON.stringify(pet("hola")), ip: "8.8.8.8" }, { env: { AGENTE_ACTIVO: "1", META_API_KEY: CLAVE_META, AGENTE_LIMITE_IP_DIA: "1" }, cargador, presupuesto, fetch: escenario([100], () => texto("Solo puedo ayudarte con servicios públicos de la Comunidad de Madrid")).fetch, registrar: () => {} });
    return { status: r.status, modo: (r.cuerpo as { modo?: string }).modo, validacion: lineas[0]?.validacion, gasto, cupoDevuelto: otra.status !== 429 };
  }

  it("una llamada: 38 s responde con IA; pasado el límite da 504, apunta la llamada cortada en el tope y NO devuelve el cupo (R5-I1)", async () => {
    const a = await turnoSimple(38_000);
    expect(a).toMatchObject({ status: 200, modo: "ia" });
    for (const d of [TIEMPO_TURNO_MS + 1_000, 42_000, 45_000]) {
      const r = await turnoSimple(d);
      expect(r, `${d} ms`).toMatchObject({ status: 504, gasto: COSTE_LLAMADA_CORTADA_USD, cupoDevuelto: false });
    }
  });

  it("con herramienta: 1.ª llamada de 10 s + 2.ª de 25 s = IA; 2.ª de 31 s (total 41 s) = plantilla sin IA con 200", async () => {
    expect(await turnoConHerramienta(10_000, 25_000)).toMatchObject({ status: 200, modo: "ia" });
    const lenta = await turnoConHerramienta(10_000, 31_000);
    expect(lenta).toMatchObject({ status: 200, modo: "reglas", validacion: "tiempo" });
    expect(lenta.gasto).toBeGreaterThan(0); // la 1.ª sí se cobró
  });

  it("con herramienta: si la 1.ª llamada ya tarda 38 s el turno acaba sin texto del modelo (plantilla); pasado el límite, 504", async () => {
    const r38 = await turnoConHerramienta(38_000, 5_000);
    expect(r38).toMatchObject({ status: 200, modo: "reglas", validacion: "tiempo" });
    const tarde = await turnoConHerramienta(TIEMPO_TURNO_MS + 1_000, 1_000);
    expect(tarde).toMatchObject({ status: 504, gasto: COSTE_LLAMADA_CORTADA_USD, cupoDevuelto: false });
  });
});

describe("T7: vista-modelo, casos límite (NaN, negativos, enormes)", () => {
  const base = { anio_poblacion: 2025, servicio: "farmacia", radio_m: 1000, criterio: "x", ambito: { tipo: "comunidad", nombre: "Madrid" } };
  const ranking = (f: object) => ({ ok: true as const, herramienta: "ranking_deficit" as const, acciones: [], paso: { herramienta: "ranking_deficit", resumen: "" }, salida: { ...base, nivel: "municipio", orden: "personas", filas: [f], total_deficit: 1, total_objetivo: 2 } });
  const fila = (o: object) => ({ id: "x", nombre: "A", en_deficit: 0, objetivo: 0, pct: 0, ratio: null, aproximada: false, ...o });
  const salida = (o: object) => JSON.stringify(vistaParaModelo(ranking(fila(o)) as never));

  it("formato español de miles, decimales y ceros", () => {
    const s = salida({ en_deficit: 189814, objetivo: 1234567, pct: 15.37 });
    expect(s).toContain("189.814");
    expect(s).toContain("1.234.567");
    expect(s).toContain("15,4 %");
  });
  it("0, NaN, negativo e Infinity no rompen la vista (se documenta qué sale)", () => {
    for (const v of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 1e21]) {
      expect(() => salida({ en_deficit: v, objetivo: v, pct: v })).not.toThrow();
    }
  });
  it("undefined/null en campos opcionales no lanza", () => {
    expect(() => salida({ en_deficit: undefined, objetivo: null, pct: undefined })).not.toThrow();
  });
  it("el validador acepta lo que el modelo copia de la vista (miles con punto, % con coma) y rechaza lo inventado", () => {
    const r = ranking(fila({ en_deficit: 189814, objetivo: 1234567, pct: 15.37, nombre: "Parla" }));
    const permitidos = numerosPermitidos([r.salida], []);
    expect(validarTexto("En Parla hay 189.814 habitantes de 1.234.567 (15,4 %).", permitidos).ok).toBe(true);
    expect(validarTexto("En Parla hay 189.815 habitantes.", permitidos).ok).toBe(false);
    expect(validarTexto("En Parla hay 189814 habitantes.", permitidos).ok).toBe(true); // sin separador: se acepta
  });
  it("un resultado enorme se recorta antes de mandarlo al modelo", () => {
    expect(MAX_RESULTADO_AL_MODELO).toBe(12_000);
  });
});

describe("T7: proveedor Baseten usa el precio de Meta", () => {
  it("el precio es el mismo para los dos proveedores (declarado en un único sitio)", () => {
    expect(proveedorDesdeEntorno({ BASETEN_API_KEY: "k" })!.precio).toEqual({ entrada: 1.25, salida: 4.25 });
  });
});

describe("R5: arreglos de la revisión", () => {
  const p = proveedorDesdeEntorno({ META_API_KEY: CLAVE_META })!;
  const corte = (async () => {
    throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
  }) as unknown as typeof fetch;

  it("I1: una petición enviada y cortada por tiempo se apunta como gastada (ErrorTiempo con enviada = true)", async () => {
    const usos: number[] = [];
    const e = await llamarModelo(p, [], { limite: Date.now() + 5000, fetch: corte, despues: (u) => usos.push(u.costeUsd) }).catch((x) => x);
    expect(e).toBeInstanceOf(ErrorTiempo);
    expect((e as ErrorTiempo).enviada).toBe(true);
    expect(usos).toEqual([COSTE_LLAMADA_CORTADA_USD]);
  });

  it("I1: sin tiempo para enviarla, no se apunta nada (enviada = false)", async () => {
    const usos: number[] = [];
    const e = await llamarModelo(p, [], { limite: Date.now() + 500, fetch: corte, despues: (u) => usos.push(u.costeUsd) }).catch((x) => x);
    expect((e as ErrorTiempo).enviada).toBe(false);
    expect(usos).toEqual([]);
  });

  it("I1: si el tiempo se agota mientras llega el cuerpo, es un corte por tiempo (no «formato») y también cuenta", async () => {
    const usos: number[] = [];
    const cuerpoCortado = (async () => ({ ok: true, status: 200, json: async () => { throw Object.assign(new Error("abort"), { name: "AbortError" }); } })) as unknown as typeof fetch;
    const e = await llamarModelo(p, [], { limite: Date.now() + 5000, fetch: cuerpoCortado, despues: (u) => usos.push(u.costeUsd) }).catch((x) => x);
    expect(e).toBeInstanceOf(ErrorTiempo);
    expect(usos).toEqual([COSTE_LLAMADA_CORTADA_USD]);
  });

  it("I1: un 429 seguido de un corte apunta el coste una sola vez y la reserva vuelve a 0", async () => {
    const presupuesto = crearPresupuesto();
    const usos: number[] = [];
    let n = 0;
    const f = (async () => {
      if (n++ === 0) return json({}, 429);
      throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    }) as unknown as typeof fetch;
    const e = await llamarModelo(p, [], {
      limite: Date.now() + 10_000,
      fetch: f,
      espera: async () => {},
      antes: () => presupuesto.reservar(3),
      despues: (u) => {
        presupuesto.anotar(u);
        usos.push(u.costeUsd);
      },
    }).catch((x) => x);
    expect(e).toBeInstanceOf(ErrorTiempo);
    expect(n).toBe(2);
    expect(usos).toEqual([COSTE_LLAMADA_CORTADA_USD]);
    expect(presupuesto.reservadoUsd()).toBe(0);
    expect(presupuesto.gastadoHoyUsd()).toBeCloseTo(COSTE_LLAMADA_CORTADA_USD, 6);
  });

  const base = { anio_poblacion: 2025, servicio: "farmacia", radio_m: 1000, criterio: "x", ambito: { tipo: "comunidad", nombre: "Madrid" } };
  const vistaRanking = (filas: object[]) =>
    vistaParaModelo({ ok: true, herramienta: "ranking_deficit", acciones: [], paso: { herramienta: "ranking_deficit", resumen: "" }, salida: { ...base, nivel: "municipio", orden: "personas", filas, total_deficit: 1, total_objetivo: 2 } } as never);
  const fila = (o: object) => ({ id: "x", nombre: "A", en_deficit: 3, objetivo: 10_000, pct: 0.03, ratio: null, aproximada: false, ...o });

  it("M1: la vista ya no lleva «puesto» (número que no sale de las herramientas)", () => {
    const s = JSON.stringify(vistaRanking([fila({}), fila({ nombre: "B" }), fila({ nombre: "C", aproximada: true })]));
    expect(s).not.toContain("puesto");
  });

  it("M2: por debajo del 0,1 % la vista no da cifra y el validador acepta el texto copiado", () => {
    const s = JSON.stringify(vistaRanking([fila({})]));
    expect(s).toContain("una parte mínima");
    expect(s).not.toContain("0,1");
    const salida = { ...base, nivel: "municipio", orden: "personas", filas: [fila({})], total_deficit: 1, total_objetivo: 2 };
    expect(validarTexto("En A, una parte mínima de los vecinos vive lejos.", numerosPermitidos([salida], [])).ok).toBe(true);
  });

  it("M5: al regenerar el informe I3 se conserva el historial escrito a mano", () => {
    const viejo = "# I3\n\n| tabla |\n\n## Historial de pasadas (x)\n| 1 | 2/12 |\n\nTexto.\n\n## Respuestas\n### 1\n";
    const h = historialDelInforme(viejo);
    expect(h).toBe("## Historial de pasadas (x)\n| 1 | 2/12 |\n\nTexto.");
    expect(historialDelInforme("# sin historial\n")).toBeNull();
    const md = informeMarkdown([], { prompt: "agente-v4", modelo: "m", fecha: "2026-11-20", historial: h });
    expect(md.indexOf("## Historial de pasadas")).toBeGreaterThan(-1);
    expect(md.indexOf("## Historial de pasadas")).toBeLessThan(md.indexOf("## Respuestas"));
    expect(md).toContain(`límite del turno ${TIEMPO_TURNO_MS / 1000} s`);
  });
});
