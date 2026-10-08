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
            открытые позиции физлиц и юрлиц по фьючерсам (с 2020; API — с задержкой 14 дней,
            последние две недели — с сайта Мосбиржи).
  Банк России — ключевая ставка и курс доллара.
  Минфин — исполнение федерального бюджета (с 2011) и ФНБ (с 2008); SIPRI — военные расходы.
  Другие страны — Банк Англии, Минфин Японии, Шанхайская биржа, ЕЦБ, HKMA; цены на жильё и долг
            домохозяйств — BIS (через FRED).

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
    "MORTGAGE30US": "Ставка по 30-летней фиксированной ипотеке в США, %",

    # Недвижимость (BIS): цены на жильё — номинальные и реальные (с поправкой на инфляцию), индекс;
    # долг домохозяйств — % ВВП. Есть по всем странам дашборда.
    **{f"Q{c}N628BIS": f"Цены на жильё, {c} (BIS, номинальные)" for c in ("US", "RU", "FR", "GB", "JP", "CN", "HK")},
    **{f"Q{c}R628BIS": f"Цены на жильё, {c} (BIS, реальные)" for c in ("US", "RU", "FR", "GB", "JP", "CN", "HK")},
    **{f"Q{c}HAM770A": f"Долг домохозяйств, {c}, % ВВП (BIS)" for c in ("US", "RU", "FR", "GB", "JP", "CN", "HK")},

    # Франция
    "IRLTLT01FRM156N": "Франция: 10-летние гособлигации (OAT), %, помесячно",
    "IR3TIB01FRM156N": "Франция: 3-месячная межбанковская ставка, %, помесячно",
    "IRLTLT01DEM156N": "Германия: 10-летние гособлигации (Bund), %, помесячно",
    "ECBDFR": "Депозитная ставка ЕЦБ, %",
    "DEXUSEU": "Долларов за 1 евро",
    "SPASTT01FRM661N": "Франция: цены акций (ОЭСР, 2015 = 100), помесячно",
    "CLVMNACSCAB1GQFR": "Франция: реальный ВВП, поквартально",
    # Великобритания
    "DEXUSUK": "Долларов за 1 фунт",
    "SPASTT01GBM661N": "Великобритания: цены акций (ОЭСР, 2015 = 100), помесячно",
    "NGDPRSAXDCGBQ": "Великобритания: реальный ВВП, поквартально",
    # Япония
    "DEXJPUS": "Иен за 1 доллар",
    "NIKKEI225": "Nikkei 225",
    "IRSTCI01JPM156N": "Япония: ставка овернайт (call rate), %, помесячно",
    # Китай
    "DEXCHUS": "Юаней за 1 доллар",
    "IR3TIB01CNM156N": "Китай: 3-месячная межбанковская ставка, %, помесячно",
    # Гонконг
    "DEXHKUS": "Гонконгских долларов за 1 доллар США",

    # Реальная доходность акций США: инфляция и реальная доходность гособлигаций
    "CPIAUCSL": "Индекс потребительских цен США (CPI), помесячно",
    "DFII10": "Реальная доходность 10-летних TIPS, %",
    # Сырьё и мировая торговля
    "DCOILWTICO": "Нефть WTI, $/баррель",
    "DCOILBRENTEU": "Нефть Brent, $/баррель",
    "DHHNGSP": "Газ Henry Hub (США), $/млн БТЕ",
    "PNGASEUUSDM": "Газ в Европе (TTF), $/млн БТЕ, помесячно (МВФ)",
    "PNGASJPUSDM": "СПГ в Азии, $/млн БТЕ, помесячно (МВФ)",
    "PWHEAMTUSDM": "Пшеница, $/т, помесячно (МВФ)",
    "PMAIZMTUSDM": "Кукуруза, $/т, помесячно (МВФ)",
    "PSOYBUSDM": "Соя, $/т, помесячно (МВФ)",
    "PCOPPUSDM": "Медь, $/т, помесячно (МВФ)",
    "PALLFNFINDEXM": "Глобальный индекс цен на сырьё (МВФ), помесячно",
    "DTWEXBGS": "Индекс доллара США к валютам торговых партнёров (ФРС)",
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
        self.verbose = False            # печатать прогресс (для сборки в GitHub Actions)
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
                    if self.verbose:
                        print(f"  {self.name}: {self.progress['done']}/{self.progress['total']} дн.", flush=True)

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
    # Сырьё: Brent (10 и 1 баррель), газ Henry Hub (100 и 1 млн БТЕ), пшеница (1 т), золото (1 унция)
    "BR": "Фьючерс на нефть Brent", "BM": "Фьючерс на нефть Brent (мини)",
    "NG": "Фьючерс на газ Henry Hub", "NR": "Фьючерс на газ Henry Hub (мини)",
    "W4": "Фьючерс на пшеницу", "GD": "Фьючерс на золото",
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
                                   note="Ежедневно; последние 2 недели — с сайта Мосбиржи"))

    # Последние ~14 дней API отдаёт только платным пользователям, но те же цифры бесплатно
    # публикуются на сайте Мосбиржи — по одному CSV-файлу на день. Добираем недостающие дни.
    fresh = fetch_moex_open_positions(till + dt.timedelta(days=1), dt.date.today())
    by_id = {s["id"]: s for s in out}
    for sid, points in fresh.items():
        if sid in by_id and points:
            merged = dict(zip(by_id[sid]["dates"], by_id[sid]["values"]))
            merged.update(points)
            by_id[sid].update(make_series(sid, by_id[sid]["title"], by_id[sid]["source"], merged.items(), by_id[sid].get("note")))
    return out


