# ¿Dónde hace falta?

**Qué cobertura tienen los servicios públicos de la Comunidad de Madrid y dónde un centro nuevo ayudaría más.** Proyecto para el datathon DATAMAD 2026.

Cruza los registros oficiales de centros de la Comunidad de Madrid con la población por edad de cada una de sus 4.518 secciones censales (INE, censo de 2025) para medir qué vecinos tienen cerca un centro de salud, un hospital, una farmacia, un colegio o instituto o un desfibrilador, y qué zonas tienen pocas plazas de residencia para mayores.

![Simulador: residencia de mayores en Pinto](docs/capturas/donde-hace-falta-simulador.png)

**▶ Vídeo de la demo (2 min, sin voz, con rótulos):** [donde-hace-falta.vercel.app/demo.mp4](https://donde-hace-falta.vercel.app/demo.mp4) (se ve en el navegador; copia en [presentacion/demo-donde-hace-falta.mp4](presentacion/demo-donde-hace-falta.mp4)). Grabado sobre la web publicada, con preguntas reales al agente de IA; la espera de sus respuestas va acelerada.

## Qué hace

**1. ¿Dónde hace falta?** (vista de quien decide)
- Eliges un servicio y un radio (según el servicio, de 300 m a 25 km) y el mapa pinta cada sección censal según lo cerca que queda ese servicio (o cuántas plazas hay), con un ranking de dónde más ayudaría un centro nuevo por municipio, distrito o zona.
- **Tú decides:** colocas un centro nuevo en el mapa (arrastrándolo, con el dedo o con el teclado) y ves al momento cuántos vecinos ganan acceso o, en residencias, cuántas plazas más se cubren.
- **El modelo:** calcula la mejor ubicación (algoritmo voraz de máxima cobertura) y compara tu propuesta con ella («logra el 68 % del óptimo»).
- **Madrid en 2030:** repite el cálculo con la población proyectada para 2030 (proyección oficial INE/Comunidad repartida por sección y validada con los años 2021-2025).
- **Agente:** preguntas en lenguaje natural («¿dónde pondrías una residencia en el sur?»). El agente usa las mismas herramientas de cálculo, mueve el mapa y explica el resultado; cada cifra del texto sale de esas herramientas. Con IA (Muse Spark, de Meta, a través de su API) entiende preguntas libres; **sin clave, sin conexión o con el tope de gasto agotado responde por reglas** (interpreta la pregunta en el navegador, con las mismas herramientas). Cómo activarlo: [docs/I2-agente.md](docs/I2-agente.md).

**2. Mi municipio** (vista del ciudadano)
- Buscas tu municipio o distrito y ves qué servicios tiene, cómo está frente a la media de la Comunidad, dónde un centro nuevo le ayudaría más y cómo está el aire hoy (red de estaciones de la Comunidad, actualizada varias veces al día).

| Madrid en 2030 | Mi municipio | Agente |
|---|---|---|
| ![2030](docs/capturas/donde-hace-falta-2030.png) | ![Mi municipio](docs/capturas/donde-hace-falta-municipio.png) | ![Agente](docs/capturas/donde-hace-falta-agente.png) |

## Cómo reproducirlo

Requiere [uv](https://docs.astral.sh/uv/) (Python) y Node 20 o superior.

**Datos** (`public/donde/`):
```
uv run --project pipeline python -m donde.construir --salida public/donde
uv run --project pipeline pytest
```
La primera vez descarga unos 220 MB a `salida/cache/` (fuera de git): el censo del INE (148 MB), el seccionado censal del INE (60 MB) y los CSV del portal de la Comunidad. Dos ejecuciones dan exactamente los mismos ficheros. Los intermedios y el informe quedan en `salida/donde/`.

**Web**:
```
npm install
npm run dev      # http://localhost:5173
npm test         # pruebas (Vitest)
npm run build    # tipos, empaqueta la función api/agente.js y build de producción en dist/
```
Sin clave en `.env.local`, `npm run dev` no sirve `/api` y el agente responde en modo sin IA. Para probar el agente con IA en local, ver [docs/I2-agente.md](docs/I2-agente.md).

La web es estática (Vite + React + TypeScript + MapLibre GL JS): todo el cálculo se hace en el navegador, con el mismo motor que se comprueba contra una implementación independiente en Python (`pipeline/donde/referencia.py`). El aire de hoy se lee de la rama `datos` de este repositorio, que actualiza el workflow `.github/workflows/datos.yml` (`uv run --project pipeline python -m alergia.ejecutar --salida datos`; programado cada hora y ejecutable a mano). Vite no arranca si la ruta de la carpeta contiene `?` o `#`.

Detalle de fuentes, decisiones y comprobaciones: [DATOS-DONDE.md](DATOS-DONDE.md) (servicios, población, 2030) y [DATOS.md](DATOS.md) (aire). Plan técnico: [PLAN-DONDE-HACE-FALTA.md](PLAN-DONDE-HACE-FALTA.md).

## Fuentes de datos

**Portal de datos abiertos de la Comunidad de Madrid** ([datos.comunidad.madrid](https://datos.comunidad.madrid/catalogo/)), licencia CC BY 4.0, fuente «Comunidad de Madrid»:
- [Centros, servicios y establecimientos sanitarios](https://datos.comunidad.madrid/catalogo/dataset/centros_servicios_establecimientos_sanitarios): centros de salud, consultorios y hospitales.
- [Registro de centros de atención social](https://datos.comunidad.madrid/catalogo/dataset/atencion_social_registro_centros): residencias de mayores y otros servicios sociales.
- [Oficinas de farmacia](https://datos.comunidad.madrid/catalogo/dataset/oficinas_farmacia).
- [Desfibriladores externos fuera del ámbito sanitario](https://datos.comunidad.madrid/catalogo/dataset/desfibriladores_externos_fuera_ambito_sanitario).
- [Centros educativos](https://datos.comunidad.madrid/catalogo/dataset/centros_educativos).
- [Municipios de la Comunidad de Madrid](https://datos.comunidad.madrid/catalogo/dataset/municipio_comunidad_madrid).
- [Proyecciones de población por sexo](https://datos.comunidad.madrid/catalogo/dataset/proyecciones_poblacion_por_sexo) (origen: INE, Proyecciones de Población 2026-2076).
- [Calidad del aire: datos diarios horarios](https://datos.comunidad.madrid/catalogo/dataset/calidad_aire_datos_dia) y [estaciones](https://datos.comunidad.madrid/catalogo/dataset/calidad_aire_estaciones).

**Otras fuentes**:
- INE, licencia CC BY 4.0, «Fuente: INE»: [Censo anual de población por sección censal, tabla 69213](https://www.ine.es/jaxiT3/Tabla.htm?t=69213) y [seccionado censal 2025](https://www.ine.es/prodyser/cartografia/seccionado_2025.zip).
- IGN: nombres y punto de cada municipio. *Obra derivada de Núcleos de población y Unidades administrativas (IGN-INE, 2025) CC-BY 4.0 [ign.es](https://www.ign.es).*
- IMSERSO: [Servicios Sociales dirigidos a las personas mayores en España, 2024](https://imserso.es/documents/20123/10902543/inf_ssppmmesp2024.pdf/1432577e-5e36-5d7c-83d1-24864192dc99) (plazas de referencia por cada 100 mayores).
- [Decreto 78/2017 de la Comunidad de Madrid](https://www.bocm.es/boletin/CM_Orden_BOCM/2017/09/14/BOCM-20170914-1.PDF) (desfibriladores).
- [Open-Meteo](https://open-meteo.com) (CC BY 4.0): viento y previsión del aire (CAMS Europa). *Generated using Copernicus Atmosphere Monitoring Service information 2026.*
- Mapa base: [OpenFreeMap](https://openfreemap.org), © [OpenMapTiles](https://openmaptiles.org), datos © [colaboradores de OpenStreetMap](https://www.openstreetmap.org/copyright) (ODbL). Visor: [MapLibre GL JS](https://maplibre.org) (BSD-3).

## Límites (declarados también en la web)
- Las distancias son en línea recta, no por carretera ni en transporte público.
- La unidad es la sección censal, representada por un punto interior.
- La población de 3 a 16 años se estima a partir de tramos de 5 años.
- 18 residencias (4,7 % de las plazas) no tienen coordenadas en la fuente y no cuentan. Se usan las plazas autorizadas, no las libres.
- Los hospitales son solo los generales; los centros sanitarios no traen nombre propio en la fuente y se nombran por su dirección.
- Los centros de día no se cuentan como plazas de residencia (el registro mezcla centros de día con hogares y clubes de mayores).
- Los centros sociales sensibles (acogida, mujeres, menores, pisos tutelados…) se publican sin nombre y en el punto de su sección censal, no en su dirección.
- 3.135 desfibriladores registrados en solo 6 direcciones (equipos móviles dados de alta en una sede) se agrupan en un punto por dirección: 13.680 equipos en 10.551 puntos.
- 2030 es una proyección: en la validación 2021-2025 el error medio ponderado por población fue del 1,3 % en mayores de 65 y del 1,8 % en mayores de 75 (en un municipio típico, 3,3 % y 5,5 %); no tiene en cuenta la vivienda nueva.
- El aire de los distritos de Madrid capital se toma de la estación de la Comunidad más cercana a su centro (Leganés, Coslada, Pozuelo, Alcobendas, Getafe, Rivas o Las Rozas), porque la red de la capital es del Ayuntamiento; Madrid entera usa la de Pozuelo.

## Código reutilizado
`pipeline/alergia/ckan.py` se inspira en `MCP/servidor.py` de Alberto Abella ([github.com/albertoabellagarcia/DATAMAD2026](https://github.com/albertoabellagarcia/DATAMAD2026), material de la formación DATAMAD 2026). Se ha reescrito, sin copiar código.

## Uso de IA
El desarrollo se ha hecho con ayuda de asistentes de IA (permitido por las bases).

**En la aplicación**, el agente de «¿Dónde hace falta?» usa [Muse Spark](https://dev.meta.ai) (`muse-spark-1.3`) a través de la API de Meta, compatible con OpenAI; con `AGENTE_PROVEEDOR=baseten` usa Muse Spark Open (pesos abiertos) en Baseten. El modelo solo puede llamar a 5 herramientas de cálculo del propio proyecto; cada cifra del texto se valida contra sus resultados y, si no coincide, se responde con una plantilla. Sin clave, el agente funciona en modo sin IA (reglas). Código en `servidor/` (función `api/agente.js`, generada con `npm run build:api`).

**Código reutilizado (propio):** `servidor/proveedor.ts` (cliente del modelo: clave solo por variable de entorno, `reasoning_effort` bajo, reintentos, coste por llamada) y `servidor/presupuesto.ts` (tope de gasto diario) están adaptados del proyecto DockClerk de Guillermo Molero Jiménez (`apps/meta-hackathon/dockclerk/src/lib/ai/`), escrito para el Meta Hackathon.

## Licencias
- Código: MIT ([LICENSE](LICENSE)).
- `public/donde/`, `datos-estaticos/` y `pipeline/tests/datos/` son datos derivados de las fuentes anteriores: CC BY 4.0, con su atribución. Los ficheros de prueba de `pipeline/tests/datos/` llevan valores ficticios en las columnas personales.

## Dirección pública y vista previa del enlace

`index.html` lleva las etiquetas Open Graph y de Twitter (`og:image` apunta a `public/og.jpg`, 1200×630). La dirección absoluta sale de la variable `VITE_URL_PUBLICA` (en `.env.local` o en las variables de entorno de Vercel, sin barra final); si no existe, se usa `https://donde-hace-falta.vercel.app` (constante `URL_PUBLICA_POR_DEFECTO` en `vite.config.ts`). Al saber la URL definitiva: poner `VITE_URL_PUBLICA=https://…` y volver a construir.
