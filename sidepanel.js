const BING_CREATE_URL = 'https://www.bing.com/images/create/ai-image-generator';

const ASPECT_LABEL_TO_BING = {
  '1:1': '1',
  '3:2': '4',
  '2:3': '5'
};

const state = {
  queue: [],
  running: false,
  paused: false,
  allowWatermarkedNoLogin: false,
  pendingResumeAction: null,
  referenceImage: null, // { name, type, dataUrl }
  downloadDirHandle: null
};

// IndexedDB helper for persisting FileSystemDirectoryHandle across side panel reloads
function openHandleDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('bingAutomatorDB', 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('handles')) {
        req.result.createObjectStore('handles');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveDirHandle(handle) {
  const db = await openHandleDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('handles', 'readwrite');
    if (handle) {
      tx.objectStore('handles').put(handle, 'downloadDir');
    } else {
      tx.objectStore('handles').delete('downloadDir');
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadDirHandle() {
  try {
    const db = await openHandleDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('handles', 'readonly');
      const req = tx.objectStore('handles').get('downloadDir');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

const el = (id) => document.getElementById(id);

const ui = {
  tabStatus: el('tabStatus'),
  refreshStatusBtn: el('refreshStatusBtn'),
  openBingCard: el('openBingCard'),
  openBingBtn: el('openBingBtn'),
  allowAlembicCheckbox: el('allowAlembicCheckbox'),
  authWarningCard: el('authWarningCard'),
  signInBingBtn: el('signInBingBtn'),
  resumeAfterLoginBtn: el('resumeAfterLoginBtn'),
  continueNoLoginBtn: el('continueNoLoginBtn'),

  aiBaseUrl: el('aiBaseUrl'),
  aiApiKey: el('aiApiKey'),
  aiModel: el('aiModel'),
  fetchModelsBtn: el('fetchModelsBtn'),
  aiModelSelect: el('aiModelSelect'),
  aiSystemPrompt: el('aiSystemPrompt'),
  aiTopic: el('aiTopic'),
  aiChooseAspectRatio: el('aiChooseAspectRatio'),
  aiCount: el('aiCount'),
  aiCountVal: el('aiCountVal'),
  generatePromptsBtn: el('generatePromptsBtn'),
  aiStatus: el('aiStatus'),

  aspectRatio: el('aspectRatio'),
  downloadMode: el('downloadMode'),
  downloadSubfolder: el('downloadSubfolder'),
  chooseFolderBtn: el('chooseFolderBtn'),
  chosenFolderRow: el('chosenFolderRow'),
  chosenFolderLabel: el('chosenFolderLabel'),
  clearFolderBtn: el('clearFolderBtn'),
  refImageInput: el('refImageInput'),
  clearRefBtn: el('clearRefBtn'),
  refPreviewWrap: el('refPreviewWrap'),
  refPreviewImg: el('refPreviewImg'),
  refFileName: el('refFileName'),

  manualPromptInput: el('manualPromptInput'),
  addManualBtn: el('addManualBtn'),
  queueCount: el('queueCount'),
  queueList: el('queueList'),
  clearQueueBtn: el('clearQueueBtn'),
  startBatchBtn: el('startBatchBtn'),
  pauseBatchBtn: el('pauseBatchBtn'),
  batchStatus: el('batchStatus'),

  targetBatchIndex: el('targetBatchIndex'),
  editPromptInput: el('editPromptInput'),
  runEditBtn: el('runEditBtn'),
  restyleSelect: el('restyleSelect'),
  runRestyleBtn: el('runRestyleBtn'),
  actionStatus: el('actionStatus')
};

async function getActiveBingTab() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab && activeTab.url && activeTab.url.startsWith('https://www.bing.com/images/create')) {
    return activeTab;
  }
  const bingTabs = await chrome.tabs.query({ url: 'https://www.bing.com/images/create*' });
  return bingTabs[0] || null;
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

async function sendToBingTab(message) {
  const tab = await getActiveBingTab();
  if (!tab) {
    throw new Error('No Bing Image Creator tab found.');
  }
  await chrome.runtime.sendMessage({ type: 'ENSURE_CONTENT_SCRIPT', tabId: tab.id });
  return chrome.tabs.sendMessage(tab.id, message);
}

async function runSidepanelBingJob(submitType, payload, { timeout = 120000 } = {}) {
  const tab = await getActiveBingTab();
  if (!tab) throw new Error('No Bing Image Creator tab found.');
  const tabId = tab.id;

  const preSnap = await sendToBingTab({ type: 'POLL_GENERATION', payload }).catch(() => null);
  let prevUrl = preSnap?.url || tab.url || '';
  let prevImages = Array.isArray(preSnap?.images) ? preSnap.images : [];

  try {
    const submitRes = await sendToBingTab({ type: submitType, payload });
    if (submitRes && !submitRes.ok) {
      throw new Error(submitRes.error || `${submitType} failed.`);
    }
    if (submitRes?.prevUrl) prevUrl = submitRes.prevUrl;
    if (Array.isArray(submitRes?.prevImages)) prevImages = submitRes.prevImages;
  } catch (err) {
    if (!isTransientNavError(err)) throw err;
    // Page navigated immediately after clicking Generate; continue polling
  }

  const start = Date.now();
  let sawGeneratingState = false;
  let firstReadyAt = 0;

  while (Date.now() - start < timeout) {
    await sleep(1000);
    let snap = null;
    try {
      const currentTab = await chrome.tabs.get(tabId);
      if (currentTab.status === 'loading') {
        sawGeneratingState = true;
        continue;
      }
      await chrome.runtime.sendMessage({ type: 'ENSURE_CONTENT_SCRIPT', tabId });
      snap = await chrome.tabs.sendMessage(tabId, {
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
        const finalSnap = await chrome.tabs
          .sendMessage(tabId, {
            type: 'POLL_GENERATION',
            payload: { autoDismissWatermarkModal: Boolean(payload?.autoDismissWatermarkModal) }
          })
          .catch(() => snap);
        return { ok: true, urls: finalSnap?.images?.length ? finalSnap.images : currentImages };
      }
      if (!firstReadyAt) firstReadyAt = Date.now();
      if (Date.now() - firstReadyAt >= 2500) {
        return { ok: true, urls: currentImages };
      }
    } else {
      firstReadyAt = 0;
    }
  }

  throw new Error('Timed out waiting for Bing image generation to finish.');
}

async function refreshTabStatus() {
  try {
    const tab = await getActiveBingTab();
    if (!tab) {
      ui.tabStatus.textContent = 'Not on Bing Image Creator';
      ui.openBingCard.classList.remove('hidden');
      return null;
    }
    ui.openBingCard.classList.add('hidden');
    await chrome.runtime.sendMessage({ type: 'ENSURE_CONTENT_SCRIPT', tabId: tab.id });
    const status = await chrome.tabs.sendMessage(tab.id, { type: 'CHECK_STATUS' });
    ui.tabStatus.textContent = status.signedOut
      ? 'Connected (Signed Out — Watermark applies)'
      : 'Connected (Signed In)';
    if (!status.signedOut) {
      ui.authWarningCard.classList.add('hidden');
    }
    return status;
  } catch {
    ui.tabStatus.textContent = 'Bing tab loading or needs refresh';
    return null;
  }
}

async function ensureAuthOrPause(resumeFn) {
  const status = await refreshTabStatus();
  if (!status) {
    throw new Error('Could not connect to Bing Image Creator tab. Refresh the Bing page and try again.');
  }
  if (status.signedOut && !state.allowWatermarkedNoLogin) {
    state.pendingResumeAction = resumeFn;
    ui.authWarningCard.classList.remove('hidden');
    ui.batchStatus.textContent = 'Paused: waiting for sign-in choice (watermark notice).';
    return false;
  }
  return true;
}

function updateChosenFolderUI() {
  if (state.downloadDirHandle) {
    ui.chosenFolderLabel.textContent = `📁 Custom folder: ${state.downloadDirHandle.name}`;
    ui.chosenFolderRow.classList.remove('hidden');
    ui.downloadSubfolder.disabled = true;
    ui.downloadSubfolder.placeholder = `Saving to ${state.downloadDirHandle.name}`;
  } else {
    ui.chosenFolderLabel.textContent = '';
    ui.chosenFolderRow.classList.add('hidden');
    ui.downloadSubfolder.disabled = false;
    ui.downloadSubfolder.placeholder = 'Subfolder in Downloads';
  }
}

async function ensureCustomFolderPermission() {
  if (!state.downloadDirHandle) return false;
  try {
    let perm = await state.downloadDirHandle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      perm = await state.downloadDirHandle.requestPermission({ mode: 'readwrite' });
    }
    return perm === 'granted';
  } catch {
    return false;
  }
}

function saveSettings() {
  chrome.storage.local.set({
    aiBaseUrl: ui.aiBaseUrl.value.trim(),
    aiApiKey: ui.aiApiKey.value.trim(),
    aiModel: ui.aiModel.value.trim(),
    aiSystemPrompt: ui.aiSystemPrompt.value,
    aiChooseAspectRatio: ui.aiChooseAspectRatio.checked,
    aiCount: ui.aiCount.value,
    aspectRatio: ui.aspectRatio.value,
    downloadMode: ui.downloadMode.value,
    downloadSubfolder: ui.downloadSubfolder.value.trim()
  });
}

async function loadSettings() {
  const data = await chrome.storage.local.get([
    'alembicEnabled',
    'aiBaseUrl',
    'aiApiKey',
    'aiModel',
    'aiSystemPrompt',
    'aiChooseAspectRatio',
    'aiCount',
    'aspectRatio',
    'downloadMode',
    'downloadSubfolder'
  ]);
  ui.allowAlembicCheckbox.checked = Boolean(data.alembicEnabled);
  ui.aiBaseUrl.value = data.aiBaseUrl || 'https://api.openai.com/v1';
  ui.aiApiKey.value = data.aiApiKey || '';
  ui.aiModel.value = data.aiModel || 'gpt-4o-mini';
  ui.aiSystemPrompt.value = data.aiSystemPrompt || '';
  ui.aiChooseAspectRatio.checked = Boolean(data.aiChooseAspectRatio);
  ui.aiCount.value = data.aiCount || '4';
  ui.aiCountVal.textContent = ui.aiCount.value;
  if (data.aspectRatio) ui.aspectRatio.value = data.aspectRatio;
  if (data.downloadMode) ui.downloadMode.value = data.downloadMode;
  if (data.downloadSubfolder) ui.downloadSubfolder.value = data.downloadSubfolder;

  state.downloadDirHandle = await loadDirHandle();
  updateChosenFolderUI();
}

function renderQueue() {
  ui.queueCount.textContent = String(state.queue.length);
  ui.queueList.innerHTML = '';

  state.queue.forEach((item, index) => {
    const li = document.createElement('li');
    li.className = 'queue-item';

    const row = document.createElement('div');
    row.className = 'queue-item-row';

    const text = document.createElement('span');
    text.className = 'queue-item-text';
    text.title = item.prompt;
    text.textContent = `${index + 1}. ${item.prompt}`;

    const badge = document.createElement('span');
    const badgeClass =
      item.status === 'done'
        ? 'badge-done'
        : item.status === 'error'
        ? 'badge-error'
        : item.status === 'pending'
        ? 'badge-pending'
        : 'badge-running';
    badge.className = `badge ${badgeClass}`;
    badge.textContent = item.status;
    if (item.error) badge.title = item.error;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn btn-ghost btn-xs';
    removeBtn.textContent = '✕';
    removeBtn.disabled = state.running && item.status !== 'pending' && item.status !== 'done' && item.status !== 'error';
    removeBtn.addEventListener('click', () => {
      state.queue.splice(index, 1);
      renderQueue();
    });

    if (item.aspectRatioLabel) {
      const arBadge = document.createElement('span');
      arBadge.className = 'badge-ar';
      arBadge.title = 'AI-selected aspect ratio';
      arBadge.textContent = item.aspectRatioLabel;
      row.append(text, arBadge, badge, removeBtn);
    } else {
      row.append(text, badge, removeBtn);
    }

    li.appendChild(row);
    if (item.error) {
      const errEl = document.createElement('div');
      errEl.className = 'queue-item-error';
      errEl.textContent = item.error;
      li.appendChild(errEl);
    }
    ui.queueList.appendChild(li);
  });
}

function addPromptsToQueue(items) {
  for (const entry of items) {
    if (typeof entry === 'string') {
      const trimmed = entry.trim();
      if (trimmed) {
        state.queue.push({ prompt: trimmed, aspectRatioLabel: null, status: 'pending', error: null });
      }
    } else if (entry && typeof entry.prompt === 'string') {
      const trimmed = entry.prompt.trim();
      if (trimmed) {
        state.queue.push({
          prompt: trimmed,
          aspectRatioLabel: entry.aspectRatio || null,
          status: 'pending',
          error: null
        });
      }
    }
  }
  renderQueue();
}

function sanitizeFileSegment(text, maxLen = 40) {
  return (text || 'image')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen) || 'image';
}

function dataUrlToUint8Array(dataUrl) {
  const base64 = dataUrl.split(',')[1] || '';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function downloadResultUrls(urls, label) {
  const mode = ui.downloadMode.value;
  const targetUrls = mode === 'first' ? urls.slice(0, 1) : urls;

  // Save directly to custom folder via File System Access API if chosen & permitted
  if (state.downloadDirHandle) {
    const hasPerm = await ensureCustomFolderPermission();
    if (hasPerm) {
      const fetchRes = await chrome.runtime.sendMessage({
        type: 'FETCH_FULLRES_DATA_URLS',
        payload: { urls: targetUrls }
      });
      if (!fetchRes?.ok) {
        throw new Error(fetchRes?.error || 'Failed to fetch full-res images.');
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const slug = sanitizeFileSegment(label, 42);
      const saved = [];
      for (let i = 0; i < fetchRes.dataUrls.length; i++) {
        const filename = `${timestamp}_${slug}_img_${i + 1}.jpg`;
        const fileHandle = await state.downloadDirHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(dataUrlToUint8Array(fetchRes.dataUrls[i]));
        await writable.close();
        saved.push({ filename });
      }
      return saved;
    }
  }

  // Fallback to Chrome Downloads subfolder
  const res = await chrome.runtime.sendMessage({
    type: 'DOWNLOAD_IMAGES',
    payload: {
      urls: targetUrls,
      prompt: label,
      subfolder: ui.downloadSubfolder.value.trim() || 'BingImageCreator'
    }
  });
  if (!res?.ok) {
    throw new Error(res?.error || 'Download failed.');
  }
  return res.results;
}

async function acquireSidepanelLock() {
  const res = await chrome.runtime.sendMessage({ type: 'SET_SIDEPANEL_BUSY', busy: true });
  if (!res?.ok) {
    throw new Error(res?.error || 'Busy: another generation is running.');
  }
}

function releaseSidepanelLock() {
  chrome.runtime.sendMessage({ type: 'SET_SIDEPANEL_BUSY', busy: false }).catch(() => {});
}

function setRunningUI(isRunning) {
  state.running = isRunning;
  ui.startBatchBtn.disabled = isRunning;
  ui.pauseBatchBtn.disabled = !isRunning;
  ui.runEditBtn.disabled = isRunning;
  ui.runRestyleBtn.disabled = isRunning;
}

async function runBatchQueue() {
  if (state.running) return;
  const hasPending = state.queue.some((q) => q.status === 'pending');
  if (!hasPending) {
    ui.batchStatus.textContent = 'Add at least one pending prompt to the queue.';
    return;
  }

  try {
    await ensureCustomFolderPermission();
    const canProceed = await ensureAuthOrPause(runBatchQueue);
    if (!canProceed) return;
    await acquireSidepanelLock();
  } catch (err) {
    ui.batchStatus.textContent = err.message;
    return;
  }

  state.paused = false;
  setRunningUI(true);

  try {
    for (let i = 0; i < state.queue.length; i++) {
      if (state.paused) {
        ui.batchStatus.textContent = 'Batch paused.';
        break;
      }

      const item = state.queue[i];
      if (item.status !== 'pending') continue;

      item.status = 'generating';
      renderQueue();
      const itemAspectValue =
        (item.aspectRatioLabel && ASPECT_LABEL_TO_BING[item.aspectRatioLabel]) || ui.aspectRatio.value;
      ui.batchStatus.textContent = `Generating (${i + 1}/${state.queue.length}): ${item.prompt.slice(0, 48)}...`;

      try {
        const genRes = await runSidepanelBingJob('SUBMIT_GENERATE', {
          prompt: item.prompt,
          aspectRatio: itemAspectValue,
          referenceImage: state.referenceImage,
          autoDismissWatermarkModal: state.allowWatermarkedNoLogin
        });

        if (!genRes?.ok) {
          throw new Error(genRes?.error || 'Generation failed.');
        }

        item.status = 'downloading';
        renderQueue();
        ui.batchStatus.textContent = `Downloading images for prompt ${i + 1}/${state.queue.length}...`;

        await downloadResultUrls(genRes.urls, item.prompt);
        item.status = 'done';
        item.error = null;
        renderQueue();
        await sleep(1000);
      } catch (err) {
        item.status = 'error';
        item.error = err.message;
        renderQueue();
        ui.batchStatus.textContent = `Error on item ${i + 1}: ${err.message}`;
      }
    }

    if (!state.paused) {
      const doneCount = state.queue.filter((q) => q.status === 'done').length;
      const errCount = state.queue.filter((q) => q.status === 'error').length;
      ui.batchStatus.textContent =
        errCount > 0
          ? `Batch finished: ${doneCount} done, ${errCount} failed.`
          : `Batch complete! (${doneCount} done)`;
    }
  } finally {
    releaseSidepanelLock();
    setRunningUI(false);
    refreshTabStatus();
  }
}

async function runSingleEditImage() {
  const editPrompt = ui.editPromptInput.value.trim();
  if (!editPrompt) {
    ui.actionStatus.textContent = 'Enter an edit prompt first.';
    ui.actionStatus.classList.remove('hidden');
    return;
  }

  try {
    await ensureCustomFolderPermission();
    const canProceed = await ensureAuthOrPause(runSingleEditImage);
    if (!canProceed) return;
    await acquireSidepanelLock();
  } catch (err) {
    ui.actionStatus.textContent = err.message;
    ui.actionStatus.classList.remove('hidden');
    return;
  }

  setRunningUI(true);
  ui.actionStatus.classList.remove('hidden');
  ui.actionStatus.textContent = 'Running Edit Image on Bing...';

  try {
    const res = await runSidepanelBingJob('SUBMIT_EDIT_IMAGE', {
      batchIndex: Number(ui.targetBatchIndex.value),
      editPrompt,
      aspectRatio: ui.aspectRatio.value,
      autoDismissWatermarkModal: state.allowWatermarkedNoLogin
    });
    if (!res?.ok) throw new Error(res?.error || 'Edit image failed.');

    ui.actionStatus.textContent = 'Downloading edited images...';
    await downloadResultUrls(res.urls, `edit_${editPrompt}`);
    ui.actionStatus.textContent = 'Edit Image complete & downloaded!';
  } catch (err) {
    ui.actionStatus.textContent = `Error: ${err.message}`;
  } finally {
    releaseSidepanelLock();
    setRunningUI(false);
    refreshTabStatus();
  }
}

async function runSingleRestyle() {
  const styleKey = ui.restyleSelect.value;
  const styleLabel = ui.restyleSelect.options[ui.restyleSelect.selectedIndex].text;

  try {
    await ensureCustomFolderPermission();
    const canProceed = await ensureAuthOrPause(runSingleRestyle);
    if (!canProceed) return;
    await acquireSidepanelLock();
  } catch (err) {
    ui.actionStatus.textContent = err.message;
    ui.actionStatus.classList.remove('hidden');
    return;
  }

  setRunningUI(true);
  ui.actionStatus.classList.remove('hidden');
  ui.actionStatus.textContent = `Restyling as "${styleLabel}"...`;

  try {
    const res = await runSidepanelBingJob('SUBMIT_RESTYLE', {
      batchIndex: Number(ui.targetBatchIndex.value),
      styleKey,
      autoDismissWatermarkModal: state.allowWatermarkedNoLogin
    });
    if (!res?.ok) throw new Error(res?.error || 'Restyle failed.');

    ui.actionStatus.textContent = 'Downloading restyled images...';
    await downloadResultUrls(res.urls, `restyle_${styleKey}`);
    ui.actionStatus.textContent = `Restyle (${styleLabel}) complete & downloaded!`;
  } catch (err) {
    ui.actionStatus.textContent = `Error: ${err.message}`;
  } finally {
    releaseSidepanelLock();
    setRunningUI(false);
    refreshTabStatus();
  }
}

// Event Listeners
ui.refreshStatusBtn.addEventListener('click', refreshTabStatus);

ui.openBingBtn.addEventListener('click', async () => {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab) {
    await chrome.tabs.update(activeTab.id, { url: BING_CREATE_URL });
  } else {
    await chrome.tabs.create({ url: BING_CREATE_URL });
  }
  setTimeout(refreshTabStatus, 1500);
});

ui.signInBingBtn.addEventListener('click', async () => {
  try {
    await sendToBingTab({ type: 'TRIGGER_SIGN_IN' });
    ui.batchStatus.textContent = 'Sign in on the Bing tab, then click "I\'m Signed In — Resume".';
  } catch (err) {
    ui.batchStatus.textContent = err.message;
  }
});

ui.resumeAfterLoginBtn.addEventListener('click', async () => {
  const status = await refreshTabStatus();
  if (status && !status.signedOut) {
    ui.authWarningCard.classList.add('hidden');
    const fn = state.pendingResumeAction;
    state.pendingResumeAction = null;
    if (fn) fn();
  } else {
    ui.batchStatus.textContent = 'Still signed out on Bing. Finish signing in or choose Continue Without Login.';
  }
});

ui.continueNoLoginBtn.addEventListener('click', async () => {
  state.allowWatermarkedNoLogin = true;
  ui.authWarningCard.classList.add('hidden');
  try {
    await sendToBingTab({ type: 'DISMISS_WATERMARK_MODAL' });
  } catch {
    // Ignore if modal isn't open
  }
  const fn = state.pendingResumeAction;
  state.pendingResumeAction = null;
  if (fn) fn();
});

ui.allowAlembicCheckbox.addEventListener('change', () => {
  chrome.storage.local.set({ alembicEnabled: ui.allowAlembicCheckbox.checked });
});

ui.aiCount.addEventListener('input', () => {
  ui.aiCountVal.textContent = ui.aiCount.value;
  saveSettings();
});

[
  ui.aiBaseUrl,
  ui.aiApiKey,
  ui.aiModel,
  ui.aiSystemPrompt,
  ui.aiChooseAspectRatio,
  ui.aspectRatio,
  ui.downloadMode,
  ui.downloadSubfolder
].forEach((input) => input.addEventListener('change', saveSettings));

ui.fetchModelsBtn.addEventListener('click', async () => {
  saveSettings();
  ui.fetchModelsBtn.disabled = true;
  ui.aiStatus.classList.remove('hidden');
  ui.aiStatus.textContent = 'Fetching models from API...';

  try {
    const res = await chrome.runtime.sendMessage({
      type: 'OPENAI_FETCH_MODELS',
      payload: {
        baseUrl: ui.aiBaseUrl.value.trim(),
        apiKey: ui.aiApiKey.value.trim()
      }
    });

    if (!res?.ok) throw new Error(res?.error || 'Failed to fetch models.');

    ui.aiModelSelect.innerHTML = '';
    for (const modelId of res.models) {
      const opt = document.createElement('option');
      opt.value = modelId;
      opt.textContent = modelId;
      ui.aiModelSelect.appendChild(opt);
    }

    if (res.models.includes(ui.aiModel.value.trim())) {
      ui.aiModelSelect.value = ui.aiModel.value.trim();
    } else if (res.models.length > 0) {
      ui.aiModel.value = res.models[0];
      ui.aiModelSelect.value = res.models[0];
      saveSettings();
    }

    ui.aiModelSelect.classList.remove('hidden');
    ui.aiStatus.textContent = `Loaded ${res.models.length} model(s).`;
  } catch (err) {
    ui.aiStatus.textContent = `Fetch Models Error: ${err.message}`;
  } finally {
    ui.fetchModelsBtn.disabled = false;
  }
});

ui.aiModelSelect.addEventListener('change', () => {
  ui.aiModel.value = ui.aiModelSelect.value;
  saveSettings();
});

ui.chooseFolderBtn.addEventListener('click', async () => {
  if (typeof window.showDirectoryPicker !== 'function') {
    ui.batchStatus.textContent = 'Folder picker not supported in this browser; using Downloads subfolder.';
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    state.downloadDirHandle = handle;
    await saveDirHandle(handle);
    updateChosenFolderUI();
    ui.batchStatus.textContent = `Download folder set to: ${handle.name}`;
  } catch (err) {
    if (err?.name !== 'AbortError') {
      ui.batchStatus.textContent = `Could not choose folder: ${err.message}`;
    }
  }
});

ui.clearFolderBtn.addEventListener('click', async () => {
  state.downloadDirHandle = null;
  await saveDirHandle(null);
  updateChosenFolderUI();
  ui.batchStatus.textContent = 'Reset to Chrome Downloads subfolder.';
});

ui.generatePromptsBtn.addEventListener('click', async () => {
  const topic = ui.aiTopic.value.trim();
  if (!topic) {
    ui.aiStatus.textContent = 'Enter a theme or idea for the AI prompter.';
    ui.aiStatus.classList.remove('hidden');
    return;
  }

  saveSettings();
  ui.generatePromptsBtn.disabled = true;
  ui.aiStatus.classList.remove('hidden');
  ui.aiStatus.textContent = `Generating ${ui.aiCount.value} prompt(s)...`;

  try {
    const res = await chrome.runtime.sendMessage({
      type: 'OPENAI_GENERATE_PROMPTS',
      payload: {
        baseUrl: ui.aiBaseUrl.value.trim(),
        apiKey: ui.aiApiKey.value.trim(),
        model: ui.aiModel.value.trim(),
        systemPrompt: ui.aiSystemPrompt.value,
        topic,
        count: Number(ui.aiCount.value),
        chooseAspectRatio: ui.aiChooseAspectRatio.checked
      }
    });

    if (!res?.ok) throw new Error(res?.error || 'Failed to generate prompts.');
    const addedItems = res.items || res.prompts;
    addPromptsToQueue(addedItems);
    ui.aiStatus.textContent = `Added ${addedItems.length} AI-generated prompt(s) to the queue.`;
  } catch (err) {
    ui.aiStatus.textContent = `AI Error: ${err.message}`;
  } finally {
    ui.generatePromptsBtn.disabled = false;
  }
});

ui.refImageInput.addEventListener('change', () => {
  const file = ui.refImageInput.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    state.referenceImage = {
      name: file.name,
      type: file.type || 'image/png',
      dataUrl: reader.result
    };
    ui.refPreviewImg.src = reader.result;
    ui.refFileName.textContent = file.name;
    ui.refPreviewWrap.classList.remove('hidden');
    ui.clearRefBtn.classList.remove('hidden');
  };
  reader.readAsDataURL(file);
});

ui.clearRefBtn.addEventListener('click', () => {
  state.referenceImage = null;
  ui.refImageInput.value = '';
  ui.refPreviewImg.src = '';
  ui.refFileName.textContent = '';
  ui.refPreviewWrap.classList.add('hidden');
  ui.clearRefBtn.classList.add('hidden');
});

ui.addManualBtn.addEventListener('click', () => {
  const lines = ui.manualPromptInput.value.split(/\r?\n/);
  addPromptsToQueue(lines);
  ui.manualPromptInput.value = '';
});

ui.clearQueueBtn.addEventListener('click', () => {
  if (state.running) return;
  state.queue = [];
  renderQueue();
});

ui.startBatchBtn.addEventListener('click', runBatchQueue);
ui.pauseBatchBtn.addEventListener('click', () => {
  state.paused = true;
  ui.batchStatus.textContent = 'Pausing after current step...';
});

ui.runEditBtn.addEventListener('click', runSingleEditImage);
ui.runRestyleBtn.addEventListener('click', runSingleRestyle);

// Keep a lifecycle port so background resets sidepanelBusy if the side panel closes mid-run
chrome.runtime.connect({ name: 'sidepanel' });

// Initialize
loadSettings();
renderQueue();
refreshTabStatus();
