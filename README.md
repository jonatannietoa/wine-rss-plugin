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
| 3 | **Textos SEO con IA** | Redacta los seis campos que Shopify usa para posicionar la ficha —descripción, meta title, meta description, handle, alt text y descripción de feed— con el tono y el idioma que fije la configuración, y sin inventar lo que el fichero no dice. |
| 4 | **Imagen** | Busca una foto existente del producto y, si no hay ninguna usable, genera una imagen nueva coherente con la ficha. |
| 5 | **Publicación** | Crea o actualiza el producto en Shopify: título, descripción, imagen, tipo y tags, precio, coste y cantidad de inventario. |

Las etapas son piezas independientes: cada una es una herramienta del harness, y el agente las
encadena. Se puede correr el pipeline entero sobre un fichero o una sola etapa sobre un producto
concreto (regenerar la descripción, cambiar la imagen, sincronizar solo stock y precios).

## Estado actual

Las tres primeras etapas están implementadas. El código de la
iteración anterior del proyecto —un agente que leía noticias RSS del sector y recomendaba un
producto— **se ha eliminado**: no había nada reutilizable para leer un CSV.

| Pieza | Estado |
|---|---|
| `catalog.config.yml` — configuración del dominio | ✅ la leen las tres etapas |
| `catalogo.example.csv` — fixture anonimizado | ✅ 22 filas, una por rareza del fichero real |
| 1. Ingesta del fichero | ✅ `catalog_load` |
| 2. Normalización a modelo de producto | ✅ `catalog_load` |
| 3. Textos SEO con IA | ✅ `catalog_describe` + `catalog_review` |
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
| `source` | Ruta del fichero habitual, bandeja de entrada, formato, codificación, separadores locales, y si la carga es incremental |
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

## Elegir el fichero de entrada

⚠️ **dsh no admite adjuntar un CSV al chat.** Su capa de adjuntos
(`@deepseek-ai/dsh-attachment`) solo acepta imágenes —PNG, JPEG, WebP y GIF—, y su propia
documentación lista los ficheros genéricos como trabajo pendiente. Así que «subir el catálogo» se
resuelve por disco.

La forma de hacerlo son las **bandejas de entrada**: las carpetas que declara `source.dirs`
(`./entradas` por defecto, en `.gitignore` porque va a tener catálogos de clientes). Se deja ahí el
fichero y se elige por su nombre:

```yaml
source:
  dirs:
    - ./entradas
    - ~/Documents/Bodegas Rosas to Shopify    # una carpeta por cliente
```

**Hay que declarar las carpetas de cliente.** El plugin no puede saber en qué directorio está
trabajando la sesión de dsh: no está en `AgentOptions` ni lo expone ningún paquete del harness, y el
`PWD` del proceso es este repo porque `./dsh.sh` lanza desde aquí. Si el fichero no está en una
bandeja declarada, hay que pasar la ruta absoluta.

```
tú:  ¿qué catálogos tengo?
     → catalog_sources
       ✓ cliente-bodegas-sur.csv — 22 filas — modificado 2026-08-21
       ✗ proveedor-ingles.csv — no trae las columnas que declara la configuración:
           Nº, Descripción, Precio Venta tienda… Las que trae son: Item Code, Retail EUR…
       ✗ precios-2026.xlsx — no es un .csv
       El catálogo habitual de la tienda, si no se pide otro, es …/stock-rosas.csv

tú:  carga el de bodegas sur
     → catalog_load(path: "cliente-bodegas-sur")
```

`catalog_sources` no lista nombres: abre cada CSV, lo cuenta y **comprueba su cabecera contra el
mapeo de columnas**. Un fichero de otro ERP se ve incompatible antes de cargarlo, y dice qué
columnas le faltan — que es exactamente lo que hay que saber para escribir la configuración de un
cliente nuevo.

`catalog_load` resuelve el `path` de lo más explícito a lo más cómodo:

| Lo que pasas | De dónde sale |
|---|---|
| nada | `source.path`, el catálogo habitual de la tienda |
| `cliente-x.csv` o `cliente-x` | las bandejas de `source.dirs`, en orden (la extensión la pone `source.pattern`) |
| `./otro/sitio/x.csv` | relativo al directorio donde arrancaste dsh |
| `/ruta/absoluta.csv` | tal cual |

