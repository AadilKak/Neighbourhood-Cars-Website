// Listen for live progress updates from the active Facebook tab
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "SCRAPE_PROGRESS") {
    document.getElementById("output").innerText = message.text;
  }
});

// Persist the admin key across popup opens (kept in chrome.storage, not in code).
// Backend endpoint. Hardcoded to the local server for now — change this single
// line to your Render URL when you go live.
const DEFAULT_API_BASE = "https://marketplace-system-lf78.onrender.com";
const DEFAULT_DEALER_SLUG = "neighborhood-used-cars";
const DEFAULT_DEALER_KEY = "nuc2024";
let autoEnabled = true;

const apiBaseInput = document.getElementById("api-base-input");
const dealerSlugInput = document.getElementById("dealer-slug-input");
const dealerKeyInput = document.getElementById("dealer-key-input");

function cleanBaseUrl(value) {
  return (value || DEFAULT_API_BASE).trim().replace(/\/+$/, "");
}

async function getDealerSettings() {
  const saved = await chrome.storage.local.get(["apiBase", "dealerSlug", "dealerKey"]);
  return {
    apiBase: cleanBaseUrl(saved.apiBase || DEFAULT_API_BASE),
    dealerSlug: (saved.dealerSlug || DEFAULT_DEALER_SLUG).trim(),
    dealerKey: (saved.dealerKey || DEFAULT_DEALER_KEY).trim(),
  };
}

function listingEndpoint(settings) {
  if (settings.dealerSlug) {
    return `${settings.apiBase}/api/dealers/${encodeURIComponent(settings.dealerSlug)}/listings`;
  }
  return `${settings.apiBase}/api/listings`;
}

function isCustomerBackend(settings) {
  return /^https?:\/\/(localhost|127\.0\.0\.1):8020$/i.test(settings.apiBase || "");
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

async function loadSettingsForm() {
  const settings = await getDealerSettings();
  apiBaseInput.value = settings.apiBase;
  dealerSlugInput.value = settings.dealerSlug;
  dealerKeyInput.value = settings.dealerKey;
  const configuredLabel = document.getElementById("configured-label");
  if (configuredLabel) {
    configuredLabel.innerText = `Connected to ${settings.dealerSlug}. Auto scan runs every 30 minutes.`;
  }
}

function saveSettingsForm() {
  chrome.storage.local.set({
    apiBase: cleanBaseUrl(apiBaseInput.value),
    dealerSlug: dealerSlugInput.value.trim(),
    dealerKey: dealerKeyInput.value.trim(),
  });
}

[apiBaseInput, dealerSlugInput, dealerKeyInput].forEach((input) => {
  input.addEventListener("change", saveSettingsForm);
  input.addEventListener("blur", saveSettingsForm);
});

loadSettingsForm();

function refreshAutoStatus() {
  chrome.runtime.sendMessage({ type: "NUC_AUTO_STATUS" }, (status) => {
    if (chrome.runtime.lastError || !status) return;
    autoEnabled = status.enabled !== false;
    const btn = document.getElementById("auto-button");
    btn.innerText = autoEnabled ? "Auto Scan: On" : "Auto Scan: Off";
    const last = status.last;
    if (last && last.message) {
      document.getElementById("output").innerText = `${last.message}\n${new Date(last.at).toLocaleString()}`;
    }
  });
}

document.getElementById("auto-button").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "NUC_SET_AUTO", enabled: !autoEnabled }, () => {
    refreshAutoStatus();
  });
});

document.getElementById("run-auto-button").addEventListener("click", () => {
  saveSettingsForm();
  document.getElementById("output").innerText = "Scanning profile, syncing inventory, then enriching missing details...";
  chrome.runtime.sendMessage({ type: "NUC_RUN_AUTO_NOW" }, (result) => {
    if (chrome.runtime.lastError) {
      document.getElementById("output").innerText = "Auto scan failed to start.";
      return;
    }
    document.getElementById("output").innerText = (result && result.message) || "Auto scan finished.";
    refreshAutoStatus();
  });
});

