/**
 * Adaptador de entrada: el catálogo que dejó la última carga.
 *
 * Las etapas 3, 4 y 5 consumen la salida de la 2, no el fichero del ERP: así
 * describen lo que el usuario cargó de verdad, aunque no fuera el habitual.
 *
 * @module dsh-plugin-catalog-agent/catalog-describe/infra/catalog-reader
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolveFromConfig } from '../../config.js'

/**
 * El catálogo que dejó la última carga.
 *
 * Las etapas 3, 4 y 5 consumen la salida de la 2, no el fichero de entrada: así
 * describen lo que el usuario cargó de verdad, aunque no sea el habitual.
 * @param dominio - la configuración cargada.
 * @returns el catálogo con sus productos.
 */
export
function cargarCatalogo(dominio) {
  const path = resolveFromConfig(dominio, dominio.output?.catalogJson ?? './.artifacts/catalog.json')
  if (!existsSync(path)) {
    throw new Error(
      `no hay catálogo cargado (falta ${path}). Llama antes a catalog_load, y si el usuario quiere `
      + 'un fichero concreto, pásale su nombre en `path`.',
    )
  }
  let datos
  try {
    datos = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`no se pudo leer el catálogo cargado en ${path}: ${error.message}`)
  }
  if (!Array.isArray(datos?.items)) throw new Error(`${path} no tiene una lista de productos`)
  return datos
}
