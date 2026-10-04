'use strict';
/*
 * SEMKIN macro — дашборд ранних индикаторов рецессии.
 *
 * Поток данных:
 *   GET /api/data  →  сырые ряды (FRED, ФРС, FINRA, CFTC, CBOE, Мосбиржа, Банк России; сервер их кэширует)
 *   →  computeIndicators(): производные индикаторы (спреды кривой, флаг инверсии,
 *      скорость кредитных спредов, плечо, позиции в деньгах, зоны)
 *   →  вкладки «США» и «Россия»: сводные карточки + графики Plotly с общей осью времени.
 *
 * Все пояснения «человеческим языком» собраны в EXPLAIN — их используют и карточки
 * (всплывающая подсказка), и подписи под графиками.
 *
 * Графики рисуются в SVG (type: 'scatter'), а не в WebGL: у браузера ограничено число
 * WebGL-контекстов на страницу (~16), и при их нехватке графики становились пустыми.
 */

// ---------------------------------------------------------------------------
// Пояснения к индикаторам
// ---------------------------------------------------------------------------

const EXPLAIN = {
  // США: кривая
  DGS3MO: 'Доходность трёхмесячных гособлигаций США почти повторяет ставку ФРС. Растёт, когда ФРС поднимает ставку, падает, когда снижает; резкое падение часто значит, что ФРС уже спасает экономику.',
  DGS2: 'Показывает, где рынок ждёт ставку ФРС через пару лет. Если она падает быстрее остальных, инвесторы рассчитывают на снижение ставок — обычно из-за ожидаемого замедления.',
  DGS5: 'Середина кривой: смесь ожиданий по ставкам и по росту экономики на среднем горизонте.',
  DGS10: 'Главный ориентир для ипотеки и корпоративных кредитов. Отражает ожидания по росту и инфляции на 10 лет; падает, когда инвесторы прячутся от риска в надёжные бумаги.',
  DGS30: 'Самые длинные госбумаги. В них зашиты долгосрочные ожидания по инфляции и плата за риск держать долг 30 лет.',
  curve2y: 'Разница между 10-летней и 2-летней доходностью. Обычно она положительна — за долгий срок платят больше. Уход ниже нуля (инверсия) значит, что рынок ждёт снижения ставок из-за будущего спада.',
  curve3m: 'Разница между 10-летней доходностью и почти текущей ставкой ФРС. На этом спреде построена модель вероятности рецессии ФРБ Нью-Йорка; его инверсия предшествовала всем рецессиям с конца 1960-х.',
  inversionFill: 'Залитые участки ниже нуля — периоды инверсии. Рецессия чаще начиналась не во время инверсии, а когда кривая уже из неё вышла.',
  flag: 'Загорается, если хотя бы один из спредов кривой ниже нуля. Важно и что после: исторически рецессия чаще начиналась в первые месяцы после выхода кривой из инверсии.',
  yields: 'Текущие доходности гособлигаций США по срокам. В норме чем длиннее срок, тем выше доходность.',
  // США: кредит
  hy: 'Насколько больше гособлигаций платят компании с рейтингом ниже инвестиционного («мусорные» облигации). Растёт, когда инвесторы боятся банкротств; очень низкий спред — признак спокойствия или беспечности.',
  hyRoc: 'Насколько спред мусорных облигаций изменился за выбранное окно. Быстрый рост часто важнее уровня: это бегство из риска, даже если спред ещё в «спокойной» зоне.',
  baa: 'Сколько платят сверх гособлигаций надёжные, но не лучшие компании (рейтинг Baa). Двигается вместе со спредом мусорных облигаций, но есть с 1986 года — по нему видно поведение кредита во всех прошлых кризисах.',
  baaRoc: 'Скорость изменения спреда Baa − 10Y за выбранное окно. Резкие скачки совпадают с моментами, когда кредитный рынок «замерзает».',
  gz: 'Средний спред облигаций американских компаний к гособлигациям, который ФРС считает по тысячам выпусков с 1973 года. Ведёт себя как спред мусорных облигаций, но с полной историей: растёт перед рецессиями и во время них.',
  ebp: 'Премия за избыточный кредитный риск — часть спреда, которую нельзя объяснить вероятностью дефолтов. Это «страх» кредиторов; по исследованиям ФРС её рост — один из самых надёжных ранних признаков рецессии.',
  gzProb: 'Вероятность рецессии в ближайшие 12 месяцев по модели экономистов ФРС на основе EBP и наклона кривой доходности. Это оценка модели, а не официальный прогноз ФРС.',
  usrec: 'Официальные рецессии США по датировке NBER (Национального бюро экономических исследований). Их объявляют задним числом — часто через полгода–год после начала спада.',
  // США: плечо
  marginM2: 'Маржинальный долг в процентах от денежной массы M2. Показывает, насколько рынок «на плече» относительно всех денег в экономике; пики 2000 и 2007 годов совпали с вершинами рынка.',
  margin: 'Сколько инвесторы заняли у брокеров под залог бумаг, чтобы купить больше акций. Растёт на оптимизме и усиливает падения: при снижении брокеры требуют довнести деньги, и позиции продают принудительно.',
  m2: 'Денежная масса M2 — наличные, вклады и близкие к ним деньги в экономике. Здесь служит «знаменателем»: позволяет сравнивать долг разных эпох.',
  capMargin: 'Капитализация рынка, делённая на маржинальный долг. Чем ниже значение, тем большая доля рынка куплена в долг и тем выше риск каскада принудительных продаж.',
  cap: 'Рыночная стоимость акций всех американских компаний по данным ФРС (отчёт Z.1) — замена индексу Wilshire 5000, который больше не публикуется на FRED. Выходит раз в квартал с задержкой ~2,5 месяца.',
  // США: индексы
  sp500: 'Индекс 500 крупнейших компаний США — главный барометр американского рынка акций. Обычно начинает падать за несколько месяцев до официальной рецессии.',
  nasdaq: 'Индекс биржи NASDAQ, где много технологических компаний. Сильнее реагирует на ставки и аппетит к риску, поэтому на медвежьих рынках падает глубже.',
  drawdown: 'Насколько индекс ниже своего исторического максимума. До −10% — обычные колебания, −10…−20% — коррекция, ниже −20% — медвежий рынок.',
  // США: позиционирование
  cotComm: 'Коммерческие участники — крупные институты и дилеры, которые в основном хеджируют свои портфели. Часто действуют против толпы: наращивают покупки на распродажах.',
  cotNoncomm: 'Крупные спекулянты — хедж-фонды и другие фонды, торгующие на направление рынка. Их чистая позиция показывает настрой профессиональных игроков, которые обычно следуют за трендом.',
  cotSmall: 'Мелкие трейдеры — позиции ниже порога обязательной отчётности, ближайший бесплатный прокси частных инвесторов. Крайний оптимизм этой группы часто читают как поздний сигнал.',
  tffMoney: 'Позиции переведены в доллары: контракты × множитель (S&P 500 — $50, NASDAQ-100 — $20) × значение индекса на дату отчёта. Сплошная линия — лонги, пунктир — шорты.',
  tffAsset: 'Управляющие активами — пенсионные фонды, страховые компании, паевые фонды. Обычно держат большие лонги как часть долгосрочных портфелей; сокращение лонгов — признак осторожности институционалов.',
  tffLev: 'Хедж-фонды и другие фонды с плечом. Часто держат нетто-шорт (хеджи и арбитраж против акций), но резкий рост шортов показывает ставки на падение.',
  tffDealer: 'Банки-дилеры: продают клиентам деривативы и хеджируют этот риск фьючерсами, поэтому их позиция во многом зеркальна клиентской. По умолчанию скрыты — включите в легенде.',
  tffOther: 'Прочие крупные участники: корпорации, казначейства, семейные офисы. По умолчанию скрыты — включите в легенде.',
  tffSmall: 'Мелкие трейдеры ниже порога отчётности — прокси частных инвесторов.',
  pcEquity: 'Отношение опционов «пут» (ставки на падение) к «колл» (ставки на рост) по отдельным акциям — здесь в основном торгуют частные инвесторы. Высокое значение — страх, низкое — самоуверенность; крайние значения обычно читают наоборот.',
  pcTotal: 'То же по всем опционам CBOE, включая индексные, которые чаще покупают институционалы для страховки портфеля.',
  pcRaw: 'Дневные значения без сглаживания: очень шумные, поэтому основная линия — среднее за 21 торговый день (≈ месяц).',
  siSPY: 'Сколько паёв SPY (фонд на S&P 500) продано в шорт. Рост — больше ставок на падение рынка или страховки портфелей. В подсказке — за сколько дней торгов можно откупить все шорты.',
  siQQQ: 'Шорт в QQQ — фонде на NASDAQ-100. Показывает, сколько игроков ставят на падение или хеджируют крупные технологические компании.',
  siIWM: 'Шорт в IWM — фонде на индекс малых компаний Russell 2000. Малые компании чувствительнее к кредиту и замедлению, поэтому здесь шорт обычно выше.',
  overlay: 'Индекс акций на правой шкале (логарифмической) — для сравнения, как рынок вёл себя одновременно с индикатором.',

  // Россия
  keyRate: 'Ключевая ставка Банка России — цена денег в экономике. Высокая ставка охлаждает кредит и инфляцию, но тормозит рост; долгий период жёсткой ставки обычно заканчивается замедлением экономики.',
  OFZ_1Y: 'Доходность годовых ОФЗ по кривой бескупонной доходности Мосбиржи — близка к ожиданиям по ключевой ставке на ближайший год.',
  OFZ_2Y: 'Доходность двухлетних ОФЗ — где рынок ждёт ключевую ставку в среднем на два года вперёд.',
  OFZ_5Y: 'Середина кривой ОФЗ: ожидания по ставкам и инфляции на средний срок.',
  OFZ_10Y: 'Длинная ставка: долгосрочные ожидания по инфляции и плата за риск держать рублёвый долг 10 лет.',
  OFZ_20Y: 'Самые длинные ОФЗ — максимальная плата за долгосрочный риск.',
  ruCurve: 'Разница доходностей 10-летних и 2-летних ОФЗ. Ниже нуля — инверсия: рынок ждёт снижения ставок, обычно потому что ЦБ держит ставку высокой, чтобы охладить экономику.',
  ruCurveKey: 'Разница между 10-летними ОФЗ и ключевой ставкой. Глубоко отрицательная — ЦБ держит очень жёсткую политику, которая со временем замедляет экономику.',
  ruFlag: 'Загорается, если хотя бы один из двух спредов ОФЗ ниже нуля. В России инверсия обычно означает очень жёсткую политику ЦБ, которая со временем охлаждает экономику.',
  rgbiYield: 'Средняя доходность к погашению облигаций из индекса RGBI — ОФЗ со сроком больше года.',
  corpYield: 'Средняя доходность корпоративных облигаций из индекса Мосбиржи (до июня 2023 — RUCBITR, далее — его преемник RUCBTRNS).',
  ruSpread: 'Насколько компании платят больше государства. Растёт, когда инвесторы боятся дефолтов. Сравнение приблизительное: у корпоративного индекса срок до погашения короче, чем у RGBI.',
  imoex: 'Индекс Мосбиржи — крупнейшие российские компании, в рублях.',
  rts: 'Индекс РТС — те же компании, но в долларах. Падает сильнее IMOEX, когда слабеет рубль.',
  rgbi: 'Ценовой индекс гособлигаций. Растёт, когда доходности падают (рынок ждёт снижения ставки), и падает при росте ставок.',
  futFiz: 'Физлица — частные инвесторы. Мосбиржа публикует их позиции отдельно от юрлиц, так что это прямой показатель настроения розницы.',
  futYur: 'Юрлица — банки, фонды, брокеры, компании. Их нетто-позиция всегда зеркальна нетто-позиции физлиц: на каждый лонг есть шорт.',
  futMoney: 'Позиции переведены в рубли: контракты × стоимость контракта по текущей спецификации Мосбиржи × значение индекса на дату. Сплошная линия — лонги, пунктир — шорты. Данные Мосбиржи на последний торговый день.',
  accounts: 'Сколько счетов физлиц держат лонг и сколько — шорт. Показывает, насколько массово розница ставит на рост или падение, независимо от объёма денег.',
  budRev: 'Все доходы федерального бюджета за последние 12 месяцев. Сумма за 12 месяцев убирает сезонность: налоги и расходы распределены по году очень неравномерно.',
  budOil: 'Нефтегазовые доходы — налоги и пошлины на добычу и экспорт нефти и газа. Зависят от цен на нефть, курса рубля и объёмов экспорта; их падение — главный риск для бюджета.',
  budNonoil: 'Все остальные доходы: НДС, налог на прибыль, акцизы, ввозные пошлины. Растут вместе с экономикой и инфляцией.',
  budExp: 'Все расходы федерального бюджета за последние 12 месяцев.',
  budBal: 'Разница доходов и расходов за 12 месяцев. Ниже нуля — дефицит: государству приходится занимать (выпускать ОФЗ) или тратить ФНБ. Устойчиво большой дефицит давит на ставки и рубль.',
  budNonoilBal: 'Дефицит без нефтегазовых доходов — показывает, насколько бюджет зависит от нефти и газа. Чем он глубже, тем уязвимее бюджет к падению цен на нефть.',
  budYtd: 'Дефицит с начала текущего года нарастающим итогом — так его публикует Минфин. Внутри года он сильно колеблется: в декабре традиционно проходит много расходов.',
  budGdp: 'Доля в ВВП — оценка: ВВП взят из отчёта Минфина о ФНБ, где объём фонда приводится и в рублях, и в процентах к ВВП.',
  nwf: 'Фонд национального благосостояния — «подушка» бюджета, куда раньше откладывали сверхдоходы от нефти. Из него покрывают дефицит, когда нефтегазовых доходов не хватает.',
  nwfLiquid: 'Ликвидная часть — деньги на счетах в Банке России (юани, золото, рубли), которые можно быстро потратить. Остальное вложено в акции, облигации и проекты и быстро не продаётся. Расчёт: объём фонда минус «иные активы».',
  nwfCover: 'Во сколько раз ликвидная часть ФНБ больше годового дефицита — грубая оценка запаса прочности. На практике дефицит покрывают в основном займами (ОФЗ), а не только ФНБ.',
  defenseMinfin: 'Расходы федерального бюджета по разделу «Национальная оборона» по данным Минфина. С 2022 года Минфин перестал публиковать разбивку расходов по разделам.',
  defenseSipri: 'Оценка военных расходов России от SIPRI (Стокгольмский институт исследования проблем мира). Шире раздела «Национальная оборона»: включает, например, военные пенсии и часть расходов силовых ведомств.',
  sipriShare: 'Военные расходы в процентах от ВВП и от всех государственных расходов по оценке SIPRI — какая доля экономики и бюджета уходит на оборону.',
  ruCrises: 'Периоды спада ВВП России (приблизительно, по годовой динамике ВВП): 1998, 2008–09, 2015–16, 2020, 2022–23. Официальной датировки рецессий, как NBER в США, в России нет.',
};

// ---------------------------------------------------------------------------
// Источники данных (показываются под графиками и в подсказках карточек)
// ---------------------------------------------------------------------------

/** Ссылка на ряд FRED. */
const fred = (id, label = `FRED: ${id}`) => [label, `https://fred.stlouisfed.org/series/${id}`];
const MOEX_INDEX = (id) => [`Мосбиржа: ${id}`, `https://www.moex.com/ru/index/${id}`];

// Источник — список пар [подпись, ссылка]; показывается кликабельными ссылками.
const SRC = {
  yields: [fred('DGS3MO'), fred('DGS2'), fred('DGS5'), fred('DGS10'), fred('DGS30')],
  curve: [['расчёт по данным FRED'], fred('DGS10'), fred('DGS2'), fred('DGS3MO')],
  hy: [fred('BAMLH0A0HYM2', 'FRED: BAMLH0A0HYM2 (ICE BofA US High Yield OAS)')],
  hyRoc: [['расчёт по данным FRED'], fred('BAMLH0A0HYM2'), fred('BAA10Y')],
  baa: [fred('BAA10Y', "FRED: BAA10Y (Moody's Baa − 10Y Treasury)")],
  gz: [['ФРС США: Gilchrist & Zakrajšek, FEDS Notes', 'https://www.federalreserve.gov/econres/notes/feds-notes/updating-the-recession-risk-and-the-excess-bond-premium-20161006.html'],
    ['данные (CSV)', 'https://www.federalreserve.gov/econres/notes/feds-notes/ebp_csv.csv']],
  finra: [['FINRA: Margin Statistics', 'https://www.finra.org/rules-guidance/key-topics/margin-accounts/margin-statistics']],
  margin: [['FINRA: Margin Statistics', 'https://www.finra.org/rules-guidance/key-topics/margin-accounts/margin-statistics'], fred('M2SL')],
  cap: [fred('BOGZ1LM883164105Q', 'ФРС, отчёт Z.1 (FRED: BOGZ1LM883164105Q)'),
    ['FINRA: Margin Statistics', 'https://www.finra.org/rules-guidance/key-topics/margin-accounts/margin-statistics']],
  indices: [fred('SP500'), fred('NASDAQCOM'), ['S&P 500 до 2016 г. — данные Р. Шиллера', 'https://datahub.io/core/s-and-p-500']],
  tff: [['CFTC: Traders in Financial Futures', 'https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm'], fred('SP500'), fred('NASDAQ100')],
  cot: [['CFTC: Commitments of Traders', 'https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm']],
  putcall: [['CBOE: статистика put/call', 'https://www.cboe.com/us/options/market_statistics/']],
  short: [['FINRA: Equity Short Interest', 'https://www.finra.org/finra-data/browse-catalog/equity-short-interest']],
  nber: [fred('USREC', 'рецессии NBER (FRED: USREC)')],
  keyRate: [['Банк России: ключевая ставка', 'https://www.cbr.ru/hd_base/KeyRate/']],
  ofz: [['Мосбиржа: кривая бескупонной доходности ОФЗ', 'https://www.moex.com/ru/marketdata/indices/state/g-curve/']],
  ruCurve: [['расчёт по данным Мосбиржи (кривая ОФЗ)', 'https://www.moex.com/ru/marketdata/indices/state/g-curve/'],
    ['Банка России (ключевая ставка)', 'https://www.cbr.ru/hd_base/KeyRate/']],
  ruBonds: [MOEX_INDEX('RGBI'), MOEX_INDEX('RUCBTRNS'), ['RUCBITR (до 2023)', 'https://www.moex.com/ru/index/RUCBITR']],
  ruIndices: [MOEX_INDEX('IMOEX'), MOEX_INDEX('RTSI'), MOEX_INDEX('RGBI')],
  futoi: [['Мосбиржа: открытые позиции', 'https://www.moex.com/ru/derivatives/open-positions.aspx'],
    ['курс доллара — Банк России', 'https://www.cbr.ru/currency_base/dynamics/']],
  budget: [['Минфин России: исполнение федерального бюджета', 'https://minfin.gov.ru/ru/statistics/fedbud/execute/']],
  nwf: [['Минфин России: ФНБ', 'https://minfin.gov.ru/ru/perfomance/nationalwealthfund/statistics/']],
  defense: [['Минфин России (раздел «Национальная оборона», до 2021 г.)', 'https://minfin.gov.ru/ru/statistics/fedbud/execute/'],
    ['SIPRI Military Expenditure Database', 'https://www.sipri.org/databases/milex']],
  sipri: [['SIPRI Military Expenditure Database', 'https://www.sipri.org/databases/milex']],
  ruCrises: [['периоды спада ВВП России — приблизительно, по данным Росстата', 'https://rosstat.gov.ru/statistics/accounts']],
};

/** Источник → HTML с кликабельными ссылками (открываются в новой вкладке). */
function srcHtml(list) {
  return (list || []).map(([text, url]) => (url
    ? `<a href="${url}" target="_blank" rel="noopener">${escapeHtml(text)}</a>`
    : escapeHtml(text))).join(', ');
}

// Источник наложенного индекса.
const OVERLAY_SRC = { sp500: SRC.indices, nasdaq: SRC.indices, imoex: SRC.ruIndices, rts: SRC.ruIndices };

// Полосы рецессий и кризисов по вкладкам: подпись в легенде, пояснение и источник.
const TAB_BANDS = {
  us: { legend: 'Рецессии NBER', explain: 'usrec', source: SRC.nber },
  ru: { legend: 'Спады ВВП', explain: 'ruCrises', source: SRC.ruCrises },
};

// ---------------------------------------------------------------------------
// Настройки и пороги
// ---------------------------------------------------------------------------

const DEFAULT_FROM = '1985-01-01';

const YIELDS = [
  { id: 'DGS3MO', name: '3 мес', color: '--s-3m' },
  { id: 'DGS2', name: '2 года', color: '--s-2y' },
  { id: 'DGS5', name: '5 лет', color: '--s-5y' },
  { id: 'DGS10', name: '10 лет', color: '--s-10y' },
  { id: 'DGS30', name: '30 лет', color: '--s-30y' },
];

const OFZ = [
  { id: 'OFZ_1Y', name: 'ОФЗ 1 год', color: '--s-3m' },
  { id: 'OFZ_2Y', name: 'ОФЗ 2 года', color: '--s-2y' },
  { id: 'OFZ_5Y', name: 'ОФЗ 5 лет', color: '--s-5y' },
  { id: 'OFZ_10Y', name: 'ОФЗ 10 лет', color: '--s-10y' },
  { id: 'OFZ_20Y', name: 'ОФЗ 20 лет', color: '--s-30y' },
];

// Периоды спада ВВП России (приблизительно): официальной датировки рецессий нет.
const RU_CRISES = [
  ['1998-07-01', '1999-04-01'],
  ['2008-10-01', '2009-12-01'],
  ['2015-01-01', '2016-04-01'],
  ['2020-04-01', '2021-01-01'],
  ['2022-04-01', '2023-04-01'],
];

// Пороговые зоны HY OAS (б.п.) — из ТЗ.
const HY_ZONES = [
  { max: 500, label: 'Спокойно', color: '--calm' },
  { max: 700, label: 'Настороженность', color: '--caution' },
  { max: 1000, label: 'Стресс', color: '--stress' },
  { max: Infinity, label: 'Паника', color: '--panic' },
];

// Зоны для Baa−10Y (б.п.). Приблизительные: ряд в ~2,5 раза «уже» HY OAS,
// пороги подобраны по историческим пикам (2001–02 ≈ 390, 2020 ≈ 430, 2008 ≈ 616).
const BAA_ZONES = [
  { max: 250, label: 'Спокойно', color: '--calm' },
  { max: 350, label: 'Настороженность', color: '--caution' },
  { max: 450, label: 'Стресс', color: '--stress' },
  { max: Infinity, label: 'Паника', color: '--panic' },
];

// Эвристика для скорости расширения HY-спреда (б.п. за окно ~60 торговых дней).
// Ориентиры: конец 2018 ≈ +200, 2022 ≈ +250, март 2020 ≈ +600.
const HY_ROC_ZONES = [
  { max: 50, label: 'Стабильно', color: '--calm' },
  { max: 150, label: 'Расширение', color: '--caution' },
  { max: 300, label: 'Резкое расширение', color: '--stress' },
  { max: Infinity, label: 'Шок', color: '--panic' },
];

// Вероятность рецессии по модели ФРС, %. Пороги условные.
const PROB_ZONES = [
  { max: 20, label: 'Низкая', color: '--calm' },
  { max: 40, label: 'Повышенная', color: '--caution' },
  { max: 60, label: 'Высокая', color: '--stress' },
  { max: Infinity, label: 'Очень высокая', color: '--panic' },
];

const CURVE_ZONES = [
  { max: 0, label: 'Инверсия', color: '--panic' },
  { max: 50, label: 'Плоская кривая', color: '--caution' },
  { max: Infinity, label: 'Нормальный наклон', color: '--calm' },
];

// Плечо оцениваем по перцентилю собственной истории ряда (с 1997 г.):
// абсолютных общепринятых порогов для этих отношений нет.
const LEVERAGE_ZONES = [
  { max: 50, label: 'Плечо ниже среднего', color: '--calm' },
  { max: 80, label: 'Плечо выше среднего', color: '--caution' },
  { max: 95, label: 'Высокое плечо', color: '--stress' },
  { max: Infinity, label: 'Экстремальное плечо', color: '--panic' },
];

// Кредитный спред по перцентилю собственной истории (для рядов без общепринятых порогов).
const SPREAD_PCT_ZONES = [
  { max: 50, label: 'Ниже среднего', color: '--calm' },
  { max: 80, label: 'Выше среднего', color: '--caution' },
  { max: 95, label: 'Высокий', color: '--stress' },
  { max: Infinity, label: 'Экстремальный', color: '--panic' },
];

// Просадка индекса от исторического максимума, %.
const DRAWDOWN_ZONES = [
  { max: -35, label: 'Глубокий медвежий рынок', color: '--panic' },
  { max: -20, label: 'Медвежий рынок', color: '--stress' },
  { max: -10, label: 'Коррекция', color: '--caution' },
  { max: Infinity, label: 'Около максимумов', color: '--calm' },
];

