# En curso: etapa 3 (textos SEO) — dónde lo dejamos

> Escrito el 22 de agosto de 2026 al cerrar la sesión. Versión del plugin: ver
> `dsh-plugin/package.json`. Todo lo de aquí sale de medir ejecuciones reales, no de estimaciones.

## 1. El experimento abierto: `off` contra `high`

**Es lo único pendiente de decidir, y se cierra solo con la próxima carga normal.**

`description.reasoningEffort` está en **`off`**. La razón es que ya hay tres medidas de `high` y
ninguna de `off`, y hacen falta las dos para elegir:

| Esfuerzo | Segundos por llamada al modelo | Media |
|---|---|---|
| `low` | 21,4 · 27,0 · 32,4 | **26,9 s** |
| `high` | 54,9 · 33,9 · 84,9 | **57,9 s** |
| `off` | — | **lo que mida la próxima carga** |

### Qué mirar cuando salga

En el resumen de `catalog_describe`:

| Número | Qué decide |
|---|---|
| `segundosPorLlamada` | Si `off` baja de los 57,9 s de `high`. Es latencia del proveedor: no baja paralelizando |
| `intentosMedios` | Si sube por encima de ~1,3, `off` está costando reintentos y cada uno es una llamada entera |
| `rechazos` | **La clave.** Si suben `entradaLarga`, `largo:seoTitle` o `bulletLargo`, es que sin razonamiento el modelo cuenta peor los caracteres |
| `razonamientoMaximo` | Con `off` debe ser 0. Si no lo es, `off` no está llegando al proveedor |
| Las fichas, con `catalog_seo` | Si la prosa sale plana. Esto no lo dice ningún número |

### La decisión

- `off` más rápido **y** sin subir rechazos → se queda en `off`.
- `off` sube los rechazos de longitud → volver a `high` (una línea en `catalog.config.yml`).
- Caso intermedio (más rápido pero con algún rechazo más): gana el que dé menos **tiempo total**,
  porque un reintento cuesta una llamada entera. `segundos` del resumen ya lo dice.

Ninguna ficha se publica sin pasar por `catalog_review`, así que el experimento no puede llegar a la
tienda.

## 2. Estado del pipeline

| Etapa | Estado |
|---|---|
| 1. Ingesta del fichero | ✅ `catalog_load` |
| 2. Normalización | ✅ `catalog_load` |
| 3. Textos SEO | ✅ `catalog_describe` + `catalog_seo` + `catalog_review` |
| 4. Imagen | ⛔ pendiente, sin empezar |
| 5. Publicación en Shopify | ⛔ pendiente, sin empezar |

80 tests con `node --test`, sin claves ni red. El fichero real da 793 productos de 800 filas, con 7
rechazos (los `#N/A` de precio).

## 3. Cinco diagnósticos de sesiones reales

Cada uno salió de un `.jsonl` de sesión. Están aquí para no volver a diagnosticarlos.

### 3.1 Ocho borradores en blanco (`session-with-failures`)

`maxTokens: 1500` cableado en el código contra una sesión con `reasoningEffort: high`. El modelo se
gastaba el presupuesto de salida razonando y no escribía nada. **El razonamiento consume del mismo
`maxTokens` que el texto**: un tope calculado solo para el texto deja al modelo sin sitio.

Arreglado subiendo el tope y sacándolo a configuración. Se pasó de 7 fallos sobre ~13 llamadas a
1 sobre 9, y luego 1 sobre 14. **No ha desaparecido del todo**: si `sinTexto` reaparece, mirar
`razonamientoMaximo` contra `maxTokens` × 3 y subir el tope.

### 3.2 Cuatro productos en cinco minutos (`session-4productos-5minutos`)

El bucle era secuencial. Ahora va en paralelo (`description.concurrency`, 4), con el primer producto
solo como sonda de configuración, saltable con `probeFirst: auto` cuando ya hay una ficha escrita por
ese mismo modelo. Medido: 204 s → 97 s → ~32 s.

**El paralelismo introdujo un riesgo**: los productos de un trozo se redactan contra la misma foto de
lo ya usado, así que dos pueden elegir el mismo `handle`. Se comprueba **al aceptar**, en orden, y
quien llega segundo repite. Tiene test propio.

