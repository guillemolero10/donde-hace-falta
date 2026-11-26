import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { MAX_CARACTERES_PREGUNTA, PREGUNTAS_SUGERIDAS } from "../lib/donde/intencion";
import { textoRestantes } from "../lib/donde/clienteAgente";
import { ETIQUETA_PASO, type Agente, type MensajeUI } from "../lib/useAgente";
import { IconoCerrar } from "./Iconos";
import "./PanelAgente.css";

interface Props {
  agente: Agente;
  abierto: boolean;
  onAbrir: () => void;
  onCerrar: () => void;
}

function Pasos({ m }: { m: MensajeUI }) {
  if (!m.pasos || m.pasos.length === 0) return null;
  const nombres = [...new Set(m.pasos.map((p) => ETIQUETA_PASO[p.herramienta] ?? p.herramienta))];
  return (
    <details className="agente__pasos">
      <summary>He consultado: {nombres.join(", ").toLowerCase()}</summary>
      <ol>
        {m.pasos.map((p, i) => (
          <li key={i}>
            <strong>{ETIQUETA_PASO[p.herramienta] ?? p.herramienta}.</strong> {p.resumen}
          </li>
        ))}
      </ol>
    </details>
  );
}

function Mensaje({ m }: { m: MensajeUI }) {
  if (m.rol === "usuario") {
    return (
      <li className="agente__msg agente__msg--usuario">
        <span className="agente__quien">Tú</span>
        <p>{m.texto}</p>
      </li>
    );
  }
  return (
    <li className="agente__msg agente__msg--agente">
      <span className="agente__quien">
        Agente
        {/* 26-nov: «IA» si la IA interpretó la pregunta (también si el validador cambió el texto por el calculado). En el respaldo
            sin IA no se pone etiqueta ni aviso: no se dice «IA» cuando no lo es, pero tampoco se avisa (decisión de Guillermo). */}
        {m.modo === "ia" || m.revisada ? <span className="agente__modo agente__modo--ia">IA</span> : null}
      </span>
      <p>{m.texto}</p>
      <Pasos m={m} />
      {m.noAplicadas ? <p className="agente__nota agente__nota--aviso">No he podido aplicar {m.noAplicadas === 1 ? "un cambio" : `${m.noAplicadas} cambios`} en el mapa.</p> : null}
    </li>
  );
}