// Дефицит федерального бюджета за 12 месяцев, % ВВП. Пороги условные.
const DEFICIT_ZONES = [
  { max: -3, label: 'Дефицит больше 3% ВВП', color: '--panic' },
  { max: -1, label: 'Дефицит 1–3% ВВП', color: '--stress' },
  { max: 0, label: 'Дефицит до 1% ВВП', color: '--caution' },
  { max: Infinity, label: 'Профицит', color: '--calm' },
];

const UNINVERSION_WINDOW_DAYS = 730;  // сколько дней после выхода из инверсии считаем «дезинверсией»
const PC_SMOOTH = 21;                 // окно сглаживания put/call, торговых дней

// Группы участников отчёта CFTC TFF.
const TFF_GROUPS = [
  { key: 'ASSET', name: 'Управляющие активами', color: '--s-30y', explain: 'tffAsset' },
  { key: 'LEV', name: 'Хедж-фонды', color: '--s-2y', explain: 'tffLev' },
  { key: 'SMALL', name: 'Мелкие трейдеры', color: '--s-3m', explain: 'tffSmall' },
  { key: 'DEALER', name: 'Дилеры', color: '--s-5y', explain: 'tffDealer', hidden: true },
  { key: 'OTHER', name: 'Прочие крупные', color: '--muted', explain: 'tffOther', hidden: true },
];

// Фьючерсы Мосбиржи: рублей за один пункт индекса на контракт (по текущей спецификации).
//   MX: цена ≈ IMOEX × 100, шаг 25 пт = 25 ₽     → 100 ₽ за пункт IMOEX
//   MM, IMOEXF: цена ≈ IMOEX, шаг 0,05 = 0,5 ₽   → 10 ₽ за пункт IMOEX
//   RB: цена ≈ RGBI × 100, шаг 1 пт = 1 ₽        → 100 ₽ за пункт RGBI
//   RI: цена ≈ RTS × 100, 1 пт = 0,02 $          → 2 $ за пункт RTS (переводим по курсу ЦБ)
const FUT_IMOEX = { MX: 100, MM: 10, IMOEXF: 10 };

// ---------------------------------------------------------------------------
// Состояние
// ---------------------------------------------------------------------------

const state = {
  raw: null,          // ответ /api/data
  ind: null,          // вычисленные индикаторы
  range: null,        // [from, to] — текущий диапазон дат (ISO-строки)
  tab: 'us',          // активная вкладка
  overlay: { us: '', ru: '' },  // наложенный индекс для каждой вкладки
  syncing: false,     // защита от рекурсии при синхронизации зума между графиками
  fs: null,           // id графика, развёрнутого на весь экран
  hoverChart: null,   // id графика под мышью (для стрелок)
};

const OVERLAYS = {
  us: [['', 'нет'], ['sp500', 'S&P 500'], ['nasdaq', 'NASDAQ']],
  ru: [['', 'нет'], ['imoex', 'IMOEX'], ['rts', 'РТС']],
};