document.getElementById("scan-profile-button").addEventListener("click", () => {
  saveSettingsForm();
  document.getElementById("output").innerText =
    "Scanning the saved Facebook profile, importing listings, then enriching missing details...";
  chrome.runtime.sendMessage({ type: "NUC_SCAN_PROFILE_NOW" }, (result) => {
    if (chrome.runtime.lastError) {
      document.getElementById("output").innerText = "Profile scan failed to start.";
      return;
    }
    document.getElementById("output").innerText = (result && result.message) || "Profile scan finished.";
    refreshAutoStatus();
  });
});

document.getElementById("stop-button").addEventListener("click", () => {
  document.getElementById("output").innerText = "Stopping current scan...";
  chrome.runtime.sendMessage({ type: "NUC_STOP_AUTO" }, (result) => {
    if (chrome.runtime.lastError) {
      document.getElementById("output").innerText = "Stop request failed.";
      return;
    }
    document.getElementById("output").innerText = (result && result.message) || "Stop requested.";
    refreshAutoStatus();
  });
});

refreshAutoStatus();

// Download each photo in the browser (the extension has fbcdn permission) and
// convert it to a base64 data URL, so the backend never has to fetch FB's image
// URLs server-side (which Facebook often blocks).
async function toDataUrls(urls) {
  const out = [];
  for (const u of urls) {
    try {
      const resp = await fetch(u);
      if (!resp.ok) continue;
      const blob = await resp.blob();
      const dataUrl = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = rej;
        fr.readAsDataURL(blob);
      });
      if (dataUrl && dataUrl.indexOf("data:image") === 0) out.push(dataUrl);
    } catch (e) { /* skip this image */ }
  }
  return out;
}

document.getElementById("sync-button").addEventListener("click", async () => {
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab.url.includes("facebook.com/marketplace/item/")) {
    document.getElementById("output").innerText = "Error: Use a real Marketplace item page.";
    return;
  }

  document.getElementById("output").innerText = "Isolating listing window context...";

  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    function: localScraperRoutine
  }, async (results) => {
    if (chrome.runtime.lastError || !results || !results[0]) {
      document.getElementById("output").innerText = "Scrape failed.";
      return;
    }
    
    const scrapedData = results[0].result;

    // Inline the photos as base64 (downloaded here in the browser).
    if (scrapedData && scrapedData.images && scrapedData.images.length) {
      document.getElementById("output").innerText =
        "Downloading " + scrapedData.images.length + " photo(s)...";
      scrapedData.images = await toDataUrls(scrapedData.images);
    }

    try {
        const settings = await getDealerSettings();
        const response = await saveScrapedListing(scrapedData, settings);

      const backendResult = await response.json();
      
      if (response.ok) {
        const saved = (backendResult && typeof backendResult.photos === "number") ? backendResult.photos : "?";
        const soldTag = backendResult && backendResult.is_sold ? " — marked SOLD" : "";
        const scraped = scrapedData.images ? scrapedData.images.length : 0;
        document.getElementById("output").innerText =
          `Backend ${backendResult.status || "ok"} at ${settings.apiBase}: ${saved} photo(s) saved (scraped ${scraped})${soldTag}.` +
          (saved === 0 ? "\nNo photos stored — the listing's images are likely gone/expired (common on sold listings)." : "");
      } else {
        document.getElementById("output").innerText = "Backend error: " + response.statusText;
      }
    } catch (err) {
      document.getElementById("output").innerText = "Could not reach the Render backend.";
      console.error(err);
    }
  });
});

