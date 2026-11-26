// Estado del panel del agente: la conversación, la llamada a `/api/agente` (con respaldo en el navegador) y la ejecución de
// las acciones sobre el mapa y el panel. El historial se pasa como contexto (hasta 12 mensajes de 500 caracteres).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { describirAccion, ejecutarAcciones, filasDeRanking, type Destino } from "./donde/accionesAgente";
import { crearClienteAgente, mensajesParaEnviar, type ResultadoPregunta } from "./donde/clienteAgente";
import { crearEntorno } from "./donde/herramientas";
import { MAX_CARACTERES_PREGUNTA, responderSinIA } from "./donde/intencion";
import { opcionesEstado } from "./donde/tuDecides";
import type { Accion, Datos, PasoAgente, PeticionAgente } from "./donde/tipos";
import { cargarCentros, type Donde } from "./useDonde";
import type { Vista } from "./vista";

export type FaseAgente = "libre" | "pensando" | "aplicando";

export interface MensajeUI {
  id: number;
  rol: "usuario" | "asistente";
  texto: string;
  /** Solo en las respuestas: quién las ha calculado. */
  modo?: "ia" | "reglas";
  /** Por qué se respondió sin IA (si es el caso). */
  aviso?: string | null;
  /** El servidor descartó el texto del modelo por seguridad y respondió con el cálculo (`motivo: "revisada"`). */
  revisada?: boolean;
  pasos?: PasoAgente[];
  /** Filas del ranking que el servidor (o el modo sin IA) ha calculado; la IA no las escribe. */
  ranking?: Extract<Accion, { tipo: "mostrar_ranking" }> | null;
  /** Acciones que no se han podido aplicar en pantalla. */
  noAplicadas?: number;
}

export interface Agente {
  mensajes: MensajeUI[];
  fase: FaseAgente;
  /** Lo que está haciendo ahora, para enseñarlo («Calculando…», «Moviendo el mapa…»). */
  estado: string | null;
  /** Modo de la última respuesta, o null si aún no ha respondido. */
  modo: "ia" | "reglas" | null;
  /** Preguntas con IA que quedan hoy, si el servidor lo dice. */
  restantes: number | null;
  /** Hay datos para responder (la base está cargada). */
  listo: boolean;
  preguntar: (texto: string) => Promise<void>;
  nuevaConversacion: () => void;
}

interface Opciones {
  donde: Donde;
  vista: Vista;
  destino: Destino;
  /** Municipio o distrito de la ficha abierta (`mun:…`, `dis:…`), o null. Solo se envía al agente en «Mi municipio». */
  lugar?: string | null;
  /** Alias por id de municipio (`lugares.json`): «Fuenla», «Sanse»… */
  alias?: Record<string, string[]>;
}

/** Nombre del paso que se enseña en la lista «He consultado…». */
export const ETIQUETA_PASO: Record<string, string> = {
  ranking_deficit: "Ranking de déficit",
  ubicacion_optima: "Ubicación óptima",
  simular_centro: "Simulación de un centro",
  ficha_municipio: "Ficha del municipio",
  mover_mapa: "Mover el mapa",
};

/** Lo que se cuenta mientras se espera la respuesta. */
export const ESTADO_PENSANDO = "Consultando al agente y calculando…";