// ---------------------------------------------------------------------------
// Утилиты
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Цвет CSS-переменной с прозрачностью (для заливки зон). */
function withAlpha(varName, alpha) {
  const m = css(varName).match(/^#([0-9a-f]{6})$/i);
  if (!m) return css(varName);
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const DAY_MS = 86400000;
const toDate = (iso) => new Date(iso + 'T00:00:00Z');
const toIso = (d) => d.toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / DAY_MS);
const monthKey = (iso) => iso.slice(0, 7);

function addMonths(iso, n) {
  const d = toDate(iso);
  d.setUTCMonth(d.getUTCMonth() + n);
  return toIso(d);
}

function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}
const fmtMonth = (iso) => (iso ? `${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '—');

function fmtNum(v, digits = 0, signed = false) {
  if (v == null || Number.isNaN(v)) return '—';
  const s = v.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return signed && v > 0 ? '+' + s : s;
}

/** Находит зону, в которую попадает значение. */
const zoneOf = (zones, v) => zones.find((z) => v < z.max) || zones[zones.length - 1];

/** Индекс первого элемента массива ISO-дат, который >= iso (бинарный поиск). */
function lowerBound(dates, iso) {
  let lo = 0, hi = dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] < iso) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Перцентиль значения v в истории ряда: доля наблюдений, не превышающих v, %. */
function percentile(values, v) {
  if (!values.length || v == null) return null;
  return (values.filter((x) => x <= v).length / values.length) * 100;
}

const last = (s) => (s && s.dates.length
  ? { date: s.dates[s.dates.length - 1], value: s.values[s.values.length - 1] }
  : null);

// ---------------------------------------------------------------------------
// Операции над рядами
// ---------------------------------------------------------------------------

/** Сырой ряд → { dates, values }. Пустой, если источник не ответил. */
function series(id) {
  const s = state.raw.series[id];
  return s ? { dates: s.dates, values: s.values } : { dates: [], values: [] };
}

const mapValues = (s, fn) => ({ dates: s.dates, values: s.values.map(fn) });
const toBp = (s) => mapValues(s, (v) => v * 100);

/** Поэлементная операция над двумя рядами по общим датам (по ключу keyFn). */
function combine(a, b, fn, keyFn = (d) => d) {
  const bMap = new Map(b.dates.map((d, i) => [keyFn(d), b.values[i]]));
  const dates = [], values = [];
  a.dates.forEach((d, i) => {
    const bv = bMap.get(keyFn(d));
    if (bv !== undefined) {
      dates.push(d);
      values.push(fn(a.values[i], bv));
    }
  });
  return { dates, values };
}

/**
 * Операция «на дату»: для каждой даты ряда a берётся последнее известное значение b
 * (на эту дату или раньше). Нужна, когда у рядов разная частота или календарь.
 */
function asof(a, b, fn) {
  const dates = [], values = [];
  let j = -1;
  a.dates.forEach((d, i) => {
    while (j + 1 < b.dates.length && b.dates[j + 1] <= d) j++;
    if (j >= 0) {
      dates.push(d);
      values.push(fn(a.values[i], b.values[j]));
    }
  });
  return { dates, values };
}

/** Склейка: ряд a до начала ряда b, дальше — b. */
function stitch(a, b) {
  const cut = b.dates[0] || '9999';
  const i = lowerBound(a.dates, cut);
  return { dates: [...a.dates.slice(0, i), ...b.dates], values: [...a.values.slice(0, i), ...b.values] };
}

/** Спред кривой (a − b) в б.п. по общим датам. */
const spreadBp = (a, b) => combine(a, b, (x, y) => Math.round((x - y) * 1e4) / 100);

/**
 * Скорость изменения: v[i] − v[i − window], где окно считается в наблюдениях,
 * т.е. в торговых днях (выходные и праздники в дневных рядах отсутствуют).
 */
function rateOfChange(s, window) {
  const dates = [], values = [];
  for (let i = window; i < s.values.length; i++) {
    dates.push(s.dates[i]);
    values.push(Math.round((s.values[i] - s.values[i - window]) * 100) / 100);
  }
  return { dates, values };
}

/** Скользящее среднее за n наблюдений. */
function movingAverage(s, n) {
  const dates = [], values = [];
  let sum = 0;
  for (let i = 0; i < s.values.length; i++) {
    sum += s.values[i];
    if (i >= n) sum -= s.values[i - n];
    if (i >= n - 1) {
      dates.push(s.dates[i]);
      values.push(sum / n);
    }
  }
  return { dates, values };
}

/** Изменение помесячного ряда за 12 месяцев, %. */
function yearOverYear(s) {
  const byMonth = new Map(s.dates.map((d, i) => [monthKey(d), s.values[i]]));
  const dates = [], values = [];
  s.dates.forEach((d, i) => {
    const prev = byMonth.get(monthKey(addMonths(d, -12)));
    if (prev) {
      dates.push(d);
      values.push((s.values[i] / prev - 1) * 100);
    }
  });
  return { dates, values };
}

/** Просадка от исторического максимума, %. */
function drawdown(s) {
  let peak = -Infinity;
  return mapValues(s, (v) => {
    peak = Math.max(peak, v);
    return (v / peak - 1) * 100;
  });
}

/**
 * Периоды рецессий из помесячного USREC: непрерывные отрезки со значением 1.
 * Конец периода — первое число месяца после последнего «рецессионного» месяца.
 */
function recessionPeriods(usrec) {
  const periods = [];
  let start = null;
  usrec.dates.forEach((d, i) => {
    if (usrec.values[i] === 1 && start === null) start = d;
    if (usrec.values[i] !== 1 && start !== null) {
      periods.push([start, d]);
      start = null;
    }
  });
  if (start !== null) periods.push([start, toIso(new Date())]); // рецессия идёт сейчас
  return periods;
}

/** Флаг инверсии: true, если хотя бы один из спредов < 0. */
function inversionFlag(s1, s2) {
  const m1 = new Map(s1.dates.map((d, i) => [d, s1.values[i]]));
  const m2 = new Map(s2.dates.map((d, i) => [d, s2.values[i]]));
  const dates = [...new Set([...s1.dates, ...s2.dates])].sort();
  return {
    dates,
    values: dates.map((d) => (m1.get(d) ?? Infinity) < 0 || (m2.get(d) ?? Infinity) < 0),
  };
}

/**
 * Текущее состояние флага инверсии:
 *  - inverted   — инверсия сейчас (с какой даты);
 *  - uninverted — недавно вышли из инверсии (исторически рецессии часто начинались в этой фазе);
 *  - none       — инверсии нет (когда была последняя).
 */
function inversionStatus(flag) {
  const n = flag.dates.length;
  if (!n) return null;
  const lastDate = flag.dates[n - 1];
  if (flag.values[n - 1]) {
    let i = n - 1;
    while (i > 0 && flag.values[i - 1]) i--;
    return { kind: 'inverted', since: flag.dates[i], days: daysBetween(flag.dates[i], lastDate) };
  }
  let j = n - 1;
  while (j >= 0 && !flag.values[j]) j--;
  if (j < 0) return { kind: 'none', lastInverted: null };
  const endedOn = flag.dates[j + 1];
  const ago = daysBetween(endedOn, lastDate);
  return ago <= UNINVERSION_WINDOW_DAYS
    ? { kind: 'uninverted', endedOn, ago }
    : { kind: 'none', lastInverted: flag.dates[j] };
}

/** Нарастающий итог с начала года (как публикует Минфин) → значения за каждый месяц. */
function ytdToMonthly(s) {
  const byMonth = new Map(s.dates.map((d, i) => [monthKey(d), s.values[i]]));
  const dates = [], values = [];
  s.dates.forEach((d, i) => {
    const prev = d.slice(5, 7) === '01' ? 0 : byMonth.get(monthKey(addMonths(d, -1)));
    if (prev !== undefined) {
      dates.push(d);
      values.push(s.values[i] - prev);
    }
  });
  return { dates, values };
}

/** Сумма за последние 12 месяцев (только если есть все 12 месяцев). */
function rolling12(m) {
  const byMonth = new Map(m.dates.map((d, i) => [monthKey(d), m.values[i]]));
  const dates = [], values = [];
  for (const d of m.dates) {
    let sum = 0, ok = true;
    for (let k = 0; k < 12 && ok; k++) {
      const v = byMonth.get(monthKey(addMonths(d, -k)));
      if (v === undefined) ok = false; else sum += v;
    }
    if (ok) {
      dates.push(d);
      values.push(sum);
    }
  }
  return { dates, values };
}

/** Показатель бюджета за 12 месяцев, трлн ₽, из нарастающего итога Минфина (млрд ₽). */
const budget12 = (id) => mapValues(rolling12(ytdToMonthly(series(id))), (v) => v / 1000);

/** Годовые итоги из нарастающего итога: декабрьское значение → середина года (для столбцов). */
function yearTotals(s) {
  const dates = [], values = [];
  s.dates.forEach((d, i) => {
    if (d.slice(5, 7) === '12') {
      dates.push(`${d.slice(0, 4)}-07-01`);
      values.push(s.values[i]);
    }
  });
  return { dates, values };
}

/** Чистая позиция группы COT в % от открытого интереса. */
function cotNet(prefix) {
  const net = combine(series(`COT_${prefix}_LONG`), series(`COT_${prefix}_SHORT`), (l, s) => l - s);
  return combine(net, series('COT_OI'), (n, oi) => (n / oi) * 100);
}

/**
 * Позиции TFF в млрд $: контракты × множитель × индекс на дату отчёта.
 * Возвращает { ASSET: { L, S, net }, LEV: {...}, ... }.
 */
function tffMoney(name, index, multiplier) {
  const out = {};
  for (const g of TFF_GROUPS) {
    const toUsd = (side) => asof(series(`TFF_${name}_${g.key}_${side}`), index, (c, px) => (c * multiplier * px) / 1e9);
    const L = toUsd('L'), S = toUsd('S');
    // netContracts — для перцентилей: долларовые суммы растут вместе с индексом и искажают сравнение с прошлым.
    const netContracts = combine(series(`TFF_${name}_${g.key}_L`), series(`TFF_${name}_${g.key}_S`), (l, s) => l - s);
    out[g.key] = { L, S, net: combine(L, S, (l, s) => l - s), netContracts };
  }
  return out;
}

/**
 * Позиции физлиц и юрлиц по группе фьючерсов Мосбиржи в млрд ₽.
 * tickers: { тикер: ₽ (или $) за пункт индекса на контракт }; index — ряд цены базового индекса
 * (для РТС — уже в рублях, т.е. РТС × курс доллара). Тикер, который ещё не торговался, даёт 0.
 */
function futoiMoney(tickers, index) {
  const out = {};
  for (const g of ['FIZ', 'YUR']) {
    out[g] = {};
    for (const side of ['L', 'S']) {
      const total = new Map();
      for (const [t, mult] of Object.entries(tickers)) {
        const rub = asof(series(`FUTOI_${t}_${g}_${side}`), index, (c, px) => (c * mult * px) / 1e9);
        rub.dates.forEach((d, i) => total.set(d, (total.get(d) || 0) + rub.values[i]));
      }
      const dates = [...total.keys()].sort();
      out[g][side] = { dates, values: dates.map((d) => total.get(d)) };
    }
    out[g].net = combine(out[g].L, out[g].S, (l, s) => l - s);
  }
  return out;
}

/** Сумма числа счетов физлиц по нескольким тикерам (один человек может быть посчитан дважды). */
function futoiAccounts(tickers, side) {
  const total = new Map();
  for (const t of tickers) {
    const s = series(`FUTOI_${t}_FIZ_${side}`);
    s.dates.forEach((d, i) => total.set(d, (total.get(d) || 0) + s.values[i]));
  }
  const dates = [...total.keys()].sort();
  return { dates, values: dates.map((d) => total.get(d)) };
}

function computeIndicators() {
  const window = Math.max(1, parseInt($('#window').value, 10) || 60);

  // --- США ---
  const y = Object.fromEntries(YIELDS.map((s) => [s.id, series(s.id)]));
  const curve2y = spreadBp(y.DGS10, y.DGS2);
  const curve3m = spreadBp(y.DGS10, y.DGS3MO);
  const hy = toBp(series('BAMLH0A0HYM2'));
  const baa = toBp(series('BAA10Y'));
  const flag = inversionFlag(curve2y, curve3m);

  // Плечо. FINRA: млн $, M2: млрд $, Z.1: млн $. Всё приводим к млрд $.
  const margin = mapValues(series('MARGIN_DEBT'), (v) => v / 1000);
  const m2 = series('M2SL');
  const marginM2 = combine(margin, m2, (a, b) => (a / b) * 100, monthKey);
  // Z.1 датирует квартал первым днём (2026-04-01 = II кв.), а значение — на конец квартала.
  // Сдвигаем на последний месяц квартала, чтобы совместить с помесячным долгом.
  const capRaw = series('BOGZ1LM883164105Q');
  const cap = { dates: capRaw.dates.map((d) => addMonths(d, 2)), values: capRaw.values.map((v) => v / 1000) };
  const capMargin = combine(cap, margin, (c, m) => (c / m) * 100, monthKey);

  // S&P 500: дневной ряд FRED есть только за 10 лет, до него — среднемесячные данные Шиллера.
  const sp500 = stitch(series('SP500_MONTHLY'), series('SP500'));
  const nasdaq = series('NASDAQCOM');
  const ndx = series('NASDAQ100');

  const pcEquity = series('PC_EQUITY');
  const pcTotal = series('PC_TOTAL');

  // --- Россия ---
  const keyRate = series('CBR_KEYRATE');
  const usdrub = series('CBR_USDRUB');
  const ofz = Object.fromEntries(OFZ.map((s) => [s.id, series(s.id)]));
  const ruCurve = spreadBp(ofz.OFZ_10Y, ofz.OFZ_2Y);
  const ruCurveKey = asof(ofz.OFZ_10Y, keyRate, (a, b) => Math.round((a - b) * 100));
  const rgbiYield = series('MOEX_RGBI_YIELD');
  const corpYield = stitch(series('MOEX_RUCBITR_YIELD'), series('MOEX_RUCBTRNS_YIELD'));
  const ruSpread = combine(corpYield, rgbiYield, (c, g) => Math.round((c - g) * 100));
  const imoex = series('MOEX_IMOEX');
  const rts = series('MOEX_RTSI');
  const rgbi = series('MOEX_RGBI');
  const rtsRub = asof(rts, usdrub, (px, fx) => px * fx);  // РТС в рублях: пункт × курс доллара

  // Бюджет (Минфин): суммы за 12 месяцев, трлн ₽.
  const budBal12 = budget12('BUD_BALANCE');
  const budRev12 = budget12('BUD_REV');
  const budOil12 = budget12('BUD_OILGAS');
  // ВВП (млрд ₽) — из отчёта о ФНБ: объём фонда в рублях и в % ВВП.
  const gdp = combine(series('NWF_TOTAL'), series('NWF_GDP'), (v, pct) => v / (pct / 100));
  const nwfTotal = mapValues(series('NWF_TOTAL'), (v) => v / 1000);
  const nwfLiquid = combine(series('NWF_TOTAL'), series('NWF_OTHER'), (t, o) => (t - o) / 1000);

  state.ind = {
    window, yields: y, curve2y, curve3m, flag,
    inversion: inversionStatus(flag),
    hy, baa,
    hyRoc: rateOfChange(hy, window),
    baaRoc: rateOfChange(baa, window),
    gz: series('GZ_SPREAD'), ebp: series('GZ_EBP'), gzProb: series('GZ_PROB'),
    usrec: series('USREC'),
    recessions: recessionPeriods(series('USREC')),
    margin, m2, marginM2, marginYoY: yearOverYear(margin), cap, capMargin,
    sp500, nasdaq, sp500Dd: drawdown(sp500), nasdaqDd: drawdown(nasdaq),
    cotComm: cotNet('COMM'), cotNoncomm: cotNet('NONCOMM'), cotSmall: cotNet('SMALL'),
    tffSpx: tffMoney('SPX', sp500, 50),
    tffNdx: tffMoney('NDX', ndx, 20),
    pcEquity, pcTotal,
    pcEquityMa: movingAverage(pcEquity, PC_SMOOTH), pcTotalMa: movingAverage(pcTotal, PC_SMOOTH),
    si: Object.fromEntries(['SPY', 'QQQ', 'IWM'].map((t) => [t, { si: series(`SI_${t}`), dtc: series(`DTC_${t}`) }])),

    keyRate, ofz, ruCurve, ruCurveKey, ruFlag: inversionStatus(inversionFlag(ruCurve, ruCurveKey)),
    rgbiYield, corpYield, ruSpread,
    imoex, rts, rgbi, imoexDd: drawdown(imoex), rtsDd: drawdown(rts), rgbiDd: drawdown(rgbi),
    futImoex: futoiMoney(FUT_IMOEX, imoex),
    futRts: futoiMoney({ RI: 2 }, rtsRub),       // 2 $ за пункт РТС, индекс уже в рублях
    futRgbi: futoiMoney({ RB: 100 }, rgbi),
    accImoexL: futoiAccounts(Object.keys(FUT_IMOEX), 'NL'),
    accImoexS: futoiAccounts(Object.keys(FUT_IMOEX), 'NS'),

    // Другие страны и разделы «Недвижимость» США/России
    c: Object.fromEntries(COUNTRIES.map((cfg) => [cfg.tab, computeCountry(cfg)])),
    re: { us: computeCountry(REAL_ESTATE.us), ru: computeCountry(REAL_ESTATE.ru) },

    budRev12, budOil12, budBal12,
    budNonoil12: budget12('BUD_NONOIL'),
    budExp12: budget12('BUD_EXP'),
    budNonoilBal12: budget12('BUD_NONOIL_BALANCE'),
    budBalYtd: mapValues(series('BUD_BALANCE'), (v) => v / 1000),
    budBal12Gdp: asof(budBal12, gdp, (b, g) => (b * 1000 / g) * 100),
    budOilShare: combine(budOil12, budRev12, (o, r) => (o / r) * 100),
    nwfTotal, nwfLiquid, nwfGdp: series('NWF_GDP'), nwfUsd: series('NWF_USD'),
    defenseMinfin: mapValues(yearTotals(series('BUD_DEFENSE')), (v) => v / 1000),
    defenseSipri: mapValues(series('SIPRI_RU_RUB'), (v) => v / 1000),
    sipriGdp: series('SIPRI_RU_GDP'), sipriGov: series('SIPRI_RU_GOV'),

    // Последняя дата по всем рядам (US и Россия) — правая граница периода.
    lastDate: Object.values(state.raw.series).map((s) => s.dates[s.dates.length - 1]).filter(Boolean).sort().pop(),
    // Самая ранняя дата среди рядов на графиках (USREC — только полосы рецессий, с 1854 г., не в счёт).
    firstDate: Object.entries(state.raw.series).filter(([id]) => id !== 'USREC')
      .map(([, s]) => s.dates[0]).filter(Boolean).sort()[0],
  };
}

// ---------------------------------------------------------------------------
// Сводная панель
// ---------------------------------------------------------------------------

/** Минимум ряда за последние N дней (для подписи «мин. за 2 года»). */
function minSince(s, days) {
  if (!s.dates.length) return null;
  const from = toIso(new Date(toDate(s.dates[s.dates.length - 1]) - days * DAY_MS));
  const vals = s.values.slice(lowerBound(s.dates, from));
  return vals.length ? Math.min(...vals) : null;
}

let tipCounter = 0;

// Карточка → график, на котором видно, откуда взято значение (по началу подписи карточки).
const CARD_CHART = {
  us: [['Спред 10Y', 'chart-curve'], ['Флаг инверсии', 'chart-curve'], ['Доходности трежерис', 'chart-yields'],
    ['Спред мусорных', 'chart-hy'], ['Изменение HY OAS', 'chart-roc'], ['Спред Baa', 'chart-baa'], ['GZ-спред', 'chart-gz'],
    ['Вероятность рецессии', 'chart-gzprob'], ['Маржинальный долг / M2', 'chart-margin-m2'], ['Капитализация /', 'chart-cap-margin'],
    ['Маржинальный долг', 'chart-margin-m2'], ['S&P 500', 'chart-indices'], ['NASDAQ Composite', 'chart-indices'],
    ['Фьючерсы S&P 500', 'chart-tff-spx'], ['Фьючерсы NASDAQ-100', 'chart-tff-ndx'], ['COT:', 'chart-cot'],
    ['Put/call', 'chart-putcall'], ['Short interest', 'chart-short'], ['Рецессия по NBER', 'chart-yields']],
  ru: [['Ключевая ставка', 'ru-rates'], ['ОФЗ 10 лет', 'ru-rates'], ['Спред ОФЗ', 'ru-curve'], ['Флаг инверсии', 'ru-curve'],
    ['Спред корпоративных', 'ru-spread'], ['Доходность: корпоративные', 'ru-bonds'], ['Индекс Мосбиржи', 'ru-indices'],
    ['Индекс РТС', 'ru-indices'], ['Индекс гособлигаций', 'ru-rgbi'], ['Фьючерсы на', 'ru-fut-net'],
    ['Дефицит', 'ru-budget-balance'], ['Нефтегазовые', 'ru-budget-flows'], ['ФНБ', 'ru-nwf'], ['Ликвидная часть', 'ru-nwf'],
    ['Военные расходы', 'ru-defense']],
};

function card({ label, value, unit = '', zone, detail = '', extraHtml = '', explain, source, chart }) {
  const zoneStyle = zone ? `style="--zone: var(${zone.color})"` : '';
  const tipId = `tip-${++tipCounter}`;
  const src = source ? `<span class="tip-src">Источник: ${srcHtml(source)}</span>` : '';
  const tip = explain
    ? `<button class="info" aria-label="Что это?" aria-describedby="${tipId}">?</button>
       <div class="tip" role="tooltip" id="${tipId}">${escapeHtml(explain)}${src}</div>`
    : '';
  return `<div class="card" ${zoneStyle}>
    <div class="label">${label}</div>${tip}
    <div class="value">${value}${unit ? ` <small>${unit}</small>` : ''}</div>
    ${zone ? `<div class="zone">${zone.label}</div>` : ''}
    ${extraHtml}
    ${detail ? `<div class="detail">${detail}</div>` : ''}
    ${chartLink(chart, label)}
  </div>`;
}

/** Ссылка «к графику» на карточке. */
function chartLink(chart, label) {
  const id = chart || ((CARD_CHART[state.tab] || []).find(([prefix]) => label.startsWith(prefix)) || [])[1];
  return id ? `<a class="to-chart" href="#panel-${id}" data-chart="${id}">к графику ↓</a>` : '';
}

/** Карточка с зоной по перцентилю собственной истории. invert — если «хуже» = ниже. */
function percentileCard(opts, s, zones, invert = false) {
  const l = last(s);
  if (!l) return '';
  const p = percentile(s.values, l.value);
  return card({
    ...opts,
    value: opts.value ?? fmtNum(l.value, opts.digits ?? 1, opts.signed),
    zone: zoneOf(zones, invert ? 100 - p : p),
    detail: `${opts.detail ?? ''}перцентиль истории: ${fmtNum(p)}%`,
  });
}

/**
 * Карточка «крайние 10% истории» для показателей позиционирования.
 * pctSeries — ряд, по которому считать перцентиль, если он отличается от показываемого
 * (например, позиции в контрактах, а показываем в долларах).
 */
function extremesCard(opts, s, { high, low }, pctSeries = s) {
  const l = last(s), lp = last(pctSeries);
  if (!l || !lp) return '';
  const p = percentile(pctSeries.values, lp.value);
  const zone = p > 90 ? { label: high, color: '--caution' }
    : p < 10 ? { label: low, color: '--caution' }
      : { label: 'В обычном диапазоне', color: '--calm' };
  return card({
    ...opts, value: fmtNum(l.value, opts.digits ?? 1, opts.signed), zone,
    detail: `${opts.detail ?? ''}на ${fmtDate(l.date)} · перцентиль${pctSeries === s ? '' : ' (по контрактам)'}: ${fmtNum(p)}%`,
  });
}

function curveCard(label, s, explain, source, chart) {
  const l = last(s);
  if (!l) return '';
  return card({
    label, value: fmtNum(l.value, 0, true), unit: 'б.п.', zone: zoneOf(CURVE_ZONES, l.value), explain, source, chart,
    detail: `на ${fmtDate(l.date)} · мин. за 2 года: ${fmtNum(minSince(s, 730), 0, true)} б.п.`,
  });
}

function inversionCard(inv, explain, source, chart) {
  if (!inv) return '';
  // Функции, а не готовые объекты: поля inv различаются в зависимости от kind.
  const variants = {
    inverted: () => ({
      value: 'Да', zone: { label: 'Инверсия сейчас', color: '--panic' },
      detail: `с ${fmtDate(inv.since)}, ${fmtNum(inv.days)} дн.`,
    }),
    uninverted: () => ({
      value: 'Нет', zone: { label: 'Дезинверсия', color: '--stress' },
      detail: `вышла из инверсии ${fmtDate(inv.endedOn)}, ${fmtNum(inv.ago)} дн. назад`,
    }),
    none: () => ({
      value: 'Нет', zone: { label: 'Инверсии нет', color: '--calm' },
      detail: inv.lastInverted ? `последний день инверсии: ${fmtDate(inv.lastInverted)}` : '',
    }),
  };
  return card({ label: 'Флаг инверсии', explain, source, chart, ...variants[inv.kind]() });
}

function indexCard(label, s, dd, explain, source, digits = 0, chart) {
  const l = last(s), d = last(dd);
  if (!l) return '';
  return card({
    label, value: fmtNum(l.value, digits), explain: `${explain} ${EXPLAIN.drawdown}`, source, chart,
    zone: zoneOf(DRAWDOWN_ZONES, d.value),
    detail: `на ${fmtDate(l.date)} · от максимума: ${fmtNum(d.value, 1)}%`,
  });
}

function usCards(I) {
  const curve = [
    curveCard('Спред 10Y − 2Y', I.curve2y, EXPLAIN.curve2y, SRC.curve),
    curveCard('Спред 10Y − 3M', I.curve3m, EXPLAIN.curve3m, SRC.curve),
    inversionCard(I.inversion, EXPLAIN.flag, SRC.curve),
  ];
  const yl = YIELDS.map((s) => last(I.yields[s.id]));
  if (yl.some(Boolean)) {
    const head = YIELDS.map((s) => `<span>${s.name}</span>`).join('');
    const vals = yl.map((l) => `<span>${l ? fmtNum(l.value, 2) : '—'}</span>`).join('');
    curve.push(card({
      label: 'Доходности трежерис, %', source: SRC.yields, value: '', explain: EXPLAIN.yields,
      extraHtml: `<div class="yields">${head}${vals}</div>`,
      detail: `на ${fmtDate(yl.map((l) => l?.date).filter(Boolean).sort().pop())}`,
    }));
  }

  const credit = [];
  const hy = last(I.hy), hyRoc = last(I.hyRoc), baa = last(I.baa), baaRoc = last(I.baaRoc);
  if (hy) {
    credit.push(card({
      label: 'Спред мусорных облигаций (HY OAS)', source: SRC.hy, value: fmtNum(hy.value), unit: 'б.п.',
      zone: zoneOf(HY_ZONES, hy.value), detail: `на ${fmtDate(hy.date)}`, explain: EXPLAIN.hy,
    }));
  }
  if (hyRoc) {
    credit.push(card({
      label: `Изменение HY OAS за ${I.window} торг. дн.`, source: SRC.hyRoc, value: fmtNum(hyRoc.value, 0, true), unit: 'б.п.',
      zone: zoneOf(HY_ROC_ZONES, hyRoc.value), explain: EXPLAIN.hyRoc,
      detail: 'пороги эвристические: +50 / +150 / +300 б.п. для окна ~60 дн.',
    }));
  }
  if (baa) {
    credit.push(card({
      label: 'Спред Baa − 10Y (с 1986)', source: SRC.baa, value: fmtNum(baa.value), unit: 'б.п.',
      zone: zoneOf(BAA_ZONES, baa.value), explain: EXPLAIN.baa,
      detail: `на ${fmtDate(baa.date)} · за ${I.window} дн.: ${fmtNum(baaRoc?.value, 0, true)} б.п.`,
    }));
  }
  const gz = last(I.gz);
  if (gz) {
    credit.push(percentileCard({
      label: 'GZ-спред ФРС (с 1973)', source: SRC.gz, unit: 'б.п.', value: fmtNum(gz.value * 100), explain: EXPLAIN.gz,
      detail: `на ${fmtMonth(gz.date)} · EBP: ${fmtNum(last(I.ebp)?.value * 100, 0, true)} б.п. · `,
    }, I.gz, SPREAD_PCT_ZONES));
  }
  const prob = last(I.gzProb);
  if (prob) {
    credit.push(card({
      label: 'Вероятность рецессии за 12 мес. (модель ФРС)', source: SRC.gz, value: fmtNum(prob.value, 0), unit: '%',
      zone: zoneOf(PROB_ZONES, prob.value), explain: EXPLAIN.gzProb,
      detail: `на ${fmtMonth(prob.date)} · пороги условные: 20 / 40 / 60%`,
    }));
  }

  const leverage = [];
  const mm = last(I.marginM2);
  if (mm) {
    leverage.push(percentileCard({
      label: 'Маржинальный долг / M2', source: SRC.margin, unit: '%', digits: 2, explain: EXPLAIN.marginM2,
      detail: `на ${fmtMonth(mm.date)} · `,
    }, I.marginM2, LEVERAGE_ZONES));
  }
  const cm = last(I.capMargin);
  if (cm) {
    leverage.push(percentileCard({
      label: 'Капитализация / маржинальный долг', source: SRC.cap, unit: '%', digits: 0, explain: EXPLAIN.capMargin,
      detail: `на ${fmtMonth(cm.date)} (квартал) · ниже = больше плеча · `,
    }, I.capMargin, LEVERAGE_ZONES, true));
  }
  const m = last(I.margin), yoy = last(I.marginYoY);
  if (m) {
    leverage.push(card({
      label: 'Маржинальный долг', source: SRC.finra, value: fmtNum(m.value), unit: 'млрд $', explain: EXPLAIN.margin,
      zone: yoy && yoy.value > 30 ? { label: `Быстрый рост: ${fmtNum(yoy.value, 0, true)}% г/г`, color: '--caution' }
        : { label: `${fmtNum(yoy?.value, 0, true)}% за год`, color: '--border' },
      detail: `на ${fmtMonth(m.date)}, FINRA, задержка ~3–4 недели`,
    }));
  }

  const market = [
    indexCard('S&P 500', I.sp500, I.sp500Dd, EXPLAIN.sp500, SRC.indices),
    indexCard('NASDAQ Composite', I.nasdaq, I.nasdaqDd, EXPLAIN.nasdaq, SRC.indices),
    extremesCard({
      label: 'Фьючерсы S&P 500: хедж-фонды, нетто', source: SRC.tff, unit: 'млрд $', digits: 0, signed: true,
      explain: `${EXPLAIN.tffLev} ${EXPLAIN.tffMoney}`,
    }, I.tffSpx.LEV.net, { high: 'Мало шортов у хедж-фондов', low: 'Много шортов у хедж-фондов' }, I.tffSpx.LEV.netContracts),
    extremesCard({
      label: 'Фьючерсы S&P 500: управляющие, нетто', source: SRC.tff, unit: 'млрд $', digits: 0, signed: true,
      explain: `${EXPLAIN.tffAsset} ${EXPLAIN.tffMoney}`,
    }, I.tffSpx.ASSET.net, { high: 'Очень большие лонги', low: 'Лонги сокращены' }, I.tffSpx.ASSET.netContracts),
    extremesCard({
      label: 'Фьючерсы NASDAQ-100: хедж-фонды, нетто', source: SRC.tff, unit: 'млрд $', digits: 1, signed: true,
      explain: `${EXPLAIN.tffLev} ${EXPLAIN.tffMoney}`,
    }, I.tffNdx.LEV.net, { high: 'Мало шортов у хедж-фондов', low: 'Много шортов у хедж-фондов' }, I.tffNdx.LEV.netContracts),
    extremesCard({
      label: 'COT: мелкие трейдеры, чистая позиция', source: SRC.cot, unit: '% ОИ', signed: true, explain: EXPLAIN.cotSmall,
      detail: 'E-mini S&P 500, ',
    }, I.cotSmall, { high: 'Сильный оптимизм мелких', low: 'Сильный пессимизм мелких' }),
  ];

  const pc = last(I.pcEquityMa);
  if (pc) {
    const p = percentile(I.pcEquityMa.values, pc.value);
    market.push(card({
      label: `Put/call по акциям, среднее ${PC_SMOOTH} дн.`, source: SRC.putcall, value: fmtNum(pc.value, 2), explain: EXPLAIN.pcEquity,
      zone: p < 10 ? { label: 'Самоуверенность: мало страховок', color: '--caution' }
        : p > 90 ? { label: 'Страх: много страховок', color: '--stress' }
          : { label: 'Нейтрально', color: '--calm' },
      detail: `CBOE, на ${fmtDate(pc.date)} · перцентиль: ${fmtNum(p)}%`,
    }));
  }
  const spy = I.si.SPY, sl = last(spy.si), dl = last(spy.dtc);
  if (sl) {
    const p = percentile(spy.si.values, sl.value);
    market.push(card({
      label: 'Short interest SPY', source: SRC.short, value: fmtNum(sl.value, 0), unit: 'млн паёв', explain: EXPLAIN.siSPY,
      zone: p > 90 ? { label: 'Много ставок на падение', color: '--caution' }
        : p < 10 ? { label: 'Мало ставок на падение', color: '--caution' }
          : { label: 'Обычный уровень', color: '--calm' },
      detail: `FINRA, на ${fmtDate(sl.date)} · ${fmtNum(dl?.value, 1)} дн. на покрытие · перцентиль с 2017: ${fmtNum(p)}%`,
    }));
  }
  const rec = last(I.usrec);
  if (rec) {
    market.push(card({
      label: 'Рецессия по NBER', source: SRC.nber, value: rec.value === 1 ? 'Да' : 'Нет', explain: EXPLAIN.usrec,
      zone: rec.value === 1 ? { label: 'Идёт рецессия', color: '--panic' } : { label: 'Не объявлена', color: '--calm' },
      detail: `на ${fmtMonth(rec.date)} · объявляется задним числом`,
    }));
  }

  return [
    ['Кривая доходности', curve],
    ['Кредитные спреды', credit],
    ['Плечо на рынке', leverage],
    ['Рынок акций и позиционирование', market],
  ];
}

function ruCards(I) {
  const rates = [];
  const kr = last(I.keyRate);
  if (kr) {
    const yearAgo = I.keyRate.values[Math.max(0, lowerBound(I.keyRate.dates, addMonths(kr.date, -12)) - 1)];
    const ch = kr.value - yearAgo;
    rates.push(card({
      label: 'Ключевая ставка ЦБ', source: SRC.keyRate, value: fmtNum(kr.value, 2), unit: '%', explain: EXPLAIN.keyRate,
      zone: ch < 0 ? { label: `Снижается: ${fmtNum(ch, 2, true)} п.п. за год`, color: '--caution' }
        : ch > 0 ? { label: `Растёт: ${fmtNum(ch, 2, true)} п.п. за год`, color: '--stress' }
          : { label: 'Без изменений за год', color: '--border' },
      detail: `на ${fmtDate(kr.date)}`,
    }));
  }
  const o10 = last(I.ofz.OFZ_10Y), o2 = last(I.ofz.OFZ_2Y);
  if (o10) {
    rates.push(card({
      label: 'ОФЗ 10 лет / 2 года (КБД)', source: SRC.ofz, value: `${fmtNum(o10.value, 2)} / ${fmtNum(o2?.value, 2)}`, unit: '%',
      explain: `${EXPLAIN.OFZ_10Y} ${EXPLAIN.OFZ_2Y}`, detail: `на ${fmtDate(o10.date)}, Мосбиржа`,
    }));
  }
  rates.push(curveCard('Спред ОФЗ 10Y − 2Y', I.ruCurve, EXPLAIN.ruCurve, SRC.ofz));
  rates.push(curveCard('Спред ОФЗ 10Y − ключевая ставка', I.ruCurveKey, EXPLAIN.ruCurveKey, SRC.ruCurve));
  rates.push(inversionCard(I.ruFlag, EXPLAIN.ruFlag, SRC.ruCurve));

  const credit = [];
  const sp = last(I.ruSpread);
  if (sp) {
    credit.push(percentileCard({
      label: 'Спред корпоративных облигаций к ОФЗ', source: SRC.ruBonds, unit: 'б.п.', digits: 0, explain: EXPLAIN.ruSpread,
      detail: `на ${fmtDate(sp.date)} · `,
    }, I.ruSpread, SPREAD_PCT_ZONES));
  }
  const cy = last(I.corpYield), gy = last(I.rgbiYield);
  if (cy) {
    credit.push(card({
      label: 'Доходность: корпоративные / ОФЗ (RGBI)', source: SRC.ruBonds, value: `${fmtNum(cy.value, 2)} / ${fmtNum(gy?.value, 2)}`,
      unit: '%', explain: `${EXPLAIN.corpYield} ${EXPLAIN.rgbiYield}`, detail: `на ${fmtDate(cy.date)}`,
    }));
  }

  const market = [
    indexCard('Индекс Мосбиржи (IMOEX)', I.imoex, I.imoexDd, EXPLAIN.imoex, SRC.ruIndices),
    indexCard('Индекс РТС', I.rts, I.rtsDd, EXPLAIN.rts, SRC.ruIndices),
    indexCard('Индекс гособлигаций RGBI', I.rgbi, I.rgbiDd, EXPLAIN.rgbi, SRC.ruIndices, 2),
  ];

  const retail = { high: 'Розница в сильном лонге', low: 'Розница в сильном шорте' };
  const pos = [
    extremesCard({
      label: 'Фьючерсы на IMOEX: физлица, нетто', source: SRC.futoi, unit: 'млрд ₽', signed: true,
      explain: `${EXPLAIN.futFiz} ${EXPLAIN.futMoney}`, detail: 'Мосбиржа, ',
    }, I.futImoex.FIZ.net, retail),
    extremesCard({
      label: 'Фьючерсы на РТС: физлица, нетто', source: SRC.futoi, unit: 'млрд ₽', signed: true,
      explain: `${EXPLAIN.futFiz} ${EXPLAIN.futMoney}`, detail: 'Мосбиржа, ',
    }, I.futRts.FIZ.net, retail),
    extremesCard({
      label: 'Фьючерсы на RGBI: физлица, нетто', source: SRC.futoi, unit: 'млрд ₽', signed: true,
      explain: `${EXPLAIN.futFiz} ${EXPLAIN.futMoney}`, detail: 'Мосбиржа, ',
    }, I.futRgbi.FIZ.net, retail),
  ];

  const budget = [];
  const ytd = last(I.budBalYtd);
  if (ytd) {
    const prevYear = I.budBalYtd.values[I.budBalYtd.dates.indexOf(addMonths(ytd.date, -12))];
    budget.push(card({
      label: 'Дефицит (−) / профицит бюджета с начала года', value: fmtNum(ytd.value, 2, true), unit: 'трлн ₽',
      explain: EXPLAIN.budYtd, source: SRC.budget,
      zone: ytd.value < 0 ? { label: 'Дефицит', color: '--stress' } : { label: 'Профицит', color: '--calm' },
      detail: `за 01–${fmtMonth(ytd.date)} · год назад за тот же период: ${fmtNum(prevYear, 2, true)} трлн ₽`,
    }));
  }
  const b12 = last(I.budBal12), bg = last(I.budBal12Gdp), nb12 = last(I.budNonoilBal12);
  if (b12) {
    budget.push(card({
      label: 'Дефицит (−) / профицит за 12 месяцев', value: fmtNum(b12.value, 2, true), unit: 'трлн ₽',
      explain: `${EXPLAIN.budBal} ${EXPLAIN.budGdp}`, source: SRC.budget,
      zone: bg ? zoneOf(DEFICIT_ZONES, bg.value) : undefined,
      detail: `по ${fmtMonth(b12.date)} · ≈ ${fmtNum(bg?.value, 1, true)}% ВВП · ненефтегазовый: ${fmtNum(nb12?.value, 1, true)} трлн ₽ · пороги условные`,
    }));
  }
  const oil = last(I.budOil12), share = last(I.budOilShare);
  if (oil) {
    const yearAgo = I.budOil12.values[I.budOil12.dates.indexOf(addMonths(oil.date, -12))];
    const ch = yearAgo ? (oil.value / yearAgo - 1) * 100 : null;
    budget.push(card({
      label: 'Нефтегазовые доходы за 12 месяцев', value: fmtNum(oil.value, 2), unit: 'трлн ₽',
      explain: EXPLAIN.budOil, source: SRC.budget,
      zone: ch == null ? undefined : ch < 0 ? { label: `Снижаются: ${fmtNum(ch, 0, true)}% г/г`, color: '--stress' }
        : { label: `Растут: ${fmtNum(ch, 0, true)}% г/г`, color: '--calm' },
      detail: `по ${fmtMonth(oil.date)} · ${fmtNum(share?.value, 0)}% всех доходов бюджета`,
    }));
  }
  const nt = last(I.nwfTotal), nl = last(I.nwfLiquid);
  if (nt) {
    budget.push(card({
      label: 'ФНБ: всего / ликвидная часть', value: `${fmtNum(nt.value, 1)} / ${fmtNum(nl?.value, 1)}`, unit: 'трлн ₽',
      explain: `${EXPLAIN.nwf} ${EXPLAIN.nwfLiquid}`, source: SRC.nwf,
      detail: `на ${fmtMonth(nt.date)} · ${fmtNum(last(I.nwfGdp)?.value, 1)}% ВВП · ${fmtNum(last(I.nwfUsd)?.value, 0)} млрд $`,
    }));
  }
  if (nl && b12 && b12.value < 0) {
    const cover = nl.value / -b12.value;
    budget.push(card({
      label: 'Ликвидная часть ФНБ / годовой дефицит', value: fmtNum(cover, 1), unit: 'года',
      explain: EXPLAIN.nwfCover, source: [...SRC.nwf, ...SRC.budget],
      zone: cover < 0.5 ? { label: 'Запас меньше полугода дефицита', color: '--stress' }
        : cover < 1 ? { label: 'Запас меньше года дефицита', color: '--caution' }
          : { label: 'Запас больше года дефицита', color: '--calm' },
      detail: `${fmtNum(nl.value, 1)} трлн ₽ ликвидных средств против дефицита ${fmtNum(-b12.value, 1)} трлн ₽ за 12 мес.`,
    }));
  }
  const mil = last(I.defenseSipri);
  if (mil) {
    budget.push(card({
      label: `Военные расходы, ${mil.date.slice(0, 4)} (оценка SIPRI)`, value: fmtNum(mil.value, 1), unit: 'трлн ₽',
      explain: `${EXPLAIN.defenseSipri} ${EXPLAIN.defenseMinfin}`, source: SRC.sipri,
      detail: `${fmtNum(last(I.sipriGdp)?.value, 1)}% ВВП · ${fmtNum(last(I.sipriGov)?.value, 1)}% всех госрасходов`,
    }));
  }

  return [
    ['Ставки и кривая ОФЗ', rates],
    ['Кредитный риск', credit],
    ['Индексы', market],
    ['Позиции физлиц и юрлиц во фьючерсах', pos],
    ['Федеральный бюджет', budget],
  ];
}

function renderCards(tab) {
  const I = state.ind;
  const groups = tab === 'us'
    ? [...usCards(I), ['Недвижимость', realEstateCards(I.re.us, REAL_ESTATE.us, 'us')]]
    : tab === 'ru'
      ? [...ruCards(I), ['Валюта и недвижимость', [fxCard(I.re.ru.fx, REAL_ESTATE.ru.fx, 'ru-fx'), ...realEstateCards(I.re.ru, REAL_ESTATE.ru, 'ru')]]]
      : countryCards(COUNTRY[tab]);
  $(`#cards-${tab}`).innerHTML = groups
    .map(([title, cards]) => [title, cards.filter(Boolean)])
    .filter(([, cards]) => cards.length)
    .map(([title, cards]) => `<h3 class="group">${title}</h3><div class="cards">${cards.join('')}</div>`)
    .join('');
}

// ---------------------------------------------------------------------------
// Графики: строительные блоки
// ---------------------------------------------------------------------------

/**
 * Вставляет null в разрывы длиннее maxGapDays, чтобы Plotly не соединял линией
 * точки через многолетние дыры (например, 30-летние трежерис не выпускались в 2002–2006).
 */
function withGaps(s, maxGapDays) {
  const x = [], y = [];
  for (let i = 0; i < s.dates.length; i++) {
    if (i > 0 && daysBetween(s.dates[i - 1], s.dates[i]) > maxGapDays) {
      x.push(s.dates[i]);
      y.push(null);
    }
    x.push(s.dates[i]);
    y.push(s.values[i]);
  }
  return { x, y };
}

/** Линия (SVG). gap — порог разрыва в днях; dash — стиль линии; extra — атрибуты трассы Plotly. */
function line(s, name, colorVar, hover, { gap = 20, dash, ...extra } = {}) {
  return {
    type: 'scatter',
    mode: 'lines',
    name,
    ...withGaps(s, gap),
    line: { color: css(colorVar), width: 1.5, dash },
    hovertemplate: hover,
    ...extra,
  };
}

/** Столбцы (годовые значения). */
function bars(s, name, colorVar, hover, extra = {}) {
  return { type: 'bar', name, x: s.dates, y: s.values, marker: { color: css(colorVar) }, hovertemplate: hover, ...extra };
}

/** Серые вертикальные полосы рецессий (США — NBER, Россия — периоды спада ВВП). */
function recessionShapes(tab) {
  const periods = tab === 'ru' ? RU_CRISES : tab === 'us' ? state.ind.recessions : ((state.ind.c[tab] || {}).bands || []);
  return periods.map(([x0, x1]) => ({
    type: 'rect', xref: 'x', yref: 'paper', x0, x1, y0: 0, y1: 1,
    fillcolor: css('--recession'), line: { width: 0 }, layer: 'below', name: 'recession',
  }));
}

/** Горизонтальные цветные полосы пороговых зон. */
function zoneShapes(zones) {
  let lo = -1e4;
  return zones.map((z) => {
    const shape = {
      type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: lo, y1: Math.min(z.max, 1e4),
      fillcolor: withAlpha(z.color, 0.09), line: { width: 0 }, layer: 'below',
    };
    lo = z.max;
    return shape;
  });
}

/** Подписи зон у правого края графика (последняя зона без верхней границы не подписывается). */
function zoneAnnotations(zones) {
  return zones.filter((z) => Number.isFinite(z.max)).map((z) => ({
    xref: 'paper', yref: 'y', x: 1, y: z.max,
    xanchor: 'right', yanchor: 'top', text: z.label, showarrow: false,
    font: { size: 11, color: css(z.color) },
  }));
}

