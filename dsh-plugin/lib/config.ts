/**
 * La configuración de dominio de la tienda: cargarla y resolver sus rutas.
 *
 * Es lo único que comparten todos los hexágonos, porque todos necesitan saber qué
 * dice el `catalog.config.yml` del cliente. No conoce ninguna tool.
 *
 * @module dsh-plugin-catalog-agent/config
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { load as loadYaml } from 'js-yaml'
import { messageOf } from './errors.ts'

/**
 * La configuración de dominio de la tienda, tal como la declara
 * `catalog.config.yml`.
 *
 * Existe porque el YAML entra como `any` y de ahí salen TODOS los accesos del
 * plugin: sin este tipo, `config.description.maxTokens` mal escrito no lo caza
 * nadie. Los campos son opcionales porque el fichero de un cliente puede no
 * traerlos y cada consumidor decide su valor por defecto; los obligatorios los
 * valida {@link loadConfig} en ejecución, que es donde se puede dar un mensaje
 * útil.
 */
export interface CatalogConfig {
  readonly version?: number
  /** Añadido por {@link loadConfig}: contra qué se resuelven las rutas relativas. */
  readonly baseDir?: string

  readonly source: {
    readonly path: string
    readonly format?: string
    readonly encoding?: BufferEncoding
    readonly delimiter?: string
    readonly trimHeaders?: boolean
    readonly dateFormat?: string
    readonly decimalSeparator?: string
    readonly thousandsSeparator?: string
    readonly currencySymbol?: string
    /** Bandejas de entrada. `dir` es la forma antigua, de una sola carpeta. */
    readonly dirs?: readonly string[]
    readonly dir?: string
    readonly pattern?: string
  }

  readonly columns: Readonly<Record<string, string>>

  readonly normalize?: {
    readonly titleCase?: boolean | {
      readonly enabled?: boolean
      readonly lowercaseWords?: readonly string[]
      readonly keepUppercase?: readonly string[]
    }
    readonly extractFormat?: {
      readonly enabled?: boolean
      readonly optionName?: string
      readonly patterns?: readonly string[]
    }
    readonly blocked?: {
      readonly trueValues?: readonly string[]
      readonly falseValues?: readonly string[]
    }
    readonly skipRows?: {
      readonly emptySku?: boolean
      readonly negativeStock?: boolean
    }
  }

  readonly taxonomy: {
    readonly groups: Readonly<Record<string, { productType?: string, tags?: readonly string[] }>>
    readonly productionTypes?: Readonly<Record<string, string>>
    readonly suppliers?: Readonly<Record<string, string>>
    readonly origin?: { readonly asTag?: boolean, readonly metafield?: string }
  }

  readonly output?: {
    readonly catalogJson?: string
    readonly seoJson?: string
  }

  readonly description?: DescriptionConfig
}

/** Lo que gobierna la etapa 3: qué se le pide al modelo y qué se le valida. */
export interface DescriptionConfig {
  readonly language?: string
  readonly tone?: string
  readonly audience?: string

  readonly seoTitle?: FieldLimits
  readonly seoDescription?: FieldLimits
  readonly bodyHtml?: FieldLimits & {
    readonly leadMaxWords?: number
    readonly bullets?: { readonly min: number, readonly max: number, readonly maxChars: number }
    readonly allowTags?: readonly string[]
  }
  readonly altText?: FieldLimits
  readonly feedDescription?: FieldLimits
  readonly handle?: FieldLimits

  readonly fields?: readonly string[]
  readonly keywordsFrom?: readonly string[]
  readonly forbid?: readonly string[]
  readonly forbidPatterns?: readonly string[]
  readonly forbidPhrases?: readonly string[]
  readonly maxKeywordRepeats?: number

  /**
   * Códigos de regla que solo avisan en vez de tumbar la ficha.
   *
   * Existe porque medimos que, con el razonamiento apagado, el modelo se pasa de
   * los topes de longitud por 1-5 caracteres: rehacer la ficha entera por eso
   * cuesta una llamada completa. Y de esos límites solo `seoTitle` es una
   * restricción real del buscador; el resto los elegimos nosotros.
   */
  readonly softRules?: readonly string[]

  /**
   * `off` apaga el razonamiento; los demás lo dejan encendido y consume del
   * mismo `maxTokens` que el texto. NO se tipa como unión de literales a
   * propósito: los valores que acepta dependen de la versión del adaptador de
   * DeepSeek, que no se puede fijar, así que la comprobación de verdad está en
   * `dsh.sh` y en el error del adaptador.
   */
  readonly reasoningEffort?: string
  readonly maxTokens?: number
  readonly temperature?: number
  readonly provider?: string
  readonly model?: string

  readonly maxAttempts?: number
  readonly concurrency?: number
  readonly probeFirst?: 'auto' | 'always' | 'never'
  readonly maxPerCall?: number
  readonly regenerate?: 'missing' | 'always' | 'never'
}

/** Los límites de longitud de un campo de la ficha. */
export interface FieldLimits {
  readonly maxChars?: number
  readonly minChars?: number
}

/** Campos sin los que no se puede construir un producto publicable. */
export const REQUIRED_COLUMNS = ['sku', 'title', 'price', 'stock', 'group']

/**
 * Carga y valida la configuración de dominio.
 *
 * Falla aquí, y no trescientas filas más tarde, cuando el fichero de otro cliente
 * no cuadra: el mensaje dice qué falta.
 * @param configPath - ruta del `catalog.config.yml`.
 * @returns la configuración, con `baseDir` para resolver sus rutas relativas.
 */
export function loadConfig(configPath: string): CatalogConfig {
  const path = resolve(configPath)
  let raw
  try {
    raw = loadYaml(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`no se pudo leer la configuración en ${path}: ${messageOf(error)}`)
  }
  if (!raw || typeof raw !== 'object') throw new Error(`la configuración en ${path} está vacía`)
  // Aquí `raw` es lo que trajo el YAML: `loadConfig` valida lo que se usa y lo
  // devuelve tipado, y es el único sitio del plugin donde se hace esa promesa.
  const yaml = raw as Partial<CatalogConfig>

  const problems = []
  if (!yaml.source?.path) problems.push('falta source.path')
  if (yaml.source?.format !== 'csv') {
    problems.push(`source.format debe ser "csv" (dice "${yaml.source?.format ?? 'nada'}"): esta etapa solo lee CSV`)
  }
  for (const key of REQUIRED_COLUMNS) {
    if (!yaml.columns?.[key]) problems.push(`falta columns.${key}`)
  }
  if (!yaml.taxonomy?.groups || typeof yaml.taxonomy.groups !== 'object') {
    problems.push('falta taxonomy.groups: sin él no hay con qué categorizar en Shopify')
  }
  if (problems.length > 0) {
    throw new Error(`configuración inválida en ${path}: ${problems.join('; ')}`)
  }

  return { ...(yaml as CatalogConfig), baseDir: dirname(path) }
}

/**
 * Resuelve una ruta de la configuración. Las relativas cuelgan del directorio del
 * propio `catalog.config.yml`, no del directorio de trabajo de la sesión, y `~`
 * es el home del usuario.
 * @param config - la configuración cargada.
 * @param path - la ruta declarada.
 * @returns la ruta absoluta.
 */
export function resolveFromConfig(config: CatalogConfig, path: string): string {
  const text = String(path ?? '')
  if (text === '~' || text.startsWith(`~${sep}`) || text.startsWith('~/')) {
    return join(homedir(), text.slice(1))
  }
  return isAbsolute(text) ? text : resolve(config.baseDir ?? '.', text)
}
