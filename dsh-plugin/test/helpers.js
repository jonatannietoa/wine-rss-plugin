/**
 * Andamiaje compartido por los tests: rutas del repo, configuración temporal y
 * registro de las herramientas con un contexto de mentira.
 *
 * @module dsh-plugin-catalog-agent/test/helpers
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { dump } from 'js-yaml'
import { loadConfig } from '../lib/catalog.js'
import { Config, apply } from '../lib/index.js'

export const RAIZ = resolve(import.meta.dirname, '..', '..')
export const CONFIG = join(RAIZ, 'catalog.config.yml')
export const FIXTURE = join(RAIZ, 'catalogo.example.csv')

/** Un directorio temporal recién creado. */
export const temporal = () => mkdtempSync(join(tmpdir(), 'catalog-agent-'))

/**
 * Escribe una copia de la configuración de la tienda en un temporal, apuntando
 * al fixture y con sus salidas fuera del repo.
 * @param mutar - retoque de la configuración antes de volcarla.
 * @returns la ruta del `catalog.config.yml` temporal.
 */
export function configTemporal(mutar = () => {}) {
  const crudo = JSON.parse(JSON.stringify(loadConfig(CONFIG)))
  delete crudo.baseDir
  crudo.source.path = FIXTURE
  crudo.output = { catalogJson: './catalog.json', seoJson: './catalog-seo.json' }
  mutar(crudo)
  const ruta = join(temporal(), 'catalog.config.yml')
  writeFileSync(ruta, dump(crudo), 'utf8')
  return ruta
}

/**
 * Registra las herramientas del plugin con un contexto de mentira.
 * @param configPath - la configuración de dominio que verán.
 * @param llm - el servicio `llm` simulado, si el test lo necesita.
 * @returns las herramientas por nombre.
 */
export function registrar(configPath, llm = {}) {
  const registradas = {}
  apply(
    { tools: { register: (tool) => { registradas[tool.name] = tool } }, llm },
    Config({ configPath }),
  )
  return registradas
}

/**
 * Registra las herramientas y deja el catálogo ya cargado.
 *
 * Las etapas 3 y siguientes consumen la salida de la 2, así que sin una carga
 * previa no tienen nada que describir: es el orden real del pipeline.
 * @param llm - el servicio `llm` simulado.
 * @param mutar - retoque de la configuración temporal.
 * @returns las herramientas y la ruta de la configuración usada.
 */
export async function conCatalogoCargado(llm = {}, mutar = () => {}) {
  const configPath = configTemporal(mutar)
  const tools = registrar(configPath, llm)
  await tools.catalog_load.execute({})
  return { tools, configPath }
}

/**
 * Un `llm` simulado que devuelve respuestas preparadas, una por llamada.
 * @param respuestas - lo que contesta el modelo, en orden.
 * @returns `{ llm, llamadas }`, donde `llamadas` acumula los prompts recibidos.
 */
export function llmSimulado(respuestas) {
  const llamadas = []
  const pendientes = [...respuestas]
  return {
    llamadas,
    llm: {
      async *stream(opciones) {
        llamadas.push(opciones)
        const texto = pendientes.shift() ?? ''
        yield { type: 'text-delta', index: 0, text: texto }
        yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 200 } }
      },
    },
  }
}

/** El `exec` que recibe un tool, con el modelo de la sesión y su señal. */
export const ejecucion = (modelo = { provider: 'deepseek', model: 'deepseek-chat' }) => ({
  agent: { options: modelo },
  signal: AbortSignal.timeout(30000),
})
