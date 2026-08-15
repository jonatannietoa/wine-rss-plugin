"""
Plugins estilo DeepSeek Harness (dsh).

DeepSeek Harness (dsh) es un framework de agentes open-source de DeepSeek,
publicado en TypeScript sobre el meta-framework Cordis, cuyo principio es
"todo es un plugin": el adaptador de modelo, las herramientas, la sesión y
el propio bucle del agente son piezas intercambiables sin núcleo privilegiado.
Está en developer preview y su API puede cambiar.

Este módulo reproduce esa misma filosofía en Python (modelo / herramientas /
loop como piezas sustituibles) para tener un ejemplo ejecutable ya mismo.
Cuando la API de dsh esté estable, cada clase de aquí se puede envolver en
un plugin real de dsh (ver README.md, sección "Migrar a dsh real").
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any

import feedparser
import requests

WINE_SEARCHER_RSS_FEED = "https://www.wine-searcher.com/rss-feed/dept/all"


# ---------------------------------------------------------------------------
# Plugin: herramienta RSS
# ---------------------------------------------------------------------------
@dataclass
class NewsItem:
    titulo: str
    resumen: str
    enlace: str
    publicado: str = ""


class RSSFeedTool:
    """Plugin de herramienta: obtiene noticias del feed RSS de Wine-Searcher."""

    name = "rss_feed_tool"

    def __init__(self, feed_url: str = WINE_SEARCHER_RSS_FEED, timeout: int = 15):
        self.feed_url = feed_url
        self.timeout = timeout

    def fetch_latest(self, n: int = 1) -> list[NewsItem]:
        resp = requests.get(
            self.feed_url,
            timeout=self.timeout,
            headers={"User-Agent": "Mozilla/5.0 (compatible; wine-agent/0.1)"},
        )
        resp.raise_for_status()
        parsed = feedparser.parse(resp.content)
        items = []
        for entry in parsed.entries[:n]:
            items.append(
                NewsItem(
                    titulo=entry.get("title", "").strip(),
                    resumen=entry.get("summary", entry.get("description", "")).strip(),
                    enlace=entry.get("link", ""),
                    publicado=entry.get("published", ""),
                )
            )
        return items


# ---------------------------------------------------------------------------
# Plugin: herramienta de stock
# ---------------------------------------------------------------------------
class StockTool:
    """Plugin de herramienta: da acceso de solo lectura al stock de la tienda."""

    name = "stock_tool"

    def __init__(self, stock_path: str):
        with open(stock_path, encoding="utf-8") as f:
            self.stock: list[dict[str, Any]] = json.load(f)

    def as_prompt_context(self) -> str:
        lines = []
        for w in self.stock:
            lines.append(
                f"- id={w['product_id']} | {w['nombre']} ({w['tipo']}, {w['region']}, "
                f"{w['uva']}) | stock={w['stock']} | {w['precio_eur']}€"
            )
        return "\n".join(lines)

    def valid_ids(self) -> set[str]:
        return {w["product_id"] for w in self.stock}

    def get(self, product_id: str) -> dict[str, Any] | None:
        return next((w for w in self.stock if w["product_id"] == product_id), None)


# ---------------------------------------------------------------------------
# Plugin: adaptador de modelo (DeepSeek, con modo mock para tests/demo)
# ---------------------------------------------------------------------------
class ModelPlugin:
    """Plugin de modelo. Usa la API de DeepSeek (compatible OpenAI).

    Si no hay DEEPSEEK_API_KEY configurada, o mock=True, responde en modo
    mock determinista -- útil para desarrollar y para los tests de deepeval
    sin depender de una clave de pago.
    """

    def __init__(self, model: str = "deepseek-chat", mock: bool | None = None):
        self.model = model
        # `or None`: con un .env, la variable puede existir pero estar vacía, y eso
        # es "no hay clave", no "hay una clave que es la cadena vacía".
        self.api_key = os.environ.get("DEEPSEEK_API_KEY") or None
        self.mock = mock if mock is not None else self.api_key is None
        if not self.mock:
            from openai import OpenAI  # DeepSeek expone API compatible con OpenAI

            self.client = OpenAI(api_key=self.api_key, base_url="https://api.deepseek.com")

    def complete(self, system_prompt: str, user_prompt: str) -> str:
        if self.mock:
            return self._mock_complete(user_prompt)
        response = self.client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.3,
        )
        return response.choices[0].message.content

    def _mock_complete(self, user_prompt: str) -> str:
        # Respuesta determinista de ejemplo (modo offline / eval).
        return json.dumps(
            {
                "noticia": {
                    "titulo": "Titular de ejemplo (modo mock, sin DEEPSEEK_API_KEY)",
                    "resumen": "Resumen de ejemplo generado en modo mock para pruebas locales.",
                    "enlace": "",
                },
                "recomendacion": {
                    "product_id": "SKU-1002",
                    "motivo": "Recomendación de ejemplo en modo mock.",
                },
            },
            ensure_ascii=False,
        )


# ---------------------------------------------------------------------------
# Plugin: bucle del agente (orquesta modelo + herramientas + reintentos)
# ---------------------------------------------------------------------------
SYSTEM_PROMPT = """Eres un agente para una tienda de vinos. Se te da una noticia \
del sector del vino y el stock disponible de la tienda. Debes:
1. Resumir la noticia en 2-3 frases en español.
2. Recomendar EXACTAMENTE un vino del stock (usando su product_id exacto) que \
mejor conecte con la noticia (por región, uva, tipo o contexto).
Responde ÚNICAMENTE con JSON válido, sin texto adicional, con este esquema:
{
  "noticia": {"titulo": str, "resumen": str, "enlace": str},
  "recomendacion": {"product_id": str, "motivo": str}
}"""


@dataclass
class AgentResult:
    output: dict[str, Any]
    attempts: int
    valid: bool
    errors: list[str] = field(default_factory=list)


class AgentLoop:
    """Plugin de loop: encadena RSSFeedTool -> ModelPlugin -> validación -> reintento."""

    def __init__(
        self,
        model: ModelPlugin,
        rss_tool: RSSFeedTool,
        stock_tool: StockTool,
        max_attempts: int = 2,
    ):
        self.model = model
        self.rss_tool = rss_tool
        self.stock_tool = stock_tool
        self.max_attempts = max_attempts

    def _validate(self, raw: str) -> tuple[dict[str, Any] | None, list[str]]:
        errors = []
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as e:
            return None, [f"JSON inválido: {e}"]

        noticia = data.get("noticia", {})
        recomendacion = data.get("recomendacion", {})

        if not noticia.get("titulo") or not noticia.get("resumen"):
            errors.append("Falta título o resumen de la noticia")
        if len(noticia.get("resumen", "")) < 20:
            errors.append("El resumen es demasiado corto")
        product_id = recomendacion.get("product_id")
        if not product_id:
            errors.append("Falta product_id de la recomendación")
        elif product_id not in self.stock_tool.valid_ids():
            errors.append(f"product_id '{product_id}' no existe en el stock")
        if not recomendacion.get("motivo"):
            errors.append("Falta el motivo de la recomendación")

        return (data if not errors else data), errors

    def run(self, news_item: NewsItem) -> AgentResult:
        user_prompt = (
            f"NOTICIA:\nTítulo: {news_item.titulo}\n"
            f"Resumen original: {news_item.resumen}\nEnlace: {news_item.enlace}\n\n"
            f"STOCK DISPONIBLE:\n{self.stock_tool.as_prompt_context()}"
        )

        feedback = ""
        last_errors: list[str] = []
        for attempt in range(1, self.max_attempts + 1):
            prompt = user_prompt if not feedback else user_prompt + f"\n\nCORRECCIÓN NECESARIA: {feedback}"
            raw = self.model.complete(SYSTEM_PROMPT, prompt)
            data, errors = self._validate(raw)
            if not errors:
                if news_item.enlace and data["noticia"].get("enlace") != news_item.enlace:
                    data["noticia"]["enlace"] = news_item.enlace
                return AgentResult(output=data, attempts=attempt, valid=True, errors=[])
            last_errors = errors
            feedback = "; ".join(errors)

        return AgentResult(output=data or {}, attempts=self.max_attempts, valid=False, errors=last_errors)
