# Arquitectura de `catalog-agent`

> Un hexágono por tool. El código está en inglés; los comentarios y esta documentación, en
> castellano. Cada cambio de arquitectura se documenta aquí — es la regla
> `.agent/rules/architecture-documented.md`.

## Por qué esta forma

El plugin lleva productos desde un fichero de un ERP hasta una tienda de Shopify, en cinco etapas.
Cada etapa tiene **su propia dependencia externa y su propio modo de fallo**: un CSV con formatos
locales, un modelo de lenguaje que a veces no escribe nada, un proveedor de imágenes, la API de
Shopify. Meterlas todas en un fichero llevaba a 2.000 líneas donde un `fs.writeFileSync` convivía con
una regla de negocio de la tienda.

La respuesta no es una arquitectura hexagonal canónica con puertos formales, que para tres tools
sería sobre-ingeniería. Es la parte que paga: **cada tool es su propio hexágono**, con su carpeta de
infraestructura y su carpeta de aplicación, y un único dominio compartido.

## El árbol

```
dsh-plugin/lib/
├── index.ts                       adaptador primario: defineTool ×5, cero negocio
├── config.ts                      cargar catalog.config.yml y resolver sus rutas (CatalogConfig)
├── schemas.ts                     esquemas de salida compartidos
├── errors.ts                      lo único que estrecha el `unknown` de un catch
│
├── domain/
│   └── product.ts                 el ÚNICO dominio compartido entre tools
│
├── catalog-load/                  etapas 1 y 2: ingesta y normalización
│   ├── infra/csv-source.ts        entra: el CSV y las bandejas de entrada
│   ├── infra/catalog-store.ts     sale: catalog.json
│   └── application/
│       ├── load-catalog.ts        orquesta: filas → dominio → JSON
│       └── list-sources.ts        qué ficheros hay para cargar
│
├── catalog-describe/              etapa 3: textos SEO
│   ├── domain/seo-draft.ts        su dominio propio: qué es una ficha válida
│   ├── infra/llm-adapter.ts       entra/sale: el modelo y el parseo de su respuesta
│   ├── infra/catalog-reader.ts    entra: el catálogo de la etapa 2
│   ├── infra/seo-store.ts         sale: catalog-seo.json
│   └── application/describe-catalog.ts   prompt → modelo → valida → reintenta
│
└── catalog-review/                la puerta de revisión humana
    └── application/review-catalog.ts    leer fichas y aprobarlas
```

## Las tres capas, y qué va en cada una

| Capa | Qué es | Qué NO puede hacer |
|---|---|---|
| **`domain/`** | Las reglas del negocio: qué es un producto publicable, qué es una ficha SEO válida | Leer ficheros, llamar a nadie, saber de dónde vienen sus datos |
| **`infra/`** | Todo lo que habla con el exterior: CSV, JSON en disco, el modelo | Decidir políticas de negocio |
| **`application/`** | La orquestación y las políticas: reintentos, `regenerate`, el reparto del lote | Hablar con el exterior directamente |
| **`index.js`** | El adaptador primario: parámetros, esquemas, presentación, cableado | Tener una sola regla de negocio |

La prueba del algodón de que el reparto está bien: **`index.js` no importa `node:fs` ni toca
`ctx.llm`**, y el dominio se testea con un fixture sin levantar dsh.

## Las tres decisiones que hay que respetar

### 1. `Product` es el único dominio compartido

Lo produce `catalog-load` y lo consumen las demás etapas. `SeoDraft` **no** se fuerza a dominio
compartido: solo lo usa `catalog-describe`, así que vive dentro de su hexágono. La regla al añadir una
etapa: **un concepto sube a `domain/` cuando lo usan dos tools, no antes.**

### 2. Las etapas consumen la salida de la anterior, no la fuente original

`catalog-describe` lee `catalog.json`, no el CSV. Así describe lo que el usuario cargó de verdad,
aunque no fuera el catálogo habitual. Esto se rompió una vez —la etapa 3 releía el fichero
configurado y describía productos de otro catálogo, en silencio— y por eso está escrito aquí.

