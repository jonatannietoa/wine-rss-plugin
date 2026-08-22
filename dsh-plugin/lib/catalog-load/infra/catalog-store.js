/**
 * Adaptador de salida de la carga: el JSON de catálogo normalizado.
 *
 * Es lo que consumen las etapas 3, 4 y 5. Se escribe a disco y no se devuelve al
 * modelo porque 800 productos son unos 480 KB y el podador del preset corta los
 * resultados de herramienta a 8192 caracteres.
 *
 * @module dsh-plugin-catalog-agent/catalog-load/infra/catalog-store
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { resolveFromConfig } from '../../config.js'

/**
 * Dónde va el catálogo normalizado.
 * @param config - la configuración cargada.
 * @returns la ruta absoluta del JSON.
 */
export function rutaCatalogo(config) {
  return resolveFromConfig(config, config.output?.catalogJson ?? './.artifacts/catalog.json')
}

/**
 * Guarda el catálogo normalizado.
 * @param config - la configuración cargada.
 * @param catalog - el catálogo con sus productos y sus rechazos.
 * @returns la ruta donde ha quedado.
 */
export function guardarCatalogo(config, catalog) {
  const path = rutaCatalogo(config)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
  return path
}
