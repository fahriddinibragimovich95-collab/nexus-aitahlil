/**
 * NeXuS AI — Netlify Serverless Function
 * Backend: Yahoo Finance + Google Gemini AI
 * Modes: penny | growth | value | fairvalue
 */

const { GoogleGenerativeAI } = require("@google/generative-ai");
const yahooFinance = require("yahoo-finance2").default || require("yahoo-finance2");

// ─────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────
exports.handler = async function (event, context) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  let ticker, mode;
  try {
    const parsed = JSON.parse(event.body || "{}");
    ticker = (parsed.ticker || "").toUpperCase().trim();
    mode = (parsed.mode || "").toLowerCase().trim();
    if (!ticker || !mode) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "ticker va mode parametrlari majburiy." }),
      };
    }
  } catch (e) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "JSON parse xatosi." }),
    };
  }

  try {
    // ── 1. Yahoo Finance dan ma'lumot olish ──────────────────
    let yfRaw;
    try {
      yfRaw = await yahooFinance.quoteSummary(ticker, {
        modules: [
          "price",
          "summaryDetail",
          "financialData",
          "defaultKeyStatistics",
        ],
      });
    } catch (e) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({
          error: `"${ticker}" uchun bozor ma'lumotlari topilmadi. Ticker to'g'riligini tekshiring.`,
        }),
      };
    }

    const data = extractYFData(yfRaw);

    // ── 2. Gemini AI ni sozlash ──────────────────────────────
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const aiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    // ── 3. Rejimga qarab ishlash ─────────────────────────────
    let result = {};

    if (mode === "fairvalue") {
      result = await handleFairValue(ticker, data, aiModel);
    } else if (mode === "penny") {
      result = await handlePenny(ticker, data, aiModel);
    } else if (mode === "growth") {
      result = await handleGrowth(ticker, data, aiModel);
    } else if (mode === "value") {
      result = await handleValue(ticker, data, aiModel);
    } else {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: `Noto'g'ri rejim: "${mode}". penny | growth | value | fairvalue bo'lishi kerak.`,
        }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, mode, ticker, ...result }),
    };
  } catch (err) {
    console.error("NeXuS internal error:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: "Serverda ichki xatolik yuz berdi. Keyinroq urinib ko'ring.",
        detail: err.message || "",
      }),
    };
  }
};

// ─────────────────────────────────────────
// YAHOO FINANCE — MA'LUMOT TARTIBLASHTIRISH
// ─────────────────────────────────────────
function extractYFData(yf) {
  const p = yf.price || {};
  const sd = yf.summaryDetail || {};
  const fd = yf.financialData || {};
  const ks = yf.defaultKeyStatistics || {};

  return {
    price: p.regularMarketPrice || 0,
    companyName: p.longName || p.shortName || "N/A",
    exchange: p.exchangeName || "N/A",
    currency: p.currency || "USD",
    marketCap: p.marketCap || 0,
    sharesOutstanding: ks.sharesOutstanding || p.sharesOutstanding || 1,
    beta: sd.beta || 1,
    pe_ratio: sd.trailingPE || 0,
    forwardPE: sd.forwardPE || 0,
    eps_ttm: ks.trailingEps || 0,
    forwardEps: fd.forwardEps || 0,
    revenue_ttm: fd.totalRevenue || 0,
    revenueGrowth: fd.revenueGrowth || 0,
    grossMargins: fd.grossMargins || 0,
    net_margin: fd.profitMargins ? fd.profitMargins * 100 : 0,
    operatingMargins: fd.operatingMargins || 0,
    returnOnEquity: fd.returnOnEquity || 0,
    returnOnAssets: fd.returnOnAssets || 0,
    debt_equity: fd.debtToEquity || 0,
    current_ratio: fd.currentRatio || 0,
    quickRatio: fd.quickRatio || 0,
    freeCashflow: fd.freeCashflow || 0,
    operatingCashflow: fd.operatingCashflow || 0,
    totalCash: fd.totalCash || 0,
    totalDebt: fd.totalDebt || 0,
    ebitda: fd.ebitda || 0,
    priceToSales: sd.priceToSalesTrailing12Months || 0,
    priceToBook: ks.priceToBook || 0,
    bookValuePerShare: ks.bookValue || 0,
    pegRatio: ks.pegRatio || 0,
    enterpriseValue: ks.enterpriseValue || 0,
    high_52: sd.fiftyTwoWeekHigh || 0,
    low_52: sd.fiftyTwoWeekLow || 0,
    fiftyDayAvg: sd.fiftyDayAverage || 0,
    twoHundredDayAvg: sd.twoHundredDayAverage || 0,
    volume: p.regularMarketVolume || 0,
    avgVolume: sd.averageVolume || 0,
    change_pct: p.regularMarketChangePercent
      ? p.regularMarketChangePercent * 100
      : 0,
    dividendYield: sd.dividendYield ? sd.dividendYield * 100 : 0,
    payoutRatio: sd.payoutRatio || 0,
    sector: p.sector || "N/A",
    industry: p.industry || "N/A",
  };
}