# Базовые активы на сайте Мосбиржи → тикеры отчёта FUTOI.
MOEX_SITE_ASSETS = {"MIX": "MX", "MXI": "MM", "IMOEX": "IMOEXF", "RTS": "RI", "RGBI": "RB",
                    "BR": "BR", "BRM": "BM", "NG": "NG", "NGM": "NR", "WHEAT": "W4", "GOLD": "GD"}


def fetch_moex_open_positions(start, end):
    """
    Открытые позиции физлиц и юрлиц с сайта Мосбиржи (moex.com/ru/derivatives/open-positions):
    один CSV на торговый день, без задержки. Возвращает {ID ряда FUTOI: {дата: значение}}.
    Физлица помечены iz_fiz = 1, юрлица — пустым полем.
    """
    out = {}
    d = start
    while d <= end:
        if d.weekday() < 5:
            url = f"https://www.moex.com/ru/derivatives/open-positions-csv.aspx?d={d:%Y%m%d}&t=1"
            try:
                text = http_get(url, timeout=30, headers={"User-Agent": "Mozilla/5.0"}).lstrip("\ufeff")
            except (urllib.error.URLError, OSError):
                text = ""
            for r in csv.DictReader(io.StringIO(text)):
                ticker = MOEX_SITE_ASSETS.get(r.get("isin"))
                if r.get("contract_type") != "F" or not ticker or r.get("moment") != d.isoformat():
                    continue
                group = "FIZ" if (r.get("iz_fiz") or "").strip() else "YUR"
                p = f"FUTOI_{ticker}_{group}_"
                try:
                    vals = {"L": float(r["long_position"]), "S": abs(float(r["short_position"])),
                            "NL": float(r["clients_in_long"]), "NS": float(r["clients_in_short"])}
                except (KeyError, ValueError):
                    continue
                for k, v in vals.items():
                    out.setdefault(p + k, {})[d.isoformat()] = v
        d += dt.timedelta(days=1)
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
    """Банк России: ключевая ставка (с 2013) и официальные курсы доллара и юаня."""
    today = dt.date.today()
    html = http_get("https://www.cbr.ru/hd_base/KeyRate/?UniDbQuery.Posted=True&UniDbQuery.From=17.09.2013"
                    f"&UniDbQuery.To={today:%d.%m.%Y}")
    cells = re.findall(r"<td>\s*([^<]*?)\s*</td>", html)
    key = []
    for d, v in zip(cells[::2], cells[1::2]):
        if re.fullmatch(r"\d{2}\.\d{2}\.\d{4}", d):
            key.append((f"{d[6:]}-{d[3:5]}-{d[:2]}", float(v.replace(",", "."))))
    def rate(code):
        """Официальный курс валюты к рублю за единицу (номинал ЦБ бывает 1, 10, 100 — делим)."""
        xml = http_get("https://www.cbr.ru/scripts/XML_dynamic.asp?date_req1=01/01/1995"
                       f"&date_req2={today:%d/%m/%Y}&VAL_NM_RQ={code}", raw=True)
        pts = []
        for rec in ElementTree.fromstring(xml).iter("Record"):
            d = rec.get("Date")
            nominal = float(rec.findtext("Nominal").replace(",", "."))
            iso = f"{d[6:]}-{d[3:5]}-{d[:2]}"
            value = float(rec.findtext("Value").replace(",", ".")) / nominal
            if iso < "1998-01-01":
                value /= 1000  # деноминация рубля 1 января 1998 г.: 1000 старых рублей = 1 новый
            pts.append((iso, value))
        return pts

    return [make_series("CBR_KEYRATE", "Ключевая ставка Банка России, %", "Банк России", key),
            make_series("CBR_USDRUB", "Официальный курс доллара, ₽", "Банк России", rate("R01235")),
            make_series("CBR_CNYRUB", "Официальный курс юаня, ₽", "Банк России", rate("R01375"))]


