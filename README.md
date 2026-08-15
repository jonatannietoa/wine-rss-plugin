# Agente de vinos (RSS Wine-Searcher → resumen → recomendación de stock)

Ejemplo de agente con arquitectura de plugins inspirada en **DeepSeek Harness (dsh)**
(framework open-source de DeepSeek, "todo es un plugin": modelo, herramientas,
sesión y loop del agente son piezas intercambiables). Como `dsh` es TypeScript y
está en developer preview con una API que puede cambiar, aquí la misma filosofía
se implementa en Python para tener algo ejecutable ya mismo. Ver la sección
"Migrar a dsh real" más abajo.

## Qué hace

1. Descarga la última noticia del feed real de Wine-Searcher:
   `https://www.wine-searcher.com/rss-feed/dept/all`
   (la URL que compartiste es la página HTML del RSS, no el feed en sí).
2. Le pasa la noticia + tu stock (`stock.json`) al modelo (DeepSeek por defecto).
3. El modelo resume la noticia y recomienda un `product_id` de tu stock.
4. Si la respuesta no es válida (JSON roto, falta `product_id`, `product_id`
   inexistente, resumen demasiado corto...), el `AgentLoop` reintenta una vez
   más añadiendo el motivo del fallo al prompt.
5. Imprime el JSON final.

## Estructura

```
wine_agent/
├── agent.py              # punto de entrada
├── stock.json             # stock de ejemplo de la tienda (edítalo con tu stock real)
├── harness/
│   └── plugins.py         # RSSFeedTool, StockTool, ModelPlugin, AgentLoop
├── eval/
│   └── test_wine_agent.py # tests deepeval (pass / fail / accuracy>0.80 / retry)
└── dsh-plugin/
    ├── package.json       # paquete del plugin nativo de dsh
    └── lib/index.js       # herramientas wine_rss_latest / wine_stock_list / wine_recommend
```

## Uso

```bash
pip install -r requirements.txt

# Sin clave: corre en modo mock (respuesta determinista, útil para probar el flujo)
python agent.py

# Con DeepSeek real:
export DEEPSEEK_API_KEY=sk-...
python agent.py
```

### Variables de entorno

Las claves van en un `.env` en la raíz del repo, a partir de la plantilla:

```bash
cp .env.example .env   # y rellena lo que uses
```

| Variable | Para qué |
|---|---|
| `DEEPSEEK_API_KEY` | modelo de `agent.py`; sin ella corre en modo mock. También es el juez de `eval_session.py` si no fuerzas otro |
| `OPENAI_API_KEY` | juez de deepeval por defecto (`eval/test_wine_agent.py`) |
| `DEEPSEEK_MODEL_NAME` | modelo del juez DeepSeek; por defecto `deepseek-chat` |
| `DEEPEVAL_TELEMETRY_OPT_OUT` | `1` para que deepeval no mande telemetría |

Se carga siempre el `.env` de la raíz del repo, no el del directorio desde el que
lances el comando, así que los scripts funcionan desde cualquier sitio. Una
variable ya exportada en la shell gana sobre el fichero, y una variable vacía
cuenta como ausente. `.env` está en `.gitignore`; `.env.example` no, así que ahí
no van claves.

El plugin nativo de dsh no lee nada de esto: usa el modelo de la sesión del harness.

Salida esperada (ejemplo):
```json
{
  "product_id": "SKU-1002",
  "noticia": {"titulo": "...", "resumen": "...", "enlace": "..."},
  "recomendacion": {"product_id": "SKU-1002", "motivo": "..."},
  "meta": {"intentos": 1, "valido": true, "errores": []}
}
```

## Evaluación con deepeval

Los 4 casos pedidos están en `eval/test_wine_agent.py`:

| Test | Qué demuestra |
|---|---|
| `test_case_pass` | Respuesta coherente (mismo tipo/región/uva que la noticia) → la métrica GEval pasa |
| `test_case_fail` | Recomendación sin relación con la noticia → la métrica falla (se comprueba con `pytest.raises`) |
| `test_case_accuracy_above_080` | Métrica `GEval` de exactitud explícita con `threshold=0.80`, y se comprueba `score >= 0.80` |
| `test_case_forces_retry` | Un modelo simulado responde incompleto en el 1er intento (sin `product_id`); el `AgentLoop` lo detecta y reintenta; se evalúa la salida ya corregida |

Esos 4 casos evalúan el agente **Python**. Para evaluar lo que de verdad corrió
dentro de dsh está `eval/eval_session.py`, que lee el log de una sesión, extrae
cada llamada a `wine_recommend` y la puntúa contra la noticia y el catálogo que el
agente tenía delante en ese momento:

