const API_BASE = 'http://127.0.0.1:8765/api';
console.log('Popup loaded, checking health at:', `${API_BASE}/health`);

// Health check
fetch(`${API_BASE}/health`).then(r => {
  console.log('Health check response:', r.status);
  return r.json();
}).then(data => {
  console.log('Health check data:', data);
  document.getElementById('server-dot').className =
    `popup-status__dot popup-status__dot--${data.status === 'ok' ? 'ok' : 'warn'}`;
  document.getElementById('server-status').textContent =
    data.status === 'ok' ? '서버 연결됨' : '서버 연결됨 (일부 기능 제한)';

  document.getElementById('ollama-dot').className =
    `popup-status__dot popup-status__dot--${data.ollama ? 'ok' : 'err'}`;
  document.getElementById('ollama-status').textContent =
    data.ollama ? 'Ollama 연결됨' : 'Ollama 연결 실패';
}).catch((err) => {
  console.error('Health check failed:', err);
  document.getElementById('server-dot').className = 'popup-status__dot popup-status__dot--err';
  document.getElementById('server-status').textContent = '서버에 연결할 수 없습니다';
  document.getElementById('ollama-dot').className = 'popup-status__dot popup-status__dot--err';
  document.getElementById('ollama-status').textContent = '서버 비활성';
});

// Current document
chrome.storage.local.get(['currentDocId', 'currentTitle'], (data) => {
  if (data.currentDocId) {
    document.getElementById('doc-section').style.display = 'block';
    document.getElementById('doc-title').textContent = data.currentTitle || data.currentDocId;
    document.getElementById('doc-info').textContent = `ID: ${data.currentDocId}`;
  }
});

// Buttons
document.getElementById('btn-options').onclick = () => {
  chrome.runtime.openOptionsPage();
};

document.getElementById('btn-docs').onclick = () => {
  chrome.storage.local.set({ panelMode: 'docs' }, () => {
    chrome.runtime.sendMessage({ type: 'OPEN_SIDEPANEL' });
  });
};

document.getElementById('btn-docs-link').onclick = (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'http://127.0.0.1:8765/docs' });
};