# --- Бюджет России: Минфин и SIPRI ---------------------------------------------

XLSX_NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
           "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}


def _col_index(ref):
    """'AB12' → 27 (номер колонки с нуля)."""
    n = 0
    for ch in re.match(r"[A-Z]+", ref).group(0):
        n = n * 26 + ord(ch) - 64
    return n - 1


def read_xlsx(blob, sheet=None):
    """
    Минимальный разбор xlsx без сторонних библиотек: строки листа как списки значений
    (число → float, текст → str, пусто → None). sheet — имя листа; по умолчанию первый.
    Даты в Excel хранятся числами (дни от 1899-12-30) — их переводит excel_date().
    """
    m = XLSX_NS["m"]
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            sst = ElementTree.fromstring(z.read("xl/sharedStrings.xml"))
            shared = ["".join(t.text or "" for t in si.iter(f"{{{m}}}t")) for si in sst]
        wb = ElementTree.fromstring(z.read("xl/workbook.xml"))
        rels = ElementTree.fromstring(z.read("xl/_rels/workbook.xml.rels"))
        targets = {r.get("Id"): r.get("Target") for r in rels}
        sheets = [(s.get("name"), targets[s.get(f"{{{XLSX_NS['r']}}}id")]) for s in wb.iter(f"{{{m}}}sheet")]
        name, target = next(((n, t) for n, t in sheets if n == sheet), sheets[0]) if sheet else sheets[0]
        path = target.lstrip("/") if target.startswith("/") else "xl/" + target
        root = ElementTree.fromstring(z.read(path))
    rows = []
    for row in root.iter(f"{{{m}}}row"):
        vals = {}
        for c in row.findall(f"{{{m}}}c"):
            t, v = c.get("t"), c.find(f"{{{m}}}v")
            if t == "inlineStr":
                val = "".join(x.text or "" for x in c.iter(f"{{{m}}}t"))
            elif v is None or v.text is None:
                continue
            elif t == "s":
                val = shared[int(v.text)]
            elif t in ("str", "e", "b"):
                val = v.text
            else:
                try:
                    val = float(v.text)
                except ValueError:
                    val = v.text
            vals[_col_index(c.get("r"))] = val
        rows.append([vals.get(i) for i in range(max(vals) + 1)] if vals else [])
    return rows


def excel_date(serial):
    return (dt.date(1899, 12, 30) + dt.timedelta(days=int(serial))).isoformat()


RU_MONTHS = {"янв": 1, "фев": 2, "мар": 3, "апр": 4, "май": 5, "мая": 5, "июн": 6,
             "июл": 7, "авг": 8, "сен": 9, "окт": 10, "ноя": 11, "дек": 12}


def month_header(value):
    """Заголовок колонки Минфина → 'YYYY-MM-01'. Бывает датой Excel, 'фев.26 ***' или 'Январь 2008¹'."""
    if isinstance(value, float) and value > 20000:
        return excel_date(value)[:8] + "01"
    if isinstance(value, str):
        mt = re.match(r"\s*([А-Яа-яЁё]+)\.?\s*(\d{2,4})", value)
        if mt and mt.group(1)[:3].lower() in RU_MONTHS:
            year = int(mt.group(2))
            year += 2000 if year < 100 else 0
            return f"{year:04d}-{RU_MONTHS[mt.group(1)[:3].lower()]:02d}-01"
    return None


