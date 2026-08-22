---
description: Todo cambio de arquitectura se documenta en ARCHITECTURE.md
globs:
alwaysApply: true
---

# La arquitectura se documenta

`ARCHITECTURE.md` es la descripción viva de cómo está montado el plugin. No es un documento de
diseño histórico: describe lo que hay hoy.

## Qué cuenta como cambio de arquitectura

Cualquiera de estos, y hay que actualizar `ARCHITECTURE.md` **en la misma tarea**:

- Añadir, quitar o renombrar un hexágono (`lib/<tool>/`) o una de sus capas.
- Mover una pieza de capa: de `domain/` a `application/`, de `application/` a `infra/`, etc.
- Subir un concepto a `domain/` porque ya lo usan dos tools, o bajarlo porque solo lo usa una.
- Cambiar qué consume una etapa (por ejemplo, que deje de leer la salida de la anterior).
- Añadir una dependencia externa nueva (un proveedor, una API) y su adaptador.
- Cambiar el idioma o la convención de nombres del código.

## Qué NO lo es

Añadir una regla de validación, un campo a una salida, un parámetro a una tool o un test. Eso va al
`CHANGELOG.md` por la regla de versión, no aquí.

## Cómo se documenta

En `ARCHITECTURE.md`, y con el mismo criterio que el resto del repo: **decir por qué, no solo qué**.
Si una decisión salió de un fallo real, se dice cuál fue el fallo — el apartado «las etapas consumen
la salida de la anterior» existe porque eso se rompió una vez en silencio, y esa frase es lo que
evita que se repita.

Si el cambio invalida una parte del documento, se corrige esa parte en vez de añadir una sección
nueva que la contradiga.

## Verificación

Estas dos cosas tienen que seguir siendo verdad después de cualquier cambio, y son comprobables:

```bash
# index.js no habla con el exterior ni tiene negocio
grep -E "from 'node:fs'|ctx\.llm\.stream|validateDraft|buildCatalog" dsh-plugin/lib/index.js

# el dominio no lee ni escribe nada
grep -rE "from 'node:fs'|readFileSync|writeFileSync" dsh-plugin/lib/domain/ dsh-plugin/lib/*/domain/
```

Las dos deben salir vacías. Si una devuelve algo, hay una pieza en la capa equivocada.