### 3.3 `reasoningEffort: low` no es fiable (`session-CONFIG`)

`dsh` declara todas sus dependencias con rangos (`^0.1.0-rc.6`), así que npm resuelve
`dsh-llm-deepseek` a lo más nuevo que encaje **el día que se instala**. En dos cachés de npx de esta
misma máquina salieron rc.6 y rc.8, y aceptan esfuerzos distintos:

```
siempre:     off, high, max
desde rc.8:  + low
```

Con `low` en la configuración, la carga funciona o revienta con `UNSUPPORTED_REASONING_EFFORT` según
lo que tocara. **No se arregla pinando**: `dsh-tools@rc.6` pide `dsh-session@^0.1.0-rc.6`, npm lo
sube a rc.8 y ese exige `dsh-llm@^0.1.0-rc.8`. No hay árbol coherente en rc.6.

Dos redes: `./dsh.sh` comprueba qué acepta el adaptador resuelto y **para el despliegue** si la
configuración pide otro; y si el proveedor lo rechaza en caliente, el error dice de dónde sale el
valor y cuáles valen.

### 3.4 `entradaSinTipo` con tipos genéricos (`sessionTestAB-2`)

La regla «la primera frase dice qué es el producto» exigía que el párrafo nombrase el `productType`.
Pero el ERP traduce el grupo `OTROS` a `productType: "Otros"`, y *«Romate Seco Oloroso es un
otros…»* no lo escribe nadie. Los 2 productos `Otros` del fichero de muestra pagaban un reintento
garantizado — y cuando pasaban era por accidente, porque «otros» cabe como subcadena dentro de «otros
vinos».

Confirmación exacta: 11 productos, 2 con `productType: "Otros"`, 2 rechazos `entradaSinTipo`.

Arreglado: ahora vale el tipo, su palabra principal **o la categoría** (`VINO` → «vino»), que es lo
que un redactor escribiría igual.

### 3.5 Lo que el log de sesión NO trae

**Las llamadas internas del plugin (`ctx.llm.stream`) no aparecen en el `session.jsonl`.** Todos los
`usage` de esos ficheros son de los turnos del agente. Por eso el resumen de `catalog_describe`
instrumenta el tiempo por su cuenta (`segundos`, `segundosPorLlamada`, `razonamientoMaximo`): sin eso
no hay forma de saber cuánto tarda la etapa 3.

## 4. Trampas de operación

Cosas que costaron tiempo y no volverán a costarlo si se recuerdan:

- **`./dsh.sh -n` no reinicia dsh.** Dos sesiones corrieron con código viejo y aparecieron bugs ya
  arreglados. Para que el plugin nuevo entre: `./dsh.sh` (sin `-n`) **y sesión nueva** en el
  navegador. Una sesión ya abierta se queda con el código y el preset que tenía al crearse.
- **`npx` pregunta `Ok to proceed?`** cuando el paquete no está en caché, y dentro de un script eso
  es un bloqueo silencioso. Por eso `dsh.sh` usa `npx --yes`.
- **La versión va en cuatro sitios** (`package.json` + lock, `preset.yml`, la persona, `CHANGELOG`).
  `./dsh.sh` para el despliegue si no cuadran, porque dsh lee el preset desplegado y no el repo.
- **dsh no admite adjuntar un CSV al chat** (su capa de adjuntos es solo de imágenes). Para cargar
  un fichero hay que dejarlo en una carpeta de `source.dirs` y pedirlo por su nombre.
- **El plugin no puede saber el directorio de la sesión de dsh.** No lo expone ningún paquete del
  harness. Las carpetas de cliente hay que declararlas en `source.dirs` (admite `~`).

## 5. Decisiones tomadas, para no rediscutirlas

| Decisión | Por qué |
|---|---|
| El JSON se escribe a disco y el tool devuelve un resumen | 793 productos son 481 KB; el podador del preset corta a 8192 caracteres |
| Filas sucias: excluir y reportar aparte | La ingesta no decide qué se publica; eso es de la etapa 5 |
| Solo config declarativa para el mapeo de columnas | Cliente nuevo = `.yml` nuevo, cero código |
| Los seis campos SEO, no solo la descripción | El punto 4 del artículo de Shopify los nombra como los de mayor impacto |
| Bloques `### campo` en vez de JSON | La API no expone modo JSON, y el HTML dentro de una cadena era la parte frágil: un corte tiraba la ficha entera |
| Las fichas nacen `reviewed: false` | El punto 7 del artículo y la política de contenido generado de Google |
| Alcance obligatorio en `catalog_describe` | Cada producto es una llamada y hay 793 |
| El primero del lote va solo (sonda) | Un fallo de configuración cuesta 3 llamadas en vez de 12 |

