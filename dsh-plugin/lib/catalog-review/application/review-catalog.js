/**
 * Aplicación de la revisión: leer las fichas y aprobarlas.
 *
 * Casi sin dominio propio: solo toca el almacén de fichas. Existe como capa
 * porque la puerta de revisión es una regla del negocio —nada se publica sin que
 * una persona lo haya visto— y conviene que tenga un sitio con nombre.
 *
 * @module dsh-plugin-catalog-agent/catalog-review/application/review-catalog
 */

import { loadDrafts, saveDrafts, draftsPath } from '../../catalog-describe/infra/seo-store.js'

/**
 * Las fichas guardadas, para poder leerlas antes de aprobar nada.
 * @param dominio - la configuración cargada.
 * @param args - `sku`, `skus`, `limit` o `soloSinRevisar`.
 * @returns las fichas elegidas y el recuento de lo que hay.
 */
export function readSeo(domainConfig, args = {}) {
  const storePath = draftsPath(domainConfig)
  const drafts = loadDrafts(storePath)
  const all = Object.values(drafts)

  const requestedSkus = [...(args.sku ? [args.sku.trim()] : []), ...(args.skus ?? []).map((s) => String(s).trim())]
  let chosen
  let notFound = []
  if (requestedSkus.length > 0) {
    chosen = requestedSkus.map((sku) => drafts[sku]).filter(Boolean)
    notFound = requestedSkus.filter((sku) => !drafts[sku])
  } else {
    const candidates = args.soloSinRevisar ? all.filter((f) => !f.reviewed) : all
    chosen = candidates.slice(0, args.limit ?? 4)
  }

  return {
    outputPath: storePath,
    total: all.length,
    unreviewed: all.filter((f) => !f.reviewed).length,
    drafts: chosen,
    notFound,
  }
}

/**
 * Marca fichas como revisadas por una persona.
 * @param dominio - la configuración cargada.
 * @param args - `sku`, `skus` o `all`.
 * @returns cuántas se han marcado y cuántas quedan.
 */
export function reviewCatalog(domainConfig, args = {}) {
  const storePath = draftsPath(domainConfig)
  const drafts = loadDrafts(storePath)

  const requestedSkus = [...(args.sku ? [args.sku.trim()] : []), ...(args.skus ?? []).map((s) => String(s).trim())]
  if (requestedSkus.length === 0 && !args.all) {
    throw new Error('di qué revisar: `sku`, `skus`, o `all: true` para todas las pendientes')
  }

  const targets = args.all ? Object.keys(drafts) : requestedSkus
  const withoutDraft = targets.filter((sku) => !drafts[sku])
  let newlyReviewed = 0
  let alreadyReviewed = 0
  for (const sku of targets) {
    const draft = drafts[sku]
    if (!draft) continue
    if (draft.reviewed) alreadyReviewed += 1
    else {
      draft.reviewed = true
      newlyReviewed += 1
    }
  }
  saveDrafts(storePath, drafts)

  return {
    outputPath: storePath,
    newlyReviewed,
    alreadyReviewed,
    unreviewed: Object.values(drafts).filter((draft) => !draft.reviewed).length,
    withoutDraft,
  }
}
