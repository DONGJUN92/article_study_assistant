const KEYS = ['opt-server', 'opt-ollama', 'opt-lang', 'opt-fontsize', 'opt-theme'];
const DEFAULT_MODELS = ['gemma4:e2b', 'solar-pro3', 'kanana-o']; // Only 3 since Gemma3 is for translation. Wait, the req says gemma3:1b is included. I will include it.
const defaultAIList = ['gemma3:1b', 'gemma4:e2b', 'kanana-o', 'solar-pro3'];

const availableSelect = document.getElementById('available-models');
const appliedSelect = document.getElementById('applied-models');
const btnAdd = document.getElementById('btn-add');
const btnRemove = document.getElementById('btn-remove');
const btnRefresh = document.getElementById('btn-refresh-models');

let allModels = [];
let appliedModels = [];

// Load saved settings
chrome.storage.local.get([...KEYS, 'appliedModels'], (data) => {
  KEYS.forEach(key => {
    if (data[key]) document.getElementById(key).value = data[key];
  });
  
  appliedModels = data.appliedModels || defaultAIList;
  fetchModels();
});

async function fetchModels() {
  const serverUrl = document.getElementById('opt-server').value || "http://localhost:8765";
  availableSelect.innerHTML = '<option disabled>로딩중...</option>';
  try {
    const res = await fetch(`${serverUrl}/api/models`);
    if (!res.ok) throw new Error('API request failed');
    const data = await res.json();
    allModels = [...new Set([...data.built_in, ...data.openrouter_free])];
  } catch (err) {
    console.error("Failed to fetch models", err);
    // Fallback if server is off
    allModels = defaultAIList.slice();
  }
  renderLists();
}

btnRefresh.onclick = fetchModels;

function renderLists() {
  availableSelect.innerHTML = '';
  appliedSelect.innerHTML = '';

  const availList = allModels.filter(m => !appliedModels.includes(m));
  
  availList.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m; opt.textContent = m;
    availableSelect.appendChild(opt);
  });

  appliedModels.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m; opt.textContent = m;
    appliedSelect.appendChild(opt);
  });
}

function moveSelected(source, target, isAdding) {
  Array.from(source.selectedOptions).forEach(opt => {
    if (isAdding) {
      if (!appliedModels.includes(opt.value)) appliedModels.push(opt.value);
    } else {
      appliedModels = appliedModels.filter(m => m !== opt.value);
    }
  });
  renderLists();
}

btnAdd.onclick = () => moveSelected(availableSelect, appliedSelect, true);
btnRemove.onclick = () => moveSelected(appliedSelect, availableSelect, false);

// Save
document.getElementById('btn-save').onclick = () => {
  const settings = {};
  KEYS.forEach(key => {
    settings[key] = document.getElementById(key).value;
  });
  settings.appliedModels = appliedModels;
  
  chrome.storage.local.set(settings, () => {
    const toast = document.getElementById('toast');
    toast.style.display = 'block';
    setTimeout(() => { toast.style.display = 'none'; }, 2000);
  });
};
