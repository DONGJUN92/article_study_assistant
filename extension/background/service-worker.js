/**
 * Article Study — Service Worker (Background Script)
 * Handles API communication, tab capture, and message routing.
 */

const API_BASE = 'http://127.0.0.1:8765/api';
console.log('[SW] Article Study Service Worker starting...');

// ── Side Panel setup ────────────────────────────────────
chrome.sidePanel?.setOptions?.({ enabled: true });

// ── Context Menu ────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'article-study-analyze',
      title: 'Article Study: 분석하기',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: 'article-study-add-vocab',
      title: 'Article Study: 단어장에 추가',
      contexts: ['selection'],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'article-study-analyze' && info.selectionText) {
    // 1. Save selection for the side panel to pick up
    await chrome.storage.local.set({ 
      pendingSelection: info.selectionText,
      panelMode: 'chat' 
    });
    
    // 2. Open Side Panel
    try {
      await chrome.sidePanel.open({ tabId: tab.id });
    } catch (e) {
      console.warn('sidePanel.open failed', e);
    }
  } else if (info.menuItemId === 'article-study-add-vocab' && info.selectionText) {
    const text = info.selectionText.trim();
    if (!text) return;

    const res = await chrome.storage.local.get(['currentDocId', 'pendingVocab', 'selectedModel', 'openrouterModel']);
    const pending = res.pendingVocab || [];
    if (!pending.includes(text)) {
      pending.push(text);
      await chrome.storage.local.set({ pendingVocab: pending });
    }

    chrome.runtime.sendMessage({ type: 'VOCAB_ADDING', word: text });

    // Directly call the Backend API
    const resp = await apiPost('/vocabulary', {
      word: text,
      meaning: '',
      context_sentence: text,
      doc_id: res.currentDocId || null,
      model_name: res.selectedModel || 'gemma4:e2b',
      openrouter_model: res.openrouterModel || 'google/gemma-4-31b-it:free'
    });

    // Remove from pending
    const res2 = await chrome.storage.local.get(['pendingVocab']);
    const updatedPending = (res2.pendingVocab || []).filter(w => w !== text);
    await chrome.storage.local.set({ pendingVocab: updatedPending });

    if (!resp.error) {
      chrome.runtime.sendMessage({ type: 'RELOAD_VOCAB' });
    }
  }
});

// ── Keyboard shortcuts ──────────────────────────────────
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'ai-chat-toggle') {
     chrome.sidePanel.open({ tabId: tab.id });
  } else {
    chrome.tabs.sendMessage(tab.id, { type: 'COMMAND', command });
  }
});

// ── Message handler  ────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse).catch(err => {
    sendResponse({ error: err.message });
  });
  return true; // async
});

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case 'HEALTH_CHECK':
      return apiGet('/health');

    case 'INGEST_PDF':
      return apiPost('/ingest', {
        pdf_data: msg.pdfData,
        filename: msg.filename,
        pdf_url: msg.pdfUrl,
      });

    case 'INGEST_STATUS':
      return apiGet(`/ingest/${msg.docId}/status`);

    case 'WORD_ANALYZE':
      return apiPost('/word', {
        word: msg.word,
        context: msg.context,
        doc_id: msg.docId,
      });

    case 'SENTENCE_ANALYZE':
      return apiPost('/sentence', {
        sentence: msg.sentence,
        doc_id: msg.docId,
      });

    case 'BRIEFING':
      return apiPost('/briefing', { doc_id: msg.docId });

    case 'OPEN_SIDEPANEL':
      try {
        await chrome.sidePanel.open({ tabId: sender.tab ? sender.tab.id : undefined });
      } catch (e) {
        console.warn('sidePanel.open failed', e);
      }
      return { ok: true };


    case 'GET_DOCUMENTS':
      return apiGet('/documents');

    case 'DELETE_DOCUMENT':
      return apiDelete(`/documents/${msg.docId}`);

    case 'VOCAB_LIST':
      return apiGet('/vocabulary');

    case 'VOCAB_ADD':
      return apiPost('/vocabulary', msg.entry);

    case 'VOCAB_DUE':
      return apiGet('/vocabulary/due');

    // ── Background AI Operations (survive sidepanel close) ──
    case 'NOTES_EVALUATE':
      handleNotesEvaluateBg(msg);
      return { status: 'started' };

    case 'BRIEFING_BG':
      handleBriefingBg(msg);
      return { status: 'started' };

    case 'CHAT_BG':
      handleChatBg(msg);
      return { status: 'started' };

    default:
      return { error: 'Unknown message type' };
  }
}


