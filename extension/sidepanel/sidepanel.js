/**
 * Article Study — Side Panel Logic
 * Handles AI chat, vision query, vocabulary, and briefing tabs.
 */

const API_BASE = 'http://127.0.0.1:8765/api';
let currentDocId = null;
let chatHistory = [];
let isBriefingRunning = false;

// ═══════════════════════════════════════════════════
// UI ELEMENTS
// ═══════════════════════════════════════════════════
const statusBox = document.getElementById('status-box');
const statusText = document.getElementById('status-text');
const progressFill = document.getElementById('progress-fill');

// ═══════════════════════════════════════════════════
// TAB SWITCHING
// ═══════════════════════════════════════════════════
document.querySelectorAll('.sp-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.sp-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.sp-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`panel-${tab.dataset.tab}`).classList.add('active');

    // Load data for the tab
    if (tab.dataset.tab === 'vocab') loadVocabulary();
    if (tab.dataset.tab === 'docs') loadDocuments();
    if (tab.dataset.tab === 'chat') loadPersistedState();
    if (tab.dataset.tab === 'notes') loadNotes();
  });
});

// ── INIT — Load state from storage ─────────────────────
function checkPendingActions() {
  chrome.storage.local.get(['currentDocId', 'panelMode', 'pendingSelection'], (data) => {
    currentDocId = data.currentDocId;

    if (data.panelMode === 'chat' && data.pendingSelection) {
      switchToTab('chat');
      handlePendingSelection(data.pendingSelection);
      chrome.storage.local.remove(['pendingSelection', 'panelMode']);
    } else if (data.panelMode === 'chat') {
      switchToTab('chat');
      chrome.storage.local.remove(['panelMode']);
    } else if (data.panelMode === 'docs') {
      switchToTab('docs');
      chrome.storage.local.remove(['panelMode']);
    } else if (data.panelMode === 'vocab') {
      switchToTab('vocab');
      chrome.storage.local.remove(['panelMode']);
    } else if (data.panelMode === 'briefing') {
      switchToTab('briefing');
      chrome.storage.local.remove(['panelMode']);
    } else if (data.panelMode === 'notes') {
      switchToTab('notes');
      chrome.storage.local.remove(['panelMode']);
    }
    
    if (currentDocId) {
      console.log('[SP] Current Doc ID:', currentDocId);
      checkStatus();
      loadPersistedState();
    } else {
      console.log('[SP] No currentDocId found in storage');
    }
  });
}

checkPendingActions();

async function loadPersistedState() {
  if (!currentDocId) return;
  
  // 1. Load Chat History — clear stale loading states
  const chatData = await chrome.storage.local.get([`chatHistory_${currentDocId}`, `chatLoading_${currentDocId}`]);
  let history = chatData[`chatHistory_${currentDocId}`] || [];
  const isChatLoading = chatData[`chatLoading_${currentDocId}`] || false;
  
  // Stale loading detection: if chatLoading is true but we just (re)loaded the panel,
  // the process that was generating the answer is dead. Clear the stale state.
  if (isChatLoading) {
    console.log('[SP] Clearing stale chatLoading state for', currentDocId);
    await chrome.storage.local.set({ [`chatLoading_${currentDocId}`]: false });
  }

  // Remove orphaned trailing user messages (question sent but answer never received)
  while (history.length > 0 && history[history.length - 1].role === 'user') {
    console.log('[SP] Removing orphaned user message:', history[history.length - 1].content.substring(0, 50));
    history.pop();
  }
  // Persist the cleaned history
  if (history.length !== (chatData[`chatHistory_${currentDocId}`] || []).length) {
    await chrome.storage.local.set({ [`chatHistory_${currentDocId}`]: history });
  }

  chatHistory = history;
  chatMessages.innerHTML = '';
  
  if (history.length > 0) {
    for (const msg of history) {
      addChatBubble(msg.role, msg.content);
    }
  } else {
    chatMessages.innerHTML = `
      <div class="sp-chat-welcome">
        <div class="sp-chat-welcome__icon">🤖</div>
        <h3>논문에 대해 질문하세요</h3>
        <p>학습된 논문 내용을 기반으로 답변합니다</p>
      </div>`;
    loadChatSuggestions();
  }
  chatMessages.scrollTop = chatMessages.scrollHeight;

  // 2. Load Briefing State — skip if briefing is actively running in this session
  if (isBriefingRunning) {
    console.log('[SP] Briefing is actively running, skipping state reset');
  } else {
    const briefingData = await chrome.storage.local.get([`briefing_${currentDocId}`]);
    const data = briefingData[`briefing_${currentDocId}`];

    const renderEmptyBriefing = () => {
      const briefingContainer = document.getElementById('briefing-container');
      briefingContainer.innerHTML = `
        <div class="sp-empty-state">
          <div style="font-size:48px;margin-bottom:12px;">🎯</div>
          <p>논문 브리핑을 생성합니다</p>
          <button id="briefing-generate" class="sp-btn-primary" style="margin-top:16px;">브리핑 생성</button>
        </div>`;
      document.getElementById('briefing-generate')?.addEventListener('click', generateBriefing);
    };

    if (data && typeof data === 'string') {
      // Clean up corrupted string data from the older bug
      console.warn('[SP] Detected corrupted string data for briefing, clearing it...');
      await chrome.storage.local.remove([`briefing_${currentDocId}`]);
      renderEmptyBriefing();
    } else if (data) {
      // Stale loading detection: only if no active briefing in this session
      if (data.status === 'processing' || data.loading) {
        console.log('[SP] Clearing stale briefing loading state for', currentDocId);
        await chrome.storage.local.remove([`briefing_${currentDocId}`]);
        renderEmptyBriefing();
      } else {
        renderBriefingResult(data);
      }
    } else {
      renderEmptyBriefing();
    }
  }
}

