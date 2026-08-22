/**
 * Adaptador del modelo: hablar con `ctx.llm` y entender lo que devuelve.
 *
 * Aquí está lo que es representación externa y no regla de negocio: montar la
 * petición, acumular el stream, medir cuánto tardó y cuánto razonó, y sacar los
 * seis campos del texto crudo. La capa de aplicación recibe una ficha ya
 * parseada y no sabe que detrás hay un stream.
 *
 * @module dsh-plugin-catalog-agent/catalog-describe/infra/llm-adapter
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import { SEO_FIELDS } from '../domain/seo-draft.js'

/** Cuánto de la respuesta cruda se guarda para poder diagnosticar un fallo. */
const MAX_CRUDA = 500

/**
 * Pide una ficha al modelo y devuelve lo que dijo, sin interpretarlo.
 *
 * @param ctx - el contexto Cordis, por su servicio `llm`.
 * @param peticion - `{ modelo, system, user, reasoningEffort, maxTokens, temperature, plugin, signal }`.
 * @returns `{ texto, razonamiento, milisegundos }`.
 */
export async function pedirFicha(ctx, peticion) {
  const arranque = Date.now()
  let texto = ''
  let razonamiento = 0
  try {
    for await (const trozo of ctx.llm.stream({
      provider: peticion.modelo.provider,
      model: peticion.modelo.model,
      system: peticion.system,
      messages: [createUserMessage({
        content: [{ type: 'text', text: peticion.user }],
        source: { kind: 'plugin', plugin: peticion.plugin, contextForm: 'transient' },
      })],
      reasoningEffort: peticion.reasoningEffort,
      maxTokens: peticion.maxTokens,
      ...(peticion.temperature === undefined ? {} : { temperature: peticion.temperature }),
      signal: peticion.signal,
    })) {
      if (trozo.type === 'text-delta') texto += trozo.text
      else if (trozo.type === 'reasoning-delta') razonamiento += trozo.text.length
    }
  } catch (error) {
    // Qué esfuerzos acepta el adaptador depende de su versión, y el error crudo
    // no dice de dónde sale el valor ni cuáles valen.
    if (error?.code === 'UNSUPPORTED_REASONING_EFFORT' || /reasoning effort/i.test(error?.message ?? '')) {
      throw new Error(
        `el proveedor no acepta el esfuerzo de razonamiento "${peticion.reasoningEffort}". `
        + 'Sale de `description.reasoningEffort` en catalog.config.yml (o del parámetro '
        + '`reasoningEffort` de esta llamada). DeepSeek acepta off, high y max en todas sus '
        + `versiones, y low solo desde rc.8. Mensaje del proveedor: ${error.message}`,
      )
    }
    throw error
  }
  return { texto, razonamiento, milisegundos: Date.now() - arranque, cruda: texto.slice(0, MAX_CRUDA) }
}

/**
 * Saca los seis campos de la respuesta del modelo.
 *
 * El formato son bloques con cabecera en lugar de JSON porque el HTML dentro de
 * una cadena JSON era la parte frágil: había que escaparlo, y un corte a media
 * cadena tiraba la ficha entera. Con bloques, lo que llegó completo se conserva y
 * la validación pide solo lo que falta.
 *
 * Tolerante con lo que el modelo añade de su cosecha: se ignora cualquier
 * preámbulo antes del primer bloque, las cabeceras que no reconoce y el markdown
 * de cercado. Un campo que no aparece se queda vacío, y de eso ya avisa
 * {@link validateDraft}.
 * @param raw - el texto que devolvió el modelo.
 * @returns el borrador con los seis campos, ya recortados.
 */
export function parseBlocks(raw) {
  const texto = String(raw ?? '').replace(/^\s*```[a-z]*\s*$|^\s*```\s*$/gim, '')
  const borrador = {}
  for (const campo of SEO_FIELDS) borrador[campo] = ''

  // `### campo` en su propia línea abre un bloque; se cierra con el siguiente.
  const cabecera = new RegExp(`^[ \\t]*#{1,6}[ \\t]*(${SEO_FIELDS.join('|')})[ \\t]*:?[ \\t]*$`, 'gim')
  const marcas = [...texto.matchAll(cabecera)]
  if (marcas.length === 0) {
    throw new Error(
      'la respuesta no trae ningún bloque "### campo": '
      + `${texto.trim() ? `empieza por "${texto.trim().slice(0, 80)}…"` : 'está vacía'}`,
    )
  }

  // La cabecera se compara sin distinguir mayúsculas, así que hay que volver al
  // nombre canónico del campo: `#### Handle:` es `handle`.
  const canonico = new Map(SEO_FIELDS.map((campo) => [campo.toLowerCase(), campo]))
  marcas.forEach((marca, indice) => {
    const desde = marca.index + marca[0].length
    const hasta = indice + 1 < marcas.length ? marcas[indice + 1].index : texto.length
    borrador[canonico.get(marca[1].toLowerCase())] = texto.slice(desde, hasta).trim()
  })
  return borrador
}