```bash
# una sesión exportada con el botón "Session log" de la UI
./.venv/bin/python eval/eval_session.py session.jsonl

# las que dsh guarda por su cuenta, comprimidas
./.venv/bin/python eval/eval_session.py ~/.dsh/sessions/*/session-*/session.jsonl.zstd

# ver los casos que salen del log sin gastar llamadas al juez
./.venv/bin/python eval/eval_session.py --dry-run session.jsonl
```

Comprueba gratis la estructura (que el `product_id` exista en `stock.json`, que
haya motivo y que el resumen no sea un muñón) y cuenta las llamadas que
`wine_recommend` rechazó, que son los reintentos del loop. Las dos métricas
`GEval` —fidelidad del resumen y pertinencia de la recomendación— no usan
`expected_output`, porque en una sesión real no hay una respuesta esperada contra
la que comparar.

El juez no tiene por qué ser OpenAI: es solo el proveedor por defecto de deepeval.
Con `DEEPSEEK_API_KEY` en el entorno, `eval_session.py` usa el `DeepSeekModel` de
deepeval sin más configuración; `--juez openai|deepseek` y `--modelo-juez` fuerzan
uno concreto. Ojo con juzgar con el mismo modelo que generó la respuesta: es
cómodo, pero un juez tiende a ser indulgente con su propia salida.

deepeval usa un LLM "juez" (por defecto OpenAI) para las métricas `GEval`, así que necesitas una clave para el juez, independiente de la clave de DeepSeek que usa el propio agente:

```bash
export OPENAI_API_KEY=sk-...        # el juez de deepeval
export DEEPSEEK_API_KEY=sk-...      # opcional, si no está el agente corre en modo mock
deepeval test run eval/test_wine_agent.py
```

## Desplegado en el dsh local (localhost:3080)

El agente está registrado como **skill de usuario** del harness dsh que corre en
`http://localhost:3080`:

```
~/.dsh/skills/wine-rss-agent/SKILL.md
```

Esa skill le dice al agente de dsh qué hace este proyecto, con qué intérprete
ejecutarlo (`.venv/bin/python agent.py`), qué forma tiene el JSON de salida y cómo
lanzar los tests. dsh vigila el directorio de skills, así que se recogió en caliente,
sin reiniciar el harness. Para retirarlo, borra ese directorio.

Ojo: es una skill de **usuario** (global) a propósito. dsh resuelve el ámbito de
proyecto por el ancestro más cercano con `.git` y, al haberse lanzado desde otro
directorio, una skill de proyecto aquí no se vería.

Si cambian las rutas, los flags o la forma de la salida del agente, hay que
actualizar ese `SKILL.md`.

## Plugin nativo de dsh

`dsh-plugin/` es la versión nativa del agente para DeepSeek Harness (probado contra
`0.1.0-rc.6`). No envuelve al script Python: lo reimplementa como filas del harness.

| Python | dsh |
| --- | --- |
| `RSSFeedTool` | herramienta `wine_rss_latest` |
| `StockTool` | herramienta `wine_stock_list` |
| validación de `AgentLoop._validate` | herramienta `wine_recommend`, que rechaza la llamada |
| reintento de `AgentLoop` | el propio loop del agente, que se autocorrige ante el rechazo |
| `ModelPlugin` | desaparece: el modelo es el del harness |

Esto último es la diferencia práctica: el plugin nativo no necesita
`DEEPSEEK_API_KEY` propia ni tiene modo mock, porque quien resume y elige el vino
es el modelo de la sesión de dsh.

### Instalación

```bash
# dependencias del plugin (fijadas a la versión del harness)
cd dsh-plugin && npm install && cd ..

# darlo de alta en el perfil de dsh (reenvía a pnpm en el directorio del perfil)
dsh plugin --profile web add "$PWD/dsh-plugin"
```

El aviso `declares no dsh.bundle` es lo esperado: el plugin no es una capa del
perfil (plano host), lo monta el preset de agente (plano agente).

El preset vive en `~/.dsh/.agent-presets/wine-agent/` (`agent.cordis.yml` +
`preset.yml`) y se elige por sesión desde el selector de presets de dsh. Su fila
apunta al `stock.json` de este repo por ruta absoluta, así que el catálogo no
depende del directorio de trabajo de la sesión.

Si actualizas dsh, vuelve a fijar `@deepseek-ai/dsh-tools` en `dsh-plugin/package.json`
a la versión nueva y reinstala.

### El agente Python sigue estando

`agent.py` no se toca y sigue funcionando por su cuenta: es la versión autónoma,
con su propio modelo y su modo mock, y es lo que evalúan los tests de `eval/`.