def minfin_link(page, pattern):
    """Ссылка на свежий файл на странице Минфина (имя файла меняется каждый месяц)."""
    html = http_get(f"https://minfin.gov.ru{page}", headers={"User-Agent": "Mozilla/5.0"})
    found = re.findall(r'href="([^"]*' + pattern + r'[^"]*\.xlsx)"', html)
    if not found:
        raise ValueError(f"На странице {page} не найден файл {pattern}")
    return "https://minfin.gov.ru" + urllib.parse.quote(found[0])


def minfin_table(rows, wanted):
    """
    Таблица Минфина «показатели по строкам × месяцы по колонкам».
    wanted: {ID ряда: начало названия строки}. Возвращает {ID: [(дата, значение)]}.
    """
    hdr = next(r for r in rows if r and any(month_header(v) for v in r[2:]))
    dates = {i: month_header(v) for i, v in enumerate(hdr) if i >= 2 and month_header(v)}
    out = {sid: [] for sid in wanted}
    for r in rows:
        label = str(r[1]).strip() if len(r) > 1 and r[1] else ""
        for sid, prefix in wanted.items():
            if label.startswith(prefix) and not out[sid]:
                out[sid] = [(d, r[i]) for i, d in dates.items() if i < len(r) and isinstance(r[i], float)]
    return out


BUDGET_ROWS = {
    "BUD_REV": "Доходы, всего",
    "BUD_OILGAS": "Нефтегазовые доходы",
    "BUD_NONOIL": "Ненефтегазовые доходы",
    "BUD_EXP": "Расходы, всего",
    "BUD_DEFENSE": "Национальная оборона",
    "BUD_SECURITY": "Национальная безопасность",
    "BUD_SOCIAL": "Социальная политика",
    "BUD_DEBTSERV": "Обслуживание государственного",
    "BUD_BALANCE": "Дефицит (-)/Профицит (+)",
    "BUD_NONOIL_BALANCE": "Ненефтегазовый дефицит",
}


def fetch_minfin_budget(_api_key):
    """
    Краткая ежемесячная информация об исполнении федерального бюджета (Минфин), млрд ₽,
    нарастающим итогом с начала года, с 2011 г. Расходы по разделам (оборона и др.)
    Минфин публикует только до 2021 г. — дальше эти строки пустые.
    """
    url = minfin_link("/ru/statistics/fedbud/execute/", "_mes")
    table = minfin_table(read_xlsx(http_get(url, raw=True, headers={"User-Agent": "Mozilla/5.0"})), BUDGET_ROWS)
    note = "Минфин, помесячно нарастающим итогом с начала года; последние месяцы — оценка"
    return [make_series(sid, BUDGET_ROWS[sid] + ", млрд ₽ (с начала года)", "Минфин", pts, note)
            for sid, pts in table.items()]


NWF_ROWS = {
    "NWF_TOTAL": "Объем на конец периода",
    "NWF_GDP": "в т.ч. в процентах к ВВП",
    "NWF_USD": "Объем средств фонда на конец периода (млрд. долларов",
    "NWF_IN": "Поступления",
    "NWF_OUT": "Изъятия",
    "NWF_OTHER": "Размещено в иные разрешенные активы",
}


def fetch_minfin_nwf(_api_key):
    """
    Фонд национального благосостояния (Минфин), помесячно с 2008 г., млрд ₽.
    «Иные разрешённые активы» — вложения в акции, облигации и проекты; ликвидная часть
    считается в браузере как объём минус иные активы.
    """
    url = minfin_link("/ru/perfomance/nationalwealthfund/statistics/", "Dannye_")
    table = minfin_table(read_xlsx(http_get(url, raw=True, headers={"User-Agent": "Mozilla/5.0"})), NWF_ROWS)
    table["NWF_GDP"] = [(d, v * 100) for d, v in table["NWF_GDP"]]  # доля → проценты
    note = "Минфин, данные на начало следующего месяца"
    return [make_series(sid, f"ФНБ: {NWF_ROWS[sid]}", "Минфин", pts, note) for sid, pts in table.items()]