// ─────────────────────────────────────────
// REJIM 1: FAIR VALUE (10 USUL)
// ─────────────────────────────────────────
async function handleFairValue(ticker, data, aiModel) {
  // 1a. Gemini'dan etishmayotgan prognozlarni so'rash
  const valuationPrompt = buildValuationPrompt(ticker, data);
  let geminiJson = {};

  try {
    const aiResp = await aiModel.generateContent(valuationPrompt);
    const aiText = aiResp.response.text();
    geminiJson = tryParseJSON(aiText) || {};
  } catch (e) {
    console.warn("Gemini Fair Value JSON parse xatosi:", e.message);
    geminiJson = {};
  }

  // 1b. Yahoo + Gemini ma'lumotlarini birlashtirish
  const merged = mergeValuationData(geminiJson, data);

  // 1c. 10 usul bilan hisoblash
  const valuations = calculateValuations(merged);

  // 1d. Natijani formatlash
  const formatted = formatFairValueResult(ticker, merged, valuations, data);

  return {
    type: "fairvalue",
    summary: formatted.summary,
    metrics: formatted.metrics,
    valuations: formatted.valuations,
    verdict: formatted.verdict,
    raw: {
      merged,
      valuations,
    },
  };
}

function buildValuationPrompt(ticker, data) {
  return `You are a quantitative financial analyst. For the stock "${ticker}" (${data.companyName}), provide ONLY a strict JSON object with NO markdown, NO explanation, NO backticks.

Current known data:
- Revenue TTM: ${data.revenue_ttm}
- Free Cash Flow: ${data.freeCashflow}
- Net Margin: ${data.net_margin}%
- Revenue Growth: ${(data.revenueGrowth * 100).toFixed(1)}%
- Forward EPS: ${data.forwardEps}
- Forward P/E: ${data.forwardPE}
- Price/Sales: ${data.priceToSales}

Estimate the MISSING forward-looking values. Return ONLY this JSON, no other text:
{
  "fyRevenueEst": <next FY total revenue in USD raw number>,
  "fyFcfEst": <next FY free cash flow in USD raw number>,
  "adjustedEpsEst": <next FY adjusted EPS in USD>,
  "fcfMarginPct": <FCF margin as percent number, e.g. 18.5>,
  "expectedGrowthRatePct": <annual revenue growth rate as percent number, e.g. 12.0>,
  "historicalPE": <fair historical or sector PE multiple, e.g. 22.0>,
  "historicalPS": <fair price-to-sales multiple, e.g. 4.5>,
  "sectorPeerRevenueMultiple": <peer average revenue multiple, e.g. 3.2>
}`;
}

function mergeValuationData(gemini, yf) {
  return {
    price: yf.price || 0,
    companyName: yf.companyName,
    exchange: yf.exchange,
    sharesOutstanding: yf.sharesOutstanding || 1,
    ebitda: yf.ebitda || 0,
    bookValuePerShare: yf.bookValuePerShare || 0,
    netCashPosition: (yf.totalCash || 0) - (yf.totalDebt || 0),
    totalCash: yf.totalCash || 0,
    totalDebt: yf.totalDebt || 0,
    beta: yf.beta || 1,
    dividendYield: yf.dividendYield || 0,
    high_52: yf.high_52 || 0,
    low_52: yf.low_52 || 0,
    marketCap: yf.marketCap || 0,
    revenueGrowth_yf: (yf.revenueGrowth || 0) * 100,
    // Gemini prognozlari (Yahoo bilan fallback)
    fyRevenueEst:
      gemini.fyRevenueEst && gemini.fyRevenueEst > 0
        ? gemini.fyRevenueEst
        : yf.revenue_ttm || 0,
    fyFcfEst:
      gemini.fyFcfEst && gemini.fyFcfEst > 0
        ? gemini.fyFcfEst
        : yf.freeCashflow || 0,
    adjustedEpsEst:
      gemini.adjustedEpsEst && gemini.adjustedEpsEst > 0
        ? gemini.adjustedEpsEst
        : yf.forwardEps || yf.eps_ttm || 0,
    historicalPE:
      gemini.historicalPE && gemini.historicalPE > 0
        ? gemini.historicalPE
        : yf.forwardPE || yf.pe_ratio || 15,
    historicalPS:
      gemini.historicalPS && gemini.historicalPS > 0
        ? gemini.historicalPS
        : yf.priceToSales || 2,
    expectedGrowthRatePct:
      gemini.expectedGrowthRatePct && gemini.expectedGrowthRatePct !== 0
        ? gemini.expectedGrowthRatePct
        : (yf.revenueGrowth || 0) * 100 || 5,
    fcfMarginPct:
      gemini.fcfMarginPct && gemini.fcfMarginPct > 0
        ? gemini.fcfMarginPct
        : yf.net_margin || 10,
    sectorPeerRevenueMultiple:
      gemini.sectorPeerRevenueMultiple && gemini.sectorPeerRevenueMultiple > 0
        ? gemini.sectorPeerRevenueMultiple
        : 2,
  };
}

