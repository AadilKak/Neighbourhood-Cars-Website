const DEFAULT_API_BASE = "https://marketplace-system-lf78.onrender.com";
const DEFAULT_DEALER_SLUG = "neighborhood-used-cars";
const DEFAULT_DEALER_KEY = "nuc2024";
const DEFAULT_FACEBOOK_PROFILE_URL = "https://www.facebook.com/marketplace/profile/100057362652664";
const AUTO_ALARM = "nuc-auto-enrich";
const AUTO_INTERVAL_MINUTES = 30;

let isAutoRunning = false;
let cancelRequested = false;
let activeAutoTabId = null;

chrome.runtime.onInstalled.addListener(async () => {
  const saved = await chrome.storage.local.get(["apiBase", "dealerSlug", "dealerKey", "facebookProfileUrl"]);
  await chrome.storage.local.set({
    autoEnrichEnabled: true,
    apiBase: saved.apiBase || DEFAULT_API_BASE,
    dealerSlug: saved.dealerSlug || DEFAULT_DEALER_SLUG,
    dealerKey: saved.dealerKey || DEFAULT_DEALER_KEY,
    facebookProfileUrl: saved.facebookProfileUrl || DEFAULT_FACEBOOK_PROFILE_URL,
  });
  ensureAutoAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAutoAlarm();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_ALARM) {
    runAutoScanAndEnrich(false);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "NUC_AUTO_STATUS") {
    chrome.storage.local.get(["autoEnrichEnabled", "lastAutoEnrich"], (data) => {
      if (data.autoEnrichEnabled !== false) ensureAutoAlarm();
      sendResponse({
        enabled: data.autoEnrichEnabled !== false,
        running: isAutoRunning,
        last: data.lastAutoEnrich || null,
      });
    });
    return true;
  }

  if (message.type === "NUC_SET_AUTO") {
    chrome.storage.local.set({ autoEnrichEnabled: !!message.enabled }, async () => {
      if (message.enabled) {
        ensureAutoAlarm();
        runAutoScanAndEnrich(true);
      } else {
        chrome.alarms.clear(AUTO_ALARM);
      }
      sendResponse({ ok: true, enabled: !!message.enabled });
    });
    return true;
  }

  if (message.type === "NUC_RUN_AUTO_NOW") {
    runAutoScanAndEnrich(true).then(sendResponse);
    return true;
  }

  if (message.type === "NUC_SCAN_PROFILE_NOW") {
    runProfileScanAndEnrich(true).then(sendResponse);
    return true;
  }

  if (message.type === "NUC_STOP_AUTO") {
    requestStopCurrentRun().then(sendResponse);
    return true;
  }
});

async function requestStopCurrentRun() {
  cancelRequested = true;
  chrome.alarms.clear(AUTO_ALARM);
  if (activeAutoTabId) {
    try { await chrome.tabs.remove(activeAutoTabId); } catch (e) {}
    activeAutoTabId = null;
  }
  const settings = await chrome.storage.local.get(["autoEnrichEnabled"]);
  if (settings.autoEnrichEnabled !== false) ensureAutoAlarm();
  const message = isAutoRunning ? "Stop requested. Current scan will end now." : "No scan is running.";
  await saveLastAuto(message);
  return { ok: true, message };
}

function startRun() {
  cancelRequested = false;
  isAutoRunning = true;
}

function finishRun() {
  isAutoRunning = false;
  activeAutoTabId = null;
}

function throwIfCancelled() {
  if (cancelRequested) throw new Error("Stopped by user.");
}

function ensureAutoAlarm() {
  chrome.alarms.create(AUTO_ALARM, {
    delayInMinutes: AUTO_INTERVAL_MINUTES,
    periodInMinutes: AUTO_INTERVAL_MINUTES,
  });
}

