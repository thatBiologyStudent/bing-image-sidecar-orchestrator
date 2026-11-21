importScripts('update-check.js');

// GitHub update badge: checked on install, on browser start, and (cached for 12 h) whenever the worker wakes up
chrome.runtime.onInstalled.addListener(() => globalThis.ExtensionUpdate?.updateBadge(true));
chrome.runtime.onStartup.addListener(() => globalThis.ExtensionUpdate?.updateBadge(true));
globalThis.ExtensionUpdate?.updateBadge(false);

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('Failed to set sidePanel behavior:', err));

function sanitizeSegment(text, maxLen = 40) {
  return (text || 'image')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen) || 'image';
}

function buildFullResUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith('bing.com') && parsed.pathname.startsWith('/th/id/')) {
      const pid = parsed.searchParams.get('pid') || 'ImgGn';
      return `${parsed.origin}${parsed.pathname}?pid=${encodeURIComponent(pid)}`;
    }
    return url;
  } catch {
    return url;
  }
}

async function ensureContentScript(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (res?.ok) return true;
  } catch {
    // Content script not loaded yet in this tab
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js']
  });
  return true;
}

async function sendToBingContent(tabId, message) {
  await ensureContentScript(tabId);
  return chrome.tabs.sendMessage(tabId, message);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isTransientNavError(err) {
  const msg = (err?.message || String(err || '')).toLowerCase();
  return (
    msg.includes('message channel closed') ||
    msg.includes('receiving end does not exist') ||
    msg.includes('message port closed') ||
    msg.includes('frame was removed')
  );
}

async function runBingJobWithPolling(tabId, submitType, payload, { timeout = 300000 } = {}) {
  const preSnap = await sendToBingContent(tabId, { type: 'POLL_GENERATION', payload }).catch(() => null);
  let prevUrl = preSnap?.url || '';
  let prevImages = Array.isArray(preSnap?.images) ? preSnap.images : [];

  try {
    const submitRes = await sendToBingContent(tabId, { type: submitType, payload });
    if (submitRes && !submitRes.ok) {
      throw new Error(submitRes.error || `${submitType} failed.`);
    }
    if (submitRes?.prevUrl) prevUrl = submitRes.prevUrl;
    if (Array.isArray(submitRes?.prevImages)) prevImages = submitRes.prevImages;
  } catch (err) {
    if (!isTransientNavError(err)) throw err;
    // Page navigated immediately on Generate click; proceed to polling
  }

  const start = Date.now();
  let sawGeneratingState = false;
  let firstReadyAt = 0;
  let lastCount = 0;

  while (Date.now() - start < timeout) {
    await sleep(1000);
    let snap = null;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'loading') {
        sawGeneratingState = true;
        continue;
      }
      snap = await sendToBingContent(tabId, {
        type: 'POLL_GENERATION',
        payload: { autoDismissWatermarkModal: Boolean(payload?.autoDismissWatermarkModal) }
      });
    } catch (err) {
      if (isTransientNavError(err)) {
        sawGeneratingState = true;
        continue;
      }
      throw err;
    }

    if (!snap?.ok) continue;
    if (snap.errorText) {
      throw new Error(`Bing reported an error: ${snap.errorText}`);
    }

    const currentImages = Array.isArray(snap.images) ? snap.images : [];
    const urlChanged = prevUrl && snap.url && snap.url !== prevUrl;
    const imagesChanged =
      currentImages.length > 0 &&
      (prevImages.length === 0 ||
        currentImages.length !== prevImages.length ||
        currentImages.some((u, i) => u !== prevImages[i]));

    if (!snap.dlReady || urlChanged) {
      sawGeneratingState = true;
    }

    if ((sawGeneratingState || imagesChanged) && snap.dlReady && imagesChanged) {
      if (currentImages.length >= 4) {
        await sleep(500);
        const finalSnap = await sendToBingContent(tabId, {
          type: 'POLL_GENERATION',
          payload: { autoDismissWatermarkModal: Boolean(payload?.autoDismissWatermarkModal) }
        }).catch(() => snap);
        return { ok: true, urls: finalSnap?.images?.length ? finalSnap.images : currentImages };
      }
      // Bing renders 4 per prompt. With fewer, the batch strip may still be loading (only the main image
      // visible) or Bing filtered some: wait up to 15 s for more, and restart the wait when another one appears.
      if (!firstReadyAt || currentImages.length > lastCount) {
        firstReadyAt = Date.now();
        lastCount = currentImages.length;
      }
      if (Date.now() - firstReadyAt >= 15000) {
        return { ok: true, urls: currentImages };
      }
    } else {
      firstReadyAt = 0;
      lastCount = 0;
    }
  }

  throw new Error('Timed out waiting for Bing image generation to finish.');
}