function calculateValuations(d) {
  const wacc = 0.095; // Weighted Average Cost of Capital: 9.5%
  const termGrowth = 0.025; // Terminal growth: 2.5%
  const years = 5;
  const shares = d.sharesOutstanding || 1;

  // ── 1. DCF (Discounted Cash Flow) ──────────────────────────
  let dcfPv = 0;
  let projFcf = d.fyFcfEst || 0;
  const g = (d.expectedGrowthRatePct || 5) / 100;
  for (let t = 1; t <= years; t++) {
    projFcf *= 1 + g;
    dcfPv += projFcf / Math.pow(1 + wacc, t);
  }
  const termVal = (projFcf * (1 + termGrowth)) / (wacc - termGrowth);
  const tvPv = termVal / Math.pow(1 + wacc, years);
  const dcf =
    shares > 0 ? (dcfPv + tvPv + (d.netCashPosition || 0)) / shares : 0;

  // ── 2. P/E (Tarixiy) ────────────────────────────────────────
  const peHist = (d.adjustedEpsEst || 0) * (d.historicalPE || 15);

  // ── 3. P/E (Bozor konservativ) ──────────────────────────────
  const conservativePE = d.historicalPE > 0 ? Math.min(d.historicalPE, 18) : 12;
  const peMarket = (d.adjustedEpsEst || 0) * conservativePE;

  // ── 4. EV/EBITDA ─────────────────────────────────────────────
  // Sektoral o'rtacha EV/EBITDA ko'paytuvchi: 11x
  const evEbitda =
    shares > 0 && d.ebitda > 0
      ? (d.ebitda * 11 + (d.netCashPosition || 0)) / shares
      : 0;

  // ── 5. Price/Sales ────────────────────────────────────────────
  const ps =
    shares > 0 && d.fyRevenueEst > 0
      ? (d.fyRevenueEst * (d.historicalPS || 2)) / shares
      : 0;

  // ── 6. FCF Yield ──────────────────────────────────────────────
  // Target FCF yield: 8% → FV = FCF / 0.08
  const fcfYield =
    shares > 0 && d.fyFcfEst > 0 ? d.fyFcfEst / 0.08 / shares : 0;

  // ── 7. EPV (Earnings Power Value) ────────────────────────────
  // EPV = EPS / WACC (no-growth intrinsic value)
  const epv = d.adjustedEpsEst > 0 ? d.adjustedEpsEst / wacc : 0;

  // ── 8. Graham Number ─────────────────────────────────────────
  // Graham: sqrt(22.5 × EPS × BookValue)
  const grahamRaw =
    22.5 * (d.adjustedEpsEst || 0) * (d.bookValuePerShare || 0);
  const graham = grahamRaw > 0 ? Math.sqrt(grahamRaw) : 0;

  // ── 9. Rule of 40 ─────────────────────────────────────────────
  // SaaS metrik: FCF margin% + Revenue growth% >= 40 → premium multiplier
  const ruleScore = (d.fcfMarginPct || 0) + (d.expectedGrowthRatePct || 0);
  const ruleMultiplier = ruleScore >= 40 ? 4 : d.historicalPS || 2;
  const ruleOf40 =
    shares > 0 && d.fyRevenueEst > 0
      ? (d.fyRevenueEst * ruleMultiplier) / shares
      : 0;

  // ── 10. Peer Average (Sektor tengdoshi) ──────────────────────
  const peerAvg =
    shares > 0 && d.fyRevenueEst > 0
      ? (d.fyRevenueEst * (d.sectorPeerRevenueMultiple || 2)) / shares
      : 0;

  // ── Weighted Average Fair Value ───────────────────────────────
  // Nol yoki cheksiz qiymatlarni filtrlab o'rtacha hisoblaymiz
  const allVals = [
    dcf,
    peHist,
    peMarket,
    evEbitda,
    ps,
    fcfYield,
    epv,
    graham,
    ruleOf40,
    peerAvg,
  ];
  const validVals = allVals.filter(
    (v) => v > 0 && isFinite(v) && !isNaN(v) && v < d.price * 20
  );
  const average =
    validVals.length > 0
      ? validVals.reduce((a, b) => a + b, 0) / validVals.length
      : 0;

  return {
    dcf,
    peHist,
    peMarket,
    evEbitda,
    ps,
    fcfYield,
    epv,
    graham,
    ruleOf40,
    ruleScore,
    peerAvg,
    average,
    validCount: validVals.length,
  };
}

