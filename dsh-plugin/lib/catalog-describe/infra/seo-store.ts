/**
 * Adaptador de salida: el almacén de fichas SEO.
 *
 * Va aparte del catálogo a propósito: la normalización es determinista y se
 * rehace entera en cada carga, así que mezclar aquí lo generado lo perdería.
 * Lo usan la etapa 3 para escribir y la revisión para aprobar.
 *
 * @module dsh-plugin-catalog-agent/catalog-describe/infra/seo-store
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { resolveFromConfig, type CatalogConfig } from '../../config.ts'
import type { StoredDraft } from '../domain/seo-draft.ts'
import { messageOf } from '../../errors.ts'

/** Resuelve la ruta del almacén SEO declarada en la configuración. */
export const draftsPath = (domainConfig: CatalogConfig): string =>
  resolveFromConfig(domainConfig, domainConfig.output?.seoJson ?? './.artifacts/catalog-seo.json')

/**
 * Lee el almacén de textos SEO. No existir es lo normal la primera vez.
 * @param path - ruta del JSON.
 * @returns las fichas indexadas por SKU.
 */
export function loadDrafts(path: string): Record<string, StoredDraft> {
  if (!existsSync(path)) return {}
  let data
  try {
    data = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`no se pudo leer ${path}: ${messageOf(error)}`)
  }
  return data?.items && typeof data.items === 'object' ? data.items : {}
}

/**
 * Guarda el almacén de textos SEO.
 * @param path - ruta del JSON.
 * @param items - las fichas indexadas por SKU.
 */
export function saveDrafts(path: string, items: Record<string, StoredDraft>): void {
  mkdirSync(dirname(path), { recursive: true })
  const contenido = { generatedAt: new Date().toISOString(), items }
  writeFileSync(path, `${JSON.stringify(contenido, null, 2)}\n`, 'utf8')
}
