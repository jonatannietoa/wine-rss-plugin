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

> El repositorio y algunos identificadores del código todavía se llaman `wine-*`; ver
> [Renombrado](#renombrado) al final.

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

De las cinco etapas **no hay ninguna implementada todavía**. Lo que hay hoy es el nombre, la
configuración acordada y esta documentación; el código sigue siendo el de la iteración anterior
del proyecto, un agente que leía noticias RSS del sector y recomendaba un producto del catálogo.

| Pieza | Estado |
|---|---|
| Nombre del plugin, del paquete y del preset | ✅ genérico (`catalog-agent`) |
| `catalog.config.yml` — configuración del dominio | ✅ creado, todavía no lo lee nadie |
| `catalogo.example.csv` — fixture anonimizado | ✅ en el repo |
| 1. Ingesta del fichero | ⛔ pendiente |
| 2. Normalización a modelo de producto | ⛔ pendiente |
| 3. Descripción con IA | ⛔ pendiente |
| 4. Búsqueda + generación de imagen | ⛔ pendiente |
| 5. Publicación en Shopify (productos, precios, stock) | ⛔ pendiente |
| Herramientas `wine_rss_latest` / `wine_article_fetch` / `wine_stock_list` / `wine_recommend` | ⚠️ siguen en el código, con nombres de la iteración anterior |
| Agente Python autónomo (`agent.py`) y sus evals | ⚠️ sigue funcionando por su cuenta, ver abajo |

Aviso práctico: `stock.json`, el catálogo JSON que usaban `wine_stock_list` y `wine_recommend`, se
ha borrado del repo (el catálogo real ahora es el CSV). Hasta que exista la ingesta, esas dos
herramientas fallan al no encontrar el fichero que apunta `stockPath` en el preset.

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

Falta enchufarlo: el plugin todavía no lee este fichero, así que la clave `configPath` está
**comentada** en la fila del preset. Se descomenta cuando exista la etapa de ingesta.

```yaml
- id: catalog-tools
  name: dsh-plugin-catalog-agent
  config:
    stockPath: /ruta/al/repo/stock.json
    # configPath: /ruta/al/repo/catalog.config.yml
```

Decisiones que siguen abiertas, y que hay que cerrar antes de implementar la etapa 5: si las
descripciones e imágenes ya generadas se respetan o se rescriben en cargas posteriores (hoy
`regenerate: missing`), y qué se hace con los productos que están en Shopify y ya no vienen en el
fichero (hoy `missingInFile: leave`).

## Arrancar dsh

No hay binario en el `PATH`: dsh se lanza con `npx`, y **el directorio desde el que lo lanzas es la
raíz de workspace** de la sesión (es lo que dsh usa para resolver las skills de ámbito de
proyecto), así que lánzalo siempre desde el mismo sitio.

```bash
npx dsh web                  # alias de `npx dsh --profile web`; imprime la URL al arrancar
npx dsh web --port 8080      # los flags después de `web` son de la app web, no del lanzador
npx dsh --help               # la ayuda del lanzador; `npx dsh web --help` es la de la app
```

Corre en primer plano: se para con `Ctrl-C`. Por defecto queda en
[http://localhost:3080](http://localhost:3080). El perfil `web` se auto-inicializa la primera vez
en `~/.dsh/profiles/web/`.

Para ver el árbol del perfil sin arrancar nada, `npx dsh --profile web --dump-config`. Ojo: eso es
el **plano host**, y este plugin lo monta el preset (plano agente), así que ahí no aparece. Se
comprueba abriendo una sesión con el preset «Agente de catálogo» y llamando a una herramienta.

## Instalar el plugin (una sola vez)

```bash
# 1. dependencias PROPIAS del plugin: pnpm lo enlaza con `link:` y Node resuelve por realpath,
#    así que si esto falta, dsh arranca con `Cannot find package '@deepseek-ai/dsh-tools'`
cd dsh-plugin && npm install && cd ..

# 2. darlo de alta en el perfil (reenvía a pnpm en el directorio del perfil)
npx dsh plugin --profile web add "$PWD/dsh-plugin"

# 3. desplegar el preset de agente, que es quien monta las herramientas
mkdir -p ~/.dsh/.agent-presets/catalog-agent
cp agent-presets/catalog-agent/preset.yml agent-presets/catalog-agent/agent.cordis.yml \
   ~/.dsh/.agent-presets/catalog-agent/
```

El aviso `declares no dsh.bundle` del paso 2 es lo esperado: el plugin no es una capa del perfil
(plano host), lo monta el preset (plano agente).

El paso 2 deja en `~/.dsh/profiles/web/package.json` una entrada
`dsh-plugin-catalog-agent: link:<ruta absoluta>/dsh-plugin`, y un symlink en el `node_modules` del
perfil. Es un enlace **por ruta absoluta**: mover el repo o renombrar el paquete lo deja colgando.

El preset se elige por sesión en el selector de dsh. Si quieres que sea el de por defecto, es
`agent-presets.default` en `~/.dsh/settings.yaml` — y ojo, un default que nombre un preset que no
existe se guarda sin queja y falla al resolver la siguiente sesión.

Las rutas de la fila del preset son **absolutas** a propósito, así que hay que ajustarlas a la
máquina donde se despliegue.

## Qué hay que hacer en cada cambio

No todo pide lo mismo, y reiniciar dsh a ciegas cuesta tiempo. La regla corta: **cambio de código
del plugin → reiniciar dsh; cambio de configuración → basta con abrir sesión nueva.**

| Qué cambias | Qué hay que hacer |
|---|---|
| `dsh-plugin/lib/index.js` u otro código del plugin | **Reiniciar dsh** (`Ctrl-C` y `npx dsh web`) y abrir sesión nueva. El proceso ya tiene el módulo importado y no lo vuelve a leer; el HMR que trae dsh es de los bundles del cliente, no de los plugins del servidor. No hace falta reinstalar nada: el enlace apunta al directorio de trabajo. |
| Dependencias del plugin (`dsh-plugin/package.json`) | `cd dsh-plugin && npm install`, y reiniciar dsh. |
| Nombre del paquete, o ruta del repo | `npx dsh plugin --profile web remove <nombre-viejo>` + `add "$PWD/dsh-plugin"`, y reiniciar. Sin el `remove`, en el perfil queda una dependencia `link:` a una ruta que ya no existe. |
| `agent.cordis.yml` o `preset.yml` (la config de las filas) | Copiarlos otra vez a `~/.dsh/.agent-presets/catalog-agent/` y **abrir sesión nueva; no hace falta reiniciar**. El documento se relee y la generación nueva entra en la siguiente sesión que se cree; las sesiones ya abiertas se quedan con la composición con la que nacieron. |
| Un fichero *al lado* del preset (skill, asset) | Eso no lo nota el sello de generación: llega a las sesiones nuevas solo cuando cambia el propio `agent.cordis.yml` o cuando se reinicia el proceso. |
| `catalog.config.yml` | Hoy nada: el plugin todavía no lo lee. Cuando lo lea, la intención es leerlo **en cada llamada**, como ya hace `stockPath`, para que editar la configuración no exija reinicio. |
| `~/.dsh/skills/*/SKILL.md` | Nada: el watcher de skills lo recoge en caliente. |
| El `.env` del repo | Nada en dsh: el plugin nativo no lo lee, usa el modelo de la sesión del harness. Solo afecta a `agent.py` y a las evals. |

Ciclo de trabajo típico, entonces: editas `lib/index.js`, `Ctrl-C`, `npx dsh web`, abres sesión
nueva con el preset «Agente de catálogo» y pruebas la herramienta.

La versión sigue **semver (x.y.z)** y su fuente canónica es `version` en
`dsh-plugin/package.json`. El `name` del preset y la línea de la persona (`Versión del código …:
x.y.z`) deben coincidir con ella; se suben a mano en cada release, y luego se redeploya y se
reinicia dsh. La versión va en la persona (y no solo en el `name`) porque la persona se congela
por sesión en el system prompt, mientras que el `name` es una etiqueta global que se re-lee para
todas las sesiones.

Si actualizas dsh, vuelve a fijar `@deepseek-ai/dsh-tools` en `dsh-plugin/package.json` a la
versión nueva y reinstala.

## Variables de entorno

Las claves van en un `.env` en la raíz del repo, a partir de la plantilla:

```bash
cp .env.example .env   # y rellena lo que uses
```

| Variable | Para qué |
|---|---|
| `DEEPSEEK_API_KEY` | modelo de `agent.py`; sin ella corre en modo mock. También es el juez de `eval_session.py` si no fuerzas otro |
| `OPENAI_API_KEY` | juez de deepeval por defecto (`eval/test_wine_agent.py`) |
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
│   └── lib/index.js          # herramientas registradas en el registro `tools`
├── agent-presets/
│   └── catalog-agent/        # preset de agente versionado (preset.yml + agent.cordis.yml)
├── agent.py                  # agente Python autónomo (iteración anterior)
├── harness/                  # piezas del agente Python: herramientas, modelo, loop
└── eval/                     # tests de deepeval y evaluación de sesiones reales
```

## El agente Python y las evals

`agent.py` es la versión autónoma de la iteración anterior: su propio modelo, su modo mock y su
propio bucle de reintentos, sin depender del harness. Sigue funcionando por su cuenta y es lo que
evalúan los tests de `eval/`.

```bash
pip install -r requirements.txt
python agent.py                      # sin clave: modo mock determinista
DEEPSEEK_API_KEY=sk-... python agent.py
```

Los tests de `eval/test_wine_agent.py` cubren cuatro casos: respuesta coherente que pasa la
métrica, respuesta incoherente que la falla, métrica de exactitud con `threshold=0.80`, y un
modelo simulado que responde incompleto para forzar el reintento del loop.

```bash
deepeval test run eval/test_wine_agent.py
```

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

Cuando las etapas del pipeline estén implementadas, estas evals hay que rehacerlas: lo que habrá
que medir es la calidad de las descripciones y de las imágenes, y la corrección de lo publicado en
Shopify. Y hay que hacerlo contra `catalogo.example.csv`, no contra el fichero de producción.

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

GitHub deja redirigidas las URLs del nombre viejo, así que un `git remote` que se haya quedado
atrás sigue funcionando; conviene actualizarlo igualmente (`git remote set-url origin`).

Como el nombre del paquete es lo que resuelve la fila del preset, y el enlace del perfil es por
ruta absoluta, después de esto hay que **volver a dar de alta el plugin y redeployar el preset**:

```bash
# el enlace viejo apunta a un paquete y a una ruta que ya no existen
npx dsh plugin --profile web remove dsh-plugin-wine-agent
npx dsh plugin --profile web add "$PWD/dsh-plugin"

mkdir -p ~/.dsh/.agent-presets/catalog-agent
cp agent-presets/catalog-agent/*.yml ~/.dsh/.agent-presets/catalog-agent/
rm -rf ~/.dsh/.agent-presets/wine-agent      # el preset viejo, ya renombrado
```

Y si `agent-presets.default` en `~/.dsh/settings.yaml` sigue apuntando a `wine-agent`, cámbialo a
`catalog-agent`: un default que nombre un preset inexistente no da error al guardarse, falla al
resolver la sesión. Después, reinicia dsh.

Al cambiar el directorio del proyecto hay que rehacer lo que dsh tenía enlazado por ruta
absoluta: el plugin del perfil (`~/.dsh/profiles/web/package.json` apunta al `dsh-plugin/` viejo) y
la skill de usuario `~/.dsh/skills/wine-rss-agent/SKILL.md`, que además sigue describiendo el
agente de noticias.

Sigue pendiente de renombrar, porque toca código: los nombres de las herramientas
(`wine_rss_latest`, `wine_article_fetch`, `wine_stock_list`, `wine_recommend`), el `User-Agent` del
plugin, el texto de la persona del preset, los módulos de `harness/` y el fichero
`eval/test_wine_agent.py`.