// Listen for storage changes while sidepanel is open
chrome.storage.onChanged.addListener((changes) => {
  if (changes.pendingSelection || changes.panelMode || changes.currentDocId) {
    checkPendingActions();
  }
  if (changes.currentDocId) {
    loadPersistedState();
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'RELOAD_VOCAB') {
    loadVocabulary();
  } else if (msg.type === 'VOCAB_ADDING') {
    const list = document.getElementById('vocab-list');
    if (!list) return;

    const loadingCard = document.createElement('div');
    loadingCard.className = 'sp-vocab-card sp-vocab-loading';
    loadingCard.innerHTML = `
      <div class="sp-vocab-card__word">${escapeHtml(msg.word)}</div>
      <div class="sp-loading" style="padding:16px; flex-direction:row; justify-content:center;">
        <div class="sp-spinner sp-spinner--small"></div>
        <span style="color:var(--sp-text-light);font-size:12px;margin-left:8px;">단어 의미 파악 중...</span>
      </div>
    `;
    
    // Clear initial empty state if present
    const emptyState = list.querySelector('.sp-empty-state');
    if (emptyState) {
      list.innerHTML = '';
    }
    
    list.prepend(loadingCard);
  } else if (msg.type === 'NOTES_EVALUATE_DONE') {
    const fbEl = document.getElementById(`feedback-${msg.noteId}`);
    if (fbEl) {
      fbEl.classList.remove('sp-note-feedback--loading');
      fbEl.innerHTML = `
        <div class="sp-note-feedback__header">🤖 AI 학습 피드백</div>
        <div style="white-space:pre-wrap;">${escapeHtml(msg.feedback)}</div>
      `;
    }
  } else if (msg.type === 'BRIEFING_BG_DONE' && msg.docId === currentDocId) {
    renderBriefingResult(msg.result);
  } else if (msg.type === 'CHAT_BG_DONE' && msg.docId === currentDocId) {
    chatSend.disabled = false;
    loadPersistedState(); // Refresh UI to show the new history
  }
});

function switchToTab(tabName) {
  document.querySelectorAll('.sp-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tabName);
  });
  document.querySelectorAll('.sp-panel').forEach(p => {
    p.classList.toggle('active', p.id === `panel-${tabName}`);
  });
  
  // Load data for the tab if needed
  if (tabName === 'vocab') loadVocabulary();
  if (tabName === 'docs') loadDocuments();
  if (tabName === 'notes') loadNotes();
}

async function handlePendingSelection(text) {
  chatInput.value = text + '\n\n(이 문장의 전후 맥락을 고려해서 분석해줘)';
  document.getElementById('chat-send').click();
}

// ═══════════════════════════════════════════════════
// AI CHAT
// ═══════════════════════════════════════════════════
const chatInput = document.getElementById('chat-input');
const chatSend = document.getElementById('chat-send');
const chatMessages = document.getElementById('chat-messages');
const vocabList = document.getElementById('vocab-list');
const vocabExportBtn = document.getElementById('vocab-export-csv');
const vocabClearBtn = document.getElementById('vocab-clear-btn');

chatSend.addEventListener('click', sendChatMessage);
document.getElementById('chat-clear-btn')?.addEventListener('click', async () => {
  if (!currentDocId) return;
  if (!confirm('현재 문서의 모든 채팅 기록을 초기화하시겠습니까?')) return;
  await chrome.storage.local.remove([`chatHistory_${currentDocId}`]);
  chatHistory = [];
  loadPersistedState();
});

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});

async function sendChatMessage() {
  const query = chatInput.value.trim();
  if (!query || !currentDocId) return;

  const suggContainer = document.getElementById('chat-suggestions');
  if (suggContainer) suggContainer.style.display = 'none';

  chatInput.value = '';
  addChatBubble('user', query);
  await performChatQuery(query);
}

async function loadChatSuggestions() {
  const container = document.getElementById('chat-suggestions');
  if (!container || !currentDocId) return;
  if (chatHistory && chatHistory.length > 0) { container.style.display = 'none'; return; }
  const cacheKey = `chat_sugg_${currentDocId}`;
  const data = await chrome.storage.local.get([cacheKey]);
  if (data[cacheKey] && data[cacheKey].length > 0) { renderSuggestions(data[cacheKey]); return; }
  container.style.display = 'flex';
  container.innerHTML = `<span style="font-size:12px;color:var(--sp-text-light);">💡 추천 질문 생성 중...</span>`;
  try {
    const lang = document.getElementById('briefing-lang')?.value || 'ko';
    const resp = await fetch(`${API_BASE}/chat_suggestions?doc_id=${currentDocId}&language=${lang}`);
    const resData = await resp.json();
    if (resData.suggestions && resData.suggestions.length > 0) {
      await chrome.storage.local.set({ [cacheKey]: resData.suggestions });
      renderSuggestions(resData.suggestions);
    } else { container.style.display = 'none'; }
  } catch(e) { container.style.display = 'none'; }
}

