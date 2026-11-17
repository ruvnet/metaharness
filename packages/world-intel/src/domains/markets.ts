// MIT port of marc-shade/world-intel-mcp at fdebf9a8. See THIRD_PARTY_NOTICES.md.
const _DEFAULT_INDEX_SYMBOLS: any = ["^GSPC", "^DJI", "^IXIC", "^FTSE", "^N225", "^HSI", "^GDAXI"];
const _SECTOR_ETFS: any = { "XLK": "Technology", "XLF": "Financials", "XLE": "Energy", "XLV": "Healthcare", "XLI": "Industrials", "XLC": "Communication", "XLY": "Consumer Disc", "XLP": "Consumer Staples", "XLRE": "Real Estate", "XLU": "Utilities", "XLB": "Materials" };
const _COMMODITY_SYMBOLS: any = { "GC=F": "Gold", "SI=F": "Silver", "CL=F": "Crude Oil WTI", "BZ=F": "Brent Crude", "NG=F": "Natural Gas", "ZC=F": "Corn", "ZW=F": "Wheat", "ZS=F": "Soybeans" };
const _FRED_RATE_SERIES: any = { "fed_funds": { "series_id": "DFF", "bank": "Federal Reserve", "country": "USA", "currency": "USD", "label": "Federal Funds Rate" }, "ecb_deposit": { "series_id": "ECBDFR", "bank": "European Central Bank", "country": "EUR", "currency": "EUR", "label": "ECB Deposit Facility Rate" }, "boe_bank_rate": { "series_id": "IUDSOIA", "bank": "Bank of England", "country": "GBR", "currency": "GBP", "label": "BoE Bank Rate (SONIA)" } };
const _CURATED_RATES: any = [{ "bank": "Bank of Japan", "country": "JPN", "currency": "JPY", "label": "BoJ Policy Rate", "rate": 0.5, "as_of": "2025-01-24", "notes": "Short-term policy rate target" }, { "bank": "People's Bank of China", "country": "CHN", "currency": "CNY", "label": "PBoC LPR 1Y", "rate": 3.1, "as_of": "2025-01-20", "notes": "1-year Loan Prime Rate" }, { "bank": "Reserve Bank of India", "country": "IND", "currency": "INR", "label": "RBI Repo Rate", "rate": 6.5, "as_of": "2025-02-07", "notes": "Policy repo rate" }, { "bank": "Reserve Bank of Australia", "country": "AUS", "currency": "AUD", "label": "RBA Cash Rate", "rate": 4.35, "as_of": "2024-11-05", "notes": "Cash rate target" }, { "bank": "Bank of Canada", "country": "CAN", "currency": "CAD", "label": "BoC Overnight Rate", "rate": 3.25, "as_of": "2024-12-11", "notes": "Target for the overnight rate" }, { "bank": "Swiss National Bank", "country": "CHE", "currency": "CHF", "label": "SNB Policy Rate", "rate": 0.5, "as_of": "2024-12-12", "notes": "SNB policy rate" }, { "bank": "Central Bank of Brazil", "country": "BRA", "currency": "BRL", "label": "BCB SELIC", "rate": 13.25, "as_of": "2025-01-29", "notes": "SELIC target rate" }, { "bank": "Bank of Korea", "country": "KOR", "currency": "KRW", "label": "BoK Base Rate", "rate": 3.0, "as_of": "2025-01-16", "notes": "Base rate" }, { "bank": "Central Bank of Turkey", "country": "TUR", "currency": "TRY", "label": "CBRT Policy Rate", "rate": 45.0, "as_of": "2025-01-23", "notes": "1-week repo rate" }, { "bank": "South African Reserve Bank", "country": "ZAF", "currency": "ZAR", "label": "SARB Repo Rate", "rate": 7.75, "as_of": "2024-11-21", "notes": "Repurchase rate" }, { "bank": "Banco de México", "country": "MEX", "currency": "MXN", "label": "Banxico Target Rate", "rate": 10.0, "as_of": "2025-02-06", "notes": "Overnight interbank rate target" }, { "bank": "Bank Indonesia", "country": "IDN", "currency": "IDR", "label": "BI Rate", "rate": 5.75, "as_of": "2025-01-15", "notes": "BI-Rate" }];
const FRED_FALLBACK: any = [{ "bank": "Federal Reserve", "country": "USA", "currency": "USD", "label": "Federal Funds Rate", "rate": 4.5, "as_of": "2025-01-29", "notes": "Fed funds target rate (upper bound)" }, { "bank": "European Central Bank", "country": "EUR", "currency": "EUR", "label": "ECB Deposit Facility Rate", "rate": 2.75, "as_of": "2025-01-30", "notes": "Deposit facility rate" }, { "bank": "Bank of England", "country": "GBR", "currency": "GBP", "label": "BoE Bank Rate", "rate": 4.5, "as_of": "2025-02-06", "notes": "Bank rate" }];
const STOCK_EXCHANGES: any = [{ "name": "New York Stock Exchange", "acronym": "NYSE", "country": "USA", "iso3": "USA", "city": "New York", "lat": 40.71, "lon": -74.01, "tier": "mega", "market_cap_usd_t": 28.4, "index": "^DJI", "currency": "USD", "timezone": "America/New_York" }, { "name": "NASDAQ", "acronym": "NASDAQ", "country": "USA", "iso3": "USA", "city": "New York", "lat": 40.76, "lon": -73.99, "tier": "mega", "market_cap_usd_t": 25.5, "index": "^IXIC", "currency": "USD", "timezone": "America/New_York" }, { "name": "Shanghai Stock Exchange", "acronym": "SSE", "country": "China", "iso3": "CHN", "city": "Shanghai", "lat": 31.23, "lon": 121.47, "tier": "mega", "market_cap_usd_t": 6.9, "index": "000001.SS", "currency": "CNY", "timezone": "Asia/Shanghai" }, { "name": "Japan Exchange Group", "acronym": "JPX", "country": "Japan", "iso3": "JPN", "city": "Tokyo", "lat": 35.68, "lon": 139.77, "tier": "mega", "market_cap_usd_t": 6.5, "index": "^N225", "currency": "JPY", "timezone": "Asia/Tokyo" }, { "name": "Shenzhen Stock Exchange", "acronym": "SZSE", "country": "China", "iso3": "CHN", "city": "Shenzhen", "lat": 22.54, "lon": 114.06, "tier": "mega", "market_cap_usd_t": 4.9, "index": "399001.SZ", "currency": "CNY", "timezone": "Asia/Shanghai" }, { "name": "Hong Kong Exchanges", "acronym": "HKEX", "country": "China", "iso3": "HKG", "city": "Hong Kong", "lat": 22.28, "lon": 114.16, "tier": "mega", "market_cap_usd_t": 4.6, "index": "^HSI", "currency": "HKD", "timezone": "Asia/Hong_Kong" }, { "name": "National Stock Exchange of India", "acronym": "NSE", "country": "India", "iso3": "IND", "city": "Mumbai", "lat": 19.06, "lon": 72.86, "tier": "mega", "market_cap_usd_t": 4.3, "index": "^NSEI", "currency": "INR", "timezone": "Asia/Kolkata" }, { "name": "London Stock Exchange", "acronym": "LSE", "country": "UK", "iso3": "GBR", "city": "London", "lat": 51.51, "lon": -0.09, "tier": "mega", "market_cap_usd_t": 3.4, "index": "^FTSE", "currency": "GBP", "timezone": "Europe/London" }, { "name": "Euronext", "acronym": "ENX", "country": "Netherlands", "iso3": "NLD", "city": "Amsterdam", "lat": 52.37, "lon": 4.89, "tier": "mega", "market_cap_usd_t": 7.3, "index": "^AEX", "currency": "EUR", "timezone": "Europe/Amsterdam" }, { "name": "Toronto Stock Exchange", "acronym": "TSX", "country": "Canada", "iso3": "CAN", "city": "Toronto", "lat": 43.65, "lon": -79.38, "tier": "major", "market_cap_usd_t": 2.8, "index": "^GSPTSE", "currency": "CAD", "timezone": "America/Toronto" }, { "name": "Saudi Exchange (Tadawul)", "acronym": "TADAWUL", "country": "Saudi Arabia", "iso3": "SAU", "city": "Riyadh", "lat": 24.71, "lon": 46.67, "tier": "major", "market_cap_usd_t": 2.9, "index": "^TASI", "currency": "SAR", "timezone": "Asia/Riyadh" }, { "name": "Deutsche Börse", "acronym": "XETRA", "country": "Germany", "iso3": "DEU", "city": "Frankfurt", "lat": 50.11, "lon": 8.68, "tier": "major", "market_cap_usd_t": 2.3, "index": "^GDAXI", "currency": "EUR", "timezone": "Europe/Berlin" }, { "name": "SIX Swiss Exchange", "acronym": "SIX", "country": "Switzerland", "iso3": "CHE", "city": "Zurich", "lat": 47.37, "lon": 8.54, "tier": "major", "market_cap_usd_t": 1.9, "index": "^SSMI", "currency": "CHF", "timezone": "Europe/Zurich" }, { "name": "Korea Exchange", "acronym": "KRX", "country": "South Korea", "iso3": "KOR", "city": "Seoul", "lat": 37.52, "lon": 126.93, "tier": "major", "market_cap_usd_t": 1.8, "index": "^KS11", "currency": "KRW", "timezone": "Asia/Seoul" }, { "name": "Nasdaq Nordic (OMX)", "acronym": "OMX", "country": "Sweden", "iso3": "SWE", "city": "Stockholm", "lat": 59.33, "lon": 18.07, "tier": "major", "market_cap_usd_t": 1.7, "index": "^OMX", "currency": "SEK", "timezone": "Europe/Stockholm" }, { "name": "Australian Securities Exchange", "acronym": "ASX", "country": "Australia", "iso3": "AUS", "city": "Sydney", "lat": -33.87, "lon": 151.21, "tier": "major", "market_cap_usd_t": 1.6, "index": "^AXJO", "currency": "AUD", "timezone": "Australia/Sydney" }, { "name": "Taiwan Stock Exchange", "acronym": "TWSE", "country": "Taiwan", "iso3": "TWN", "city": "Taipei", "lat": 25.03, "lon": 121.52, "tier": "major", "market_cap_usd_t": 2.1, "index": "^TWII", "currency": "TWD", "timezone": "Asia/Taipei" }, { "name": "Bombay Stock Exchange", "acronym": "BSE", "country": "India", "iso3": "IND", "city": "Mumbai", "lat": 18.93, "lon": 72.83, "tier": "major", "market_cap_usd_t": 4.1, "index": "^BSESN", "currency": "INR", "timezone": "Asia/Kolkata" }, { "name": "Johannesburg Stock Exchange", "acronym": "JSE", "country": "South Africa", "iso3": "ZAF", "city": "Johannesburg", "lat": -26.2, "lon": 28.04, "tier": "major", "market_cap_usd_t": 1.1, "index": "^J203", "currency": "ZAR", "timezone": "Africa/Johannesburg" }, { "name": "B3 (Brasil Bolsa Balcão)", "acronym": "B3", "country": "Brazil", "iso3": "BRA", "city": "São Paulo", "lat": -23.55, "lon": -46.63, "tier": "major", "market_cap_usd_t": 0.9, "index": "^BVSP", "currency": "BRL", "timezone": "America/Sao_Paulo" }, { "name": "Borsa Italiana", "acronym": "BIT", "country": "Italy", "iso3": "ITA", "city": "Milan", "lat": 45.46, "lon": 9.19, "tier": "major", "market_cap_usd_t": 0.8, "index": "FTSEMIB.MI", "currency": "EUR", "timezone": "Europe/Rome" }, { "name": "BME Spanish Exchanges", "acronym": "BME", "country": "Spain", "iso3": "ESP", "city": "Madrid", "lat": 40.42, "lon": -3.7, "tier": "major", "market_cap_usd_t": 0.7, "index": "^IBEX", "currency": "EUR", "timezone": "Europe/Madrid" }, { "name": "Singapore Exchange", "acronym": "SGX", "country": "Singapore", "iso3": "SGP", "city": "Singapore", "lat": 1.28, "lon": 103.85, "tier": "major", "market_cap_usd_t": 0.6, "index": "^STI", "currency": "SGD", "timezone": "Asia/Singapore" }, { "name": "Bolsa Mexicana de Valores", "acronym": "BMV", "country": "Mexico", "iso3": "MEX", "city": "Mexico City", "lat": 19.43, "lon": -99.13, "tier": "major", "market_cap_usd_t": 0.5, "index": "^MXX", "currency": "MXN", "timezone": "America/Mexico_City" }, { "name": "Tel Aviv Stock Exchange", "acronym": "TASE", "country": "Israel", "iso3": "ISR", "city": "Tel Aviv", "lat": 32.07, "lon": 34.77, "tier": "major", "market_cap_usd_t": 0.3, "index": "^TA125", "currency": "ILS", "timezone": "Asia/Jerusalem" }, { "name": "Indonesia Stock Exchange", "acronym": "IDX", "country": "Indonesia", "iso3": "IDN", "city": "Jakarta", "lat": -6.22, "lon": 106.85, "tier": "emerging", "market_cap_usd_t": 0.6, "index": "^JKSE", "currency": "IDR", "timezone": "Asia/Jakarta" }, { "name": "Bursa Malaysia", "acronym": "BM", "country": "Malaysia", "iso3": "MYS", "city": "Kuala Lumpur", "lat": 3.15, "lon": 101.71, "tier": "emerging", "market_cap_usd_t": 0.4, "index": "^KLSE", "currency": "MYR", "timezone": "Asia/Kuala_Lumpur" }, { "name": "Stock Exchange of Thailand", "acronym": "SET", "country": "Thailand", "iso3": "THA", "city": "Bangkok", "lat": 13.76, "lon": 100.5, "tier": "emerging", "market_cap_usd_t": 0.5, "index": "^SET", "currency": "THB", "timezone": "Asia/Bangkok" }, { "name": "Philippine Stock Exchange", "acronym": "PSE", "country": "Philippines", "iso3": "PHL", "city": "Manila", "lat": 14.59, "lon": 120.98, "tier": "emerging", "market_cap_usd_t": 0.3, "index": "PSEI.PS", "currency": "PHP", "timezone": "Asia/Manila" }, { "name": "Ho Chi Minh Stock Exchange", "acronym": "HOSE", "country": "Vietnam", "iso3": "VNM", "city": "Ho Chi Minh City", "lat": 10.77, "lon": 106.7, "tier": "emerging", "market_cap_usd_t": 0.2, "index": "^VNINDEX", "currency": "VND", "timezone": "Asia/Ho_Chi_Minh" }, { "name": "Colombo Stock Exchange", "acronym": "CSE", "country": "Sri Lanka", "iso3": "LKA", "city": "Colombo", "lat": 6.93, "lon": 79.84, "tier": "emerging", "market_cap_usd_t": 0.02, "index": "^CSE", "currency": "LKR", "timezone": "Asia/Colombo" }, { "name": "Abu Dhabi Securities Exchange", "acronym": "ADX", "country": "UAE", "iso3": "ARE", "city": "Abu Dhabi", "lat": 24.45, "lon": 54.65, "tier": "emerging", "market_cap_usd_t": 0.8, "index": "^ADI", "currency": "AED", "timezone": "Asia/Dubai" }, { "name": "Dubai Financial Market", "acronym": "DFM", "country": "UAE", "iso3": "ARE", "city": "Dubai", "lat": 25.2, "lon": 55.27, "tier": "emerging", "market_cap_usd_t": 0.2, "index": "^DFMGI", "currency": "AED", "timezone": "Asia/Dubai" }, { "name": "Qatar Stock Exchange", "acronym": "QSE", "country": "Qatar", "iso3": "QAT", "city": "Doha", "lat": 25.29, "lon": 51.53, "tier": "emerging", "market_cap_usd_t": 0.2, "index": "^QSI", "currency": "QAR", "timezone": "Asia/Qatar" }, { "name": "Kuwait Stock Exchange", "acronym": "BK", "country": "Kuwait", "iso3": "KWT", "city": "Kuwait City", "lat": 29.38, "lon": 47.99, "tier": "emerging", "market_cap_usd_t": 0.1, "index": "^BKP", "currency": "KWD", "timezone": "Asia/Kuwait" }, { "name": "Bahrain Bourse", "acronym": "BHB", "country": "Bahrain", "iso3": "BHR", "city": "Manama", "lat": 26.22, "lon": 50.59, "tier": "emerging", "market_cap_usd_t": 0.03, "index": "^BAX", "currency": "BHD", "timezone": "Asia/Bahrain" }, { "name": "Muscat Securities Market", "acronym": "MSM", "country": "Oman", "iso3": "OMN", "city": "Muscat", "lat": 23.61, "lon": 58.59, "tier": "emerging", "market_cap_usd_t": 0.03, "index": "^MSI", "currency": "OMR", "timezone": "Asia/Muscat" }, { "name": "Casablanca Stock Exchange", "acronym": "CSE", "country": "Morocco", "iso3": "MAR", "city": "Casablanca", "lat": 33.59, "lon": -7.62, "tier": "emerging", "market_cap_usd_t": 0.07, "index": "^MASI", "currency": "MAD", "timezone": "Africa/Casablanca" }, { "name": "Egyptian Exchange", "acronym": "EGX", "country": "Egypt", "iso3": "EGY", "city": "Cairo", "lat": 30.04, "lon": 31.24, "tier": "emerging", "market_cap_usd_t": 0.04, "index": "^EGX30", "currency": "EGP", "timezone": "Africa/Cairo" }, { "name": "Nairobi Securities Exchange", "acronym": "NSE", "country": "Kenya", "iso3": "KEN", "city": "Nairobi", "lat": -1.29, "lon": 36.82, "tier": "emerging", "market_cap_usd_t": 0.02, "index": "^NSE20", "currency": "KES", "timezone": "Africa/Nairobi" }, { "name": "Nigerian Exchange", "acronym": "NGX", "country": "Nigeria", "iso3": "NGA", "city": "Lagos", "lat": 6.45, "lon": 3.4, "tier": "emerging", "market_cap_usd_t": 0.04, "index": "^NGSE", "currency": "NGN", "timezone": "Africa/Lagos" }, { "name": "Santiago Stock Exchange", "acronym": "BCS", "country": "Chile", "iso3": "CHL", "city": "Santiago", "lat": -33.44, "lon": -70.66, "tier": "emerging", "market_cap_usd_t": 0.2, "index": "^IPSA", "currency": "CLP", "timezone": "America/Santiago" }, { "name": "Buenos Aires Stock Exchange", "acronym": "BCBA", "country": "Argentina", "iso3": "ARG", "city": "Buenos Aires", "lat": -34.61, "lon": -58.37, "tier": "emerging", "market_cap_usd_t": 0.06, "index": "^MERV", "currency": "ARS", "timezone": "America/Argentina/Buenos_Aires" }, { "name": "Lima Stock Exchange", "acronym": "BVL", "country": "Peru", "iso3": "PER", "city": "Lima", "lat": -12.05, "lon": -77.04, "tier": "emerging", "market_cap_usd_t": 0.08, "index": "^SPBLPGPT", "currency": "PEN", "timezone": "America/Lima" }, { "name": "Colombia Stock Exchange", "acronym": "BVC", "country": "Colombia", "iso3": "COL", "city": "Bogotá", "lat": 4.71, "lon": -74.07, "tier": "emerging", "market_cap_usd_t": 0.07, "index": "^COLCAP", "currency": "COP", "timezone": "America/Bogota" }, { "name": "Warsaw Stock Exchange", "acronym": "WSE", "country": "Poland", "iso3": "POL", "city": "Warsaw", "lat": 52.23, "lon": 21.01, "tier": "emerging", "market_cap_usd_t": 0.2, "index": "^WIG20", "currency": "PLN", "timezone": "Europe/Warsaw" }, { "name": "Moscow Exchange", "acronym": "MOEX", "country": "Russia", "iso3": "RUS", "city": "Moscow", "lat": 55.76, "lon": 37.62, "tier": "emerging", "market_cap_usd_t": 0.6, "index": "IMOEX.ME", "currency": "RUB", "timezone": "Europe/Moscow" }, { "name": "Istanbul Stock Exchange", "acronym": "BIST", "country": "Turkey", "iso3": "TUR", "city": "Istanbul", "lat": 41.01, "lon": 28.98, "tier": "emerging", "market_cap_usd_t": 0.3, "index": "^XU100", "currency": "TRY", "timezone": "Europe/Istanbul" }, { "name": "Athens Stock Exchange", "acronym": "ATHEX", "country": "Greece", "iso3": "GRC", "city": "Athens", "lat": 37.98, "lon": 23.73, "tier": "emerging", "market_cap_usd_t": 0.08, "index": "^ATG", "currency": "EUR", "timezone": "Europe/Athens" }, { "name": "Bucharest Stock Exchange", "acronym": "BVB", "country": "Romania", "iso3": "ROU", "city": "Bucharest", "lat": 44.43, "lon": 26.1, "tier": "emerging", "market_cap_usd_t": 0.06, "index": "^BET", "currency": "RON", "timezone": "Europe/Bucharest" }, { "name": "Prague Stock Exchange", "acronym": "PSE", "country": "Czech Republic", "iso3": "CZE", "city": "Prague", "lat": 50.08, "lon": 14.43, "tier": "emerging", "market_cap_usd_t": 0.03, "index": "^PX", "currency": "CZK", "timezone": "Europe/Prague" }, { "name": "Budapest Stock Exchange", "acronym": "BSE", "country": "Hungary", "iso3": "HUN", "city": "Budapest", "lat": 47.5, "lon": 19.04, "tier": "emerging", "market_cap_usd_t": 0.04, "index": "^BUX", "currency": "HUF", "timezone": "Europe/Budapest" }, { "name": "Pakistan Stock Exchange", "acronym": "PSX", "country": "Pakistan", "iso3": "PAK", "city": "Karachi", "lat": 24.85, "lon": 67.01, "tier": "emerging", "market_cap_usd_t": 0.04, "index": "^KSE100", "currency": "PKR", "timezone": "Asia/Karachi" }, { "name": "Dhaka Stock Exchange", "acronym": "DSE", "country": "Bangladesh", "iso3": "BGD", "city": "Dhaka", "lat": 23.73, "lon": 90.39, "tier": "emerging", "market_cap_usd_t": 0.05, "index": "^DSEX", "currency": "BDT", "timezone": "Asia/Dhaka" }, { "name": "Amman Stock Exchange", "acronym": "ASE", "country": "Jordan", "iso3": "JOR", "city": "Amman", "lat": 31.95, "lon": 35.93, "tier": "frontier", "market_cap_usd_t": 0.02, "index": "^AMGNRLX", "currency": "JOD", "timezone": "Asia/Amman" }, { "name": "Tunis Stock Exchange", "acronym": "BVMT", "country": "Tunisia", "iso3": "TUN", "city": "Tunis", "lat": 36.8, "lon": 10.18, "tier": "frontier", "market_cap_usd_t": 0.01, "index": "^TUNINDEX", "currency": "TND", "timezone": "Africa/Tunis" }, { "name": "Dar es Salaam Stock Exchange", "acronym": "DSE", "country": "Tanzania", "iso3": "TZA", "city": "Dar es Salaam", "lat": -6.79, "lon": 39.28, "tier": "frontier", "market_cap_usd_t": 0.01, "index": "^DSI", "currency": "TZS", "timezone": "Africa/Dar_es_Salaam" }, { "name": "Uganda Securities Exchange", "acronym": "USE", "country": "Uganda", "iso3": "UGA", "city": "Kampala", "lat": 0.31, "lon": 32.58, "tier": "frontier", "market_cap_usd_t": 0.005, "index": "^ALSI", "currency": "UGX", "timezone": "Africa/Kampala" }, { "name": "Rwanda Stock Exchange", "acronym": "RSE", "country": "Rwanda", "iso3": "RWA", "city": "Kigali", "lat": -1.94, "lon": 30.06, "tier": "frontier", "market_cap_usd_t": 0.003, "index": "^RSI", "currency": "RWF", "timezone": "Africa/Kigali" }, { "name": "Ghana Stock Exchange", "acronym": "GSE", "country": "Ghana", "iso3": "GHA", "city": "Accra", "lat": 5.56, "lon": -0.19, "tier": "frontier", "market_cap_usd_t": 0.01, "index": "^GGSECI", "currency": "GHS", "timezone": "Africa/Accra" }, { "name": "Zimbabwe Stock Exchange", "acronym": "ZSE", "country": "Zimbabwe", "iso3": "ZWE", "city": "Harare", "lat": -17.83, "lon": 31.05, "tier": "frontier", "market_cap_usd_t": 0.003, "index": "^ZSI", "currency": "ZWL", "timezone": "Africa/Harare" }, { "name": "Botswana Stock Exchange", "acronym": "BSE", "country": "Botswana", "iso3": "BWA", "city": "Gaborone", "lat": -24.65, "lon": 25.91, "tier": "frontier", "market_cap_usd_t": 0.004, "index": "^DCI", "currency": "BWP", "timezone": "Africa/Gaborone" }, { "name": "Lusaka Securities Exchange", "acronym": "LuSE", "country": "Zambia", "iso3": "ZMB", "city": "Lusaka", "lat": -15.39, "lon": 28.32, "tier": "frontier", "market_cap_usd_t": 0.005, "index": "^LASI", "currency": "ZMW", "timezone": "Africa/Lusaka" }, { "name": "Mauritius Stock Exchange", "acronym": "SEM", "country": "Mauritius", "iso3": "MUS", "city": "Port Louis", "lat": -20.16, "lon": 57.5, "tier": "frontier", "market_cap_usd_t": 0.01, "index": "^SEMDEX", "currency": "MUR", "timezone": "Indian/Mauritius" }, { "name": "Nepal Stock Exchange", "acronym": "NEPSE", "country": "Nepal", "iso3": "NPL", "city": "Kathmandu", "lat": 27.71, "lon": 85.32, "tier": "frontier", "market_cap_usd_t": 0.02, "index": "^NEPSE", "currency": "NPR", "timezone": "Asia/Kathmandu" }, { "name": "Cambodia Securities Exchange", "acronym": "CSX", "country": "Cambodia", "iso3": "KHM", "city": "Phnom Penh", "lat": 11.56, "lon": 104.93, "tier": "frontier", "market_cap_usd_t": 0.003, "index": "^CSXI", "currency": "KHR", "timezone": "Asia/Phnom_Penh" }, { "name": "Lao Securities Exchange", "acronym": "LSX", "country": "Laos", "iso3": "LAO", "city": "Vientiane", "lat": 17.97, "lon": 102.63, "tier": "frontier", "market_cap_usd_t": 0.001, "index": "^LSXI", "currency": "LAK", "timezone": "Asia/Vientiane" }, { "name": "Mongolia Stock Exchange", "acronym": "MSE", "country": "Mongolia", "iso3": "MNG", "city": "Ulaanbaatar", "lat": 47.92, "lon": 106.91, "tier": "frontier", "market_cap_usd_t": 0.002, "index": "^MNT20", "currency": "MNT", "timezone": "Asia/Ulaanbaatar" }, { "name": "Tehran Stock Exchange", "acronym": "TSE", "country": "Iran", "iso3": "IRN", "city": "Tehran", "lat": 35.69, "lon": 51.42, "tier": "emerging", "market_cap_usd_t": 0.2, "index": "^TEDPIX", "currency": "IRR", "timezone": "Asia/Tehran" }, { "name": "Karachi Stock Exchange (merged into PSX)", "acronym": "KSE", "country": "Pakistan", "iso3": "PAK", "city": "Karachi", "lat": 24.85, "lon": 67.01, "tier": "emerging", "market_cap_usd_t": 0.0, "index": "", "currency": "PKR", "timezone": "Asia/Karachi" }, { "name": "Colombo Stock Exchange", "acronym": "CSE", "country": "Sri Lanka", "iso3": "LKA", "city": "Colombo", "lat": 6.93, "lon": 79.85, "tier": "frontier", "market_cap_usd_t": 0.02, "index": "^ASPI", "currency": "LKR", "timezone": "Asia/Colombo" }, { "name": "New Zealand Exchange", "acronym": "NZX", "country": "New Zealand", "iso3": "NZL", "city": "Wellington", "lat": -41.29, "lon": 174.78, "tier": "major", "market_cap_usd_t": 0.1, "index": "^NZ50", "currency": "NZD", "timezone": "Pacific/Auckland" }, { "name": "Oslo Stock Exchange", "acronym": "OSE", "country": "Norway", "iso3": "NOR", "city": "Oslo", "lat": 59.91, "lon": 10.75, "tier": "major", "market_cap_usd_t": 0.3, "index": "^OBX", "currency": "NOK", "timezone": "Europe/Oslo" }, { "name": "Copenhagen Stock Exchange", "acronym": "CSE", "country": "Denmark", "iso3": "DNK", "city": "Copenhagen", "lat": 55.68, "lon": 12.57, "tier": "major", "market_cap_usd_t": 0.7, "index": "^OMXC25", "currency": "DKK", "timezone": "Europe/Copenhagen" }, { "name": "Helsinki Stock Exchange", "acronym": "OMXH", "country": "Finland", "iso3": "FIN", "city": "Helsinki", "lat": 60.17, "lon": 24.94, "tier": "major", "market_cap_usd_t": 0.3, "index": "^OMXH25", "currency": "EUR", "timezone": "Europe/Helsinki" }, { "name": "Vienna Stock Exchange", "acronym": "VSE", "country": "Austria", "iso3": "AUT", "city": "Vienna", "lat": 48.21, "lon": 16.37, "tier": "emerging", "market_cap_usd_t": 0.1, "index": "^ATX", "currency": "EUR", "timezone": "Europe/Vienna" }, { "name": "Lisbon Stock Exchange (Euronext)", "acronym": "ELX", "country": "Portugal", "iso3": "PRT", "city": "Lisbon", "lat": 38.72, "lon": -9.14, "tier": "emerging", "market_cap_usd_t": 0.08, "index": "^PSI20", "currency": "EUR", "timezone": "Europe/Lisbon" }, { "name": "Brussels Stock Exchange (Euronext)", "acronym": "EBR", "country": "Belgium", "iso3": "BEL", "city": "Brussels", "lat": 50.85, "lon": 4.35, "tier": "major", "market_cap_usd_t": 0.3, "index": "^BFX", "currency": "EUR", "timezone": "Europe/Brussels" }, { "name": "Irish Stock Exchange (Euronext)", "acronym": "ISE", "country": "Ireland", "iso3": "IRL", "city": "Dublin", "lat": 53.35, "lon": -6.26, "tier": "emerging", "market_cap_usd_t": 0.1, "index": "^ISEQ", "currency": "EUR", "timezone": "Europe/Dublin" }, { "name": "Zagreb Stock Exchange", "acronym": "ZSE", "country": "Croatia", "iso3": "HRV", "city": "Zagreb", "lat": 45.81, "lon": 15.98, "tier": "frontier", "market_cap_usd_t": 0.03, "index": "^CRBEX", "currency": "EUR", "timezone": "Europe/Zagreb" }, { "name": "Ljubljana Stock Exchange", "acronym": "LJSE", "country": "Slovenia", "iso3": "SVN", "city": "Ljubljana", "lat": 46.05, "lon": 14.51, "tier": "frontier", "market_cap_usd_t": 0.01, "index": "^SBITOP", "currency": "EUR", "timezone": "Europe/Ljubljana" }, { "name": "Beirut Stock Exchange", "acronym": "BSE", "country": "Lebanon", "iso3": "LBN", "city": "Beirut", "lat": 33.89, "lon": 35.5, "tier": "frontier", "market_cap_usd_t": 0.003, "index": "^BLOM", "currency": "LBP", "timezone": "Asia/Beirut" }];
export type MarketObject = Record<string, any>;
export interface MarketOptions {
    fetch?: typeof globalThis.fetch;
    now?: () => number;
    fredApiKey?: string;
    eiaApiKey?: string;
    timeoutMs?: number;
    maxBytes?: number;
}
export type MarketHandler = (args: MarketObject) => Promise<MarketObject>;
const COUNTRY_INDEX_TICKERS: Record<string, string> = { ...Object.fromEntries(STOCK_EXCHANGES.filter((x: any) => x.index && ["mega", "major"].includes(x.tier)).map((x: any) => [x.iso3, x.index])), USA: "^GSPC", CHN: "000001.SS", IND: "^NSEI", ARE: "^ADI" };
const obj = (x: any): MarketObject => x && typeof x === 'object' && !Array.isArray(x) ? x : {};
const finite = (x: any): number | null => x === null || x === undefined || x === '' || x === '.' || !Number.isFinite(Number(x)) ? null : Number(x);
// Python uses bankers rounding; round ties to nearest even for financial parity.
export function pyRound(x: number, n = 0): number {
    if (!Number.isFinite(x) || x === 0) return x;
    if (!Number.isInteger(n) || Math.abs(n) > 100) throw new Error('Unsupported rounding precision');
    // Round the exact IEEE-754 value, not x*10**n (which introduces another rounding).
    // This matches Python's round(2.675, 2) === 2.67 as well as halfway-to-even.
    const buffer = new ArrayBuffer(8), view = new DataView(buffer);
    view.setFloat64(0, Math.abs(x));
    const bits = view.getBigUint64(0), exponent = Number((bits >> 52n) & 2047n);
    let numerator = bits & ((1n << 52n) - 1n), denominator = 1n;
    if (exponent) numerator |= 1n << 52n;
    const power = (exponent || 1) - 1023 - 52;
    if (power >= 0) numerator <<= BigInt(power); else denominator <<= BigInt(-power);
    if (n >= 0) numerator *= 10n ** BigInt(n); else denominator *= 10n ** BigInt(-n);
    let q = numerator / denominator;
    const remainder = numerator % denominator;
    if (2n * remainder > denominator || (2n * remainder === denominator && q % 2n !== 0n)) q++;
    const rounded = Number(q) / 10 ** n;
    return x < 0 ? -rounded : rounded;
}

