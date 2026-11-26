// Tope de gasto diario y límite de preguntas por visitante, EN MEMORIA.
//
// Adaptado de `apps/meta-hackathon/dockclerk/src/lib/ai/budget.ts` (proyecto propio de Guillermo Molero). Allí el total vive en una
// base de datos (Prisma) compartida por todas las instancias; aquí no hay base de datos, así que el contador es por instancia de la
// función. LIMITACIÓN DECLARADA: con varias instancias en caliente, o tras un arranque en frío, el contador vuelve a cero y el gasto
// real puede superar el tope por un factor pequeño. El freno de fondo son los créditos prepagados del proveedor (Meta o Baseten) y
// el tope de gasto de su panel. Si hiciera falta un contador global: Upstash Redis (Vercel Marketplace).
//
// Sin DOM ni `import.meta.env`.
import { createHash } from "node:crypto";

export const TOPE_POR_DEFECTO_USD = 3;
/** Reserva si falta `AGENTE_LIMITE_IP_DIA`: 3 preguntas con IA por visitante y día. En producción la variable vale 100 (26-nov). */
export const LIMITE_IP_POR_DEFECTO = 3;
/**
 * Dólares que se reservan al empezar CADA llamada al proveedor y se cambian por el coste real al recibir la respuesta. Cubre una llamada
 * cara: ~6.000 tokens de entrada + 4.000 de salida (el máximo que se pide, razonamiento incluido) = 0,025 $. Así, con peticiones
 * simultáneas, el tope corta también antes de que vuelva ninguna respuesta (T4-11).
 */
export const RESERVA_POR_LLAMADA_USD = 0.045; // R2-M4: cubre también el reintento por respuesta vacía (6.500 tokens de salida + ~8.000 de entrada ≈ 0,038 $)

export interface UsoLlamada {
  entrada: number;
  salida: number;
  razonamiento: number;
  costeUsd: number;
  ms: number;
}

type Entorno = Record<string, string | undefined>;

/** `AI_DAILY_BUDGET_USD` en dólares; 0 apaga el agente. Vacío: el valor por defecto (3 $). Escrito pero no válido (-1, «no»…): 0, apagado (R2-M5: falla cerrado). */
export function topeDiarioUsd(env: Entorno): number {
  const crudo = env.AI_DAILY_BUDGET_USD?.trim();
  const v = crudo ? Number(crudo) : NaN;
  if (!crudo) return TOPE_POR_DEFECTO_USD;
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

/** `AGENTE_LIMITE_IP_DIA`: preguntas con IA por visitante y día. */
export function limiteIpDia(env: Entorno): number {
  const crudo = env.AGENTE_LIMITE_IP_DIA?.trim();
  const v = crudo ? Number(crudo) : NaN;
  return Number.isInteger(v) && v >= 1 ? v : LIMITE_IP_POR_DEFECTO;
}

/** Avisos de configuración para el log de arranque (valores que se ignoran y se sustituyen por el de por defecto). */
export function avisosDeConfiguracion(env: Entorno): string[] {
  const avisos: string[] = [];
  const ip = env.AGENTE_LIMITE_IP_DIA?.trim();
  if (ip && limiteIpDia(env) !== Number(ip)) {
    avisos.push(`AGENTE_LIMITE_IP_DIA="${ip.slice(0, 20)}" no es un entero >= 1: se usa ${LIMITE_IP_POR_DEFECTO} (el límite por visitante no se puede apagar con 0).`);
  }
  const tope = env.AI_DAILY_BUDGET_USD?.trim();
  if (tope && !(Number.isFinite(Number(tope)) && Number(tope) >= 0)) {
    avisos.push(`AI_DAILY_BUDGET_USD="${tope.slice(0, 20)}" no es un número >= 0: el agente queda APAGADO (tope 0 $). Vacío = ${TOPE_POR_DEFECTO_USD} $.`);
  }
  return avisos;
}

export class ErrorPresupuesto extends Error {
  constructor(
    public gastadoUsd: number,
    public topeUsd: number,
  ) {
    super(`Tope diario de IA alcanzado: ${gastadoUsd.toFixed(3)} $ de ${topeUsd.toFixed(2)} $`);
    this.name = "ErrorPresupuesto";
  }
}

/** Día natural en Madrid (`2026-11-25`): el contador se reinicia a medianoche de allí. */
export function diaMadrid(ahora: number): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ahora));
}

