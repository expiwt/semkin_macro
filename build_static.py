#!/usr/bin/env python3
"""
SEMKIN macro — сборка статической версии сайта для GitHub Pages.

Что делает:
  1. Скачивает все данные тем же кодом, что и server.py (кэш в cache/ переиспользуется).
     История put/call и кривой ОФЗ докачивается синхронно, до конца.
  2. Сжимает данные (gzip) и шифрует паролем: AES-256-GCM, ключ из пароля через
     PBKDF2-SHA256. Без пароля из опубликованного файла ничего не прочитать.
  3. Складывает в dist/ страницу, скрипты и зашифрованный data.enc.

Браузер расшифровывает данные сам (Web Crypto API), сервер не нужен.

Переменные окружения:
  DASHBOARD_PASSWORD — пароль для входа на сайт (обязательно);
  FRED_API_KEY       — ключ FRED (необязательно, без него — CSV-выгрузка FRED).

Нужна библиотека cryptography (pip install cryptography): в стандартной библиотеке
Python нет AES. Сам server.py по-прежнему работает без зависимостей.

Запуск:
    DASHBOARD_PASSWORD=... python3 build_static.py
"""

import gzip
import hashlib
import json
import os
import shutil
import sys
import time

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

import server

DIST = os.path.join(server.ROOT, "dist")

# Параметры шифрования — должны совпадать с ENC_* в static/app.js.
# Соль фиксированная: тогда ключ, сохранённый в браузере («запомнить меня»),
# продолжает подходить после ежедневных пересборок.
ENC_SALT = b"semkin-macro/v1"
ENC_ITERATIONS = 600_000


def encrypt(payload: bytes, password: str) -> bytes:
    """Формат data.enc: 12 байт IV + шифротекст AES-GCM (с тегом в конце)."""
    key = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), ENC_SALT, ENC_ITERATIONS, dklen=32)
    iv = os.urandom(12)
    return iv + AESGCM(key).encrypt(iv, payload, None)


def main():
    password = os.environ.get("DASHBOARD_PASSWORD", "")
    if len(password) < 8:
        sys.exit("Задайте DASHBOARD_PASSWORD (не короче 8 символов).")

    # Фоновую докачку выполняем синхронно и до конца — в сборке нет «потом».
    for backfill in (server.CBOE_DAILY, server.ZCYC_DAILY):
        t = time.time()
        backfill.verbose = True
        print(f"{backfill.name}: докачка истории…", flush=True)
        backfill._run()
        backfill.started_at = time.time()  # не запускать её повторно внутри get_all()
        print(f"{backfill.name}: докачано {backfill.progress['done']} дн. за {time.time() - t:.0f} с")

    data = server.get_all()

    # Сводка по источникам — видна в логе GitHub Actions.
    failed = []
    for key, src in sorted(data["sources"].items()):
        mark = {"hit": "кэш", "miss": "скачано", "stale": "УСТАРЕВШИЙ КЭШ", "error": "ОШИБКА"}.get(src["cache"], src["cache"])
        print(f"  {key:28s} {mark}{(': ' + src['error']) if src.get('error') else ''}")
        if src["cache"] == "error":
            failed.append(key)

    raw = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    blob = encrypt(gzip.compress(raw, compresslevel=9), password)

    shutil.rmtree(DIST, ignore_errors=True)
    shutil.copytree(server.STATIC_DIR, DIST)
    with open(os.path.join(DIST, "data.enc"), "wb") as f:
        f.write(blob)
    open(os.path.join(DIST, ".nojekyll"), "w").close()  # GitHub Pages: отдавать файлы как есть

    # Открытый статус источников: какие ответили, какие нет. Без данных и без секретов —
    # чтобы проверять сборку, не заходя в лог GitHub Actions.
    fred_key = os.environ.get("FRED_API_KEY", "")
    status = {
        "generated_at": data["generated_at"],
        "sources": {k: {"cache": v["cache"], "error": (v.get("error") or "").replace(fred_key or "\0", "***") or None}
                    for k, v in data["sources"].items()},
    }
    with open(os.path.join(DIST, "status.json"), "w", encoding="utf-8") as f:
        json.dump(status, f, ensure_ascii=False, indent=1)

    # Включаем на странице статический режим: данные из data.enc вместо /api/data.
    index = os.path.join(DIST, "index.html")
    with open(index, encoding="utf-8") as f:
        html = f.read()
    marker = "window.SEMKIN_STATIC = false;"
    if marker not in html:
        sys.exit("В index.html не найден маркер статического режима.")
    with open(index, "w", encoding="utf-8") as f:
        f.write(html.replace(marker, "window.SEMKIN_STATIC = true;"))

    print(f"Готово: dist/ ({len(raw) / 1e6:.1f} МБ данных → {len(blob) / 1e6:.1f} МБ зашифровано)")
    if failed:
        print(f"Внимание, нет данных из источников: {', '.join(failed)}")
    # Падаем, только если не пришло вообще ничего — частичные данные лучше пустого сайта.
    if len(failed) == len(data["sources"]):
        sys.exit("Ни один источник не ответил.")


if __name__ == "__main__":
    main()
