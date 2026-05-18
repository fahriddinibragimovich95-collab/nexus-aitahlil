// netlify/functions/analyze.js
// =============================================================
// NeXuS AI — Professional US Stocks Swing Trading Analyzer
// Stack: Netlify Serverless + Yahoo Finance 2 + Google Gemini AI
// =============================================================

const yahooFinance = require("yahoo-finance2").default;
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Yahoo Finance konsoldagi keraksiz ogohlantirishlarni o'chirish
try {
  yahooFinance.suppressNotices(["yahooSurvey", "ripHistorical"]);
} catch (_) {}

// =============================================================
// CORS SARLAVHALARI
// =============================================================
const CORS_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Cache-Control": "no-store",
};

// =============================================================
// JSON RESPONSE YORDAMCHISI
// =============================================================
function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(payload),
  };
}

// =============================================================
// SON FORMATLASH YORDAMCHILARI
// =============================================================
function fmtNumber(n, digits = 2) {
  if (n === null || n === undefined || isNaN(n) || !isFinite(n)) return "N/A";
  return Number(n).toFixed(digits);
}

function fmtBigMoney(n) {
  if (n === null || n === undefined || isNaN(n) || !isFinite(n) || n === 0)
    return "N/A";
  const abs = Math.abs(n);
  if (abs >= 1e12) return "$" + (n / 1e12).toFixed(2) + "T";
  if (abs >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return "$" + (n / 1e3).toFixed(2) + "K";
  return "$" + n.toFixed(2);
}

function fmtPercent(n, digits = 2) {
  if (n === null || n === undefined || isNaN(n) || !isFinite(n)) return "N/A";
  return Number(n).toFixed(digits) + "%";
}

// =============================================================
// TIKERNI TOZALASH
// "#AAPL", "$MULN", "+MSFT", "*NVDA*" → "AAPL", "MULN", ...
// =============================================================
function cleanTicker(raw) {
  if (!raw || typeof raw !== "string") return "";
  return raw.replace(/[^a-zA-Z]/g, "").toUpperCase().trim();
}

// =============================================================
// ASOSIY HANDLER
// =============================================================
exports.handler = async function (event) {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  // Faqat POST qabul qilamiz
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, {
      ok: false,
      error: "Faqat POST so'rovlari qabul qilinadi.",
    });
  }

  // GEMINI API KEY tekshiruvi
  if (!process.env.GEMINI_API_KEY) {
    return jsonResponse(500, {
      ok: false,
      error:
        "Server konfiguratsiyasi xatosi: GEMINI_API_KEY environment variable o'rnatilmagan.",
    });
  }

  // SO'ROV BODYNI PARSE QILISH
  let rawTicker = "";
  try {
    const body = JSON.parse(event.body || "{}");
    rawTicker = body.ticker || body.symbol || "";
  } catch (e) {
    return jsonResponse(400, {
      ok: false,
      error: "So'rov tanasi (body) noto'g'ri JSON formatda.",
    });
  }

  // TIKERNI TOZALASH
  const ticker = cleanTicker(rawTicker);
  if (!ticker || ticker.length < 1 || ticker.length > 8) {
    return jsonResponse(400, {
      ok: false,
      error:
        "Iltimos, to'g'ri aksiya tikerini kiriting (masalan: AAPL, MSFT, NVDA).",
    });
  }

  // ---------------------------------------------------------
  // 1-QADAM: YAHOO FINANCE DAN MA'LUMOT OLISH
  // ---------------------------------------------------------
  let summary;
  try {
    summary = await yahooFinance.quoteSummary(ticker, {
      modules: [
        "price",
        "summaryDetail",
        "financialData",
        "defaultKeyStatistics",
      ],
    });
  } catch (err) {
    console.error(`[Yahoo] "${ticker}" uchun xato:`, err && err.message);
    return jsonResponse(404, {
      ok: false,
      ticker,
      error: `"${ticker}" tikeri uchun bozor ma'lumotlari topilmadi. Tiker noto'g'ri bo'lishi yoki Yahoo Finance vaqtincha javob bermayotgan bo'lishi mumkin.`,
    });
  }

  if (!summary || !summary.price) {
    return jsonResponse(404, {
      ok: false,
      ticker,
      error: `"${ticker}" uchun Yahoo Finance bo'sh javob qaytardi.`,
    });
  }

  // ---------------------------------------------------------
  // 2-QADAM: MA'LUMOTLARNI TARTIBLASHTIRISH
  // ---------------------------------------------------------
  const price = summary.price || {};
  const sd = summary.summaryDetail || {};
  const fd = summary.financialData || {};
  const ks = summary.defaultKeyStatistics || {};

  const data = {
    ticker,
    companyName: price.longName || price.shortName || ticker,
    exchange: price.exchangeName || price.fullExchangeName || "N/A",
    currency: price.currency || "USD",

    currentPrice:
      price.regularMarketPrice ??
      fd.currentPrice ??
      sd.previousClose ??
      null,
    previousClose: price.regularMarketPreviousClose ?? sd.previousClose ?? null,
    change: price.regularMarketChange ?? null,
    changePercent:
      price.regularMarketChangePercent !== undefined &&
      price.regularMarketChangePercent !== null
        ? price.regularMarketChangePercent * 100
        : null,

    marketCap: price.marketCap ?? sd.marketCap ?? null,
    trailingPE: sd.trailingPE ?? ks.trailingPE ?? null,
    forwardPE: sd.forwardPE ?? ks.forwardPE ?? null,
    pegRatio: ks.pegRatio ?? null,
    priceToBook: ks.priceToBook ?? null,
    priceToSales: sd.priceToSalesTrailing12Months ?? null,

    profitMargins:
      fd.profitMargins !== undefined && fd.profitMargins !== null
        ? fd.profitMargins * 100
        : ks.profitMargins !== undefined && ks.profitMargins !== null
        ? ks.profitMargins * 100
        : null,
    grossMargins:
      fd.grossMargins !== undefined && fd.grossMargins !== null
        ? fd.grossMargins * 100
        : null,
    operatingMargins:
      fd.operatingMargins !== undefined && fd.operatingMargins !== null
        ? fd.operatingMargins * 100
        : null,
    returnOnEquity:
      fd.returnOnEquity !== undefined && fd.returnOnEquity !== null
        ? fd.returnOnEquity * 100
        : null,
    returnOnAssets:
      fd.returnOnAssets !== undefined && fd.returnOnAssets !== null
        ? fd.returnOnAssets * 100
        : null,

    revenueGrowth:
      fd.revenueGrowth !== undefined && fd.revenueGrowth !== null
        ? fd.revenueGrowth * 100
        : null,
    earningsGrowth:
      fd.earningsGrowth !== undefined && fd.earningsGrowth !== null
        ? fd.earningsGrowth * 100
        : null,

    totalRevenue: fd.totalRevenue ?? null,
    ebitda: fd.ebitda ?? null,
    freeCashflow: fd.freeCashflow ?? null,
    operatingCashflow: fd.operatingCashflow ?? null,

    totalCash: fd.totalCash ?? null,
    totalDebt: fd.totalDebt ?? null,
    debtToEquity: fd.debtToEquity ?? null,
    currentRatio: fd.currentRatio ?? null,
    quickRatio: fd.quickRatio ?? null,

    beta: sd.beta ?? ks.beta ?? null,
    fiftyTwoWeekHigh: sd.fiftyTwoWeekHigh ?? null,
    fiftyTwoWeekLow: sd.fiftyTwoWeekLow ?? null,
    fiftyDayAverage: sd.fiftyDayAverage ?? null,
    twoHundredDayAverage: sd.twoHundredDayAverage ?? null,

    volume: price.regularMarketVolume ?? sd.volume ?? null,
    averageVolume: sd.averageVolume ?? sd.averageVolume10days ?? null,

    dividendYield:
      sd.dividendYield !== undefined && sd.dividendYield !== null
        ? sd.dividendYield * 100
        : null,
    payoutRatio:
      sd.payoutRatio !== undefined && sd.payoutRatio !== null
        ? sd.payoutRatio * 100
        : null,

    eps: ks.trailingEps ?? null,
    forwardEps: ks.forwardEps ?? fd.forwardEps ?? null,
    sharesOutstanding: ks.sharesOutstanding ?? null,
    bookValue: ks.bookValue ?? null,
    targetMeanPrice: fd.targetMeanPrice ?? null,
    targetHighPrice: fd.targetHighPrice ?? null,
    targetLowPrice: fd.targetLowPrice ?? null,
    recommendationKey: fd.recommendationKey ?? null,
  };

  // Joriy narx topilmasa — xatolik
  if (data.currentPrice === null || data.currentPrice === undefined) {
    return jsonResponse(404, {
      ok: false,
      ticker,
      error: `"${ticker}" uchun joriy narx ma'lumoti mavjud emas.`,
    });
  }

  // ---------------------------------------------------------
  // 3-QADAM: TEXNIK QO'LLAB-QUVVATLASH / QARSHILIK DARAJALARI
  // ---------------------------------------------------------
  const p = data.currentPrice;
  const support1 = p * 0.95;
  const support2 = p * 0.9;
  const resistance1 = p * 1.05;
  const resistance2 = p * 1.1;

  // ---------------------------------------------------------
  // 4-QADAM: GEMINI AI UCHUN PROMPT QURISH
  // ---------------------------------------------------------
  const prompt = `
Sen tajribali Wall Street swing trading tahlilchisisan va FAQAT O'ZBEK TILIDA, professional uslubda javob berasan.
Quyidagi AQSh aksiyasi uchun chuqur va mukammal SWING TRADING (3 hafta – 3 oy) tahlilini tayyorla.

═════════════════════════════════════════════════════════════
📊 KOMPANIYA VA BOZOR MA'LUMOTLARI
═════════════════════════════════════════════════════════════
- Ticker: ${data.ticker}
- Kompaniya: ${data.companyName}
- Birja: ${data.exchange}
- Valyuta: ${data.currency}

💵 NARX VA HAJM:
- Joriy narx (Current Price): $${fmtNumber(data.currentPrice, 2)}
- Oldingi yopilish: $${fmtNumber(data.previousClose, 2)}
- Kunlik o'zgarish: ${fmtPercent(data.changePercent, 2)}
- Savdo hajmi: ${data.volume ? data.volume.toLocaleString() : "N/A"}
- O'rtacha hajm: ${data.averageVolume ? data.averageVolume.toLocaleString() : "N/A"}

🏦 FUNDAMENTAL KO'RSATKICHLAR:
- Market Cap: ${fmtBigMoney(data.marketCap)}
- Trailing P/E: ${fmtNumber(data.trailingPE, 2)}
- Forward P/E: ${fmtNumber(data.forwardPE, 2)}
- PEG Ratio: ${fmtNumber(data.pegRatio, 2)}
- Price/Book: ${fmtNumber(data.priceToBook, 2)}
- Price/Sales: ${fmtNumber(data.priceToSales, 2)}
- EPS (TTM): $${fmtNumber(data.eps, 2)}
- Forward EPS: $${fmtNumber(data.forwardEps, 2)}

📈 DAROMADLILIK:
- Profit Margins: ${fmtPercent(data.profitMargins, 2)}
- Gross Margins: ${fmtPercent(data.grossMargins, 2)}
- Operating Margins: ${fmtPercent(data.operatingMargins, 2)}
- ROE: ${fmtPercent(data.returnOnEquity, 2)}
- ROA: ${fmtPercent(data.returnOnAssets, 2)}

💰 MOLIYAVIY SOG'LOMLIK:
- Total Revenue (TTM): ${fmtBigMoney(data.totalRevenue)}
- Revenue Growth: ${fmtPercent(data.revenueGrowth, 2)}
- Earnings Growth: ${fmtPercent(data.earningsGrowth, 2)}
- EBITDA: ${fmtBigMoney(data.ebitda)}
- Free Cash Flow: ${fmtBigMoney(data.freeCashflow)}
- Total Cash: ${fmtBigMoney(data.totalCash)}
- Total Debt: ${fmtBigMoney(data.totalDebt)}
- Debt/Equity: ${fmtNumber(data.debtToEquity, 2)}
- Current Ratio: ${fmtNumber(data.currentRatio, 2)}
- Quick Ratio: ${fmtNumber(data.quickRatio, 2)}

📊 TEXNIK KONTEKST:
- Beta: ${fmtNumber(data.beta, 2)}
- 52 Hafta Yuqori: $${fmtNumber(data.fiftyTwoWeekHigh, 2)}
- 52 Hafta Past: $${fmtNumber(data.fiftyTwoWeekLow, 2)}
- 50 Kunlik O'rtacha: $${fmtNumber(data.fiftyDayAverage, 2)}
- 200 Kunlik O'rtacha: $${fmtNumber(data.twoHundredDayAverage, 2)}

🎯 ANALITIK MAQSADLARI:
- O'rtacha Maqsad Narx: $${fmtNumber(data.targetMeanPrice, 2)}
- Yuqori Maqsad: $${fmtNumber(data.targetHighPrice, 2)}
- Past Maqsad: $${fmtNumber(data.targetLowPrice, 2)}
- Tavsiya: ${data.recommendationKey || "N/A"}

💎 DIVIDEND:
- Yield: ${fmtPercent(data.dividendYield, 2)}
- Payout Ratio: ${fmtPercent(data.payoutRatio, 2)}

📐 TEXNIK DARAJALAR (joriy narxdan hisoblangan):
- Birinchi qo'llab-quvvatlash (S1): $${fmtNumber(support1, 2)}
- Ikkinchi qo'llab-quvvatlash (S2): $${fmtNumber(support2, 2)}
- Birinchi qarshilik (R1): $${fmtNumber(resistance1, 2)}
- Ikkinchi qarshilik (R2): $${fmtNumber(resistance2, 2)}

═════════════════════════════════════════════════════════════
🎯 SENING VAZIFANG
═════════════════════════════════════════════════════════════
Quyidagi tarkibda, aniq markdown formatida, chuqur va professional tahlil yoz:

## 📌 1. UMUMIY XULOSA
Kompaniya nima qiladi va hozirgi bozor holati haqida 2-3 jumla.

## 💼 2. FUNDAMENTAL TAHLIL
- Daromadlilik va o'sish dinamikasi.
- Moliyaviy barqarorlik (qarz darajasi, likvidlik).
- Baholash (P/E, P/B, PEG — bozor o'rtachasiga nisbatan).

## 📊 3. TEXNIK TAHLIL
- Joriy narxning 50/200 kunlik MA'larga nisbatan holati.
- 52 haftalik diapazonda qayerda?
- Trend yo'nalishi (yuqori / pastga / yon).

## ⚠️ 4. RISK MENEJMENTI
- Asosiy 3 ta xavf omilini sanab o't.
- Stop-Loss darajasi (aniq narx): $XX.XX
- Pozitsiya hajmi tavsiyasi (portfeldan necha %).
- Risk/Reward nisbati.

## 🎯 5. MAQSADLI NARXLAR (Target Prices)
- Birinchi maqsad (T1): $XX.XX — qisqa muddatli (2-4 hafta)
- Ikkinchi maqsad (T2): $XX.XX — o'rta muddatli (1-2 oy)
- Uchinchi maqsad (T3): $XX.XX — to'liq swing (3 oy)

## 🧭 6. QO'LLAB-QUVVATLASH VA QARSHILIK
- Asosiy qo'llab-quvvatlash darajalari va ularning ahamiyati.
- Asosiy qarshilik darajalari va breakout senariylari.

## ⚡ 7. KATALIZATORLAR
- Yaqin oydagi mumkin bo'lgan ijobiy va salbiy yangiliklar (earnings, sektor trendlari, makroiqtisodiy omillar).

## ✅ 8. YAKUNIY HUKM
Aniq va qisqa bitta variant tanla:
- 🟢 **KUCHLI SOTIB OLISH** — narx kirish zonasi va sabab
- 🔵 **SOTIB OLISH** — narx kirish zonasi va sabab
- 🟡 **KUTISH** — qanday signaldan keyin kirish kerak
- 🟠 **SOTISH** — sabab va alternativ
- 🔴 **KUCHLI SOTISH** — sabab va xavflar

Tahlil aniq, raqamlarga asoslangan, professional va o'qishga oson bo'lsin. Ortiqcha takror gaplardan saqlan.
`.trim();

  // ---------------------------------------------------------
  // 5-QADAM: GEMINI AI ORQALI TAHLIL OLISH
  // ---------------------------------------------------------
  let aiText = "";
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      generationConfig: {
        temperature: 0.7,
        topP: 0.95,
        topK: 40,
        maxOutputTokens: 4096,
      },
    });

    const result = await model.generateContent(prompt);
    aiText =
      (result &&
        result.response &&
        typeof result.response.text === "function" &&
        result.response.text()) ||
      "";

    if (!aiText || aiText.trim().length < 50) {
      throw new Error("Gemini bo'sh yoki juda qisqa javob qaytardi.");
    }
  } catch (err) {
    console.error("[Gemini] AI xatosi:", err && err.message);
    return jsonResponse(502, {
      ok: false,
      ticker,
      error:
        "Sun'iy intellekt tahlili tayyorlanmadi. Iltimos, biroz vaqtdan keyin qayta urinib ko'ring.",
      detail: (err && err.message) || "Unknown AI error",
    });
  }

  // ---------------------------------------------------------
  // 6-QADAM: YAKUNIY JAVOB
  // ---------------------------------------------------------
  return jsonResponse(200, {
    ok: true,
    ticker,
    companyName: data.companyName,
    exchange: data.exchange,
    generatedAt: new Date().toISOString(),
    metrics: {
      currentPrice: data.currentPrice,
      previousClose: data.previousClose,
      changePercent: data.changePercent,
      marketCap: data.marketCap,
      trailingPE: data.trailingPE,
      forwardPE: data.forwardPE,
      pegRatio: data.pegRatio,
      priceToBook: data.priceToBook,
      priceToSales: data.priceToSales,
      eps: data.eps,
      forwardEps: data.forwardEps,
      profitMargins: data.profitMargins,
      grossMargins: data.grossMargins,
      operatingMargins: data.operatingMargins,
      returnOnEquity: data.returnOnEquity,
      returnOnAssets: data.returnOnAssets,
      revenueGrowth: data.revenueGrowth,
      earningsGrowth: data.earningsGrowth,
      totalRevenue: data.totalRevenue,
      ebitda: data.ebitda,
      freeCashflow: data.freeCashflow,
      totalCash: data.totalCash,
      totalDebt: data.totalDebt,
      debtToEquity: data.debtToEquity,
      currentRatio: data.currentRatio,
      quickRatio: data.quickRatio,
      beta: data.beta,
      fiftyTwoWeekHigh: data.fiftyTwoWeekHigh,
      fiftyTwoWeekLow: data.fiftyTwoWeekLow,
      fiftyDayAverage: data.fiftyDayAverage,
      twoHundredDayAverage: data.twoHundredDayAverage,
      volume: data.volume,
      averageVolume: data.averageVolume,
      dividendYield: data.dividendYield,
      payoutRatio: data.payoutRatio,
      targetMeanPrice: data.targetMeanPrice,
      targetHighPrice: data.targetHighPrice,
      targetLowPrice: data.targetLowPrice,
      recommendationKey: data.recommendationKey,
    },
    technicalLevels: {
      support1,
      support2,
      resistance1,
      resistance2,
    },
    analysis: aiText.trim(),
  });
};
