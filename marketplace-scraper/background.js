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

  if (message.type === "NUC_CAPTURE_CURRENT_PUPPET") {
    captureCurrentPuppetListing().then(sendResponse);
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
    return `${settings.apiBase}/api/dealers/${encodeURIComponent(settings.dealerSlug)}/needs-details?key=${encodeURIComponent(settings.dealerKey)}`;
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

function puppetProfileScanEndpoint(settings) {
  if (settings.dealerSlug) {
    return `${settings.apiBase}/api/dealers/${encodeURIComponent(settings.dealerSlug)}/puppet/profile-scan`;
  }
  return `${settings.apiBase}/api/puppet/profile-scan`;
}

function puppetRawListingEndpoint(settings) {
  if (settings.dealerSlug) {
    return `${settings.apiBase}/api/dealers/${encodeURIComponent(settings.dealerSlug)}/puppet/raw-listing`;
  }
  return `${settings.apiBase}/api/puppet/raw-listing`;
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
    const rawCards = scan.raw_cards || [];
    const scannedCount = rawCards.length || listings.length;
    if (!scannedCount) {
      const message = "Profile scan captured no Marketplace listing candidates.";
      await saveLastAuto(message);
      return { ok: false, message };
    }
    const importResult = await importProfileScan(scan, settings);
    throwIfCancelled();
    const customerSyncResult = await syncCustomerBackend(settings, dealer);
    throwIfCancelled();
    const inventoryResult = await fetchInventorySummary(settings);
    throwIfCancelled();

    const customerMessage = customerSyncResult?.skipped ? "" : `Customer backend synced ${customerSyncResult.total_received || 0} listing(s).`;
    const inventoryMessage = inventoryResult?.skipped ? "" : `Backend inventory: ${inventoryResult.active} active / ${inventoryResult.total} total.`;
    const message = `Profile scan captured ${scannedCount} Facebook listing candidate(s). ${importResult.message || ""} ${customerMessage} ${inventoryMessage}`.trim();
    await saveLastAuto(message);
    return {
      ok: true,
      message,
      scanned: scannedCount,
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

async function importProfileScan(scan, settings) {
  const puppetResponse = await fetch(puppetProfileScanEndpoint(settings), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key: settings.dealerKey,
      profile_url: scan.profile_url || "",
      page_text: scan.page_text || "",
      html: scan.html || "",
      headings: scan.headings || [],
      raw_cards: scan.raw_cards || [],
      listings: scan.listings || [],
    }),
  });
  if (!puppetResponse.ok) {
    let errorDetail = "";
    try {
      const errorBody = await puppetResponse.json();
      errorDetail = errorBody.detail ? ` ${errorBody.detail}` : "";
    } catch (e) {}
    throw new Error(`Puppet profile import failed: ${puppetResponse.status}.${errorDetail}`);
  }
  return puppetResponse.json();
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
      function: puppetRawCaptureRoutine,
    });

    const rawData = results && results[0] && results[0].result;
    if (!rawData || rawData.success === false) {
      throw new Error((rawData && rawData.error) || "Facebook raw capture failed.");
    }

    if (rawData.images && rawData.images.length) {
      rawData.images = await toDataUrls(rawData.images);
    }

    const saveResult = await savePuppetRawListing(rawData, settings);
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

async function captureCurrentPuppetListing() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.includes("facebook.com/marketplace/item/")) {
    return { ok: false, message: "Open a real Marketplace item page first." };
  }

  try {
    const settings = await getDealerSettings();
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      function: puppetRawCaptureRoutine,
    });
    const rawData = results && results[0] && results[0].result;
    if (!rawData || rawData.success === false) {
      throw new Error((rawData && rawData.error) || "Facebook raw capture failed.");
    }
    if (rawData.images && rawData.images.length) {
      rawData.images = await toDataUrls(rawData.images);
    }
    const response = await savePuppetRawListing(rawData, settings);
    let body = {};
    try { body = await response.json(); } catch (e) {}
    if (!response.ok) return { ok: false, message: `Backend error: ${response.status}` };
    return {
      ok: true,
      message: `Puppet raw capture saved at ${settings.apiBase}: ${body.status || "ok"} (${body.photos ?? "?"} photo(s)).`,
    };
  } catch (err) {
    return { ok: false, message: "Puppet capture error: " + (err && err.message ? err.message : String(err)) };
  }
}

