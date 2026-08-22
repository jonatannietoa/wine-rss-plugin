/**
 * Aplicación de la etapa 3: orquesta catálogo → prompt → modelo → validación.
 *
 * Aquí vive lo que no es ni dominio ni infraestructura: construir el prompt
 * combinando las reglas del cliente con el producto, el bucle de reintentos, el
 * reparto del lote en paralelo y la política de qué se rehace.
 *
 * El bucle de reintentos está aquí y no en el agente a propósito: son cientos de
 * productos, y meter cada corrección en la conversación llenaría el contexto.
 *
 * @module dsh-plugin-catalog-agent/catalog-describe/application/describe-catalog
 */

import { FIELD_ROLES, SEO_FIELDS, keywords, readable, validateDraft } from '../domain/seo-draft.js'
import { parseBlocks, requestDraft } from '../infra/llm-adapter.js'
import { readCatalog } from '../infra/catalog-reader.js'
import { loadDrafts, saveDrafts, draftsPath } from '../infra/seo-store.js'

/** Los datos del producto que el modelo puede ver, y ninguno más. */
function visibleFields(product, config) {
  const campos = config.description?.fields ?? ['title', 'productType']
  const data = {}
  for (const campo of campos) {
    const value = readable(product, campo, config)
    if (value !== null) data[campo] = value
  }
  return data
}

/**
 * Construye el prompt de un producto.
 *
 * Las cifras salen de la configuración, no del texto: cambiar un límite en
 * `catalog.config.yml` cambia lo que se le pide al modelo y lo que se le valida
 * después, que es la única forma de que no se contradigan.
 * @param product - el producto normalizado.
 * @param config - la configuración cargada.
 * @param problemas - lo que hay que corregir de un intento anterior.
 * @returns `{ system, user }`, los dos textos de la llamada.
 */
export function buildPrompt(product, config, problems = []) {
  const d = config.description ?? {}
  const bullets = d.bodyHtml?.bullets ?? { min: 3, max: 5, maxChars: 90 }
  const keywordList = keywords(product, config)

  const system = [
    `Escribes fichas de producto para una tienda online, en ${d.language ?? 'es'}.`,
    d.tone ? `Tono: ${d.tone}` : '',
    d.audience ? `Le hablas a: ${d.audience}` : '',
    '',
    'Cómo se escribe una ficha que rinde en buscador:',
    '- Escribe para quien compra, no para el buscador. Di qué es el producto, para quién y cómo se usa.',
    '- Primero el beneficio y luego el dato que lo sostiene. El dato solo no vende: explica qué le hace al comprador.',
    '- La primera frase dice qué es el producto. Sin rodeos ni frases de apertura vacías.',
    '- Usa las keywords donde importan (título, primera frase, metadatos) y solo si describen el producto de verdad.',
    `- Nunca repitas la misma keyword más de ${d.maxKeywordRepeats ?? 3} veces: eso es keyword stuffing y penaliza.`,
    '- Cada ficha es distinta de las demás. Nada de plantillas ni de texto reciclado entre productos.',
    '- El texto alternativo describe lo que se ve en la foto, en lenguaje llano. No es un sitio para keywords.',
    '- La descripción del feed describe el mismo producto que la ficha, sin lenguaje promocional.',
    '',
    'Lo que NO puedes hacer:',
    ...(d.forbid ?? []).map((regla) => `- No menciones ${regla}.`),
    '- No inventes ningún dato que no esté en los datos del producto que te doy.',
    '- No uses lenguaje promocional (envío gratis, mejor precio, oferta limitada): eso va en otros campos de Shopify.',
    '',
    'Responde con seis bloques, cada uno abierto por su cabecera en una línea propia y nada más.',
    'Sin markdown alrededor, sin explicaciones, sin repetir estas instrucciones. Así exactamente:',
    '',
    `### seoTitle`,
    `${FIELD_ROLES.seoTitle}. Máximo ${d.seoTitle?.maxChars ?? 60} caracteres.`,
    '',
    `### seoDescription`,
    `${FIELD_ROLES.seoDescription}. Entre ${d.seoDescription?.minChars ?? 70} y ${d.seoDescription?.maxChars ?? 155} caracteres.`,
    '',
    `### bodyHtml`,
    `${FIELD_ROLES.bodyHtml}. Máximo ${d.bodyHtml?.maxChars ?? 700} caracteres.`
      + ` Exactamente un <p> de entrada de como mucho ${d.bodyHtml?.leadMaxWords ?? 40} palabras,`
      + ` y después un <ul> con entre ${bullets.min} y ${bullets.max} <li> de como mucho ${bullets.maxChars} caracteres cada uno.`
      + ` Solo estas etiquetas: ${(d.bodyHtml?.allowTags ?? ['p', 'ul', 'li']).join(', ')}.`
      + ' El HTML va tal cual, sin comillas alrededor y sin escapar nada.',
    '',
    `### handle`,
    `${FIELD_ROLES.handle}. Minúsculas, sin acentos, palabras separadas por guiones, máximo ${d.handle?.maxChars ?? 70} caracteres.`,
    '',
    `### altText`,
    `${FIELD_ROLES.altText}. Máximo ${d.altText?.maxChars ?? 125} caracteres.`,
    '',
    `### feedDescription`,
    `${FIELD_ROLES.feedDescription}. Máximo ${d.feedDescription?.maxChars ?? 500} caracteres.`,
    '',
    'Escribe los seis, en ese orden, y termina cada uno antes de abrir el siguiente.',
  ].filter(Boolean).join('\n')

  const partes = [
    'Datos del producto (es TODO lo que se sabe de él):',
    JSON.stringify(visibleFields(product, config), null, 2),
  ]
  if (keywordList.length > 0) {
    partes.push(
      '',
      `Keywords que describen este producto: ${keywordList.join(', ')}.`,
      'Úsalas donde encajen de forma natural. Si alguna no encaja en una frase, no la metas.',
    )
  }
  if (problems.length > 0) {
    partes.push(
      '',
      'Tu respuesta anterior no vale. Corrige exactamente esto y devuelve el JSON completo otra vez:',
      ...problems.map((issue) => `- ${issue}`),
    )
  }

  return { system, user: partes.join('\n') }
}