export function useAgente({ donde, vista, destino, lugar = null, alias }: Opciones): Agente {
  const [mensajes, setMensajes] = useState<MensajeUI[]>([]);
  const [fase, setFase] = useState<FaseAgente>("libre");
  const [estado, setEstado] = useState<string | null>(null);
  const [modo, setModo] = useState<"ia" | "reglas" | null>(null);
  const [restantes, setRestantes] = useState<number | null>(null);

  const siguienteId = useRef(1);
  const mensajesRef = useRef(mensajes);
  mensajesRef.current = mensajes;
  /** Se actualiza a mano (no en cada render) para que dos envíos seguidos no se crucen. */
  const faseRef = useRef<FaseAgente>("libre");
  const vivo = useRef({ donde, vista, destino, lugar, alias });
  vivo.current = { donde, vista, destino, lugar, alias };
  const montado = useRef(true);
  const control = useRef<AbortController | null>(null);

  useEffect(() => {
    montado.current = true;
    return () => {
      montado.current = false;
      control.current?.abort();
    };
  }, []);

  // Los datos para el modo sin IA: los mismos que ya tiene la pantalla. Los centros de cada servicio salen de su caché.
  // Con 2030 elegido en el simulador, el agente responde con 2030 (y lo dice); en «Mi municipio», que siempre es de hoy, con hoy.
  // La ficha es de hoy: lo calcula `ficha_municipio` con `datosHoy`. El resto de respuestas siguen el año del simulador, también desde «Mi municipio»,
  // para que el agente no cambie el año por su cuenta.
  const baseAgente = donde.base;
  const datos = useMemo<Datos | null>(
    () => (baseAgente.fase === "listo" ? { secciones: baseAgente.valor.secciones, territorios: baseAgente.valor.territorios, servicios: {} } : null),
    [baseAgente],
  );
  const datosHoy = useMemo<Datos | null>(
    () => (donde.baseHoy.fase === "listo" ? { secciones: donde.baseHoy.valor.secciones, territorios: donde.baseHoy.valor.territorios, servicios: {} } : null),
    [donde.baseHoy],
  );
  const datosHoyRef = useRef(datosHoy);
  datosHoyRef.current = datosHoy;
  const seccionesHoy = donde.baseHoy.fase === "listo" ? donde.baseHoy.valor.secciones : null;
  const seccionesHoyRef = useRef(seccionesHoy);
  seccionesHoyRef.current = seccionesHoy;
  const datosRef = useRef(datos);
  datosRef.current = datos;

  const cliente = useMemo(
    () =>
      crearClienteAgente({
        local: async (peticion) => {
          const d = datosRef.current;
          if (!d) throw new Error("los datos todavía no se han cargado");
          // El mismo umbral que ve el usuario en el panel, para que el agente y la pantalla den la misma cifra.
          const { umbral } = opcionesEstado(vivo.current.donde.est);
          const alias = vivo.current.alias;
          const entorno = crearEntorno(d, {
            cargarServicio: cargarCentros,
            contexto: peticion.contexto,
            ...(umbral === undefined ? {} : { referencia: umbral }),
            // Con 2030, la referencia de residencias es la de hoy.
            ...(seccionesHoyRef.current ? { seccionesHoy: seccionesHoyRef.current } : {}),
            ...(datosHoyRef.current ? { datosHoy: datosHoyRef.current } : {}),
            ...(alias ? { aliasLugares: alias } : {}),
          });
          return responderSinIA(peticion, entorno);
        },
      }),
    [],
  );

  const preguntar = useCallback(
    async (textoCrudo: string) => {
      const texto = textoCrudo.trim().slice(0, MAX_CARACTERES_PREGUNTA);
      if (!texto || faseRef.current !== "libre") return;
      faseRef.current = "pensando";
      const { donde: d, vista: v, lugar: l } = vivo.current;

      const usuario: MensajeUI = { id: siguienteId.current++, rol: "usuario", texto };
      const previos = mensajesRef.current;
      setMensajes([...previos, usuario]);
      setFase("pensando");
      setEstado(ESTADO_PENSANDO);

      const peticion: PeticionAgente = {
        mensajes: mensajesParaEnviar([...previos, usuario]),
        contexto: {
          vista: v === "municipio" ? "municipio" : "donde",
          servicio: d.est.servicio,
          radio_m: d.est.radio_m,
          lugar: v === "municipio" ? l : null,
          anio: d.est.anio,
          referencia: d.est.referencia,
          zona: d.est.zona,
        },
      };

      control.current?.abort();
      const cancelar = new AbortController();
      control.current = cancelar;
      let resultado: ResultadoPregunta;
      try {
        resultado = await cliente.preguntar(peticion, cancelar.signal);
      } catch {
        if (!montado.current) return;
        // Solo ocurre si se ha cancelado la petición.
        faseRef.current = "libre";
        setFase("libre");
        setEstado(null);
        return;
      }
      if (!montado.current) return;

      const { respuesta, aviso } = resultado;
      const ranking = filasDeRanking(respuesta.acciones);
      const asistente: MensajeUI = {
        id: siguienteId.current++,
        rol: "asistente",
        texto: respuesta.texto,
        modo: respuesta.modo,
        aviso,
        ...(respuesta.motivo === "revisada" ? { revisada: true } : {}),
        pasos: respuesta.pasos,
        ranking,
      };
      setMensajes((m) => [...m, asistente]);
      // Respuesta «revisada»: la IA interpretó la pregunta y el servidor dio el texto calculado; cuenta como IA en la cabecera.
      const conIA = respuesta.modo === "ia" || respuesta.motivo === "revisada";
      setModo(conIA ? "ia" : "reglas");
      if (conIA) setRestantes(respuesta.restantes);
      else setRestantes(null);

      // El texto ya se ve; ahora se aplica en el mapa y en el panel.
      let noAplicadas = 0;
      if (respuesta.acciones.length) {
        setFase("aplicando");
        faseRef.current = "aplicando";
        const resultados = await ejecutarAcciones(respuesta.acciones, vivo.current.destino, (a) => {
          if (montado.current) setEstado(describirAccion(a));
        });
        noAplicadas = resultados.filter((r) => !r.ok).length;
        if (!montado.current) return;
        if (noAplicadas) setMensajes((m) => m.map((x) => (x.id === asistente.id ? { ...x, noAplicadas } : x)));
      }
      setFase("libre");
      faseRef.current = "libre";
      setEstado(null);
    },
    [cliente],
  );

  const nuevaConversacion = useCallback(() => {
    if (faseRef.current !== "libre") return;
    setMensajes([]);
    setModo(null);
    setRestantes(null);
    cliente.olvidarFallos();
  }, [cliente]);

  return { mensajes, fase, estado, modo, restantes, listo: datos !== null, preguntar, nuevaConversacion };
}
