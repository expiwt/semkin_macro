#!/usr/bin/env python3
"""
SEMKIN macro — локальный сервер дашборда ранних индикаторов рецессии.

Зачем он нужен:
  * Источники (FRED, FINRA, CFTC, CBOE) не отдают CORS-заголовки, поэтому
    браузер не может обращаться к ним напрямую — сервер работает как прокси.
  * Кэширует данные на диске (папка cache/), чтобы не дёргать API при каждой
    перезагрузке страницы.
  * Прячет API-ключ FRED: он остаётся на сервере и не попадает в браузер.

Источники данных:
  FRED (ФРС Сент-Луиса)
    Если задан FRED_API_KEY (переменная окружения или файл .env) — официальный
    API. Без ключа — запасной путь через публичную CSV-выгрузку графиков FRED
    (fredgraph.csv): работает, но это недокументированный интерфейс.
    Бесплатный ключ: https://fredaccount.stlouisfed.org/apikeys
  ФРС     — кредитный спред Гилкриста–Закрайшека и EBP (помесячно с 1973).
  FINRA   — маржинальный долг (xlsx, помесячно с 1997) и short interest по ETF (API, с 2017).
  CFTC    — Commitments of Traders: legacy по E-mini S&P 500 (с 1997) и Traders in Financial
            Futures по E-mini S&P 500 и NASDAQ-100 (с 2006).
  CBOE    — put/call ratio: архивные CSV (2003–2019) + дневные файлы (с октября 2019).
  datahub — помесячная история S&P 500 (данные Шиллера) до начала дневного ряда FRED.
  Мосбиржа (ISS) — индексы IMOEX, RTS, RGBI, корпоративных облигаций; кривая ОФЗ (с 2014);
            открытые позиции физлиц и юрлиц по фьючерсам (с 2020, задержка 14 дней).
  Банк России — ключевая ставка и курс доллара.

Только стандартная библиотека Python 3.8+, никаких зависимостей.

Запуск:
    python3 server.py              # http://127.0.0.1:8050
    python3 server.py --port 9000
"""

import argparse
import csv
import datetime as dt
import io
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from xml.etree import ElementTree

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(ROOT, "static")
CACHE_DIR = os.path.join(ROOT, "cache")

HOUR = 60 * 60
USER_AGENT = "recession-dashboard/2.0 (local analytics tool; python-urllib)"

# Минимальная дата, с которой запрашиваем данные FRED (берём максимум глубины).
OBSERVATION_START = "1962-01-01"

# Ряды FRED. Ключ — ID ряда на FRED.
FRED_SERIES = {
    "DGS3MO": "Доходность 3-мес. трежерис, %",
    "DGS2": "Доходность 2-летних трежерис, %",
    "DGS5": "Доходность 5-летних трежерис, %",
    "DGS10": "Доходность 10-летних трежерис, %",
    "DGS30": "Доходность 30-летних трежерис, %",
    # ICE BofA US High Yield OAS. По лицензии ICE на FRED доступны только последние ~3 года.
    "BAMLH0A0HYM2": "ICE BofA US High Yield OAS, %",
    # Длинный прокси кредитного стресса: Moody's Baa минус 10-летние трежерис, с 1986 г.
    "BAA10Y": "Moody's Baa минус 10Y Treasury, %",
    "USREC": "Рецессии NBER (1 = рецессия), помесячно",
    "M2SL": "Денежная масса M2, млрд $, помесячно",
    # Wilshire 5000 убран с FRED в 2024 г. Замена — рыночная стоимость акций всех
    # американских компаний из отчёта ФРС Z.1 (Financial Accounts), поквартально.
    "BOGZ1LM883164105Q": "Акции всех отечественных секторов по рыночной стоимости, млн $, поквартально",
    # S&P 500 на FRED доступен только за последние 10 лет (лицензия S&P).
    "SP500": "S&P 500, дневной",
    "NASDAQCOM": "NASDAQ Composite, дневной",
    "NASDAQ100": "NASDAQ-100, дневной (для перевода фьючерсов NASDAQ в доллары)",
}

# Ограничиваем одновременные запросы к одному хосту.
_fred_semaphore = threading.Semaphore(4)


# ---------------------------------------------------------------------------
# Общие утилиты
# ---------------------------------------------------------------------------