/**
 * Los handles y los textos que ya están en uso, para que dos fichas no salgan
 * iguales ni compartan URL.
 * @param items - las fichas ya generadas.
 * @param excluir - SKUs que se están regenerando y por tanto no cuentan.
 * @returns `{ handles, textos }`.
 */
function alreadyUsed(items, excluir = new Set()) {
  const handles = new Set()
  const texts = new Set()
  for (const [sku, draft] of Object.entries(items)) {
    if (excluir.has(sku)) continue
    if (draft.handle) handles.add(draft.handle)
    for (const campo of ['seoDescription', 'bodyHtml', 'feedDescription']) {
      if (draft[campo]) texts.add(`${campo}:${draft[campo]}`)
    }
  }
  return { handles, texts }
}

/**
 * Pide al modelo de la sesión los textos de un producto y no se da por
 * satisfecho hasta que pasan la validación.
 *
 * El bucle de reintentos está aquí y no en el agente a propósito: son cientos de
 * productos, y meter cada corrección en la conversación llenaría el contexto.
 * @param ctx - el contexto Cordis, por su servicio `llm`.
 * @param modelo - `{ provider, model }` de la sesión.
 * @param product - el producto normalizado.
 * @param dominio - la configuración cargada.
 * @param usados - handles y textos ya en uso.
 * @param signal - la señal de cancelación del tool.
 * @param problemasIniciales - lo que hay que corregir de entrada, cuando se
 *   reintenta por haber chocado con otra ficha del mismo lote.
 * @param esfuerzo - esfuerzo de razonamiento que pisa el de la configuración,
 *   para poder medir un valor contra otro sin editar ficheros.
 * @param plugin - el nombre del plugin, para el origen del mensaje.
 * @returns `{ draft }` si pasó, o `{ problemas }` con lo que falló en el último
 *   intento; y en los dos casos `rechazos`, los códigos de lo que se rechazó.
 */