function formatFairValueResult(ticker, d, v, raw) {
  const price = d.price;
  const fv = v.average;
  let upside = 0;
  let verdictText = "—";
  let verdictType = "neutral";

  if (price > 0 && fv > 0) {
    upside = ((fv - price) / price) * 100;
    if (upside > 20) {
      verdictText = `ARZON — ${upside.toFixed(1)}% potensial o'sish`;
      verdictType = "bullish";
    } else if (upside > 8) {
      verdictText = `BIROZ ARZON — ${upside.toFixed(1)}% salohiyat`;
      verdictType = "mildly-bullish";
    } else if (upside < -20) {
      verdictText = `QIMMAT — ${Math.abs(upside).toFixed(1)}% qadrsizlanish xavfi`;
      verdictType = "bearish";
    } else if (upside < -8) {
      verdictText = `BIROZ QIMMAT — ${Math.abs(upside).toFixed(1)}% yuqori`;
      verdictType = "mildly-bearish";
    } else {
      verdictText = `ADOLATLI NARXDA — ${upside.toFixed(1)}% farq`;
      verdictType = "neutral";
    }
  }

  const metrics = {
    price: price,
    companyName: d.companyName,
    exchange: d.exchange,
    marketCap: d.marketCap,
    fyRevenueEst: d.fyRevenueEst,
    fyFcfEst: d.fyFcfEst,
    ebitda: d.ebitda,
    adjustedEpsEst: d.adjustedEpsEst,
    expectedGrowthRatePct: d.expectedGrowthRatePct,
    historicalPE: d.historicalPE,
    netCashPosition: d.netCashPosition,
    high_52: d.high_52,
    low_52: d.low_52,
    beta: d.beta,
  };

  const valuations = [
    {
      name: "DCF (Chegirmalangan Pul Oqimi)",
      shortName: "DCF",
      value: v.dcf,
      icon: "💎",
      desc: "5 yillik FCF prognozi, WACC=9.5%, terminal o'sish=2.5%",
    },
    {
      name: "P/E (Tarixiy Multiplier)",
      shortName: "P/E Tarixiy",
      value: v.peHist,
      icon: "📐",
      desc: `EPS × Tarixiy P/E (${d.historicalPE?.toFixed(1)}x)`,
    },
    {
      name: "P/E (Konservativ Bozor)",
      shortName: "P/E Konservativ",
      value: v.peMarket,
      icon: "📏",
      desc: `EPS × min(P/E, 18) — konservativ baholash`,
    },
    {
      name: "EV/EBITDA",
      shortName: "EV/EBITDA",
      value: v.evEbitda,
      icon: "🏗️",
      desc: "EBITDA × 11x sektoral multiplier + Net Kash",
    },
    {
      name: "Price/Sales",
      shortName: "P/S",
      value: v.ps,
      icon: "💼",
      desc: `Revenue × P/S multiplier (${d.historicalPS?.toFixed(1)}x)`,
    },
    {
      name: "FCF Yield Modeli",
      shortName: "FCF Yield",
      value: v.fcfYield,
      icon: "💧",
      desc: "FCF / 0.08 — maqsadli 8% FCF yield",
    },
    {
      name: "EPV (Daromad Quvvati Qiymati)",
      shortName: "EPV",
      value: v.epv,
      icon: "⚡",
      desc: "EPS / WACC — o'sishsiz intrinsik qiymat",
    },
    {
      name: "Graham Raqami",
      shortName: "Graham",
      value: v.graham,
      icon: "🛡️",
      desc: "√(22.5 × EPS × Kitob Qiymati)",
    },
    {
      name: "Rule of 40",
      shortName: "Rule of 40",
      value: v.ruleOf40,
      icon: "🚦",
      desc: `Ball: ${v.ruleScore?.toFixed(1)} (O'sish% + FCF Margin%)`,
    },
    {
      name: "Sektor Tengdoshlari",
      shortName: "Peer Avg",
      value: v.peerAvg,
      icon: "🤝",
      desc: `Revenue × Sektoral tengdosh multiplier`,
    },
  ];

  return {
    summary: `${ticker} uchun ${v.validCount} usul bo'yicha o'rtacha adolatli narx: $${fv.toFixed(2)}`,
    metrics,
    valuations,
    verdict: {
      fairValue: fv,
      currentPrice: price,
      upside,
      text: verdictText,
      type: verdictType,
    },
  };
}

// ─────────────────────────────────────────
// REJIM 2: PENNY STOCK
// ─────────────────────────────────────────
async function handlePenny(ticker, data, aiModel) {
  // 2a. 6-filter tekshiruvi
  const filterResult = runPennyFilters(ticker, data);

  // 2b. AI fundamental tahlil
  const prompt = buildFundamentalPrompt(ticker, data, "penny");
  let aiText = "";
  try {
    const aiResp = await aiModel.generateContent(prompt);
    aiText = aiResp.response.text();
  } catch (e) {
    aiText = "AI tahlil vaqtincha mavjud emas.";
  }

  return {
    type: "penny",
    filters: filterResult,
    aiAnalysis: aiText,
    metrics: extractDisplayMetrics(data),
  };
}