const list = (x: any): any[] => Array.isArray(x) ? x : [];
const paths: Record<string, RegExp> = {
    'soa.smext.faa.gov': /^\/asws\/api\/airport\/status\/[A-Z]{3}$/,
    'api.adsb.lol': /^\/v2\/mil$/,
    'opensky-network.org': /^\/api\/states\/all$/,
    'query1.finance.yahoo.com': /^\/v8\/finance\/chart\/[A-Za-z0-9%_^=.+-]{1,100}$/,
    'api.coingecko.com': /^\/api\/v3\/(coins\/(markets|bitcoin\/market_chart)|global)$/,
    'api.alternative.me': /^\/fng\/$/, 'mempool.space': /^\/api\/v1\/fees\/recommended$/,
    'api.worldbank.org': /^\/v2\/country\/[A-Za-z]{2,3}\/indicator\/[A-Za-z0-9.]{1,100}$/,
    'api.stlouisfed.org': /^\/fred\/series\/observations$/, 'gasprices.aaa.com': /^\/$/,
    'api.eia.gov': /^\/v2\/(petroleum\/pri\/spt|natural-gas\/pri\/(fut|sum)|electricity\/retail-sales)\/data\/$/,
    'fred.stlouisfed.org': /^\/graph\/fredgraph.csv$/,
    'data-api.ecb.europa.eu': /^\/service\/data\/(BSI|ILM)\/[A-Za-z0-9.+_]{1,200}$/,
};
/** Fixed-origin, bounded transport. Credentials must be explicitly supplied, never discovered. */
export class MarketTransport {
    readonly now: () => number;
    private fetcher: typeof globalThis.fetch;
    private cache = new Map<string, {
        time: number;
        text: string;
    }>();
    private queues = new Map<string, Promise<void>>();
    private last = new Map<string, number>();
    stale(url: URL): {
        time: number;
        text: string;
    } | undefined { return this.cache.get(url.href); }
    constructor(readonly options: MarketOptions = {}) { if (options.maxBytes !== undefined && (!Number.isInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 16000000))
        throw new Error('maxBytes must be 1..16000000'); if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 60000))
        throw new Error('timeoutMs must be 1..60000'); this.now = options.now ?? Date.now; this.fetcher = options.fetch ?? globalThis.fetch; }
    async text(url: URL, ttl = 300): Promise<string | null> {
        if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || !paths[url.hostname]?.test(url.pathname) || url.href.length > 4096)
            throw new Error('Source URL outside fixed allowlist');
        const key = url.href, c = this.cache.get(key);
        if (c && this.now() - c.time < ttl * 1000)
            return c.text;
        const origin = url.hostname;
        const floor = origin === 'fred.stlouisfed.org' ? 1000 : origin === 'query1.finance.yahoo.com' ? 500 : 0;
        // Injected fixture transports need no wall-clock provider pacing.
        if (floor && !this.options.fetch) {
            const prior = this.queues.get(origin) ?? Promise.resolve();
            let release!: () => void;
            const gate = new Promise<void>(r => release = r);
            this.queues.set(origin, prior.then(() => gate));
            await prior;
            const wait = Math.max(0, (this.last.get(origin) ?? 0) + floor - Date.now());
            if (wait)
                await new Promise(r => setTimeout(r, wait));
            this.last.set(origin, Date.now());
            release();
        }
        const ctrl = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { ctrl.abort(); reject(new Error('Source timeout')); }, this.options.timeoutMs ?? 15000); });
            const read = async () => {
                const r = await this.fetcher(url, { signal: ctrl.signal, redirect: 'error', credentials: 'omit', headers: { 'User-Agent': 'world-intel-mcp (https://github.com/marc-shade/world-intel-mcp)', 'Accept': 'application/json, text/csv, text/html' } });
                if (!r.ok) {
                    await r.body?.cancel();
                    return null;
                }
                const reader = r.body?.getReader();
                if (!reader)
                    return null;
                let length = 0;
                const chunks: Uint8Array[] = [];
                const abort = () => { void reader.cancel(); };
                ctrl.signal.addEventListener('abort', abort, { once: true });
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done)
                            break;
                        length += value.byteLength;
                        if (length > (this.options.maxBytes ?? 4000000)) {
                            await reader.cancel();
                            throw new Error('Source body too large');
                        }
                        chunks.push(value);
                    }
                    if (ctrl.signal.aborted)
                        throw new Error('Source timeout');
                }
                finally {
                    ctrl.signal.removeEventListener('abort', abort);
                    reader.releaseLock();
                }
                const bytes = new Uint8Array(length);
                let off = 0;
                for (const ch of chunks) {
                    bytes.set(ch, off);
                    off += ch.length;
                }
                return new TextDecoder().decode(bytes);
            };
            const text = await Promise.race([read(), timeout]);
            if (text !== null) {
                if (this.cache.size >= 100)
                    this.cache.delete(this.cache.keys().next().value!);
                this.cache.set(key, { time: this.now(), text });
            }
            return text;
        }
        catch {
            return null;
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    }
    async json(url: URL, ttl = 300): Promise<any> { const t = await this.text(url, ttl); if (t === null)
        return null; try {
        return JSON.parse(t);
    }
    catch {
        return null;
    } }
    timestamp() { return new Date(this.now()).toISOString(); }
    url(base: string, params: Record<string, any> = {}): URL { const u = new URL(base); for (const [k, v] of Object.entries(params))
        for (const item of Array.isArray(v) ? v : [v])
            u.searchParams.append(k, String(item)); return u; }
}
export function createMarketHandlers(options: MarketOptions = {}): Record<string, MarketHandler> {
    const tr = new MarketTransport(options), stamp = () => tr.timestamp();
    const quote = async (symbol: string): Promise<MarketObject | null> => { if (typeof symbol !== 'string' || !/^[-A-Za-z0-9^=._]{1,30}$/.test(symbol))
        throw new Error('Invalid ticker'); const d = await tr.json(tr.url(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`, { range: '1d', interval: '5m' }), 120); const m = d?.chart?.result?.[0]?.meta; if (!m)
        return null; const price = m.regularMarketPrice ?? null; let change = m.regularMarketChangePercent ?? null; const prev = m.previousClose || m.chartPreviousClose; if (change === null && price !== null && prev > 0)
        change = pyRound((price - prev) / prev * 100, 4); return { symbol, price, change_pct: change, currency: m.currency ?? null, _volume: m.regularMarketVolume ?? null }; };
    const clean = (q: MarketObject) => { const { _volume, ...r } = q; return r; };
    const quotes = async (symbols: any) => { symbols = symbols?.length ? symbols : _DEFAULT_INDEX_SYMBOLS; if (!Array.isArray(symbols) || symbols.length > 100)
        throw new Error('symbols must contain at most100 tickers'); return (await Promise.all(symbols.map(quote))).filter((q): q is MarketObject => q !== null); };
    const cg = async (params: MarketObject) => tr.json(tr.url('https://api.coingecko.com/api/v3/coins/markets', params), 180);
    const eia = (path: string, params: MarketObject) => tr.json(tr.url(`https://api.eia.gov/v2/${path}/data/`, { api_key: options.eiaApiKey, ...params }), 3600);
    const baseEia = { frequency: 'monthly', 'data[0]': 'value', 'sort[0][column]': 'period', 'sort[0][direction]': 'desc' };
    const fred = async (series_id: string, limit: number) => { if (!/^[A-Za-z0-9_]{1,80}$/.test(series_id) || !Number.isInteger(limit) || limit < 1 || limit > 10000)
        throw new Error('Invalid FRED query'); return tr.json(tr.url('https://api.stlouisfed.org/fred/series/observations', { series_id, api_key: options.fredApiKey, file_type: 'json', sort_order: 'desc', limit }), 3600); };
    const handlers: Record<string, MarketHandler> = {
        intel_market_quotes: async (a) => ({ quotes: (await quotes(a.symbols)).map(clean), source: 'yahoo-finance', timestamp: stamp() }),
        intel_crypto_quotes: async (a) => { const limit = a.limit ?? 20; if (!Number.isInteger(limit) || limit < 1 || limit > 250)
            throw new Error('limit must be1..250'); const d = await cg({ vs_currency: 'usd', order: 'market_cap_desc', per_page: limit, sparkline: 'true', price_change_percentage: '1h,24h,7d' }); return { coins: list(d).map(c => Object.fromEntries(['id', 'symbol', 'name', 'current_price', 'market_cap', 'price_change_percentage_24h', 'sparkline_in_7d'].map(k => [k, c[k] ?? null]))), source: 'coingecko', timestamp: stamp() }; },
        intel_stablecoin_status: async () => { const d = await cg({ vs_currency: 'usd', ids: 'tether,usd-coin,dai,first-digital-usd', sparkline: 'false' }); return { stablecoins: list(d).filter(c => finite(c.current_price) !== null).map(c => ({ id: c.id ?? null, price: c.current_price, peg_deviation_pct: pyRound(Math.abs(c.current_price - 1) * 100, 4), is_depegged: Math.abs(c.current_price - 1) > .005 })), source: 'coingecko', timestamp: stamp() }; },
        intel_etf_flows: async () => ({ etfs: (await quotes(['IBIT', 'FBTC', 'GBTC', 'ARKB', 'BITB'])).map(q => ({ symbol: q.symbol, price: q.price, change_pct: q.change_pct, volume: q._volume })), source: 'yahoo-finance', timestamp: stamp() }),
        intel_sector_heatmap: async () => ({ sectors: (await quotes(Object.keys(_SECTOR_ETFS))).map(q => ({ symbol: q.symbol, name: _SECTOR_ETFS[q.symbol], price: q.price, change_pct: q.change_pct })), source: 'yahoo-finance', timestamp: stamp() }),
        intel_commodity_quotes: async () => { const commodities = (await quotes(Object.keys(_COMMODITY_SYMBOLS))).map(q => ({ symbol: q.symbol, name: _COMMODITY_SYMBOLS[q.symbol], price: q.price, change_pct: q.change_pct })); return { commodities, count: commodities.length, source: 'yahoo-finance', timestamp: stamp() }; },
        intel_country_stocks: async (a) => { const country = String(a.country ?? 'USA').toUpperCase(), ticker = COUNTRY_INDEX_TICKERS[country]; if (!ticker)
            return { error: `No index ticker mapped for country '${country}'`, available_countries: Object.keys(COUNTRY_INDEX_TICKERS).sort(), source: 'yahoo-finance', timestamp: stamp() }; const q = await quote(ticker), ex = STOCK_EXCHANGES.find((x: any) => x.index === ticker); return { country, ticker, quote: q ? clean(q) : null, exchange: ex ? Object.fromEntries(['name', 'acronym', 'city', 'currency', 'tier'].map(k => [k, ex[k]])) : null, source: 'yahoo-finance', timestamp: stamp() }; },
        intel_btc_technicals: async () => { const d = await tr.json(tr.url('https://api.coingecko.com/api/v3/coins/bitcoin/market_chart', { vs_currency: 'usd', days: 200, interval: 'daily' }), 600); if (!d?.prices)
            return { error: 'Failed to fetch BTC historical data', source: 'coingecko', timestamp: stamp() }; const p = list(d.prices).map(x => finite(x[1])).filter((x): x is number => x !== null); if (p.length < 50)
            return { error: 'Insufficient price history', source: 'coingecko', timestamp: stamp() }; const price = p.at(-1)!, s50 = p.slice(-50).reduce((a, b) => a + b, 0) / 50, s200 = p.slice(-200).reduce((a, b) => a + b, 0) / Math.min(p.length, 200), ath = Math.max(...p); const change = (n: number) => p.at(-n) === 0 ? null : pyRound((price - p.at(-n)!) / p.at(-n)! * 100, 2); return { price: pyRound(price, 2), sma_50: pyRound(s50, 2), sma_200: s200 ? pyRound(s200, 2) : null, mayer_multiple: s200 > 0 ? pyRound(price / s200, 4) : null, cross_signal: s50 > s200 ? 'golden_cross' : s50 < s200 ? 'death_cross' : 'neutral', ath_in_period: pyRound(ath, 2), ath_distance_pct: ath > 0 ? pyRound((price - ath) / ath * 100, 2) : null, change_7d_pct: change(8), change_30d_pct: change(31), data_points: p.length, source: 'coingecko', timestamp: stamp() }; },
        intel_fred_series: async (a) => { if (!options.fredApiKey)
            return { error: 'FRED_API_KEY not configured' }; const id = String(a.series_id ?? ''), d = await fred(id, a.limit ?? 30); const r: MarketObject = { series_id: id, title: id, observations: list(d?.observations).filter(o => o.date != null).map(o => ({ date: o.date, value: finite(o.value) })), fetched_at: stamp(), source: 'fred' }; for (const k of ['realtime_start', 'realtime_end'])
            if (d && k in d)
                r[k] = d[k]; return r; },
        intel_world_bank_indicators: async (a) => { const country = a.country ?? 'USA', ids = a.indicators?.length ? a.indicators : ['NY.GDP.MKTP.CD', 'FP.CPI.TOTL.ZG', 'SL.UEM.TOTL.ZS']; if (!/^[A-Za-z]{2,3}$/.test(country) || !Array.isArray(ids) || ids.length > 30 || ids.some(i => typeof i !== 'string' || !/^[-A-Za-z0-9.]{1,100}$/.test(i)))
            throw new Error('Invalid World Bank query'); const indicators = await Promise.all(ids.map(async (id) => { const raw = await tr.json(tr.url(`https://api.worldbank.org/v2/country/${country}/indicator/${id}`, { format: 'json', per_page: 5, date: '2020:2025' }), 86400); const rows = Array.isArray(raw) ? list(raw[1]) : []; return { id, name: rows[0]?.indicator?.value ?? id, values: rows.filter(r => r.date != null).map(r => ({ year: r.date, value: finite(r.value) })) }; })); return { country, indicators, fetched_at: stamp(), source: 'world-bank' }; },
        intel_residential_natgas: async () => { if (!options.eiaApiKey)
            return { error: 'EIA_API_KEY not configured' }; const d = await eia('natural-gas/pri/sum', { ...baseEia, length: 6, 'facets[duoarea][]': 'NUS', 'facets[process][]': 'PRS' }); const prices = list(d?.response?.data).filter(r => r.period != null && finite(r.value) !== null).map(r => ({ price: Number(r.value), period: r.period }) as MarketObject); if (prices.length >= 2) {
            const delta = prices[0].price - prices[1].price;
            prices[0].change = pyRound(delta, 2);
            prices[0].change_pct = prices[1].price ? pyRound(delta / prices[1].price * 100, 2) : 0;
        } return { prices, fetched_at: stamp(), source: 'eia', unit: '$/thousand cubic feet' }; },
        intel_electricity_rates: async (a) => { if (!options.eiaApiKey)
            return { error: 'EIA_API_KEY not configured' }; const state = String(a.state ?? 'US').toUpperCase(); if (!/^[A-Z]{2}$/.test(state))
            throw new Error('Invalid state'); const d = await eia('electricity/retail-sales', { ...baseEia, 'data[0]': 'price', length: 12, 'facets[stateid][]': state, 'facets[sectorid][]': ['RES', 'COM', 'IND', 'ALL'] }); const sectors: MarketObject = {}, rates: MarketObject = {}; const names: MarketObject = { RES: 'residential', COM: 'commercial', IND: 'industrial', ALL: 'all_sectors' }; for (const r of list(d?.response?.data)) {
            if (r.sectorid == null || r.period == null || finite(r.price) === null)
                continue;
            const k = names[r.sectorid] ?? r.sectorid;
            sectors[k] ??= [];
            if (sectors[k].length < 2)
                sectors[k].push({ price: Number(r.price), period: r.period });
        } for (const [k, rs] of Object.entries(sectors)) {
            const rows = rs as any[], r: MarketObject = { price_cents_kwh: rows[0].price, period: rows[0].period };
            if (rows.length > 1) {
                const delta = rows[0].price - rows[1].price;
                r.change = pyRound(delta, 2);
                r.change_pct = rows[1].price ? pyRound(delta / rows[1].price * 100, 2) : 0;
                r.prev_period = rows[1].period;
            }
            rates[k] = r;
        } return { state, rates, fetched_at: stamp(), source: 'eia', unit: 'cents/kWh' }; },
        intel_energy_prices: async () => { if (!options.eiaApiKey)
            return { error: 'EIA_API_KEY not configured' }; const [oil, gas] = await Promise.all([eia('petroleum/pri/spt', { ...baseEia, frequency: 'daily', length: 5, 'facets[product][]': ['EPCBRENT', 'EPCWTI'] }), eia('natural-gas/pri/fut', { ...baseEia, frequency: 'daily', length: 5, 'facets[process][]': 'PRC' })]); const r: MarketObject = { oil: { brent: null, wti: null }, natural_gas: null, fetched_at: stamp(), source: 'eia' }; for (const x of list(oil?.response?.data)) {
            const k = x.product === 'EPCBRENT' ? 'brent' : x.product === 'EPCWTI' ? 'wti' : null;
            if (k && r.oil[k] === null && finite(x.value) !== null && x.period != null)
                r.oil[k] = { price: Number(x.value), date: x.period };
        } const g = gas?.response?.data?.[0]; if (g?.period != null && finite(g.value) !== null)
            r.natural_gas = { price: Number(g.value), date: g.period }; return r; },
        intel_gas_prices: async () => { const url = new URL('https://gasprices.aaa.com/'); let html = await tr.text(url, 1800); const stale = html === null ? tr.stale(url) : undefined; const r: MarketObject = { region: 'US', prices: {}, fetched_at: stale ? new Date(stale.time).toISOString() : stamp(), source: 'aaa', update_frequency: 'daily' }; if (stale) {
            html = stale.text;
            r._stale = true;
            r._stale_age_seconds = pyRound(Math.max(0, tr.now() - stale.time) / 1000, 1);
        } if (html !== null)
            Object.assign(r, parseAAA(html)); return r; },
        intel_central_bank_rates: async () => { const rates: any[] = []; if (options.fredApiKey)
            for (const meta of Object.values(_FRED_RATE_SERIES) as any[]) {
                const d = await fred(meta.series_id, 1), o = d?.observations?.[0], rate = finite(o?.value);
                if (rate !== null)
                    rates.push({ bank: meta.bank, country: meta.country, currency: meta.currency, label: meta.label, rate, as_of: o.date ?? null, source: 'fred' });
            } const have = new Set(rates.map(x => x.bank)); for (const entry of [..._CURATED_RATES, ...FRED_FALLBACK])
            if (!have.has(entry.bank))
                rates.push({ ...entry, source: 'curated' }); rates.sort((a, b) => b.rate - a.rate); return { rates, count: rates.length, fred_available: !!options.fredApiKey, source: 'multi', timestamp: stamp() }; },
        intel_macro_signals: async () => { const [fg, fees, dxy, vix, gold, treasury, global] = await Promise.all([tr.json(new URL('https://api.alternative.me/fng/?limit=1')), tr.json(new URL('https://mempool.space/api/v1/fees/recommended')), quote('DX-Y.NYB'), quote('^VIX'), quote('GC=F'), quote('^TNX'), tr.json(new URL('https://api.coingecko.com/api/v3/global'))]); const macro = (q: any) => q ? { symbol: q.symbol, price: q.price, change_pct: q.change_pct, source: 'yahoo-finance' } : null; const f = fg?.data?.[0]; return { signals: { fear_greed: f && finite(f.value) !== null ? { value: Math.trunc(Number(f.value)), classification: f.value_classification ?? null, source: 'alternative-me' } : null, mempool_fees: fees ? { fastest_fee: fees.fastestFee ?? null, half_hour_fee: fees.halfHourFee ?? null, hour_fee: fees.hourFee ?? null, economy_fee: fees.economyFee ?? null, minimum_fee: fees.minimumFee ?? null, source: 'mempool' } : null, dxy: macro(dxy), vix: macro(vix), gold: macro(gold), treasury_10y: macro(treasury), btc_dominance: finite(global?.data?.market_cap_percentage?.btc) !== null ? { btc_dominance_pct: pyRound(Number(global.data.market_cap_percentage.btc), 2), source: 'coingecko' } : null }, source: 'multi', timestamp: stamp() }; },
    };
    return handlers;
}
export function parseAAA(html: string): MarketObject {
    const result: MarketObject = { prices: {}, state_prices: [] };
    const table = html.match(/<table[^>]*>.*?Regular.*?<\/table>/is)?.[0];
    const grades = ['regular', 'mid_grade', 'premium', 'diesel', 'e85'], labels: MarketObject = { 'Current Avg.': 'today', 'Yesterday Avg.': 'yesterday', 'Week Ago Avg.': 'week_ago', 'Month Ago Avg.': 'month_ago', 'Year Ago Avg.': 'year_ago' }, times: MarketObject = {};
    if (table) {
        const regex = /<tr[^>]*>\s*<td[^>]*>([^<]+)<\/td>\s*<td[^>]*>\$?([\d.]+)<\/td>\s*<td[^>]*>\$?([\d.]+)<\/td>\s*<td[^>]*>\$?([\d.]+)<\/td>\s*<td[^>]*>\$?([\d.]+)<\/td>\s*<td[^>]*>\$?([\d.]+)<\/td>/gs;
        for (const row of table.matchAll(regex)) {
            const k = labels[row[1].trim()];
            if (k)
                times[k] = Object.fromEntries(grades.map((g, i) => [g, Number(row[i + 2])]));
        }
        for (const g of grades) {
            const cur = times.today?.[g];
            if (cur == null)
                continue;
            const e: MarketObject = { price_per_gallon: cur, unit: '$/gallon' }, prev = times.yesterday?.[g];
            if (prev) {
                e.change = pyRound(cur - prev, 3);
                e.change_pct = pyRound((cur - prev) / prev * 100, 2);
            }
            for (const p of ['week_ago', 'month_ago', 'year_ago'])
                if (times[p]?.[g]) {
                    e[p] = times[p][g];
                    e[p + '_pct'] = pyRound((cur - times[p][g]) / times[p][g] * 100, 2);
                }
            result.prices[g] = e;
        }
    }
    const iwm = html.match(/iwmparam\[0\]\.placestxt\s*=\s*"([^"]+)"/);
    if (iwm) {
        const parts = iwm[1].split(',');
        for (let i = 0; i + 2 < parts.length; i += 4) {
            const state = parts[i].split(';').at(-1)!.trim(), price = finite(parts[i + 2].trim().replace(/^\$/, ''));
            if (price !== null)
                result.state_prices.push({ state, price });
        }
    }
    return result;
}
