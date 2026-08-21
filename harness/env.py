"""Carga del `.env` del proyecto.

Se carga siempre el `.env` de la raíz del repo, no el del directorio desde el que
se lance el comando, para que `eval/eval_session.py` encuentre la clave del juez
igual desde cualquier sitio.
"""

from __future__ import annotations

import os
from pathlib import Path

ENV_PATH = Path(__file__).resolve().parent.parent / ".env"


def cargar_env(path: Path | None = None, *, override: bool = False) -> bool:
    """Vuelca el `.env` del proyecto en el entorno.

    :param path: fichero a leer; por defecto el `.env` de la raíz del repo.
    :param override: si pisar variables ya presentes en el entorno. Por defecto no,
        para que una clave puntual pasada por la shell gane sobre el fichero.
    :returns: si se llegó a leer un fichero.
    """
    destino = path or ENV_PATH
    if not destino.is_file():
        return False
    try:
        from dotenv import load_dotenv
    except ImportError:  # pragma: no cover - solo si se instala sin python-dotenv
        return _cargar_a_mano(destino, override=override)
    return load_dotenv(destino, override=override)


def _cargar_a_mano(path: Path, *, override: bool) -> bool:
    """Lectura mínima de `CLAVE=valor` para cuando falta python-dotenv."""
    for linea in path.read_text(encoding="utf-8").splitlines():
        linea = linea.strip()
        if not linea or linea.startswith("#") or "=" not in linea:
            continue
        clave, _, valor = linea.partition("=")
        clave = clave.strip()
        valor = valor.strip().strip("'\"")
        if valor and (override or clave not in os.environ):
            os.environ[clave] = valor
    return True