/** Псевдо-ряд для легенды: позволяет кликом скрывать/показывать полосы рецессий. */
function recessionLegendTrace(tab) {
  return {
    type: 'scatter', mode: 'markers', x: [null], y: [null],
    name: TAB_BANDS[tab].legend, meta: 'recession-toggle',
    marker: { symbol: 'square', size: 12, color: css('--recession') },
    hoverinfo: 'skip',
  };
}

/** Индекс акций на правой логарифмической шкале — по переключателю «Наложить индекс». */
function overlayTrace(tab) {
  const key = state.overlay[tab];
  if (!key) return null;
  const I = state.ind;
  const [s, name] = key === 'eq'
    ? [I.c[tab].equity, COUNTRY[tab].equity.short]
    : { sp500: [I.sp500, 'S&P 500'], nasdaq: [I.nasdaq, 'NASDAQ'], imoex: [I.imoex, 'IMOEX'], rts: [I.rts, 'РТС'] }[key];
  return line(s, `${name} (правая шкала)`, '--overlay', '%{y:,.0f}', {
    gap: 40, yaxis: 'y2', meta: 'overlay', line: { color: css('--overlay'), width: 1.2, dash: 'dot' },
  });
}

function baseLayout(tab, { unit = '', zeroLine = false, shapes = [], annotations = [], log = false } = {}) {
  const text = css('--text'), muted = css('--muted'), grid = css('--grid');
  return {
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { family: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif', size: 12, color: text },
    margin: { l: 56, r: 12, t: 8, b: 32 },
    hovermode: 'x unified',
    hoverlabel: { bgcolor: css('--surface'), bordercolor: css('--border'), font: { color: text } },
    dragmode: 'zoom',
    legend: { orientation: 'h', x: 0, y: 1.02, yanchor: 'bottom', font: { color: muted } },
    xaxis: {
      type: 'date', range: state.range, gridcolor: grid, linecolor: grid,
      hoverformat: '%d.%m.%Y', tickfont: { color: muted },
      showspikes: false,  // вместо вертикальной линии — точки цвета линий (drawDots)
    },
    yaxis: {
      type: log ? 'log' : 'linear', gridcolor: grid, ticksuffix: unit, fixedrange: true,
      tickformat: log ? undefined : ',~r', separatethousands: true,
      tickfont: { color: muted }, zeroline: zeroLine, zerolinecolor: muted, zerolinewidth: 1.5,
    },
    shapes: [...recessionShapes(tab), ...shapes],
    annotations,
  };
}

// Узкий экран (телефон) — легенда и высота графиков раскладываются иначе, см. renderCharts().
const NARROW = matchMedia('(max-width: 640px)');
// Сенсорный экран (телефон, планшет) — жесты вместо мыши, см. bindTouchGestures().
const TOUCH = matchMedia('(pointer: coarse)');

// doubleClick: false — двойной клик обрабатываем сами (отдалить), а не сбрасываем масштаб Plotly.
const PLOT_CONFIG = { responsive: true, displaylogo: false, locale: 'ru', doubleClick: false, modeBarButtonsToRemove: ['lasso2d', 'select2d'] };

/**
 * Заливка областей ниже нуля — наглядно показывает периоды инверсии.
 * Plotly тянет заливку через пропуски (null), поэтому на каждый непрерывный участок
 * данных — своя трасса; возвращает массив трасс.
 */
function fillBelowZero(s, colorVar, group) {
  // Порог разрыва — по типичному шагу ряда (дневные, месячные, квартальные данные).
  const steps = s.dates.slice(1).map((d, i) => daysBetween(s.dates[i], d)).sort((a, b) => a - b);
  const gap = Math.max(20, 2.5 * (steps[Math.floor(steps.length / 2)] || 1));
  const segments = [];
  let cur = null;
  s.dates.forEach((d, i) => {
    if (!cur || daysBetween(s.dates[i - 1], d) > gap) segments.push(cur = { x: [], y: [] });
    cur.x.push(d);
    cur.y.push(Math.min(s.values[i], 0));
  });
  return segments.map(({ x, y }) => ({
    type: 'scatter', mode: 'none', x, y,
    fill: 'tozeroy', fillcolor: withAlpha(colorVar, 0.3), legendgroup: group, showlegend: false,
    hoverinfo: 'skip', meta: 'no-scale',
  }));
}

/**
 * Лонги (сплошная) и шорты (пунктир) группы участников в деньгах.
 * Одна группа легенды: клик по названию скрывает обе линии.
 */
function longShortTraces(pos, name, colorVar, unit, { hidden = false, digits = 1 } = {}) {
  const common = { legendgroup: name, ...(hidden ? { visible: 'legendonly' } : {}) };
  return [
    line(pos.L, `${name}: лонг`, colorVar, `%{y:,.${digits}f} ${unit}`, common),
    line(pos.S, `${name}: шорт`, colorVar, `%{y:,.${digits}f} ${unit}`, { ...common, dash: 'dash' }),
  ];
}

// ---------------------------------------------------------------------------
// Описание графиков: вкладка, раздел, заголовок, вводный текст, ряды с пояснениями
// ---------------------------------------------------------------------------

/*
 * Каждый график: build(I, tab) возвращает { data, layout, explain }, где explain —
 * список [название, CSS-цвет, текст] для подписей под графиком.
 * Опции масштаба оси Y: includeZero, minTop (зоны всегда видны), log.
 */
const CHARTS = [
  // ============================ США ============================
  {
    tab: 'us', id: 'chart-yields', source: SRC.yields, section: 'Кривая доходности', title: 'Доходности трежерис по срокам',
    intro: 'Сколько платит правительство США за заём на разные сроки. Обычно длинные бумаги доходнее коротких; когда линии сходятся или короткие поднимаются выше длинных, рынок закладывает замедление экономики.',
    build: (I, tab) => ({
      data: YIELDS.map((s) => line(I.yields[s.id], s.name, s.color, '%{y:.2f}%')),
      layout: baseLayout(tab, { unit: '%' }),
      explain: YIELDS.map((s) => [s.name, s.color, EXPLAIN[s.id]]),
    }),
  },
  {
    tab: 'us', id: 'chart-curve', source: SRC.curve, title: 'Спреды кривой доходности',
    intro: 'Разница между длинными и короткими ставками. Ниже нуля — инверсия: короткие ставки выше длинных. Исторически инверсия предшествовала рецессиям с лагом от нескольких месяцев до двух лет.',
    includeZero: true,
    build: (I, tab) => ({
      data: [
        ...fillBelowZero(I.curve2y, '--s-2y', '2y'),
        ...fillBelowZero(I.curve3m, '--s-3m', '3m'),
        line(I.curve2y, '10Y − 2Y', '--s-2y', '%{y:.0f} б.п.', { legendgroup: '2y' }),
        line(I.curve3m, '10Y − 3M', '--s-3m', '%{y:.0f} б.п.', { legendgroup: '3m' }),
      ],
      layout: baseLayout(tab, { zeroLine: true }),
      explain: [
        ['10Y − 2Y', '--s-2y', EXPLAIN.curve2y],
        ['10Y − 3M', '--s-3m', EXPLAIN.curve3m],
        ['Заливка ниже нуля', '--panic', EXPLAIN.inversionFill],
      ],
    }),
  },
  {
    tab: 'us', id: 'chart-hy', source: SRC.hy, section: 'Кредитные спреды', title: 'Спред мусорных облигаций (ICE BofA US High Yield OAS)',
    intro: 'Цветом — пороговые зоны: до 500 б.п. спокойно, 500–700 настороженность, 700–1000 стресс, выше 1000 паника. Ограничение источника: с 2024 года ICE разрешает FRED публиковать только последние 3 года этого ряда и убрал более раннюю историю даже из архивных версий; других бесплатных источников полной истории нет. Поэтому для прошлых кризисов ниже есть два длинных аналога: GZ-спред ФРС (с 1973) и Baa − 10Y (с 1986).',
    minTop: 1100,  // всегда видны все четыре зоны, включая «панику»
    build: (I, tab) => ({
      data: [line(I.hy, 'HY OAS', '--s-10y', '%{y:.0f} б.п.')],
      layout: baseLayout(tab, { shapes: zoneShapes(HY_ZONES), annotations: zoneAnnotations(HY_ZONES) }),
      explain: [['HY OAS', '--s-10y', EXPLAIN.hy]],
    }),
  },
  {
    tab: 'us', id: 'chart-gz', source: SRC.gz, title: 'Кредитный спред ФРС (Gilchrist–Zakrajšek) и премия за риск, с 1973 года',
    intro: 'Длинная замена истории мусорного спреда: экономисты ФРС считают его по облигациям сотен компаний, помесячно. Видно все рецессии с 1970-х: спред и особенно премия EBP растут заранее.',
    includeZero: true,
    build: (I, tab) => ({
      data: [
        line(mapValues(I.gz, (v) => v * 100), 'GZ-спред', '--s-10y', '%{y:.0f} б.п.', { gap: 45 }),
        line(mapValues(I.ebp, (v) => v * 100), 'Премия EBP', '--s-2y', '%{y:+.0f} б.п.', { gap: 45 }),
      ],
      layout: baseLayout(tab, { zeroLine: true }),
      explain: [['GZ-спред', '--s-10y', EXPLAIN.gz], ['Премия EBP', '--s-2y', EXPLAIN.ebp]],
    }),
  },
  {
    tab: 'us', id: 'chart-gzprob', source: SRC.gz, title: 'Вероятность рецессии в ближайшие 12 месяцев (модель ФРС)',
    intro: 'Оценка по модели экономистов ФРС на основе премии EBP и наклона кривой. Цветом — условные зоны 20 / 40 / 60%.',
    minTop: 70,
    build: (I, tab) => ({
      data: [line(I.gzProb, 'Вероятность рецессии', '--s-5y', '%{y:.0f}%', { gap: 45 })],
      layout: baseLayout(tab, { unit: '%', shapes: zoneShapes(PROB_ZONES), annotations: zoneAnnotations(PROB_ZONES) }),
      explain: [['Вероятность рецессии', '--s-5y', EXPLAIN.gzProb]],
    }),
  },
  {
    tab: 'us', id: 'chart-baa', source: SRC.baa, title: "Moody's Baa − 10Y, с 1986 года",
    intro: 'Дневной кредитный спред с длинной историей. Двигается вместе со спредом мусорных облигаций, но в меньшем масштабе, поэтому зоны свои и приблизительные: до 250 б.п. спокойно, 250–350 настороженность, 350–450 стресс, выше 450 паника (пики: 2001–02 ≈ 390, 2020 ≈ 430, 2008 ≈ 616).',
    minTop: 500,
    build: (I, tab) => ({
      data: [line(I.baa, 'Baa − 10Y', '--s-5y', '%{y:.0f} б.п.')],
      layout: baseLayout(tab, { shapes: zoneShapes(BAA_ZONES), annotations: zoneAnnotations(BAA_ZONES) }),
      explain: [['Baa − 10Y', '--s-5y', EXPLAIN.baa]],
    }),
  },
  {
    tab: 'us', id: 'chart-roc', source: SRC.hyRoc, title: 'Скорость изменения кредитных спредов',
    intro: 'Насколько спреды выросли или упали за выбранное окно (поле «Окно ROC» сверху). Резкий рост — бегство от риска, даже если сам уровень спреда ещё спокойный.',
    includeZero: true,
    build: (I, tab) => ({
      data: [
        line(I.hyRoc, `HY OAS, Δ за ${I.window} дн.`, '--s-10y', '%{y:+.0f} б.п.'),
        line(I.baaRoc, `Baa − 10Y, Δ за ${I.window} дн.`, '--s-5y', '%{y:+.0f} б.п.'),
      ],
      layout: baseLayout(tab, { zeroLine: true }),
      explain: [
        [`HY OAS, Δ за ${I.window} дн.`, '--s-10y', EXPLAIN.hyRoc],
        [`Baa − 10Y, Δ за ${I.window} дн.`, '--s-5y', EXPLAIN.baaRoc],
      ],
    }),
  },
  {
    tab: 'us', id: 'chart-margin-m2', source: SRC.margin, section: 'Плечо на рынке', title: 'Маржинальный долг к денежной массе M2',
    intro: 'Сколько денег инвесторы заняли у брокеров на покупку акций — в процентах от всей денежной массы. Данные FINRA есть с 1997 года; до 2010 года они охватывали только членов NYSE.',
    build: (I, tab) => ({
      data: [line(I.marginM2, 'Маржинальный долг / M2', '--s-2y', '%{y:.2f}% · долг %{customdata:,.0f} млрд $',
        { gap: 45, customdata: combine(I.marginM2, I.margin, (r, m) => m, monthKey).values })],
      layout: baseLayout(tab, { unit: '%' }),
      explain: [
        ['Маржинальный долг / M2', '--s-2y', EXPLAIN.marginM2],
        ['Маржинальный долг', '--s-2y', EXPLAIN.margin],
        ['M2', '--muted', EXPLAIN.m2],
      ],
    }),
  },
  {
    tab: 'us', id: 'chart-cap-margin', source: SRC.cap, title: 'Капитализация рынка к маржинальному долгу',
    intro: 'Во сколько раз стоимость всех американских акций больше долга, взятого на их покупку (в процентах: 7000% = в 70 раз). Чем ниже линия, тем сильнее рынок «на плече». Поквартально: капитализация из отчёта ФРС Z.1 — замена Wilshire 5000.',
    build: (I, tab) => ({
      data: [line(I.capMargin, 'Капитализация / маржинальный долг', '--s-30y', '%{y:,.0f}% · капитализация %{customdata:,.1f} трлн $',
        { gap: 100, customdata: combine(I.capMargin, I.cap, (r, c) => c / 1000, monthKey).values })],
      layout: baseLayout(tab, { unit: '%' }),
      explain: [
        ['Капитализация / маржинальный долг', '--s-30y', EXPLAIN.capMargin],
        ['Капитализация (ФРС Z.1)', '--s-30y', EXPLAIN.cap],
      ],
    }),
  },
  {
    tab: 'us', id: 'chart-indices', source: SRC.indices, section: 'Индексы акций', title: 'S&P 500 и NASDAQ Composite',
    intro: 'Логарифмическая шкала: одинаковое расстояние по вертикали — одинаковый процент изменения. Любой индекс можно наложить на остальные графики переключателем «Наложить индекс» сверху. S&P 500 до октября 2016 г. — среднемесячные значения (данные Шиллера), дальше — дневные с FRED.',
    log: true, noOverlay: true,
    build: (I, tab) => ({
      data: [
        line(I.sp500, 'S&P 500', '--s-10y', '%{y:,.0f}', { gap: 40 }),
        line(I.nasdaq, 'NASDAQ Composite', '--s-3m', '%{y:,.0f}', { gap: 40 }),
      ],
      layout: baseLayout(tab, { log: true }),
      explain: [['S&P 500', '--s-10y', EXPLAIN.sp500], ['NASDAQ Composite', '--s-3m', EXPLAIN.nasdaq]],
    }),
  },
  {
    tab: 'us', id: 'chart-tff-spx', source: SRC.tff, section: 'Позиционирование и настроения', title: 'Фьючерсы на S&P 500: лонги и шорты в деньгах (CFTC)',
    intro: 'Сколько денег каждая группа участников держит в длинных и коротких позициях во фьючерсах E-mini S&P 500, млрд $, еженедельно с 2006 года (отчёт CFTC Traders in Financial Futures). Разбивки на юрлиц и физлиц в американских данных нет — ближе всего к ней эти группы.',
    build: (I, tab) => ({
      data: TFF_GROUPS.flatMap((g) => longShortTraces(I.tffSpx[g.key], g.name, g.color, 'млрд $', { hidden: g.hidden, digits: 0 })),
      layout: baseLayout(tab),
      explain: [['Лонги и шорты', '--muted', EXPLAIN.tffMoney], ...TFF_GROUPS.map((g) => [g.name, g.color, EXPLAIN[g.explain]])],
    }),
  },
  {
    tab: 'us', id: 'chart-tff-ndx', source: SRC.tff, title: 'Фьючерсы на NASDAQ-100: лонги и шорты в деньгах (CFTC)',
    intro: 'То же для фьючерсов E-mini NASDAQ-100, млрд $. Технологический сектор чувствительнее к настроениям, поэтому изменения позиций здесь резче.',
    build: (I, tab) => ({
      data: TFF_GROUPS.flatMap((g) => longShortTraces(I.tffNdx[g.key], g.name, g.color, 'млрд $', { hidden: g.hidden, digits: 1 })),
      layout: baseLayout(tab),
      explain: [['Лонги и шорты', '--muted', EXPLAIN.tffMoney], ...TFF_GROUPS.map((g) => [g.name, g.color, EXPLAIN[g.explain]])],
    }),
  },
  {
    tab: 'us', id: 'chart-cot', source: SRC.cot, title: 'Чистые позиции во фьючерсах на S&P 500, % от открытого интереса (CFTC COT)',
    intro: 'Чистая позиция (покупки минус продажи) каждой группы в процентах от всех открытых контрактов E-mini S&P 500, еженедельно с 1997 года. В 1997–2000 годах контракт был маленьким, поэтому доли тогда сильно скачут.',
    includeZero: true,
    build: (I, tab) => ({
      data: [
        line(I.cotComm, 'Коммерческие (хеджеры)', '--s-30y', '%{y:+.1f}% ОИ'),
        line(I.cotNoncomm, 'Крупные спекулянты', '--s-5y', '%{y:+.1f}% ОИ'),
        line(I.cotSmall, 'Мелкие трейдеры', '--s-3m', '%{y:+.1f}% ОИ'),
      ],
      layout: baseLayout(tab, { unit: '%', zeroLine: true }),
      explain: [
        ['Коммерческие (хеджеры)', '--s-30y', EXPLAIN.cotComm],
        ['Крупные спекулянты', '--s-5y', EXPLAIN.cotNoncomm],
        ['Мелкие трейдеры', '--s-3m', EXPLAIN.cotSmall],
      ],
    }),
  },
  {
    tab: 'us', id: 'chart-putcall', source: SRC.putcall, title: 'Put/call ratio (CBOE)',
    intro: `Соотношение ставок на падение и на рост в опционах. Основные линии сглажены средним за ${PC_SMOOTH} торговый день; сырые дневные значения можно включить в легенде. По акциям — с 2006 года, по всем опционам — с 2003-го.`,
    build: (I, tab) => ({
      data: [
        line(I.pcEquityMa, `По акциям, ср. ${PC_SMOOTH} дн.`, '--s-2y', '%{y:.2f}'),
        line(I.pcTotalMa, `Все опционы, ср. ${PC_SMOOTH} дн.`, '--s-10y', '%{y:.2f}'),
        line(I.pcEquity, 'По акциям, дневной', '--s-2y', '%{y:.2f}', { visible: 'legendonly', line: { color: withAlpha('--s-2y', 0.45), width: 1 } }),
        line(I.pcTotal, 'Все опционы, дневной', '--s-10y', '%{y:.2f}', { visible: 'legendonly', line: { color: withAlpha('--s-10y', 0.45), width: 1 } }),
      ],
      layout: baseLayout(tab),
      explain: [
        ['По акциям', '--s-2y', EXPLAIN.pcEquity],
        ['Все опционы', '--s-10y', EXPLAIN.pcTotal],
        ['Дневные значения', '--muted', EXPLAIN.pcRaw],
      ],
    }),
  },
  {
    tab: 'us', id: 'chart-short', source: SRC.short, title: 'Short interest по индексным ETF (FINRA)',
    intro: 'Сколько паёв крупнейших индексных фондов продано в шорт, млн штук, дважды в месяц с конца 2017 года. Сводного short interest по всему рынку в бесплатном доступе нет, поэтому берём ETF как прокси: шорт в них — это ставки на падение рынка и хеджирование портфелей.',
    build: (I, tab) => {
      const etfs = [['SPY', '--s-10y'], ['QQQ', '--s-3m'], ['IWM', '--s-30y']];
      return {
        data: etfs.map(([t, c]) => {
          const { si, dtc } = I.si[t];
          return line(si, t, c, '%{y:.0f} млн · %{customdata:.1f} дн. на покрытие',
            { gap: 40, customdata: combine(si, dtc, (a, b) => b).values });
        }),
        layout: baseLayout(tab),
        explain: etfs.map(([t, c]) => [t, c, EXPLAIN[`si${t}`]]),
      };
    },
  },

  // ============================ Россия ============================
  {
    tab: 'ru', id: 'ru-rates', source: [...SRC.keyRate, ...SRC.ofz], section: 'Ставки и кривая ОФЗ', title: 'Ключевая ставка и доходности ОФЗ',
    intro: 'Ключевая ставка Банка России (с 2013 года) и доходности ОФЗ по кривой бескупонной доходности Мосбиржи (с 2014 года). Когда короткие ОФЗ доходнее длинных, рынок ждёт снижения ставки — обычно после периода жёсткой политики.',
    build: (I, tab) => ({
      data: [
        line(I.keyRate, 'Ключевая ставка', '--panic', '%{y:.2f}%', { line: { color: css('--panic'), width: 2.2, shape: 'hv' } }),
        ...OFZ.map((s) => line(I.ofz[s.id], s.name, s.color, '%{y:.2f}%')),
      ],
      layout: baseLayout(tab, { unit: '%' }),
      explain: [['Ключевая ставка', '--panic', EXPLAIN.keyRate], ...OFZ.map((s) => [s.name, s.color, EXPLAIN[s.id]])],
    }),
  },
  {
    tab: 'ru', id: 'ru-curve', source: SRC.ruCurve, title: 'Спреды кривой ОФЗ',
    intro: 'Наклон кривой ОФЗ. Ниже нуля — инверсия. В России она чаще всего означает, что ЦБ держит ставку выше рыночных ожиданий на будущее, чтобы сбить инфляцию, — это охлаждает экономику с задержкой.',
    includeZero: true,
    build: (I, tab) => ({
      data: [
        ...fillBelowZero(I.ruCurve, '--s-2y', 'ru2y'),
        ...fillBelowZero(I.ruCurveKey, '--panic', 'rukey'),
        line(I.ruCurve, 'ОФЗ 10Y − 2Y', '--s-2y', '%{y:+.0f} б.п.', { legendgroup: 'ru2y' }),
        line(I.ruCurveKey, 'ОФЗ 10Y − ключевая', '--panic', '%{y:+.0f} б.п.', { legendgroup: 'rukey' }),
      ],
      layout: baseLayout(tab, { zeroLine: true }),
      explain: [
        ['ОФЗ 10Y − 2Y', '--s-2y', EXPLAIN.ruCurve],
        ['ОФЗ 10Y − ключевая', '--panic', EXPLAIN.ruCurveKey],
        ['Заливка ниже нуля', '--panic', 'Периоды инверсии.'],
      ],
    }),
  },
  {
    tab: 'ru', id: 'ru-bonds', source: SRC.ruBonds, section: 'Кредитный риск', title: 'Доходности индексов облигаций Мосбиржи',
    intro: 'Средняя доходность к погашению государственных (RGBI) и корпоративных облигаций. Разрыв между ними — плата за риск компаний.',
    build: (I, tab) => ({
      data: [
        line(I.rgbiYield, 'ОФЗ (RGBI)', '--s-10y', '%{y:.2f}%'),
        line(I.corpYield, 'Корпоративные', '--s-3m', '%{y:.2f}%'),
      ],
      layout: baseLayout(tab, { unit: '%' }),
      explain: [['ОФЗ (RGBI)', '--s-10y', EXPLAIN.rgbiYield], ['Корпоративные', '--s-3m', EXPLAIN.corpYield]],
    }),
  },
  {
    tab: 'ru', id: 'ru-spread', source: [['расчёт по данным'], ...SRC.ruBonds], title: 'Спред корпоративных облигаций к ОФЗ',
    intro: 'Российский аналог кредитного спреда: насколько доходность корпоративного индекса выше доходности RGBI. Общепринятых порогов нет, поэтому зона на карточке — по перцентилю собственной истории.',
    build: (I, tab) => ({
      data: [line(I.ruSpread, 'Корпоративные − ОФЗ', '--s-5y', '%{y:+.0f} б.п.')],
      layout: baseLayout(tab, { zeroLine: true }),
      explain: [['Корпоративные − ОФЗ', '--s-5y', EXPLAIN.ruSpread]],
    }),
  },
  {
    tab: 'ru', id: 'ru-indices', source: SRC.ruIndices, section: 'Индексы', title: 'Индекс Мосбиржи и индекс РТС',
    intro: 'Логарифмическая шкала. IMOEX — в рублях, РТС — в долларах; расхождение линий показывает влияние курса рубля.',
    log: true, noOverlay: true,
    build: (I, tab) => ({
      data: [line(I.imoex, 'IMOEX', '--s-10y', '%{y:,.0f}'), line(I.rts, 'РТС', '--s-3m', '%{y:,.0f}')],
      layout: baseLayout(tab, { log: true }),
      explain: [['IMOEX', '--s-10y', EXPLAIN.imoex], ['РТС', '--s-3m', EXPLAIN.rts]],
    }),
  },
  {
    tab: 'ru', id: 'ru-rgbi', source: SRC.ruIndices, title: 'Индекс гособлигаций RGBI',
    intro: 'Ценовой индекс ОФЗ. Падение RGBI — рост доходностей: рынок ждёт более высокую ставку ЦБ или требует больше за риск.',
    build: (I, tab) => ({
      data: [line(I.rgbi, 'RGBI', '--s-30y', '%{y:.2f}')],
      layout: baseLayout(tab),
      explain: [['RGBI', '--s-30y', EXPLAIN.rgbi]],
    }),
  },
  {
    tab: 'ru', id: 'ru-fut-imoex', source: SRC.futoi, section: 'Позиции физлиц и юрлиц во фьючерсах', title: 'Фьючерсы на индекс Мосбиржи: лонги и шорты, млрд ₽',
    intro: 'Сумма по фьючерсам MX, MM (мини) и вечному IMOEXF. Мосбиржа публикует открытые позиции отдельно для физлиц и юрлиц — это та самая разбивка, которой нет в американских данных. Данные с 2020 года, на последний торговый день.',
    build: (I, tab) => ({
      data: [
        ...longShortTraces(I.futImoex.FIZ, 'Физлица', '--s-3m', 'млрд ₽'),
        ...longShortTraces(I.futImoex.YUR, 'Юрлица', '--s-10y', 'млрд ₽'),
      ],
      layout: baseLayout(tab),
      explain: [
        ['Лонги и шорты', '--muted', EXPLAIN.futMoney],
        ['Физлица', '--s-3m', EXPLAIN.futFiz],
        ['Юрлица', '--s-10y', EXPLAIN.futYur],
      ],
    }),
  },
  {
    tab: 'ru', id: 'ru-fut-net', source: SRC.futoi, title: 'Нетто-позиции физлиц во фьючерсах, млрд ₽',
    intro: 'Лонги минус шорты физлиц по каждому классу фьючерсов. Выше нуля — розница в среднем ставит на рост, ниже — на падение. Нетто юрлиц — та же линия с обратным знаком.',
    includeZero: true,
    build: (I, tab) => ({
      data: [
        line(I.futImoex.FIZ.net, 'Индекс Мосбиржи', '--s-10y', '%{y:+,.1f} млрд ₽'),
        line(I.futRts.FIZ.net, 'Индекс РТС', '--s-3m', '%{y:+,.1f} млрд ₽'),
        line(I.futRgbi.FIZ.net, 'Гособлигации RGBI', '--s-30y', '%{y:+,.1f} млрд ₽'),
      ],
      layout: baseLayout(tab, { zeroLine: true }),
      explain: [
        ['Нетто физлиц', '--muted', EXPLAIN.futFiz],
        ['Индекс Мосбиржи', '--s-10y', 'Фьючерсы MX + MM + IMOEXF.'],
        ['Индекс РТС', '--s-3m', 'Фьючерс RI; переведён в рубли по курсу ЦБ на дату.'],
        ['Гособлигации RGBI', '--s-30y', 'Фьючерс RB: лонг — ставка физлиц на рост цен ОФЗ (снижение ставок), шорт — на их падение.'],
      ],
    }),
  },
  {
    tab: 'ru', id: 'ru-fut-rts', source: SRC.futoi, title: 'Фьючерс на индекс РТС: лонги и шорты, млрд ₽',
    intro: 'Исторически самый ликвидный фьючерс Мосбиржи. Стоимость контракта — 2 $ за пункт индекса, в рубли переведена по курсу ЦБ на дату.',
    build: (I, tab) => ({
      data: [
        ...longShortTraces(I.futRts.FIZ, 'Физлица', '--s-3m', 'млрд ₽'),
        ...longShortTraces(I.futRts.YUR, 'Юрлица', '--s-10y', 'млрд ₽'),
      ],
      layout: baseLayout(tab),
      explain: [
        ['Лонги и шорты', '--muted', EXPLAIN.futMoney],
        ['Физлица', '--s-3m', EXPLAIN.futFiz],
        ['Юрлица', '--s-10y', EXPLAIN.futYur],
      ],
    }),
  },
  {
    tab: 'ru', id: 'ru-fut-rgbi', title: 'Фьючерс на индекс гособлигаций RGBI: лонги и шорты, млрд ₽',
    intro: 'Позиции по фьючерсу на RGBI (данные с 2022 года). Лонг — ставка на рост цен ОФЗ, то есть на снижение ставок; шорт — на рост ставок.',
    build: (I, tab) => ({
      data: [
        ...longShortTraces(I.futRgbi.FIZ, 'Физлица', '--s-3m', 'млрд ₽', { digits: 2 }),
        ...longShortTraces(I.futRgbi.YUR, 'Юрлица', '--s-10y', 'млрд ₽', { digits: 2 }),
      ],
      layout: baseLayout(tab),
      explain: [
        ['Лонги и шорты', '--muted', EXPLAIN.futMoney],
        ['Физлица', '--s-3m', EXPLAIN.futFiz],
        ['Юрлица', '--s-10y', EXPLAIN.futYur],
      ],
    }),
  },
  {
    tab: 'ru', id: 'ru-fut-accounts', source: SRC.futoi, title: 'Число физлиц в лонге и шорте по фьючерсам на индекс Мосбиржи',
    intro: 'Сколько счетов физлиц держат длинные и короткие позиции (сумма по MX, MM и IMOEXF; человек с позициями в нескольких контрактах считается несколько раз).',
    build: (I, tab) => ({
      data: [
        line(I.accImoexL, 'Счетов в лонге', '--calm', '%{y:,.0f}'),
        line(I.accImoexS, 'Счетов в шорте', '--panic', '%{y:,.0f}'),
      ],
      layout: baseLayout(tab),
      explain: [['Счета в лонге и шорте', '--muted', EXPLAIN.accounts]],
    }),
  },
  {
    tab: 'ru', id: 'ru-budget-flows', source: SRC.budget, section: 'Федеральный бюджет',
    title: 'Доходы и расходы федерального бюджета за 12 месяцев, трлн ₽',
    intro: 'Скользящие суммы за последние 12 месяцев по данным Минфина (с 2011 года). Разрыв между расходами и доходами — дефицит бюджета.',
    build: (I, tab) => ({
      data: [
        line(I.budExp12, 'Расходы', '--panic', '%{y:.1f} трлн ₽', { gap: 45 }),
        line(I.budRev12, 'Доходы', '--s-10y', '%{y:.1f} трлн ₽', { gap: 45 }),
        line(I.budNonoil12, 'Ненефтегазовые доходы', '--s-30y', '%{y:.1f} трлн ₽', { gap: 45 }),
        line(I.budOil12, 'Нефтегазовые доходы', '--s-3m', '%{y:.1f} трлн ₽', { gap: 45 }),
      ],
      layout: baseLayout(tab),
      explain: [
        ['Расходы', '--panic', EXPLAIN.budExp], ['Доходы', '--s-10y', EXPLAIN.budRev],
        ['Ненефтегазовые доходы', '--s-30y', EXPLAIN.budNonoil], ['Нефтегазовые доходы', '--s-3m', EXPLAIN.budOil],
      ],
    }),
  },
  {
    tab: 'ru', id: 'ru-budget-balance', source: SRC.budget, title: 'Дефицит (−) и профицит федерального бюджета, трлн ₽',
    intro: 'Сколько бюджет тратит сверх доходов. Основная линия — сумма за 12 месяцев (в подсказке — оценка в % ВВП); пунктир — нарастающий итог с начала года, как его публикует Минфин.',
    includeZero: true,
    build: (I, tab) => ({
      data: [
        ...fillBelowZero(I.budBal12, '--panic', 'bal12'),
        line(I.budBal12, 'За 12 месяцев', '--panic', '%{y:+.2f} трлн ₽ · %{customdata:+.1f}% ВВП',
          { gap: 45, legendgroup: 'bal12', customdata: asof(I.budBal12, I.budBal12Gdp, (a, b) => b).values }),
        line(I.budNonoilBal12, 'Ненефтегазовый, за 12 месяцев', '--s-5y', '%{y:+.1f} трлн ₽', { gap: 45 }),
        line(I.budBalYtd, 'С начала года', '--muted', '%{y:+.2f} трлн ₽', { gap: 45, dash: 'dot' }),
      ],
      layout: baseLayout(tab, { zeroLine: true }),
      explain: [
        ['За 12 месяцев', '--panic', `${EXPLAIN.budBal} ${EXPLAIN.budGdp}`],
        ['Ненефтегазовый дефицит', '--s-5y', EXPLAIN.budNonoilBal],
        ['С начала года', '--muted', EXPLAIN.budYtd],
      ],
    }),
  },
  {
    tab: 'ru', id: 'ru-nwf', source: SRC.nwf, title: 'Фонд национального благосостояния, трлн ₽',
    intro: 'Весь объём ФНБ и его ликвидная часть — то, что можно быстро потратить на покрытие дефицита. Помесячно с 2008 года.',
    build: (I, tab) => ({
      data: [
        line(I.nwfLiquid, 'Ликвидная часть', '--s-30y', '%{y:.2f} трлн ₽',
          { gap: 45, fill: 'tozeroy', fillcolor: withAlpha('--s-30y', 0.25) }),
        line(I.nwfTotal, 'Весь фонд', '--s-10y', '%{y:.2f} трлн ₽ · %{customdata:.1f}% ВВП',
          { gap: 45, customdata: combine(I.nwfTotal, I.nwfGdp, (a, b) => b, monthKey).values }),
      ],
      layout: baseLayout(tab),
      explain: [['Весь фонд', '--s-10y', EXPLAIN.nwf], ['Ликвидная часть', '--s-30y', EXPLAIN.nwfLiquid]],
    }),
  },
  {
    tab: 'ru', id: 'ru-defense', source: SRC.defense, title: 'Расходы на оборону по годам, трлн ₽',
    intro: 'Официальные данные Минфина по разделу «Национальная оборона» есть только до 2021 года — с 2022 года разбивка расходов закрыта. Для последних лет — независимая оценка SIPRI, которая шире бюджетного раздела.',
    includeZero: true,
    build: (I, tab) => {
      const built = {
        data: [
          bars(I.defenseMinfin, 'Минфин: «Национальная оборона»', '--s-10y', '%{y:.2f} трлн ₽'),
          bars(I.defenseSipri, 'Оценка SIPRI', '--s-3m', '%{y:.2f} трлн ₽'),
        ],
        layout: baseLayout(tab),
        explain: [['Минфин', '--s-10y', EXPLAIN.defenseMinfin], ['Оценка SIPRI', '--s-3m', EXPLAIN.defenseSipri]],
      };
      built.layout.barmode = 'group';
      return built;
    },
  },
  {
    tab: 'ru', id: 'ru-defense-share', source: SRC.sipri, title: 'Военные расходы: доля в ВВП и в госрасходах (SIPRI), %',
    intro: 'Какая часть экономики и государственных расходов уходит на оборону, по годам.',
    build: (I, tab) => ({
      data: [
        line(I.sipriGdp, '% ВВП', '--s-2y', '%{y:.1f}%', { gap: 400, mode: 'lines+markers' }),
        line(I.sipriGov, '% всех госрасходов', '--s-5y', '%{y:.1f}%', { gap: 400, mode: 'lines+markers' }),
      ],
      layout: baseLayout(tab, { unit: '%' }),
      explain: [['Доля в ВВП и госрасходах', '--muted', EXPLAIN.sipriShare]],
    }),
  },
];

// ---------------------------------------------------------------------------
// Другие страны и недвижимость: общий шаблон вкладки
// ---------------------------------------------------------------------------

/*
 * Каждая страна описана конфигурацией COUNTRIES: какие ряды — ставки, длинные доходности,
 * наклоны кривой, индекс акций, курс, недвижимость. По ней строятся графики (countryCharts),
 * карточки (countryCards) и расчёты (computeCountry). Раздел «Недвижимость» тем же
 * шаблоном добавляется и во вкладки США и России (REAL_ESTATE).
 */

const BIS_SRC = (c) => [fred(`Q${c}N628BIS`, 'BIS: цены на жильё (FRED)'), fred(`Q${c}R628BIS`, 'реальные'),
  ['BIS Residential property prices', 'https://data.bis.org/topics/RPP']];
const BIS_DEBT_SRC = (c) => [fred(`Q${c}HAM770A`, 'BIS: долг домохозяйств, % ВВП (FRED)'),
  ['BIS Total credit', 'https://data.bis.org/topics/TOTAL_CREDIT']];

Object.assign(SRC, {
  boe: [['Банк Англии: база данных IADB', 'https://www.bankofengland.co.uk/boeapps/database/']],
  jgb: [['Минфин Японии: доходности JGB', 'https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/index.htm']],
  sse: [['Шанхайская биржа: SSE Composite', 'https://english.sse.com.cn/markets/indices/overview/']],
  ecbMir: [['ЕЦБ: ставки по новым кредитам (MIR)', 'https://data.ecb.europa.eu/data/datasets/MIR']],
  hkma: [['HKMA: денежная статистика', 'https://www.hkma.gov.hk/eng/data-publications-and-research/data-and-statistics/']],
  esri: [['Кабинет министров Японии (ESRI): даты деловых циклов', 'https://www.esri.cao.go.jp/en/stat/di/di-e.html']],
});

// Официальные даты спадов Японии (от пика до дна, ESRI). Последние годы могут быть ещё не датированы.
const JP_CYCLES = [
  ['1973-11-01', '1975-03-01'], ['1977-01-01', '1977-10-01'], ['1980-02-01', '1983-02-01'],
  ['1985-06-01', '1986-11-01'], ['1991-02-01', '1993-10-01'], ['1997-05-01', '1999-01-01'],
  ['2000-11-01', '2002-01-01'], ['2008-02-01', '2009-03-01'], ['2012-03-01', '2012-11-01'],
  ['2018-10-01', '2020-05-01'],
];

/** Технические рецессии: два и более квартала подряд падения реального ВВП. */
function technicalRecessions(gdp) {
  const periods = [];
  let start = null, run = 0;
  for (let i = 1; i < gdp.values.length; i++) {
    if (gdp.values[i] < gdp.values[i - 1]) {
      if (!run) start = gdp.dates[i];
      run++;
    } else {
      if (run >= 2) periods.push([start, gdp.dates[i]]);
      run = 0;
    }
  }
  if (run >= 2) periods.push([start, addMonths(gdp.dates[gdp.dates.length - 1], 3)]);
  return periods;
}

const GDP_BANDS_EXPLAIN = 'Серые полосы — технические рецессии: два и более квартала подряд падения реального ВВП (официальной датировки, как NBER в США, нет).';

// Справки о кризисах на рынке жилья (общеизвестные события; точные цифры — на графике BIS).
const HOUSING_STORY = {
  us: 'Крупнейший кризис — 2006–2012 годы: после бума ипотеки для заёмщиков с плохой кредитной историей цены на жильё упали примерно на четверть от пика 2006 года, волна дефолтов обрушила банки и вызвала мировой кризис 2008 года. После 2020 года цены снова резко выросли на дешёвой ипотеке; с 2022 года ставка по 30-летней ипотеке поднялась примерно до 7%, и сделок стало заметно меньше.',
  ru: 'В 2008–2009 годах цены на жильё снижались — в долларах сильнее, чем в рублях. В 2014–2016 годах после девальвации рубля реальные цены (с поправкой на инфляцию) падали несколько лет. С 2020 года рынок рос на льготной ипотеке с государственной субсидией ставки; в июле 2024 года массовая льготная программа завершилась, и при высокой ключевой ставке рыночная ипотека стала очень дорогой — спрос сместился на семейную ипотеку.',
  fr: 'В начале 1990-х после спекулятивного роста цены на жильё во Франции, особенно в Париже, снижались несколько лет подряд — в Париже примерно на треть. Затем был долгий рост до 2008 года, небольшая коррекция в 2008–2009 годах и снова рост до 2022 года. С 2022 года после повышения ставок ЕЦБ ипотека подорожала примерно с 1% до 4%, и цены впервые за долгое время пошли вниз.',
  uk: 'В 1989–1995 годах после бума цены упали примерно на 20% в номинале и сильнее в реальном выражении; сотни тысяч семей оказались должны банку больше, чем стоил их дом. В 2007–2009 годах падение тоже было около 20%. Осенью 2022 года после «мини-бюджета» правительства ставки по ипотеке резко выросли и охладили рынок. Большинство британских ипотек — с фиксированной ставкой на 2–5 лет, поэтому рост ставок доходит до заёмщиков с задержкой, при перекредитовании.',
  jp: 'Классический пример лопнувшего пузыря: в конце 1980-х цены на землю и жильё выросли в разы, а после 1991 года падали около 15 лет подряд — в крупных городах цены на землю снизились в несколько раз. Банки годами сидели на плохих кредитах, экономика пережила «потерянное десятилетие» с дефляцией. В 2010–2020-х на сверхнизких ставках цены в Токио снова выросли; с 2024 года Банк Японии начал повышать ставку.',
  cn: 'Недвижимость — крупнейшая отрасль Китая: вместе со смежными отраслями, по оценкам, около четверти ВВП. В 2020 году власти ограничили долги застройщиков («три красные линии»), в 2021 году объявил дефолт Evergrande, затем Country Garden и другие. Продажи новых квартир и цены снижаются с 2021–2022 годов, часть оплаченных квартир не достроена. Власти снижали ставки и первоначальные взносы, но спрос восстанавливается медленно.',
  hk: 'Один из самых дорогих и волатильных рынков жилья в мире: после азиатского кризиса 1997 года и эпидемии SARS цены к 2003 году упали примерно на две трети. Затем был долгий рост почти в шесть раз до 2021 года. С 2021–2022 годов цены снижаются: ставки HIBOR выросли вслед за ставкой ФРС (гонконгский доллар привязан к доллару США), часть жителей уехала. Ипотека здесь в основном плавающая, привязанная к HIBOR, поэтому рост ставок быстро бьёт по заёмщикам.',
};

/*
 * Конфигурация стран. Поля:
 *   rates   — линии на графике ставок: { id, name, color, step? (ступенчатая — ключевая ставка), src }
 *   curves  — наклоны кривой: { a, b, name, color } (a − b, б.п.; b берётся «на дату»)
 *   equity  — индекс акций { id, name, log?, src, monthly? }
 *   fx      — курс { id, invert? (ряд — долларов за единицу валюты), name, unit, band? (коридор привязки) }
 *   bis     — код страны в рядах BIS; mortgage — ипотечные ставки; bands — полосы рецессий
 */
const COUNTRIES = [
  {
    tab: 'fr', name: 'Франция', cur: 'евро',
    rates: [
      { id: 'ECBDFR', name: 'Депозитная ставка ЕЦБ', color: '--panic', step: true, src: [fred('ECBDFR')] },
      { id: 'IR3TIB01FRM156N', name: '3 месяца (межбанк)', color: '--s-3m', src: [fred('IR3TIB01FRM156N')] },
      { id: 'IRLTLT01FRM156N', name: '10-летние OAT', color: '--s-10y', src: [fred('IRLTLT01FRM156N')] },
      { id: 'IRLTLT01DEM156N', name: '10-летние Bund (Германия)', color: '--s-30y', src: [fred('IRLTLT01DEM156N')] },
    ],
    curves: [{ a: 'IRLTLT01FRM156N', b: 'IR3TIB01FRM156N', name: '10 лет − 3 месяца', color: '--s-3m' }],
    risk: { a: 'IRLTLT01FRM156N', b: 'IRLTLT01DEM156N', name: 'OAT − Bund' },
    equity: { id: 'SPASTT01FRM661N', name: 'Акции Франции (индекс ОЭСР, 2015 = 100)', short: 'Акции Франции', src: [fred('SPASTT01FRM661N')], monthly: true },
    fx: { id: 'DEXUSEU', invert: true, name: 'Евро за 1 доллар', unit: '€', src: [fred('DEXUSEU')] },
    bis: 'FR',
    mortgage: [{ id: 'FR_MORTGAGE', name: 'Ставка по новой ипотеке', color: '--s-2y', src: SRC.ecbMir }],
    bands: { kind: 'gdp', id: 'CLVMNACSCAB1GQFR', src: [fred('CLVMNACSCAB1GQFR', 'реальный ВВП Франции (FRED)')] },
  },
  {
    tab: 'uk', name: 'Великобритания', cur: 'фунт',
    rates: [
      { id: 'BOE_IUDBEDR', name: 'Ключевая ставка Банка Англии', color: '--panic', step: true, src: SRC.boe },
      { id: 'BOE_IUDSNZC', name: 'Гилты 5 лет', color: '--s-2y', src: SRC.boe },
      { id: 'BOE_IUDMNZC', name: 'Гилты 10 лет', color: '--s-10y', src: SRC.boe },
      { id: 'BOE_IUDLNZC', name: 'Гилты 20 лет', color: '--s-30y', src: SRC.boe },
    ],
    curves: [
      { a: 'BOE_IUDMNZC', b: 'BOE_IUDBEDR', name: '10 лет − ключевая ставка', color: '--panic' },
      { a: 'BOE_IUDMNZC', b: 'BOE_IUDSNZC', name: '10 лет − 5 лет', color: '--s-2y' },
    ],
    equity: { id: 'SPASTT01GBM661N', name: 'Акции Великобритании (индекс ОЭСР, 2015 = 100)', short: 'Акции Великобритании', src: [fred('SPASTT01GBM661N')], monthly: true },
    fx: { id: 'DEXUSUK', invert: true, name: 'Фунтов за 1 доллар', unit: '£', src: [fred('DEXUSUK')] },
    bis: 'GB',
    mortgage: [
      { id: 'BOE_IUMBV34', name: '2-летняя фиксированная (LTV 75%)', color: '--s-2y', src: SRC.boe },
      { id: 'BOE_CFMHSDE', name: 'Эффективная ставка по новой ипотеке', color: '--s-10y', src: SRC.boe },
    ],
    bands: { kind: 'gdp', id: 'NGDPRSAXDCGBQ', src: [fred('NGDPRSAXDCGBQ', 'реальный ВВП Великобритании (FRED)')] },
  },
  {
    tab: 'jp', name: 'Япония', cur: 'иена',
    rates: [
      { id: 'IRSTCI01JPM156N', name: 'Ставка овернайт (ориентир Банка Японии)', color: '--panic', step: true, src: [fred('IRSTCI01JPM156N')] },
      { id: 'JGB_2Y', name: 'JGB 2 года', color: '--s-2y', src: SRC.jgb },
      { id: 'JGB_10Y', name: 'JGB 10 лет', color: '--s-10y', src: SRC.jgb },
      { id: 'JGB_30Y', name: 'JGB 30 лет', color: '--s-30y', src: SRC.jgb },
    ],
    curves: [
      { a: 'JGB_10Y', b: 'JGB_2Y', name: '10 лет − 2 года', color: '--s-2y' },
      { a: 'JGB_10Y', b: 'IRSTCI01JPM156N', name: '10 лет − ставка овернайт', color: '--panic' },
    ],
    equity: { id: 'NIKKEI225', name: 'Nikkei 225', short: 'Nikkei 225', src: [fred('NIKKEI225')], log: true },
    fx: { id: 'DEXJPUS', name: 'Иен за 1 доллар', unit: '¥', src: [fred('DEXJPUS')] },
    bis: 'JP',
    bands: { kind: 'fixed', periods: JP_CYCLES, legend: 'Спады (ESRI)', src: SRC.esri,
      explain: 'Серые полосы — официальные спады экономики Японии по датировке Кабинета министров (ESRI), от пика до дна делового цикла. Последние годы могут быть ещё не датированы.' },
  },
  {
    tab: 'cn', name: 'Китай', cur: 'юань',
    rates: [{ id: 'IR3TIB01CNM156N', name: '3 месяца (межбанк)', color: '--s-3m', src: [fred('IR3TIB01CNM156N')] }],
    curves: [],
    equity: { id: 'SSE_COMP', name: 'SSE Composite (Шанхай)', short: 'SSE Composite', src: SRC.sse, log: true },
    fx: { id: 'DEXCHUS', name: 'Юаней за 1 доллар', unit: '¥', src: [fred('DEXCHUS')] },
    bis: 'CN',
    bands: { kind: 'none', explain: 'Реальный ВВП Китая в официальной статистике годами не снижался (даже в 2020 году был небольшой рост), поэтому полос рецессий нет; признаки спада видны по ценам на жильё, индексу акций и юаню.' },
    note: 'Бесплатных ежедневных данных по доходностям китайских гособлигаций в открытом доступе не нашлось, поэтому кривой доходности здесь нет.',
  },
  {
    tab: 'hk', name: 'Гонконг', cur: 'гонконгский доллар',
    rates: [
      { id: 'HK_BASE', name: 'Базовая ставка HKMA', color: '--panic', step: true, src: SRC.hkma },
      { id: 'HK_HIBOR_ON', name: 'HIBOR овернайт', color: '--s-3m', src: SRC.hkma },
      { id: 'HK_HIBOR_1M', name: 'HIBOR 1 месяц', color: '--s-10y', src: SRC.hkma },
    ],
    curves: [],
    fx: { id: 'DEXHKUS', name: 'Гонконгских долларов за 1 доллар США', unit: 'HK$', src: [fred('DEXHKUS')], band: [7.75, 7.85] },
    bis: 'HK',
    mortgage: [{ id: 'HK_HIBOR_1M', name: 'HIBOR 1 месяц — база для ипотеки', color: '--s-2y', src: SRC.hkma }],
    bands: { kind: 'none', explain: 'Бесплатного квартального ряда ВВП Гонконга в доступных источниках нет, поэтому полос рецессий нет.' },
    note: 'Бесплатного источника индекса Hang Seng не нашлось (биржевые сайты закрыты от автоматической загрузки), поэтому графика акций здесь нет.',
  },
];

// Недвижимость для вкладок США и России — тем же шаблоном.
const REAL_ESTATE = {
  us: { bis: 'US', mortgage: [{ id: 'MORTGAGE30US', name: '30-летняя фиксированная ипотека', color: '--s-2y', src: [fred('MORTGAGE30US')] }] },
  ru: { bis: 'RU', fx: { id: 'CBR_USDRUB', name: 'Рублей за 1 доллар', unit: '₽', src: [['Банк России: курс доллара', 'https://www.cbr.ru/currency_base/dynamics/']] } },
};

const COUNTRY = Object.fromEntries(COUNTRIES.map((c) => [c.tab, c]));

// Полосы, наложение индекса и привязка карточек к графикам — для каждой страны.
for (const c of COUNTRIES) {
  const b = c.bands;
  TAB_BANDS[c.tab] = {
    legend: b.legend || 'Рецессии', explain: `bands_${c.tab}`,
    source: b.src || [['полос нет']],
  };
  EXPLAIN[`bands_${c.tab}`] = b.explain || GDP_BANDS_EXPLAIN;
  OVERLAYS[c.tab] = [['', 'нет'], ...(c.equity ? [['eq', c.equity.short]] : [])];
}
OVERLAYS.ru = [...OVERLAYS.ru];

// Зона цен на жильё — по падению реальных цен от их исторического пика.
const RE_ZONES = [
  { max: -30, label: 'Ниже пика на 30% и больше', color: '--panic' },
  { max: -15, label: 'Ниже пика на 15–30%', color: '--stress' },
  { max: -5, label: 'Ниже пика на 5–15%', color: '--caution' },
  { max: Infinity, label: 'Около пика', color: '--calm' },
];

/** Расчёты по стране (или по разделу «Недвижимость» США/России). */
function computeCountry(c) {
  const get = (id) => series(id);
  const out = {};
  for (const r of c.rates || []) out[r.id] = get(r.id);
  out.curves = (c.curves || []).map((cv) => asof(get(cv.a), get(cv.b), (x, y) => Math.round((x - y) * 100)));
  if (c.risk) out.risk = asof(get(c.risk.a), get(c.risk.b), (x, y) => Math.round((x - y) * 100));
  if (c.equity) {
    out.equity = get(c.equity.id);
    out.equityDd = drawdown(out.equity);
  }
  if (c.fx) out.fx = c.fx.invert ? mapValues(get(c.fx.id), (v) => 1 / v) : get(c.fx.id);
  if (c.bis) {
    out.houseNom = get(`Q${c.bis}N628BIS`);
    out.houseReal = get(`Q${c.bis}R628BIS`);
    out.houseNomYoY = yearOverYear(out.houseNom);
    out.houseRealYoY = yearOverYear(out.houseReal);
    out.houseRealDd = drawdown(out.houseReal);
    out.hhDebt = get(`Q${c.bis}HAM770A`);
  }
  for (const m of c.mortgage || []) out[m.id] = get(m.id);
  if (c.bands) {
    out.bands = c.bands.kind === 'gdp' ? technicalRecessions(get(c.bands.id))
      : c.bands.kind === 'fixed' ? c.bands.periods : [];
  }
  return out;
}

/** Графики раздела «Недвижимость» (общие для всех стран). */
function realEstateCharts(tab, cfg, name, cid) {
  const D = (I) => (COUNTRY[tab] ? I.c[tab] : I.re[tab]);
  const charts = [{
    tab, id: `${cid}-house`, section: 'Недвижимость', source: BIS_SRC(cfg.bis),
    title: `Цены на жильё: ${name} (BIS, индекс 2010 = 100)`,
    intro: 'Номинальные цены — как в объявлениях; реальные — с поправкой на инфляцию, то есть сколько жильё стоит в «сегодняшних» деньгах. Поквартально, данные Банка международных расчётов.',
    story: HOUSING_STORY[tab],
    build: (I, t) => ({
      data: [
        line(D(I).houseNom, 'Номинальные', '--s-10y', '%{y:.1f}', { gap: 100 }),
        line(D(I).houseReal, 'Реальные (с поправкой на инфляцию)', '--s-3m', '%{y:.1f}', { gap: 100 }),
      ],
      layout: baseLayout(t),
      explain: [
        ['Номинальные', '--s-10y', 'Индекс цен на жильё в местной валюте (2010 год = 100).'],
        ['Реальные', '--s-3m', 'Тот же индекс с поправкой на инфляцию: падение реальных цен при росте номинальных значит, что жильё дешевеет относительно остальных товаров.'],
      ],
    }),
  }, {
    tab, id: `${cid}-houseyoy`, source: BIS_SRC(cfg.bis), title: `Цены на жильё: изменение за год, %`,
    intro: 'Насколько цены выросли или упали за последние 12 месяцев. Уход реальных цен ниже нуля на несколько кварталов подряд — типичная картина охлаждения или кризиса рынка жилья.',
    includeZero: true,
    build: (I, t) => ({
      data: [
        ...fillBelowZero(D(I).houseRealYoY, '--panic', 'ryoy'),
        line(D(I).houseNomYoY, 'Номинальные', '--s-10y', '%{y:+.1f}%', { gap: 100 }),
        line(D(I).houseRealYoY, 'Реальные', '--s-3m', '%{y:+.1f}%', { gap: 100, legendgroup: 'ryoy' }),
      ],
      layout: baseLayout(t, { unit: '%', zeroLine: true }),
      explain: [['Изменение за год', '--muted', 'Темп роста цен за 12 месяцев; заливка — периоды, когда реальные цены падали.']],
    }),
  }, {
    tab, id: `${cid}-hhdebt`, source: BIS_DEBT_SRC(cfg.bis), title: 'Долг домохозяйств, % ВВП (BIS)',
    intro: 'Все кредиты населения — в основном ипотека — в процентах от ВВП. Быстрый рост долга вместе с ценами на жильё — главный признак кредитного пузыря; после кризисов долг обычно годами сокращается.',
    build: (I, t) => ({
      data: [line(D(I).hhDebt, 'Долг домохозяйств', '--s-5y', '%{y:.1f}% ВВП', { gap: 100 })],
      layout: baseLayout(t, { unit: '%' }),
      explain: [['Долг домохозяйств', '--s-5y', 'Кредиты населения и некоммерческих организаций, обслуживающих домохозяйства, в % ВВП (BIS, с поправкой на разрывы в статистике).']],
    }),
  }];
  if (cfg.mortgage && cfg.mortgage.length) {
    charts.push({
      tab, id: `${cid}-mortgage`, source: cfg.mortgage.flatMap((m) => m.src), title: 'Ставки по ипотеке, %',
      intro: tab === 'hk'
        ? 'В Гонконге ипотека в основном плавающая и привязана к HIBOR, поэтому именно HIBOR определяет платежи заёмщиков.'
        : 'Чем выше ставка, тем меньше покупатели могут занять и тем сильнее давление на цены жилья.',
      build: (I, t) => ({
        data: cfg.mortgage.map((m) => line(D(I)[m.id], m.name, m.color, '%{y:.2f}%', { gap: 45 })),
        layout: baseLayout(t, { unit: '%' }),
        explain: cfg.mortgage.map((m) => [m.name, m.color, 'Средняя ставка по ипотечным кредитам.']),
      }),
    });
  }
  return charts;
}

/** Все графики вкладки страны. */
function countryCharts(c) {
  const t = c.tab;
  const charts = [{
    tab: t, id: `${t}-rates`, section: 'Ставки и кривая доходности', source: c.rates.flatMap((r) => r.src),
    title: `Ставки: ${c.name}`,
    intro: c.curves.length || c.risk
      ? 'Ключевая ставка центробанка и доходности гособлигаций. Когда короткие ставки поднимаются выше длинных, рынок закладывает будущее снижение ставок — обычно из-за ожидаемого замедления.'
      : 'Ставки денежного рынка — цена коротких денег в экономике.' + (c.note ? ` ${c.note}` : ''),
    build: (I, tb) => ({
      data: c.rates.map((r) => line(I.c[t][r.id], r.name, r.color, '%{y:.2f}%',
        r.step ? { gap: 45, line: { color: css(r.color), width: 2.2, shape: 'hv' } } : { gap: 45 })),
      layout: baseLayout(tb, { unit: '%' }),
      explain: c.rates.map((r) => [r.name, r.color, r.step ? 'Ставка центробанка — главный инструмент денежной политики.' : 'Рыночная доходность.']),
    }),
  }];
  if (c.curves.length) {
    charts.push({
      tab: t, id: `${t}-curve`, source: c.rates.flatMap((r) => r.src), title: 'Наклон кривой доходности, б.п.',
      intro: 'Разница между длинными и короткими ставками. Ниже нуля — инверсия: рынок ждёт снижения ставок, что исторически часто предшествовало рецессиям.',
      includeZero: true,
      build: (I, tb) => ({
        data: c.curves.flatMap((cv, k) => [
          ...fillBelowZero(I.c[t].curves[k], cv.color, `cv${k}`),
          line(I.c[t].curves[k], cv.name, cv.color, '%{y:+.0f} б.п.', { gap: 45, legendgroup: `cv${k}` }),
        ]),
        layout: baseLayout(tb, { zeroLine: true }),
        explain: c.curves.map((cv) => [cv.name, cv.color, 'Ниже нуля — инверсия кривой.']),
      }),
    });
  }
  if (c.risk) {
    charts.push({
      tab: t, id: `${t}-risk`, source: [fred(c.risk.a), fred(c.risk.b)], title: 'Спред OAT − Bund: премия за риск Франции, б.п.',
      intro: 'Насколько Франция платит по 10-летнему долгу больше Германии. Рост спреда — сигнал, что инвесторы сомневаются в бюджете Франции или в устойчивости еврозоны (как в 2011–2012 годах).',
      build: (I, tb) => ({
        data: [line(I.c[t].risk, c.risk.name, '--s-5y', '%{y:+.0f} б.п.', { gap: 45 })],
        layout: baseLayout(tb, { zeroLine: true }),
        explain: [[c.risk.name, '--s-5y', 'Разница доходностей 10-летних облигаций Франции и Германии.']],
      }),
    });
  }
  if (c.equity || c.fx) charts.push(...[
    c.equity && {
      tab: t, id: `${t}-equity`, section: 'Рынок акций и валюта', source: c.equity.src, title: c.equity.name,
      intro: (c.equity.monthly ? 'Помесячно (индекс ОЭСР). ' : '') + 'Рынок акций обычно начинает падать раньше официального спада экономики.',
      log: true, noOverlay: true,
      build: (I, tb) => ({
        data: [line(I.c[t].equity, c.equity.short, '--s-10y', '%{y:,.0f}', { gap: 45 })],
        layout: baseLayout(tb, { log: true }),
        explain: [[c.equity.short, '--s-10y', EXPLAIN.drawdown]],
      }),
    },
    c.fx && {
      tab: t, id: `${t}-fx`, section: c.equity ? undefined : 'Валюта', source: c.fx.src, title: `Курс: ${c.fx.name.toLowerCase()}`,
      intro: c.fx.band
        ? 'Гонконгский доллар привязан к доллару США: курс держится в коридоре 7,75–7,85 (цветная полоса), поэтому ставки в Гонконге следуют за ставками ФРС.'
        : `Сколько ${c.fx.name.split(' ')[0].toLowerCase()} стоит один доллар США. Рост — местная валюта слабеет: импорт дорожает, а бегство капитала в кризис обычно сопровождается резким ослаблением.`,
      build: (I, tb) => ({
        data: [line(I.c[t].fx, c.fx.name, '--s-30y', `%{y:,.${c.fx.band ? 4 : 3}f} ${c.fx.unit}`)],
        layout: baseLayout(tb, c.fx.band ? { shapes: [{ type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: c.fx.band[0], y1: c.fx.band[1], fillcolor: withAlpha('--calm', 0.12), line: { width: 0 }, layer: 'below' }] } : {}),
        explain: [[c.fx.name, '--s-30y', 'Официальный курс (ФРС США, данные с задержкой около недели).']],
      }),
    },
  ].filter(Boolean));
  charts.push(...realEstateCharts(t, c, c.name, t));
  return charts;
}

// Добавляем графики стран и разделы «Недвижимость» в США и Россию.
CHARTS.push(...realEstateCharts('us', REAL_ESTATE.us, 'США', 'us'));
CHARTS.push({
  tab: 'ru', id: 'ru-fx', section: 'Валюта', source: REAL_ESTATE.ru.fx.src, title: 'Курс: рублей за 1 доллар',
  intro: 'Официальный курс Банка России. Рост — рубль слабеет: импорт дорожает, а резкие скачки (2008, 2014, 2022) совпадали с кризисами.',
  build: (I, tb) => ({
    data: [line(I.re.ru.fx, 'Рублей за 1 доллар', '--s-30y', '%{y:,.2f} ₽')],
    layout: baseLayout(tb),
    explain: [['Курс доллара', '--s-30y', 'Официальный курс ЦБ, ежедневно.']],
  }),
});
CHARTS.push(...realEstateCharts('ru', REAL_ESTATE.ru, 'Россия', 'ru'));
for (const c of COUNTRIES) CHARTS.push(...countryCharts(c));

/** Карточки раздела «Недвижимость». */
function realEstateCards(D, cfg, cid) {
  const cards = [];
  const ry = last(D.houseRealYoY), ny = last(D.houseNomYoY), dd = last(D.houseRealDd);
  if (ry) {
    cards.push(card({
      label: 'Реальные цены на жильё за год', value: fmtNum(ry.value, 1, true), unit: '%', chart: `${cid}-house`,
      zone: zoneOf(RE_ZONES, dd ? dd.value : 0), source: BIS_SRC(cfg.bis),
      explain: 'Изменение цен на жильё за год с поправкой на инфляцию. Зона — по падению реальных цен от их исторического максимума.',
      detail: `на ${fmtMonth(ry.date)} (квартал) · номинальные: ${fmtNum(ny?.value, 1, true)}% · от максимума: ${fmtNum(dd?.value, 0)}%`,
    }));
  }
  const hd = last(D.hhDebt);
  if (hd) {
    const before = D.hhDebt.values[D.hhDebt.dates.indexOf(addMonths(hd.date, -60))];
    cards.push(card({
      label: 'Долг домохозяйств', value: fmtNum(hd.value, 1), unit: '% ВВП', chart: `${cid}-hhdebt`, source: BIS_DEBT_SRC(cfg.bis),
      explain: 'Кредиты населения (в основном ипотека) в % ВВП. Быстрый рост вместе с ценами на жильё — признак кредитного пузыря.',
      detail: `на ${fmtMonth(hd.date)} · за 5 лет: ${before ? fmtNum(hd.value - before, 1, true) + ' п.п.' : '—'}`,
    }));
  }
  for (const m of cfg.mortgage || []) {
    const v = last(D[m.id]);
    if (!v) continue;
    const yearAgo = D[m.id].values[Math.max(0, lowerBound(D[m.id].dates, addMonths(v.date, -12)) - 1)];
    cards.push(card({
      label: m.name, value: fmtNum(v.value, 2), unit: '%', chart: `${cid}-mortgage`, source: m.src,
      explain: 'Средняя ставка по ипотеке. Чем выше, тем меньше покупатели могут занять и тем сильнее давление на цены.',
      detail: `на ${fmtDate(v.date)} · за год: ${fmtNum(v.value - yearAgo, 2, true)} п.п.`,
    }));
    break;  // в сводке — одна главная ипотечная ставка
  }
  return cards;
}

/** Карточка курса: сколько местной валюты за доллар и изменение за год. */
function fxCard(s, fx, chart) {
  const v = last(s);
  if (!v) return '';
  const yearAgo = s.values[Math.max(0, lowerBound(s.dates, addMonths(v.date, -12)) - 1)];
  const ch = (v.value / yearAgo - 1) * 100;
  return card({
    label: fx.name, value: fmtNum(v.value, fx.band ? 4 : 2), unit: fx.unit, chart, source: fx.src,
    zone: fx.band ? { label: v.value > fx.band[1] - 0.01 || v.value < fx.band[0] + 0.01 ? 'У границы коридора' : 'Внутри коридора привязки', color: '--calm' }
      : ch > 10 ? { label: `Валюта слабеет: ${fmtNum(ch, 1, true)}% за год`, color: '--stress' }
        : ch < -10 ? { label: `Валюта крепнет: ${fmtNum(ch, 1, true)}% за год`, color: '--caution' }
          : { label: `${fmtNum(ch, 1, true)}% за год`, color: '--calm' },
    explain: 'Сколько местной валюты стоит один доллар США. Рост — местная валюта слабеет.',
    detail: `на ${fmtDate(v.date)}`,
  });
}

/** Сводка вкладки страны. */
function countryCards(c) {
  const D = state.ind.c[c.tab];
  const rates = [];
  for (const r of c.rates) {
    const v = last(D[r.id]);
    if (!v) continue;
    const yearAgo = D[r.id].values[Math.max(0, lowerBound(D[r.id].dates, addMonths(v.date, -12)) - 1)];
    rates.push(card({
      label: r.name, value: fmtNum(v.value, 2), unit: '%', chart: `${c.tab}-rates`, source: r.src,
      explain: r.step ? 'Ставка центробанка — цена денег в экономике.' : 'Доходность гособлигаций или ставка денежного рынка.',
      detail: `на ${fmtDate(v.date)} · за год: ${fmtNum(v.value - yearAgo, 2, true)} п.п.`,
    }));
  }
  c.curves.forEach((cv, k) => {
    rates.push(curveCard(`Наклон кривой: ${cv.name}`, D.curves[k], 'Разница длинных и коротких ставок. Ниже нуля — инверсия.',
      c.rates.flatMap((r) => r.src), `${c.tab}-curve`));
  });
  if (c.curves.length) {
    rates.push(inversionCard(inversionStatus(inversionFlag(D.curves[0], D.curves[1] || D.curves[0])),
      'Загорается, если хотя бы один из наклонов кривой ниже нуля.', c.rates.flatMap((r) => r.src), `${c.tab}-curve`));
  }
  if (c.risk && last(D.risk)) {
    rates.push(percentileCard({
      label: 'Спред OAT − Bund', unit: 'б.п.', digits: 0, signed: true, chart: `${c.tab}-risk`,
      explain: 'Премия, которую Франция платит сверх Германии. Рост — сомнения инвесторов в бюджете Франции.',
      source: [fred(c.risk.a), fred(c.risk.b)], detail: `на ${fmtMonth(last(D.risk).date)} · `,
    }, D.risk, SPREAD_PCT_ZONES));
  }
  const market = [];
  if (c.equity) market.push(indexCard(c.equity.short, D.equity, D.equityDd, 'Индекс акций.', c.equity.src, 0, `${c.tab}-equity`));
  if (c.fx) market.push(fxCard(D.fx, c.fx, `${c.tab}-fx`));
  return [
    ['Ставки и кривая доходности', rates],
    ['Рынок акций и валюта', market],
    ['Недвижимость', realEstateCards(D, c, c.tab)],
  ];
}

// ---------------------------------------------------------------------------
// Отрисовка графиков и масштаб оси Y
// ---------------------------------------------------------------------------

const tabCharts = (tab) => CHARTS.filter((c) => c.tab === tab);

/** Создаёт разделы и панели графиков вкладки по описанию CHARTS (один раз). */
function buildPanels(tab) {
  const root = $(`#charts-${tab}`);
  if (root.childElementCount) return;
  let secNo = 0;
  root.innerHTML = tabCharts(tab).map((c) => `
    ${c.section ? `<h2 class="section" id="sec-${tab}-${++secNo}">${c.section}</h2>` : ''}
    <section class="panel" id="panel-${c.id}">
      <div class="panel-head">
        <h2>${escapeHtml(c.title)}</h2>
        <button class="fs-btn" data-chart="${c.id}" aria-label="Открыть на весь экран" title="На весь экран">⛶</button>
      </div>
      <p class="note">${escapeHtml(c.intro)}</p>
      ${c.story ? `<details class="story"><summary>Кризисы на рынке жилья: справка</summary><p>${escapeHtml(c.story)}</p></details>` : ''}
      <div class="chart-wrap">
        <div class="chart" id="${c.id}"></div>
        <div class="dots" id="${c.id}-dots"></div>
        <div class="cursor-box" id="${c.id}-cursor" hidden></div>
      </div>
      <details class="more">
        <summary>Что на графике и откуда данные</summary>
        <div class="explain" id="${c.id}-explain"></div>
        <p class="source" id="${c.id}-source"></p>
      </details>
    </section>`).join('');
  buildToc(tab);
}

/** Оглавление вкладки: сводка и разделы со списком графиков — ссылки-переходы. */
function buildToc(tab) {
  const sections = [];
  for (const c of tabCharts(tab)) {
    if (c.section || !sections.length) sections.push({ title: c.section || 'Графики', charts: [] });
    sections[sections.length - 1].charts.push(c);
  }
  let secNo = 0;
  $(`#toc-${tab}`).innerHTML = `
    <details class="toc" open>
      <summary>Содержание</summary>
      <ol>
        <li><a href="#cards-${tab}">Сводка: текущие значения индикаторов</a></li>
        ${sections.map((sec) => `
          <li><a href="#sec-${tab}-${++secNo}">${escapeHtml(sec.title)}</a>
            <ul>${sec.charts.map((c) => `<li><a href="#panel-${c.id}" data-chart="${c.id}">${escapeHtml(c.title)}</a></li>`).join('')}</ul>
          </li>`).join('')}
      </ol>
    </details>`;
}

/** Пределы видимых значений по оси (y или y2) в текущем окне дат. */
/**
 * Окно дат для конкретного графика: общий выбранный период, обрезанный по его собственным
 * данным — чтобы слева и справа не было пустого места, если ряд начинается позже
 * или заканчивается раньше. Если период целиком вне данных графика — показываем как есть.
 */
function chartRange(traces) {
  const [from, to] = state.range;
  let first = '9999', lastD = '0000', hasBars = false;
  for (const tr of traces) {
    if (tr.meta || !tr.x || !tr.x.length) continue;  // служебные ряды и наложенный индекс не в счёт
    const xs = tr.x.filter((x, i) => x && tr.y[i] != null);
    if (!xs.length) continue;
    if (xs[0] < first) first = xs[0];
    if (xs[xs.length - 1] > lastD) lastD = xs[xs.length - 1];
    if (tr.type === 'bar') hasBars = true;
  }
  if (first === '9999') return [from, to];
  if (hasBars) {  // годовые столбцы стоят на середине года — оставляем место под их ширину
    first = toIso(new Date(toDate(first) - 200 * DAY_MS));
    lastD = toIso(new Date(toDate(lastD).getTime() + 200 * DAY_MS));
  }
  const a = from > first ? from : first;
  const b = to < lastD ? to : lastD;
  return a < b ? [a, b] : [from, to];
}

function visibleExtent(traces, axis, range) {
  const [from, to] = range;
  let lo = Infinity, hi = -Infinity;
  for (const tr of traces) {
    if (tr.visible === 'legendonly' || tr.visible === false) continue;
    if ((tr.yaxis || 'y') !== axis) continue;
    if (axis === 'y' && tr.meta) continue;  // служебные ряды не влияют на масштаб
    const i0 = lowerBound(tr.x, from), i1 = lowerBound(tr.x, to + '~');
    for (let i = i0; i < i1; i++) {
      const v = tr.y[i];
      if (v == null) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  return Number.isFinite(lo) ? [lo, hi] : null;
}

/** Засечки логарифмической оси на «круглых» значениях: 100, 200, 500, 1000… */
function logTicks([a, b]) {
  const vals = [];
  for (let p = Math.floor(a); p <= Math.ceil(b); p++) {
    for (const m of [1, 2, 5]) {
      const v = m * 10 ** p;
      if (Math.log10(v) >= a && Math.log10(v) <= b) vals.push(v);
    }
  }
  return { tickvals: vals, ticktext: vals.map((v) => fmtNum(v)) };
}

/** Логарифмическая ось Plotly задаётся в log10 единицах. */
function logRange([lo, hi]) {
  const a = Math.log10(Math.max(lo, 1e-9)), b = Math.log10(Math.max(hi, 1e-9));
  const pad = (b - a) * 0.05 || 0.1;
  return [a - pad, b + pad];
}

/**
 * Подбирает диапазон оси Y под видимые данные в текущем окне дат
 * (Plotly сам этого не делает при зуме только по X).
 */
function yRangeFor(traces, def, range) {
  const ext = visibleExtent(traces, 'y', range);
  if (!ext) return [0, 1];
  if (def.log) return logRange(ext);
  let [lo, hi] = ext;
  if (def.includeZero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  if (def.minTop) { lo = 0; hi = Math.max(hi, def.minTop); }
  const pad = (hi - lo) * 0.06 || 1;
  return [def.minTop ? 0 : lo - pad, hi + pad];
}

/** Обновления осей Y (и правой оси наложенного индекса) под текущее окно дат. */
function axisUpdate(traces, def) {
  const xr = chartRange(traces);
  const r = yRangeFor(traces, def, xr);
  const upd = { 'xaxis.range': xr, 'yaxis.range': r };
  if (def.log) {
    const t = logTicks(r);
    upd['yaxis.tickvals'] = t.tickvals;
    upd['yaxis.ticktext'] = t.ticktext;
  }
  const ext2 = visibleExtent(traces, 'y2', xr);
  if (ext2) {
    const r2 = logRange(ext2);
    const t = logTicks(r2);
    Object.assign(upd, { 'yaxis2.range': r2, 'yaxis2.tickvals': t.tickvals, 'yaxis2.ticktext': t.ticktext });
  }
  return upd;
}

function renderCharts(tab) {
  buildPanels(tab);
  for (const def of tabCharts(tab)) renderChart(def, tab);
}

/** Рисует один график (обычный или развёрнутый на весь экран). */
function renderChart(def, tab = state.tab) {
  const overlay = overlayTrace(tab);
  {
    const el = document.getElementById(def.id);
    const built = def.build(state.ind, tab);
    const data = [...built.data];
    const layout = built.layout;
    const explain = [...built.explain];

    if (overlay && !def.noOverlay) {
      data.push(overlay);
      layout.yaxis2 = {
        overlaying: 'y', side: 'right', type: 'log', showgrid: false, fixedrange: true,
        tickfont: { color: css('--overlay') }, zeroline: false,
      };
      layout.margin.r = 56;
      explain.push([overlay.name, '--overlay', EXPLAIN.overlay]);
    }
    if (recessionShapes(tab).length) data.push(recessionLegendTrace(tab));   // у Китая и Гонконга полос нет
    explain.push(['Серые полосы', '--muted', EXPLAIN[TAB_BANDS[tab].explain]]);

    // Телефон: легенда в две колонки мелким шрифтом, высота графика растёт с числом рядов,
    // чтобы легенда не съедала область графика; панель кнопок Plotly скрыта.
    // Сенсорный экран: встроенный зум Plotly выключен — сдвиг и масштаб делают свои жесты
    // (bindTouchGestures), а вертикальное протягивание прокручивает страницу.
    if (TOUCH.matches) {
      layout.dragmode = false;
      layout.xaxis.fixedrange = true;
      layout.hovermode = false;  // значения показывает своя подсказка (showCursor) — её можно закрыть касанием
    }
    if (NARROW.matches) {
      // Пары «лонг/шорт» — одна строка легенды на группу (касание скрывает обе линии).
      for (const t of data) {
        if (t.legendgroup && t.line && t.line.dash === 'dash') t.showlegend = false;
      }
      const shown = data.filter((t) => t.showlegend !== false);
      for (const t of shown) {
        if (/: лонг$/.test(t.name || '')) {
          t.name = t.name.replace(/: лонг$/, '');
          t.hovertemplate += ' (лонг)';  // во всплывающих значениях пометка остаётся
        }
      }
      // Короткие названия — по два в строку, иначе по одному (длинные наезжали бы друг на друга).
      const twoCols = shown.every((t) => (t.name || '').length <= 16);
      layout.legend = {
        ...layout.legend, font: { ...layout.legend.font, size: 10 },
        entrywidth: twoCols ? 0.5 : 1, entrywidthmode: 'fraction',
      };
      layout.margin.l = 44;
      layout.height = 250 + Math.ceil(shown.length / (twoCols ? 2 : 1)) * 20;
      el.style.height = `${layout.height}px`;
    } else {
      // Высота из CSS (.chart), заданная явно: иначе после выхода из полноэкранного режима
      // Plotly оставил бы прежнюю, полноэкранную высоту.
      el.style.height = '';
      layout.height = parseFloat(getComputedStyle(el).height) || 380;
    }
    // Весь экран: график занимает всю высоту окна под заголовком.
    if (state.fs === def.id) {
      const head = document.querySelector(`#panel-${def.id} .panel-head`);
      layout.height = Math.max(280, window.innerHeight - (head ? head.offsetHeight : 40) - 28);
      layout.width = el.clientWidth;          // явно: сам Plotly ширину развёрнутой панели не подхватывает
      el.style.height = `${layout.height}px`;
    }

    // Ключи вида 'yaxis.range' раскладываем в объект layout.
    for (const [path, v] of Object.entries(axisUpdate(data, def))) {
      const [axis, prop] = path.split('.');
      if (layout[axis]) layout[axis][prop] = v;
    }
    // Нет данных (источник не ответил при последней загрузке) — честная надпись вместо пустых осей.
    const hasData = data.some((t) => !t.meta && t.y && t.y.some((v) => v != null));
    if (!hasData) {
      layout.annotations = [...(layout.annotations || []), {
        xref: 'paper', yref: 'paper', x: 0.5, y: 0.5, showarrow: false,
        text: 'Нет данных: источник не ответил при последней загрузке.<br>Попробуйте позже — данные обновляются автоматически.',
        font: { size: 13, color: css('--muted') },
      }];
    }
    hideCursorBox(el);
    clearDots(el);
    const keep = state.fs === def.id ? el._cursorMs : null;    // выбранная точка в полноэкранном режиме
    Plotly.react(el, data, layout, { ...PLOT_CONFIG, displayModeBar: !NARROW.matches && !TOUCH.matches && state.fs !== def.id })
      .then(() => { if (keep) showCursorAt(el, keep); });
    if (!el.dataset.bound) bindChartEvents(el, def);

    let srcLine = `Источник: ${srcHtml(def.source)}; полосы — ${srcHtml(TAB_BANDS[tab].source)}`;
    if (overlay && !def.noOverlay) srcLine += `; наложенный индекс — ${srcHtml(state.overlay[tab] === 'eq' ? COUNTRY[tab].equity.src : OVERLAY_SRC[state.overlay[tab]])}`;
    document.getElementById(`${def.id}-source`).innerHTML = `${srcLine}.`;

    document.getElementById(`${def.id}-explain`).innerHTML = explain.map(([name, color, text]) =>
      `<div><span class="swatch" style="background: var(${color})"></span><b>${escapeHtml(name)}.</b> ${escapeHtml(text)}</div>`,
    ).join('');
  }
}

// ---------------------------------------------------------------------------
// Подсказка со значениями для сенсорных экранов
// ---------------------------------------------------------------------------

/**
 * Точки цвета линий в выбранных датах — поверх графика, отдельным HTML-слоем
 * (без перерисовки Plotly, поэтому двигаются за курсором плавно).
 * pts: [{ x: дата, y: значение, axis: 'y' | 'y2', color }].
 */
function drawDots(el, pts) {
  const layer = document.getElementById(`${el.id}-dots`);
  if (!layer || !el._fullLayout) return;
  const fl = el._fullLayout, xa = fl.xaxis;
  layer.innerHTML = pts.map((p) => {
    const ya = p.axis === 'y2' ? fl.yaxis2 : fl.yaxis;
    if (!ya || p.y == null) return '';
    const px = xa._offset + xa.d2p(p.x), py = ya._offset + ya.d2p(p.y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return '';
    if (px < xa._offset - 1 || px > xa._offset + xa._length + 1 || py < ya._offset - 1 || py > ya._offset + ya._length + 1) return '';
    return `<span class="dot" style="left:${px}px;top:${py}px;background:${p.color}"></span>`;
  }).join('');
}

function clearDots(el) {
  const layer = document.getElementById(`${el.id}-dots`);
  if (layer) layer.innerHTML = '';
}

/** Число по формату из hovertemplate: '.2f', '+.0f', ',.1f', '+,.1f' и т.п. */
function fmtByTemplate(v, f = '') {
  const m = f.match(/^(\+)?,?(?:\.(\d+))?/);
  return fmtNum(v, m && m[2] ? Number(m[2]) : 2, !!(m && m[1]));
}

/** Подставляет значения в hovertemplate трассы (%{y:…}, %{customdata:…}). */
function fillTemplate(tpl, y, cd) {
  return tpl.replace(/%\{(y|customdata)(?::([^}]*))?\}/g, (m, key, f) => fmtByTemplate(key === 'y' ? y : cd, f));
}

/** Ближайшая к дате точка трассы — если она не дальше полутора типичных шагов ряда. */
function nearestPoint(tr, ms) {
  const xs = tr.x;
  let lo = 0, hi = xs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (toDate(String(xs[mid]).slice(0, 10)) < ms) lo = mid + 1; else hi = mid;
  }
  let best = -1, bestDist = Infinity;
  for (const i of [lo - 1, lo, lo + 1]) {
    if (i < 0 || i >= xs.length || xs[i] == null || tr.y[i] == null) continue;
    const dist = Math.abs(toDate(String(xs[i]).slice(0, 10)) - ms);
    if (dist < bestDist) { best = i; bestDist = dist; }
  }
  if (best < 0) return -1;
  const step = (toDate(String(xs[xs.length - 1]).slice(0, 10)) - toDate(String(xs[0]).slice(0, 10))) / Math.max(1, xs.length - 1);
  return bestDist <= Math.max(3 * DAY_MS, 1.5 * step) ? best : -1;
}

/**
 * Значения всех видимых рядов графика на дату (ближайшие точки).
 * Возвращает { date, rows: [{ tr, i, color, axis }] }.
 */
function valuesAt(el, ms) {
  const rows = [];
  let date = null;
  for (const tr of el.data) {
    if (tr.visible === 'legendonly' || tr.visible === false) continue;
    if (!tr.hovertemplate || !tr.x || !tr.x.length) continue;          // заливки, служебные ряды
    if (tr.meta && tr.meta !== 'overlay') continue;
    const i = nearestPoint(tr, ms);
    if (i < 0) continue;
    const color = (tr.line && tr.line.color) || (tr.marker && tr.marker.color) || css('--text');
    rows.push({ tr, i, color, axis: tr.yaxis === 'y2' ? 'y2' : 'y' });
    date = date || String(tr.x[i]).slice(0, 10);
  }
  return { date, rows };
}

/** Единица измерения и число знаков ряда — из его hovertemplate ('%{y:.2f} трлн ₽ · …' → ' трлн ₽', 2). */
function unitOf(tpl) {
  const m = tpl.match(/%\{y(?::([^}]*))?\}([^·(]*)/);  // единица — до « ·» или «(»
  const digits = m && m[1] && /\.(\d+)/.test(m[1]) ? Number(m[1].match(/\.(\d+)/)[1]) : 2;
  return { unit: m ? m[2].trimEnd() : '', digits };
}

/** Точки на кривых + фигуры замера (points = { y: [...], y2: [...] }). */
function setMarkers(el, points, shapes) {
  const pts = [...points.y.map((p) => ({ ...p, axis: 'y' })), ...points.y2.map((p) => ({ ...p, axis: 'y2' }))]
    .map((p) => ({ x: p.x, y: p.y, axis: p.axis, color: p.c }));
  state.syncing = true;
  return Plotly.relayout(el, { shapes }).finally(() => {
    state.syncing = false;
    drawDots(el, pts);  // после relayout: оси уже в окончательном виде
  });
}

/** Ставит блок значений там, где он не заденет линии: справа, слева или между ними. */
function placeBox(el, box, lines) {
  const W = el.getBoundingClientRect().width, gap = 10;
  const a = Math.min(...lines), b = Math.max(...lines);
  const spaces = [['right', W - b], ['left', a], ['between', lines.length > 1 ? b - a : 0]];
  const [where, room] = spaces.reduce((best, cur) => (cur[1] > best[1] ? cur : best));
  box.style.maxWidth = `${Math.max(130, room - 2 * gap)}px`;
  box.style.top = `${el._fullLayout._size.t + 4}px`;
  box.style.left = where === 'right' ? `${b + gap}px` : where === 'between' ? `${a + gap}px` : '';
  box.style.right = where === 'left' ? `${W - a + gap}px` : '';
}

/**
 * Замер между двумя датами: две полупрозрачные линии, подсветка промежутка, кружки на кривых
 * и блок с изменением каждого ряда — в единицах ряда и в процентах.
 * Телефон: удерживать два пальца на графике; компьютер: Shift + протянуть мышью.
 */
function showMeasure(el, clientX1, clientX2) {
  const xa = el._fullLayout.xaxis;
  const left = el.getBoundingClientRect().left + xa._offset;
  const px = [clientX1, clientX2].map((x) => Math.min(xa._length, Math.max(0, x - left))).sort((p, q) => p - q);
  const A = valuesAt(el, xa.p2l(px[0])), B = valuesAt(el, xa.p2l(px[1]));
  if (!A.date || !B.date || A.date === B.date) return;

  const points = { y: [], y2: [] };
  const rows = [];
  for (const ra of A.rows) {
    const rb = B.rows.find((r) => r.tr === ra.tr);
    if (!rb) continue;
    const ya = ra.tr.y[ra.i], yb = rb.tr.y[rb.i];
    points[ra.axis].push({ x: ra.tr.x[ra.i], y: ya, c: ra.color }, { x: rb.tr.x[rb.i], y: yb, c: ra.color });
    const { unit, digits } = unitOf(ra.tr.hovertemplate);
    const dUnit = unit.trim() === '%' ? ' п.п.' : unit;              // для процентных рядов разница — в п.п.
    const pct = ya > 0 && yb > 0 ? ` (${fmtNum((yb / ya - 1) * 100, 1, true)}%)` : '';
    rows.push(`<div class="row"><span class="swatch" style="background:${ra.color}"></span>
      <span class="name">${escapeHtml(ra.tr.name)}</span>
      <b>${fmtNum(ya, digits)} → ${fmtNum(yb, digits)}${escapeHtml(unit)} · ${fmtNum(yb - ya, digits, true)}${escapeHtml(dUnit)}${pct}</b></div>`);
  }
  if (!rows.length) return;

  const line = (x) => ({ type: 'line', name: 'measure', xref: 'x', yref: 'paper', x0: x, x1: x, y0: 0, y1: 1,
    line: { color: withAlpha('--text', 0.4), width: 1 } });
  const shapes = (el.layout.shapes || []).filter((sh) => sh.name !== 'cursor' && sh.name !== 'measure');
  shapes.push({ type: 'rect', name: 'measure', xref: 'x', yref: 'paper', x0: A.date, x1: B.date, y0: 0, y1: 1,
    fillcolor: withAlpha('--accent', 0.08), line: { width: 0 }, layer: 'below' }, line(A.date), line(B.date));
  setMarkers(el, points, shapes);

  const days = daysBetween(A.date, B.date);
  const span = days >= 730 ? `${fmtNum(days / 365.25, 1)} г.` : `${fmtNum(days)} дн.`;
  const box = document.getElementById(`${el.id}-cursor`);
  box.innerHTML = `<div class="date">${fmtDate(A.date)} → ${fmtDate(B.date)} · ${span}${closeBtn()}</div>${rows.join('')}
    ${TOUCH.matches ? '' : '<div class="close">нажмите, чтобы скрыть</div>'}`;
  box.hidden = false;
  box.classList.add('measuring');               // пока открыт замер, наведение его не перезаписывает
  placeBox(el, box, [A.date, B.date].map((d) => xa._offset + xa.l2p(toDate(d).getTime())));
  bindBoxTap(el, box);
}

function hideCursorBox(el) {
  const box = document.getElementById(`${el.id}-cursor`);
  if (box) {
    box.hidden = true;
    box.classList.remove('measuring', 'solid');
  }
}

/** Убирает подсказку: точки, линии замера и блок со значениями. */
function hideCursor(el) {
  el._cursorMs = null;
  hideCursorBox(el);
  clearDots(el);
  if (!el.data || !el.layout) return;
  const shapes = el.layout.shapes || [];
  if (!shapes.some((sh) => sh.name === 'cursor' || sh.name === 'measure')) return;
  state.syncing = true;
  Plotly.relayout(el, { shapes: shapes.filter((sh) => sh.name !== 'cursor' && sh.name !== 'measure') })
    .finally(() => { state.syncing = false; });
}

/**
 * Блок значений на дату: строки в том же порядке, что и кривые на графике (выше кривая — выше строка).
 * rows: [{ tr, i, color, axis }].
 */
function fillValuesBox(el, date, rows) {
  const fl = el._fullLayout;
  const py = (r) => {
    const ya = r.axis === 'y2' ? fl.yaxis2 : fl.yaxis;
    const v = ya ? ya.d2p(r.tr.y[r.i]) : 0;
    return Number.isFinite(v) ? v : 0;
  };
  const sorted = [...rows].sort((a, b) => py(a) - py(b));       // меньше пиксель — выше на экране
  const box = document.getElementById(`${el.id}-cursor`);
  box.innerHTML = `<div class="date">${fmtDate(date)}${closeBtn()}</div>${sorted.map((r) => {
    const cd = Array.isArray(r.tr.customdata) ? r.tr.customdata[r.i] : undefined;
    return `<div class="row"><span class="swatch" style="background:${r.color}"></span>
      <span class="name">${escapeHtml(r.tr.name)}</span><b>${escapeHtml(fillTemplate(r.tr.hovertemplate, r.tr.y[r.i], cd))}</b></div>`;
  }).join('')}`;
  box.hidden = false;
  box.classList.remove('measuring');
  return box;
}

/**
 * Блок значений — в верхнем углу графика, с той стороны, где нет точек.
 * Сторона меняется, только когда точки подходят под блок, — поэтому к блоку
 * можно подвести мышь, и он не «убегает».
 */
function placeBoxCorner(el, box, lineX) {
  const xa = el._fullLayout.xaxis;
  const W = el.getBoundingClientRect().width;
  box.style.maxWidth = `${Math.max(150, xa._length * 0.55)}px`;
  box.style.top = `${el._fullLayout._size.t + 4}px`;
  const put = (side) => {
    el._boxSide = side;
    box.style.left = side === 'left' ? `${xa._offset + 6}px` : '';
    box.style.right = side === 'right' ? `${W - xa._offset - xa._length + 6}px` : '';
  };
  put(el._boxSide || (lineX < xa._offset + xa._length / 2 ? 'right' : 'left'));
  const wrapLeft = el.getBoundingClientRect().left;
  const b = box.getBoundingClientRect();
  if (lineX + wrapLeft > b.left - 12 && lineX + wrapLeft < b.right + 12) put(el._boxSide === 'left' ? 'right' : 'left');
}

/** Кнопка «×» в блоке значений (на сенсорном экране — единственный способ закрыть блок). */
const closeBtn = () => (TOUCH.matches ? '<button class="x" aria-label="Скрыть">×</button>' : '');

/**
 * Закрытие блока значений. Сенсорный экран: блок пропускает касания к графику (можно выбрать
 * точку под ним), закрывается крестиком. Мышь: блок яркий при наведении, клик — закрыть.
 */
function bindBoxTap(el, box) {
  box.classList.remove('solid');
  const x = box.querySelector('.x');
  if (x) x.onclick = (e) => { e.stopPropagation(); hideCursor(el); };
  box.onclick = TOUCH.matches ? null : () => hideCursor(el);
}

/** Касание графика (сенсорный экран): точки цвета линий и полупрозрачный блок значений. */
function showCursor(el, clientX) {
  const xa = el._fullLayout.xaxis;
  const px = clientX - el.getBoundingClientRect().left - xa._offset;
  if (px < 0 || px > xa._length) return;
  showCursorAt(el, xa.p2l(px));
}

/** То же для даты (мс). Дата запоминается, чтобы подсказка пережила перерисовку графика. */
function showCursorAt(el, ms) {
  const xa = el._fullLayout.xaxis;
  const { date, rows } = valuesAt(el, ms);
  if (!rows.length) { hideCursor(el); return; }
  el._cursorMs = ms;

  const shapes = (el.layout.shapes || []).filter((sh) => sh.name !== 'cursor' && sh.name !== 'measure');
  const points = { y: [], y2: [] };
  for (const r of rows) points[r.axis].push({ x: r.tr.x[r.i], y: r.tr.y[r.i], c: r.color });
  setMarkers(el, points, shapes);

  const box = fillValuesBox(el, date, rows);
  placeBoxCorner(el, box, xa._offset + xa.l2p(toDate(date).getTime()));
  bindBoxTap(el, box);
}

/**
 * Жесты на сенсорном экране:
 *   один палец влево-вправо — сдвиг периода; вверх-вниз — обычная прокрутка страницы
 *   (CSS touch-action: pan-y оставляет вертикаль браузеру);
 *   два пальца — приблизить/отдалить вокруг точки между пальцами;
 *   касание без движения — Plotly показывает значения на дату.
 * Во время жеста перерисовывается только этот график; когда пальцы отпущены,
 * новый период применяется ко всем графикам (каждый — в пределах своих данных).
 */
function bindTouchGestures(el) {
  let g = null;           // состояние текущего жеста
  let frame = 0;          // запланированная перерисовка (не чаще кадра экрана)
  const xa = () => el._fullLayout.xaxis;
  const toStr = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  const minSpan = 30 * DAY_MS;

  const redraw = () => {
    frame = 0;
    if (!g || !g.cur) return;
    state.syncing = true;  // не запускать синхронизацию всех графиков на каждом кадре
    Plotly.relayout(el, { 'xaxis.range': g.cur.map(toStr) }).finally(() => { state.syncing = false; });
  };

  el.addEventListener('touchstart', (e) => {
    if (!TOUCH.matches || !el._fullLayout) return;
    const [a, b] = xa().range.map((r) => xa().r2l(r));
    if (e.touches.length === 2) {
      // Два пальца: если в течение 0,35 с не двигаются — замер между ними, иначе — масштаб.
      const [t1, t2] = e.touches;
      clearTimeout(g && g.timer);
      g = { kind: 'two', a, b, dist: Math.abs(t1.clientX - t2.clientX) || 1, mid: (t1.clientX + t2.clientX) / 2 };
      g.timer = setTimeout(() => {
        if (g && g.kind === 'two') { g.kind = 'measure'; showMeasure(el, t1.clientX, t2.clientX); }
      }, 350);
    } else if (e.touches.length === 1) {
      g = { kind: 'pending', a, b, x: e.touches[0].clientX, y: e.touches[0].clientY };
      // Полноэкранный режим: палец удержан на месте 0,28 с — «ведение»: точки следуют за пальцем.
      if (state.fs === el.id) {
        const st = g;
        st.hold = setTimeout(() => {
          if (g === st && st.kind === 'pending') {
            st.kind = 'scrub';
            showCursor(el, st.x);
            if (navigator.vibrate) navigator.vibrate(8);
          }
        }, 280);
      }
    }
  }, { passive: true });

  el.addEventListener('touchmove', (e) => {
    if (!g) return;
    const span = g.b - g.a;
    const len = xa()._length;
    if (g.kind === 'scrub') {
      const x = e.touches[0].clientX;
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; showCursor(el, x); });
      if (e.cancelable) e.preventDefault();
      return;
    }
    if (g.kind === 'pending') {
      const dx = e.touches[0].clientX - g.x, dy = e.touches[0].clientY - g.y;
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;            // ещё касание, а не жест
      clearTimeout(g.hold);
      if (Math.abs(dy) > Math.abs(dx)) { g = null; return; }        // вертикаль — прокрутка страницы
      g.kind = 'pan';
    }
    if (g.kind === 'two' && e.touches.length === 2) {
      const [t1, t2] = e.touches;
      const moved = Math.abs((Math.abs(t1.clientX - t2.clientX) || 1) - g.dist) > 12
        || Math.abs((t1.clientX + t2.clientX) / 2 - g.mid) > 12;
      if (!moved) { if (e.cancelable) e.preventDefault(); return; }
      clearTimeout(g.timer);
      g.kind = 'pinch';
    }
    if (g.kind === 'measure') {
      if (e.touches.length === 2) {
        const [t1, t2] = e.touches;
        if (!frame) frame = requestAnimationFrame(() => { frame = 0; showMeasure(el, t1.clientX, t2.clientX); });
      }
      if (e.cancelable) e.preventDefault();
      return;
    }
    if (!g.cursorHidden) { hideCursor(el); g.cursorHidden = true; }  // при сдвиге/масштабе подсказка не нужна
    if (g.kind === 'pan' && e.touches.length === 1) {
      const shift = (-(e.touches[0].clientX - g.x) / len) * span;
      g.cur = [g.a + shift, g.b + shift];
    } else if (g.kind === 'pinch' && e.touches.length === 2) {
      const [t1, t2] = e.touches;
      const dist = Math.abs(t1.clientX - t2.clientX) || 1;
      const left = el.getBoundingClientRect().left + xa()._offset;
      const f = Math.min(1, Math.max(0, (g.mid - left) / len));   // доля ширины, где пальцы
      const center = g.a + f * span;
      const maxSpan = toDate(state.ind.lastDate) - toDate(state.ind.firstDate);
      const newSpan = Math.min(Math.max((span * g.dist) / dist, minSpan), maxSpan);
      g.cur = [center - f * newSpan, center + (1 - f) * newSpan];
    } else {
      return;
    }
    if (e.cancelable) e.preventDefault();
    if (!frame) frame = requestAnimationFrame(redraw);
  }, { passive: false });

  const finish = () => {
    if (g) { clearTimeout(g.timer); clearTimeout(g.hold); }
    if (g && g.kind === 'scrub') { g = null; return; }        // точки остаются там, где отпустили палец
    if (g && g.cur) setRange(toIso(new Date(g.cur[0])), toIso(new Date(g.cur[1])));
    else if (g && g.kind === 'pending') {
      // Касание: обычный график — развернуть на весь экран, развёрнутый — значения на дату.
      if (state.fs === el.id) showCursor(el, g.x); else openFullscreen(el.id);
    }
    g = null;
  };
  el.addEventListener('touchend', (e) => { if (!e.touches.length) finish(); });
  el.addEventListener('touchcancel', () => { if (g) { clearTimeout(g.timer); clearTimeout(g.hold); } g = null; });
}

/**
 * Мышь: клик по графику (без протягивания) — развернуть на весь экран;
 * Shift + протянуть — замер изменения между двумя датами (встроенный зум Plotly при этом не срабатывает).
 */
function bindMouse(el) {
  el.addEventListener('mousedown', (e) => {
    if (TOUCH.matches || e.button !== 0) return;
    if (e.target.closest('.legend, .modebar, .cursor-box')) return;
    const inPlot = e.target.closest('.nsewdrag, .draglayer');
    if (e.shiftKey && inPlot) {
      e.preventDefault();
      e.stopPropagation();                       // не даём Plotly начать рамку зума
      const x0 = e.clientX;
      let frame = 0;
      const move = (ev) => {
        if (!frame) frame = requestAnimationFrame(() => { frame = 0; showMeasure(el, x0, ev.clientX); });
      };
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      return;
    }
    if (!inPlot || state.fs === el.id) return;
    const x0 = e.clientX, y0 = e.clientY;
    const up = (ev) => {
      window.removeEventListener('mouseup', up);
      if (Math.abs(ev.clientX - x0) < 4 && Math.abs(ev.clientY - y0) < 4) {
        clearTimeout(el._fsTimer);
        el._fsTimer = setTimeout(() => openFullscreen(el.id), 260);   // двойной клик успеет отменить
      }
    };
    window.addEventListener('mouseup', up);
  }, true);

  // Двойной клик — отдалить в 2 раза вокруг точки клика (показать больше лет).
  el.addEventListener('dblclick', (e) => {
    if (TOUCH.matches) return;
    clearTimeout(el._fsTimer);
    e.preventDefault();
    zoomBy(el, 2, e.clientX);
  });

  // Тачпад: свайп двумя пальцами вбок — сдвиг; щипок (браузер присылает wheel с ctrlKey) — масштаб.
  // Вертикальная прокрутка колесом/тачпадом остаётся прокруткой страницы.
  el.addEventListener('wheel', (e) => {
    if (TOUCH.matches || !el._fullLayout) return;
    const px = e.deltaMode === 1 ? 16 : 1;                       // строки → пиксели (Firefox)
    const dx = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * px, dy = e.deltaY * px;
    if (!e.ctrlKey && Math.abs(dx) <= Math.abs(dy)) return;
    e.preventDefault();
    const xa = el._fullLayout.xaxis;
    const [a, b] = el._wheel || xa.range.map((r) => xa.r2l(r));
    let range;
    if (e.ctrlKey) {
      const anchor = xa.p2l(e.clientX - el.getBoundingClientRect().left - xa._offset);
      range = scaleRange([a, b], Math.exp(dy * 0.01), anchor);
    } else {
      const shift = (dx / xa._length) * (b - a);
      range = [a + shift, b + shift];
    }
    previewRange(el, range);
  }, { passive: false });

  el.addEventListener('mouseenter', () => { state.hoverChart = el.id; });
  el.addEventListener('mouseleave', () => { if (state.hoverChart === el.id) state.hoverChart = null; });
}

// ---------------------------------------------------------------------------
// Масштаб и сдвиг: двойной клик, стрелки, тачпад
// ---------------------------------------------------------------------------

/** Новый диапазон дат: масштаб factor (>1 — отдалить) вокруг даты anchor (мс), с ограничениями. */
function scaleRange([a, b], factor, anchor = (a + b) / 2) {
  const maxSpan = toDate(state.ind.lastDate) - toDate(state.ind.firstDate);
  const span = Math.min(Math.max((b - a) * factor, 30 * DAY_MS), maxSpan);
  const f = Math.min(1, Math.max(0, (anchor - a) / (b - a)));
  return [anchor - f * span, anchor + (1 - f) * span];
}

const msToIso = (ms) => toIso(new Date(ms));

/** Масштаб всех графиков вкладки вокруг точки clientX графика el (или вокруг центра). */
function zoomBy(el, factor, clientX) {
  const xa = el._fullLayout.xaxis;
  const [a, b] = xa.range.map((r) => xa.r2l(r));
  const anchor = clientX == null ? undefined : xa.p2l(clientX - el.getBoundingClientRect().left - xa._offset);
  const [na, nb] = scaleRange([a, b], factor, anchor);
  setRange(msToIso(na), msToIso(nb));
}

/** Сдвиг всех графиков вкладки на долю ширины (минус — в прошлое). */
function panBy(el, fraction) {
  const xa = el._fullLayout.xaxis;
  const [a, b] = xa.range.map((r) => xa.r2l(r));
  const shift = fraction * (b - a);
  setRange(msToIso(a + shift), msToIso(b + shift));
}

/**
 * Плавный предпросмотр при прокрутке тачпадом: перерисовывается только этот график,
 * а через 0,2 с после последнего движения период применяется ко всем графикам.
 */
function previewRange(el, range) {
  el._wheel = range;
  hideCursorBox(el);
  clearDots(el);
  if (!el._wheelFrame) {
    el._wheelFrame = requestAnimationFrame(() => {
      el._wheelFrame = 0;
      const toStr = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
      state.syncing = true;
      Plotly.relayout(el, { 'xaxis.range': el._wheel.map(toStr) }).finally(() => { state.syncing = false; });
    });
  }
  clearTimeout(el._wheelTimer);
  el._wheelTimer = setTimeout(() => {
    const [a, b] = el._wheel;
    el._wheel = null;
    setRange(msToIso(a), msToIso(b));
  }, 200);
}

// ---------------------------------------------------------------------------
// Весь экран
// ---------------------------------------------------------------------------

function openFullscreen(id) {
  if (state.fs) closeFullscreen();
  const panel = document.getElementById(`panel-${id}`);
  if (!panel) return;
  state.fs = id;
  panel.classList.add('fs');
  document.body.classList.add('fs-open');
  const btn = panel.querySelector('.fs-btn');
  btn.textContent = '×';
  btn.setAttribute('aria-label', 'Свернуть');
  btn.title = 'Свернуть (Esc)';
  renderChart(CHARTS.find((c) => c.id === id));
}

function closeFullscreen() {
  const id = state.fs;
  if (!id) return;
  state.fs = null;
  const panel = document.getElementById(`panel-${id}`);
  panel.classList.remove('fs');
  document.body.classList.remove('fs-open');
  const btn = panel.querySelector('.fs-btn');
  btn.textContent = '⛶';
  btn.setAttribute('aria-label', 'Открыть на весь экран');
  btn.title = 'На весь экран';
  renderChart(CHARTS.find((c) => c.id === id));
  // Вернуть обычную ширину: размер снова берётся из панели, как у остальных графиков.
  const el = document.getElementById(id);
  state.syncing = true;
  Plotly.relayout(el, { autosize: true }).finally(() => { state.syncing = false; });
  panel.scrollIntoView({ block: 'center' });
}

function bindChartEvents(el, def) {
  el.dataset.bound = '1';
  bindTouchGestures(el);
  bindMouse(el);

  // Зум по X на любом графике → применяем ко всем.
  el.on('plotly_relayout', (ev) => {
    if (state.syncing) return;
    if (ev['xaxis.range[0]'] && ev['xaxis.range[1]']) {
      setRange(String(ev['xaxis.range[0]']).slice(0, 10), String(ev['xaxis.range[1]']).slice(0, 10));
    } else if (ev['xaxis.range']) {
      setRange(String(ev['xaxis.range'][0]).slice(0, 10), String(ev['xaxis.range'][1]).slice(0, 10));
    } else if (ev['xaxis.autorange']) {
      applyPreset('all'); // двойной клик по графику — показать всю историю
    }
  });

  // Наведение мышью: точки цвета линий на всех рядах в дате под курсором.
  // Стандартная подсказка Plotly скрыта (CSS .hoverlayer) — вместо неё свой блок значений,
  // где строки идут в том же порядке, что и кривые.
  const box = document.getElementById(`${el.id}-cursor`);
  el.on('plotly_hover', (ev) => {
    if (TOUCH.matches || box.classList.contains('measuring')) return;
    clearTimeout(el._hideTimer);
    const rows = ev.points
      .filter((p) => (!p.data.meta || p.data.meta === 'overlay') && p.data.hovertemplate)
      .map((p) => ({ tr: p.data, i: p.pointIndex ?? p.pointNumber,
        color: (p.data.line && p.data.line.color) || (p.data.marker && p.data.marker.color), axis: p.data.yaxis === 'y2' ? 'y2' : 'y' }));
    if (!rows.length) return;
    drawDots(el, rows.map((r) => ({ x: r.tr.x[r.i], y: r.tr.y[r.i], axis: r.axis, color: r.color })));
    const date = String(rows[0].tr.x[rows[0].i]).slice(0, 10);
    fillValuesBox(el, date, rows);
    placeBoxCorner(el, box, el._fullLayout.xaxis._offset + el._fullLayout.xaxis.l2p(toDate(date).getTime()));
    box.onclick = () => hideCursor(el);
  });
  // Уход мыши с графика: прячем, если мышь не перешла на сам блок (на нём он становится ярким).
  const hideLater = () => {
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => {
      if (!box.matches(':hover') && !box.querySelector('.close')) { clearDots(el); hideCursorBox(el); }
    }, 150);
  };
  el.on('plotly_unhover', () => { if (!TOUCH.matches) hideLater(); });
  box.addEventListener('mouseleave', (e) => { if (!TOUCH.matches && !el.contains(e.relatedTarget)) hideLater(); });
  el.on('plotly_relayout', () => { if (!state.syncing) clearDots(el); });  // после зума позиции точек неверны

  // Клик по легенде → пересчитываем ось Y; псевдо-ряд «Рецессии» скрывает полосы.
  el.on('plotly_restyle', () => {
    if (state.syncing) return;
    const recTrace = el.data.find((t) => t.meta === 'recession-toggle');
    const showRec = !recTrace || recTrace.visible !== 'legendonly';
    const shapes = el.layout.shapes.map((s) => (s.name === 'recession' ? { ...s, visible: showRec } : s));
    state.syncing = true;
    Plotly.relayout(el, { shapes, ...axisUpdate(el.data, def) })
      .finally(() => { state.syncing = false; });
  });
}