async function writeDraft(ctx, model, product, domainConfig, used, signal, initialProblems = [], effort = undefined, plugin = 'catalog-agent') {
  const d = domainConfig.description ?? {}
  const maxIntentos = d.maxAttempts ?? 3
  let problems = initialProblems
  let diagnostico = null
  // Los códigos de todo lo que se rechazó por el camino, aunque al final salga
  // bien: es lo único que dice qué regla está costando llamadas.
  const rejections = []
  const durations = []
  // El pico de razonamiento del lote: es lo que dice si `maxTokens` va holgado o
  // al filo, y hasta ahora solo se veía en los fallos definitivos.
  let peakReasoningChars = 0
  // Si ni un intento produjo un bloque aprovechable, el fallo no es de este
  // producto: es del modelo o del prompt, y seguir con el lote es tirar llamadas.
  let algunBloque = false

  for (let attempt = 1; attempt <= maxIntentos; attempt += 1) {
    const { system, user } = buildPrompt(product, domainConfig, problems.map((x) => x.message))
    const { text, reasoning, durations: tardo, raw } = await requestDraft(ctx, {
      model,
      system,
      user,
      reasoningEffort: effort ?? d.reasoningEffort ?? 'high',
      // Holgado a propósito: el razonamiento consume de este mismo presupuesto,
      // y un tope justo para el texto deja la respuesta vacía.
      maxTokens: d.maxTokens ?? 16000,
      temperature: d.temperature,
      plugin,
      signal,
    })
    durations.push(tardo)
    peakReasoningChars = Math.max(peakReasoningChars, reasoning)
    diagnostico = {
      textChars: text.length,
      reasoningChars: reasoning,
      rawResponse: raw,
    }

    let draft
    try {
      draft = parseBlocks(text)
    } catch (error) {
      problems = [{ code: 'sinBloques', message: error.message }]
      // El síntoma que costó ocho borradores en blanco: todo el presupuesto en
      // razonamiento y nada escrito. Decirlo con nombre ahorra el diagnóstico.
      if (text.length === 0 && reasoning > 0) {
        problems.push({
          code: 'sinTexto',
          message: `el modelo gastó ${reasoning} caracteres razonando y no escribió nada: `
            + 'sube `description.maxTokens` o baja `description.reasoningEffort`',
        })
      } else {
        problems.push({ code: 'ayuda', message: 'Empieza directamente por "### seoTitle", sin texto alrededor.' })
      }
      rejections.push(...problems.map((x) => x.code))
      continue
    }
    algunBloque = true

    problems = validateDraft(draft, product, domainConfig, used)
    rejections.push(...problems.map((x) => x.code))
    if (problems.length === 0) {
      return {
        draft: {
          sku: product.sku,
          ...Object.fromEntries(SEO_FIELDS.map((campo) => [campo, draft[campo]])),
          reviewed: false,
          generatedAt: new Date().toISOString(),
          model: `${model.provider}/${model.model}`,
          attempts: attempt,
        },
        rejections,
        durations,
        peakReasoningChars,
      }
    }
  }

  return { problems, diagnostico, rejections, durations, peakReasoningChars, sistemico: !algunBloque }
}

/**
 * Reserva el handle y los textos de una ficha para que ninguna otra los repita.
 * @param draft - la ficha aceptada.
 * @param usados - los conjuntos compartidos.
 */
function reserve(draft, used) {
  used.handles.add(draft.handle)
  for (const campo of ['seoDescription', 'bodyHtml', 'feedDescription']) {
    used.texts.add(`${campo}:${draft[campo]}`)
  }
}

/**
 * Si una ficha choca con otra aceptada mientras se generaba en paralelo.
 *
 * Los productos de un lote se redactan a la vez contra la misma foto de lo ya
 * usado, así que dos pueden elegir el mismo handle sin que ninguno lo sepa. Esto
 * se comprueba al aceptar, que es cuando ya hay un orden.
 * @param draft - la ficha a aceptar.
 * @param usados - los conjuntos, ya con las fichas aceptadas antes que esta.
 * @returns los problemas de unicidad, o lista vacía.
 */
function collidesWith(draft, used) {
  const problems = []
  if (used.handles.has(draft.handle)) {
    problems.push({
      code: 'handleDuplicado',
      message: `handle "${draft.handle}" ya lo tiene otro producto de este mismo lote, y la URL tiene que ser única`,
    })
  }
  for (const campo of ['seoDescription', 'bodyHtml', 'feedDescription']) {
    if (used.texts.has(`${campo}:${draft[campo]}`)) {
      problems.push({
        code: 'textoDuplicado',
        message: `${campo} es idéntico al de otro producto de este mismo lote; cada ficha tiene que ser distinta`,
      })
    }
  }
  return problems
}

/**
 * Escribe las fichas SEO de un lote de productos.
 * @param ctx - el contexto Cordis, por su servicio `llm`.
 * @param dominio - la configuración cargada.
 * @param args - lo que pidió quien llama.
 * @param exec - la ejecución del tool: el modelo de la sesión y su señal.
 * @param plugin - el nombre del plugin, para el origen de los mensajes.
 * @returns el resumen del lote.
 */
