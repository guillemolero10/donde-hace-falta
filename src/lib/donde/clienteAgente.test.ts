// Cliente del agente: llama a /api/agente y pasa al modo sin IA con 503, 504, 429, sin red o sin /api. Sin red real: `fetch` es simulado.
import { describe, expect, it, vi } from "vitest";
import { AVISO_RESPUESTA_REVISADA, crearClienteAgente, esRespuestaAgente, mensajesParaEnviar, ESPERA_TRAS_FALLO_MS } from "./clienteAgente";
import type { PeticionAgente, RespuestaAgente } from "./tipos";

const peticion: PeticionAgente = {
  mensajes: [{ rol: "usuario", texto: "¿Dónde pondrías una residencia en el sur?" }],
  contexto: { vista: "donde", servicio: "residencia", radio_m: 10000, lugar: null },
};
const RESPUESTA_IA: RespuestaAgente = {
  texto: "Parla.",
  acciones: [{ tipo: "abrir_ficha", lugar: "mun:28106" }],
  pasos: [{ herramienta: "ubicacion_optima", entrada: {}, resumen: "1 punto en Parla" }],
  modo: "ia",
  restantes: 7,
};
const LOCAL: RespuestaAgente = { texto: "Respuesta local", acciones: [], pasos: [], modo: "reglas", restantes: null };

const json = (estado: number, cuerpo: unknown) => new Response(JSON.stringify(cuerpo), { status: estado, headers: { "content-type": "application/json" } });
function cliente(f: typeof fetch, extra: { ahora?: () => number; tiempoMaximoMs?: number } = {}) {
  const local = vi.fn(async () => LOCAL);
  return { local, c: crearClienteAgente({ fetch: f, local, ...extra }) };
}

