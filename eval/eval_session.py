"""
Evalúa con deepeval sesiones REALES del harness, no el agente Python.

Lee el log de una sesión de dsh (`session.jsonl`, o el `session.jsonl.zstd` que dsh
guarda en `~/.dsh/sessions/`), extrae cada recomendación que hizo el agente y la
puntúa contra la noticia y el catálogo que el propio agente tenía delante en ese
momento.

Uso:
    # una sesión exportada desde el botón "Session log" de la UI
    ./.venv/bin/python eval/eval_session.py session.jsonl

    # varias, incluidas las que dsh guarda comprimidas
    ./.venv/bin/python eval/eval_session.py ~/.dsh/sessions/*/session-*/session.jsonl.zstd

    # ver qué casos salen del log sin gastar llamadas al juez
    ./.venv/bin/python eval/eval_session.py --dry-run session.jsonl

El juez de GEval necesita una clave. OpenAI es solo el defecto de deepeval; con
`DEEPSEEK_API_KEY` en el entorno se usa DeepSeek y no hace falta segunda cuenta:

    export DEEPSEEK_API_KEY=sk-...            # juez DeepSeek (automático)
    export OPENAI_API_KEY=sk-...              # o el juez por defecto de deepeval

    ./.venv/bin/python eval/eval_session.py --juez openai session.jsonl   # forzar uno
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

STOCK_PATH = Path(__file__).resolve().parent.parent / "stock.json"

RECOMMEND_TOOL = "wine_recommend"
NEWS_TOOL = "wine_rss_latest"
STOCK_TOOL = "wine_stock_list"

THRESHOLD = 0.80


@dataclass
class Recomendacion:
    """Una llamada a `wine_recommend` extraída del log, con lo que el agente vio antes."""

    origen: Path
    turno: int
    argumentos: dict[str, Any]
    peticion: str
    noticia: str
    catalogo: str
    rechazada: bool
    error: str = ""
    problemas_estructura: list[str] = field(default_factory=list)

    @property
    def product_id(self) -> str:
        return str(self.argumentos.get("product_id", ""))

    def actual_output(self) -> str:
        """La propuesta del agente, en la misma forma que emite el agente Python."""
        return json.dumps(
            {
                "noticia": {
                    "titulo": self.argumentos.get("titulo"),
                    "resumen": self.argumentos.get("resumen"),
                    "enlace": self.argumentos.get("enlace"),
                },
                "recomendacion": {
                    "product_id": self.argumentos.get("product_id"),
                    "motivo": self.argumentos.get("motivo"),
                },
            },
            ensure_ascii=False,
        )


def leer_eventos(path: Path) -> Iterator[dict[str, Any]]:
    """Recorre el log de una sesión, comprimido o no, saltando las líneas ilegibles."""
    if path.suffix == ".zstd":
        from compression.zstd import ZstdFile

        handle = ZstdFile(path, "r")
        lineas = (line.decode("utf-8") for line in handle)
    else:
        handle = path.open(encoding="utf-8")
        lineas = handle
    try:
        for linea in lineas:
            linea = linea.strip()
            if not linea:
                continue
            try:
                yield json.loads(linea)
            except json.JSONDecodeError:
                continue
    finally:
        handle.close()


def texto_resultado(evento: dict[str, Any]) -> tuple[str, bool]:
    """Saca el texto renderizado de un `tool/result` y si fue un error.

    El log guarda lo que se le enseñó al modelo, no el JSON canónico de la
    herramienta: ese es local a la ejecución y no se replica.
    """
    partes: list[str] = []
    es_error = False
    for bloque in evento.get("data", {}).get("message", {}).get("content", []):
        es_error = es_error or bool(bloque.get("isError"))
        for trozo in bloque.get("content", []):
            if trozo.get("type") == "text":
                partes.append(trozo.get("text", ""))
    return "\n".join(partes).strip(), es_error


def extraer(path: Path, ids_validos: set[str]) -> list[Recomendacion]:
    """Reconstruye del log cada recomendación junto al contexto que la precedió."""
    peticion = ""
    noticia = ""
    catalogo = ""
    turno = 0
    pendientes: dict[str, tuple[str, dict[str, Any], int, str, str, str]] = {}
    resultados: dict[str, tuple[str, bool]] = {}
    orden: list[str] = []

    for evento in sorted(leer_eventos(path), key=lambda e: e.get("seq", 0)):
        tipo = evento.get("type")
        data = evento.get("data", {})

        if tipo == "user/message":
            # El harness inyecta su contexto de runtime como mensaje de rol usuario;
            # solo cuenta lo que escribió la persona.
            if data.get("source", {}).get("kind") != "user":
                continue
            textos = [b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"]
            nuevo = " ".join(t for t in textos if t).strip()
            # Se acumulan: el turno que dispara la recomendación suele ser un "sí" que
            # no dice nada por sí solo, y lo que se pidió está en los turnos anteriores.
            if nuevo:
                peticion = f"{peticion} / {nuevo}" if peticion else nuevo
        elif tipo == "turn/start":
            turno = data.get("turn", turno + 1)
        elif tipo == "tool/call":
            nombre = data.get("name", "")
            call_id = data.get("callId", "")
            try:
                argumentos = json.loads(data.get("arguments") or "{}")
            except json.JSONDecodeError:
                argumentos = {}
            if nombre == RECOMMEND_TOOL:
                pendientes[call_id] = (nombre, argumentos, data.get("turn", turno), peticion, noticia, catalogo)
                orden.append(call_id)
            else:
                pendientes[call_id] = (nombre, argumentos, data.get("turn", turno), "", "", "")
        elif tipo == "tool/result":
            call_id = data.get("message", {}).get("source", {}).get("callId", "")
            texto, es_error = texto_resultado(evento)
            resultados[call_id] = (texto, es_error)
            nombre = pendientes.get(call_id, ("",))[0]
            if nombre == NEWS_TOOL and not es_error:
                noticia = texto
            elif nombre == STOCK_TOOL and not es_error:
                catalogo = texto

    recomendaciones = []
    for call_id in orden:
        _, argumentos, turno_llamada, peticion_previa, noticia_previa, catalogo_previo = pendientes[call_id]
        texto, es_error = resultados.get(call_id, ("(sin resultado en el log)", False))
        problemas = []
        product_id = str(argumentos.get("product_id", ""))
        if product_id not in ids_validos:
            problemas.append(f"product_id '{product_id}' no está en stock.json")
        if not str(argumentos.get("motivo", "")).strip():
            problemas.append("motivo vacío")
        if len(str(argumentos.get("resumen", "")).strip()) < 20:
            problemas.append("resumen demasiado corto")
        recomendaciones.append(
            Recomendacion(
                origen=path,
                turno=turno_llamada,
                argumentos=argumentos,
                peticion=peticion_previa,
                noticia=noticia_previa,
                catalogo=catalogo_previo,
                rechazada=es_error,
                error=texto if es_error else "",
                problemas_estructura=problemas,
            )
        )
    return recomendaciones


def construir_juez(proveedor: str, modelo: str | None) -> Any:
    """Elige el LLM que puntúa. OpenAI es solo el defecto de deepeval, no un requisito.

    Con `auto` se usa DeepSeek si hay `DEEPSEEK_API_KEY` en el entorno, para no
    depender de una segunda cuenta; si no, se deja el defecto de deepeval.
    """
    import os

    if proveedor == "auto":
        proveedor = "deepseek" if os.environ.get("DEEPSEEK_API_KEY") else "openai"
    if proveedor == "deepseek":
        from deepeval.models import DeepSeekModel

        return DeepSeekModel(model=modelo or "deepseek-chat")
    if modelo:
        from deepeval.models import OpenAIModel

        return OpenAIModel(model=modelo)
    return None  # el defecto de deepeval


def construir_metricas(juez: Any = None) -> list[Any]:
    """Las métricas del juez. No usan `expected_output`: en una sesión real no hay.

    Sustituyen a la `Accuracy` de `test_wine_agent.py`, que compara contra una
    salida esperada fija, por dos criterios que se pueden juzgar solo con lo que
    el agente tenía delante.
    """
    from deepeval.metrics import GEval
    from deepeval.test_case import SingleTurnParams

    params = [SingleTurnParams.INPUT, SingleTurnParams.ACTUAL_OUTPUT, SingleTurnParams.RETRIEVAL_CONTEXT]
    extra = {"model": juez} if juez is not None else {}
    return [
        GEval(
            name="FidelidadDelResumen",
            criteria=(
                "El contexto contiene la noticia tal y como la leyó el agente. Puntúa alto si el "
                "resumen refleja fielmente esa noticia y no añade ningún dato que no esté en ella. "
                "Puntúa bajo si inventa cifras, regiones, bodegas o hechos."
            ),
            evaluation_params=params,
            threshold=THRESHOLD,
            **extra,
        ),
        GEval(
            name="PertinenciaDeLaRecomendacion",
            criteria=(
                "El contexto contiene la noticia y el catálogo de la tienda. Puntúa alto si el vino "
                "recomendado conecta de verdad con la noticia por región, uva, tipo o contexto, y si "
                "el motivo explica esa conexión. Puntúa bajo si el motivo es genérico ('es nuestro "
                "mejor vino') o si la conexión con la noticia no se sostiene."
            ),
            evaluation_params=params,
            threshold=THRESHOLD,
            **extra,
        ),
    ]


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Evalúa con deepeval las recomendaciones de sesiones reales de dsh.",
    )
    parser.add_argument("logs", nargs="+", type=Path, help="ficheros session.jsonl o session.jsonl.zstd")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="extrae y comprueba la estructura sin llamar al juez de GEval",
    )
    parser.add_argument(
        "--juez",
        choices=("auto", "deepseek", "openai"),
        default="auto",
        help="quién puntúa: auto usa DeepSeek si hay DEEPSEEK_API_KEY, si no el defecto de deepeval",
    )
    parser.add_argument(
        "--modelo-juez",
        default=None,
        help="modelo concreto del juez (por defecto deepseek-chat cuando el juez es DeepSeek)",
    )
    parser.add_argument(
        "--incluir-rechazadas",
        action="store_true",
        help="evalúa también las llamadas que wine_recommend rechazó (por defecto solo se cuentan)",
    )
    args = parser.parse_args()

    stock = json.loads(STOCK_PATH.read_text(encoding="utf-8"))
    ids_validos = {w["product_id"] for w in stock}

    recomendaciones: list[Recomendacion] = []
    for path in args.logs:
        if not path.exists():
            print(f"aviso: no existe {path}", file=sys.stderr)
            continue
        encontradas = extraer(path, ids_validos)
        recomendaciones.extend(encontradas)
        print(f"{path}: {len(encontradas)} llamada(s) a {RECOMMEND_TOOL}")

    if not recomendaciones:
        print(f"\nNingún log contiene llamadas a {RECOMMEND_TOOL}: no hay nada que evaluar.")
        return 1

    print()
    for rec in recomendaciones:
        estado = "RECHAZADA por la herramienta" if rec.rechazada else "aceptada"
        print(f"- turno {rec.turno} | {rec.product_id or '(sin product_id)'} | {estado}")
        if rec.problemas_estructura:
            print(f"    estructura: {'; '.join(rec.problemas_estructura)}")
        if rec.rechazada:
            print(f"    error: {rec.error.splitlines()[0][:160]}")
        if not rec.noticia:
            print("    aviso: no se vio ninguna noticia antes de esta llamada")

    a_evaluar = [r for r in recomendaciones if args.incluir_rechazadas or not r.rechazada]
    rechazadas = len(recomendaciones) - len([r for r in recomendaciones if not r.rechazada])
    if rechazadas:
        print(f"\n{rechazadas} llamada(s) rechazadas por wine_recommend (el loop se autocorrigió).")

    if not a_evaluar:
        print("\nNo queda ninguna recomendación aceptada que evaluar.")
        return 1

    if args.dry_run:
        print(f"\n--dry-run: {len(a_evaluar)} caso(s) listos; no se ha llamado al juez.")
        return 0

    from deepeval import evaluate
    from deepeval.test_case import LLMTestCase

    casos = [
        LLMTestCase(
            input=rec.peticion or "Lee una noticia y recomienda un vino del stock.",
            actual_output=rec.actual_output(),
            retrieval_context=[c for c in (rec.noticia, rec.catalogo) if c],
        )
        for rec in a_evaluar
    ]

    juez = construir_juez(args.juez, args.modelo_juez)
    nombre_juez = juez.get_model_name() if juez is not None else "el defecto de deepeval"
    print(f"\nEvaluando {len(casos)} recomendación(es) con umbral {THRESHOLD}, juez: {nombre_juez}\n")
    evaluate(test_cases=casos, metrics=construir_metricas(juez))
    return 0


if __name__ == "__main__":
    sys.exit(main())
