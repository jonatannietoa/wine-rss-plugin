/**
 * Este fichero no se ejecuta: lo comprueba `tsc`.
 *
 * Es la prueba de que el tipado de las tools sigue atado. `defineTool` es
 * genérico sobre el esquema de parámetros y el de salida, así que `execute` está
 * obligado a devolver exactamente lo que declara `output.schema`. Si alguien
 * rompe ese cableado —quitando un `as const`, ensanchando un tipo—, el
 * `@ts-expect-error` de abajo se queda sin error que esperar y `tsc` falla con
 * «Unused '@ts-expect-error' directive».
 *
 * El caso es real: al renombrar las claves de las salidas al inglés dejé un
 * `pendientes` en un `execute` cuyo esquema ya decía `pending`, y solo se vio
 * cuando el render devolvió `undefined` en una sesión.
 *
 * @module dsh-plugin-catalog-agent/test/typing
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

// El esquema declara `pending` y el execute devuelve `pendientes`: tiene que doler.
defineTool({
  name: 'desajuste',
  description: 'El esquema y el execute no coinciden.',
  parameters: { limit: { type: 'integer', description: 'Cuántos.' } },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { pending: { type: 'integer', required: true } },
    },
    render: (_args, value) => [{ type: 'text', text: String(value.pending) }],
  },
  // @ts-expect-error el execute devuelve `pendientes` y el esquema dice `pending`
  async execute(args) {
    return { pendientes: args.limit ?? 0 }
  },
})

// Y el caso bueno tiene que compilar sin quejas.
defineTool({
  name: 'coincide',
  description: 'El esquema y el execute coinciden.',
  parameters: { limit: { type: 'integer', description: 'Cuántos.' } },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { pending: { type: 'integer', required: true } },
    },
    render: (_args, value) => [{ type: 'text', text: String(value.pending) }],
  },
  async execute(args) {
    return { pending: args.limit ?? 0 }
  },
})