// ── API helpers ─────────────────────────────────────────
// ── Streaming Translation handler ───────────────────────
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'translate') {
    port.onMessage.addListener(async (msg) => {
      try {
        const resp = await fetch(`${API_BASE}/translate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ doc_id: msg.docId, target_lang: msg.targetLang })
        });

        if (!resp.ok) {
          throw new Error(`API ${resp.status}`);
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            port.postMessage({ done: true });
            break;
          }
          
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data:')) {
              const dataStr = line.slice(5).trim();
              if (dataStr) {
                try {
                  const data = JSON.parse(dataStr);
                  port.postMessage(data);
                } catch(e) {}
              }
            }
          }
        }
      } catch (err) {
        port.postMessage({ error: err.message });
      }
    });
  }
});

async function apiGet(path) {
  try {
    const resp = await fetch(`${API_BASE}${path}`);
    if (!resp.ok) throw new Error(`API ${resp.status}`);
    return await resp.json();
  } catch (err) {
    return { error: err.message };
  }
}

async function apiPost(path, body) {
  try {
    const resp = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`API ${resp.status}`);
    return await resp.json();
  } catch (err) {
    return { error: err.message };
  }
}

async function apiDelete(path) {
  try {
    const resp = await fetch(`${API_BASE}${path}`, { method: 'DELETE' });
    if (!resp.ok) throw new Error(`API ${resp.status}`);
    return await resp.json();
  } catch (err) {
    return { error: err.message };
  }
}

async function apiPatch(path, body) {
  try {
    const resp = await fetch(`${API_BASE}${path}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`API ${resp.status}`);
    return await resp.json();
  } catch (err) {
    return { error: err.message };
  }
}

// ── Background AI Handlers ─────────────────────────────────
// These operations run entirely in the service worker and
// survive sidepanel close. Results are broadcast via messages.

async function handleNotesEvaluateBg(msg) {
  const { noteId, docId, content, language } = msg;
  try {
    const result = await apiPost('/notes/evaluate', {
      doc_id: docId,
      content: content,
      language: language || 'ko'
    });

    const feedback = result.feedback || '평가를 받아오지 못했습니다.';

    // Persist to server
    await apiPatch(`/notes/${noteId}`, { ai_feedback: feedback });

    // Broadcast to sidepanel (if open)
    chrome.runtime.sendMessage({
      type: 'NOTES_EVALUATE_DONE',
      noteId, feedback
    }).catch(() => {}); // sidepanel may be closed, that's fine
  } catch (err) {
    console.warn('[SW] Notes evaluate error:', err);
    chrome.runtime.sendMessage({
      type: 'NOTES_EVALUATE_DONE',
      noteId,
      feedback: `평가 오류: ${err.message}`
    }).catch(() => {});
  }
}

async function handleBriefingBg(msg) {
  const { docId, language } = msg;

  try {
    const result = await apiPost('/briefing', {
      doc_id: docId,
      language: language || 'ko'
    });

    if (result.error) throw new Error(result.error);

    // Persist to storage immediately
    await chrome.storage.local.set({ [`briefing_${docId}`]: result });

    chrome.runtime.sendMessage({
      type: 'BRIEFING_BG_DONE',
      docId, result
    }).catch(() => {});
  } catch (err) {
    console.warn('[SW] Briefing bg error:', err);
    chrome.runtime.sendMessage({
      type: 'BRIEFING_BG_DONE',
      docId, result: { error: err.message }
    }).catch(() => {});
  }
}

async function handleChatBg(msg) {
  const { docId, query, history, language } = msg;
  try {
    const result = await apiPost('/chat', {
      doc_id: docId,
      query: query,
      history: history || [],
      language: language || 'ko',
      stream: false
    });

    if (result.error) throw new Error(result.error);

    const answer = result.answer || '';
    const newHistory = [...(history || []), { role: 'assistant', content: answer }];

    // Persist to storage immediately so sidepanel can see it on return
    await chrome.storage.local.set({ 
      [`chatHistory_${docId}`]: newHistory,
      [`chatLoading_${docId}`]: false 
    });

    chrome.runtime.sendMessage({
      type: 'CHAT_BG_DONE',
      docId, query, answer
    }).catch(() => {});
  } catch (err) {
    console.warn('[SW] Chat bg error:', err);
    await chrome.storage.local.set({ [`chatLoading_${docId}`]: false });
    chrome.runtime.sendMessage({
      type: 'CHAT_BG_DONE',
      docId, query,
      error: err.message
    }).catch(() => {});
  }
}