// ---------------------------------------------------------------------------
// Диапазон дат и вкладки
// ---------------------------------------------------------------------------

function setRange(from, to, presetKey = null) {
  if (from > to) [from, to] = [to, from];
  // Не уходим за пределы всех данных. При сдвиге за край период упирается в него, сохраняя ширину.
  if (state.ind) {
    const first = toDate(state.ind.firstDate).getTime(), lastMs = toDate(state.ind.lastDate).getTime();
    let a = toDate(from).getTime(), b = toDate(to).getTime();
    if (b > lastMs) { a -= b - lastMs; b = lastMs; }
    if (a < first) { b = Math.min(lastMs, b + (first - a)); a = first; }
    from = toIso(new Date(a));
    to = toIso(new Date(b));
  }
  state.range = [from, to];
  $('#from').value = from;
  $('#to').value = to;
  document.querySelectorAll('.presets button').forEach((b) => {
    b.classList.toggle('active', b.dataset.preset === presetKey);
  });

  // Графики скрытой вкладки получат диапазон при следующем показе (renderCharts).
  state.syncing = true;
  Promise.all(tabCharts(state.tab).map((def) => {
    const el = document.getElementById(def.id);
    if (!el || !el.data) return null;
    return Plotly.relayout(el, axisUpdate(el.data, def));
  })).finally(() => { state.syncing = false; });
}