## 6. Lo que está sin tocar a propósito

- **Las reglas de validación**, salvo el arreglo de `entradaSinTipo`. Cuatro de los rechazos vienen
  de límites que elegimos nosotros (`bullets.maxChars`, `feedDescription.maxChars`,
  `seoDescription.minChars`, `maxKeywordRepeats`) y puede que alguno sobre — pero relajarlo ahora
  mezclaría esa variable con el experimento del razonamiento. **Primero cerrar el A/B.**
- **La investigación de keywords.** El punto 3 del artículo pide volumen y dificultad (Semrush o
  similar). No hay esa fuente, así que las keywords se derivan de lo que dice el fichero: tipo,
  denominación, formato, elaboración. Son ciertas, pero no están priorizadas por demanda.
- **`eval/eval_session.py`**, conservado como esqueleto del futuro eval de sesiones. Sigue con
  `wine_recommend` y un `stock.json` que ya no existe: hoy no puntúa nada de catálogo.

## 7. Cómo retomar mañana

```bash
cd /Users/jonatannietoa/Documents/projects/dsh-plugin-catalog-agent
./dsh.sh                    # despliega, comprueba el adaptador y arranca
```

Y en **sesión nueva** del navegador, con el prompt de siempre:

```
Procesa el fichero /Users/jonatannietoa/Documents/deepseek-harness-workspaces/bodegas-rosas/rosas-sample.csv
y crea los productos con las descripciones y SEO
```

Eso ya mide `off` (es el defecto). Luego:

1. Leer el resumen: `segundosPorLlamada`, `intentosMedios`, `rechazos`, `razonamientoMaximo`.
2. `catalog_seo(limit: 11)` para leer las fichas y juzgar la prosa.
3. Comparar con la tabla de la sección 1 y decidir `off` o `high`.
4. Si se queda en `off`, quitar de `catalog.config.yml` el comentario que dice que es provisional.

Si se quiere comparar los dos en la misma sesión sin esperar a dos cargas:

```
catalog_describe(limit: 4, regenerate: "always", reasoningEffort: "off")
catalog_describe(limit: 4, regenerate: "always", reasoningEffort: "high")
```

Los dos parámetros son necesarios: sin `regenerate: "always"` no rehace nada porque ya tienen ficha,
y sin `reasoningEffort` usa el defecto. Faltó eso en los dos intentos anteriores de A/B.

## 8. La arquitectura (hecha el 22 de agosto)

`lib/` está partido en un hexágono por tool, siguiendo
`catalog-agent-refactor-hexagonal.md`. `index.js` pasó de 1183 a 567 líneas y ya no tiene `fs`,
`ctx.llm` ni ninguna regla de negocio: solo parámetros, esquemas, presentación y la llamada a la capa
de aplicación. El árbol y las reglas del reparto están en el README, sección «Un hexágono por tool».

Lo que hay que respetar al añadir las etapas 4 y 5: cada una es su propio hexágono, con su
`infra/` para su dependencia externa (proveedor de imágenes, Shopify) y su `application/` para su
política de fallo. `domain/product.js` es el único dominio compartido; lo que solo use una tool se
queda dentro de ella.

## 9. Después del A/B

Por orden de valor:

1. **Ajustar los límites que sobren**, con `rechazos` de varias cargas como evidencia.
2. **Etapa 4 (imagen)**: el contrato está en el bloque `image` de `catalog.config.yml`. `altText` ya
   se genera en la etapa 3, así que la 4 solo tiene que buscar o generar el fichero.
3. **Etapa 5 (Shopify)**: contrato en el bloque `shopify`. Arranca en `dryRun: true`, y publicar de
   verdad es una decisión consciente. Dos cosas abiertas ahí: qué hacer con lo que ya tiene
   descripción (`regenerate: missing`) y con lo que está en Shopify y ya no viene en el fichero
   (`missingInFile: leave`).