async function runAutoEnrich(manual) {
  if (isAutoRunning) return { ok: false, message: "Auto enrich is already running." };

  const settings = await chrome.storage.local.get(["autoEnrichEnabled"]);
  if (!manual && settings.autoEnrichEnabled === false) {
    return { ok: true, message: "Auto enrich is off." };
  }

  startRun();
  try {
    const settings = await getDealerSettings();
    const needs = await fetchNeedsDetails(settings);
    const listings = (needs.listings || []).filter((listing) =>
      listing.facebook_source_url && listing.facebook_source_url.includes("facebook.com/marketplace/item/")
    );

    if (!listings.length) {
      const message = `No listings need details. Checked ${settings.apiBase} (${needs.count || 0} queued).`;
      await saveLastAuto(message);
      return { ok: true, message, queued: needs.count || 0 };
    }

    let updated = 0;
    let failed = 0;
    for (const listing of listings.slice(0, 3)) {
      throwIfCancelled();
      const result = await scrapeListingUrl(listing.facebook_source_url, settings);
      if (result.ok) updated += 1;
      else failed += 1;
      await delay(2500, true);
    }
    throwIfCancelled();

    const message = `Auto enrich finished: ${updated} updated, ${failed} failed. Checked ${settings.apiBase} (${listings.length} queued).`;
    await saveLastAuto(message);
    return { ok: failed === 0, message, updated, failed, queued: listings.length };
  } catch (err) {
    const message = "Auto enrich error: " + (err && err.message ? err.message : String(err));
    await saveLastAuto(message);
    return { ok: false, message };
  } finally {
    finishRun();
  }
}

async function runAutoScanAndEnrich(manual) {
  const settings = await chrome.storage.local.get(["autoEnrichEnabled"]);
  if (!manual && settings.autoEnrichEnabled === false) {
    return { ok: true, message: "Auto scan is off." };
  }

  const scanResult = await runProfileScanOnly(manual);
  if (scanResult.ok === false) {
    const enrichResult = await runAutoEnrich(manual);
    if (String(scanResult.message || "").includes("Facebook profile URL")) return enrichResult;
    return {
      ok: enrichResult.ok !== false,
      message: `${scanResult.message} ${enrichResult.message || ""}`.trim(),
      scanResult,
      enrichResult,
    };
  }

  const enrichResult = await runAutoEnrich(manual);
  const message = `${scanResult.message} ${enrichResult.message || ""}`.trim();
  await saveLastAuto(message);
  return {
    ok: enrichResult.ok !== false,
    message,
    scanResult,
    enrichResult,
  };
}

async function getDealerSettings() {
  const saved = await chrome.storage.local.get(["apiBase", "dealerSlug", "dealerKey", "facebookProfileUrl"]);
  return {
    apiBase: (saved.apiBase || DEFAULT_API_BASE).trim().replace(/\/+$/, ""),
    dealerSlug: (saved.dealerSlug || DEFAULT_DEALER_SLUG).trim(),
    dealerKey: (saved.dealerKey || DEFAULT_DEALER_KEY).trim(),
    facebookProfileUrl: (saved.facebookProfileUrl || DEFAULT_FACEBOOK_PROFILE_URL).trim(),
  };
}

function listingEndpoint(settings) {
  if (isCustomerBackend(settings)) {
    return `${settings.apiBase}/api/listings`;
  }
  if (settings.dealerSlug) {
    return `${settings.apiBase}/api/dealers/${encodeURIComponent(settings.dealerSlug)}/listings`;
  }
  return `${settings.apiBase}/api/listings`;
}

function isCustomerBackend(settings) {
  return /^https?:\/\/(localhost|127\.0\.0\.1):8020$/i.test(settings.apiBase || "");
}

function needsDetailsEndpoint(settings) {
  if (settings.dealerSlug) {
    return `${settings.apiBase}/api/dealers/${encodeURIComponent(settings.dealerSlug)}/needs-details`;
  }
  return `${settings.apiBase}/api/needs-details`;
}

async function fetchNeedsDetails(settings) {
  if (isCustomerBackend(settings)) {
    const rows = await fetchJson(listingEndpoint(settings));
    const listings = rows.filter((row) =>
      !row.is_sold &&
      row.facebook_source_url &&
      (
        row.source === "facebook" ||
        row.source === "sync"
      ) &&
      (
        !row.description ||
        !row.mileage ||
        !row.transmission ||
        /^(not found|see fb listing)$/i.test(String(row.mileage).trim()) ||
        /^(not found|see fb listing)$/i.test(String(row.transmission).trim())
      )
    ).map((row) => ({
      id: row.id,
      title: row.title,
      price: row.price,
      facebook_source_url: row.facebook_source_url,
      needs_enrich: true,
    }));
    return { count: listings.length, listings };
  }
  return fetchJson(needsDetailsEndpoint(settings));
}

function extensionConfigEndpoint(settings) {
  return `${settings.apiBase}/api/dealers/${encodeURIComponent(settings.dealerSlug)}/extension-config`;
}

function dealerEndpoint(settings) {
  return `${settings.apiBase}/api/dealers/${encodeURIComponent(settings.dealerSlug)}`;
}