function applyPreset(key) {
  const { lastDate, firstDate } = state.ind;
  let from;
  if (key === 'all') from = firstDate;
  else if (key === '1985') from = DEFAULT_FROM;
  else {
    const d = toDate(lastDate);
    d.setUTCFullYear(d.getUTCFullYear() - Number(key));
    from = toIso(d);
  }
  setRange(from, lastDate, key);
}

function fillOverlayOptions() {
  $('#overlay').innerHTML = OVERLAYS[state.tab]
    .map(([v, label]) => `<option value="${v}" ${state.overlay[state.tab] === v ? 'selected' : ''}>${label}</option>`)
    .join('');
}

function renderTab() {
  if (!state.ind) return;
  renderCards(state.tab);
  renderCharts(state.tab);
}

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  if (state.fs) closeFullscreen();
  for (const t of Object.keys(TAB_BANDS)) {
    for (const part of ['toc', 'cards', 'charts']) {
      const node = document.getElementById(`${part}-${t}`);
      if (node) node.hidden = t !== tab;
    }
  }
  fillOverlayOptions();
  try { localStorage.setItem('semkin-tab', tab); } catch (e) { /* хранилище недоступно — не страшно */ }
  renderTab();
}

// ---------------------------------------------------------------------------
// Статический режим (GitHub Pages): зашифрованные данные и вход по паролю
// ---------------------------------------------------------------------------