def fetch_sipri(_api_key):
    """
    SIPRI Military Expenditure Database: военные расходы России по годам — в рублях,
    в % ВВП и в % всех госрасходов. Оценка SIPRI шире раздела «Национальная оборона»
    (включает, например, военные пенсии и часть расходов силовых ведомств).
    """
    year = dt.date.today().year
    blob = None
    for y in (year, year - 1, year - 2):  # файл называется по последнему году данных
        try:
            blob = http_get(f"https://www.sipri.org/sites/default/files/SIPRI-Milex-data-1949-{y - 1}.xlsx", raw=True)
            break
        except urllib.error.HTTPError:
            continue
    if blob is None:
        raise ValueError("Файл SIPRI не найден")

    def russia(sheet, scale):
        rows = read_xlsx(blob, sheet)
        hdr = next(r for r in rows if r and r[0] == "Country")
        ru = next(r for r in rows if r and isinstance(r[0], str) and r[0].strip() == "Russia")
        return [(f"{int(h)}-07-01", v * scale) for h, v in zip(hdr, ru)
                if isinstance(h, float) and isinstance(v, float) and h >= 1993]

    note = "SIPRI, оценка по календарным годам"
    return [
        make_series("SIPRI_RU_RUB", "Военные расходы России (SIPRI), млрд ₽", "SIPRI",
                    russia("Local currency calendar years", 1e-9), note),
        make_series("SIPRI_RU_GDP", "Военные расходы России, % ВВП (SIPRI)", "SIPRI", russia("Share of GDP", 100), note),
        make_series("SIPRI_RU_GOV", "Военные расходы России, % госрасходов (SIPRI)", "SIPRI",
                    russia("Share of Govt. spending", 100), note),
    ]


# --- Другие страны: центробанки и биржи ---------------------------------------------

def fetch_boe(_api_key):
    """
    Банк Англии (база IADB): доходности гилтов (бескупонные, 5/10/20 лет) и ключевая ставка — ежедневно;
    ипотечные ставки — помесячно. Дата в файле: '31 Jan 2026'.
    """
    def iadb(codes, start):
        url = ("https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?csv.x=yes"
               f"&Datefrom={start}&Dateto=now&SeriesCodes={','.join(codes)}&CSVF=TN&UsingCodes=Y&VPD=Y&VFD=N")
        rows = list(csv.reader(io.StringIO(http_get(url, timeout=90, headers={"User-Agent": "Mozilla/5.0"}))))
        out = {c: [] for c in codes}
        for r in rows[1:]:
            try:
                d = dt.datetime.strptime(r[0].strip(), "%d %b %Y").date().isoformat()
            except (ValueError, IndexError):
                continue
            for c, v in zip(codes, r[1:]):
                if v.strip():
                    out[c].append((d, float(v)))
        return out

    names = {"IUDSNZC": "Гилты 5 лет, %", "IUDMNZC": "Гилты 10 лет, %", "IUDLNZC": "Гилты 20 лет, %",
             "IUDBEDR": "Ключевая ставка Банка Англии, %",
             "IUMBV34": "Ипотека: 2-летняя фиксированная ставка (LTV 75%), %",
             "CFMHSDE": "Ипотека: эффективная ставка по новым кредитам, %"}
    data = iadb(["IUDSNZC", "IUDMNZC", "IUDLNZC", "IUDBEDR"], "01/Jan/1975")
    data.update(iadb(["IUMBV34", "CFMHSDE"], "01/Jan/1995"))
    return [make_series(f"BOE_{c}", names[c], "Банк Англии", pts) for c, pts in data.items()]


def fetch_jgb(_api_key):
    """Минфин Японии: доходности гособлигаций JGB по срокам, ежедневно с 1974 г. (архив + текущий месяц)."""
    base = "https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate"
    terms = {"2Y": "JGB_2Y", "10Y": "JGB_10Y", "30Y": "JGB_30Y"}
    points = {sid: {} for sid in terms.values()}
    for url in (f"{base}/historical/jgbcme_all.csv", f"{base}/jgbcme.csv"):
        text = http_get(url, timeout=90, raw=True).decode("cp932", errors="replace")  # файл в японской кодировке
        rows = list(csv.reader(io.StringIO(text)))
        hdr = next((r for r in rows if r and r[0].strip() == "Date"), None)
        if not hdr:
            continue
        idx = {t: hdr.index(t) for t in terms if t in hdr}
        for r in rows:
            if not r or not re.fullmatch(r"\d{4}/\d{1,2}/\d{1,2}", r[0].strip()):
                continue
            y, m, d = (int(x) for x in r[0].strip().split("/"))
            for t, i in idx.items():
                if i < len(r) and r[i].strip() not in ("", "-"):
                    points[terms[t]][f"{y:04d}-{m:02d}-{d:02d}"] = float(r[i])
    names = {"JGB_2Y": "JGB 2 года, %", "JGB_10Y": "JGB 10 лет, %", "JGB_30Y": "JGB 30 лет, %"}
    return [make_series(sid, names[sid], "Минфин Японии", pts.items()) for sid, pts in points.items()]


