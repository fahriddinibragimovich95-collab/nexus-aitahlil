/**
 * NeXuS AI — Netlify Serverless Function (PRODUCTION READY v2)
 * Backend: Yahoo Finance (direct fetch) + Google Gemini AI
 * Modes: penny | growth | value | fairvalue
 * 
 * MUHIM: yahoo-finance2 paketidan voz kechildi.
 * Yahoo'ga to'g'ridan-to'g'ri fetch orqali murojaat qilinadi (crumb auth bilan).
 */

const { GoogleGenerativeAI } = require("@google/generative-ai");

// Global cache for Yahoo cookie + crumb (5 daqiqa)
let _yahooAuth = { cookie: null, crumb: null, expiresAt: 0 };

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ─────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────
exports.handler = async function (event) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
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
    ticker = (parsed.ticker || "")
      .toString()
      .replace(/[^a-zA-Z]/g, "")
      .toUpperCase();
    mode = (parsed.mode || "").toString().toLowerCase().trim();

    if (!ticker || !mode) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "ticker va mode parametrlari majburiy.",
        }),
      };
    }

    if (ticker.length < 1 || ticker.length > 6) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: `Noto'g'ri ticker formati: "${ticker}".`,
        }),
      };
    }
  } catch (e) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "JSON parse xatosi: " + e.message }),
    };
  }

  try {
    // ── 1. Yahoo Finance'dan ma'lumot olish ──
    let rawData;
    try {
      rawData = await getYahooQuoteSummary(ticker);
    } catch (e) {
      console.error("Yahoo fetch xato:", e.message);
      // Zaxira: chart API'dan asosiy narxni olish
      try {
        rawData = await getYahooChartFallback(ticker);
      } catch (e2) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({
            error: `"${ticker}" uchun bozor ma'lumotlari topilmadi. Tikerni qayta tekshiring.`,
            detail: e.message,
          }),
        };
      }
    }

    const data = extractYFData(rawData);

    if (!data.price || data.price <= 0) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({
          error: `"${ticker}" — narx ma'lumotlari topilmadi. Ticker noto'g'ri yoki savdoda emas.`,
        }),
      };
    }

    // ── 2. Gemini AI ──
    if (!process.env.GEMINI_API_KEY) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: "GEMINI_API_KEY environment variable o'rnatilmagan.",
        }),
      };
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const aiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    let result = {};
    if (mode === "fairvalue") result = await handleFairValue(ticker, data, aiModel);
    else if (mode === "penny") result = await handlePenny(ticker, data, aiModel);
    else if (mode === "growth") result = await handleGrowth(ticker, data, aiModel);
    else if (mode === "value") result = await handleValue(ticker, data, aiModel);
    else {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: `Noto'g'ri rejim: "${mode}". penny | growth | value | fairvalue`,
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
        error: "Serverda ichki xatolik yuz berdi.",
        detail: err.message || "",
      }),
    };
  }
};

// ─────────────────────────────────────────
// YAHOO FINANCE — DIRECT FETCH (CRUMB AUTH)
// ─────────────────────────────────────────
async function ensureYahooAuth() {
  const now = Date.now();
  if (_yahooAuth.cookie && _yahooAuth.crumb && now < _yahooAuth.expiresAt) {
    return _yahooAuth;
  }

  // Step 1: cookie olish
  const cookieRes = await fetch("https://fc.yahoo.com/", {
    method: "GET",
    headers: { "User-Agent": USER_AGENT },
    redirect: "manual",
  });

  let cookie = "";
  const setCookie = cookieRes.headers.get("set-cookie");
  if (setCookie) {
    cookie = setCookie.split(",").map((c) => c.split(";")[0].trim()).join("; ");
  }

  // Step 2: crumb olish
  const crumbRes = await fetch(
    "https://query2.finance.yahoo.com/v1/test/getcrumb",
    {
      headers: {
        "User-Agent": USER_AGENT,
        Cookie: cookie,
      },
    }
  );

  if (!crumbRes.ok) {
    throw new Error("Yahoo crumb olishda xatolik: " + crumbRes.status);
  }

  const crumb = (await crumbRes.text()).trim();
  if (!crumb || crumb.length < 5) {
    throw new Error("Yahoo'dan to'g'ri crumb kelmadi");
  }

  _yahooAuth = {
    cookie,
    crumb,
    expiresAt: now + 5 * 60 * 1000, // 5 daqiqa
  };
  return _yahooAuth;
}

