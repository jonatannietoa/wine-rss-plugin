/**
 * Lo que se puede decir de un error atrapado.
 *
 * En TypeScript lo que llega a un `catch` es `unknown`, y con razón: puede ser
 * cualquier cosa. Estas dos funciones son el único sitio donde se estrecha.
 *
 * @module dsh-plugin-catalog-agent/errors
 */

/** El mensaje de un error atrapado, sea lo que sea lo que se lanzó. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** El `code` que ponen Node y los adaptadores de dsh, si lo trae. */
export function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined
}