function runPennyFilters(ticker, data) {
  const price = data.price;
  const mc = data.marketCap / 1e6; // Millionda
  const filters = [];
  let passCount = 0,
    failCount = 0,
    warnCount = 0;

  // ── FILTER 1: FLOAT ────────────────────────────────────────
  // Float ≈ Market Cap / Price (oddiy taxmin, real float YF da yo'q)
  const floatEst = price > 0 && mc > 0 ? mc / price : 0;
  if (floatEst > 0 && floatEst < 30) {
    filters.push({
      id: 1,
      name: "Float",
      criteria: "< 30M ta aksiya",
      status: "pass",
      value: `~${floatEst.toFixed(1)}M ta`,
      comment: "Muvaffaqiyatli zona — past float yuqori volatillikka olib keladi",
    });
    passCount++;
  } else if (floatEst >= 30 && floatEst < 60) {
    filters.push({
      id: 1,
      name: "Float",
      criteria: "< 30M ta aksiya",
      status: "warn",
      value: `~${floatEst.toFixed(1)}M ta`,
      comment: "Chegarada — harakatchanlik pasayishi mumkin",
    });
    warnCount++;
  } else {
    filters.push({
      id: 1,
      name: "Float",
      criteria: "< 30M ta aksiya",
      status: "fail",
      value: floatEst > 0 ? `~${floatEst.toFixed(1)}M ta` : "Ma'lumot yo'q",
      comment: "Float juda katta — momentum pop ehtimoli past",
    });
    failCount++;
  }

  // ── FILTER 2: MARKET CAP ───────────────────────────────────
  if (mc > 0 && mc < 20) {
    filters.push({
      id: 2,
      name: "Market Cap",
      criteria: "< $20M",
      status: "pass",
      value: `$${mc.toFixed(2)}M`,
      comment: "Micro-cap zona — yuqori salohiyatli harakat imkoniyati",
    });
    passCount++;
  } else if (mc >= 20 && mc < 60) {
    filters.push({
      id: 2,
      name: "Market Cap",
      criteria: "< $20M",
      status: "warn",
      value: `$${mc.toFixed(2)}M`,
      comment: "Small-cap chegarasida — ehtiyotkor bo'ling",
    });
    warnCount++;
  } else {
    filters.push({
      id: 2,
      name: "Market Cap",
      criteria: "< $20M",
      status: "fail",
      value: mc > 0 ? `$${mc.toFixed(2)}M` : "Ma'lumot yo'q",
      comment: "Bozor qiymati juda katta — penny dinamikasi yo'q",
    });
    failCount++;
  }

  // ── FILTER 3: NARX ORALIG'I ────────────────────────────────
  if (price > 0.01 && price <= 5) {
    filters.push({
      id: 3,
      name: "Narx Oralig'i",
      criteria: "$0.01 — $5",
      status: "pass",
      value: `$${price.toFixed(4)}`,
      comment: "Klassik penny stock narxi oralig'ida",
    });
    passCount++;
  } else if (price > 5 && price <= 10) {
    filters.push({
      id: 3,
      name: "Narx Oralig'i",
      criteria: "$0.01 — $5",
      status: "warn",
      value: `$${price.toFixed(2)}`,
      comment: "Chegarada — ba'zi setuplarda ishlaydi",
    });
    warnCount++;
  } else {
    filters.push({
      id: 3,
      name: "Narx Oralig'i",
      criteria: "$0.01 — $5",
      status: "fail",
      value: price > 0 ? `$${price.toFixed(2)}` : "Ma'lumot yo'q",
      comment: price <= 0.01 ? "Narx juda past — delisting xavfi" : "Narx penny chegarasidan yuqori",
    });
    failCount++;
  }

  // ── FILTER 4: REVERSE SPLIT XAVFI ─────────────────────────
  if (data.high_52 > 0) {
    const drop = ((price - data.high_52) / data.high_52) * 100;
    if (drop < -80) {
      filters.push({
        id: 4,
        name: "Reverse Split Xavfi",
        criteria: "52w high dan < 80% tushmasin",
        status: "fail",
        value: `${drop.toFixed(1)}% tushgan`,
        comment: "Reverse Split ehtimoli YUQORI — katta xavf",
      });
      failCount++;
    } else if (drop < -50) {
      filters.push({
        id: 4,
        name: "Reverse Split Xavfi",
        criteria: "52w high dan < 80% tushmasin",
        status: "warn",
        value: `${drop.toFixed(1)}% tushgan`,
        comment: "O'rta xavf — kuzatishda bo'ling",
      });
      warnCount++;
    } else {
      filters.push({
        id: 4,
        name: "Reverse Split Xavfi",
        criteria: "52w high dan < 80% tushmasin",
        status: "pass",
        value: `${drop.toFixed(1)}% tushgan`,
        comment: "RS xavfi past — qabul qilinadi",
      });
      passCount++;
    }
  } else {
    filters.push({
      id: 4,
      name: "Reverse Split Xavfi",
      criteria: "52w high dan < 80% tushmasin",
      status: "warn",
      value: "Ma'lumot yo'q",
      comment: "52w high topilmadi — qo'lda tekshiring",
    });
    warnCount++;
  }

  // ── FILTER 5: HAJM (VOLUME) ────────────────────────────────
  const vol = data.volume;
  const avgVol = data.avgVolume;
  if (vol >= 500000) {
    filters.push({
      id: 5,
      name: "Savdo Hajmi",
      criteria: "> 500K lot",
      status: "pass",
      value: formatVolume(vol),
      comment: "Yetarli likvidlik — kirish/chiqish oson",
    });
    passCount++;
  } else if (vol >= 100000) {
    filters.push({
      id: 5,
      name: "Savdo Hajmi",
      criteria: "> 500K lot",
      status: "warn",
      value: formatVolume(vol),
      comment: "O'rta likvidlik — slippage xavfi bor",
    });
    warnCount++;
  } else {
    filters.push({
      id: 5,
      name: "Savdo Hajmi",
      criteria: "> 500K lot",
      status: "fail",
      value: vol > 0 ? formatVolume(vol) : "Ma'lumot yo'q",
      comment: "Past likvidlik — manipulyatsiya xavfi YUQORI",
    });
    failCount++;
  }

  // ── FILTER 6: RELATIVE VOLUME ──────────────────────────────
  const rvol = avgVol > 0 ? vol / avgVol : 0;
  if (rvol >= 2) {
    filters.push({
      id: 6,
      name: "Nisbiy Hajm (RVOL)",
      criteria: "> 2x o'rtacha",
      status: "pass",
      value: `${rvol.toFixed(2)}x`,
      comment: "Yuqori RVOL — momentum harakatda",
    });
    passCount++;
  } else if (rvol >= 1) {
    filters.push({
      id: 6,
      name: "Nisbiy Hajm (RVOL)",
      criteria: "> 2x o'rtacha",
      status: "warn",
      value: rvol > 0 ? `${rvol.toFixed(2)}x` : "Ma'lumot yo'q",
      comment: "O'rtacha RVOL — trigger kuting",
    });
    warnCount++;
  } else {
    filters.push({
      id: 6,
      name: "Nisbiy Hajm (RVOL)",
      criteria: "> 2x o'rtacha",
      status: "fail",
      value: rvol > 0 ? `${rvol.toFixed(2)}x` : "Ma'lumot yo'q",
      comment: "Past RVOL — harakat yo'q",
    });
    failCount++;
  }

  // ── UMUMIY XULOSA ──────────────────────────────────────────
  let overallType, overallText;
  if (failCount === 0 && warnCount <= 1) {
    overallType = "strong";
    overallText = "KUCHLI SETUP — Shartlar juda qulay";
  } else if (failCount <= 1 && warnCount <= 2) {
    overallType = "medium";
    overallText = "O'RTA SETUP — Ehtiyotkorlik bilan ko'rib chiqing";
  } else if (failCount <= 2) {
    overallType = "weak";
    overallText = "ZAIF SETUP — Ko'pchilik shartlar bajarilmagan";
  } else {
    overallType = "danger";
    overallText = "YUQORI XAVF — Bu aksiyadan uzoq yuring";
  }

  return {
    filters,
    passCount,
    failCount,
    warnCount,
    totalFilters: filters.length,
    overall: { type: overallType, text: overallText },
  };
}