async function getYahooQuoteSummary(ticker) {
  const modules = ["price", "summaryDetail", "financialData", "defaultKeyStatistics"].join(",");

  // 1-urinish: crumb bilan
  try {
    const { cookie, crumb } = await ensureYahooAuth();
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
      ticker
    )}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`;

    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Cookie: cookie,
        Accept: "application/json",
      },
    });

    const json = await res.json();

    if (json && json.quoteSummary && json.quoteSummary.result && json.quoteSummary.result[0]) {
      return json.quoteSummary.result[0];
    }

    if (json && json.quoteSummary && json.quoteSummary.error) {
      throw new Error("Yahoo xato: " + (json.quoteSummary.error.description || "Topilmadi"));
    }

    throw new Error("Yahoo bo'sh javob qaytardi");
  } catch (e) {
    // Auth cache'ni tozalab qayta urinish
    _yahooAuth = { cookie: null, crumb: null, expiresAt: 0 };
    throw e;
  }
}

// Zaxira: chart API (crumb shart emas) — faqat narx beradi
async function getYahooChartFallback(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    ticker
  )}?interval=1d&range=1y`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  const json = await res.json();
  if (!json.chart || !json.chart.result || !json.chart.result[0]) {
    throw new Error("Chart API ham javob bermadi");
  }
  const r = json.chart.result[0];
  const meta = r.meta || {};

  return {
    price: {
      regularMarketPrice: meta.regularMarketPrice,
      longName: meta.longName || meta.shortName || ticker,
      shortName: meta.shortName || ticker,
      exchangeName: meta.exchangeName || meta.fullExchangeName || "N/A",
      currency: meta.currency || "USD",
      regularMarketVolume: meta.regularMarketVolume || 0,
      marketCap: 0,
    },
    summaryDetail: {
      fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh || 0,
      fiftyTwoWeekLow: meta.fiftyTwoWeekLow || 0,
    },
    financialData: {},
    defaultKeyStatistics: {},
  };
}

// ─────────────────────────────────────────
// YAHOO MA'LUMOTNI TARTIBLASH
// ─────────────────────────────────────────
function extractYFData(yf) {
  const p = yf.price || {};
  const sd = yf.summaryDetail || {};
  const fd = yf.financialData || {};
  const ks = yf.defaultKeyStatistics || {};

  const num = (v) => {
    if (v === null || v === undefined) return 0;
    if (typeof v === "number") return isFinite(v) ? v : 0;
    if (typeof v === "object" && v.raw !== undefined) {
      return typeof v.raw === "number" && isFinite(v.raw) ? v.raw : 0;
    }
    const parsed = parseFloat(v);
    return isNaN(parsed) ? 0 : parsed;
  };

  const str = (v) => {
    if (!v) return null;
    if (typeof v === "string") return v;
    if (typeof v === "object" && v.fmt) return v.fmt;
    return String(v);
  };

  return {
    price: num(p.regularMarketPrice),
    companyName: str(p.longName) || str(p.shortName) || "N/A",
    exchange: str(p.exchangeName) || "N/A",
    currency: str(p.currency) || "USD",
    marketCap: num(p.marketCap) || num(sd.marketCap),
    sharesOutstanding: num(ks.sharesOutstanding) || num(p.sharesOutstanding) || 1,
    beta: num(sd.beta) || num(ks.beta) || 1,
    pe_ratio: num(sd.trailingPE),
    forwardPE: num(sd.forwardPE) || num(ks.forwardPE),
    eps_ttm: num(ks.trailingEps),
    forwardEps: num(fd.forwardEps) || num(ks.forwardEps),
    revenue_ttm: num(fd.totalRevenue),
    revenueGrowth: num(fd.revenueGrowth),
    grossMargins: num(fd.grossMargins),
    net_margin: num(fd.profitMargins) ? num(fd.profitMargins) * 100 : 0,
    operatingMargins: num(fd.operatingMargins),
    returnOnEquity: num(fd.returnOnEquity),
    returnOnAssets: num(fd.returnOnAssets),
    debt_equity: num(fd.debtToEquity),
    current_ratio: num(fd.currentRatio),
    quickRatio: num(fd.quickRatio),
    freeCashflow: num(fd.freeCashflow),
    operatingCashflow: num(fd.operatingCashflow),
    totalCash: num(fd.totalCash),
    totalDebt: num(fd.totalDebt),
    ebitda: num(fd.ebitda),
    priceToSales: num(sd.priceToSalesTrailing12Months),
    priceToBook: num(ks.priceToBook),
    bookValuePerShare: num(ks.bookValue),
    pegRatio: num(ks.pegRatio),
    enterpriseValue: num(ks.enterpriseValue),
    high_52: num(sd.fiftyTwoWeekHigh),
    low_52: num(sd.fiftyTwoWeekLow),
    fiftyDayAvg: num(sd.fiftyDayAverage),
    twoHundredDayAvg: num(sd.twoHundredDayAverage),
    volume: num(p.regularMarketVolume),
    avgVolume: num(sd.averageVolume),
    change_pct: num(p.regularMarketChangePercent) * 100,
    dividendYield: num(sd.dividendYield) * 100,
    payoutRatio: num(sd.payoutRatio),
    sector: str(p.sector) || "N/A",
    industry: str(p.industry) || "N/A",
  };
}