function renderSuggestions(suggestions) {
  const container = document.getElementById('chat-suggestions');
  if (!container || !suggestions || suggestions.length === 0) { if(container) container.style.display = 'none'; return; }
  container.style.display = 'flex';
  container.style.flexDirection = 'column';
  container.style.gap = '8px';
  container.style.padding = '8px 12px';
  const icons = ['💡', '🧩'];
  container.innerHTML = '';
  suggestions.forEach((s, idx) => {
    const btn = document.createElement('div');
    btn.style.cssText = 'display:flex;align-items:center;background:white;border:1px solid var(--sp-border);border-radius:8px;padding:8px 12px;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.03);transition:all 0.2s ease;';
    btn.innerHTML = `<span style="font-size:14px;margin-right:10px;">${icons[idx % icons.length]}</span><span style="font-size:12px;color:var(--sp-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(s)}</span>`;
    btn.onmouseover = () => { btn.style.transform = 'translateY(-2px)'; btn.style.boxShadow = '0 6px 16px rgba(0,0,0,0.08)'; };
    btn.onmouseout = () => { btn.style.transform = 'none'; btn.style.boxShadow = '0 2px 6px rgba(0,0,0,0.03)'; };
    btn.onclick = () => { chatInput.value = s; container.style.display = 'none'; sendChatMessage(); };
    container.appendChild(btn);
  });
}

