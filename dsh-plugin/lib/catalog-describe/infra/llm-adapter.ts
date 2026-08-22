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
import { SEO_FIELDS, type SeoDraft } from '../domain/seo-draft.ts'
import { codeOf, messageOf } from '../../errors.ts'

/** Lo que hace falta para pedirle una ficha al modelo. */
export interface DraftRequest {
  readonly model: { readonly provider: string, readonly model: string }
  readonly system: string
  readonly user: string
  readonly reasoningEffort: string
  readonly maxTokens: number
  readonly temperature?: number
  readonly plugin: string
  readonly signal?: AbortSignal
}

/** El servicio `llm` del host, en lo que este adaptador usa de él. */
export interface LlmCapable {
  readonly llm: { stream(options: Record<string, unknown>): AsyncIterable<{ type: string, text?: string }> }
}

/** Cuánto de la respuesta cruda se guarda para poder diagnosticar un fallo. */
const MAX_CRUDA = 500

/**
 * Pide una ficha al modelo y devuelve lo que dijo, sin interpretarlo.
 *
 * @param ctx - el contexto Cordis, por su servicio `llm`.
 * @param peticion - `{ modelo, system, user, reasoningEffort, maxTokens, temperature, plugin, signal }`.
 * @returns `{ texto, razonamiento, milisegundos }`.
 */
export async function requestDraft(ctx: LlmCapable, request: DraftRequest):
Promise<{ text: string, reasoning: number, durations: number, raw: string }> {
  const start = Date.now()
  let text = ''
  let reasoning = 0
  try {
    for await (const chunk of ctx.llm.stream({
      provider: request.model.provider,
      model: request.model.model,
      system: request.system,
      messages: [createUserMessage({
        content: [{ type: 'text', text: request.user }],
        source: { kind: 'plugin', plugin: request.plugin, contextForm: 'transient' },
      })],
      reasoningEffort: request.reasoningEffort,
      maxTokens: request.maxTokens,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      signal: request.signal,
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'reasoning-delta') reasoning += chunk.text.length
    }
  } catch (error) {
    // Qué esfuerzos acepta el adaptador depende de su versión, y el error crudo
    // no dice de dónde sale el valor ni cuáles valen.
    if (codeOf(error) === 'UNSUPPORTED_REASONING_EFFORT' || /reasoning effort/i.test(messageOf(error))) {
      throw new Error(
        `el proveedor no acepta el esfuerzo de razonamiento "${request.reasoningEffort}". `
        + 'Sale de `description.reasoningEffort` en catalog.config.yml (o del parámetro '
        + '`reasoningEffort` de esta llamada). DeepSeek acepta off, high y max en todas sus '
        + `versiones, y low solo desde rc.8. Mensaje del proveedor: ${messageOf(error)}`,
      )
    }
    throw error
  }
  return { text, reasoning, durations: Date.now() - start, raw: text.slice(0, MAX_CRUDA) }
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
export function parseBlocks(raw: unknown): SeoDraft {
  const text = String(raw ?? '').replace(/^\s*```[a-z]*\s*$|^\s*```\s*$/gim, '')
  const borrador = {}
  for (const campo of SEO_FIELDS) borrador[campo] = ''

  // `### campo` en su propia línea abre un bloque; se cierra con el siguiente.
  const header = new RegExp(`^[ \\t]*#{1,6}[ \\t]*(${SEO_FIELDS.join('|')})[ \\t]*:?[ \\t]*$`, 'gim')
  const headings = [...text.matchAll(header)]
  if (headings.length === 0) {
    throw new Error(
      'la respuesta no trae ningún bloque "### campo": '
      + `${text.trim() ? `empieza por "${text.trim().slice(0, 80)}…"` : 'está vacía'}`,
    )
  }

  // La cabecera se compara sin distinguir mayúsculas, así que hay que volver al
  // nombre canónico del campo: `#### Handle:` es `handle`.
  const canonicalName = new Map(SEO_FIELDS.map((campo) => [campo.toLowerCase(), campo]))
  headings.forEach((marca, index) => {
    const from = marca.index + marca[0].length
    const to = index + 1 < headings.length ? headings[index + 1].index : text.length
    borrador[canonicalName.get(marca[1].toLowerCase())] = text.slice(from, to).trim()
  })
  return borrador
}