async function savePuppetRawListing(rawData, settings) {
  const payload = {
    key: settings.dealerKey,
    url: rawData.url || "",
    raw_title: rawData.raw_title || "",
    page_text: rawData.page_text || "",
    html: rawData.html || "",
    images: rawData.images || [],
  };
  return fetch(puppetRawListingEndpoint(settings), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
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

async function puppetRawCaptureRoutine() {
  try {
    const modalElement = Array.from(document.querySelectorAll('div[role="dialog"]')).find(el => el.getBoundingClientRect().width > 500);
    const activeContext = modalElement ? modalElement : document.body;

    try {
      const seeMore = Array.from(activeContext.querySelectorAll('span, div[role="button"]'))
        .find(el => (el.innerText || "").trim().toLowerCase() === "see more");
      if (seeMore) { seeMore.click(); await new Promise(r => setTimeout(r, 400)); }
    } catch (e) {}

    let rawTitle = "";
    if (modalElement) {
      const h1El = modalElement.querySelector('h1');
      if (h1El) rawTitle = h1El.innerText;
    }
    if (!rawTitle) {
      rawTitle = document.querySelector('meta[property="og:title"]')?.content || document.title || "";
    }

    const recommendationLabels = ["more items from this seller", "related items", "suggested listings", "sponsored", "recommended for you"];
    let recommendationCutoffY = Infinity;
    activeContext.querySelectorAll('span, h2, h3, div').forEach(el => {
      const text = el.innerText?.trim().toLowerCase();
      if (text && recommendationLabels.some(label => text.includes(label))) {
        const absoluteTop = el.getBoundingClientRect().top + window.scrollY;
        if (absoluteTop > 0 && absoluteTop < recommendationCutoffY) recommendationCutoffY = absoluteTop;
      }
    });

    const images = [];
    const seenMainImageUrls = [];

    function getMainImageSrc() {
      const allImgs = Array.from(activeContext.querySelectorAll('img'));
      let mainImg = null;
      let maxArea = 0;
      allImgs.forEach(img => {
        const rect = img.getBoundingClientRect();
        const absoluteTop = rect.top + window.scrollY;
        if (absoluteTop < recommendationCutoffY) {
          const area = rect.width * rect.height;
          if (area > maxArea && rect.width > 250) {
            maxArea = area;
            mainImg = img;
          }
        }
      });
      return mainImg ? mainImg.src : null;
    }

    function captureVisibleImage() {
      const src = getMainImageSrc();
      if (src && src.includes("scontent") && !images.includes(src)) images.push(src);
    }

    function getFreshNextButton() {
      const allImgs = Array.from(activeContext.querySelectorAll('img'));
      let mainImg = null;
      let maxArea = 0;
      allImgs.forEach(img => {
        const rect = img.getBoundingClientRect();
        const absoluteTop = rect.top + window.scrollY;
        if (absoluteTop < recommendationCutoffY) {
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
        return Math.abs(btnCenterY - imgMiddleY) < 120 &&
          btnCenterX > imgRect.left + imgRect.width * 0.5 &&
          btnCenterX < imgRect.right + 60;
      });
    }

    captureVisibleImage();
    const initialMainSrc = getMainImageSrc();
    if (initialMainSrc) seenMainImageUrls.push(initialMainSrc);

    for (let i = 0; i < 40; i++) {
      const nextButton = getFreshNextButton();
      if (nextButton) {
        nextButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      } else {
        const eventConfig = { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, bubbles: true };
        document.dispatchEvent(new KeyboardEvent('keydown', eventConfig));
        document.dispatchEvent(new KeyboardEvent('keyup', eventConfig));
      }
      await new Promise(resolve => setTimeout(resolve, 850));
      captureVisibleImage();
      const dynamicMainSrc = getMainImageSrc();
      if (!dynamicMainSrc || seenMainImageUrls.includes(dynamicMainSrc)) break;
      seenMainImageUrls.push(dynamicMainSrc);
    }

    return {
      success: true,
      timestamp: new Date().toISOString(),
      url: window.location.href,
      raw_title: rawTitle,
      page_text: activeContext.innerText || "",
      html: activeContext.outerHTML || document.documentElement.outerHTML || "",
      images: images.slice(0, 40),
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function profileScanRoutine() {
  try {
    const seenCounts = [];
    const rawCardsById = new Map();
    const maxScrolls = 20;
    let lastCount = 0;
    let stableCount = 0;

    function captureHeadings() {
      return Array.from(document.querySelectorAll(
        '[role="heading"], h1, h2, h3, h4, span[dir="auto"], [aria-level]'
      )).map(el => ({
        text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
        y: el.getBoundingClientRect().top + window.scrollY,
      })).filter(item => item.text);
    }

    function collectRawCards() {
      const rows = [];
      const seen = new Set();
      const anchors = Array.from(document.querySelectorAll(
        'a[href*="/marketplace/item/"], a[href*="/commerce/listing/"]'
      ));

      anchors.forEach(anchor => {
        const href = decodeURIComponent(anchor.href || anchor.getAttribute('href') || '');
        const idMatch = href.match(/\/(?:marketplace\/item|commerce\/listing)\/(\d+)/);
        if (!idMatch) return;
        const fbId = idMatch[1];
        if (seen.has(fbId)) return;
        seen.add(fbId);

        let box = anchor;
        for (let i = 0; i < 6 && box && box.parentElement; i++) {
          const text = (box.innerText || '').trim();
          const rect = box.getBoundingClientRect();
          if (text.includes('$') && rect.width > 120 && rect.height > 80) break;
          box = box.parentElement;
        }

        const text = (box?.innerText || anchor.innerText || '').trim();
        const img = box?.querySelector?.('img[src*="scontent"]') || anchor.querySelector?.('img[src*="scontent"]');

        rows.push({
          fb_listing_id: fbId,
          href: 'https://www.facebook.com/marketplace/item/' + fbId + '/',
          text,
          image_url: img?.src || '',
          y: anchor.getBoundingClientRect().top + window.scrollY,
        });
      });
      return rows;
    }

    async function collectAllVisible() {
      return {
        rows: collectRawCards(),
        headings: captureHeadings(),
      };
    }

    for (let i = 0; i < maxScrolls; i++) {
      const { rows, headings } = await collectAllVisible();
      rows.forEach(row => {
        const existing = rawCardsById.get(row.fb_listing_id);
        if (!existing || (row.text || '').length > (existing.text || '').length) {
          rawCardsById.set(row.fb_listing_id, row);
        }
      });
      const count = rawCardsById.size;
      seenCounts.push({ count, total_headings: headings.length });
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
    final.rows.forEach(row => rawCardsById.set(row.fb_listing_id, row));

    return {
      success: true,
      profile_url: window.location.href,
      count: rawCardsById.size,
      seen_counts: seenCounts,
      page_text: document.body.innerText || '',
      html: document.documentElement.outerHTML || '',
      headings: final.headings,
      raw_cards: Array.from(rawCardsById.values()),
      listings: [],
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