**Las etapas siguientes trabajan sobre lo que se cargó, no sobre lo configurado.**
`catalog_describe` lee el JSON que dejó `catalog_load`, así que si cargaste el fichero de un cliente
es ese el que describe. Ambas herramientas dicen en su respuesta de qué fichero salió el catálogo:
confundir el de un cliente con el de producción es un error caro, y verlo escrito es la única
defensa.

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

## Las herramientas `catalog_describe` y `catalog_review`

La etapa 3. Escribe los **seis textos** que Shopify usa para posicionar una ficha, no solo la
descripción:

| Campo | Qué es en Shopify | Límite |
|---|---|---|
| `seoTitle` | El meta title de la página | 60 car. |
| `seoDescription` | La meta description del resultado de búsqueda | 70-155 car. |
| `bodyHtml` | La descripción de la ficha: un `<p>` de entrada y un `<ul>` de bullets | 700 car. |
| `handle` | El trozo final de la URL | 70 car. |
| `altText` | El texto alternativo de la foto | 125 car. |
| `feedDescription` | La descripción para el feed de Google Merchant Center | 500 car. |

Salen de [SEO Product Descriptions: 7 Tips to Optimize Product
Pages](https://www.shopify.com/enterprise/blog/seo-product-descriptions), que en su punto 4 nombra
exactamente esos como los campos de mayor impacto. `handle` y `altText` los necesitan igualmente
las etapas 4 y 5, así que generarlos aquí evita una segunda pasada por el modelo. Los datos
estructurados del punto 9 (name, description, price, currency, availability) no necesitan nada
nuevo: salen de la etapa 2 y de estos campos.

### Redacta con el modelo de tu sesión

El plugin no trae cliente de IA ni pide una clave: inyecta el servicio `llm` de dsh y usa el
proveedor y el modelo del agente (`exec.agent.options`). Cambias de modelo en dsh y cambia con
quién se redacta, sin tocar nada.

### Bloques, no JSON

El modelo devuelve seis bloques con cabecera, no un objeto JSON:

```
### seoTitle
Dido la Universal, vino tinto ecológico del Montsant

### bodyHtml
<p>Un vino tinto del Montsant de elaboración ecológica…</p>
<ul><li>…</li></ul>
```

No es una preferencia estética. `GenerateOptions` de dsh **no expone modo JSON**, así que el formato
es lo único que da robustez, y el HTML dentro de una cadena JSON era la parte frágil: había que
escaparlo, y un corte a media cadena tiraba los seis campos. Con bloques no hay nada que escapar, y
lo que llegó completo se conserva: la validación pide solo los campos que faltan, que es lo que se
le devuelve al modelo. El parser tolera preámbulos, cercado de markdown y cabeceras de otro nivel
(`#### Handle:`).

### El modelo redacta, el código valida

Esta es la parte que justifica que sea un plugin y no un prompt. El artículo enumera los errores
que un LLM comete solo, y cada uno tiene su comprobación determinista en `lib/seo.js`:

| Regla | Qué se comprueba |
|---|---|
| Longitudes | Cada campo contra su límite, y `seoDescription` también su mínimo |
| Escaneable en móvil (punto 6) | Un `<p>` de entrada de ≤40 palabras, luego 3-5 `<li>` de ≤90 car. |
| «La primera frase dice qué es» (punto 4) | El párrafo nombra el `productType` **o la categoría** — hay grupos del ERP que se traducen a cubos genéricos (`Otros`), y exigir esa palabra fuerza una frase que nadie escribiría |
| Keyword stuffing | Ninguna keyword más de 3 veces en el cuerpo |
| Sin plantillas ni duplicados | `handle` único, y ningún texto idéntico al de otra ficha |
| Sin relleno promocional (punto 8) | Lista de frases prohibidas: «envío gratis», «mejor precio»… |
| Sin datos inventados | Patrones de añada, graduación y premios — **salvo si el dato está en el nombre del producto**, porque entonces no es invención |
| Etiquetas HTML | Solo `p`, `ul`, `li`, `strong`, `em` |

Cuando un borrador falla, los problemas vuelven al modelo redactados como correcciones y reintenta
(`description.maxAttempts`, 3 por defecto). Si agota los intentos, el producto sale en `failures` con
el motivo y **no se guarda nada**: es mejor una ficha que falta que una mala.

Lo que **no** hace: el punto 3 del artículo pide investigación de keywords con volumen y dificultad
(Semrush o similar). No tenemos esa fuente, así que las keywords se derivan de lo que el fichero
dice del producto —tipo, denominación, formato, elaboración—. Son ciertas, que es lo que hace falta
para no inventar, pero no están priorizadas por demanda de búsqueda.

### Cuánto tarda, y qué mirar si tarda demasiado

El lote se redacta **en paralelo**, en trozos de `description.concurrency` (4 por defecto). Medido
sobre el mismo lote de 4 productos: **204 s** en serie → **97 s** con paralelismo → **~32 s**
saltando la sonda, todo con `reasoningEffort: high`.

El tiempo de pared es, aproximadamente, `secondsPerCall` × (rondas secuenciales), y las rondas son:
la sonda si la hay, más el peor número de intentos de cada trozo paralelo. De ahí salen las cuatro
palancas, de más a menos efecto:

| Palanca | Qué da |
|---|---|
| `reasoningEffort` | **La grande.** De 57,9 s a 4,1 s por llamada. Tiene su propia sección: [El esfuerzo de razonamiento](#el-esfuerzo-de-razonamiento-el-ab-medido) |
| `softRules` | Deja de gastar una llamada entera por pasarse de un tope por un carácter |
| `probeFirst: auto` | Se salta la sonda cuando ya hay prueba de que el modelo funciona: una ronda menos |
| `concurrency` | Irrelevante con 4 productos, decisivo con 793 |

Los números para decidir están en [Los números del resumen](#los-números-del-resumen).

### La sonda del primer producto

El primer producto del lote se redacta **solo** para que un modelo mal configurado cueste tres
llamadas en vez de un lote entero. Es una guarda que se ganó el sitio: evitó 24 llamadas en balde una
vez. Pero es una ronda secuencial completa, **un 33 % del tiempo de pared en un lote de cuatro**.

Por eso `description.probeFirst: auto` la salta cuando ya hay una ficha escrita por *ese mismo
modelo*: eso es prueba de que la configuración funciona, y entonces la sonda no protege de nada. La
primera carga con un modelo nuevo la paga; las siguientes no. Medido con la misma latencia y las
mismas 4 llamadas: **6,4 s → 3,2 s**.

`always` la hace siempre (lo más prudente y lo más lento) y `never` nunca. Sin sonda la guarda no
desaparece: pasa al primer trozo, que se corta igual si nadie de ahí produce un bloque.

Si `averageAttempts` sube, `rejections` te dice dónde mirar antes de tocar nada:

```
Reglas que están costando llamadas:
  entradaLarga: 7
  bulletLargo: 2
```

Con eso, el ajuste es una decisión y no una corazonada: o se relaja el límite de palabras del
párrafo en `catalog.config.yml`, o se acepta que ese modelo no sigue bien esa restricción. Y si es
lo segundo, la etapa 3 puede usar **otro modelo que la sesión**:

```yaml
description:
  provider: deepseek-official
  model: deepseek-v4-pro     # charlar con uno rápido, redactar con uno preciso
```

Un modelo que acierta a la primera puede salir más barato que uno rápido que necesita tres intentos,
aunque cueste más por llamada. Los números de arriba son los que lo deciden.

### Hay que acotar el lote

Cada producto es una llamada al modelo y hay 793. Sin `limit`, `sku` ni `skus` la herramienta **no
procesa nada** y te dice cuántos faltan. `description.maxPerCall` (50) es el techo por llamada.

```
catalog_describe(dryRun: true, limit: 1)            # el prompt, sin gastar una llamada
catalog_describe(limit: 10)                         # los 10 primeros pendientes
catalog_describe(sku: "000048")                     # uno concreto
catalog_describe(limit: 10, regenerate: "always")   # rescribe, perdiendo lo anterior
```

Respeta `description.regenerate`: con `missing` (el defecto) nunca rehace una ficha que ya existe.

### Cuando el modelo no escribe nada

Pasó de verdad: ocho borradores seguidos con **cero caracteres de texto**, y uno cortado en
`Unterminated string at position 472`. La causa no era el modelo ni las reglas SEO, era el
presupuesto de la llamada:

```
sesión:    deepseek-v4-flash · maxTokens 256000 · reasoningEffort "high"
el plugin: maxTokens 1500 cableado, sin reasoningEffort
```

Con esfuerzo de razonamiento alto, el modelo se gasta el presupuesto de salida pensando y no le
queda ninguno para escribir. Ahora se declara en la configuración:

```yaml
description:
  reasoningEffort: low     # redactar no necesita razonar alto, y ahorra en 793 productos
  maxTokens: 4000          # la ficha entera ronda los 500
```

Y el fallo se explica solo. Cada entrada de `failures` dice cuántos caracteres de texto y de
razonamiento llegaron, y enseña el principio de la respuesta cruda:

```
000048 (devolvió 0 caracteres de texto y 1847 de razonamiento):
  - la respuesta no trae ningún bloque "### campo": está vacía
  - el modelo gastó 1847 caracteres razonando y no escribió nada:
    sube `description.maxTokens` o baja `description.reasoningEffort`
```

**Un fallo sistémico corta el lote.** Si el primer producto agota los intentos sin que el modelo
escriba un solo bloque, el problema es de configuración y no de los datos: se para y se dice cuántos
quedaron sin intentar. Ese escenario costaba 12 llamadas y ahora cuesta 3. Un fallo de *validación*,
en cambio, sí es del producto concreto y no interrumpe el lote.

### El razonamiento cuenta contra el mismo presupuesto

La trampa que costó 7 fichas: `reasoningEffort: low` **no apaga el razonamiento**, solo le baja el
empeño — en el cable es `thinking: enabled` con `reasoning_effort: low`, y son unos **3.000 tokens
medidos**. Y esos tokens salen del mismo `maxTokens` que el texto. Con el tope en 4.000 quedaban
~1.000 para una ficha que necesita ~500: entraba o no entraba según lo que se estirara el
razonamiento, y de ahí unos fallos intermitentes con la firma inconfundible de *0 caracteres de
texto y 11.400 de razonamiento* (11.400 es el tope, no una casualidad).

Por eso `maxTokens: 16000`. No es generosidad: es que el tope no puede estar calculado solo para el
texto.

### No uses `low`

Los esfuerzos que acepta el adaptador dependen de su versión, y **esa versión no se puede fijar**:

| Versión del adaptador | Acepta |
|---|---|
| siempre | `off`, `high`, `max` |
| desde rc.8 | `+ low` |

`dsh` declara todas sus dependencias con rangos (`^0.1.0-rc.6`), así que npm resuelve
`dsh-llm-deepseek` a lo más nuevo que encaje **el día que se instala**. En dos cachés de npx de la
misma máquina salieron rc.6 y rc.8. Con `low` en la configuración, la carga funciona o revienta con
`UNSUPPORTED_REASONING_EFFORT` según lo que tocara. Por eso el defecto es `high`.

Tampoco se arregla pinando el plugin a rc.6: `dsh-tools@rc.6` pide `dsh-session@^0.1.0-rc.6`, npm lo
sube a rc.8 y ese exige `dsh-llm@^0.1.0-rc.8`. No hay árbol coherente en rc.6, así que el plugin
declara rc.8 aunque el host sea rc.6 — es lo que npm produce, no una elección.

Dos redes para que esto no vuelva a costar una sesión: `./dsh.sh` comprueba qué esfuerzos acepta el
adaptador resuelto y **para el despliegue** si la configuración pide otro; y si aun así el proveedor
lo rechaza en caliente, el error dice de dónde sale el valor y cuáles valen.

### El esfuerzo de razonamiento: el A/B, medido

`reasoningEffort` decide si el modelo razona antes de escribir. Suena a detalle y es **la variable
que más manda** en esta etapa: cambia el tiempo por llamada en un factor de 14.

Medido con `deepseek-v4-flash` sobre el mismo fichero de 11 productos:

| esfuerzo | s/llamada | llamadas por producto | fichas escritas | s por ficha escrita |
|---|---|---|---|---|
| `high` | 57,9 | 1,4 | 11/11 · 4/4 | **78** |
| `low` | 26,9 | 1,5 | 4/4 | 40 |
| `off` | **4,1** | 3,0 | 2/4 · 3/4 · 1/4 | **12-24** |

**Qué significa cada columna.** `s/llamada` es latencia del proveedor y **no baja paralelizando**:
es el suelo. `llamadas por producto` sube cuando el modelo incumple una regla y hay que reintentar,
y cada reintento es una llamada entera. La última columna es la que decide, porque un modelo rápido
que falla la mitad puede salir más caro que uno lento que acierta.

**El resultado y su explicación.** Sin razonamiento el modelo **escribe igual de bien pero no sabe
contar**: todos sus fallos eran de longitud, y se pasaba de los topes por 1-5 caracteres. Con
razonamiento acierta a la primera pero cada llamada cuesta 14 veces más.

Por eso el defecto es **`off` con reglas blandas** (ver abajo): se queda con los 4 segundos y se
deja de tirar fichas por un carácter.

Si aun así hace falta razonamiento, el parámetro `reasoningEffort` de `catalog_describe` pisa la
configuración solo en esa llamada, para poder comparar sobre los mismos productos:

```
catalog_describe(limit: 4, regenerate: "always", reasoningEffort: "off")
catalog_describe(limit: 4, regenerate: "always", reasoningEffort: "high")
catalog_seo(limit: 4)     # y leer las fichas de cada uno
```

Los dos parámetros son necesarios: sin `regenerate: "always"` no rehace nada porque ya tienen ficha.

### Reglas duras y reglas blandas

De los límites de longitud, **solo el de `seoTitle` es una restricción real** —el buscador recorta a
unos 60 caracteres—. Los demás los elegimos nosotros con criterio, no con evidencia. Así que tirar
una ficha entera y gastar otra llamada porque un bullet tiene 91 caracteres en vez de 90 es un mal
negocio.

`description.softRules` lista los códigos que **avisan en vez de tumbar**. Lo que se pasa de un
límite blando queda en el campo `warnings` de la ficha, así que quien la revise lo ve:

```yaml
description:
  softRules:
    - bulletLargo
    - entradaLarga
    - largo:seoDescription
    - largo:feedDescription
    - largo:bodyHtml
    - corto:seoDescription
```

**Lo que nunca debe ser blando**, y por qué:

| Código | Por qué tumba la ficha |
|---|---|
| `inventado` | Una añada, una graduación o un premio que el fichero no dice. Publicarlo es mentir |
| `promocional` | Google Merchant Center rechaza el relleno promocional en los feeds |
| `stuffing` | Repetir la keyword penaliza en buscador |
| `handleInvalido`, `handleDuplicado` | Un handle roto o repetido rompe la URL del producto |
| `textoDuplicado` | Dos fichas con el mismo texto es contenido duplicado |
| `largo:seoTitle` | Lo recorta el buscador: no es criterio nuestro |
| `faltaCampo`, `sinBloques` | Sin los seis campos no hay ficha |

### Los números del resumen

| | Qué mirar |
|---|---|
| `seconds` | Lo que ha tardado el lote de pared |
| `secondsPerCall` | El suelo. Latencia del proveedor: solo baja con otro modelo |
| `callsPerProduct` | **El número honesto**: llamadas por producto intentado, contando los que fallaron |
| `averageAttempts` | Intentos por ficha *escrita*. Útil, pero esconde el trabajo perdido: mira el de arriba |
| `peakReasoningChars` | Lo que razonó la llamada que más razonó. Si se acerca a `maxTokens` × 3, el presupuesto va al filo |
| `rejections` | Qué regla ha tumbado borradores y cuántas veces |

### Nada se publica sin revisar

El punto 7 del artículo pide revisión humana, y Google trata el contenido generado a escala sin
valor añadido como *scaled content abuse*. Así que las fichas nacen con `reviewed: false` y la
etapa 5 solo publicará las aprobadas:

```
catalog_seo(soloSinRevisar: true)   # verlas ANTES de aprobar
catalog_review(sku: "000048")       # una
catalog_review(skus: [...])         # varias
catalog_review(all: true)           # todas las pendientes
```

`catalog_seo` existe porque sin él la puerta no se puede cumplir: `catalog_describe` solo devuelve
una ficha de muestra, y el preset no monta ninguna herramienta de ficheros, así que ver las otras
tres exigía abrir el JSON a mano.

La persona del preset le dice al agente que no apruebe lo que ha escrito él, y que `all: true` es
solo para cuando lo pide el usuario después de ver las fichas. Es una convención sostenida por el
prompt, no por el código: el código no puede distinguir quién aprueba.

Los textos van a `output.seoJson` (`.artifacts/catalog-seo.json`), indexados por SKU y **aparte del
catálogo**: la normalización es determinista y se rehace entera en cada carga, así que mezclarlos
perdería lo generado en cada recarga. Se juntan por SKU al publicar.

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

```bash
./dsh.sh
```

Eso es todo. El script hace el ciclo entero y se para en el primer fallo:

| | Paso | Por qué |
|---|---|---|
| 1 | Comprueba que la versión coincide en los tres sitios | dsh lee el preset desplegado, no el repo: si no cuadran, enseña la vieja |
| 2 | `npm install` en `dsh-plugin/` | Idempotente; ~1 s cuando ya está al día |
| 3 | `npm test` | No despliega código que no pasa los tests |
| 4 | Comprueba que el perfil de dsh apunta a ESTE repo | Es un symlink: si ya apunta bien, no reinstala nada |
| 5 | Copia el preset a `~/.dsh/.agent-presets/` | Es lo único que hay que redesplegar de verdad |
| 6 | Arranca el plugin fuera de dsh y prueba las herramientas en seco | Carga `index.js` **desde la ruta del perfil** y llama a `catalog_load` y a `catalog_describe` con `dryRun`. Un import roto o un esquema inválido se ven aquí, no en el navegador |
| 7 | Para lo que hubiera escuchando en el puerto | Reiniciar sin buscar el proceso a mano. Con `-n` **no** lo para: te deja el que tenías |
| 8 | Arranca dsh en primer plano | Se para con `Ctrl-C` |

```bash
./dsh.sh                    # despliega y arranca
./dsh.sh -n                 # solo despliega y comprueba, no arranca
./dsh.sh --port 8080        # otro puerto
SKIP_TESTS=1 ./dsh.sh       # para iterar rápido
SKIP_VERSION_CHECK=1 ./dsh.sh
```

Cuando arranque, **abre sesión nueva** en el navegador: eso no lo puede hacer el script, y una
sesión ya abierta se queda con el código y el preset que tenía cuando se creó.

### Los mismos pasos a mano

Si prefieres verlos, o si el script falla y quieres ir por partes:

```bash
cd dsh-plugin && npm test && cd ..
cp agent-presets/catalog-agent/*.yml ~/.dsh/.agent-presets/catalog-agent/
npx @deepseek-ai/dsh@0.1.0-rc.6 web                  # http://localhost:3080
```

Fija la versión de dsh en el comando: `npx dsh` es otro paquete de npm y falla con `could not
determine executable to run`, y sin versión npx se baja la rc más nueva. El directorio desde el que
lanzas es la raíz de workspace de la sesión.

### No siempre hace falta todo

| Qué cambias | Qué hacer |
|---|---|
| `dsh-plugin/lib/*.js` | Reiniciar dsh + sesión nueva |
| `catalog.config.yml` (`description`, `source.dirs`) | Nada: se relee en cada llamada, incluidos los límites del prompt y el presupuesto del modelo |
| `dsh-plugin/package.json` (dependencias) | `npm install` en `dsh-plugin/`, reiniciar + sesión nueva. **El pin de `dsh.sh` va a la par**: el adaptador de DeepSeek cambia entre versiones |
| `agent.cordis.yml` o `preset.yml` | `cp` al preset desplegado + sesión nueva. **Sin reiniciar** |
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
├── entradas/                 # bandeja de entrada: los catálogos que se quieran cargar (en .gitignore)
├── dsh-plugin/               # el plugin nativo de dsh
│   ├── package.json          # nombre, versión y dependencias del harness
│   ├── lib/                   # un hexágono por tool (ver abajo)
│   └── test/                 # 85 tests con `node --test`, sin claves ni red
├── agent-presets/
│   └── catalog-agent/        # preset de agente versionado (preset.yml + agent.cordis.yml)
├── dsh.sh                    # despliega el plugin y arranca dsh, con sus comprobaciones
├── harness/env.py            # carga del .env para lo que queda en Python
├── eval/eval_session.py      # evaluación de sesiones reales de dsh (de la iteración anterior)
└── .artifacts/               # salida del pipeline (en .gitignore: contiene datos reales)
```

### Un hexágono por tool

> El detalle completo, con las reglas del reparto y el molde para las etapas 4 y 5, está en
> **[ARCHITECTURE.md](ARCHITECTURE.md)**. Todo cambio de arquitectura se documenta ahí: es la regla
> `.agent/rules/architecture-documented.md`.
>
> **El código está en inglés** —nombres y claves de salida—; los comentarios, la documentación y los
> mensajes que ve el usuario, en castellano.

```
dsh-plugin/lib/
├── index.js                       SOLO cableado: defineTool ×5, cero negocio
├── config.js                      cargar catalog.config.yml y resolver sus rutas
├── schemas.js                     los esquemas de salida que ven las tools
├── domain/
│   └── product.js                 el ÚNICO dominio compartido entre tools
├── catalog-load/
│   ├── infra/csv-source.js        entra: el CSV y las bandejas de entrada
│   ├── infra/catalog-store.js     sale: catalog.json
│   └── application/               orquesta: filas → dominio → JSON
├── catalog-describe/
│   ├── domain/seo-draft.js        su dominio propio: qué es una ficha válida
│   ├── infra/llm-adapter.js       entra/sale: el modelo y el parseo de bloques
│   ├── infra/catalog-reader.js    entra: el catálogo de la etapa 2
│   ├── infra/seo-store.js         sale: catalog-seo.json
│   └── application/               orquesta: prompt → modelo → valida → reintenta
└── catalog-review/
    └── application/               leer y aprobar fichas
```

Las reglas del reparto, que son lo que hay que respetar al añadir las etapas 4 y 5:

- **`domain/product.js` es el único dominio compartido.** Lo produce `catalog-load` y lo consumen
  las demás. `SeoDraft` no se fuerza ahí: solo lo usa una tool, así que vive en su hexágono.
- **El dominio es puro**: no lee ficheros, no llama a nadie, no sabe de dónde vienen sus datos. Por
  eso se testea con un fixture sin levantar dsh.
- **La aplicación orquesta y decide políticas** (reintentos, `regenerate`, el reparto del lote), pero
  no habla con el exterior: eso es de `infra/`.
- **`index.js` no tiene lógica de negocio.** Si aparece una regla de la tienda ahí, está en el sitio
  equivocado. Pasó de 1183 líneas a 567 con el refactor, y lo que queda son parámetros, esquemas y
  cómo se presenta el resultado.

El beneficio concreto: el bucle de reintentos y validación de la etapa 3 se prueba con un
`llm-adapter` falso, sin arrancar dsh y sin llamar a ningún modelo real. Es lo que hacen los tests de
`test/catalog-describe.test.js`.

## Tests

Las etapas 1 y 2 son deterministas, así que se prueban con el runner de Node contra el fixture
anonimizado. No hacen falta claves ni red:

```bash
cd dsh-plugin && npm test          # node --test "test/*.test.js"
```

Los 85 tests van uno por regla. De la normalización: las cinco maneras de escribir el formato del
envase, los precios con `€` y coma decimal, el separador de millares, las fechas `d/m/aaaa`, las
cuatro causas de rechazo, la capitalización con palabras llanas, la taxonomía y los tags. **Si un
cliente nuevo trae una rareza más, se añade una fila a `catalogo.example.csv` y su test aquí.**

De la etapa 3 se prueba el filtro, que es la parte que puede fallar en silencio: el modelo se
simula (`test/helpers.js`) y se comprueba que un borrador con keyword stuffing, con una añada
inventada, con lenguaje promocional o calcado de otra ficha **rebota**, que las correcciones le
vuelven al modelo, y que agotar los intentos no guarda basura.

Cinco tests salen directamente de fallos reales de producción, y son los que evitan que vuelvan: que
a `ctx.llm.stream()` le llegan el `reasoningEffort` y el `maxTokens` de la configuración; que una
respuesta truncada conserva los campos completos y solo pide los que faltan; que un modelo que
devuelve puro razonamiento corta el lote y nombra la causa; que el lote corre en paralelo con el
primero solo; y que **dos fichas del mismo trozo no pueden salir con el mismo handle**, que es el
riesgo que introduce el paralelismo — se redactan contra la misma foto de lo ya usado, así que la
colisión hay que resolverla al aceptar.

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