/*
 * build_static.py кладёт рядом со страницей data.enc: 12 байт IV + AES-256-GCM(gzip(JSON)).
 * Ключ получается из пароля через PBKDF2-SHA256 — параметры совпадают с build_static.py.
 * Ключ (не пароль) можно сохранить в localStorage, чтобы не вводить пароль каждый раз.
 */
const STATIC_MODE = window.SEMKIN_STATIC === true;
const ENC_SALT = 'semkin-macro/v1';
const ENC_ITERATIONS = 600000;
const KEY_STORAGE = 'semkin-key';

async function deriveKey(password) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode(ENC_SALT), iterations: ENC_ITERATIONS, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, true, ['decrypt'],
  );
}

async function decryptData(key) {
  const resp = await fetch('data.enc', { cache: 'no-cache' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const blob = new Uint8Array(await resp.arrayBuffer());
  // Неверный ключ → исключение OperationError (тег AES-GCM не сходится).
  const zipped = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.slice(0, 12) }, key, blob.slice(12));
  const stream = new Blob([zipped]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

function savedKey() {
  try { return localStorage.getItem(KEY_STORAGE); } catch (e) { return null; }
}

async function importSavedKey(b64) {
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['decrypt']);
}

async function rememberKey(key) {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  try { localStorage.setItem(KEY_STORAGE, btoa(String.fromCharCode(...raw))); } catch (e) { /* не страшно */ }
}

function forgetKey() {
  try { localStorage.removeItem(KEY_STORAGE); } catch (e) { /* не страшно */ }
}

/** Показывает экран входа и ждёт правильный пароль. Возвращает расшифрованные данные. */
function askPassword() {
  $('#lock').hidden = false;
  $('#lock-password').focus();
  return new Promise((resolve) => {
    $('#lock-form').onsubmit = async (e) => {
      e.preventDefault();
      const btn = $('#lock-submit');
      btn.disabled = true;
      $('#lock-error').textContent = 'Проверяем пароль…';
      try {
        const key = await deriveKey($('#lock-password').value);
        const data = await decryptData(key);
        if ($('#lock-remember').checked) await rememberKey(key);
        $('#lock').hidden = true;
        resolve(data);
      } catch (err) {
        $('#lock-error').textContent = err.name === 'OperationError'
          ? 'Неверный пароль.' : `Не удалось загрузить данные: ${err.message}`;
      } finally {
        btn.disabled = false;
      }
    };
  });
}

/** Данные для статического режима: сохранённым ключом, иначе — через экран входа. */
async function loadStatic() {
  const b64 = savedKey();
  if (b64) {
    try {
      return await decryptData(await importSavedKey(b64));
    } catch (e) {
      forgetKey();  // пароль сменили — сохранённый ключ больше не подходит
    }
  }
  return askPassword();
}

// ---------------------------------------------------------------------------
// Загрузка и инициализация
// ---------------------------------------------------------------------------

async function load(force = false) {
  const status = $('#status');
  const btn = $('#refresh');
  btn.disabled = true;
  status.classList.remove('err');
  status.textContent = force ? 'Перекачиваем данные из источников…' : 'Загрузка данных…';
  try {
    if (STATIC_MODE) {
      state.raw = await loadStatic();
    } else {
      const resp = await fetch('/api/data' + (force ? '?refresh=1' : ''));
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      state.raw = await resp.json();
    }
    computeIndicators();
    // По умолчанию — вся история: каждый график начинается с начала своих данных.
    if (!state.range) state.range = [state.ind.firstDate, state.ind.lastDate];
    $('#from').value = state.range[0];
    $('#to').value = state.range[1];
    renderTab();
    renderStatus();
  } catch (e) {
    status.classList.add('err');
    status.textContent = `Не удалось загрузить данные: ${e.message}. Запущен ли server.py?`;
    console.error(e);
  } finally {
    btn.disabled = false;
  }
}

const SOURCE_NAMES = {
  finra_margin: 'маржинальный долг FINRA', sp500_history: 'история S&P 500', cftc_cot: 'COT CFTC',
  cftc_tff: 'TFF CFTC', finra_short: 'short interest FINRA', cboe_archive: 'put/call CBOE', fed_gz: 'GZ-спред ФРС',
  moex_indices: 'индексы Мосбиржи', moex_futoi: 'позиции Мосбиржи', cbr: 'Банк России',
  minfin_budget: 'бюджет Минфина', minfin_nwf: 'ФНБ Минфина', sipri: 'SIPRI',
};

function renderStatus() {
  const r = state.raw;
  const src = Object.entries(r.sources);
  const name = (k) => SOURCE_NAMES[k] || k.replace(/^fred_/, '');
  const failed = src.filter(([, s]) => s.cache === 'error').map(([k]) => name(k));
  const stale = src.filter(([, s]) => s.cache === 'stale').map(([k]) => name(k));
  const times = src.map(([, s]) => s.fetched_at).filter(Boolean);
  const when = times.length
    ? new Date(Math.min(...times) * 1000).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })
    : '—';
  const parts = STATIC_MODE
    ? [`данные обновлены ${new Date(r.generated_at * 1000).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}`,
      'обновляются автоматически каждый день']
    : [r.has_api_key ? 'FRED: API' : 'FRED: CSV без API-ключа', `самые старые данные в кэше: ${when}`];
  for (const [sid, label] of [['PC_EQUITY', 'put/call'], ['OFZ_10Y', 'кривой ОФЗ']]) {
    const s = r.series[sid];
    if (s && s.partial) parts.push(`история ${label} докачивается в фоне (${(s.note || '').split('докачка истории: ')[1] || '…'})`);
  }
  if (stale.length) parts.push(`устаревший кэш: ${stale.join(', ')}`);
  if (failed.length) parts.push(`нет данных: ${failed.join(', ')}`);
  const status = $('#status');
  status.textContent = parts.join(' · ');
  status.classList.toggle('err', failed.length > 0);
}