async function performChatQuery(query) {
  chatSend.disabled = true;

  // Clear welcome
  const welcome = chatMessages.querySelector('.sp-chat-welcome');
  if (welcome) welcome.remove();

  // Add user message to history
  chatHistory.push({ role: 'user', content: query });
  if (currentDocId) {
    await chrome.storage.local.set({ [`chatHistory_${currentDocId}`]: chatHistory });
  }

  // Add loading bubble
  const loadingEl = addChatBubble('assistant', '');
  loadingEl.querySelector('.sp-chat-bubble').innerHTML = `
    <div class="sp-loading"><div class="sp-spinner"></div><span style="font-size:12px;margin-left:8px;">AI가 답변을 생성 중입니다...</span></div>
  `;

  try {
    const lang = document.getElementById('briefing-lang')?.value || 'ko';

    // Call the API directly from the sidepanel (avoids service worker timeout)
    const resp = await fetch(`${API_BASE}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        doc_id: currentDocId,
        query: query,
        history: chatHistory.slice(-10),
        language: lang,
        stream: false
      })
    });

    if (!resp.ok) throw new Error(`API ${resp.status}`);
    const result = await resp.json();
    const answer = result.answer || '';

    // Update UI
    const bubble = loadingEl.querySelector('.sp-chat-bubble');
    bubble.textContent = answer;

    // Persist to history
    chatHistory.push({ role: 'assistant', content: answer });
    await chrome.storage.local.set({
      [`chatHistory_${currentDocId}`]: chatHistory,
      [`chatLoading_${currentDocId}`]: false
    });
  } catch (err) {
    const bubble = loadingEl.querySelector('.sp-chat-bubble');
    bubble.textContent = `오류: ${err.message}`;
    bubble.style.color = '#FF7675';
    await chrome.storage.local.set({ [`chatLoading_${currentDocId}`]: false });
  } finally {
    chatSend.disabled = false;
  }
}

function addChatBubble(role, content) {
  const msg = document.createElement('div');
  msg.className = `sp-chat-message sp-chat-message--${role}`;
  msg.innerHTML = `<div class="sp-chat-bubble">${escapeHtml(content)}</div>`;
  chatMessages.appendChild(msg);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return msg;
}

// ── STATUS CHECK ──────────────────────────────────────
async function checkStatus() {
  if (!currentDocId) return;
  console.log('[SP] Checking status for:', currentDocId);

  try {
    const resp = await fetch(`${API_BASE}/ingest/${currentDocId}/status`);
    if (!resp.ok) {
        console.error('[SP] Status API error:', resp.status);
        return;
    }
    const data = await resp.json();
    console.log('[SP] Status data:', data);

    if (data.status === 'processing') {
      const percent = Math.round(data.progress * 100);
      const estText = data.estimated_seconds ? ` (약 ${Math.round(data.estimated_seconds)}초 남음)` : '';
      statusText.innerText = `${data.message || '학습 중...'} ${percent}%${estText}`;
      progressFill.style.width = `${percent}%`;
      statusBox.classList.remove('hidden');
      statusBox.querySelector('.sp-spinner')?.classList.remove('hidden');
      setTimeout(checkStatus, 1500);
    } else if (data.status === 'complete') {
      // Only show the "Success" toast if the box was already visible (meaning it just finished)
      // This prevents the bar from popping up every time the user switches tabs.
      if (!statusBox.classList.contains('hidden')) {
        statusText.innerText = '✅ 학습 완료!';
        progressFill.style.width = '100%';
        statusBox.querySelector('.sp-spinner')?.classList.add('hidden');
        setTimeout(() => {
          statusBox.classList.add('hidden');
          // Reset spinner visibility for next ingestion
          statusBox.querySelector('.sp-spinner')?.classList.remove('hidden');
        }, 3500);
      } else {
        statusBox.classList.add('hidden');
      }
    } else if (data.status === 'error') {
      statusText.innerText = `❌ 오류: ${data.message}`;
      statusBox.classList.remove('hidden');
      statusBox.querySelector('.sp-spinner')?.classList.add('hidden');
    } else {
      statusBox.classList.add('hidden');
    }
  } catch (err) {
    console.error('[SP] Status check failed:', err);
  }
}


// ═══════════════════════════════════════════════════
// VOCABULARY
// ═══════════════════════════════════════════════════

vocabExportBtn?.addEventListener('click', exportToCSV);
vocabClearBtn?.addEventListener('click', async () => {
  if (!currentDocId) return;
  if (!confirm('현재 문서에서 수집한 모든 단어장을 삭제하시겠습니까?')) return;
  try {
    const resp = await fetch(`${API_BASE}/vocabulary/document/${currentDocId}`, { method: 'DELETE' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    vocabList.innerHTML = `<div class="sp-empty-state"><p>삭제 완료!</p></div>`;
    setTimeout(loadVocabulary, 1000);
  } catch (err) {
    alert(`단어장 삭제 실패: ${err.message}`);
  }
});

async function loadVocabulary() {
  if (!currentDocId) {
    vocabList.innerHTML = `
      <div class="sp-empty-state">
        <div style="font-size:48px;margin-bottom:12px;">📝</div>
        <p>PDF 문서를 열어주세요.</p>
      </div>
    `;
    return;
  }

  try {
    const resp = await fetch(`${API_BASE}/vocabulary?doc_id=${currentDocId}`);
    const entries = await resp.json();
    
    // Check for pending words in storage
    const storage = await chrome.storage.local.get(['pendingVocab']);
    const pending = storage.pendingVocab || [];

    if (!entries.length && !pending.length) {
      vocabList.innerHTML = `
        <div class="sp-empty-state">
          <div style="font-size:48px;margin-bottom:12px;">📝</div>
          <p>논문에서 단어를 선택하면 자동으로 추가됩니다</p>
        </div>
      `;
      return;
    }

    let listHtml = '';
    
    // 1. Render Pending (Loading) Cards
    pending.forEach(word => {
        listHtml += `
          <div class="sp-vocab-card sp-vocab-loading">
            <div class="sp-vocab-card__word">${escapeHtml(word)}</div>
            <div class="sp-loading" style="padding:16px; flex-direction:row; justify-content:center;">
              <div class="sp-spinner sp-spinner--small"></div>
              <span style="color:var(--sp-text-light);font-size:12px;margin-left:8px;">단어 의미 파악 중...</span>
            </div>
          </div>
        `;
    });

    // 2. Render Existing Cards
    listHtml += entries.map(e => `
      <div class="sp-vocab-card">
        <div style="display:flex; justify-content:space-between; align-items:flex-start;">
          <div class="sp-vocab-card__word">${escapeHtml(e.word)}</div>
          <button class="sp-btn-icon-danger btn-delete-word" data-word="${escapeHtml(e.word)}" title="단어 삭제" style="padding:4px; font-size:14px; margin-top:-4px; margin-right:-4px;">🗑️</button>
        </div>
        <div class="sp-vocab-card__meaning">${escapeHtml(e.meaning).replace(/\n/g, '<br>')}</div>
        ${e.context_sentence ? `<div class="sp-vocab-card__context">"${escapeHtml(e.context_sentence.substring(0, 100))}"</div>` : ''}
        <div class="sp-vocab-card__meta">
          <span>저장일: ${e.added_at ? e.added_at.split('T')[0] : '-'}</span>
        </div>
      </div>
    `).join('');
    
    vocabList.innerHTML = listHtml;

    // Attach delete listeners
    document.querySelectorAll('.btn-delete-word').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const word = e.currentTarget.dataset.word;
        if (!confirm(`'${word}' 단어를 단어장에서 삭제하시겠습니까?`)) return;
        try {
          const resp = await fetch(`${API_BASE}/vocabulary/${encodeURIComponent(word)}?doc_id=${currentDocId}`, { method: 'DELETE' });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          loadVocabulary();
        } catch (err) {
          alert(`삭제 실패: ${err.message}`);
        }
      });
    });

  } catch (err) {
    vocabList.innerHTML = `<p style="color:#FF7675;padding:16px;">로딩 실패: ${err.message}</p>`;
  }
}

async function exportToCSV() {
  if (!currentDocId) {
    alert('학습된 논문을 먼저 열어주세요.');
    return;
  }
  try {
    const resp = await fetch(`${API_BASE}/vocabulary?doc_id=${currentDocId}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const entries = await resp.json();

    if (!entries || entries.length === 0) {
      alert('내보낼 단어가 없습니다.');
      return;
    }

    // CSV Header
    let csvContent = '단어 저장연월일,단어,1. 일반적 의미,2. 문맥적 의미\n';

    entries.forEach(e => {
      const dateStr = e.added_at ? e.added_at.split('T')[0] : 'None';
      const wordStr = e.word || '';
      
      let generalMeaning = '';
      let contextMeaning = '';

      // Parse standardized meaning lines "1. ...\n2. ..."
      if (e.meaning) {
        const lines = e.meaning.split('\\n');
        for (const line of lines) {
          if (line.includes('1. 일반적 의미') || line.startsWith('1.')) generalMeaning = line.replace(/^1\\.\\s*(\\[일반적 의미\\])?\\s*/, '').trim();
          else if (line.includes('2. 문맥적 의미') || line.startsWith('2.')) contextMeaning = line.replace(/^2\\.\\s*(\\[문맥적 의미\\])?\\s*/, '').trim();
        }
        // Fallback if parsing fails
        if (!generalMeaning && !contextMeaning) {
          generalMeaning = e.meaning.replace(/\\n/g, ' ');
        }
      }

      // Escape strings for CSV
      const esc = (text) => `"${(text || '').replace(/"/g, '""')}"`;
      
      csvContent += `${esc(dateStr)},${esc(wordStr)},${esc(generalMeaning)},${esc(contextMeaning)}\n`;
    });

    // Download logic
    const blob = new Blob(['\\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' }); // UFEEF for Excel UTF-8 BOM
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `article_study_vocabulary_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

  } catch (err) {
    alert(`CSV 내보내기 실패: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════
// BRIEFING
// ═══════════════════════════════════════════════════
const briefingBtn = document.getElementById('briefing-generate');
const briefingContainer = document.getElementById('briefing-container');

briefingBtn?.addEventListener('click', generateBriefing);

document.getElementById('briefing-clear-btn')?.addEventListener('click', async () => {
  if (!currentDocId) return;
  if (!confirm('현재 문서의 브리핑을 초기화하시겠습니까?')) return;
  await chrome.storage.local.remove([`briefing_${currentDocId}`]);
  briefingContainer.innerHTML = `
      <div class="sp-empty-state">
        <div style="font-size:48px;margin-bottom:12px;">🎯</div>
        <p>논문 브리핑을 생성합니다</p>
        <button id="briefing-generate" class="sp-btn-primary" style="margin-top:16px;">브리핑 생성</button>
      </div>`;
  document.getElementById('briefing-generate')?.addEventListener('click', generateBriefing);
});

async function generateBriefing() {
  if (!currentDocId) {
    briefingContainer.innerHTML = `<p style="color:#FF7675;padding:16px;">먼저 PDF를 학습시켜주세요</p>`;
    return;
  }

  const lang = document.getElementById('briefing-lang')?.value || 'ko';
  
  // Protect this fetch from being killed by loadPersistedState
  isBriefingRunning = true;

  // Show loading spinner immediately so user sees feedback
  briefingContainer.innerHTML = `
    <div class="sp-loading" style="padding:60px;">
      <div class="sp-spinner"></div>
      <span style="color:var(--sp-text-light);font-size:13px">브리핑 생성중... (약 1~2분 소요)</span>
    </div>`;

  try {
    // Call API directly from sidepanel (avoids service worker timeout)
    const resp = await fetch(`${API_BASE}/briefing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doc_id: currentDocId, language: lang })
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(`서버 오류 (${resp.status}): ${errBody.substring(0, 100)}`);
    }

    const result = await resp.json();

    // Persist and render
    await chrome.storage.local.set({ [`briefing_${currentDocId}`]: result });
    renderBriefingResult(result);
  } catch (err) {
    console.error('[Briefing] Error:', err);
    await chrome.storage.local.remove([`briefing_${currentDocId}`]);
    briefingContainer.innerHTML = `
      <div class="sp-empty-state">
        <div style="font-size:48px;margin-bottom:12px;">⚠️</div>
        <p style="color:#FF7675;">브리핑 생성 실패: ${escapeHtml(err.message)}</p>
        <button id="briefing-generate" class="sp-btn-primary" style="margin-top:16px;">다시 시도</button>
      </div>`;
    document.getElementById('briefing-generate')?.addEventListener('click', generateBriefing);
  } finally {
    isBriefingRunning = false;
  }
}

function renderBriefingResult(data) {
  if (data.error) {
    briefingContainer.innerHTML = `<p style="color:#FF7675;padding:16px;">브리핑 생성 실패: ${data.error}</p>`;
    return;
  }

  const diffClass = (data.difficulty || '').toLowerCase().includes('easy') ? 'easy'
    : (data.difficulty || '').toLowerCase().includes('hard') ? 'hard' : 'medium';

  const questionsHtml = (data.key_questions || []).map(q => `<li>${escapeHtml(q)}</li>`).join('');

  briefingContainer.innerHTML = `
    <div class="sp-briefing-section">
      <h4>📊 난이도</h4>
      <span class="sp-briefing-difficulty sp-briefing-difficulty--${diffClass}">${escapeHtml(data.difficulty || 'Unknown')}</span>
    </div>
    <div class="sp-briefing-section">
      <h4>📝 핵심 요약</h4>
      <p>${escapeHtml(data.summary || '')}</p>
    </div>
    ${questionsHtml ? `
    <div class="sp-briefing-section">
      <h4>❓ 핵심 연구 질문</h4>
      <ol>${questionsHtml}</ol>
    </div>` : ''}
    ${data.reading_guide ? `
    <div class="sp-briefing-section">
      <h4>📖 읽기 가이드</h4>
      <p>${escapeHtml(data.reading_guide)}</p>
    </div>` : ''}
    <button class="sp-btn-outline" id="btn-re-brief" style="margin-top:8px;">🔄 다시 생성</button>
  `;

  document.getElementById('btn-re-brief')?.addEventListener('click', generateBriefing);
}

// ═══════════════════════════════════════════════════
// DOCUMENTS (STUDY HISTORY)
// ═══════════════════════════════════════════════════
const docsList = document.getElementById('docs-list');

async function loadDocuments() {
  try {
    const resp = await fetch(`${API_BASE}/documents`);
    const docs = await resp.json();

    if (!docs.length) {
      docsList.innerHTML = `
        <div class="sp-empty-state">
          <div style="font-size:48px;margin-bottom:12px;">📂</div>
          <p>학습된 논문이 없습니다</p>
        </div>
      `;
      return;
    }

    docsList.innerHTML = docs.map(d => `
      <div class="sp-doc-card">
        <div class="sp-doc-card__main">
          <div class="sp-doc-card__title-row" style="display:flex; justify-content:space-between; align-items:center;">
            <div class="sp-doc-card__title" id="title-${d.doc_id}">${escapeHtml(d.title || d.filename)}</div>
            <button class="sp-btn-icon btn-rename-doc" data-id="${escapeHtml(d.doc_id)}" data-title="${escapeHtml(d.title || d.filename)}" title="제목 수정">✏️</button>
          </div>
          <div class="sp-doc-card__meta">
            <span>📄 ${d.page_count}페이지</span>
            <span>📅 ${d.ingested_at ? new Date(d.ingested_at).toLocaleDateString('ko') : '기록 없음'}</span>
          </div>
        </div>
        <button class="sp-btn-icon-danger btn-delete-doc" data-id="${escapeHtml(d.doc_id)}" title="학습 데이터 삭제">🗑️</button>
      </div>
    `).join('');
  } catch (err) {
    docsList.innerHTML = `<p style="color:#FF7675;padding:16px;">목록 로딩 실패: ${err.message}</p>`;
  }
}

// Event Delegation for document buttons
docsList.addEventListener('click', (e) => {
  const deleteBtn = e.target.closest('.btn-delete-doc');
  if (deleteBtn) {
    const docId = deleteBtn.dataset.id;
    if (docId) deleteDocument(docId);
    return;
  }
  
  const renameBtn = e.target.closest('.btn-rename-doc');
  if (renameBtn) {
    const docId = renameBtn.dataset.id;
    const oldTitle = renameBtn.dataset.title;
    if (docId) renameDocument(docId, oldTitle);
  }
});

async function renameDocument(docId, oldTitle) {
  const newTitle = prompt('문서의 제목을 입력하세요:', oldTitle);
  if (!newTitle || newTitle.trim() === oldTitle) return;

  try {
    const resp = await fetch(`${API_BASE}/documents/${docId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle.trim() })
    });
    
    if (resp.ok) {
      loadDocuments();
      if (currentDocId === docId) {
        chrome.storage.local.set({ currentTitle: newTitle.trim() });
      }
    } else {
      const err = await resp.json();
      alert('수정 실패: ' + (err.detail || '알 수 없는 오류'));
    }
  } catch (err) {
    alert('오류: ' + err.message);
  }
}

async function deleteDocument(docId) {
  if (!confirm('해당 논문의 학습 데이터를 삭제하시겠습니까?\n(채팅 및 요약 내용이 모두 삭제됩니다)')) return;

  try {
    const resp = await fetch(`${API_BASE}/documents/${docId}`, { method: 'DELETE' });
    if (resp.ok) {
      loadDocuments();
      if (currentDocId === docId) {
        currentDocId = null;
        chrome.storage.local.remove(['currentDocId', 'currentTitle']);
      }
    } else {
      alert('삭제 실패');
    }
  } catch (err) {
    alert('삭제 오류: ' + err.message);
  }
}

// Global expose for onclick
window.deleteDocument = deleteDocument;
window.loadDocuments = loadDocuments;

// ═══════════════════════════════════════════════════
// NOTES
// ═══════════════════════════════════════════════════
const notesContainer = document.getElementById('notes-container');

document.getElementById('notes-clear-btn')?.addEventListener('click', async () => {
  if (!currentDocId) return;
  if (!confirm('현재 문서의 모든 노트를 삭제하시겠습니까?')) return;
  try {
    await fetch(`${API_BASE}/notes?doc_id=${currentDocId}`, { method: 'DELETE' });
    loadNotes();
  } catch (err) { alert('노트 삭제 실패: ' + err.message); }
});

async function loadNotes() {
  if (!currentDocId || !notesContainer) return;
  notesContainer.innerHTML = `<div class="sp-loading" style="padding:40px;"><div class="sp-spinner"></div></div>`;
  try {
    const resp = await fetch(`${API_BASE}/notes?doc_id=${currentDocId}`);
    const notes = await resp.json();
    notesContainer.innerHTML = '';
    if (notes && notes.length > 0) {
      notes.forEach(n => renderCompletedNote(n));
    }
    renderActiveNoteInput();
  } catch (err) {
    notesContainer.innerHTML = `<p style="color:#FF7675;padding:16px;">노트 로딩 실패: ${err.message}</p>`;
  }
}

function renderCompletedNote(note) {
  const block = document.createElement('div');
  block.className = 'sp-note-block';
  const timeStr = note.created_at ? new Date(note.created_at).toLocaleString('ko') : '';
  block.innerHTML = `
    <div class="sp-note-block__meta">${timeStr}</div>
    <div class="sp-note-block__content">${escapeHtml(note.content)}</div>
  `;
  notesContainer.appendChild(block);

  if (note.ai_feedback) {
    const fb = document.createElement('div');
    fb.className = 'sp-note-feedback';
    fb.id = `feedback-${note.id}`;
    fb.innerHTML = `
      <div class="sp-note-feedback__header">🤖 AI 학습 피드백</div>
      <div style="white-space:pre-wrap;">${escapeHtml(note.ai_feedback)}</div>
    `;
    notesContainer.appendChild(fb);
  } else {
    // Show loading state if feedback is missing and re-trigger evaluation
    const loadingFb = document.createElement('div');
    loadingFb.className = 'sp-note-feedback sp-note-feedback--loading';
    loadingFb.id = `feedback-${note.id}`;
    loadingFb.innerHTML = `<div class="sp-spinner sp-spinner--small"></div><span>AI가 노트를 평가 중입니다...</span>`;
    notesContainer.appendChild(loadingFb);
    
    // Re-trigger the evaluation safely
    evaluateNoteAsync(note.id, note.content);
  }
}

function renderActiveNoteInput() {
  const block = document.createElement('div');
  block.className = 'sp-note-block sp-note-block--active';
  block.innerHTML = `
    <textarea placeholder="학습 노트를 작성하세요..." rows="3"></textarea>
    <div class="sp-note-hint">Enter: 완성 | Shift+Enter: 줄바꿈</div>
  `;
  notesContainer.appendChild(block);
  const textarea = block.querySelector('textarea');
  textarea.addEventListener('input', () => { textarea.style.height = 'auto'; textarea.style.height = textarea.scrollHeight + 'px'; });
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const content = textarea.value.trim();
      if (!content) return;
      submitNote(content, block);
    }
  });
  setTimeout(() => textarea.focus(), 100);
}