// ─────────────────────────────────────────
// REJIM 3: GROWTH STOCK
// ─────────────────────────────────────────
async function handleGrowth(ticker, data, aiModel) {
  const prompt = buildFundamentalPrompt(ticker, data, "growth");
  let aiText = "";
  try {
    const aiResp = await aiModel.generateContent(prompt);
    aiText = aiResp.response.text();
  } catch (e) {
    aiText = "AI tahlil vaqtincha mavjud emas.";
  }

  const growthScore = calculateGrowthScore(data);

  return {
    type: "growth",
    aiAnalysis: aiText,
    growthScore,
    metrics: extractDisplayMetrics(data),
  };
}

function calculateGrowthScore(data) {
  let score = 0;
  const factors = [];

  // Revenue o'sishi
  const revGrowth = (data.revenueGrowth || 0) * 100;
  if (revGrowth > 30) {
    score += 25;
    factors.push({ name: "Revenue O'sishi", value: `+${revGrowth.toFixed(1)}%`, points: 25, status: "excellent" });
  } else if (revGrowth > 15) {
    score += 15;
    factors.push({ name: "Revenue O'sishi", value: `+${revGrowth.toFixed(1)}%`, points: 15, status: "good" });
  } else if (revGrowth > 5) {
    score += 5;
    factors.push({ name: "Revenue O'sishi", value: `+${revGrowth.toFixed(1)}%`, points: 5, status: "fair" });
  } else {
    factors.push({ name: "Revenue O'sishi", value: `${revGrowth.toFixed(1)}%`, points: 0, status: "poor" });
  }

  // Gross Margin
  const gm = (data.grossMargins || 0) * 100;
  if (gm > 60) {
    score += 20;
    factors.push({ name: "Gross Margin", value: `${gm.toFixed(1)}%`, points: 20, status: "excellent" });
  } else if (gm > 40) {
    score += 12;
    factors.push({ name: "Gross Margin", value: `${gm.toFixed(1)}%`, points: 12, status: "good" });
  } else if (gm > 20) {
    score += 5;
    factors.push({ name: "Gross Margin", value: `${gm.toFixed(1)}%`, points: 5, status: "fair" });
  } else {
    factors.push({ name: "Gross Margin", value: gm > 0 ? `${gm.toFixed(1)}%` : "N/A", points: 0, status: "poor" });
  }

  // FCF mavjudligi
  if (data.freeCashflow > 0) {
    score += 20;
    factors.push({ name: "FCF Ijobiy", value: formatBillions(data.freeCashflow), points: 20, status: "excellent" });
  } else if (data.freeCashflow < 0) {
    factors.push({ name: "FCF Ijobiy", value: formatBillions(data.freeCashflow), points: 0, status: "poor" });
  } else {
    factors.push({ name: "FCF Ijobiy", value: "N/A", points: 0, status: "fair" });
  }

  // Qarz/Kapital nisbati
  const de = data.debt_equity || 0;
  if (de < 50) {
    score += 15;
    factors.push({ name: "D/E Nisbati", value: `${de.toFixed(0)}%`, points: 15, status: "excellent" });
  } else if (de < 150) {
    score += 8;
    factors.push({ name: "D/E Nisbati", value: `${de.toFixed(0)}%`, points: 8, status: "good" });
  } else {
    factors.push({ name: "D/E Nisbati", value: `${de.toFixed(0)}%`, points: 0, status: "poor" });
  }

  // ROE
  const roe = (data.returnOnEquity || 0) * 100;
  if (roe > 20) {
    score += 20;
    factors.push({ name: "ROE", value: `${roe.toFixed(1)}%`, points: 20, status: "excellent" });
  } else if (roe > 10) {
    score += 10;
    factors.push({ name: "ROE", value: `${roe.toFixed(1)}%`, points: 10, status: "good" });
  } else {
    factors.push({ name: "ROE", value: roe !== 0 ? `${roe.toFixed(1)}%` : "N/A", points: 0, status: "poor" });
  }

  let rating, ratingType;
  if (score >= 80) { rating = "A+ — Kuchli O'sish Aksiyasi"; ratingType = "excellent"; }
  else if (score >= 60) { rating = "B+ — Yaxshi O'sish"; ratingType = "good"; }
  else if (score >= 40) { rating = "C — O'rta O'sish"; ratingType = "fair"; }
  else { rating = "D — Zaif O'sish Ko'rsatkichlari"; ratingType = "poor"; }

  return { score, maxScore: 100, rating, ratingType, factors };
}