async function downloadImages({ urls, prompt, subfolder }) {
  if (!Array.isArray(urls) || urls.length === 0) {
    return { ok: false, error: 'No image URLs provided.' };
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const slug = sanitizeSegment(prompt, 42);
  const rootFolder = sanitizeSegment(subfolder || 'BingImageCreator', 40) || 'BingImageCreator';
  const results = [];

  for (let i = 0; i < urls.length; i++) {
    const targetUrl = buildFullResUrl(urls[i]);
    const filename = `${rootFolder}/${timestamp}_${slug}/img_${i + 1}.jpg`;
    try {
      const downloadId = await chrome.downloads.download({
        url: targetUrl,
        filename,
        conflictAction: 'uniquify',
        saveAs: false
      });
      results.push({ url: targetUrl, filename, downloadId });
    } catch (err) {
      results.push({ url: targetUrl, filename, error: err?.message || String(err) });
    }
  }

  return { ok: true, results };
}

function normalizeAspectRatio(val) {
  if (!val || typeof val !== 'string') return null;
  const cleaned = val.trim().replace(/\s+/g, '');
  if (cleaned === '1:1' || cleaned === '1') return '1:1';
  if (cleaned === '3:2' || cleaned === '4' || cleaned === '16:9' || cleaned === '4:3' || /landscape|horizontal/i.test(cleaned)) return '3:2';
  if (cleaned === '2:3' || cleaned === '5' || cleaned === '9:16' || cleaned === '3:4' || /portrait|vertical/i.test(cleaned)) return '2:3';
  return null;
}

function parsePromptsFromText(rawText, count, allowAspectRatio = false) {
  const trimmed = (rawText || '').trim();
  const jsonMatch = trimmed.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        const cleaned = parsed
          .map((item) => {
            if (typeof item === 'string') {
              const p = item.trim();
              return p ? { prompt: p, aspectRatio: null } : null;
            }
            if (item && typeof item === 'object' && typeof item.prompt === 'string') {
              const p = item.prompt.trim();
              if (!p) return null;
              const ar = allowAspectRatio
                ? normalizeAspectRatio(item.aspectRatio || item.aspect_ratio || item.ratio)
                : null;
              return { prompt: p, aspectRatio: ar };
            }
            return null;
          })
          .filter(Boolean)
          .slice(0, count);
        if (cleaned.length > 0) return cleaned;
      }
    } catch {
      // Fallback to line parsing
    }
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:\d+[\.\):]|[-*•])\s*/, '').replace(/^["']|["']$/g, '').trim())
    .filter((line) => line.length > 5)
    .map((prompt) => ({ prompt, aspectRatio: null }));

  return lines.slice(0, count);
}

function getApiBaseUrl(baseUrl) {
  let clean = (baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
  clean = clean.replace(/\/chat\/completions$/i, '').replace(/\/models$/i, '');
  return clean;
}

async function fetchModelsFromOpenAI({ baseUrl, apiKey }) {
  const endpoint = `${getApiBaseUrl(baseUrl)}/models`;
  const headers = {};
  if (apiKey && apiKey.trim()) {
    headers['Authorization'] = `Bearer ${apiKey.trim()}`;
  }

  const response = await fetch(endpoint, { method: 'GET', headers });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`API ${response.status}: ${errText.slice(0, 200) || response.statusText}`);
  }

  const data = await response.json();
  const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
  const models = list
    .map((m) => (typeof m === 'string' ? m : m?.id || m?.name || ''))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  if (models.length === 0) {
    throw new Error('No models returned by the endpoint.');
  }
  return { ok: true, models };
}

