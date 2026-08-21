# Catalog Agent

`dsh-plugin-catalog-agent` — plugin de [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/dsh)
para **cargar un catálogo de productos desde un fichero, enriquecerlo con IA (descripción e
imagen) y publicarlo en Shopify** con sus precios y su stock.

El plugin es genérico a propósito: no sabe de vinos ni de ninguna vertical. Todo lo que es del
dominio —qué columnas trae el fichero, cómo se llaman las categorías, con qué tono se escriben las
descripciones, a qué tienda se publica— vive en `catalog.config.yml` y en la fila del preset, que
es donde dsh quiere la configuración («no hay un lenguaje de configuración aparte: cambiar lo que
un agente puede hacer es cambiar las filas que lo componen»). El primer caso real es un catálogo
de vinos, pero el plugin no depende de eso.

> El proyecto viene de una iteración anterior que leía noticias RSS y recomendaba un vino; ese
> código ya no está. Ver [Renombrado](#renombrado) al final.

## El pipeline

| # | Etapa | Qué hace |
|---|---|---|
| 1 | **Ingesta** | Lee el fichero de catálogo (CSV export del ERP) y devuelve las filas crudas, con su cabecera tal cual viene. |
| 2 | **Normalización** | Convierte cada fila al modelo interno de producto: SKU, título, categoría, precio, coste, stock, proveedor, atributos. Aquí se resuelven los formatos locales (coma decimal, `€`, fechas `d/m/aaaa`) y los códigos truncados del ERP. |
| 3 | **Descripción con IA** | Redacta la descripción comercial a partir de los atributos normalizados, con el tono y el idioma que fije la configuración, y sin inventar lo que el fichero no dice. |
| 4 | **Imagen** | Busca una foto existente del producto y, si no hay ninguna usable, genera una imagen nueva coherente con la ficha. |
| 5 | **Publicación** | Crea o actualiza el producto en Shopify: título, descripción, imagen, tipo y tags, precio, coste y cantidad de inventario. |

Las etapas son piezas independientes: cada una es una herramienta del harness, y el agente las
encadena. Se puede correr el pipeline entero sobre un fichero o una sola etapa sobre un producto
concreto (regenerar la descripción, cambiar la imagen, sincronizar solo stock y precios).

## Estado actual

Las dos primeras etapas están implementadas y son la herramienta `catalog_load`. El código de la
iteración anterior del proyecto —un agente que leía noticias RSS del sector y recomendaba un
producto— **se ha eliminado**: no había nada reutilizable para leer un CSV.

| Pieza | Estado |
|---|---|
| `catalog.config.yml` — configuración del dominio | ✅ la lee `catalog_load` |
| `catalogo.example.csv` — fixture anonimizado | ✅ 22 filas, una por rareza del fichero real |
| 1. Ingesta del fichero | ✅ `catalog_load` |
| 2. Normalización a modelo de producto | ✅ `catalog_load` |
| 3. Descripción con IA | ⛔ pendiente |
| 4. Búsqueda + generación de imagen | ⛔ pendiente |
| 5. Publicación en Shopify (productos, precios, stock) | ⛔ pendiente |
| Herramientas `wine_*` y agente Python `agent.py` | 🗑️ eliminadas |
| `eval/eval_session.py` | ⚠️ conservado como esqueleto del futuro eval de sesiones; su extracción sigue siendo de la iteración anterior |

## El fichero de entrada

> ⚠️ **El fichero de catálogo real es de producción y no se sube al repositorio.** `stock-rosas.csv`
> son datos reales de la empresa (precios de coste, códigos de proveedor, existencias) y está en
> `.gitignore` junto con cualquier `stock*.csv` y `catalogo*.csv`. Nunca ha entrado en el
> historial de git y no debe entrar. Se trabaja con él en local, y lo que se versiona es el
> fixture anonimizado `catalogo.example.csv`, con la misma cabecera y filas inventadas.

El fichero es un export del ERP de la tienda, del orden de 800 productos.

- Codificación **UTF-8** sin BOM, separador **coma**, campos entrecomillados solo cuando hace falta.
- Números en formato español: **coma decimal**. El precio viene además con el símbolo `€` y con
  espacios de relleno dentro de las comillas (`"  9,50 € "`).
- Fechas `d/m/aaaa` sin cero de relleno (`9/1/2026`).
- La cabecera de precio lleva un **espacio inicial** en el propio nombre de columna
  (`' Precio Venta tienda'`): hay que recortar los nombres de columna, no compararlos literales.

| Columna | Qué es | Notas |
|---|---|---|
| `Nº` | Código interno del producto | Único, rellenado con ceros (`000101`): es texto, no número. Candidato natural a **SKU**. |
| `Descripción` | Nombre del producto | En mayúsculas y con el formato del envase pegado al final (`75 cl.`, `70 cl.`). Hay que separar nombre y formato, y arreglar las mayúsculas. |
| `Denominación Origen` | Atributo de origen | Setenta y pico valores distintos, unas pocas filas vacías. |
| ` Precio Venta tienda` | PVP con IVA | Limpiar `€`, espacios y coma decimal. |
| `Cód. país/región de origen` | País ISO-2 | **Casi siempre vacío** (menos de una fila de cada diez). No sirve como fuente principal de origen. |
| `Tipo elaboración` | Atributo de elaboración | Vacío en la gran mayoría. Valores: `ECOLOGICO`, `SIN ALCOHOL`, `NATURAL`, `ORANGE WINE`. Encaja como **tag**. |
| `Bloqueado` | Producto bloqueado en el ERP | `Sí` / `No`. Un producto bloqueado no debería publicarse como activo. |
| `Inventario` | Unidades en stock | Entero. |
| `Fecha últ. modificación` | Última modificación en el ERP | Es lo que permite las cargas incrementales: procesar solo lo cambiado. |
| `Nº proveedor` | Código de proveedor | Dos formatos mezclados (`40000001`, `PRO000003`). Es un código interno, no un nombre: para el *vendor* de Shopify hace falta una tabla de correspondencia. |
| `Cód. categoría producto` | Categoría | Constante (`VINO`) en el export actual. |
| `Cód. grupo producto` | Subcategoría | Once valores: `TINTO`, `BLANCO`, `ROSADO`, `DULCE`, `JEREZ`, `BRISAT`, `SIN ALCOHO`, `EXTRANJERO`, `BOX`, `ESTUCHE`, `OTROS`. Ojo: el ERP **trunca a diez caracteres** (`SIN ALCOHO`), y `EXTRANJERO` mezcla un criterio de origen con criterios de color. |
| `Último coste directo` | Coste medio | Hasta tres decimales. Va al *cost per item* de Shopify, no al precio. |

Lo que estas columnas **no** traen y la etapa de enriquecimiento tiene que resolver: descripción
comercial, imagen, añada, graduación, uva, y el nombre legible del proveedor.

## Configuración

Toda la configuración del dominio está en **`catalog.config.yml`**, versionado en la raíz del
repo. Un bloque por etapa del pipeline:

| Bloque | Qué decide |
|---|---|
| `source` | Ruta del fichero, formato, codificación, separadores locales, y si la carga es incremental |
| `columns` | Columna del fichero → campo del modelo interno. Es el único sitio que conoce los nombres del ERP |
| `normalize` | Capitalización del título, extracción del formato del envase, valores del flag `Bloqueado`, filas que se descartan |
| `taxonomy` | `Cód. grupo producto` → `product_type`, tipos de elaboración → tags, código de proveedor → nombre, y qué hacer con la denominación de origen |
| `description` | Idioma, tono, longitud máxima, atributos que puede usar el modelo, y lo que le está prohibido inventar |
| `image` | Criterios mínimos de la foto buscada, cuándo se genera una nueva, estilo y tamaño |
| `shopify` | Tienda, versión de API, clave de emparejamiento (`sku`), qué campos se escriben, estado según `Bloqueado`, qué hacer con lo que ya no viene en el fichero, `dryRun` y tamaño de lote |

Dos reglas del fichero:

- **No lleva claves.** Los tokens van en `.env`; la configuración solo guarda el *nombre* de la
  variable de entorno (`shopify.tokenEnv: SHOPIFY_ADMIN_TOKEN`).
- **Arranca en `dryRun: true`.** Escribir de verdad en la tienda es una decisión consciente que se
  toma cambiando ese valor.

La ruta de `source.path` es absoluta a propósito: el catálogo no depende del directorio de trabajo
de la sesión. Para desarrollar, apúntala a `catalogo.example.csv`.

El plugin lo recibe por `configPath`, y es lo único que la fila del preset necesita saber:

```yaml
- id: catalog-tools
  name: dsh-plugin-catalog-agent
  config:
    configPath: /ruta/al/repo/catalog.config.yml
```

Se relee en **cada llamada**, así que retocar la taxonomía o el tono se nota sin reiniciar dsh.
Cambiar la ruta sí es cambiar el preset. Las rutas relativas de dentro del fichero (como
`output.catalogJson`) cuelgan del directorio del propio `catalog.config.yml`, no del directorio de
trabajo de la sesión.

Decisiones que siguen abiertas, y que hay que cerrar antes de implementar la etapa 5: si las
descripciones e imágenes ya generadas se respetan o se rescriben en cargas posteriores (hoy
`regenerate: missing`), y qué se hace con los productos que están en Shopify y ya no vienen en el
fichero (hoy `missingInFile: leave`).

## La herramienta `catalog_load`

Es la etapa 1 y la 2 juntas: lee el fichero y devuelve los productos del dominio. No llama a
ningún modelo — la normalización es determinista, y por eso se testea en vez de evaluarse.

| Parámetro | Para qué |
|---|---|
| *(ninguno)* | Procesa el fichero que declara `source.path` |
| `path` | Otro fichero. Si es relativo, cuelga del directorio de trabajo de la sesión |
| `modifiedSince` | Fecha `aaaa-mm-dd`: solo lo que el ERP tocó desde entonces (carga incremental) |
| `sku` | Devuelve además esa ficha ya normalizada, para comprobar cómo queda |

**Escribe el catálogo en `output.catalogJson` y devuelve solo un resumen.** No es un detalle de
implementación: 800 productos son unos 480 KB de JSON, y el podador del preset corta los resultados
de herramienta a 8192 caracteres. El resumen del fichero real ocupa unos 1300, así que llega
entero: totales, desglose por tipo de producto, recuento de avisos y las primeras filas rechazadas
con su motivo y su línea.

Así queda un producto:

```json
{
  "sku": "000048",
  "titleRaw": "ESPELT VAILET 75 cl.",
  "title": "Espelt Vailet",
  "format": "75 cl",
  "volumeMl": 750,
  "group": "BLANCO",
  "productType": "Vino blanco",
  "category": "VINO",
  "origin": "Empordá",
  "countryCode": null,
  "productionType": null,
  "tags": ["Empordá"],
  "price": 7.5,
  "cost": 4.455,
  "stock": 23,
  "blocked": false,
  "supplierCode": "40000289",
  "vendor": null,
  "modifiedAt": "2026-04-10",
  "warnings": [],
  "row": 2
}
```

Es un modelo **neutro, no la forma de Shopify**: `status`, los metafields y las variantes los
compone la etapa 5 a partir de `blocked`, `origin` y `format`. Si el segundo cliente publica en
otra plataforma, la normalización no se toca.

### Rechazos y avisos

La distinción es la decisión de diseño que importa. Se **rechaza** lo que hace el producto
impublicable, y esas filas no entran en `items`: sin SKU, con un precio ilegible (el export real
trae siete `#N/A`), con un stock que no es un número, o con un grupo que `taxonomy.groups` no
declara — sin grupo no hay con qué categorizar. Cada rechazo lleva la línea del fichero y el
motivo, para poder ir a corregirlo en el ERP.

Se **avisa** de lo que solo deja la ficha incompleta: el campo queda a `null`, el producto se
publica igual y el aviso viaja en `warnings`. Ahí caen las 29 filas del export real cuyo título no
trae un formato reconocible (`MALAGA VIRGEN`, `BOX LA AURORA 15 L ETIQUETA VERDE`) —27 de ellas
llegan a publicarse, las otras dos las tumba el precio—, las que no tienen denominación
de origen, un coste ilegible o una fecha que no existe. La regla del proyecto es la misma en las
cinco etapas: **lo que el fichero no dice, no se rellena**.

Un flag `Bloqueado` con un valor que `normalize.blocked` no declara se trata como bloqueado, no
como publicable: es la opción conservadora, porque el error contrario publica en la tienda algo que
el ERP tenía retirado.

### Contra el fichero real

```
total: 800   ok: 793   rechazados: 7 (los siete #N/A de precio)
Vino tinto 405 · Vino blanco 215 · Vino de importación 58 · Vino rosado 55 · Vino dulce 36
Vino sin alcohol 8 · Otros 7 · Estuche 6 · Vino brisat 2 · Vino generoso 1
avisos: sinFormato 27 · sinOrigen 18
```

## Instalar el plugin (una sola vez)

```bash
cd dsh-plugin && npm install && cd ..                # dependencias propias del plugin
npx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile web add "$PWD/dsh-plugin"

mkdir -p ~/.dsh/.agent-presets/catalog-agent         # el preset es quien monta las herramientas
cp agent-presets/catalog-agent/*.yml ~/.dsh/.agent-presets/catalog-agent/
```

`plugin add` **no copia el plugin**: deja un `link:` al repo en `~/.dsh/profiles/web/package.json` y
un symlink en su `node_modules`. Por eso tocar `dsh-plugin/lib/` no obliga a reinstalar nada, solo a
reiniciar dsh. Este paso solo se repite si cambia el **nombre del paquete** o si **mueves el repo**.

El preset se elige por sesión en dsh, o se fija en `agent-presets.default` de
`~/.dsh/settings.yaml`. Las rutas de la fila del preset son absolutas: ajústalas a la máquina.

## Desplegar cambios y arrancar

El ciclo completo después de tocar el repo, desde la raíz:

```bash
# 1. sube la versión en los TRES sitios (ver abajo) y pasa los tests
cd dsh-plugin && npm test && cd ..

# 2. despliega el preset — el plugin no hay que redesplegarlo, es un symlink
cp agent-presets/catalog-agent/*.yml ~/.dsh/.agent-presets/catalog-agent/

# 3. reinicia dsh: Ctrl-C donde esté corriendo, y otra vez
npx @deepseek-ai/dsh@0.1.0-rc.6 web                  # http://localhost:3080

# 4. abre una SESIÓN NUEVA en el navegador
```

El paso 4 no es opcional: una sesión ya abierta sigue con el código y el preset que tenía cuando se
creó. Y fija la versión de dsh en el comando: `npx dsh` es otro paquete de npm y falla con `could
not determine executable to run`, y sin versión npx se baja la rc más nueva. Para otro puerto,
`--port 8080`. El directorio desde el que lanzas es la raíz de workspace de la sesión.

### No siempre hace falta todo

| Qué cambias | Qué hacer |
|---|---|
| `dsh-plugin/lib/*.js` | Reiniciar dsh + sesión nueva |
| `dsh-plugin/package.json` (dependencias) | `npm install` en `dsh-plugin/`, reiniciar + sesión nueva |
| `agent.cordis.yml` o `preset.yml` | `cp` al preset desplegado + sesión nueva. **Sin reiniciar** |
| `catalog.config.yml` | Nada: `catalog_load` lo relee en cada llamada |
| `catalogo.example.csv` o los tests | `npm test`. A dsh no le afecta |
| Nombre del paquete, o ruta del repo | `plugin --profile web remove <nombre-viejo>` + `add "$PWD/dsh-plugin"`, y reiniciar |
| `~/.dsh/skills/*/SKILL.md` | Nada: se recoge en caliente |

### La versión va en tres sitios

`version` de `dsh-plugin/package.json` es la fuente canónica; el `name` de `preset.yml` y la línea
de la persona de `agent.cordis.yml` tienen que coincidir con ella. Se suben a mano en cada release:

```bash
node -p "require('./dsh-plugin/package.json').version"
grep '^name:' agent-presets/catalog-agent/preset.yml
grep -o 'dsh-plugin-catalog-agent): [0-9.]*' agent-presets/catalog-agent/agent.cordis.yml
```

### Comprobar que dsh corre lo último

La trampa habitual: subes la versión en el repo y dsh sigue enseñando la vieja, porque lo que lee es
la **copia desplegada** del preset, no el repo. Si el selector de dsh dice «Agente de catálogo
(0.1.0)» cuando el repo ya va por 0.2.0, falta el `cp` del paso 2 o falta abrir sesión nueva.

```bash
diff -r agent-presets/catalog-agent/ ~/.dsh/.agent-presets/catalog-agent/ && echo "preset al día"
```

Y para saber si el proceso que tienes vivo lleva tu último cambio de código, compara cuándo arrancó
con cuándo tocaste los ficheros:

```bash
ps -o lstart= -p $(pgrep -f 'deepseek-ai/dsh' | head -1)   # cuándo arrancó dsh
ls -lT dsh-plugin/lib/*.js                                 # cuándo cambió el plugin
```

Si actualizas dsh, vuelve a fijar `@deepseek-ai/dsh-tools` a la versión nueva en
`dsh-plugin/package.json` y reinstala.

## Variables de entorno

Las claves van en un `.env` en la raíz del repo, a partir de la plantilla:

```bash
cp .env.example .env   # y rellena lo que uses
```

| Variable | Para qué |
|---|---|
| `DEEPSEEK_API_KEY` | juez de `eval_session.py` si no fuerzas otro con `--juez` |
| `OPENAI_API_KEY` | juez de deepeval por defecto (`eval_session.py --juez openai`) |
| `DEEPSEEK_MODEL_NAME` | modelo del juez DeepSeek; por defecto `deepseek-chat` |
| `DEEPEVAL_TELEMETRY_OPT_OUT` | `1` para que deepeval no mande telemetría |
| `SHOPIFY_ADMIN_TOKEN` | ⛔ pendiente: token de la Admin API de la tienda |
| `IMAGE_SEARCH_API_KEY` | ⛔ pendiente: proveedor de búsqueda de imágenes |
| `IMAGE_GENERATION_API_KEY` | ⛔ pendiente: proveedor de generación de imágenes |

Se carga siempre el `.env` de la raíz del repo, no el del directorio desde el que lances el
comando, así que los scripts funcionan desde cualquier sitio. Una variable ya exportada en la
shell gana sobre el fichero, y una variable vacía cuenta como ausente. `.env` está en
`.gitignore`; `.env.example` no, así que ahí no van claves.

El plugin nativo de dsh no lee nada de esto: usa el modelo de la sesión del harness.

## Estructura

```
.
├── catalog.config.yml        # configuración del dominio: fichero, columnas, taxonomía, IA, Shopify
├── catalogo.example.csv      # fixture anonimizado (el CSV real es de producción y no se versiona)
├── dsh-plugin/               # el plugin nativo de dsh
│   ├── package.json          # nombre, versión y dependencias del harness
│   ├── lib/index.js          # las herramientas registradas en el registro `tools`
│   ├── lib/catalog.js        # etapas 1 y 2: leer el fichero y normalizar cada fila
│   └── test/                 # tests de la normalización, con `node --test`
├── agent-presets/
│   └── catalog-agent/        # preset de agente versionado (preset.yml + agent.cordis.yml)
├── harness/env.py            # carga del .env para lo que queda en Python
├── eval/eval_session.py      # evaluación de sesiones reales de dsh (de la iteración anterior)
└── .artifacts/               # salida del pipeline (en .gitignore: contiene datos reales)
```

El reparto de `dsh-plugin/lib/` es a propósito: `catalog.js` es un módulo puro y determinista —no
llama a ningún modelo, no toca la red y no escribe nada— y por eso se puede testear con un fixture
sin levantar dsh. `index.js` es lo único que conoce el harness.

## Tests

Las etapas 1 y 2 son deterministas, así que se prueban con el runner de Node contra el fixture
anonimizado. No hacen falta claves ni red:

```bash
cd dsh-plugin && npm test          # node --test "test/*.test.js"
```

Los 23 tests van uno por regla: las cinco maneras de escribir el formato del envase, los precios
con `€` y coma decimal, el separador de millares, las fechas `d/m/aaaa`, las cuatro causas de
rechazo, la capitalización con palabras llanas, la taxonomía y los tags. **Si un cliente nuevo
trae una rareza más, se añade una fila a `catalogo.example.csv` y su test aquí.**

## Las evals de sesiones

`eval/eval_session.py` evalúa lo que de verdad corrió dentro de dsh: lee el log de una sesión,
extrae cada llamada de la herramienta final y la puntúa contra el material que el agente tenía
delante en ese momento.

```bash
./.venv/bin/python eval/eval_session.py session.jsonl
./.venv/bin/python eval/eval_session.py ~/.dsh/sessions/*/session-*/session.jsonl.zstd
./.venv/bin/python eval/eval_session.py --dry-run session.jsonl    # los casos, sin gastar juez
./.venv/bin/python eval/eval_session.py --verbose session.jsonl    # qué se le pasa al juez
```

Comprueba gratis la estructura y cuenta las llamadas que la herramienta rechazó, que son los
reintentos del loop. Las métricas `GEval` no usan `expected_output`, porque en una sesión real no
hay una respuesta esperada contra la que comparar. El juez no tiene por qué ser OpenAI: con
`DEEPSEEK_API_KEY` en el entorno usa el `DeepSeekModel` de deepeval, y `--juez openai|deepseek` y
`--modelo-juez` fuerzan uno concreto. Ojo con juzgar con el mismo modelo que generó la respuesta:
es cómodo, pero un juez tiende a ser indulgente con su propia salida.

⚠️ **Está a medio migrar**: su extracción sigue siendo la de la iteración anterior (busca llamadas
a `wine_recommend` y valida contra un `stock.json` que ya no existe), así que hoy no puntúa nada de
catálogo. Se conserva porque el esqueleto —leer el `session.jsonl` de dsh, incluido el `.zstd`
comprimido, y puntuar con un juez— es lo que hará falta cuando haya algo que juzgar: la calidad de
las descripciones de la etapa 3, las imágenes de la 4 y lo publicado en la 5. Nada de eso existe
todavía, y la carga de catálogo no se evalúa con un juez porque es determinista: se testea.

Cuando se rehaga, hay que hacerlo contra `catalogo.example.csv`, no contra el fichero de
producción.

## Renombrado

| Antes | Ahora |
|---|---|
| repositorio `jonatannietoa/wine-rss-plugin` | `jonatannietoa/dsh-plugin-catalog-agent` |
| directorio local `~/Documents/projects/wine-rss-agent` | `~/Documents/projects/dsh-plugin-catalog-agent` |
| paquete `dsh-plugin-wine-agent` | `dsh-plugin-catalog-agent` |
| plugin de Cordis `wine-agent` | `catalog-agent` |
| `agent-presets/wine-agent/` | `agent-presets/catalog-agent/` |
| fila `wine-tools` del preset | `catalog-tools` |
| preset «Agente de vinos» | «Agente de catálogo» |

GitHub redirige las URLs del nombre viejo, así que un clon que se haya quedado atrás sigue
funcionando. El redeploy en dsh ya está hecho: perfil, preset y `agent-presets.default`.

Ya no queda nada pendiente de renombrar en el código: las herramientas `wine_*`, el agente Python
y sus tests se han eliminado, y la persona del preset es la del agente de catálogo. Lo único que
sigue hablando de la iteración anterior es `eval/eval_session.py`, conservado a propósito.