def fetch_sse(_api_key):
    """Шанхайская биржа: индекс SSE Composite, ежедневно с декабря 1990 г. (вся история одним запросом)."""
    data = json.loads(http_get("http://yunhq.sse.com.cn:32041/v1/sh1/dayk/000001?begin=-20000&end=-1&period=day", timeout=60))
    pts = [(f"{str(k[0])[:4]}-{str(k[0])[4:6]}-{str(k[0])[6:]}", float(k[4])) for k in data["kline"]]
    return [make_series("SSE_COMP", "SSE Composite (Шанхай)", "Шанхайская биржа", pts)]


def fetch_ecb_mir(_api_key):
    """ЕЦБ: средняя ставка по новым ипотечным кредитам во Франции, помесячно с 2003 г."""
    url = "https://data-api.ecb.europa.eu/service/data/MIR/M.FR.B.A2C.A.R.A.2250.EUR.N?format=csvdata"
    rows = csv.DictReader(io.StringIO(http_get(url, timeout=120)))
    pts = [(r["TIME_PERIOD"] + "-01", float(r["OBS_VALUE"])) for r in rows if r.get("OBS_VALUE")]
    return [make_series("FR_MORTGAGE", "Франция: ставка по новым ипотечным кредитам, %", "ЕЦБ", pts)]


def fetch_hkma(_api_key, prev):
    """
    Денежное управление Гонконга (HKMA): HIBOR овернайт и на 1 месяц, базовая ставка — ежедневно.
    Ипотека в Гонконге в основном привязана к HIBOR. Записи идут от новых к старым, по 1000 за запрос.
    Сервер нестабилен и ограничивает частые запросы, поэтому загрузка инкрементальная: докачиваем,
    пока не дойдём до уже известных дат, а при сбое на дальних страницах сохраняем то, что успели.
    """
    base = "https://api.hkma.gov.hk/public/market-data-and-statistics/daily-monetary-statistics/daily-figures-interbank-liquidity"
    fields = {"hibor_overnight": "HK_HIBOR_ON", "hibor_fixing_1m": "HK_HIBOR_1M", "disc_win_base_rate": "HK_BASE"}
    known = last_date(prev, "HK_HIBOR_1M", "0000")
    points = {sid: {} for sid in fields.values()}
    offset = 0
    while offset < 20000:
        try:
            res = json.loads(http_get(f"{base}?pagesize=1000&offset={offset}", timeout=30))["result"]
        except (urllib.error.URLError, OSError, ValueError, KeyError):
            if offset == 0:
                raise             # первая страница не пришла — источник недоступен
            break                 # дальние страницы — докачаем в следующий раз
        recs = res.get("records", [])
        for r in recs:
            for f, sid in fields.items():
                if r.get(f) not in (None, ""):
                    points[sid][r["end_of_date"]] = float(r[f])
        if len(recs) < 1000 or (recs and recs[-1]["end_of_date"] <= known):
            break
        offset += 1000
        time.sleep(1)             # вежливо к серверу
    names = {"HK_HIBOR_ON": "HIBOR овернайт, %", "HK_HIBOR_1M": "HIBOR 1 месяц, %", "HK_BASE": "Базовая ставка HKMA, %"}
    return [make_series(sid, names[sid], "HKMA", merge_prev(prev, sid, pts)) for sid, pts in points.items()]


# --- Реальная доходность акций и сырьевые рынки ------------------------------------------

def fetch_multpl(_api_key):
    """
    Прибыльная доходность S&P 500 (прибыль за 12 месяцев / цена, %) — помесячно с 1871 г.
    Таблица multpl.com (данные Р. Шиллера и S&P); последний месяц — оценка.
    """
    html = http_get("https://www.multpl.com/s-p-500-earnings-yield/table/by-month", headers={"User-Agent": "Mozilla/5.0"})
    pts = []
    for date_s, val_s in re.findall(r"<tr[^>]*>\s*<td[^>]*>([^<]+)</td>\s*<td[^>]*>(.*?)</td>", html, re.S):
        try:
            d = dt.datetime.strptime(date_s.strip(), "%b %d, %Y").date()
            v = float(re.search(r"(-?[\d.]+)%", val_s).group(1))
        except (ValueError, AttributeError):
            continue
        pts.append((d.replace(day=1).isoformat(), v))
    return [make_series("SPX_EY", "Прибыльная доходность S&P 500, %", "multpl.com", pts)]


