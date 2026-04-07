/**
 * Article Study — Main Content Script
 * Handles PDF detection, text selection, tray bar, split view, and capture.
 */

(() => {
  'use strict';

  const API_BASE = 'http://127.0.0.1:8765/api';
  let currentDocId = null;
  let isPdf = false;
  let selectionPopup = null;
  let resultPopup = null;
  let trayBar = null;
  let splitView = null;
  let captureOverlay = null;
  
  // PDF.js global setup
  if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('libs/pdf.worker.min.js');
  }

  // ═══════════════════════════════════════════════════
  // 1. INITIALIZATION
  // ═══════════════════════════════════════════════════
  function init() {
    isPdf = detectPdf();
    if (isPdf) {
      injectTrayBar();
      startPdfIngestion();
    }
    setupMessageListener();
  }

  function detectPdf() {
    const url = window.location.href.toLowerCase();
    if (url.endsWith('.pdf')) return true;
    if (url.includes('pdf') && document.contentType === 'application/pdf') return true;
    // Check for PDF viewer embed
    const embed = document.querySelector('embed[type="application/pdf"]');
    if (embed) return true;
    // Check for PDF.js viewer
    if (document.querySelector('#viewer.pdfViewer')) return true;
    return false;
  }

  // ═══════════════════════════════════════════════════
  // 2. PDF INGESTION
  // ═══════════════════════════════════════════════════
  async function startPdfIngestion() {
    showToast('processing', '📖 논문 학습중...');

    const url = window.location.href;
    const filename = url.split('/').pop().split('?')[0] || 'document.pdf';

    try {
      let result;
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob = await resp.blob();
        
        result = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = async () => {
             const base64 = reader.result.split(',')[1];
             try {
               const r = await sendMessage({
                 type: 'INGEST_PDF',
                 pdfData: base64,
                 filename: filename,
               });
               resolve(r);
             } catch(e) { reject(e); }
          };
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      } catch (fetchErr) {
        console.log('Fetch failed, falling back to server-side download:', fetchErr);
        result = await sendMessage({
          type: 'INGEST_PDF',
          pdfUrl: url,
          filename: filename,
        });
      }

      if (!result || result.error) {
        let errorMsg = result?.error || '알 수 없는 오류';
        if (url.startsWith('file://')) {
          errorMsg = 'Chrome 설정에서 "파일 URL에 대한 액세스 허용"을 켜주세요.';
        }
        showToast('error', `❌ 학습 실패: ${errorMsg}`);
        return;
      }

      currentDocId = result.doc_id;
      chrome.storage.local.set({ currentDocId, currentTitle: result.title });

      if (result.status === 'already_indexed') {
        showToast('complete', '✅ 이미 학습된 논문입니다');
      } else {
        pollIngestStatus(result.doc_id);
      }
    } catch (err) {
      let errorMsg = err.message;
      if (url.startsWith('file://') && errorMsg.includes('fetch')) {
         errorMsg = 'Chrome 설정에서 "파일 URL에 대한 액세스 허용"을 활성화해야 합니다.';
      }
      showToast('error', `❌ PDF 로딩 실패: ${errorMsg}`);
    }
  }

  async function pollIngestStatus(docId) {
    showToast('processing', '문서 분석 준비 중...');
    const poll = setInterval(async () => {
      const status = await sendMessage({ type: 'INGEST_STATUS', docId });
      
      if (status.status === 'processing') {
        const percent = Math.round((status.progress || 0) * 100);
        const estText = status.estimated_seconds ? ` (약 ${Math.round(status.estimated_seconds)}초 남음)` : '';
        const msg = `${status.message || '학습 중...'} ${percent}%${estText}`;
        
        const toastText = document.querySelector('#as-processing-toast .as-toast__text');
        if (toastText) {
          toastText.textContent = msg;
        } else {
          showToast('processing', msg);
        }
      } else if (status.status === 'complete') {
        clearInterval(poll);
        showToast('complete', '✅ 학습 완료');
      } else if (status.status === 'error') {
        clearInterval(poll);
        showToast('error', `❌ 학습 실패: ${status.message}`);
      }
    }, 1500); // Poll slightly faster for real-time feel
  }

  // ═══════════════════════════════════════════════════
  // 3. TOAST NOTIFICATIONS
  // ═══════════════════════════════════════════════════
  function showToast(type, message) {
    removeToasts();
    const toast = document.createElement('div');
    toast.className = `as-toast as-toast--${type}`;

    if (type === 'processing') {
      toast.id = 'as-processing-toast';
      toast.innerHTML = `<div class="as-toast__spinner"></div><span class="as-toast__text">${message}</span>`;
    } else {
      toast.innerHTML = `<span>${message}</span>`;
    }

    if (type === 'error') {
      toast.onclick = () => toast.remove();
    }

    document.body.appendChild(toast);

    if (type === 'complete' || type === 'already_indexed') {
      setTimeout(() => {
        toast.classList.add('as-toast--fadeout');
        setTimeout(() => toast.remove(), 500);
      }, 2000);
    }
  }

  function removeToasts() {
    document.querySelectorAll('.as-toast').forEach(t => t.remove());
  }

  // ═══════════════════════════════════════════════════
  // 5. TRAY BAR
  // ═══════════════════════════════════════════════════
  function injectTrayBar() {
    if (trayBar) return;

    trayBar = document.createElement('div');
    trayBar.className = 'as-tray-bar as-tray-bar--minimized';
    trayBar.innerHTML = `
      <div class="as-tray-buttons">
        <button id="as-btn-translate" title="전체 문서 번역 (Ctrl+Shift+T)">📄 번역</button>
        <button id="as-btn-chat" title="AI에게 질문 (Ctrl+Shift+A)">💬 AI 질문</button>
        <button id="as-btn-vocab-tray" title="단어장 열기">🔤 단어장</button>
        <button id="as-btn-history-tray" title="학습 기록 열기">📜 학습 기록</button>
        <button id="as-btn-briefing-tray" title="논문 브리핑 열기">🎯 브리핑</button>
        <button id="as-btn-notes-tray" title="학습 노트 열기">📝 노트</button>
      </div>
      <div class="as-tray-fab-icon">📚</div>
    `;

    trayBar.querySelector('#as-btn-translate').onclick = toggleSplitView;
    trayBar.querySelector('#as-btn-chat').onclick = openAiChat;
    
    trayBar.querySelector('#as-btn-briefing-tray').onclick = () => {
      chrome.storage.local.set({ panelMode: 'briefing' });
      sendMessage({ type: 'OPEN_SIDEPANEL' });
    };

    trayBar.querySelector('#as-btn-notes-tray').onclick = () => {
      chrome.storage.local.set({ panelMode: 'notes' });
      sendMessage({ type: 'OPEN_SIDEPANEL' });
    };
    
    trayBar.querySelector('#as-btn-vocab-tray').onclick = () => {
      chrome.storage.local.set({ panelMode: 'vocab' });
      sendMessage({ type: 'OPEN_SIDEPANEL' });
    };
    
    trayBar.querySelector('#as-btn-history-tray').onclick = () => {
      chrome.storage.local.set({ panelMode: 'docs' });
      sendMessage({ type: 'OPEN_SIDEPANEL' });
    };

    let collapseTimer = null;

    trayBar.addEventListener('mouseenter', () => {
      if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
      trayBar.classList.remove('as-tray-bar--minimized');
      trayBar.classList.add('as-tray-bar--expanded');
    });

    trayBar.addEventListener('mouseleave', () => {
      collapseTimer = setTimeout(() => {
        trayBar.classList.remove('as-tray-bar--expanded');
        trayBar.classList.add('as-tray-bar--minimized');
      }, 500); // 500ms delay to prevent flickering
    });

    document.body.appendChild(trayBar);
  }

  // ═══════════════════════════════════════════════════
  // 8. SPLIT VIEW — FULL TRANSLATION
  // ═══════════════════════════════════════════════════
  function toggleSplitView() {
    if (splitView) {
      closeSplitView();
      return;
    }

    if (!currentDocId) {
      showToast('error', '❌ 먼저 PDF를 학습시켜주세요');
      return;
    }

    const btn = document.querySelector('#as-btn-translate');
    btn?.classList.add('active');

    splitView = document.createElement('div');
    splitView.className = 'as-split-container';

    splitView.innerHTML = `
      <div class="as-split-toolbar">
        <span style="font-weight:600;color:var(--as-primary)">📄 2분할 원본 대조 번역</span>
        <div style="display:flex; gap:12px; align-items:center;">
          <span id="as-split-status" style="font-size:12px; color:var(--as-text-light)"></span>
          <button id="as-split-close-btn"
                  style="all:unset;cursor:pointer;font-size:18px;color:var(--as-text-light);padding:4px 8px;">✕</button>
        </div>
      </div>
      <div class="as-split-pane as-split-pane--original" id="as-pane-original" style="margin-top:48px; background:#525659;">
         <!-- PDF.js container -->
         <div id="as-pdf-viewer" style="width:100%; height:100%; overflow:auto; padding:20px 0;"></div>
      </div>
      <div class="as-split-divider" id="as-split-divider"></div>
      <div class="as-split-pane as-split-pane--translated" id="as-pane-translated"
           style="margin-top:48px; background:white;"></div>
    `;

    splitView.addEventListener('close', closeSplitView);
    document.body.appendChild(splitView);

    splitView.querySelector('#as-split-close-btn')?.addEventListener('click', closeSplitView);

    // Setup divider drag
    setupDividerDrag();
    // Start loading translation and PDF
    loadAdvancedTranslation();
  }

  // --- PDF Viewer Helper ---
  let pdfDocument = null;
  let pageCanvases = {}; // pageNum -> { canvas, context, viewport }

  async function loadAdvancedTranslation() {
    const viewer = document.getElementById('as-pdf-viewer');
    const translated = document.getElementById('as-pane-translated');
    const statusText = document.getElementById('as-split-status');
    if (!viewer || !translated) return;

    translated.innerHTML = '<div style="text-align:center;padding:40px;color:var(--as-text-light)">번역 대기 중...</div>';
    statusText.innerText = 'PDF 로딩 중...';

    // 1. Load PDF bytes
    try {
      let pdfDataToLoad;
      
      // Always fetch the PDF from the backend to guarantee CORS bypass and correct version
      statusText.innerText = '문서 불러오는 중...';
      const pdfEndpoint = `${API_BASE}/documents/${currentDocId}/pdf`;
      const resp = await fetch(pdfEndpoint);
      if (!resp.ok) throw new Error(`서버에서 PDF를 가져오지 못했습니다. (${resp.status})`);
      
      const arrayBuffer = await resp.arrayBuffer();
      pdfDataToLoad = new Uint8Array(arrayBuffer);

      const loadingTask = pdfjsLib.getDocument(pdfDataToLoad);
      pdfDocument = await loadingTask.promise;
      viewer.innerHTML = ''; // clear loading
      pageCanvases = {};

      // 2. Render all pages (optimistic)
      for (let i = 1; i <= pdfDocument.numPages; i++) {
        const pageContainer = document.createElement('div');
        pageContainer.id = `as-pdf-page-container-${i}`;
        pageContainer.style.position = 'relative';
        pageContainer.style.margin = '0 auto 20px';
        pageContainer.style.boxShadow = '0 2px 10px rgba(0,0,0,0.2)';
        pageContainer.style.background = 'white';
        
        const canvas = document.createElement('canvas');
        canvas.id = `as-pdf-canvas-${i}`;
        pageContainer.appendChild(canvas);
        
        // Highlight layer
        const highlightLayer = document.createElement('div');
        highlightLayer.id = `as-pdf-highlights-${i}`;
        highlightLayer.style.position = 'absolute';
        highlightLayer.style.top = '0';
        highlightLayer.style.left = '0';
        highlightLayer.style.width = '100%';
        highlightLayer.style.height = '100%';
        highlightLayer.style.pointerEvents = 'none';
        highlightLayer.style.zIndex = '0';
        pageContainer.appendChild(highlightLayer);

        viewer.appendChild(pageContainer);

        const page = await pdfDocument.getPage(i);
        const viewport = page.getViewport({ scale: 1.5 }); // High res
        canvas.height = viewport.height;
        canvas.width = viewport.width;
        pageContainer.style.width = viewport.width + 'px';
        pageContainer.style.height = viewport.height + 'px';
        
        const renderContext = {
          canvasContext: canvas.getContext('2d'),
          viewport: viewport
        };
        await page.render(renderContext).promise;

        // Text layer for selection
        const textLayerDiv = document.createElement('div');
        textLayerDiv.className = 'as-text-layer';
        textLayerDiv.style.setProperty('--scale-factor', viewport.scale);
        pageContainer.appendChild(textLayerDiv);
        
        const textContent = await page.getTextContent();
        pdfjsLib.renderTextLayer({
          textContent: textContent,
          container: textLayerDiv,
          viewport: viewport,
          textDivs: []
        });

        pageCanvases[i] = { canvas, viewport };
      }

      statusText.innerText = '번역 시작...';
      
      // 3. Start Streaming Translation
      const port = chrome.runtime.connect({ name: 'translate' });
      port.postMessage({ docId: currentDocId, targetLang: 'ko' });

      translated.innerHTML = '';
      let activeHighlight = null;

      port.onMessage.addListener((msg) => {
        if (msg.done) { 
          statusText.innerText = '번역 완료';
          return; 
        }
        if (msg.error) {
          statusText.innerText = '오류 발생';
          translated.innerHTML = `<div style="padding:20px; color:var(--as-danger)">${msg.error}</div>`;
          return;
        }

        const data = msg; // from router
        const sentenceDiv = document.createElement('div');
        sentenceDiv.className = 'as-split-para';
        sentenceDiv.id = `as-sent-${data.index}`;
        sentenceDiv.innerHTML = `
          <div style="font-size:11px; color:var(--as-text-light); margin-bottom:4px;">${data.original}</div>
          <div style="font-weight:500;">${data.translated}</div>
        `;
        
        sentenceDiv.onclick = () => {
          // Scroll PDF to page/rect
          const container = document.getElementById(`as-pdf-page-container-${data.page}`);
          if (container) {
            container.scrollIntoView({ behavior: 'smooth', block: 'center' });
            // Highlight
            showSentenceHighlight(data.page, data.rects, data.index);
          }
          // Mark active in right pane
          document.querySelectorAll('.as-split-para--highlight').forEach(el => el.classList.remove('as-split-para--highlight'));
          sentenceDiv.classList.add('as-split-para--highlight');
        };

        translated.appendChild(sentenceDiv);
        statusText.innerText = `진행 중... (${data.page}페이지)`;
      });

    } catch (err) {
      console.error('[SPLIT] PDF.js fail:', err);
      statusText.innerText = '로딩 실패';
      viewer.innerHTML = `<div style="color:white; padding:40px;">PDF 로딩 실패: ${err.message}<br>브라우저 기본 뷰어에서 파일을 직접 읽을 수 없는 경우 발생할 수 있습니다.</div>`;
    }
  }

  function showSentenceHighlight(pageNo, rects, id) {
    // Clear old highlights on this page if needed, but usually we just want to show the current one
    // actually let's clear ALL highlights for a clean experience
    document.querySelectorAll('[id^="as-pdf-highlights-"] div').forEach(el => el.remove());

    const layer = document.getElementById(`as-pdf-highlights-${pageNo}`);
    if (!layer || !pageCanvases[pageNo]) return;

    const viewport = pageCanvases[pageNo].viewport;
    
    rects.forEach(rect => {
      // rect is [x0, y0, x1, y1] from PyMuPDF
      // Need to transform to viewport coordinates
      // PyMuPDF uses 72dpi, viewport scale 1.5 might handle it
      const [x0, y0, x1, y1] = rect;
      
      // PDF.js transformation
      const pdfPoint1 = viewport.convertToViewportPoint(x0, y1); // y is inverted in PDF? PyMuPDF y increases downward? 
      // Actually PyMuPDF (0,0) is top-left. PDF space (0,0) is bottom-left. 
      // FITZ (PyMuPDF) uses top-left origin by default.
      
      const el = document.createElement('div');
      el.style.position = 'absolute';
      el.style.backgroundColor = 'rgba(255, 235, 59, 0.4)'; // Yellow highlight
      el.style.border = '1px solid rgba(255, 193, 7, 0.6)';
      el.style.borderRadius = '2px';
      
      // Map BBox [x0, y0, x1, y1] to CSS
      // fitz coordinates are normally at 72dpi. viewport.scale is the factor.
      el.style.left = (x0 * viewport.scale) + 'px';
      el.style.top = (y0 * viewport.scale) + 'px';
      el.style.width = ((x1 - x0) * viewport.scale) + 'px';
      el.style.height = ((y1 - y0) * viewport.scale) + 'px';
      
      layer.appendChild(el);
    });
  }

  function closeSplitView() {
    if (splitView) {
      splitView.remove();
      splitView = null;
    }
    document.querySelector('#as-btn-translate')?.classList.remove('active');
  }

  function setupDividerDrag() {
    const divider = document.getElementById('as-split-divider');
    const original = document.getElementById('as-pane-original');
    const translated = document.getElementById('as-pane-translated');
    if (!divider || !original || !translated) return;

    let isDragging = false;

    divider.addEventListener('mousedown', () => {
      isDragging = true;
      divider.classList.add('active');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const container = splitView;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      const clamped = Math.max(0.2, Math.min(0.8, ratio));
      original.style.flex = `0 0 ${clamped * 100}%`;
      translated.style.flex = `0 0 ${(1 - clamped) * 100}%`;
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        divider.classList.remove('active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    });
  }

  function setupScrollSync() {
    const original = document.getElementById('as-pane-original');
    const translated = document.getElementById('as-pane-translated');
    if (!original || !translated) return;

    let syncing = false;

    original.addEventListener('scroll', () => {
      if (syncing) return;
      syncing = true;
      const ratio = original.scrollTop / (original.scrollHeight - original.clientHeight || 1);
      translated.scrollTop = ratio * (translated.scrollHeight - translated.clientHeight);
      requestAnimationFrame(() => { syncing = false; });
    });

    translated.addEventListener('scroll', () => {
      if (syncing) return;
      syncing = true;
      const ratio = translated.scrollTop / (translated.scrollHeight - translated.clientHeight || 1);
      original.scrollTop = ratio * (original.scrollHeight - original.clientHeight);
      requestAnimationFrame(() => { syncing = false; });
    });
  }

  async function loadTranslation() {
    const original = document.getElementById('as-pane-original');
    const translated = document.getElementById('as-pane-translated');
    if (!original || !translated) return;

    original.innerHTML = '<div style="text-align:center;padding:40px;color:var(--as-text-light)">원문 로딩중...</div>';
    translated.innerHTML = '<div style="text-align:center;padding:40px;color:var(--as-text-light)">번역중...</div>';

    try {
      const port = chrome.runtime.connect({ name: 'translate' });
      port.postMessage({ docId: currentDocId, targetLang: 'ko' });

      let firstChunk = true;
      let paraIndex = 0;

      port.onMessage.addListener((msg) => {
        if (msg.error) {
          original.innerHTML = `<div style="padding:40px;color:var(--as-danger)">오류: ${msg.error}</div>`;
          translated.innerHTML = '';
          port.disconnect();
          return;
        }

        if (msg.done) {
          port.disconnect();
          if (firstChunk) {
            original.innerHTML = '<div style="padding:40px;color:var(--as-text-light)">내용을 불러올 수 없습니다</div>';
            translated.innerHTML = '<div style="padding:40px;color:var(--as-text-light)">번역을 불러올 수 없습니다</div>';
          }
          return;
        }

        if (msg.data) {
          if (firstChunk) {
            original.innerHTML = '';
            translated.innerHTML = '';
            firstChunk = false;
          }

          const data = msg.data;
          
          const origPara = document.createElement('div');
          origPara.className = 'as-split-para';
          origPara.dataset.index = paraIndex;
          origPara.textContent = data.original;
          origPara.onmouseenter = function() { highlightPair(this.dataset.index); };
          origPara.onmouseleave = function() { removeHighlight(this.dataset.index); };
          original.appendChild(origPara);

          const transPara = document.createElement('div');
          transPara.className = 'as-split-para';
          transPara.dataset.index = paraIndex;
          transPara.textContent = data.translated;
          transPara.onmouseenter = function() { highlightPair(this.dataset.index); };
          transPara.onmouseleave = function() { removeHighlight(this.dataset.index); };
          translated.appendChild(transPara);

          paraIndex++;
        }
      });

      port.onDisconnect.addListener(() => {
        if (firstChunk && !original.innerHTML.includes('오류')) {
          original.innerHTML = '<div style="padding:40px;color:var(--as-danger)">서버 연결이 끊겼습니다</div>';
          translated.innerHTML = '';
        }
      });

    } catch (err) {
      original.innerHTML = `<div style="padding:40px;color:var(--as-danger)">오류: ${err.message}</div>`;
      translated.innerHTML = '';
    }
  }

  function highlightPair(index) {
    document.querySelectorAll('.as-split-para--highlight').forEach(el => {
      el.classList.remove('as-split-para--highlight');
    });

    document.querySelectorAll(`.as-split-para[data-index="${index}"]`).forEach(el => {
      el.classList.add('as-split-para--highlight');
    });
  }

  function removeHighlight(index) {
    document.querySelectorAll(`.as-split-para[data-index="${index}"]`).forEach(el => {
      el.classList.remove('as-split-para--highlight');
    });
  }

  // ═══════════════════════════════════════════════════
  // 9. AI CHAT — OPEN SIDE PANEL
  // ═══════════════════════════════════════════════════
  function openAiChat() {
    chrome.storage.local.set({ currentDocId, panelMode: 'chat' });
    sendMessage({ type: 'OPEN_SIDEPANEL' });
  }

  // ═══════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════
  // 11. MESSAGE HANDLING
  // ═══════════════════════════════════════════════════
  function setupMessageListener() {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      switch (msg.type) {
        case 'COMMAND':
          handleCommand(msg.command, msg.text);
          break;
        case 'ANALYZE_SELECTION':
          analyzeSelection(msg.text, { right: window.innerWidth / 2, top: 100 });
          break;
      }
    });
  }

  function handleCommand(command, msgText) {
    switch (command) {
      case 'translate-toggle': toggleSplitView(); break;
      case 'ai-chat-toggle': openAiChat(); break;
      case 'add-to-vocab':
        const sel = window.getSelection();
        const text = msgText || sel?.toString().trim();
        if (text) {
          const contextSentence = sel?.anchorNode?.parentNode?.textContent?.trim() || text;
          showToast('processing', `단어장에 추가 중...`);
          
          chrome.storage.local.get(['currentDocId'], (resSt) => {
            const docId = currentDocId || resSt.currentDocId;
            sendMessage({
              type: 'VOCAB_ADD',
              entry: {
                word: text,
                meaning: '',
                context_sentence: contextSentence,
                doc_id: docId
              }
            }).then(resp => {
              if (resp.error) {
                showToast('error', `추가 실패: ${resp.error}`);
              } else {
                showToast('complete', `✅ 단어장 추가 성공!`);
                sendMessage({ type: 'RELOAD_VOCAB' });
              }
            });
          });
        }
        break;
    }
  }

  // ═══════════════════════════════════════════════════
  // 12. UTILS
  // ═══════════════════════════════════════════════════
  function sendMessage(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        resolve(resp || {});
      });
    });
  }

  // ── Boot ──────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