async function submitNote(content, activeBlock) {
  if (!currentDocId) return;
  const textarea = activeBlock.querySelector('textarea');
  textarea.disabled = true;
  textarea.style.opacity = '0.7';
  const hint = activeBlock.querySelector('.sp-note-hint');
  if (hint) hint.textContent = '저장 중...';
  try {
    const saveResp = await fetch(`${API_BASE}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: '', doc_id: currentDocId, content: content, ai_feedback: '', created_at: '' })
    });
    const savedNote = await saveResp.json();
    activeBlock.remove();
    renderCompletedNote({ ...savedNote, ai_feedback: '' });
    const loadingFb = document.createElement('div');
    loadingFb.className = 'sp-note-feedback sp-note-feedback--loading';
    loadingFb.id = `feedback-${savedNote.id}`;
    loadingFb.innerHTML = `<div class="sp-spinner sp-spinner--small"></div><span>AI가 노트를 평가하고 있습니다 (3단계 분석 중)...</span>`;
    notesContainer.appendChild(loadingFb);
    renderActiveNoteInput();
    notesContainer.scrollTop = notesContainer.scrollHeight;
    evaluateNoteAsync(savedNote.id, content);
  } catch (err) {
    console.error('Note submit error:', err);
    activeBlock.remove();
    renderActiveNoteInput();
    const newTextarea = notesContainer.querySelector('.sp-note-block--active textarea');
    if (newTextarea) newTextarea.value = content;
  }
}

async function evaluateNoteAsync(noteId, content) {
  try {
    const lang = document.getElementById('briefing-lang')?.value || 'ko';
    
    // Call API directly from sidepanel (avoids service worker timeout)
    const resp = await fetch(`${API_BASE}/notes/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doc_id: currentDocId, content: content, language: lang })
    });

    if (!resp.ok) {
      throw new Error(`서버 오류 (${resp.status})`);
    }

    const result = await resp.json();
    const feedback = result.feedback || '평가를 받아오지 못했습니다.';

    // Save feedback to the backend
    await fetch(`${API_BASE}/notes/${noteId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ai_feedback: feedback })
    });

    // Update UI directly
    const fbEl = document.getElementById(`feedback-${noteId}`);
    if (fbEl) {
      fbEl.className = 'sp-note-feedback';
      fbEl.innerHTML = `
        <div class="sp-note-feedback__header">🤖 AI 학습 피드백</div>
        <div style="white-space:pre-wrap;">${escapeHtml(feedback)}</div>
      `;
    }
  } catch (err) {
    console.error('[SP] Notes evaluate error:', err);
    const fbEl = document.getElementById(`feedback-${noteId}`);
    if (fbEl) {
      fbEl.className = 'sp-note-feedback';
      fbEl.style.color = '#FF7675';
      fbEl.innerHTML = `
        <div class="sp-note-feedback__header">⚠️ 평가 오류</div>
        <div style="white-space:pre-wrap;">${escapeHtml(err.message)}</div>
      `;
    }
  }
}

// ═══════════════════════════════════════════════════
// PDF EXPORT
// ═══════════════════════════════════════════════════
document.getElementById('notes-export-pdf')?.addEventListener('click', exportNotesToPDF);

async function exportNotesToPDF() {
  if (!currentDocId) { alert('먼저 PDF를 학습시켜주세요.'); return; }
  const exportBtn = document.getElementById('notes-export-pdf');
  const origText = exportBtn.textContent;
  exportBtn.textContent = '⏳ 생성중...';
  exportBtn.disabled = true;
  try {
    const resp = await fetch(`${API_BASE}/notes?doc_id=${currentDocId}`);
    const notes = await resp.json();
    if (!notes || notes.length === 0) { alert('내보낼 노트가 없습니다.'); return; }
    const titleData = await chrome.storage.local.get(['currentTitle']);
    const docTitle = titleData.currentTitle || '학습 노트';
    const PW = 520, SC = 2, MG = 15;
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p', 'mm', 'a4');
    const pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight();
    const uw = pw - MG * 2;
    let cy = MG;

    async function addBlock(el) {
      document.body.appendChild(el); el.style.opacity = '1';
      const c = await html2canvas(el, { scale: SC, useCORS: true, backgroundColor: '#ffffff', logging: false, width: PW, windowWidth: PW });
      el.remove();
      const img = c.toDataURL('image/png');
      const ih = (c.height / SC) * (uw / PW);
      if (cy + ih > ph - MG && cy > MG + 1) { pdf.addPage(); cy = MG; }
      pdf.addImage(img, 'PNG', MG, cy, uw, ih);
      cy += ih + 2;
    }
    function makeEl(html) {
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;top:0;left:0;width:' + PW + 'px;background:white;padding:0;font-family:Segoe UI,-apple-system,BlinkMacSystemFont,sans-serif;color:#2D3436;z-index:-9999;opacity:0;pointer-events:none;';
      el.innerHTML = html; return el;
    }

    await addBlock(makeEl('<div style="text-align:center;padding:20px 24px 16px;border-bottom:2px solid #6C5CE7;"><div style="font-size:20px;font-weight:700;color:#6C5CE7;margin-bottom:4px;">📝 학습 노트</div><div style="font-size:12px;color:#636E72;margin-top:8px;word-break:break-word;">' + escapeHtml(docTitle) + '</div><div style="font-size:10px;color:#B2BEC3;margin-top:4px;">생성일: ' + new Date().toLocaleDateString('ko') + ' ' + new Date().toLocaleTimeString('ko') + '</div></div>'));

    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const ts = n.created_at ? new Date(n.created_at).toLocaleString('ko') : '';
      let h = '<div style="padding:12px 24px;"><div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;"><div style="background:#6C5CE7;color:white;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;">' + (i+1) + '</div><span style="font-size:10px;color:#B2BEC3;">' + ts + '</span></div><div style="background:#F8F9FA;border:1px solid #E8ECF0;border-radius:8px;padding:12px 14px;font-size:13px;line-height:1.7;white-space:pre-wrap;word-break:break-word;">' + escapeHtml(n.content) + '</div>';
      if (n.ai_feedback) {
        h += '<div style="margin-top:8px;background:#F0FFFE;border:1px solid #B2F5EA;border-left:3px solid #00CEC9;border-radius:6px;padding:10px 12px;font-size:12px;line-height:1.6;color:#2D3436;"><div style="font-size:11px;font-weight:600;color:#00CEC9;margin-bottom:4px;">🤖 AI 피드백</div><div style="white-space:pre-wrap;word-break:break-word;">' + escapeHtml(n.ai_feedback) + '</div></div>';
      }
      h += '</div>';
      await addBlock(makeEl(h));
    }

    await addBlock(makeEl('<div style="padding:12px 24px;text-align:center;border-top:1px solid #E8ECF0;"><span style="font-size:9px;color:#B2BEC3;">Article Study — AI 논문 학습 도우미 | 총 ' + notes.length + '개 노트</span></div>'));
    const safeName = (docTitle || 'notes').substring(0, 30).replace(/[\/\\?%*:|"<>]/g, '_');
    pdf.save('학습노트_' + safeName + '_' + new Date().toISOString().split('T')[0] + '.pdf');
  } catch (err) {
    console.error('PDF export error:', err);
    alert('PDF 내보내기 실패: ' + err.message);
  } finally {
    exportBtn.textContent = origText;
    exportBtn.disabled = false;
  }
}

// ═══════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}