# Контракты CFTC (отчёт Disaggregated): рынок → код. Позиции по группам участников.
CFTC_COMMODITIES = {
    "WTI": "067651", "NG": "023651", "WHEAT": "001602", "CORN": "002602",
    "SOY": "005602", "COPPER": "085692", "GOLD": "088691",
}
CFTC_DIS_GROUPS = {
    "PROD": ("prod_merc_positions_long", "prod_merc_positions_short"),
    "SWAP": ("swap_positions_long_all", "swap__positions_short_all"),
    "MM": ("m_money_positions_long_all", "m_money_positions_short_all"),
    "OTHER": ("other_rept_positions_long", "other_rept_positions_short"),
    "SMALL": ("nonrept_positions_long_all", "nonrept_positions_short_all"),
}


def fetch_cftc_disagg(_api_key):
    """
    CFTC Commitments of Traders, Disaggregated (фьючерсы, с 2006 г., еженедельно): лонги и шорты
    производителей и торговцев, своп-дилеров, управляющих фондами, прочих крупных и мелких трейдеров.
    """
    fields = ["report_date_as_yyyy_mm_dd", "open_interest_all"] + [f for pair in CFTC_DIS_GROUPS.values() for f in pair]
    out = []
    for name, code in CFTC_COMMODITIES.items():
        params = urllib.parse.urlencode({
            "$where": f"cftc_contract_market_code='{code}'",
            "$select": ",".join(fields), "$order": "report_date_as_yyyy_mm_dd", "$limit": "50000",
        })
        rows = json.loads(http_get(f"https://publicreporting.cftc.gov/resource/72hh-3qpy.json?{params}"))
        series_pts = {}
        for r in rows:
            d = r["report_date_as_yyyy_mm_dd"][:10]
            for group, (lf, sf) in CFTC_DIS_GROUPS.items():
                for side, f in (("L", lf), ("S", sf)):
                    if r.get(f) not in (None, ""):
                        series_pts.setdefault(f"CFD_{name}_{group}_{side}", {})[d] = float(r[f])
            if r.get("open_interest_all"):
                series_pts.setdefault(f"CFD_{name}_OI", {})[d] = float(r["open_interest_all"])
        for sid, pts in series_pts.items():
            out.append(make_series(sid, sid, "CFTC Disaggregated", pts.items(), note="Еженедельно, данные на вторник"))
    return out


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
    "minfin_budget": (fetch_minfin_budget, 24 * HOUR, False),
    "minfin_nwf": (fetch_minfin_nwf, 24 * HOUR, False),
    "sipri": (fetch_sipri, 30 * 24 * HOUR, False),
    "boe": (fetch_boe, 12 * HOUR, False),
    "mof_jgb": (fetch_jgb, 12 * HOUR, False),
    "sse": (fetch_sse, 6 * HOUR, False),
    "ecb_mir": (fetch_ecb_mir, 24 * HOUR, False),
    "hkma": (fetch_hkma, 12 * HOUR, True),
    "multpl": (fetch_multpl, 24 * HOUR, False),
    "cftc_disagg": (fetch_cftc_disagg, 12 * HOUR, False),
})


# Недавние сбои источников: {ключ: (время, текст ошибки)}. Упавший источник не опрашиваем
# 30 минут, чтобы каждая загрузка страницы не ждала его таймаута.
_failures = {}
FAILURE_PAUSE = 30 * 60


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
    failed_at, failed_msg = _failures.get(key, (0, ""))
    if not force and time.time() - failed_at < FAILURE_PAUSE:
        if cached:
            return dict(cached, cache="stale", error=failed_msg)
        return {"key": key, "fetched_at": None, "series": [], "cache": "error", "error": failed_msg}
    try:
        if incremental:
            prev = {s["id"]: s for s in (cached or {}).get("series", [])}
            series = fetch(api_key, prev)
        else:
            series = fetch(api_key)
        payload = {"key": key, "fetched_at": time.time(), "series": series}
        write_json(path, payload)
        _failures.pop(key, None)
        return dict(payload, cache="miss")
    except (urllib.error.URLError, OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile,
            ElementTree.ParseError) as exc:
        _failures[key] = (time.time(), str(exc))
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