export async function describeCatalog(ctx, domainConfig, args, exec, plugin) {
  // El catálogo sale del JSON que dejó `catalog_load`, no de releer el fichero
  // configurado: si el usuario cargó otro, es ese el que hay que describir.
  const catalog = readCatalog(domainConfig)
  const porSku = new Map(catalog.items.map((item) => [item.sku, item]))
  const storePath = draftsPath(domainConfig)
  const drafts = loadDrafts(storePath)

  const politica = args.regenerate ?? domainConfig.description?.regenerate ?? 'missing'
  if (politica === 'never') {
    throw new Error('la configuración dice `description.regenerate: never`: no se escribe ninguna ficha')
  }
  const pending = catalog.items.filter((item) => politica === 'always' || !drafts[item.sku])

  let targets
  const requestedSkus = [...(args.sku ? [args.sku.trim()] : []), ...(args.skus ?? []).map((s) => String(s).trim())]
  if (requestedSkus.length > 0) {
    const desconocidos = requestedSkus.filter((sku) => !porSku.has(sku))
    if (desconocidos.length > 0) {
      throw new Error(`estos SKU no están en el catálogo: ${desconocidos.join(', ')}`)
    }
    targets = requestedSkus.map((sku) => porSku.get(sku))
  } else if (args.limit) {
    if (args.limit < 1) throw new Error(`limit tiene que ser 1 o más (recibido ${args.limit})`)
    targets = pending.slice(0, args.limit)
  } else {
    throw new Error(
      `hay ${pending.length} productos sin ficha de ${catalog.items.length} del catálogo, y cada uno es `
      + 'una llamada al modelo. Acota el lote: `limit` para procesar los N primeros pendientes, o `sku`/`skus` '
      + 'para productos concretos.',
    )
  }

  const techo = domainConfig.description?.maxPerCall ?? 50
  if (targets.length > techo) {
    throw new Error(
      `has pedido ${targets.length} productos y el techo por llamada es ${techo} `
      + '(`description.maxPerCall`). Ve por lotes.',
    )
  }
  if (targets.length === 0) {
    throw new Error('no hay ningún producto pendiente: todos tienen ficha ya. Usa `regenerate: always` para rescribir.')
  }

  const used = alreadyUsed(drafts, new Set(targets.map((item) => item.sku)))

  if (args.dryRun) {
    return {
      outputPath: storePath,
      sourcePath: catalog.source?.path ?? '(desconocido)',
      model: '(prueba en seco: no se ha llamado a ninguno)',
      requested: targets.length,
      written: 0,
      failed: 0,
      skipped: 0,
      calls: 0,
      seconds: 0,
      peakReasoningChars: 0,
      secondsPerCall: 0,
      effort: args.reasoningEffort?.trim() || domainConfig.description?.reasoningEffort || 'high',
      maxTokens: domainConfig.description?.maxTokens ?? 16000,
      probed: false,
      averageAttempts: 0,
      rejections: [],
      pending: pending.length,
      unreviewed: Object.values(drafts).filter((f) => !f.reviewed).length,
      failures: [],
      sample: [],
      prompt: buildPrompt(targets[0], domainConfig),
    }
  }

  // Por defecto redacta con el modelo de la sesión, pero la tienda puede
  // fijar otro: charlar con uno rápido y escribir las fichas con uno que
  // siga mejor las restricciones de formato es una combinación razonable.
  const opciones = exec.agent?.options
  const model = {
    provider: domainConfig.description?.provider ?? opciones?.provider,
    model: domainConfig.description?.model ?? opciones?.model,
  }
  if (!model.provider || !model.model) {
    throw new Error(
      'no se ha podido averiguar el modelo de esta sesión, así que no hay con qué redactar. '
      + 'Fija `description.provider` y `description.model` en la configuración, o revisa el host.',
    )
  }

  const written = []
  const failures = []
  const rejections = []
  let skipped = 0
  let calls = 0

  const durations = []
  let peakReasoning = 0

  /** Acepta o registra el resultado de un producto. */
  const settle = (product, result) => {
    rejections.push(...(result.rejections ?? []))
    durations.push(...(result.durations ?? []))
    peakReasoning = Math.max(peakReasoning, result.peakReasoningChars ?? 0)
    calls += result.draft?.attempts ?? (domainConfig.description?.maxAttempts ?? 3)
    if (result.draft) {
      drafts[product.sku] = result.draft
      written.push(result.draft)
      reserve(result.draft, used)
      return
    }
    failures.push({
      sku: product.sku,
      problems: result.problems.map((x) => x.message),
      textChars: result.diagnostico?.textChars ?? 0,
      reasoningChars: result.diagnostico?.reasoningChars ?? 0,
      rawResponse: result.diagnostico?.rawResponse ?? '',
    })
  }

  const batchStart = Date.now()
  const concurrency = Math.max(1, domainConfig.description?.concurrency ?? 4)

  // La sonda: el primer producto solo, para que un modelo mal configurado
  // cueste tres llamadas y no un lote entero. Pero es una ola secuencial
  // completa —un 33 % del tiempo de pared en un lote de cuatro—, así que con
  // `auto` se salta cuando ya hay una ficha escrita por ESTE mismo modelo:
  // eso es prueba de que la configuración funciona.
  const probePolicy = domainConfig.description?.probeFirst ?? 'auto'
  const alreadyWorked = Object.values(drafts).some(
    (draft) => draft.model === `${model.provider}/${model.model}`,
  )
  const probe = probePolicy === 'always'
    || (probePolicy !== 'never' && !alreadyWorked)

  const effort = args.reasoningEffort?.trim() || undefined

  let rest = targets
  if (probe) {
    const [first, ...cola] = targets
    rest = cola
    exec.signal.throwIfAborted()
    const firstResult = await writeDraft(ctx, model, first, domainConfig, used, exec.signal, [], effort, plugin)
    settle(first, firstResult)
    if (firstResult.sistemico) rest = []
    skipped = firstResult.sistemico ? cola.length : 0
  }

  if (skipped === 0) {
    for (let inicio = 0; inicio < rest.length; inicio += concurrency) {
      exec.signal.throwIfAborted()
      const chunk = rest.slice(inicio, inicio + concurrency)
      const results = await Promise.all(
        chunk.map((product) => writeDraft(ctx, model, product, domainConfig, used, exec.signal, [], effort, plugin)),
      )
      // Se aceptan en orden, no a la vez: el trozo se redactó contra la
      // misma foto de lo ya usado, así que dos fichas pueden haber elegido
      // el mismo handle sin saberlo. Quien llega segundo lo repite.
      for (const [index, result] of results.entries()) {
        const product = chunk[index]
        const collisions = result.draft ? collidesWith(result.draft, used) : []
        if (collisions.length === 0) {
          settle(product, result)
          continue
        }
        const retry = await writeDraft(
          ctx, model, product, domainConfig, used, exec.signal, collisions, effort, plugin,
        )
        settle(product, {
          ...retry,
          rejections: [...(result.rejections ?? []), ...collisions.map((x) => x.code)],
          durations: [...(result.durations ?? []), ...(retry.durations ?? [])],
        })
      }

      // Sin sonda, la guarda pasa al primer trozo: si nadie de ahí produjo un
      // bloque, el fallo es de configuración y no hay que seguir.
      if (!probe && inicio === 0 && written.length === 0
          && results.every((r) => r.sistemico)) {
        skipped = rest.length - chunk.length
        break
      }
    }
  }
  saveDrafts(storePath, drafts)

  const seconds = Math.round((Date.now() - batchStart) / 100) / 10
  const secondsPerCall = durations.length === 0
    ? 0
    : Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) / 100) / 10

  const counts = new Map()
  for (const code of rejections) counts.set(code, (counts.get(code) ?? 0) + 1)

  return {
    outputPath: storePath,
    sourcePath: catalog.source?.path ?? '(desconocido)',
    model: `${model.provider}/${model.model}`,
    requested: targets.length,
    written: written.length,
    failed: failures.length,
    skipped,
    calls,
    seconds,
    peakReasoningChars: peakReasoning,
    secondsPerCall,
    effort: effort ?? domainConfig.description?.reasoningEffort ?? 'high',
    maxTokens: domainConfig.description?.maxTokens ?? 16000,
    probed: probe,
    averageAttempts: written.length === 0
      ? 0
      : Math.round((written.reduce((suma, f) => suma + f.attempts, 0) / written.length) * 100) / 100,
    rejections: [...counts]
      .sort((a, b) => b[1] - a[1])
      .map(([code, count]) => ({ code, count })),
    pending: catalog.items.filter((item) => !drafts[item.sku]).length,
    unreviewed: Object.values(drafts).filter((draft) => !draft.reviewed).length,
    failures: failures.slice(0, 5),
    sample: written.slice(0, 1),
    prompt: null,
  }
}