// ─────────────────────────────────────────
// REJIM 4: VALUE STOCK
// ─────────────────────────────────────────
async function handleValue(ticker, data, aiModel) {
  const prompt = buildFundamentalPrompt(ticker, data, "value");
  let aiText = "";
  try {
    const aiResp = await aiModel.generateContent(prompt);
    aiText = aiResp.response.text();
  } catch (e) {
    aiText = "AI tahlil vaqtincha mavjud emas.";
  }

  const valueScore = calculateValueScore(data);

  return {
    type: "value",
    aiAnalysis: aiText,
    valueScore,
    metrics: extractDisplayMetrics(data),
  };
}

function calculateValueScore(data) {
  let score = 0;
  const factors = [];

  // P/E arzonligi
  const pe = data.pe_ratio || data.forwardPE || 0;
  if (pe > 0 && pe < 15) {
    score += 25;
    factors.push({ name: "P/E Nisbati", value: `${pe.toFixed(1)}x`, points: 25, status: "excellent" });
  } else if (pe > 0 && pe < 25) {
    score += 12;
    factors.push({ name: "P/E Nisbati", value: `${pe.toFixed(1)}x`, points: 12, status: "good" });
  } else if (pe > 0 && pe < 40) {
    score += 5;
    factors.push({ name: "P/E Nisbati", value: `${pe.toFixed(1)}x`, points: 5, status: "fair" });
  } else {
    factors.push({ name: "P/E Nisbati", value: pe > 0 ? `${pe.toFixed(1)}x` : "N/A", points: 0, status: "poor" });
  }

  // P/B nisbati
  const pb = data.priceToBook || 0;
  if (pb > 0 && pb < 1.5) {
    score += 20;
    factors.push({ name: "P/B Nisbati", value: `${pb.toFixed(2)}x`, points: 20, status: "excellent" });
  } else if (pb > 0 && pb < 3) {
    score += 10;
    factors.push({ name: "P/B Nisbati", value: `${pb.toFixed(2)}x`, points: 10, status: "good" });
  } else {
    factors.push({ name: "P/B Nisbati", value: pb > 0 ? `${pb.toFixed(2)}x` : "N/A", points: 0, status: "poor" });
  }

  // Xavfsizlik marjasi (52w high dan)
  const margin = data.high_52 > 0
    ? ((data.high_52 - data.price) / data.high_52) * 100
    : 0;
  if (margin > 30) {
    score += 20;
    factors.push({ name: "Xavfsizlik Marjasi", value: `${margin.toFixed(1)}% past`, points: 20, status: "excellent" });
  } else if (margin > 15) {
    score += 10;
    factors.push({ name: "Xavfsizlik Marjasi", value: `${margin.toFixed(1)}% past`, points: 10, status: "good" });
  } else {
    factors.push({ name: "Xavfsizlik Marjasi", value: margin > 0 ? `${margin.toFixed(1)}% past` : "N/A", points: 0, status: "poor" });
  }

  // Dividend
  const dy = data.dividendYield || 0;
  if (dy > 4) {
    score += 15;
    factors.push({ name: "Dividend Yield", value: `${dy.toFixed(2)}%`, points: 15, status: "excellent" });
  } else if (dy > 1.5) {
    score += 8;
    factors.push({ name: "Dividend Yield", value: `${dy.toFixed(2)}%`, points: 8, status: "good" });
  } else {
    factors.push({ name: "Dividend Yield", value: dy > 0 ? `${dy.toFixed(2)}%` : "Yo'q", points: 0, status: "fair" });
  }

  // Current Ratio (likvidlik)
  const cr = data.current_ratio || 0;
  if (cr > 2) {
    score += 20;
    factors.push({ name: "Current Ratio", value: `${cr.toFixed(2)}x`, points: 20, status: "excellent" });
  } else if (cr > 1) {
    score += 10;
    factors.push({ name: "Current Ratio", value: `${cr.toFixed(2)}x`, points: 10, status: "good" });
  } else {
    factors.push({ name: "Current Ratio", value: cr > 0 ? `${cr.toFixed(2)}x` : "N/A", points: 0, status: "poor" });
  }

  let rating, ratingType;
  if (score >= 75) { rating = "A+ — Buffett sifatli Value"; ratingType = "excellent"; }
  else if (score >= 55) { rating = "B — Yaxshi Value Imkoniyati"; ratingType = "good"; }
  else if (score >= 35) { rating = "C — O'rta Qiymat"; ratingType = "fair"; }
  else { rating = "D — Qimmat yoki Zaif"; ratingType = "poor"; }

  return { score, maxScore: 100, rating, ratingType, factors };
}