// ─────────────────────────────────────────
// REJIM 1: FAIR VALUE
// ─────────────────────────────────────────
async function handleFairValue(ticker, data, aiModel) {
  const valuationPrompt = buildValuationPrompt(ticker, data);
  let geminiJson = {};

  try {
    const aiResp = await aiModel.generateContent(valuationPrompt);
    const aiText = aiResp.response.text();
    geminiJson = tryParseJSON(aiText) || {};
  } catch (e) {
    console.warn("Gemini FV JSON parse xatosi:", e.message);
  }

  const merged = mergeValuationData(geminiJson, data);
  const valuations = calculateValuations(merged);
  const formatted = formatFairValueResult(ticker, merged, valuations);

  return {
    type: "fairvalue",
    summary: formatted.summary,
    metrics: formatted.metrics,
    valuations: formatted.valuations,
    verdict: formatted.verdict,
    raw: { merged, valuations },
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

Estimate the MISSING forward-looking values. Return ONLY this JSON:
{
  "fyRevenueEst": <number>,
  "fyFcfEst": <number>,
  "adjustedEpsEst": <number>,
  "fcfMarginPct": <number>,
  "expectedGrowthRatePct": <number>,
  "historicalPE": <number>,
  "historicalPS": <number>,
  "sectorPeerRevenueMultiple": <number>
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
    fyRevenueEst: gemini.fyRevenueEst > 0 ? gemini.fyRevenueEst : yf.revenue_ttm || 0,
    fyFcfEst: gemini.fyFcfEst > 0 ? gemini.fyFcfEst : yf.freeCashflow || 0,
    adjustedEpsEst:
      gemini.adjustedEpsEst > 0
        ? gemini.adjustedEpsEst
        : yf.forwardEps || yf.eps_ttm || 0,
    historicalPE:
      gemini.historicalPE > 0
        ? gemini.historicalPE
        : yf.forwardPE || yf.pe_ratio || 15,
    historicalPS: gemini.historicalPS > 0 ? gemini.historicalPS : yf.priceToSales || 2,
    expectedGrowthRatePct:
      gemini.expectedGrowthRatePct && gemini.expectedGrowthRatePct !== 0
        ? gemini.expectedGrowthRatePct
        : (yf.revenueGrowth || 0) * 100 || 5,
    fcfMarginPct: gemini.fcfMarginPct > 0 ? gemini.fcfMarginPct : yf.net_margin || 10,
    sectorPeerRevenueMultiple:
      gemini.sectorPeerRevenueMultiple > 0 ? gemini.sectorPeerRevenueMultiple : 2,
  };
}

function calculateValuations(d) {
  const wacc = 0.095;
  const termGrowth = 0.025;
  const years = 5;
  const shares = d.sharesOutstanding || 1;

  let dcfPv = 0;
  let projFcf = d.fyFcfEst || 0;
  const g = (d.expectedGrowthRatePct || 5) / 100;
  for (let t = 1; t <= years; t++) {
    projFcf *= 1 + g;
    dcfPv += projFcf / Math.pow(1 + wacc, t);
  }
  const termVal = (projFcf * (1 + termGrowth)) / (wacc - termGrowth);
  const tvPv = termVal / Math.pow(1 + wacc, years);
  const dcf = shares > 0 ? (dcfPv + tvPv + (d.netCashPosition || 0)) / shares : 0;

  const peHist = (d.adjustedEpsEst || 0) * (d.historicalPE || 15);
  const conservativePE = d.historicalPE > 0 ? Math.min(d.historicalPE, 18) : 12;
  const peMarket = (d.adjustedEpsEst || 0) * conservativePE;

  const evEbitda =
    shares > 0 && d.ebitda > 0
      ? (d.ebitda * 11 + (d.netCashPosition || 0)) / shares
      : 0;
  const ps =
    shares > 0 && d.fyRevenueEst > 0
      ? (d.fyRevenueEst * (d.historicalPS || 2)) / shares
      : 0;
  const fcfYield = shares > 0 && d.fyFcfEst > 0 ? d.fyFcfEst / 0.08 / shares : 0;
  const epv = d.adjustedEpsEst > 0 ? d.adjustedEpsEst / wacc : 0;
  const grahamRaw = 22.5 * (d.adjustedEpsEst || 0) * (d.bookValuePerShare || 0);
  const graham = grahamRaw > 0 ? Math.sqrt(grahamRaw) : 0;
  const ruleScore = (d.fcfMarginPct || 0) + (d.expectedGrowthRatePct || 0);
  const ruleMultiplier = ruleScore >= 40 ? 4 : d.historicalPS || 2;
  const ruleOf40 =
    shares > 0 && d.fyRevenueEst > 0
      ? (d.fyRevenueEst * ruleMultiplier) / shares
      : 0;
  const peerAvg =
    shares > 0 && d.fyRevenueEst > 0
      ? (d.fyRevenueEst * (d.sectorPeerRevenueMultiple || 2)) / shares
      : 0;

  const all = [dcf, peHist, peMarket, evEbitda, ps, fcfYield, epv, graham, ruleOf40, peerAvg];
  const valid = all.filter((v) => v > 0 && isFinite(v) && !isNaN(v) && v < d.price * 20);
  const average = valid.length > 0 ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;

  return {
    dcf, peHist, peMarket, evEbitda, ps, fcfYield, epv, graham, ruleOf40,
    ruleScore, peerAvg, average, validCount: valid.length,
  };
}

function formatFairValueResult(ticker, d, v) {
  const price = d.price;
  const fv = v.average;
  let upside = 0;
  let verdictText = "—";
  let verdictType = "neutral";

  if (price > 0 && fv > 0) {
    upside = ((fv - price) / price) * 100;
    if (upside > 20) { verdictText = `ARZON — ${upside.toFixed(1)}% potensial`; verdictType = "bullish"; }
    else if (upside > 8) { verdictText = `BIROZ ARZON — ${upside.toFixed(1)}% salohiyat`; verdictType = "mildly-bullish"; }
    else if (upside < -20) { verdictText = `QIMMAT — ${Math.abs(upside).toFixed(1)}% qadrsizlanish`; verdictType = "bearish"; }
    else if (upside < -8) { verdictText = `BIROZ QIMMAT — ${Math.abs(upside).toFixed(1)}% yuqori`; verdictType = "mildly-bearish"; }
    else { verdictText = `ADOLATLI NARXDA — ${upside.toFixed(1)}% farq`; verdictType = "neutral"; }
  }

  const metrics = {
    price, companyName: d.companyName, exchange: d.exchange, marketCap: d.marketCap,
    fyRevenueEst: d.fyRevenueEst, fyFcfEst: d.fyFcfEst, ebitda: d.ebitda,
    adjustedEpsEst: d.adjustedEpsEst, expectedGrowthRatePct: d.expectedGrowthRatePct,
    historicalPE: d.historicalPE, netCashPosition: d.netCashPosition,
    high_52: d.high_52, low_52: d.low_52, beta: d.beta,
  };

  const valuations = [
    { name: "DCF (Chegirmalangan Pul Oqimi)", shortName: "DCF", value: v.dcf, icon: "💎", desc: "5 yillik FCF prognozi, WACC=9.5%" },
    { name: "P/E Tarixiy", shortName: "P/E Tarixiy", value: v.peHist, icon: "📐", desc: `EPS × P/E (${d.historicalPE?.toFixed(1)}x)` },
    { name: "P/E Konservativ", shortName: "P/E Konservativ", value: v.peMarket, icon: "📏", desc: `EPS × min(P/E, 18)` },
    { name: "EV/EBITDA", shortName: "EV/EBITDA", value: v.evEbitda, icon: "🏗️", desc: "EBITDA × 11x + Net Kash" },
    { name: "Price/Sales", shortName: "P/S", value: v.ps, icon: "💼", desc: `Revenue × P/S (${d.historicalPS?.toFixed(1)}x)` },
    { name: "FCF Yield", shortName: "FCF Yield", value: v.fcfYield, icon: "💧", desc: "FCF / 0.08" },
    { name: "EPV", shortName: "EPV", value: v.epv, icon: "⚡", desc: "EPS / WACC" },
    { name: "Graham Raqami", shortName: "Graham", value: v.graham, icon: "🛡️", desc: "√(22.5 × EPS × BV)" },
    { name: "Rule of 40", shortName: "Rule of 40", value: v.ruleOf40, icon: "🚦", desc: `Ball: ${v.ruleScore?.toFixed(1)}` },
    { name: "Sektor Tengdoshlari", shortName: "Peer Avg", value: v.peerAvg, icon: "🤝", desc: "Revenue × Peer multiplier" },
  ];

  return {
    summary: `${ticker} uchun ${v.validCount} usul bo'yicha o'rtacha adolatli narx: $${fv.toFixed(2)}`,
    metrics, valuations,
    verdict: { fairValue: fv, currentPrice: price, upside, text: verdictText, type: verdictType },
  };
}

// ─────────────────────────────────────────
// REJIM 2: PENNY STOCK
// ─────────────────────────────────────────
async function handlePenny(ticker, data, aiModel) {
  const filterResult = runPennyFilters(data);
  const prompt = buildFundamentalPrompt(ticker, data, "penny");
  let aiText = "";
  try {
    const aiResp = await aiModel.generateContent(prompt);
    aiText = aiResp.response.text();
  } catch (e) {
    aiText = "AI tahlil vaqtincha mavjud emas: " + e.message;
  }
  return { type: "penny", filters: filterResult, aiAnalysis: aiText, metrics: extractDisplayMetrics(data) };
}

function runPennyFilters(data) {
  const price = data.price;
  const mc = data.marketCap / 1e6;
  const filters = [];
  let passCount = 0, failCount = 0, warnCount = 0;

  const floatEst = price > 0 && mc > 0 ? mc / price : 0;
  if (floatEst > 0 && floatEst < 30) {
    filters.push({ id: 1, name: "Float", criteria: "< 30M aksiya", status: "pass", value: `~${floatEst.toFixed(1)}M`, comment: "Past float — yuqori volatillik" });
    passCount++;
  } else if (floatEst >= 30 && floatEst < 60) {
    filters.push({ id: 1, name: "Float", criteria: "< 30M aksiya", status: "warn", value: `~${floatEst.toFixed(1)}M`, comment: "Chegarada" });
    warnCount++;
  } else {
    filters.push({ id: 1, name: "Float", criteria: "< 30M aksiya", status: "fail", value: floatEst > 0 ? `~${floatEst.toFixed(1)}M` : "N/A", comment: "Float katta — momentum past" });
    failCount++;
  }

  if (mc > 0 && mc < 20) {
    filters.push({ id: 2, name: "Market Cap", criteria: "< $20M", status: "pass", value: `$${mc.toFixed(2)}M`, comment: "Micro-cap zona" });
    passCount++;
  } else if (mc >= 20 && mc < 60) {
    filters.push({ id: 2, name: "Market Cap", criteria: "< $20M", status: "warn", value: `$${mc.toFixed(2)}M`, comment: "Small-cap chegarasida" });
    warnCount++;
  } else {
    filters.push({ id: 2, name: "Market Cap", criteria: "< $20M", status: "fail", value: mc > 0 ? `$${mc.toFixed(2)}M` : "N/A", comment: "Bozor qiymati katta" });
    failCount++;
  }

  if (price > 0.01 && price <= 5) {
    filters.push({ id: 3, name: "Narx Oralig'i", criteria: "$0.01 — $5", status: "pass", value: `$${price.toFixed(4)}`, comment: "Klassik penny" });
    passCount++;
  } else if (price > 5 && price <= 10) {
    filters.push({ id: 3, name: "Narx Oralig'i", criteria: "$0.01 — $5", status: "warn", value: `$${price.toFixed(2)}`, comment: "Chegarada" });
    warnCount++;
  } else {
    filters.push({ id: 3, name: "Narx Oralig'i", criteria: "$0.01 — $5", status: "fail", value: price > 0 ? `$${price.toFixed(2)}` : "N/A", comment: price <= 0.01 ? "Delisting xavfi" : "Penny chegarasidan yuqori" });
    failCount++;
  }

  if (data.high_52 > 0) {
    const drop = ((price - data.high_52) / data.high_52) * 100;
    if (drop < -80) {
      filters.push({ id: 4, name: "Reverse Split Xavfi", criteria: "< 80% tushmasin", status: "fail", value: `${drop.toFixed(1)}%`, comment: "RS ehtimoli YUQORI" });
      failCount++;
    } else if (drop < -50) {
      filters.push({ id: 4, name: "Reverse Split Xavfi", criteria: "< 80% tushmasin", status: "warn", value: `${drop.toFixed(1)}%`, comment: "O'rta xavf" });
      warnCount++;
    } else {
      filters.push({ id: 4, name: "Reverse Split Xavfi", criteria: "< 80% tushmasin", status: "pass", value: `${drop.toFixed(1)}%`, comment: "Xavf past" });
      passCount++;
    }
  } else {
    filters.push({ id: 4, name: "Reverse Split Xavfi", criteria: "< 80% tushmasin", status: "warn", value: "N/A", comment: "Ma'lumot yo'q" });
    warnCount++;
  }

  const vol = data.volume, avgVol = data.avgVolume;
  if (vol >= 500000) {
    filters.push({ id: 5, name: "Savdo Hajmi", criteria: "> 500K", status: "pass", value: formatVolume(vol), comment: "Yetarli likvidlik" });
    passCount++;
  } else if (vol >= 100000) {
    filters.push({ id: 5, name: "Savdo Hajmi", criteria: "> 500K", status: "warn", value: formatVolume(vol), comment: "O'rta likvidlik" });
    warnCount++;
  } else {
    filters.push({ id: 5, name: "Savdo Hajmi", criteria: "> 500K", status: "fail", value: vol > 0 ? formatVolume(vol) : "N/A", comment: "Past likvidlik" });
    failCount++;
  }

  const rvol = avgVol > 0 ? vol / avgVol : 0;
  if (rvol >= 2) {
    filters.push({ id: 6, name: "RVOL", criteria: "> 2x", status: "pass", value: `${rvol.toFixed(2)}x`, comment: "Momentum harakatda" });
    passCount++;
  } else if (rvol >= 1) {
    filters.push({ id: 6, name: "RVOL", criteria: "> 2x", status: "warn", value: rvol > 0 ? `${rvol.toFixed(2)}x` : "N/A", comment: "O'rtacha RVOL" });
    warnCount++;
  } else {
    filters.push({ id: 6, name: "RVOL", criteria: "> 2x", status: "fail", value: rvol > 0 ? `${rvol.toFixed(2)}x` : "N/A", comment: "Harakat yo'q" });
    failCount++;
  }

  let overallType, overallText;
  if (failCount === 0 && warnCount <= 1) { overallType = "strong"; overallText = "KUCHLI SETUP"; }
  else if (failCount <= 1 && warnCount <= 2) { overallType = "medium"; overallText = "O'RTA SETUP"; }
  else if (failCount <= 2) { overallType = "weak"; overallText = "ZAIF SETUP"; }
  else { overallType = "danger"; overallText = "YUQORI XAVF"; }

  return { filters, passCount, failCount, warnCount, totalFilters: filters.length, overall: { type: overallType, text: overallText } };
}

// ─────────────────────────────────────────
// REJIM 3: GROWTH
// ─────────────────────────────────────────
async function handleGrowth(ticker, data, aiModel) {
  const prompt = buildFundamentalPrompt(ticker, data, "growth");
  let aiText = "";
  try {
    const aiResp = await aiModel.generateContent(prompt);
    aiText = aiResp.response.text();
  } catch (e) { aiText = "AI tahlil vaqtincha mavjud emas: " + e.message; }
  return { type: "growth", aiAnalysis: aiText, growthScore: calculateGrowthScore(data), metrics: extractDisplayMetrics(data) };
}

function calculateGrowthScore(data) {
  let score = 0; const factors = [];
  const revGrowth = (data.revenueGrowth || 0) * 100;
  if (revGrowth > 30) { score += 25; factors.push({ name: "Revenue O'sishi", value: `+${revGrowth.toFixed(1)}%`, points: 25, status: "excellent" }); }
  else if (revGrowth > 15) { score += 15; factors.push({ name: "Revenue O'sishi", value: `+${revGrowth.toFixed(1)}%`, points: 15, status: "good" }); }
  else if (revGrowth > 5) { score += 5; factors.push({ name: "Revenue O'sishi", value: `+${revGrowth.toFixed(1)}%`, points: 5, status: "fair" }); }
  else { factors.push({ name: "Revenue O'sishi", value: `${revGrowth.toFixed(1)}%`, points: 0, status: "poor" }); }

  const gm = (data.grossMargins || 0) * 100;
  if (gm > 60) { score += 20; factors.push({ name: "Gross Margin", value: `${gm.toFixed(1)}%`, points: 20, status: "excellent" }); }
  else if (gm > 40) { score += 12; factors.push({ name: "Gross Margin", value: `${gm.toFixed(1)}%`, points: 12, status: "good" }); }
  else if (gm > 20) { score += 5; factors.push({ name: "Gross Margin", value: `${gm.toFixed(1)}%`, points: 5, status: "fair" }); }
  else { factors.push({ name: "Gross Margin", value: gm > 0 ? `${gm.toFixed(1)}%` : "N/A", points: 0, status: "poor" }); }

  if (data.freeCashflow > 0) { score += 20; factors.push({ name: "FCF Ijobiy", value: formatBillions(data.freeCashflow), points: 20, status: "excellent" }); }
  else if (data.freeCashflow < 0) { factors.push({ name: "FCF Ijobiy", value: formatBillions(data.freeCashflow), points: 0, status: "poor" }); }
  else { factors.push({ name: "FCF Ijobiy", value: "N/A", points: 0, status: "fair" }); }

  const de = data.debt_equity || 0;
  if (de < 50) { score += 15; factors.push({ name: "D/E", value: `${de.toFixed(0)}%`, points: 15, status: "excellent" }); }
  else if (de < 150) { score += 8; factors.push({ name: "D/E", value: `${de.toFixed(0)}%`, points: 8, status: "good" }); }
  else { factors.push({ name: "D/E", value: `${de.toFixed(0)}%`, points: 0, status: "poor" }); }

  const roe = (data.returnOnEquity || 0) * 100;
  if (roe > 20) { score += 20; factors.push({ name: "ROE", value: `${roe.toFixed(1)}%`, points: 20, status: "excellent" }); }
  else if (roe > 10) { score += 10; factors.push({ name: "ROE", value: `${roe.toFixed(1)}%`, points: 10, status: "good" }); }
  else { factors.push({ name: "ROE", value: roe !== 0 ? `${roe.toFixed(1)}%` : "N/A", points: 0, status: "poor" }); }

  let rating, ratingType;
  if (score >= 80) { rating = "A+ Kuchli O'sish"; ratingType = "excellent"; }
  else if (score >= 60) { rating = "B+ Yaxshi O'sish"; ratingType = "good"; }
  else if (score >= 40) { rating = "C O'rta O'sish"; ratingType = "fair"; }
  else { rating = "D Zaif O'sish"; ratingType = "poor"; }

  return { score, maxScore: 100, rating, ratingType, factors };
}

// ─────────────────────────────────────────
// REJIM 4: VALUE
// ─────────────────────────────────────────
async function handleValue(ticker, data, aiModel) {
  const prompt = buildFundamentalPrompt(ticker, data, "value");
  let aiText = "";
  try {
    const aiResp = await aiModel.generateContent(prompt);
    aiText = aiResp.response.text();
  } catch (e) { aiText = "AI tahlil vaqtincha mavjud emas: " + e.message; }
  return { type: "value", aiAnalysis: aiText, valueScore: calculateValueScore(data), metrics: extractDisplayMetrics(data) };
}

function calculateValueScore(data) {
  let score = 0; const factors = [];
  const pe = data.pe_ratio || data.forwardPE || 0;
  if (pe > 0 && pe < 15) { score += 25; factors.push({ name: "P/E", value: `${pe.toFixed(1)}x`, points: 25, status: "excellent" }); }
  else if (pe > 0 && pe < 25) { score += 12; factors.push({ name: "P/E", value: `${pe.toFixed(1)}x`, points: 12, status: "good" }); }
  else if (pe > 0 && pe < 40) { score += 5; factors.push({ name: "P/E", value: `${pe.toFixed(1)}x`, points: 5, status: "fair" }); }
  else { factors.push({ name: "P/E", value: pe > 0 ? `${pe.toFixed(1)}x` : "N/A", points: 0, status: "poor" }); }

  const pb = data.priceToBook || 0;
  if (pb > 0 && pb < 1.5) { score += 20; factors.push({ name: "P/B", value: `${pb.toFixed(2)}x`, points: 20, status: "excellent" }); }
  else if (pb > 0 && pb < 3) { score += 10; factors.push({ name: "P/B", value: `${pb.toFixed(2)}x`, points: 10, status: "good" }); }
  else { factors.push({ name: "P/B", value: pb > 0 ? `${pb.toFixed(2)}x` : "N/A", points: 0, status: "poor" }); }

  const margin = data.high_52 > 0 ? ((data.high_52 - data.price) / data.high_52) * 100 : 0;
  if (margin > 30) { score += 20; factors.push({ name: "Xavfsizlik Marjasi", value: `${margin.toFixed(1)}%`, points: 20, status: "excellent" }); }
  else if (margin > 15) { score += 10; factors.push({ name: "Xavfsizlik Marjasi", value: `${margin.toFixed(1)}%`, points: 10, status: "good" }); }
  else { factors.push({ name: "Xavfsizlik Marjasi", value: margin > 0 ? `${margin.toFixed(1)}%` : "N/A", points: 0, status: "poor" }); }

  const dy = data.dividendYield || 0;
  if (dy > 4) { score += 15; factors.push({ name: "Dividend Yield", value: `${dy.toFixed(2)}%`, points: 15, status: "excellent" }); }
  else if (dy > 1.5) { score += 8; factors.push({ name: "Dividend Yield", value: `${dy.toFixed(2)}%`, points: 8, status: "good" }); }
  else { factors.push({ name: "Dividend Yield", value: dy > 0 ? `${dy.toFixed(2)}%` : "Yo'q", points: 0, status: "fair" }); }

  const cr = data.current_ratio || 0;
  if (cr > 2) { score += 20; factors.push({ name: "Current Ratio", value: `${cr.toFixed(2)}x`, points: 20, status: "excellent" }); }
  else if (cr > 1) { score += 10; factors.push({ name: "Current Ratio", value: `${cr.toFixed(2)}x`, points: 10, status: "good" }); }
  else { factors.push({ name: "Current Ratio", value: cr > 0 ? `${cr.toFixed(2)}x` : "N/A", points: 0, status: "poor" }); }

  let rating, ratingType;
  if (score >= 75) { rating = "A+ Buffett Value"; ratingType = "excellent"; }
  else if (score >= 55) { rating = "B Yaxshi Value"; ratingType = "good"; }
  else if (score >= 35) { rating = "C O'rta Qiymat"; ratingType = "fair"; }
  else { rating = "D Qimmat"; ratingType = "poor"; }

  return { score, maxScore: 100, rating, ratingType, factors };
}

// ─────────────────────────────────────────
// AI PROMPT
// ─────────────────────────────────────────
function buildFundamentalPrompt(ticker, data, mode) {
  const baseStats = `Ticker: ${ticker} | Kompaniya: ${data.companyName} | Birja: ${data.exchange}
Joriy narx (Current Price): $${data.price}
Bozor qiymati (Market Cap): ${formatBillions(data.marketCap)}
P/E (Trailing): ${data.pe_ratio?.toFixed(1) || "N/A"} | Forward P/E: ${data.forwardPE?.toFixed(1) || "N/A"}
EPS (TTM): $${data.eps_ttm?.toFixed(2) || "N/A"} | Forward EPS: $${data.forwardEps?.toFixed(2) || "N/A"}
Total Revenue: ${formatBillions(data.revenue_ttm)} | Revenue Growth: ${((data.revenueGrowth || 0) * 100).toFixed(1)}%
Profit Margins (Net): ${data.net_margin?.toFixed(1)}% | Gross Margin: ${((data.grossMargins || 0) * 100).toFixed(1)}%
Debt/Equity: ${data.debt_equity?.toFixed(1) || "N/A"} | Current Ratio: ${data.current_ratio?.toFixed(2) || "N/A"}
Free Cash Flow: ${formatBillions(data.freeCashflow)} | ROE: ${((data.returnOnEquity || 0) * 100).toFixed(1)}%
52 Week High: $${data.high_52?.toFixed(2) || "N/A"} | 52 Week Low: $${data.low_52?.toFixed(2) || "N/A"}
Beta: ${data.beta?.toFixed(2) || "N/A"} | Dividend Yield: ${data.dividendYield?.toFixed(2) || "0"}%`;

  if (mode === "penny") {
    return `Sen tajribali penny stock va Swing Trading tahlilchisisan. FAQAT O'ZBEK TILIDA professional javob ber.

${baseStats}

CHUQUR Swing Trading tahlili:
1. **Kompaniya haqida**: Nima qiladi, sektor?
2. **Moliyaviy holat**: Barqarorlik, manipulyatsiya xavfi.
3. **Texnik darajalar**:
   - 🟢 Support (Qo'llab-quvvatlash): aniq narxlar
   - 🔴 Resistance (Qarshilik): aniq narxlar
4. **Risklarni boshqarish**: Stop Loss narxi, Position size %
5. **Target narxlar (1-4 hafta)**: 🎯 Target 1, 🎯 Target 2
6. **Yakuniy HUKM**: ✅ SOTIB OL / ⚠️ KUT / ❌ SOTMA

Professional trader tilida yoz.`;
  }

  if (mode === "growth") {
    return `Sen Wall Street Growth Stock va Swing Trading tahlilchisisan. FAQAT O'ZBEK TILIDA javob ber.

${baseStats}

3-6 oylik Swing Trade tahlili:
1. **O'sish dinamikasi**: Revenue, EPS, margin tendensiyasi.
2. **Moliyaviy mustahkamlik**: FCF, kash, qarz.
3. **Bozor pozitsiyasi**: Sektor lideri?
4. **Texnik darajalar**: 🟢 Support, 🔴 Resistance (aniq narxlar)
5. **Risklarni boshqarish**: Stop Loss, Risk/Reward 1:?
6. **Target narxlar**: 🎯 1-2 oy, 🎯 3-6 oy
7. **3 ta XAVF omillari**
8. **HUKM**: ✅ SOTIB OL / ⚠️ KUT / ❌ SOTMA — aniq sabab bilan.

Professional yoz.`;
  }

  if (mode === "value") {
    return `Sen Warren Buffett uslubidagi Value + Swing Trading tahlilchisisan. FAQAT O'ZBEK TILIDA javob ber.

${baseStats}

3-6 oylik Swing Trade Value tahlili:
1. **Intrinsik qiymat**: P/E, P/B, P/S — arzonmi?
2. **Moliyaviy mustahkamlik**: D/E, likvidlik, FCF.
3. **Margin of Safety**: 52w highdan necha %?
4. **Moat (Raqobat ustunligi)**: Asosiy afzallik.
5. **Texnik darajalar**: 🟢 Support, 🔴 Resistance
6. **Risklarni boshqarish**: Stop Loss, Position size
7. **Target narxlar**: 🎯 Fair Value, 🎯 Optimistik
8. **HUKM**: ✅ SOTIB OL / ⚠️ KUT / ❌ SOTMA — asosiy sabab va target.

Buffett-Graham tamoyillariga asosan yoz.`;
  }

  return `${baseStats}\n\nProfessional o'zbek tilida chuqur Swing Trading tahlili. Support/Resistance, Stop Loss, Target va Hukm kiritilsin.`;
}

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────
function extractDisplayMetrics(data) {
  return {
    price: data.price, change_pct: data.change_pct,
    companyName: data.companyName, exchange: data.exchange,
    marketCap: data.marketCap, pe_ratio: data.pe_ratio,
    forwardPE: data.forwardPE, eps_ttm: data.eps_ttm, forwardEps: data.forwardEps,
    revenue_ttm: data.revenue_ttm, revenueGrowth: data.revenueGrowth,
    net_margin: data.net_margin, grossMargins: data.grossMargins,
    debt_equity: data.debt_equity, current_ratio: data.current_ratio,
    freeCashflow: data.freeCashflow, returnOnEquity: data.returnOnEquity,
    beta: data.beta, high_52: data.high_52, low_52: data.low_52,
    volume: data.volume, avgVolume: data.avgVolume,
    dividendYield: data.dividendYield, priceToBook: data.priceToBook,
    priceToSales: data.priceToSales,
  };
}

function tryParseJSON(text) {
  if (!text) return null;
  try {
    let clean = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) clean = match[0];
    return JSON.parse(clean);
  } catch (e) { return null; }
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