async function generatePromptsWithOpenAI({ baseUrl, apiKey, model, systemPrompt, topic, count, chooseAspectRatio }) {
  const cleanBase = getApiBaseUrl(baseUrl);
  const endpoint = `${cleanBase}/chat/completions`;
  const clampedCount = Math.min(8, Math.max(1, Number(count) || 1));

  const sysMsg =
    (systemPrompt && systemPrompt.trim()) ||
    'You are an expert AI image prompt engineer. Write vivid, detailed, self-contained image generation prompts suitable for Bing Image Creator.';

  const formatInstruction = chooseAspectRatio
    ? `Return ONLY a valid JSON array of ${clampedCount} object${clampedCount > 1 ? 's' : ''}, each with keys "prompt" (string) and "aspectRatio" (one of "1:1", "3:2", or "2:3" — choose the best framing for each image), with no extra commentary or markdown.`
    : `Return ONLY a valid JSON array of ${clampedCount} string${clampedCount > 1 ? 's' : ''} with no extra commentary or markdown.`;

  const userMsg = [
    `Generate exactly ${clampedCount} distinct image generation prompt${clampedCount > 1 ? 's' : ''} based on this idea/theme:`,
    `"${topic}"`,
    '',
    formatInstruction
  ].join('\n');

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey && apiKey.trim()) {
    headers['Authorization'] = `Bearer ${apiKey.trim()}`;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: (model || 'gpt-4o-mini').trim(),
      messages: [
        { role: 'system', content: sysMsg },
        { role: 'user', content: userMsg }
      ],
      temperature: 0.85
    })
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`API ${response.status}: ${errText.slice(0, 240) || response.statusText}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('OpenAI-compatible API returned no message content.');
  }

  const items = parsePromptsFromText(content, clampedCount, Boolean(chooseAspectRatio));
  if (items.length === 0) {
    throw new Error('Could not parse any prompts from the API response.');
  }
  return { ok: true, items, prompts: items.map((i) => i.prompt) };
}

// ==================== Shared Busy Lock & Alembic Bridge ====================

const ALEMBIC_PROTOCOL = 1;
const ALEMBIC_VERSION = chrome.runtime.getManifest().version;
const BING_CAPABILITIES = {
  models: ['MAI-Image-2.6-Flash'],
  defaultModel: 'MAI-Image-2.6-Flash',
  aspectRatios: ['1:1', '3:2', '2:3'],
  maxImagesPerRequest: 4,
  maxReferences: 1,
  img2img: true,
  inpaint: false,
  negativePrompt: false,
  seed: false,
  outputResolution: '1K'
};

const ASPECT_RATIO_TO_BING = {
  '1:1': '1',
  '3:2': '4',
  '2:3': '5'
};

let alembicBusy = false;
let sidepanelBusy = false;

function isAnyBusy() {
  return alembicBusy || sidepanelBusy;
}

async function getAlembicEnabled() {
  const { alembicEnabled } = await chrome.storage.local.get('alembicEnabled');
  return Boolean(alembicEnabled);
}

async function findBingTab() {
  const tabs = await chrome.tabs.query({ url: 'https://www.bing.com/images/create*' });
  return tabs[0] || null;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function urlToDataUrl(url) {
  const targetUrl = buildFullResUrl(url);
  const resp = await fetch(targetUrl);
  if (!resp.ok) {
    throw new Error(`Failed to fetch generated image (${resp.status}).`);
  }
  const contentType = resp.headers.get('content-type') || 'image/jpeg';
  const buf = await resp.arrayBuffer();
  return `data:${contentType};base64,${arrayBufferToBase64(buf)}`;
}

async function handleAlembicBridgeRequest(action, params = {}, emitEvent = () => {}) {
  if (action === 'hello' || action === 'status') {
    const enabled = await getAlembicEnabled();
    const tab = await findBingTab();
    let signedOut = true;
    if (tab) {
      try {
        const st = await sendToBingContent(tab.id, { type: 'CHECK_STATUS' });
        signedOut = Boolean(st?.signedOut);
      } catch {
        // Tab may still be loading
      }
    }
    return {
      ok: true,
      result: {
        protocol: ALEMBIC_PROTOCOL,
        version: ALEMBIC_VERSION,
        enabled,
        busy: isAnyBusy(),
        bing: {
          open: Boolean(tab),
          signedOut,
          url: tab?.url || '',
          title: tab?.title || ''
        },
        capabilities: BING_CAPABILITIES
      }
    };
  }

  if (action === 'generate') {
    const enabled = await getAlembicEnabled();
    if (!enabled) {
      return {
        ok: false,
        code: 'DISABLED',
        error: 'Bing Image Sidecar Orchestrator is installed but not allowing Alembic. Open its side panel and tick "Allow Alembic to control Bing".'
      };
    }

    if (isAnyBusy()) {
      return {
        ok: false,
        code: 'BUSY',
        error: 'Another Bing generation is currently running.'
      };
    }

    const prompt = typeof params.prompt === 'string' ? params.prompt.trim() : '';
    if (!prompt) {
      return { ok: false, code: 'BAD_REQUEST', error: 'Missing required "prompt" string.' };
    }

    const aspectRatio = params.aspectRatio || '3:2';
    const bingAspectValue = ASPECT_RATIO_TO_BING[aspectRatio];
    if (!bingAspectValue) {
      return {
        ok: false,
        code: 'BAD_REQUEST',
        error: `Unsupported aspectRatio "${aspectRatio}". Supported: 1:1, 3:2, 2:3.`
      };
    }

    const tab = await findBingTab();
    if (!tab) {
      return {
        ok: false,
        code: 'NO_BING_TAB',
        error: 'Open Bing Image Creator (https://www.bing.com/images/create/ai-image-generator) in a tab.'
      };
    }

    const count = Math.min(4, Math.max(1, Number(params.count) || 4));
    const ref = Array.isArray(params.references) && params.references[0] ? params.references[0] : null;
    const referenceImage = ref?.dataUrl
      ? { dataUrl: ref.dataUrl, name: ref.name || 'alembic-ref.png', type: 'image/png' }
      : null;

    alembicBusy = true;
    try {
      emitEvent('progress', 'submitting');
      const genRes = await runBingJobWithPolling(tab.id, 'SUBMIT_GENERATE', {
        prompt,
        aspectRatio: bingAspectValue,
        referenceImage,
        autoDismissWatermarkModal: true
      });

      if (!genRes?.ok) {
        return {
          ok: false,
          code: 'BING_ERROR',
          error: genRes?.error || 'Bing generation failed.'
        };
      }

      const targetUrls = (genRes.urls || []).slice(0, count);
      const images = [];
      for (const u of targetUrls) {
        const dataUrl = await urlToDataUrl(u);
        images.push({ dataUrl });
      }

      let downloaded = false;
      if (params.download === true && targetUrls.length > 0) {
        await downloadImages({ urls: targetUrls, prompt, subfolder: 'BingImageCreator' });
        downloaded = true;
      }

      return {
        ok: true,
        result: {
          images,
          model: BING_CAPABILITIES.defaultModel,
          aspectRatio,
          downloaded
        }
      };
    } catch (err) {
      return {
        ok: false,
        code: 'BING_ERROR',
        error: err?.message || String(err)
      };
    } finally {
      alembicBusy = false;
    }
  }

  return {
    ok: false,
    code: 'UNKNOWN_ACTION',
    error: `Unknown action "${action}".`
  };
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'sidepanel') {
    port.onDisconnect.addListener(() => {
      sidepanelBusy = false;
    });
    return;
  }

  if (port.name !== 'alembic-bridge') return;

  let disconnected = false;
  port.onDisconnect.addListener(() => {
    disconnected = true;
  });

  const safePost = (msg) => {
    if (disconnected) return;
    try {
      port.postMessage(msg);
    } catch {
      disconnected = true;
    }
  };

  port.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'PING') {
      safePost({ type: 'PONG' });
      return;
    }
    if (msg.type === 'REQUEST' && msg.id && msg.action) {
      const { id, action, params } = msg;
      handleAlembicBridgeRequest(action, params, (event, stage, detail) => {
        safePost({ kind: 'event', id, event, stage, detail });
      })
        .then((res) => {
          safePost({ kind: 'response', id, ...res });
        })
        .catch((err) => {
          safePost({ kind: 'response', id, ok: false, error: err?.message || String(err), code: 'INTERNAL' });
        });
    }
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'ENSURE_CONTENT_SCRIPT') {
    ensureContentScript(message.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (message?.type === 'SET_SIDEPANEL_BUSY') {
    if (message.busy && alembicBusy) {
      sendResponse({ ok: false, error: 'Alembic is currently running a Bing generation.' });
      return false;
    }
    sidepanelBusy = Boolean(message.busy);
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === 'DOWNLOAD_IMAGES') {
    downloadImages(message.payload)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (message?.type === 'OPENAI_FETCH_MODELS') {
    fetchModelsFromOpenAI(message.payload)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (message?.type === 'OPENAI_GENERATE_PROMPTS') {
    generatePromptsWithOpenAI(message.payload)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (message?.type === 'FETCH_FULLRES_DATA_URLS') {
    Promise.all((message.payload?.urls || []).map((u) => urlToDataUrl(u)))
      .then((dataUrls) => sendResponse({ ok: true, dataUrls }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  return false;
});