describe("cliente del agente", () => {
  it("200 con IA: devuelve la respuesta del servidor y no usa el modo local", async () => {
    const f = vi.fn(async () => json(200, RESPUESTA_IA));
    const { c, local } = cliente(f as unknown as typeof fetch);
    const r = await c.preguntar(peticion);
    expect(r.via).toBe("api");
    expect(r.respuesta.modo).toBe("ia");
    expect(r.respuesta.restantes).toBe(7);
    expect(r.aviso).toBeNull();
    expect(local).not.toHaveBeenCalled();
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/agente");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(peticion);
  });

  it.each([
    [503, { error: "agente_no_disponible", motivo: "sin_clave" }, "sin_clave"],
    [503, { error: "agente_no_disponible", motivo: "apagado" }, "apagado"],
    [503, { error: "agente_no_disponible", motivo: "presupuesto" }, "presupuesto"],
    [503, {}, "no_disponible"],
    [504, { error: "tiempo" }, "tiempo"],
    [429, { error: "limite", reinicio: "2099-01-01T00:00:00Z" }, "limite"],
    [404, null, "sin_api"],
    [500, null, "proveedor"],
  ])("estado %i -> modo sin IA (%s)", async (estado, cuerpo, motivo) => {
    const f = vi.fn(async () => json(estado as number, cuerpo));
    const { c, local } = cliente(f as unknown as typeof fetch);
    const r = await c.preguntar(peticion);
    expect(r.via).toBe("local");
    expect(r.motivo).toBe(motivo);
    expect(r.respuesta.modo).toBe("reglas");
    expect(r.respuesta.texto).toBe("Respuesta local");
    expect(r.aviso).toMatch(/reglas/);
    expect(local).toHaveBeenCalledWith(peticion);
  });

  it("200 con modo «reglas» y motivo «revisada» (el servidor descartó el texto del modelo): respuesta del servidor con el aviso explicado y sin pasar a local", async () => {
    const revisada: RespuestaAgente = { ...RESPUESTA_IA, modo: "reglas", motivo: "revisada" };
    const f = vi.fn(async () => json(200, revisada));
    const { c, local } = cliente(f as unknown as typeof fetch);
    const r = await c.preguntar(peticion);
    expect(r.via).toBe("api");
    expect(r.respuesta.modo).toBe("reglas");
    expect(r.respuesta.motivo).toBe("revisada");
    expect(r.aviso).toBe(AVISO_RESPUESTA_REVISADA);
    expect(local).not.toHaveBeenCalled();
    // Una respuesta de reglas sin motivo (contrato anterior) no lleva aviso.
    const { c: c2 } = cliente((async () => json(200, { ...RESPUESTA_IA, modo: "reglas" })) as unknown as typeof fetch);
    expect((await c2.preguntar(peticion)).aviso).toBeNull();
  });

  it("sin red (fetch lanza): modo sin IA", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const { c } = cliente(f as unknown as typeof fetch);
    const r = await c.preguntar(peticion);
    expect(r.via).toBe("local");
    expect(r.motivo).toBe("sin_red");
    expect(r.aviso).toMatch(/sin red/);
  });

  it("con `npm run dev` /api devuelve la página de inicio (200 con HTML): modo sin IA y no se vuelve a pedir", async () => {
    const f = vi.fn(async () => new Response("<!doctype html><html></html>", { status: 200, headers: { "content-type": "text/html" } }));
    const { c, local } = cliente(f as unknown as typeof fetch);
    const r1 = await c.preguntar(peticion);
    expect(r1.motivo).toBe("sin_api");
    const r2 = await c.preguntar(peticion);
    expect(r2.via).toBe("local");
    expect(f).toHaveBeenCalledTimes(1);
    expect(local).toHaveBeenCalledTimes(2);
  });

  it("200 con una respuesta mal formada: modo sin IA", async () => {
    const f = vi.fn(async () => json(200, { texto: "hola" }));
    const { c } = cliente(f as unknown as typeof fetch);
    expect((await c.preguntar(peticion)).via).toBe("local");
  });

  it("tras un fallo pasajero, la pregunta siguiente vuelve a probar la IA (26-nov: ESPERA_TRAS_FALLO_MS = 0)", async () => {
    expect(ESPERA_TRAS_FALLO_MS).toBe(0);
    const t = 1_000;
    const f = vi.fn(async () => json(503, { motivo: "proveedor" }));
    const { c } = cliente(f as unknown as typeof fetch, { ahora: () => t });
    expect((await c.preguntar(peticion)).via).toBe("local");
    f.mockImplementation(async () => json(200, RESPUESTA_IA));
    const r = await c.preguntar(peticion);
    expect(f).toHaveBeenCalledTimes(2);
    expect(r.via).toBe("api");
  });

  it("olvidarFallos vuelve a probar con el servidor", async () => {
    const f = vi.fn(async () => json(503, {}));
    const { c } = cliente(f as unknown as typeof fetch);
    await c.preguntar(peticion);
    c.olvidarFallos();
    await c.preguntar(peticion);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("un 400 no apaga el agente para las preguntas siguientes", async () => {
    const f = vi.fn(async () => json(400, { error: "peticion" }));
    const { c } = cliente(f as unknown as typeof fetch);
    await c.preguntar(peticion);
    await c.preguntar(peticion);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("más de 28 s sin respuesta: se corta y se responde en local", async () => {
    const f = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => init.signal?.addEventListener("abort", () => rej(new DOMException("abort", "AbortError")))));
    const { c } = cliente(f as unknown as typeof fetch, { tiempoMaximoMs: 20 });
    const r = await c.preguntar(peticion);
    expect(r.motivo).toBe("tiempo");
    expect(r.via).toBe("local");
  });

  it("si quien pregunta cancela, no hay respaldo", async () => {
    const f = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => init.signal?.addEventListener("abort", () => rej(new DOMException("abort", "AbortError")))));
    const { c, local } = cliente(f as unknown as typeof fetch);
    const ctl = new AbortController();
    const p = c.preguntar(peticion, ctl.signal);
    ctl.abort();
    await expect(p).rejects.toBeDefined();
    expect(local).not.toHaveBeenCalled();
  });

  it("si la respuesta local falla, devuelve un texto de error y no lanza", async () => {
    const f = vi.fn(async () => json(503, {}));
    const c = crearClienteAgente({ fetch: f as unknown as typeof fetch, local: async () => { throw new Error("sin datos"); } });
    const r = await c.preguntar(peticion);
    expect(r.respuesta.texto).toMatch(/sin datos/);
    expect(r.respuesta.modo).toBe("reglas");
  });
});