def load_api_key():
    """Ключ FRED: сначала переменная окружения, потом файл .env рядом со скриптом."""
    key = os.environ.get("FRED_API_KEY", "").strip()
    if key:
        return key
    env_path = os.path.join(ROOT, ".env")
    if os.path.exists(env_path):
        with open(env_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("FRED_API_KEY="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


def http_get(url, timeout=60, data=None, headers=None, raw=False):
    hdrs = {"User-Agent": USER_AGENT}
    hdrs.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=hdrs)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read()
    return body if raw else body.decode("utf-8")


def make_series(sid, title, source, points, note=None):
    """points: список (ISO-дата, значение) → словарь ряда, отсортированный по дате."""
    points = sorted(points)
    s = {
        "id": sid,
        "title": title,
        "source": source,
        "dates": [p[0] for p in points],
        "values": [p[1] for p in points],
    }
    if note:
        s["note"] = note
    return s


def read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def write_json(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, separators=(",", ":"))
    os.replace(tmp, path)  # атомарная замена


# ---------------------------------------------------------------------------
# Загрузчики источников. Каждый возвращает список рядов (make_series).
# ---------------------------------------------------------------------------

def fetch_fred(series_id, api_key):
    """Один ряд FRED: через API, если есть ключ, иначе через CSV-выгрузку."""
    with _fred_semaphore:
        if api_key:
            params = urllib.parse.urlencode({
                "series_id": series_id, "api_key": api_key,
                "file_type": "json", "observation_start": OBSERVATION_START,
            })
            data = json.loads(http_get(f"https://api.stlouisfed.org/fred/series/observations?{params}"))
            points = [(o["date"], float(o["value"])) for o in data.get("observations", [])
                      if o["value"] not in ("", ".")]  # '.' — пропуск в API
            source = "FRED API"
        else:
            params = urllib.parse.urlencode({"id": series_id, "cosd": OBSERVATION_START})
            reader = csv.reader(io.StringIO(http_get(f"https://fred.stlouisfed.org/graph/fredgraph.csv?{params}")))
            next(reader, None)  # заголовок: observation_date,<ID>
            points = [(r[0], float(r[1])) for r in reader if len(r) > 1 and r[1] not in ("", ".")]
            source = "FRED CSV"
    return [make_series(series_id, FRED_SERIES[series_id], source, points)]


def fetch_finra_margin(_api_key):
    """
    Маржинальный долг FINRA: «Debit Balances in Customers' Securities Margin Accounts», млн $.
    Файл xlsx разбираем без сторонних библиотек: строки в нём хранятся как inlineStr.
    До 2010 г. ряд охватывал только членов NYSE, после — все брокеры FINRA.
    """
    url = "https://www.finra.org/sites/default/files/2021-03/margin-statistics.xlsx"
    blob = http_get(url, raw=True)
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        sheet = ElementTree.fromstring(z.read("xl/worksheets/sheet1.xml"))
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():  # на случай, если формат файла поменяют
            sst = ElementTree.fromstring(z.read("xl/sharedStrings.xml"))
            shared = ["".join(t.text or "" for t in si.iter(f"{{{ns['m']}}}t")) for si in sst]

    def cell_value(c):
        t = c.get("t")
        if t == "inlineStr":
            return "".join(x.text or "" for x in c.iter(f"{{{ns['m']}}}t"))
        v = c.find("m:v", ns)
        if v is None:
            return None
        return shared[int(v.text)] if t == "s" else v.text

    points = []
    for row in sheet.iter(f"{{{ns['m']}}}row"):
        cells = {re.sub(r"\d", "", c.get("r")): cell_value(c) for c in row.findall("m:c", ns)}
        month, debit = cells.get("A"), cells.get("B")
        if month and re.fullmatch(r"\d{4}-\d{2}", month) and debit:
            points.append((month + "-01", float(debit)))
    return [make_series("MARGIN_DEBT", "Маржинальный долг (дебетовые остатки на маржинальных счетах), млн $",
                        "FINRA", points, note="Помесячно с 1997 г.; до 2010 — только члены NYSE")]


def fetch_sp500_history(_api_key):
    """Помесячная история S&P 500 (среднемесячные значения из данных Шиллера) — для лет до дневного ряда FRED."""
    text = http_get("https://raw.githubusercontent.com/datasets/s-and-p-500/main/data/data.csv")
    reader = csv.DictReader(io.StringIO(text))
    points = [(r["Date"], float(r["SP500"])) for r in reader if r.get("SP500") and r["Date"] >= "1950"]
    return [make_series("SP500_MONTHLY", "S&P 500, среднемесячно (данные Шиллера)", "datahub.io / Shiller", points)]


def fetch_cot(_api_key):
    """
    CFTC Commitments of Traders (legacy, только фьючерсы) по E-mini S&P 500 (код 13874A), еженедельно.
    Группы: коммерческие (хеджеры), некоммерческие (крупные спекулянты),
    неотчётные (мелкие трейдеры, ниже порога обязательной отчётности).
    """
    fields = ["report_date_as_yyyy_mm_dd", "open_interest_all",
              "comm_positions_long_all", "comm_positions_short_all",
              "noncomm_positions_long_all", "noncomm_positions_short_all",
              "nonrept_positions_long_all", "nonrept_positions_short_all"]
    params = urllib.parse.urlencode({
        "$where": "cftc_contract_market_code='13874A'",
        "$select": ",".join(fields),
        "$order": "report_date_as_yyyy_mm_dd",
        "$limit": "50000",
    })
    rows = json.loads(http_get(f"https://publicreporting.cftc.gov/resource/6dca-aqww.json?{params}"))
    out = {f: [] for f in fields[1:]}
    for r in rows:
        d = r["report_date_as_yyyy_mm_dd"][:10]
        for f in fields[1:]:
            if r.get(f) not in (None, ""):
                out[f].append((d, float(r[f])))
    ids = {
        "open_interest_all": "COT_OI",
        "comm_positions_long_all": "COT_COMM_LONG", "comm_positions_short_all": "COT_COMM_SHORT",
        "noncomm_positions_long_all": "COT_NONCOMM_LONG", "noncomm_positions_short_all": "COT_NONCOMM_SHORT",
        "nonrept_positions_long_all": "COT_SMALL_LONG", "nonrept_positions_short_all": "COT_SMALL_SHORT",
    }
    return [make_series(ids[f], f, "CFTC", pts, note="Еженедельно, данные на вторник, публикация в пятницу")
            for f, pts in out.items()]


SHORT_ETFS = ["SPY", "QQQ", "IWM"]


def fetch_short_interest(_api_key):
    """
    FINRA consolidated short interest по крупнейшим ETF на индексы (дважды в месяц, с конца 2017).
    Сводного short interest по всему рынку в бесплатном доступе нет, поэтому берём ETF как прокси:
    шорт в них — это ставки на падение рынка и хеджирование портфелей.
    """
    body = json.dumps({
        "limit": 5000,
        "fields": ["settlementDate", "symbolCode", "currentShortPositionQuantity", "daysToCoverQuantity"],
        "domainFilters": [{"fieldName": "symbolCode", "values": SHORT_ETFS}],
    }).encode("utf-8")
    rows = json.loads(http_get(
        "https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest",
        data=body, headers={"Content-Type": "application/json", "Accept": "application/json"}))
    shares, dtc = {s: {} for s in SHORT_ETFS}, {s: {} for s in SHORT_ETFS}
    for r in rows:
        sym, d = r.get("symbolCode"), r.get("settlementDate")
        if sym in shares and d and r.get("currentShortPositionQuantity") is not None:
            shares[sym][d] = r["currentShortPositionQuantity"] / 1e6  # млн акций; дубли схлопываются по дате
            if r.get("daysToCoverQuantity") is not None:
                dtc[sym][d] = r["daysToCoverQuantity"]
    note = "Дважды в месяц, публикуется с задержкой ~1,5 недели"
    out = []
    for sym in SHORT_ETFS:
        out.append(make_series(f"SI_{sym}", f"Short interest {sym}, млн акций", "FINRA", shares[sym].items(), note))
        out.append(make_series(f"DTC_{sym}", f"Дней на покрытие {sym}", "FINRA", dtc[sym].items(), note))
    return out


# --- Фоновая докачка дневных файлов -------------------------------------------
#
# Некоторые источники отдают историю только «по одному дню за запрос»
# (put/call CBOE после 2019 г., кривая ОФЗ Мосбиржи). Прошлые дни не меняются,
# поэтому храним их навсегда в cache/<name>.json и в фоне докачиваем недостающие.

class DailyBackfill:
    def __init__(self, name, start, fetch_day, workers=4):
        self.name = name
        self.path = os.path.join(CACHE_DIR, f"{name}.json")
        self.start = start
        self.fetch_day = fetch_day      # day -> dict значений | None (нет данных за день)
        self.workers = workers
        self.lock = threading.Lock()
        self.daily = None               # {"YYYY-MM-DD": {...} | None}
        self.thread = None
        self.started_at = 0.0
        self.progress = {"done": 0, "total": 0}

    def load(self):
        if self.daily is None:
            self.daily = read_json(self.path) or {}
        return self.daily

    def _run(self):
        daily = self.load()
        today = dt.date.today()
        todo = []
        d = self.start
        while d < today:  # сегодняшний день ещё не закрыт — не трогаем
            if d.weekday() < 5 and d.isoformat() not in daily:
                todo.append(d)
            d += dt.timedelta(days=1)
        todo.reverse()  # сначала свежие дни — чтобы текущие значения появились сразу
        self.progress.update(done=0, total=len(todo))

        def work(day):
            try:
                res = self.fetch_day(day)
            except (urllib.error.URLError, OSError, ValueError, KeyError):
                return  # временная ошибка — попробуем в следующий раз
            with self.lock:
                # Отсутствие данных запоминаем только для дней старше недели (праздники);
                # свежие дни перепроверяем — файл может появиться позже.
                if res is not None or (today - day).days > 7:
                    daily[day.isoformat()] = res
                self.progress["done"] += 1
                if self.progress["done"] % 100 == 0:
                    write_json(self.path, daily)

        with ThreadPoolExecutor(max_workers=self.workers) as pool:
            list(pool.map(work, todo))
        with self.lock:
            write_json(self.path, daily)

    def ensure(self):
        """Запускает фоновую докачку, если она не идёт и с прошлого запуска прошло больше 10 минут."""
        idle = self.thread is None or not self.thread.is_alive()
        if idle and time.time() - self.started_at > 600:
            self.started_at = time.time()
            self.thread = threading.Thread(target=self._run, daemon=True)
            self.thread.start()

    def pending(self):
        """Идёт ли докачка заметного объёма истории (перепроверка пары свежих дней не в счёт)."""
        alive = self.thread is not None and self.thread.is_alive()
        return alive and self.progress["total"] - self.progress["done"] > 5

    def series(self, ids, base=None, title="", source="", note=""):
        """Ряды из накопленных дней (плюс base — архивные ряды, которые дополняются)."""
        self.ensure()
        with self.lock:
            daily = dict(self.load())
        pending = self.pending()
        if pending:
            note += f" · идёт докачка истории: {self.progress['done']}/{self.progress['total']} дн."
        out = []
        for sid in ids:
            arch = next((s for s in (base or []) if s["id"] == sid), None)
            points = dict(zip(arch["dates"], arch["values"])) if arch else {}
            for d, v in daily.items():
                if v and sid in v:
                    points[d] = v[sid]
            s = make_series(sid, ids[sid] if isinstance(ids, dict) else title, source, points.items(), note)
            s["partial"] = pending
            out.append(s)
        return out


# --- CBOE put/call ---------------------------------------------------------
# Архивные CSV (2003–2019-10-04) + дневные JSON-файлы с 2019-10-07.

CBOE_ARCHIVE = {
    "PC_EQUITY": ["equitypc.csv"],
    "PC_TOTAL": ["totalpcarchive.csv", "totalpc.csv"],  # archive: 2003–2012, totalpc: 2006–2019
}
CBOE_NAMES = {"PC_EQUITY": "EQUITY PUT/CALL RATIO", "PC_TOTAL": "TOTAL PUT/CALL RATIO"}


def _cboe_fetch_day(day):
    """Один торговый день CBOE. None, если файла нет (праздник/ещё не вышел)."""
    url = f"https://cdn.cboe.com/data/us/options/market_statistics/daily/{day.isoformat()}_daily_options"
    try:
        data = json.loads(http_get(url, timeout=30))
    except urllib.error.HTTPError as e:
        if e.code in (403, 404):
            return None
        raise
    ratios = {r["name"]: r["value"] for r in data.get("ratios", [])}
    out = {}
    for sid, name in CBOE_NAMES.items():
        try:
            out[sid] = float(ratios[name])
        except (KeyError, TypeError, ValueError):
            pass
    return out or None


CBOE_DAILY = DailyBackfill("cboe_daily", dt.date(2019, 10, 7), _cboe_fetch_day)


def fetch_cboe_archive(_api_key):
    """Архивные CSV CBOE. Формат строк: 11/1/2006, CALLS, PUTS, TOTAL, P/C Ratio."""
    out = []
    for sid, files in CBOE_ARCHIVE.items():
        points = {}
        for fname in files:
            text = http_get(f"https://cdn.cboe.com/resources/options/volume_and_call_put_ratios/{fname}")
            for row in csv.reader(io.StringIO(text)):
                if len(row) < 5 or not re.fullmatch(r"\d{1,2}/\d{1,2}/\d{4}", row[0].strip()):
                    continue
                m, d, y = (int(x) for x in row[0].strip().split("/"))
                try:
                    points[f"{y:04d}-{m:02d}-{d:02d}"] = float(row[4])
                except ValueError:
                    continue
        out.append(make_series(sid, CBOE_NAMES[sid], "CBOE", points.items()))
    return out


# --- ФРС: кредитный спред Гилкриста–Закрайшека -------------------------------

def fetch_gz(_api_key):
    """
    GZ credit spread и excess bond premium (EBP) — помесячно с 1973 г. (FEDS Notes, ФРС).
    est_prob — оценка ФРС вероятности рецессии в ближайшие 12 месяцев по модели на EBP.
    Длинная бесплатная замена истории HY OAS, которую ICE закрыл на FRED.
    """
    text = http_get("https://www.federalreserve.gov/econres/notes/feds-notes/ebp_csv.csv")
    cols = {"gz_spread": [], "ebp": [], "est_prob": []}
    for r in csv.DictReader(io.StringIO(text)):
        m, d, y = (int(x) for x in r["date"].split("/"))
        date = f"{y:04d}-{m:02d}-{d:02d}"
        for c in cols:
            if r.get(c) not in (None, ""):
                cols[c].append((date, float(r[c])))
    note = "Помесячно, ФРС (Gilchrist & Zakrajšek), обновляется раз в квартал"
    return [
        make_series("GZ_SPREAD", "GZ credit spread, п.п.", "ФРС", cols["gz_spread"], note),
        make_series("GZ_EBP", "Excess bond premium, п.п.", "ФРС", cols["ebp"], note),
        make_series("GZ_PROB", "Вероятность рецессии в ближайшие 12 мес. (модель ФРС)", "ФРС",
                    [(d, v * 100) for d, v in cols["est_prob"]], note),
    ]


# --- CFTC Traders in Financial Futures: позиции по типам участников ----------------

TFF_CONTRACTS = {"SPX": "13874A", "NDX": "209742"}  # E-mini S&P 500 ($50×индекс), E-mini NASDAQ-100 ($20×индекс)
TFF_GROUPS = {
    "DEALER": ("dealer_positions_long_all", "dealer_positions_short_all"),
    "ASSET": ("asset_mgr_positions_long", "asset_mgr_positions_short"),
    "LEV": ("lev_money_positions_long", "lev_money_positions_short"),
    "OTHER": ("other_rept_positions_long", "other_rept_positions_short"),
    "SMALL": ("nonrept_positions_long_all", "nonrept_positions_short_all"),
}


def fetch_tff(_api_key):
    """
    Отчёт CFTC Traders in Financial Futures (с июня 2006, еженедельно): лонги и шорты в контрактах
    у дилеров, управляющих активами, хедж-фондов, прочих крупных и мелких трейдеров.
    В доллары переводит браузер: контракты × множитель × значение индекса на дату отчёта.
    """
    out = []
    for name, code in TFF_CONTRACTS.items():
        fields = ["report_date_as_yyyy_mm_dd"] + [f for pair in TFF_GROUPS.values() for f in pair]
        params = urllib.parse.urlencode({
            "$where": f"cftc_contract_market_code='{code}'",
            "$select": ",".join(fields), "$order": "report_date_as_yyyy_mm_dd", "$limit": "50000",
        })
        rows = json.loads(http_get(f"https://publicreporting.cftc.gov/resource/gpe5-46if.json?{params}"))
        for group, (lf, sf) in TFF_GROUPS.items():
            for side, f in (("L", lf), ("S", sf)):
                pts = [(r["report_date_as_yyyy_mm_dd"][:10], float(r[f])) for r in rows if r.get(f) not in (None, "")]
                out.append(make_series(f"TFF_{name}_{group}_{side}", f"{name} {group} {side}, контрактов", "CFTC TFF", pts,
                                       note="Еженедельно, данные на вторник, публикация в пятницу"))
    return out


# --- Россия: Мосбиржа (ISS) и Банк России ------------------------------------------

ISS = "https://iss.moex.com/iss"


def merge_prev(prev, sid, points):
    """Дополняет ранее скачанный ряд новыми точками (для инкрементальной загрузки)."""
    merged = dict(zip(prev[sid]["dates"], prev[sid]["values"])) if sid in prev else {}
    merged.update(points)
    return merged.items()


def last_date(prev, sid, default):
    s = prev.get(sid)
    return s["dates"][-1] if s and s["dates"] else default


MOEX_INDICES = {
    "IMOEX": ("Индекс Мосбиржи", False),
    "RTSI": ("Индекс РТС (в долларах)", False),
    "RGBI": ("Индекс гособлигаций RGBI (ценовой)", True),
    "RUCBITR": ("Индекс корпоративных облигаций RUCBITR (до мая 2023)", True),
    "RUCBTRNS": ("Индекс корпоративных облигаций RUCBTRNS (преемник RUCBITR)", True),
}


def fetch_moex_indices(_api_key, prev):
    """
    История индексов Мосбиржи, постранично по 100 строк. Первый раз — вся история
    (~70 запросов на индекс), дальше — только новые дни. Для облигационных индексов
    берём ещё доходность (YIELD, %) и дюрацию (DURATION, дней).
    """
    out = []
    for secid, (title, is_bond) in MOEX_INDICES.items():
        sid = f"MOEX_{secid}"
        start_from = (dt.date.fromisoformat(last_date(prev, sid, "1990-01-01")) - dt.timedelta(days=10)).isoformat()
        close, yld, dur = {}, {}, {}
        start = 0
        while True:
            params = urllib.parse.urlencode({
                "iss.meta": "off", "iss.only": "history", "from": start_from, "start": start,
                "history.columns": "TRADEDATE,CLOSE,YIELD,DURATION",
            })
            data = json.loads(http_get(f"{ISS}/history/engines/stock/markets/index/securities/{secid}.json?{params}"))
            rows = data["history"]["data"]
            for d, c, y, du in rows:
                if c is not None:
                    close[d] = c
                if is_bond and y:
                    yld[d] = y
                if is_bond and du:
                    dur[d] = du
            if len(rows) < 100:
                break
            start += len(rows)
        out.append(make_series(sid, title, "Мосбиржа", merge_prev(prev, sid, close)))
        if is_bond:
            out.append(make_series(f"{sid}_YIELD", f"{title}: доходность, %", "Мосбиржа", merge_prev(prev, f"{sid}_YIELD", yld)))
            out.append(make_series(f"{sid}_DUR", f"{title}: дюрация, дней", "Мосбиржа", merge_prev(prev, f"{sid}_DUR", dur)))
    return out


# Фьючерсы для отчёта «Открытые позиции» (FUTOI): физлица (FIZ) и юрлица (YUR).
FUTOI_TICKERS = {
    "MX": "Фьючерс на индекс Мосбиржи (полный)",
    "MM": "Фьючерс на индекс Мосбиржи (мини)",
    "IMOEXF": "Вечный фьючерс на индекс Мосбиржи",
    "RI": "Фьючерс на индекс РТС",
    "RB": "Фьючерс на индекс гособлигаций RGBI",
}
FUTOI_START = dt.date(2020, 1, 3)   # раньше в бесплатном доступе данных нет
FUTOI_DELAY = 15                    # бесплатно — с задержкой 14 дней


def fetch_futoi(_api_key, prev):
    """
    Открытые позиции физлиц и юрлиц по фьючерсам Мосбиржи: лонги, шорты (в контрактах)
    и число счетов с лонгами/шортами. Берём срез на конец дня (latest=1), по ~450 дней за запрос.
    """
    till = dt.date.today() - dt.timedelta(days=FUTOI_DELAY)
    out = []
    for ticker in FUTOI_TICKERS:
        key0 = f"FUTOI_{ticker}_FIZ_L"
        frm = max(FUTOI_START, dt.date.fromisoformat(last_date(prev, key0, FUTOI_START.isoformat())) - dt.timedelta(days=5))
        pts = {f"FUTOI_{ticker}_{g}_{k}": {} for g in ("FIZ", "YUR") for k in ("L", "S", "NL", "NS")}
        while frm <= till:
            to = min(till, frm + dt.timedelta(days=450))
            params = urllib.parse.urlencode({"iss.meta": "off", "from": frm.isoformat(), "till": to.isoformat(), "latest": 1})
            data = json.loads(http_get(f"{ISS}/analyticalproducts/futoi/securities/{ticker.lower()}.json?{params}"))
            block = data["futoi"]
            if "tradedate" not in block["columns"]:
                raise ValueError(f"FUTOI {ticker}: {block['data'][:1]}")
            idx = {c: i for i, c in enumerate(block["columns"])}
            for r in block["data"]:
                d, g = r[idx["tradedate"]], r[idx["clgroup"]]
                if g not in ("FIZ", "YUR"):
                    continue
                p = f"FUTOI_{ticker}_{g}_"
                pts[p + "L"][d] = r[idx["pos_long"]]
                pts[p + "S"][d] = abs(r[idx["pos_short"]])  # шорты приходят со знаком минус
                pts[p + "NL"][d] = r[idx["pos_long_num"]]
                pts[p + "NS"][d] = r[idx["pos_short_num"]]
            frm = to + dt.timedelta(days=1)
        for sid, p in pts.items():
            out.append(make_series(sid, f"{FUTOI_TICKERS[ticker]}: {sid}", "Мосбиржа FUTOI", merge_prev(prev, sid, p),
                                   note=f"Ежедневно, бесплатно — с задержкой {FUTOI_DELAY - 1} дней"))
    return out


def _zcyc_fetch_day(day):
    """Кривая бескупонной доходности ОФЗ (КБД) Мосбиржи на дату: доходности по срокам, % годовых."""
    params = urllib.parse.urlencode({"iss.meta": "off", "iss.only": "yearyields", "date": day.isoformat()})
    rows = json.loads(http_get(f"{ISS}/engines/stock/zcyc.json?{params}", timeout=30))["yearyields"]["data"]
    terms = {0.25: "OFZ_3M", 1.0: "OFZ_1Y", 2.0: "OFZ_2Y", 5.0: "OFZ_5Y", 10.0: "OFZ_10Y", 20.0: "OFZ_20Y"}
    out = {terms[float(r[2])]: r[3] for r in rows if r[0] == day.isoformat() and float(r[2]) in terms}
    return out or None


ZCYC_DAILY = DailyBackfill("moex_zcyc_daily", dt.date(2014, 1, 6), _zcyc_fetch_day)
ZCYC_NAMES = {"OFZ_3M": "ОФЗ 3 мес", "OFZ_1Y": "ОФЗ 1 год", "OFZ_2Y": "ОФЗ 2 года", "OFZ_5Y": "ОФЗ 5 лет",
              "OFZ_10Y": "ОФЗ 10 лет", "OFZ_20Y": "ОФЗ 20 лет"}


def fetch_cbr(_api_key):
    """Банк России: ключевая ставка (с 2013) и официальный курс доллара (с 1992)."""
    today = dt.date.today()
    html = http_get("https://www.cbr.ru/hd_base/KeyRate/?UniDbQuery.Posted=True&UniDbQuery.From=17.09.2013"
                    f"&UniDbQuery.To={today:%d.%m.%Y}")
    cells = re.findall(r"<td>\s*([^<]*?)\s*</td>", html)
    key = []
    for d, v in zip(cells[::2], cells[1::2]):
        if re.fullmatch(r"\d{2}\.\d{2}\.\d{4}", d):
            key.append((f"{d[6:]}-{d[3:5]}-{d[:2]}", float(v.replace(",", "."))))
    xml = http_get("https://www.cbr.ru/scripts/XML_dynamic.asp?date_req1=01/01/1995"
                   f"&date_req2={today:%d/%m/%Y}&VAL_NM_RQ=R01235", raw=True)
    usd = []
    for rec in ElementTree.fromstring(xml).iter("Record"):
        d = rec.get("Date")
        nominal = float(rec.findtext("Nominal").replace(",", "."))
        usd.append((f"{d[6:]}-{d[3:5]}-{d[:2]}", float(rec.findtext("Value").replace(",", ".")) / nominal))
    return [make_series("CBR_KEYRATE", "Ключевая ставка Банка России, %", "Банк России", key),
            make_series("CBR_USDRUB", "Официальный курс доллара, ₽", "Банк России", usd)]


# ---------------------------------------------------------------------------
# Кэш источников
# ---------------------------------------------------------------------------

# Источник: ключ кэша → (функция загрузки, срок свежести кэша в секундах, инкрементальный ли).
# Инкрементальные загрузчики получают ранее скачанные ряды и докачивают только новые дни.
SOURCES = {f"fred_{sid}": (lambda key, sid=sid: fetch_fred(sid, key), 6 * HOUR, False) for sid in FRED_SERIES}
SOURCES.update({
    "finra_margin": (fetch_finra_margin, 24 * HOUR, False),
    "sp500_history": (fetch_sp500_history, 7 * 24 * HOUR, False),
    "cftc_cot": (fetch_cot, 12 * HOUR, False),
    "cftc_tff": (fetch_tff, 12 * HOUR, False),
    "finra_short": (fetch_short_interest, 24 * HOUR, False),
    "cboe_archive": (fetch_cboe_archive, 30 * 24 * HOUR, False),  # архив не меняется
    "fed_gz": (fetch_gz, 24 * HOUR, False),
    "moex_indices": (fetch_moex_indices, 6 * HOUR, True),
    "moex_futoi": (fetch_futoi, 12 * HOUR, True),
    "cbr": (fetch_cbr, 6 * HOUR, False),
})


def load_source(key, api_key, force=False):
    """
    Возвращает ряды источника из кэша, если он свежий; иначе скачивает заново.
    Если источник недоступен, отдаёт устаревший кэш — лучше старые данные, чем пустой график.
    """
    fetch, ttl, incremental = SOURCES[key]
    path = os.path.join(CACHE_DIR, f"{key}.json")
    cached = read_json(path)
    if cached and not force and time.time() - cached["fetched_at"] < ttl:
        return dict(cached, cache="hit")
    try:
        if incremental:
            prev = {s["id"]: s for s in (cached or {}).get("series", [])}
            series = fetch(api_key, prev)
        else:
            series = fetch(api_key)
        payload = {"key": key, "fetched_at": time.time(), "series": series}
        write_json(path, payload)
        return dict(payload, cache="miss")
    except (urllib.error.URLError, OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile,
            ElementTree.ParseError) as exc:
        if cached:
            return dict(cached, cache="stale", error=str(exc))
        return {"key": key, "fetched_at": None, "series": [], "cache": "error", "error": str(exc)}


# Не даём двум одновременным запросам параллельно качать одно и то же.
_fetch_lock = threading.Lock()


def get_all(force=False):
    api_key = load_api_key()
    with _fetch_lock, ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda k: load_source(k, api_key, force), SOURCES))

    series, sources = {}, {}
    for r in results:
        sources[r["key"]] = {k: r.get(k) for k in ("fetched_at", "cache", "error")}
        if r["key"] == "cboe_archive":
            # Архив CBOE дополняется дневными файлами после октября 2019 г.
            r["series"] = CBOE_DAILY.series(CBOE_NAMES, base=r["series"], source="CBOE",
                                            note="Ежедневно; архив CBOE до окт. 2019, далее дневные файлы CBOE")
        for s in r["series"]:
            series[s["id"]] = dict(s, fetched_at=r["fetched_at"], cache=r["cache"])

    # Кривая ОФЗ целиком собирается из дневных файлов Мосбиржи.
    for s in ZCYC_DAILY.series(ZCYC_NAMES, source="Мосбиржа", note="Кривая бескупонной доходности ОФЗ, ежедневно с 2014 г."):
        series[s["id"]] = dict(s, fetched_at=time.time(), cache="backfill")
    return {"generated_at": time.time(), "has_api_key": bool(api_key), "series": series, "sources": sources}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/data":
            force = "refresh=1" in (parsed.query or "")
            body = json.dumps(get_all(force=force), separators=(",", ":")).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def end_headers(self):
        # Статику не кэшируем в браузере, чтобы правки кода подхватывались сразу.
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))


def main():
    parser = argparse.ArgumentParser(description="SEMKIN macro — дашборд ранних индикаторов рецессии")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8050)
    args = parser.parse_args()

    if load_api_key():
        print("FRED_API_KEY найден — данные FRED берутся из официального API.")
    else:
        print("FRED_API_KEY не задан — для FRED используется запасной CSV-источник.\n"
              "Бесплатный ключ: https://fredaccount.stlouisfed.org/apikeys "
              "(положите его в .env: FRED_API_KEY=...)")

    # История put/call и кривой ОФЗ докачивается в фоне с первого запуска.
    CBOE_DAILY.ensure()
    ZCYC_DAILY.ensure()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"SEMKIN macro: http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