function importFbSyncEndpoint(settings) {
  if (settings.dealerSlug) {
    return `${settings.apiBase}/api/dealers/${encodeURIComponent(settings.dealerSlug)}/import-fb-sync`;
  }
  return `${settings.apiBase}/api/import-fb-sync`;
}

async function fetchExtensionConfig(settings) {
  let privateConfig = {};
  try {
    const response = await fetch(extensionConfigEndpoint(settings), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: settings.dealerKey }),
    });
    if (response.ok) privateConfig = await response.json();
  } catch (e) {}

  if (privateConfig.facebook_profile_url) return privateConfig;

  let publicConfig = {};
  try {
    publicConfig = await fetchJson(dealerEndpoint(settings));
  } catch (e) {}
  return {
    ...publicConfig,
    customer_backend_url: privateConfig.customer_backend_url || "",
    customer_sync_token: privateConfig.customer_sync_token || "",
    facebook_profile_url: publicConfig.facebook_profile_url || settings.facebookProfileUrl || "",
  };
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

async function saveLastAuto(message) {
  await chrome.storage.local.set({
    lastAutoEnrich: {
      at: new Date().toISOString(),
      message,
    },
  });
}

async function runProfileScanAndEnrich(manual) {
  const scanResult = await runProfileScanOnly(manual);
  if (scanResult.ok === false) return scanResult;

  const enrichResult = await runAutoEnrich(true);
  const message = `${scanResult.message} ${enrichResult.message || ""}`.trim();
  await saveLastAuto(message);
  return {
    ok: enrichResult.ok !== false,
    message,
    scanResult,
    enrichResult,
  };
}

async function runProfileScanOnly(manual) {
  if (isAutoRunning) return { ok: false, message: "Auto scan/enrich is already running." };

  startRun();
  try {
    const settings = await getDealerSettings();
    if (isLocalApiBase(settings.apiBase)) {
      return await runLocalNodriverSync(settings);
    }

    if (!settings.dealerSlug) throw new Error("Dealer slug is required for profile scan.");

    const dealer = await fetchExtensionConfig(settings);
    const profileUrl = (dealer.facebook_profile_url || settings.facebookProfileUrl || "").trim();
    if (!profileUrl) throw new Error("Dealer has no Facebook profile URL saved in the backend.");

    throwIfCancelled();
    const scan = await scanProfileUrl(profileUrl);
    throwIfCancelled();
    const listings = scan.listings || [];
    if (!listings.length) {
      const message = "Profile scan found no Marketplace listings.";
      await saveLastAuto(message);
      return { ok: false, message };
    }
    const importResult = await importProfileListings(listings, settings);
    throwIfCancelled();
    const customerSyncResult = await syncCustomerBackend(settings, dealer);
    throwIfCancelled();
    const inventoryResult = await fetchInventorySummary(settings);
    throwIfCancelled();

    const customerMessage = customerSyncResult?.skipped ? "" : `Customer backend synced ${customerSyncResult.total_received || 0} listing(s).`;
    const inventoryMessage = inventoryResult?.skipped ? "" : `Backend inventory: ${inventoryResult.active} active / ${inventoryResult.total} total.`;
    const message = `Profile scan found ${listings.length} Facebook listing(s). ${importResult.message || ""} ${customerMessage} ${inventoryMessage}`.trim();
    await saveLastAuto(message);
    return {
      ok: true,
      message,
      scanned: listings.length,
      importResult,
      customerSyncResult,
      inventoryResult,
    };
  } catch (err) {
    const message = "Profile scan error: " + (err && err.message ? err.message : String(err));
    await saveLastAuto(message);
    return { ok: false, message };
  } finally {
    finishRun();
  }
}

function isLocalApiBase(apiBase) {
  return /^https?:\/\/(localhost|127\.0\.0\.1):8000$/i.test(apiBase || "");
}

async function runLocalNodriverSync(settings) {
  const form = new URLSearchParams();
  form.set("key", settings.dealerKey);

  const response = await fetch(`${settings.apiBase}/api/sync-fb`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!response.ok) throw new Error(`Local nodriver sync failed: ${response.status}`);

  const result = await response.json();
  throwIfCancelled();
  const inventoryResult = await fetchInventorySummary(settings);
  const scanned = result.scanned ?? result.count ?? result.profile_count ?? "";
  const scannedMessage = scanned === "" ? "Local nodriver scan finished." : `Local nodriver scan found ${scanned} Facebook listing(s).`;
  const inventoryMessage = inventoryResult?.skipped ? "" : `Backend inventory: ${inventoryResult.active} active / ${inventoryResult.total} total.`;
  const message = `${scannedMessage} ${result.message || ""} ${inventoryMessage}`.trim();
  await saveLastAuto(message);
  return {
    ok: true,
    message,
    importResult: result,
    inventoryResult,
  };
}