describe("esRespuestaAgente y mensajesParaEnviar", () => {
  it("valida la forma de la respuesta", () => {
    expect(esRespuestaAgente(RESPUESTA_IA)).toBe(true);
    expect(esRespuestaAgente({ ...RESPUESTA_IA, modo: "otro" })).toBe(false);
    expect(esRespuestaAgente({ ...RESPUESTA_IA, acciones: [{ tipo: "borrar_todo" }] })).toBe(false);
    expect(esRespuestaAgente(null)).toBe(false);
  });

  it("el historial se pasa como contexto: máximo 12 mensajes de 500 caracteres y empieza por el usuario", () => {
    const h = Array.from({ length: 20 }, (_, i) => ({ rol: (i % 2 === 0 ? "usuario" : "asistente") as "usuario" | "asistente", texto: `m${i}` }));
    const v = mensajesParaEnviar(h);
    expect(v.length).toBeLessThanOrEqual(12);
    expect(v[0]?.rol).toBe("usuario");
    expect(v[v.length - 1]?.texto).toBe("m19");
    const largo = mensajesParaEnviar([{ rol: "usuario", texto: "x".repeat(900) }]);
    expect(largo[0]?.texto.length).toBe(500);
  });
});

describe("textos del límite por visitante", () => {
  it("el aviso del 429 dice cuántas preguntas hay, sin hablar de beta", async () => {
    const { avisoDeMotivo, PREGUNTAS_IA_BETA } = await import("./clienteAgente");
    expect(PREGUNTAS_IA_BETA).toBe(100);
    expect(avisoDeMotivo("limite")).not.toMatch(/beta/i);
    expect(avisoDeMotivo("limite")).toMatch(/100 preguntas con IA al día/);
  });
  it("singular y plural de las preguntas que quedan", async () => {
    const { textoRestantes } = await import("./clienteAgente");
    expect(textoRestantes(2)).toBe("te quedan 2 preguntas con IA hoy");
    expect(textoRestantes(1)).toBe("te queda 1 pregunta con IA hoy");
    expect(textoRestantes(0)).toBe("te quedan 0 preguntas con IA hoy");
  });
  it("si el servidor tiene otro límite (p. ej. 150 el día 26), el aviso del 429 usa el del servidor, no el fijo", async () => {
    const f = vi.fn(async () => json(429, { error: "limite", reinicio: "2099-01-01T00:00:00Z", limite: 150 }));
    const { c } = cliente(f as unknown as typeof fetch);
    expect((await c.preguntar(peticion)).aviso).toMatch(/150 preguntas con IA al día/);
    // Lo recuerda en las siguientes, que ya no llaman al servidor.
    expect((await c.preguntar(peticion)).aviso).toMatch(/150 preguntas/);
    // Un límite no válido se ignora.
    const { c: c2 } = cliente((async () => json(429, { error: "limite", limite: "mucho" })) as unknown as typeof fetch);
    expect((await c2.preguntar(peticion)).aviso).toMatch(/100 preguntas/);
  });
  it("el límite también llega en el 200 y se usa si después salta el 429", async () => {
    let n = 0;
    const f = vi.fn(async () => (n++ === 0 ? json(200, { ...RESPUESTA_IA, limite: 20 }) : json(429, { error: "limite" })));
    const { c } = cliente(f as unknown as typeof fetch);
    expect((await c.preguntar(peticion)).via).toBe("api");
    expect((await c.preguntar(peticion)).aviso).toMatch(/20 preguntas/);
  });
});