/** Instante ISO del próximo reinicio (medianoche de Madrid), aproximado al minuto. */
export function proximoReinicio(ahora: number): string {
  const dia = diaMadrid(ahora);
  let t = ahora;
  // Avanza de hora en hora hasta que cambie el día de Madrid y luego afina por minutos. Como mucho ~25 + 60 pasos.
  while (diaMadrid(t) === dia) t += 3_600_000;
  t -= 3_600_000;
  while (diaMadrid(t) === dia) t += 60_000;
  return new Date(t).toISOString();
}

export const MAX_VISITANTES = 5000;

export interface Presupuesto {
  /** Lanza `ErrorPresupuesto` si el gasto de hoy (más lo reservado por llamadas en vuelo) ya alcanza el tope. */
  comprobar(topeUsd: number): void;
  /**
   * Como `comprobar`, y además reserva `estimadoUsd` hasta que se llame a la función devuelta (idempotente). Hay que llamarla siempre
   * al terminar la llamada, tanto si ha respondido como si ha fallado; el coste real se apunta antes con `anotar`.
   */
  reservar(topeUsd: number, estimadoUsd?: number): () => void;
  /** Dólares reservados ahora por llamadas en vuelo. */
  reservadoUsd(): number;
  /** Apunta el coste de una respuesta del proveedor. */
  anotar(uso: UsoLlamada): void;
  gastadoHoyUsd(): number;
  /** Cuenta una pregunta del visitante; devuelve las que le quedan hoy o `null` si ya no puede preguntar. */
  consumirPregunta(ip: string, limite: number): { restantes: number } | null;
  /** Devuelve una pregunta (el proveedor falló: no es culpa del visitante). */
  devolverPregunta(ip: string): void;
}

/** Contador en memoria. `ahora` se inyecta para probar el cambio de día. */
export function crearPresupuesto(ahora: () => number = () => Date.now()): Presupuesto {
  let dia = diaMadrid(ahora());
  let gastado = 0;
  let reservado = 0;
  const preguntas = new Map<string, number>();

  const alDia = () => {
    const hoy = diaMadrid(ahora());
    if (hoy !== dia) {
      dia = hoy;
      gastado = 0;
      preguntas.clear();
    }
  };
  // Del visitante solo se guarda un hash corto, solo en memoria y solo durante el día: no es un dato que salga de la función.
  const clave = (ip: string) => createHash("sha256").update(`${dia}|${ip}`).digest("hex").slice(0, 16);

  return {
    comprobar(topeUsd) {
      alDia();
      if (topeUsd <= 0 || gastado + reservado >= topeUsd) throw new ErrorPresupuesto(gastado + reservado, topeUsd);
    },
    reservar(topeUsd, estimadoUsd = RESERVA_POR_LLAMADA_USD) {
      alDia();
      if (topeUsd <= 0 || gastado + reservado >= topeUsd) throw new ErrorPresupuesto(gastado + reservado, topeUsd);
      reservado += estimadoUsd;
      let suelta = false;
      return () => {
        if (suelta) return;
        suelta = true;
        const queda = reservado - estimadoUsd;
        reservado = queda < 1e-9 ? 0 : queda; // sin restos de coma flotante (1e-17) cuando no queda nada en vuelo
      };
    },
    reservadoUsd() {
      return reservado;
    },
    anotar(uso) {
      alDia();
      gastado += uso.costeUsd;
    },
    gastadoHoyUsd() {
      alDia();
      return gastado;
    },
    consumirPregunta(ip, limite) {
      alDia();
      const k = clave(ip);
      const usadas = preguntas.get(k) ?? 0;
      if (usadas >= limite) return null;
      // Protección de memoria: al llegar al máximo se expulsa solo al visitante más antiguo (el primero del Map), no a todos (T4-12).
      if (!preguntas.has(k) && preguntas.size >= MAX_VISITANTES) preguntas.delete(preguntas.keys().next().value as string);
      // Se reinserta para que el orden sea «último en preguntar»: los que siguen activos no son los primeros en salir.
      preguntas.delete(k);
      preguntas.set(k, usadas + 1);
      return { restantes: limite - usadas - 1 };
    },
    devolverPregunta(ip) {
      const k = clave(ip);
      const usadas = preguntas.get(k);
      if (usadas) preguntas.set(k, usadas - 1); // el valor cambia, la posición en el Map no
    },
  };
}
