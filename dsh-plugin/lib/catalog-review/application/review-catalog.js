/**
 * Aplicación de la revisión: leer las fichas y aprobarlas.
 *
 * Casi sin dominio propio: solo toca el almacén de fichas. Existe como capa
 * porque la puerta de revisión es una regla del negocio —nada se publica sin que
 * una persona lo haya visto— y conviene que tenga un sitio con nombre.
 *
 * @module dsh-plugin-catalog-agent/catalog-review/application/review-catalog
 */

import { cargarSeo, guardarSeo, rutaSeo } from '../../catalog-describe/infra/seo-store.js'

/**
 * Las fichas guardadas, para poder leerlas antes de aprobar nada.
 * @param dominio - la configuración cargada.
 * @param args - `sku`, `skus`, `limit` o `soloSinRevisar`.
 * @returns las fichas elegidas y el recuento de lo que hay.
 */
export function readSeo(dominio, args = {}) {
  const salida = rutaSeo(dominio)
  const fichas = cargarSeo(salida)
  const todas = Object.values(fichas)

  const pedidos = [...(args.sku ? [args.sku.trim()] : []), ...(args.skus ?? []).map((s) => String(s).trim())]
  let elegidas
  let noEncontrados = []
  if (pedidos.length > 0) {
    elegidas = pedidos.map((sku) => fichas[sku]).filter(Boolean)
    noEncontrados = pedidos.filter((sku) => !fichas[sku])
  } else {
    const candidatas = args.soloSinRevisar ? todas.filter((f) => !f.reviewed) : todas
    elegidas = candidatas.slice(0, args.limit ?? 4)
  }

  return {
    outputPath: salida,
    total: todas.length,
    sinRevisar: todas.filter((f) => !f.reviewed).length,
    fichas: elegidas,
    noEncontrados,
  }
}

/**
 * Marca fichas como revisadas por una persona.
 * @param dominio - la configuración cargada.
 * @param args - `sku`, `skus` o `all`.
 * @returns cuántas se han marcado y cuántas quedan.
 */
export function reviewCatalog(dominio, args = {}) {
  const salida = rutaSeo(dominio)
  const fichas = cargarSeo(salida)

  const pedidos = [...(args.sku ? [args.sku.trim()] : []), ...(args.skus ?? []).map((s) => String(s).trim())]
  if (pedidos.length === 0 && !args.all) {
    throw new Error('di qué revisar: `sku`, `skus`, o `all: true` para todas las pendientes')
  }

  const objetivo = args.all ? Object.keys(fichas) : pedidos
  const sinFicha = objetivo.filter((sku) => !fichas[sku])
  let revisadas = 0
  let yaEstaban = 0
  for (const sku of objetivo) {
    const ficha = fichas[sku]
    if (!ficha) continue
    if (ficha.reviewed) yaEstaban += 1
    else {
      ficha.reviewed = true
      revisadas += 1
    }
  }
  guardarSeo(salida, fichas)

  return {
    outputPath: salida,
    revisadas,
    yaEstaban,
    sinRevisar: Object.values(fichas).filter((ficha) => !ficha.reviewed).length,
    sinFicha,
  }
}
