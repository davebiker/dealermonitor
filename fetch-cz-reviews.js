// Škoda CZ Reviews Fetcher
// Načte skoda-dealers-cz.json, stáhne reviews, uloží cz-real-data.json
// Použití: node fetch-cz-reviews.js

const fs = require("fs");

const API_KEY = process.env.GOOGLE_PLACES_API_KEY || "VLOZ_SVUJ_API_KLIC_ZDE";
const INPUT_FILE = "skoda-dealers-cz.json";
const OUTPUT_FILE = "cz-real-data.json";

// Kolik dealerů zpracovat (Places API vrací max 5 reviews na place)
// Pro MVP začni s prvními 50, pak zvyš
const MAX_DEALERS = 241;

// Pauza mezi requesty (ms) — předejde rate limiting
const DELAY_MS = 200;

async function fetchPlaceDetails(placeId) {
  const url = `https://places.googleapis.com/v1/places/${placeId}`;
  const response = await fetch(url, {
    headers: {
      "X-Goog-Api-Key": API_KEY,
      "X-Goog-FieldMask": [
        "id",
        "displayName",
        "formattedAddress",
        "rating",
        "userRatingCount",
        "internationalPhoneNumber",
        "websiteUri",
        "location",
        "reviews",
        "regularOpeningHours",
        "photos",
      ].join(","),
    },
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Places API error ${response.status}: ${err}`);
  }

  return response.json();
}

function extractCity(address) {
  // "Závodní 3045, 434 01 Most, Česko" → "Most"
  const parts = address.split(",").map((p) => p.trim());
  if (parts.length >= 2) {
    // Druhý nebo třetí segment obvykle obsahuje město
    const cityPart = parts[parts.length - 2] || parts[0];
    // Odstraň PSČ (5 číslic na začátku)
    return cityPart.replace(/^\d{3}\s?\d{2}\s+/, "").trim();
  }
  return parts[0];
}

function convertReviews(rawReviews, placeId) {
  if (!rawReviews || rawReviews.length === 0) return [];

  return rawReviews.map((r, i) => {
    const publishTime = r.publishTime || new Date().toISOString();
    const date = new Date(publishTime);
    const daysAgo = Math.floor((Date.now() - date.getTime()) / 86400000);

    return {
      id: `${placeId}-r${i}`,
      stars: r.rating || 3,
      text: r.text?.text || r.originalText?.text || "",
      date: date.toISOString().split("T")[0],
      daysAgo: Math.max(0, daysAgo),
      author: r.authorAttribution?.displayName || "Anonymous",
      langCode: r.text?.languageCode || "cs",
      langName: "Czech",
      localText: "",
      authorPhotoUri: r.authorAttribution?.photoUri || "",
      relativePublishTimeDescription: r.relativePublishTimeDescription || "",
    };
  });
}

function calculateSentiments(reviews) {
  // Jednoduchá heuristika z ratings
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  reviews.forEach((r) => counts[r.stars]++);
  const total = reviews.length || 1;

  const posCount = counts[4] + counts[5];
  const negCount = counts[1] + counts[2];
  const neuCount = counts[3];

  const mkSentiment = (posVar, negVar) => ({
    pos: Math.round((posCount / total) * 100) + posVar,
    neu: Math.round((neuCount / total) * 100),
    neg: Math.round((negCount / total) * 100) + negVar,
  });

  return {
    service: mkSentiment(0, 0),
    sales: mkSentiment(5, -2),
    parts: mkSentiment(-5, 3),
    communication: mkSentiment(-3, 2),
    value: mkSentiment(-8, 5),
  };
}

function buildAlerts(rating, negPct, reviewCount) {
  const alerts = [];
  if (rating < 3.5) alerts.push({ severity: "critical", text: `Nízké hodnocení: ${rating}★` });
  else if (rating < 4.0) alerts.push({ severity: "high", text: `Podprůměrné hodnocení: ${rating}★` });
  if (negPct > 25) alerts.push({ severity: "critical", text: `${negPct}% negativních recenzí` });
  else if (negPct > 15) alerts.push({ severity: "high", text: `${negPct}% negativních recenzí` });
  if (reviewCount < 20) alerts.push({ severity: "medium", text: `Málo recenzí: ${reviewCount}` });
  return alerts;
}

function generateMonthlyData(rating) {
  const months = ["Sep", "Oct", "Nov", "Dec", "Jan", "Feb"];
  return months.map((m) => ({
    month: m,
    rating: Math.max(1, Math.min(5, rating + (Math.random() - 0.5) * 0.3)),
    reviews: Math.floor(10 + Math.random() * 40),
  }));
}

async function main() {
  console.log("🚗 Škoda CZ Reviews Fetcher");
  console.log("============================");

  if (API_KEY === "VLOZ_SVUJ_API_KLIC_ZDE") {
    console.error("❌ Nastav svůj API klíč!");
    process.exit(1);
  }

  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`❌ Soubor ${INPUT_FILE} nenalezen. Spusť nejdřív skoda-dealer-discovery.js`);
    process.exit(1);
  }

  const dealers = JSON.parse(fs.readFileSync(INPUT_FILE, "utf-8"));
  const toProcess = dealers.slice(0, MAX_DEALERS);

  console.log(`📋 Zpracovávám ${toProcess.length} z ${dealers.length} dealerů...`);
  console.log(`⏱  Odhadovaný čas: ~${Math.ceil(toProcess.length * DELAY_MS / 1000)}s\n`);

  const results = [];
  let success = 0;
  let failed = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const dealer = toProcess[i];
    process.stdout.write(`[${i + 1}/${toProcess.length}] ${dealer.name.substring(0, 40).padEnd(40)} `);

    try {
      const details = await fetchPlaceDetails(dealer.place_id);

      const reviews = convertReviews(details.reviews, dealer.place_id);
      const negativeReviews = reviews.filter((r) => r.stars <= 2);
      const negPct = reviews.length > 0 ? Math.round((negativeReviews.length / reviews.length) * 100) : 0;
      const rating = details.rating || dealer.rating || 0;
      const city = extractCity(dealer.address);
      const reviewCount = details.userRatingCount || dealer.review_count || 0;

      const dealerObj = {
        id: dealer.place_id,
        name: dealer.name,
        city,
        country: "CZ",
        countryName: "Czech Republic",
        flag: "🇨🇿",
        address: dealer.address,
        lat: dealer.lat,
        lng: dealer.lng,
        rating,
        reviewCount,
        negativePercent: negPct,
        trend: 0,
        isMultibrand: false,
        brands: ["ŠKODA"],
        placeId: dealer.place_id,
        phone: dealer.phone,
        website: dealer.website,
        sentiments: calculateSentiments(reviews),
        alerts: buildAlerts(rating, negPct, reviewCount),
        recentReviews: reviews,
        monthlyData: [], // will be populated from snapshots over time
        profileQuality: null,
        hasRealData: true,
        photoCount: details.photos?.length || 0,
        hasOpeningHours: !!details.regularOpeningHours,
      };

      results.push(dealerObj);
      success++;
      console.log(`✅ ${reviews.length} reviews, ${rating}★`);
    } catch (err) {
      failed++;
      console.log(`❌ ${err.message.substring(0, 50)}`);
    }

    if (i < toProcess.length - 1) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }

  // Výstupní formát pro dashboard — { CZ: [...dealers] }
  const output = { CZ: results };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf-8");

  const avgRating = results.reduce((s, d) => s + d.rating, 0) / results.length;
  const withAlerts = results.filter((d) => d.alerts.length > 0).length;

  console.log(`\n🎉 Hotovo!`);
  console.log(`   ✅ Úspěšně: ${success} dealerů`);
  console.log(`   ❌ Selhalo: ${failed} dealerů`);
  console.log(`   ⭐ Průměrný rating: ${avgRating.toFixed(2)}`);
  console.log(`   🔔 Dealerů s alertem: ${withAlerts}`);
  console.log(`\n📁 Uloženo: ${OUTPUT_FILE}`);
  console.log(`\nDalší krok: zkopíruj ${OUTPUT_FILE} do složky dealermonitor/`);
  console.log(`Dashboard ho automaticky načte pro CZ.`);
}

main().catch(console.error);
