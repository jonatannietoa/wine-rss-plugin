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

/** Campos sin los que no se puede construir un producto publicable. */
export
const REQUIRED_COLUMNS = ['sku', 'title', 'price', 'stock', 'group']

/**
 * Carga y valida la configuración de dominio.
 *
 * Falla aquí, y no trescientas filas más tarde, cuando el fichero de otro cliente
 * no cuadra: el mensaje dice qué falta.
 * @param configPath - ruta del `catalog.config.yml`.
 * @returns la configuración, con `baseDir` para resolver sus rutas relativas.
 */
export function loadConfig(configPath) {
  const path = resolve(configPath)
  let raw
  try {
    raw = loadYaml(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`no se pudo leer la configuración en ${path}: ${error.message}`)
  }
  if (!raw || typeof raw !== 'object') throw new Error(`la configuración en ${path} está vacía`)

  const problemas = []
  if (!raw.source?.path) problemas.push('falta source.path')
  if (raw.source?.format !== 'csv') {
    problemas.push(`source.format debe ser "csv" (dice "${raw.source?.format ?? 'nada'}"): esta etapa solo lee CSV`)
  }
  for (const clave of REQUIRED_COLUMNS) {
    if (!raw.columns?.[clave]) problemas.push(`falta columns.${clave}`)
  }
  if (!raw.taxonomy?.groups || typeof raw.taxonomy.groups !== 'object') {
    problemas.push('falta taxonomy.groups: sin él no hay con qué categorizar en Shopify')
  }
  if (problemas.length > 0) {
    throw new Error(`configuración inválida en ${path}: ${problemas.join('; ')}`)
  }

  return { ...raw, baseDir: dirname(path) }
}

/**
 * Resuelve una ruta de la configuración. Las relativas cuelgan del directorio del
 * propio `catalog.config.yml`, no del directorio de trabajo de la sesión, y `~`
 * es el home del usuario.
 * @param config - la configuración cargada.
 * @param path - la ruta declarada.
 * @returns la ruta absoluta.
 */
export function resolveFromConfig(config, path) {
  const texto = String(path ?? '')
  if (texto === '~' || texto.startsWith(`~${sep}`) || texto.startsWith('~/')) {
    return join(homedir(), texto.slice(1))
  }
  return isAbsolute(texto) ? texto : resolve(config.baseDir ?? '.', texto)
}