/** Panel plegable del agente: preguntas en lenguaje natural que mueven el mapa. Va dentro del mapa, arriba a la derecha (en móvil, abajo). */
export function PanelAgente({ agente, abierto, onAbrir, onCerrar }: Props) {
  const idTitulo = useId();
  const idEntrada = useId();
  const idAyuda = useId();
  const [texto, setTexto] = useState("");
  const entrada = useRef<HTMLInputElement>(null);
  const botonAbrir = useRef<HTMLButtonElement>(null);
  const lista = useRef<HTMLOListElement>(null);
  const eraAbierto = useRef(abierto);
  const ocupado = agente.fase !== "libre";

  // Al abrir, el foco va a la pregunta; al cerrar, vuelve al botón.
  useEffect(() => {
    if (abierto) entrada.current?.focus();
    else if (eraAbierto.current) botonAbrir.current?.focus();
    eraAbierto.current = abierto;
  }, [abierto]);

  // La conversación se desplaza hasta lo último.
  useEffect(() => {
    const l = lista.current;
    if (l) l.scrollTop = l.scrollHeight;
  }, [agente.mensajes.length, agente.fase]);

  const enviar = (t: string) => {
    if (!t.trim() || ocupado || !agente.listo) return;
    setTexto("");
    void agente.preguntar(t);
  };
  const alEnviar = (e: FormEvent) => {
    e.preventDefault();
    enviar(texto);
  };
  const alPulsar = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") onCerrar();
  };

  if (!abierto) {
    return (
      <button ref={botonAbrir} type="button" className="agente-abrir" aria-label="Pregúntale al agente" aria-expanded="false" aria-controls={idTitulo + "-panel"} onClick={onAbrir}>
        <span className="agente-abrir__marca" aria-hidden="true">?</span>
        <span className="agente-abrir__texto">Pregúntale al agente</span>
        <span className="agente-abrir__corto" aria-hidden="true">Agente</span>
      </button>
    );
  }

  return (
    <section id={idTitulo + "-panel"} className={`agente tarjeta${agente.mensajes.length ? " agente--conversando" : ""}`} aria-labelledby={idTitulo} onKeyDown={alPulsar} data-agente="abierto">
      <header className="agente__cabecera">
        <div>
          <h2 id={idTitulo} className="agente__titulo">
            Pregúntale al agente
          </h2>
          <p className="agente__sub">
            {agente.modo === "ia" ? (
              <>
                Responde con IA{agente.restantes !== null ? ` · ${textoRestantes(agente.restantes)}` : ""}
              </>
            ) : agente.modo === "reglas" ? (
              "Responde con los mismos datos que el mapa"
            ) : (
              "Responde con IA, con los mismos datos que el mapa."
            )}
          </p>
        </div>
        <div className="agente__cabecera-botones">
          {agente.mensajes.length > 0 && (
            <button type="button" className="boton boton--texto" onClick={() => {
                agente.nuevaConversacion();
                setTexto("");
                entrada.current?.focus(); // el botón desaparece al vaciarse la conversación: el foco va a la pregunta
              }}
              disabled={ocupado}
            >
              Empezar de nuevo
            </button>
          )}
          <button type="button" className="boton boton--icono agente__cerrar" onClick={onCerrar} aria-label="Cerrar el agente">
            <IconoCerrar tam={16} />
          </button>
        </div>
      </header>

      <ol ref={lista} className="agente__lista" role="log" aria-label="Conversación con el agente" aria-live="polite" aria-relevant="additions">
        {agente.mensajes.length === 0 && (
          <li className="agente__vacio">
            Pregunta dónde pondrías un servicio, dónde ayudaría más un centro nuevo o qué servicios tiene un pueblo. El agente calcula, mueve el mapa y pinta el resultado.
          </li>
        )}
        {agente.mensajes.map((m) => (
          <Mensaje key={m.id} m={m} />
        ))}
      </ol>

      <div className="agente__estado" role="status" aria-live="polite">
        {ocupado && agente.estado && (
          <>
            <span className="giro" aria-hidden="true" />
            {agente.estado}
          </>
        )}
      </div>

      <div className="agente__sugeridas" role="group" aria-label="Preguntas sugeridas">
        {PREGUNTAS_SUGERIDAS.map((p) => (
          <button key={p} type="button" className="agente__chip" disabled={ocupado || !agente.listo} onClick={() => enviar(p)}>
            {p}
          </button>
        ))}
      </div>

      <form className="agente__form" onSubmit={alEnviar}>
        <label htmlFor={idEntrada} className="agente__etiqueta">
          Tu pregunta
        </label>
        <div className="agente__fila">
          <input
            ref={entrada}
            id={idEntrada}
            type="text"
            className="agente__entrada"
            value={texto}
            maxLength={MAX_CARACTERES_PREGUNTA}
            autoComplete="off"
            placeholder={agente.listo ? "Por ejemplo: ¿dónde pondrías una farmacia en el norte?" : "Cargando los datos…"}
            aria-describedby={idAyuda}
            disabled={!agente.listo}
            onChange={(e) => setTexto(e.target.value)}
          />
          <button type="submit" className="boton boton--primario" disabled={ocupado || !agente.listo || !texto.trim()}>
            Preguntar
          </button>
        </div>
        <p id={idAyuda} className="agente__ayuda">
          Las cifras salen siempre del cálculo, nunca las inventa el agente. Con IA, tu pregunta se envía a Meta: no escribas datos personales.
        </p>
      </form>
    </section>
  );
}