### 3. Dónde va cada pieza de la etapa 3

Es el reparto menos obvio, y sirve de plantilla para las etapas 4 y 5:

| Pieza | Capa | Por qué |
|---|---|---|
| `buildPrompt` | aplicación | Combina reglas del cliente (config) con el producto: es orquestación |
| `parseBlocks` | infraestructura | Parsear el texto crudo del modelo es adaptar una representación externa |
| `validateDraft`, `slugify`, `keywords` | dominio | Son las reglas de qué es una ficha válida |
| el bucle de reintentos | aplicación | Es una política: cuántas veces, con qué correcciones |
| `ctx.llm.stream` | infraestructura | Es la dependencia externa |

## El beneficio, comprobado

El bucle de reintentos y validación de la etapa 3 se ejercita con un `llm-adapter` falso, **sin
arrancar dsh y sin llamar a ningún modelo real**. Es lo que hacen los tests de
`test/catalog-describe.test.ts`: se le dan al doble del modelo respuestas preparadas —una vacía, una
truncada, una que incumple una regla— y se comprueba que el lote reacciona como debe.

## Lenguaje e idioma

**TypeScript, sin paso de compilación.** Node hace *type stripping* y ejecuta los `.ts` tal cual, así
que no hay `dist/` ni build que olvidar. `tsc --noEmit` es solo el comprobador de tipos, y `dsh.sh`
lo ejecuta como paso propio.

Dos consecuencias que hay que respetar:

- **Los imports relativos llevan la extensión real** (`from './schemas.ts'`), porque en ejecución los
  resuelve Node y no un bundler. De ahí `allowImportingTsExtensions` en `tsconfig.json`.
- **El plugin tiene que quedarse enlazado, no copiado.** Node se niega a hacer type stripping bajo
  `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), y funciona solo porque
  `dsh plugin add` monta un symlink al repo y Node resuelve el enlace al path real antes de decidir.
  Si algún día el plugin se instalara desde un tarball, dejaría de arrancar.

`tsconfig.json` lleva `erasableSyntaxOnly`: rechaza en compilación lo que el stripping no sabe
borrar (`enum`, `namespace`, propiedades de parámetro). Sin eso, `tsc` aprobaría código que revienta
al ejecutar.

Y el tipado no es decorativo: `defineTool` es genérico sobre el esquema de parámetros y el de salida,
así que `execute` está **obligado** a devolver exactamente lo que declara `output.schema`.
`test/typing.ts` lo fija con un `@ts-expect-error`: si alguien desconecta ese cableado, `tsc` falla
con «Unused '@ts-expect-error' directive».

### Idioma

- **Código en inglés**: nombres de funciones, variables, parámetros y **claves de las salidas**.
- **Comentarios y documentación en castellano**, incluida esta página y el README.
- **Los mensajes que ve el usuario, en castellano**: son producto, no código.
- **Los códigos de regla se quedan como están** (`sinFormato`, `bulletLargo`): son datos de salida
  con historia en los logs, y renombrarlos rompería la comparación con las medidas anteriores.

## Al añadir las etapas 4 y 5

Cada una es su propio hexágono, siguiendo el mismo molde:

```
catalog-image/                     etapa 4
├── infra/image-search.ts          entra: el proveedor de búsqueda
├── infra/image-generator.ts       entra: el proveedor de generación
├── infra/image-store.ts           sale: los ficheros en disco
└── application/describe-image.ts  política: buscar primero, generar si no hay

catalog-publish/                   etapa 5
├── infra/shopify-client.ts        entra/sale: la Admin API
├── infra/publish-log.ts           sale: qué se publicó y cuándo
└── application/publish-catalog.ts política: dryRun, lotes, qué campos se escriben
```

Lo que **no** hay que hacer: meter el cliente de Shopify en `domain/`, ni la política de `dryRun` en
`infra/`, ni una sola regla de negocio en `index.js`.