// ─────────────────────────────────────────
// AI PROMPT QURISH (Fundamental)
// ─────────────────────────────────────────
function buildFundamentalPrompt(ticker, data, mode) {
  const baseStats = `Ticker: ${ticker} | Kompaniya: ${data.companyName} | Birja: ${data.exchange}
Joriy narx: $${data.price} | Bozor qiymati: ${formatBillions(data.marketCap)}
P/E (TTM): ${data.pe_ratio?.toFixed(1) || "N/A"} | Forward P/E: ${data.forwardPE?.toFixed(1) || "N/A"} | EPS: $${data.eps_ttm?.toFixed(2) || "N/A"}
Revenue: ${formatBillions(data.revenue_ttm)} | Net Margin: ${data.net_margin?.toFixed(1)}% | Gross Margin: ${((data.grossMargins || 0) * 100).toFixed(1)}%
Qarz/Kapital (D/E): ${data.debt_equity?.toFixed(1) || "N/A"} | Current Ratio: ${data.current_ratio?.toFixed(2) || "N/A"}
FCF: ${formatBillions(data.freeCashflow)} | ROE: ${((data.returnOnEquity || 0) * 100).toFixed(1)}%
52H: $${data.high_52?.toFixed(2) || "N/A"} | 52L: $${data.low_52?.toFixed(2) || "N/A"} | Beta: ${data.beta?.toFixed(2) || "N/A"}`;

  if (mode === "penny") {
    return `Sen tajribali penny stock tahlilchisisan. FAQAT O'ZBEK TILIDA JAVOB YOZ.

${baseStats}

Vazifang:
1. Kompaniya nima qilishini 1-2 jumlada qisqacha ayt.
2. Moliyaviy barqarorligi va ehtimoliy manipulyatsiya xavfini baholaysan.
3. Katalizator mavjudligini (yangiliklar, FDA, shartnoma va h.k.) tekshir.
4. Xulosa: (✅ Sotib olsa bo'ladi / ⚠️ Qulay narxni kuting / ❌ Sotib olmang) va qisqa sabab.

Professional trader tilida, ortiqcha gaplarsiz yoz.`;
  }

  if (mode === "growth") {
    return `Sen Wall Street Growth Stock tahlilchisisan. FAQAT O'ZBEK TILIDA JAVOB YOZ.

${baseStats}

Vazifang (3-6 oylik swing trade uchun):
1. O'sish sur'ati tahlili: Revenue va EPS o'sish dinamikasini baholaysan.
2. Moliyaviy o'sish sifati: PEG nisbati, kash pozitsiyasi, margin tendensiyasi.
3. Bozor pozitsiyasi: Sektor lideri yoki lagerdami? Raqobatchilar?
4. Asosiy xavflar: 3 ta asosiy risk omilini nomlaysan.
5. Xulosa: ✅ SOTIB OLSA BO'LADI / ⚠️ KUTING / ❌ SOTIB OLMANG — aniq narx maqsadi va to'xtatish darajasi bilan.

Professional va aniq yoz.`;
  }

  if (mode === "value") {
    return `Sen Warren Buffett uslubidagi Value Investing tahlilchisisan. FAQAT O'ZBEK TILIDA JAVOB YOZ.

${baseStats}

Vazifang (3-6 oylik swing trade uchun):
1. Intrinsik qiymat va arzonlik: P/E, P/B, P/S nisbatlari bozor o'rtachasiga nisbatan.
2. Moliyaviy mustahkamlik: Qarz darajasi, likvidlik, pul oqimi sifati.
3. Xavfsizlik marjasi: 52 haftalik yuqoridan qancha pastda? Dividend beryaptimi?
4. Raqobat ustunligi (Moat): Kompaniyaning asosiy afzalligi nima?
5. Xulosa: ✅ SOTIB OLSA BO'LADI / ⚠️ KUTING / ❌ SOTIB OLMANG — asosiy sabab va maqsadli narx.

Benjamin Graham va Buffett tamoyillariga asoslanib yoz.`;
  }

  return `${baseStats}\nTahlil qil va o'zbek tilida xulosala.`;
}

// ─────────────────────────────────────────
// YORDAMCHI FUNKSIYALAR
// ─────────────────────────────────────────
function extractDisplayMetrics(data) {
  return {
    price: data.price,
    change_pct: data.change_pct,
    companyName: data.companyName,
    exchange: data.exchange,
    marketCap: data.marketCap,
    pe_ratio: data.pe_ratio,
    forwardPE: data.forwardPE,
    eps_ttm: data.eps_ttm,
    forwardEps: data.forwardEps,
    revenue_ttm: data.revenue_ttm,
    revenueGrowth: data.revenueGrowth,
    net_margin: data.net_margin,
    grossMargins: data.grossMargins,
    debt_equity: data.debt_equity,
    current_ratio: data.current_ratio,
    freeCashflow: data.freeCashflow,
    returnOnEquity: data.returnOnEquity,
    beta: data.beta,
    high_52: data.high_52,
    low_52: data.low_52,
    volume: data.volume,
    avgVolume: data.avgVolume,
    dividendYield: data.dividendYield,
    priceToBook: data.priceToBook,
    priceToSales: data.priceToSales,
  };
}

function tryParseJSON(text) {
  if (!text) return null;
  try {
    let clean = text
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();
    // Faqat {} ichidagi qismni olish
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) clean = match[0];
    return JSON.parse(clean);
  } catch (e) {
    return null;
  }
}

function formatVolume(n) {
  if (!n || n === 0) return "N/A";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return n.toString();
}

function formatBillions(n) {
  if (!n || n === 0 || !isFinite(n)) return "N/A";
  if (Math.abs(n) >= 1e12) return "$" + (n / 1e12).toFixed(2) + "T";
  if (Math.abs(n) >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (Math.abs(n) >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  return "$" + n.toFixed(0);
}