/** Кнопки и пустые панели (оглавление, сводка, графики) для вкладок стран из COUNTRIES. */
function createCountryTabs() {
  const nav = $('.tabs');
  let toc = $('#toc-ru'), cards = $('#cards-ru'), charts = $('#charts-ru');
  for (const c of COUNTRIES) {
    if (document.getElementById(`cards-${c.tab}`)) continue;
    nav.insertAdjacentHTML('beforeend', `<button role="tab" data-tab="${c.tab}" aria-selected="false">${c.name}</button>`);
    toc.insertAdjacentHTML('afterend', `<nav id="toc-${c.tab}" class="toc-wrap" aria-label="Содержание" hidden></nav>`);
    cards.insertAdjacentHTML('afterend', `<section id="cards-${c.tab}" class="tab-pane" aria-live="polite" hidden></section>`);
    charts.insertAdjacentHTML('afterend', `<div id="charts-${c.tab}" class="tab-pane" hidden></div>`);
    toc = document.getElementById(`toc-${c.tab}`);
    cards = document.getElementById(`cards-${c.tab}`);
    charts = document.getElementById(`charts-${c.tab}`);
  }
  nav.querySelectorAll('button').forEach((b) => {
    if (!b.dataset.bound) { b.dataset.bound = '1'; b.addEventListener('click', () => switchTab(b.dataset.tab)); }
  });
}

function init() {
  document.querySelectorAll('.presets button').forEach((b) => {
    b.addEventListener('click', () => state.ind && applyPreset(b.dataset.preset));
  });
  const onDateInput = () => {
    const from = $('#from').value, to = $('#to').value;
    if (from && to && state.ind) setRange(from, to);
  };
  $('#from').addEventListener('change', onDateInput);
  $('#to').addEventListener('change', onDateInput);

  // Новое окно ROC → пересчёт индикаторов, карточек и графиков.
  $('#window').addEventListener('change', () => {
    if (!state.raw) return;
    computeIndicators();
    renderTab();
  });

  // Наложение индекса → перерисовать графики активной вкладки.
  $('#overlay').addEventListener('change', (e) => {
    state.overlay[state.tab] = e.target.value;
    if (state.ind) renderCharts(state.tab);
  });

  // Кнопки вкладок подключаются в createCountryTabs().

  // Весь экран: кнопка ⛶ / ×, Esc, перерисовка при повороте экрана.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.fs-btn');
    if (btn) (state.fs === btn.dataset.chart ? closeFullscreen() : openFullscreen(btn.dataset.chart));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeFullscreen(); return; }
    if ((e.target instanceof Element && e.target.closest('input, select, textarea')) || !state.ind) return;
    // Стрелки: ← → — сдвиг, ↑ — приблизить, ↓ — отдалить (развёрнутый график или график под мышью).
    const el = document.getElementById(state.fs || state.hoverChart || '');
    if (!el || !el._fullLayout) return;
    const act = { ArrowLeft: () => panBy(el, -0.15), ArrowRight: () => panBy(el, 0.15),
      ArrowUp: () => zoomBy(el, 0.5), ArrowDown: () => zoomBy(el, 2) }[e.key];
    if (act) { e.preventDefault(); act(); }
  });
  // Перерисовка развёрнутого графика — только при смене ширины (поворот экрана, окно).
  // Высота на телефоне скачет, когда прячется адресная строка, — из-за этого подсказка пропадала.
  let lastWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    if (window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    if (state.fs) renderChart(CHARTS.find((c) => c.id === state.fs));
  });

  // Переходы из оглавления и карточек: сворачиваем полноэкранный режим и подсвечиваем цель.
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a) return;
    const target = document.querySelector(a.getAttribute('href'));
    if (!target) return;
    e.preventDefault();
    if (state.fs) closeFullscreen();
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target.classList.remove('flash');
    void target.offsetWidth;                        // перезапуск анимации
    target.classList.add('flash');
  });

  // Пояснение карточки — по клику на карточку (кроме ссылок) или на «?»; повторный клик закрывает.
  document.addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    const open = e.target.closest('.card');
    const wasOpen = open && open.classList.contains('tip-open');
    document.querySelectorAll('.card.tip-open').forEach((c) => c.classList.remove('tip-open'));
    if (open && !wasOpen) open.classList.add('tip-open');
  });

  $('#refresh').addEventListener('click', () => load(true));
  if (STATIC_MODE) {
    $('#refresh').hidden = true;  // данные пересобираются по расписанию, кнопке нечего делать
    $('#logout').hidden = false;
    $('#logout').addEventListener('click', () => { forgetKey(); location.reload(); });
  }

  const markTouch = () => document.documentElement.classList.toggle('touch', TOUCH.matches);
  markTouch();
  TOUCH.addEventListener('change', () => { markTouch(); if (state.ind) renderCharts(state.tab); });

  // Переход через ширину телефона (поворот экрана, изменение окна) → перерисовать графики.
  NARROW.addEventListener('change', () => state.ind && renderCharts(state.tab));

  // Смена системной темы → перерисовать графики новыми цветами.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => state.ind && renderCharts(state.tab));

  createCountryTabs();
  let saved = 'us';
  try { saved = localStorage.getItem('semkin-tab') || 'us'; } catch (e) { /* хранилище недоступно */ }
  switchTab(TAB_BANDS[saved] ? saved : 'us');
  load();
}

init();