// This specific block executes inside the Facebook tab's context
async function localScraperRoutine() {
  try {
    // CRITICAL LAYER: Detect if open as a pop-up window or standalone page
    const modalElement = Array.from(document.querySelectorAll('div[role="dialog"]')).find(el => el.getBoundingClientRect().width > 500);
    const activeContext = modalElement ? modalElement : document.body;

    // 1. Context-Aware Title Extraction
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

    // 2. Extract Price
    let price = "Not Found";
    const priceMatch = pageText.match(/\$[0-9,]+/);
    if (priceMatch) price = priceMatch[0];

    // 3. Extract Vehicle Specs
    let mileage = "Not Found";
    let transmission = "Not Found";
    
    const mileageMatch = pageText.match(/Driven\s+([0-9,]+)\s+miles/i);
    if (mileageMatch) mileage = mileageMatch[1] + " miles";

    if (pageText.match(/Automatic\s+transmission/i)) transmission = "Automatic";
    if (pageText.match(/Manual\s+transmission/i)) transmission = "Manual";

    // 4. Description — expand "See more", then read THIS page's on-screen text.
    //    The DOM only shows the current listing's description (recommended cars
    //    are just thumbnails), so this avoids the wrong-car mix-up. og:description
    //    is the truncated fallback.
    try {
      const seeMore = Array.from(activeContext.querySelectorAll('span, div[role="button"]'))
        .find(el => (el.innerText || "").trim().toLowerCase() === "see more");
      if (seeMore) { seeMore.click(); await new Promise(r => setTimeout(r, 400)); }
    } catch (e) { /* ignore */ }

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
        body = body.replace(/^[\s:'’s]+/, "").replace(/See (more|less)/gi, "").trim();
        if (body.length > best.length && body.length < 6000) best = body;
      }
      return best;
    }

    const ogDesc = (document.querySelector('meta[property="og:description"]')?.content) || "";
    const domDesc = _descFromDom();
    let description = (domDesc.length > ogDesc.length ? domDesc : ogDesc) || "";
    description = description.replace(/\s*See (more|less)\s*$/i, "").trim();

    // 4b. "About this vehicle" attributes (FB shows these as labeled rows).
    function _grab(re, i) { const m = pageText.match(re); return m ? m[i].trim() : ""; }
    const details = {
      exterior_color: _grab(/Exterior color:\s*([^\n\u00b7|]+)/i, 1),
      interior_color: _grab(/Interior color:\s*([^\n\u00b7|]+)/i, 1),
      fuel_economy: _grab(/([0-9.]+\s*MPG city[^\n]*)/i, 1),
      title_status: (pageText.match(/\b(Clean|Salvage|Rebuilt|Lien|Lemon)\s+title\b/i) || [""])[0],
    };

    // 5. Setup Cutoff Line for internal recommendations
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

    // 6. SCOPED PHOTO CAPTURE ENGINE WITH AUTO-STOP
    const filteredImages = [];
    const seenMainImageUrls = [];

    function captureVisibleImages() {
      // Pull images EXCLUSIVELY from the active window container
      const imageNodes = activeContext.querySelectorAll('img');
      imageNodes.forEach(img => {
        const src = img.src;
        if (!src || !src.includes('scontent')) return;

        const rect = img.getBoundingClientRect();
        const imgAbsoluteTop = rect.top + window.scrollY;

        if (imgAbsoluteTop >= recommendationCutoffY) return;

        const width = img.naturalWidth || img.width || 0;
        const height = img.naturalHeight || img.height || 0;
        
        if (width < 50 || height < 50) return; 

        if (!filteredImages.includes(src)) {
          filteredImages.push(src);
        }
      });
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
        chrome.runtime.sendMessage({ type: "SCRAPE_PROGRESS", text: `Slide ${i+1}: Clicking Next... (${filteredImages.length} isolated)` });
        nextButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      } else {
        chrome.runtime.sendMessage({ type: "SCRAPE_PROGRESS", text: `Slide ${i+1}: Simulating Key... (${filteredImages.length} isolated)` });
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