async function importProfileListings(listings, settings) {
  if (isCustomerBackend(settings)) {
    const payload = {
      mark_missing_sold: true,
      listings: listings.map((item) => ({
        title: item.title || "Untitled listing",
        price: item.price || "",
        mileage: "See FB listing",
        transmission: "See FB listing",
        description: item.description || "",
        facebook_source_url: item.fb_url || item.facebook_source_url || null,
        permanent_photos: item.photos || [],
        details: {},
        is_sold: !!item.is_sold,
      })),
    };
    const response = await fetch(`${settings.apiBase}/api/sync/facebook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${settings.dealerKey}`,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`Customer profile import failed: ${response.status}`);
    const result = await response.json();
    return {
      status: "success",
      message: `Synced ${result.created || 0} new, ${result.marked_sold || 0} sold.`,
      ...result,
    };
  }

  const response = await fetch(importFbSyncEndpoint(settings), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: settings.dealerKey, listings }),
  });
  if (!response.ok) throw new Error(`Profile import failed: ${response.status}`);
  return response.json();
}

async function syncCustomerBackend(settings, dealer) {
  if (!isCustomerBackend(settings)) {
    return { skipped: true };
  }

  const customerBackendUrl = (dealer.customer_backend_url || "").trim().replace(/\/+$/, "");
  const customerSyncToken = (dealer.customer_sync_token || "").trim();
  if (!customerBackendUrl || !customerSyncToken) {
    return { skipped: true };
  }
  const serviceListings = await fetchJson(listingEndpoint(settings));
  const payload = {
    mark_missing_sold: true,
    listings: serviceListings.map((item) => ({
      title: item.title || "Untitled listing",
      price: item.price || "",
      mileage: item.mileage || "",
      transmission: item.transmission || "",
      description: item.description || "",
      facebook_source_url: item.facebook_source_url || null,
      permanent_photos: item.permanent_photos || [],
      details: item.details || {},
      is_sold: !!item.is_sold,
    })),
  };
  const response = await fetch(`${customerBackendUrl}/api/sync/facebook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${customerSyncToken}`,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Customer backend sync failed: ${response.status}`);
  return response.json();
}

async function fetchInventorySummary(settings) {
  try {
    const rows = await fetchJson(listingEndpoint(settings));
    if (!Array.isArray(rows)) return { skipped: true };
    const active = rows.filter((row) => !row.is_sold).length;
    return { total: rows.length, active };
  } catch (e) {
    return { skipped: true };
  }
}

async function scanProfileUrl(profileUrl) {
  let tab;
  try {
    throwIfCancelled();
    tab = await chrome.tabs.create({ url: profileUrl, active: true });
    activeAutoTabId = tab.id;
    await waitForTabReady(tab.id);
    await delay(4500, true);
    throwIfCancelled();

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      function: profileScanRoutine,
    });
    const scan = results && results[0] && results[0].result;
    if (!scan || scan.success === false) {
      throw new Error((scan && scan.error) || "Profile scan failed.");
    }

    await delay(1200, true);
    await chrome.tabs.remove(tab.id);
    activeAutoTabId = null;
    return scan;
  } catch (err) {
    if (tab && tab.id) {
      try { await chrome.tabs.remove(tab.id); } catch (e) {}
    }
    if (activeAutoTabId === tab?.id) activeAutoTabId = null;
    throw err;
  }
}

async function scrapeListingUrl(url, settings) {
  let tab;
  try {
    throwIfCancelled();
    tab = await chrome.tabs.create({ url, active: true });
    activeAutoTabId = tab.id;
    await waitForTabReady(tab.id);
    await delay(3500, true);
    throwIfCancelled();

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      function: localScraperRoutine,
    });

    const scrapedData = results && results[0] && results[0].result;
    if (!scrapedData || scrapedData.success === false) {
      throw new Error((scrapedData && scrapedData.error) || "Facebook scrape failed.");
    }

    if (scrapedData.images && scrapedData.images.length) {
      scrapedData.images = await toDataUrls(scrapedData.images);
    }

    const saveResult = await saveScrapedListing(scrapedData, settings);
    if (!saveResult.ok) throw new Error(`Save failed: ${saveResult.status}`);

    await delay(1200, true);
    await chrome.tabs.remove(tab.id);
    activeAutoTabId = null;
    return { ok: true };
  } catch (err) {
    if (tab && tab.id) {
      try { await chrome.tabs.remove(tab.id); } catch (e) {}
    }
    if (activeAutoTabId === tab?.id) activeAutoTabId = null;
    console.error("[NUC auto enrich]", err);
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

async function saveScrapedListing(scrapedData, settings) {
  if (isCustomerBackend(settings)) {
    const payload = {
      mark_missing_sold: false,
      listings: [{
        title: scrapedData.title || "Untitled listing",
        price: scrapedData.price || "",
        mileage: scrapedData.mileage || "",
        transmission: scrapedData.transmission || "",
        description: scrapedData.description || "",
        facebook_source_url: scrapedData.url || null,
        details: scrapedData.details || {},
        images: (scrapedData.images || []).map((dataUrl, index) => ({
          filename: `listing-${index + 1}.jpg`,
          content_type: "image/jpeg",
          data_base64: dataUrl,
        })),
      }],
    };
    return fetch(`${settings.apiBase}/api/sync/facebook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${settings.dealerKey}`,
      },
      body: JSON.stringify(payload),
    });
  }

  scrapedData.key = settings.dealerKey;
  return fetch(listingEndpoint(settings), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(scrapedData),
  });
}

function waitForTabReady(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Facebook listing tab did not finish loading."));
    }, 45000);

    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

function delay(ms, cancellable = false) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (cancellable && cancelRequested) {
        reject(new Error("Stopped by user."));
        return;
      }
      if (Date.now() - started >= ms) {
        resolve();
        return;
      }
      setTimeout(tick, Math.min(250, ms));
    };
    tick();
  });
}

async function toDataUrls(urls) {
  const out = [];
  for (const u of urls) {
    try {
      const resp = await fetch(u);
      if (!resp.ok) continue;
      const blob = await resp.blob();
      const dataUrl = await blobToDataUrl(blob);
      if (dataUrl && dataUrl.indexOf("data:image") === 0) out.push(dataUrl);
    } catch (e) {}
  }
  return out;
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return `data:${blob.type || "image/jpeg"};base64,${btoa(binary)}`;
}

async function localScraperRoutine() {
  try {
    const modalElement = Array.from(document.querySelectorAll('div[role="dialog"]')).find(el => el.getBoundingClientRect().width > 500);
    const activeContext = modalElement ? modalElement : document.body;

    let rawTitle = "";
    if (modalElement) {
      const h1El = modalElement.querySelector('h1');
      if (h1El) rawTitle = h1El.innerText;
    }
    if (!rawTitle) {
      rawTitle = document.querySelector('meta[property="og:title"]')?.content || document.title;
    }

    let cleanTitle = rawTitle
      .replace(/^\(\d+\)\s*Marketplace\s*-\s*/i, "")
      .replace(/^Marketplace\s*-\s*/i, "")
      .replace(/\s*\|\s*Facebook$/i, "");

    const pageText = activeContext.innerText || "";

    let price = "Not Found";
    const priceMatch = pageText.match(/\$[0-9,]+/);
    if (priceMatch) price = priceMatch[0];

    let mileage = "Not Found";
    let transmission = "Not Found";

    const mileageMatch = pageText.match(/Driven\s+([0-9,]+)\s+miles/i);
    if (mileageMatch) mileage = mileageMatch[1] + " miles";

    if (pageText.match(/Automatic\s+transmission/i)) transmission = "Automatic";
    if (pageText.match(/Manual\s+transmission/i)) transmission = "Manual";

    try {
      const seeMore = Array.from(activeContext.querySelectorAll('span, div[role="button"]'))
        .find(el => (el.innerText || "").trim().toLowerCase() === "see more");
      if (seeMore) { seeMore.click(); await new Promise(r => setTimeout(r, 400)); }
    } catch (e) {}

    function _descFromDom() {
      const heads = Array.from(activeContext.querySelectorAll('span, h2, h3, div'));
      const head = heads.find(el => {
        const t = (el.innerText || "").trim().toLowerCase();
        return t === "seller's description" || t === "description";
      });
      if (!head) return "";
      let best = "";
      let node = head;
      for (let up = 0; up < 4 && node; up++, node = node.parentElement) {
        let body = (node.innerText || "");
        const hi = body.toLowerCase().indexOf("description");
        if (hi === -1) continue;
        body = body.slice(hi + "description".length);
        body = body.split(/Location is approximate|Seller information|Send seller a message|More from Marketplace|Related items|You might also/i)[0];
        body = body.replace(/^[\s:']+/, "").replace(/See (more|less)/gi, "").trim();
        if (body.length > best.length && body.length < 6000) best = body;
      }
      return best;
    }

    const ogDesc = (document.querySelector('meta[property="og:description"]')?.content) || "";
    const domDesc = _descFromDom();
    let description = (domDesc.length > ogDesc.length ? domDesc : ogDesc) || "";
    description = description
      .split(/\bAbout this vehicle\b/i)[0]
      .replace(/\s*See (more|less)\s*$/i, "")
      .trim();
    description = description
      .split("\n")
      .map(line => line
        .replace(/\(?\b(Clean|Salvage|Rebuilt|Lien|Lemon)\s+title\b\)?/ig, "")
        .replace(/\s*[·|,;:-]\s*$/g, "")
        .trim())
      .filter(Boolean)
      .join("\n")
      .trim();

    function _grab(re, i) { const m = pageText.match(re); return m ? m[i].trim() : ""; }
    const details = {
      exterior_color: _grab(/Exterior color:[ \t]*([^\n\u00b7|]+)/i, 1),
      interior_color: _grab(/Interior color:[ \t]*([^\n\u00b7|]+)/i, 1),
      fuel_economy: _grab(/([0-9.]+\s*MPG city[^\n]*)/i, 1),
      title_status: (pageText.match(/\b(Clean|Salvage|Rebuilt|Lien|Lemon)\s+title\b/i) || [""])[0],
    };

    const webStoreLabels = ["more items from this seller", "related items", "suggested listings", "sponsored", "recommended for you"];
    let recommendationCutoffY = Infinity;

    activeContext.querySelectorAll('span, h2, h3, div').forEach(el => {
      const text = el.innerText?.trim().toLowerCase();
      if (text && webStoreLabels.some(label => text.includes(label))) {
        const rect = el.getBoundingClientRect();
        const absoluteTop = rect.top + window.scrollY;
        if (absoluteTop > 0 && absoluteTop < recommendationCutoffY) {
          recommendationCutoffY = absoluteTop;
        }
      }
    });

    const filteredImages = [];
    const seenMainImageUrls = [];

    function captureVisibleImages() {
      // Auto-enrich opens a full listing page, where Facebook may render
      // recommendation cards nearby. Only save the current main carousel image;
      // as the loop advances, this collects the real listing photos without
      // grabbing images from other places on the page.
      const src = getMainImageSrc();
      if (src && src.includes('scontent') && !filteredImages.includes(src)) {
        filteredImages.push(src);
      }
    }

    function getMainImageSrc() {
      const allImgs = Array.from(activeContext.querySelectorAll('img'));
      let mainImg = null;
      let maxArea = 0;

      allImgs.forEach(img => {
        const rect = img.getBoundingClientRect();
        const imgAbsoluteTop = rect.top + window.scrollY;
        if (imgAbsoluteTop < recommendationCutoffY) {
          const area = rect.width * rect.height;
          if (area > maxArea && rect.width > 250) {
            maxArea = area;
            mainImg = img;
          }
        }
      });
      return mainImg ? mainImg.src : null;
    }

    function getFreshNextButton() {
      const allImgs = Array.from(activeContext.querySelectorAll('img'));
      let mainImg = null;
      let maxArea = 0;

      allImgs.forEach(img => {
        const rect = img.getBoundingClientRect();
        const imgAbsoluteTop = rect.top + window.scrollY;
        if (imgAbsoluteTop < recommendationCutoffY) {
          const area = rect.width * rect.height;
          if (area > maxArea && rect.width > 250) {
            maxArea = area;
            mainImg = img;
          }
        }
      });

      if (!mainImg) return null;
      const imgRect = mainImg.getBoundingClientRect();
      const imgMiddleY = imgRect.top + (imgRect.height / 2);

      const interactiveElements = Array.from(activeContext.querySelectorAll('div[role="button"], button, [aria-label*="Next"], [aria-label*="next"]'));

      return interactiveElements.find(el => {
        const btnRect = el.getBoundingClientRect();
        if (btnRect.width === 0 || btnRect.height === 0 || btnRect.width > 120) return false;

        const btnCenterX = btnRect.left + btnRect.width / 2;
        const btnCenterY = btnRect.top + btnRect.height / 2;

        const insideVerticalTrack = Math.abs(btnCenterY - imgMiddleY) < 120;
        const onRightEdge = (btnCenterX > imgRect.left + imgRect.width * 0.5) && (btnCenterX < imgRect.right + 60);

        return insideVerticalTrack && onRightEdge;
      });
    }

    captureVisibleImages();

    let initialMainSrc = getMainImageSrc();
    if (initialMainSrc) seenMainImageUrls.push(initialMainSrc);

    for (let i = 0; i < 40; i++) {
      let nextButton = getFreshNextButton();

      if (nextButton) {
        nextButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      } else {
        const eventConfig = { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, bubbles: true };
        document.dispatchEvent(new KeyboardEvent('keydown', eventConfig));
        document.dispatchEvent(new KeyboardEvent('keyup', eventConfig));
      }

      await new Promise(resolve => setTimeout(resolve, 850));
      captureVisibleImages();

      let dynamicMainSrc = getMainImageSrc();
      if (!dynamicMainSrc || seenMainImageUrls.includes(dynamicMainSrc)) {
        break;
      }

      seenMainImageUrls.push(dynamicMainSrc);
    }

    return {
      success: true,
      timestamp: new Date().toISOString(),
      url: window.location.href,
      title: cleanTitle,
      price: price,
      mileage: mileage,
      transmission: transmission,
      description: description || "Could not isolate description block.",
      details: details,
      images: filteredImages.slice(0, 40)
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function profileScanRoutine() {
  try {
    const seenCounts = [];
    const allById = new Map();
    const maxScrolls = 20;
    let lastCount = 0;
    let stableCount = 0;

    function findObjects(obj, typename, depth = 0) {
      if (depth > 60 || !obj) return [];
      if (Array.isArray(obj)) {
        return obj.flatMap(item => findObjects(item, typename, depth + 1));
      }
      if (typeof obj === "object") {
        const own = obj.__typename === typename ? [obj] : [];
        return own.concat(Object.values(obj).flatMap(value => findObjects(value, typename, depth + 1)));
      }
      return [];
    }

    function parseListing(item) {
      const price = item.listing_price || {};
      const seller = item.marketplace_listing_seller || {};
      const photos = [];
      const primary = item.primary_listing_photo?.image?.uri;
      if (primary) photos.push(primary);
      (item.listing_photos || []).forEach(photo => {
        const uri = photo?.image?.uri;
        if (uri && !photos.includes(uri)) photos.push(uri);
      });

      const fbId = String(item.id || "");
      return {
        fb_listing_id: fbId,
        fb_url: `https://www.facebook.com/marketplace/item/${fbId}/`,
        title: item.marketplace_listing_title || "Unknown Vehicle",
        price: price.formatted_amount || "Call for price",
        description: item.redacted_description?.text || "",
        photos,
        is_sold: !!item.is_sold,
        is_pending: !!item.is_pending,
        seller_id: seller.id || "",
        seller_name: seller.name || "",
      };
    }

    function getSellerIdsFromDom() {
      const allLinks = Array.from(document.querySelectorAll(
        'a[href*="/marketplace/item/"], a[href*="/commerce/listing/"]'
      ));
      const headings = Array.from(document.querySelectorAll(
        '[role="heading"], h1, h2, h3, h4, span[dir="auto"], [aria-level]'
      ));

      function isSellerListingsHeading(el) {
        const raw = (el.textContent || "").replace(/\s+/g, " ").trim();
        const text = raw.toLowerCase();
        if (!text || text.length > 80) return false;
        // Listing cards can have titles like "10h·Test Car Listings". Those are
        // not the seller section heading and would pull in recommendation links.
        if (/[·•]/.test(raw) || /\$[0-9,]+/.test(raw) || /^\d+\s*[smhdw]\b/i.test(raw)) return false;
        return text === "your listings" || /(?:'|’)s listings$/.test(text);
      }

      const sellerHeading = headings.find(isSellerListingsHeading);

      const relevant = sellerHeading
        ? allLinks.filter(anchor => (sellerHeading.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0)
        : [];

      const ids = new Set();
      relevant.forEach(anchor => {
        const href = decodeURIComponent(anchor.href || anchor.getAttribute("href") || "");
        const match = href.match(/\/(?:marketplace\/item|commerce\/listing)\/(\d+)/);
        if (match) ids.add(match[1]);
      });

      return {
        ids,
        total_links: allLinks.length,
        strategy: sellerHeading ? "after_seller_heading" : "no_seller_heading",
        heading_text: sellerHeading ? sellerHeading.textContent.trim() : "",
      };
    }

    function collectAnchorListings(whitelist) {
      const rows = [];
      const seen = new Set();
      const anchors = Array.from(document.querySelectorAll(
        'a[href*="/marketplace/item/"], a[href*="/commerce/listing/"]'
      ));

      anchors.forEach(anchor => {
        const href = decodeURIComponent(anchor.href || anchor.getAttribute("href") || "");
        const idMatch = href.match(/\/(?:marketplace\/item|commerce\/listing)\/(\d+)/);
        if (!idMatch) return;
        const fbId = idMatch[1];
        if (whitelist && whitelist.size && !whitelist.has(fbId)) return;
        if (seen.has(fbId)) return;
        seen.add(fbId);

        let box = anchor;
        for (let i = 0; i < 6 && box && box.parentElement; i++) {
          const text = (box.innerText || "").trim();
          const rect = box.getBoundingClientRect();
          if (text.includes("$") && rect.width > 120 && rect.height > 80) break;
          box = box.parentElement;
        }

        const text = (box?.innerText || anchor.innerText || "").trim();
        const lines = text.split(/\n+/).map(x => x.trim()).filter(Boolean);
        const priceLine = lines.find(line => /\$[0-9,]+/.test(line)) || "";
        const priceMatch = priceLine.match(/\$[0-9,]+/);
        const title = (lines.find(line =>
          line !== priceLine &&
          !/listed|marketplace|details|message|seller|available|sold/i.test(line) &&
          line.length > 3
        ) || anchor.getAttribute("aria-label") || `Facebook listing ${fbId}`).replace(/\s+/g, " ").trim();
        const img = box?.querySelector?.('img[src*="scontent"]') || anchor.querySelector?.('img[src*="scontent"]');

        rows.push({
          fb_listing_id: fbId,
          fb_url: `https://www.facebook.com/marketplace/item/${fbId}/`,
          title,
          price: priceMatch ? priceMatch[0] : "",
          description: "",
          photos: img?.src ? [img.src] : [],
          is_sold: /\bsold\b/i.test(text),
        });
      });
      return rows;
    }

    function collectJsonListings(whitelist) {
      const rows = [];
      const seen = new Set();
      const scripts = Array.from(document.querySelectorAll('script[type="application/json"]'));
      scripts.forEach(script => {
        try {
          const data = JSON.parse(script.textContent || "{}");
          const items = findObjects(data, "MarketplaceProductItem")
            .concat(findObjects(data, "GroupCommerceProductItem"));
          items.forEach(item => {
            const row = parseListing(item);
            if (!row.fb_listing_id || row.title === "Unknown Vehicle") return;
            if (whitelist && whitelist.size && !whitelist.has(row.fb_listing_id)) return;
            if (seen.has(row.fb_listing_id)) return;
            seen.add(row.fb_listing_id);
            rows.push(row);
          });
        } catch (e) {}
      });
      return rows;
    }

    async function collectAllVisible() {
      const dom = getSellerIdsFromDom();
      const whitelist = dom.ids.size ? dom.ids : null;
      const rows = collectJsonListings(whitelist);
      collectAnchorListings(whitelist).forEach(row => {
        if (!rows.some(existing => existing.fb_listing_id === row.fb_listing_id)) rows.push(row);
      });
      return { rows, dom };
    }

    for (let i = 0; i < maxScrolls; i++) {
      const { rows, dom } = await collectAllVisible();
      rows.forEach(row => {
        const existing = allById.get(row.fb_listing_id);
        if (!existing || (row.title && existing.title.startsWith("Facebook listing"))) {
          allById.set(row.fb_listing_id, row);
        }
      });
      const count = allById.size;
      seenCounts.push({
        count,
        total_links: dom.total_links,
        strategy: dom.strategy,
        heading_text: dom.heading_text,
      });
      if (count <= lastCount) stableCount += 1;
      else stableCount = 0;
      lastCount = count;
      if (stableCount >= 4) break;
      const prevHeight = document.body.scrollHeight;
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise(resolve => setTimeout(resolve, 2000));
      if (document.body.scrollHeight === prevHeight && stableCount >= 1) break;
    }

    window.scrollTo(0, 0);
    await new Promise(resolve => setTimeout(resolve, 1000));
    const final = await collectAllVisible();
    final.rows.forEach(row => allById.set(row.fb_listing_id, row));
    const listings = Array.from(allById.values());

    return {
      success: true,
      profile_url: window.location.href,
      count: listings.length,
      seen_counts: seenCounts,
      final_dom: {
        total_links: final.dom.total_links,
        strategy: final.dom.strategy,
        heading_text: final.dom.heading_text,
        seller_ids: Array.from(final.dom.ids),
      },
      listings,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
