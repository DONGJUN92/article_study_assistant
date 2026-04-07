const KEYS = ['opt-server', 'opt-ollama', 'opt-lang', 'opt-fontsize', 'opt-theme'];

// Load saved settings
chrome.storage.local.get(KEYS, (data) => {
  KEYS.forEach(key => {
    if (data[key]) document.getElementById(key).value = data[key];
  });
});

// Save
document.getElementById('btn-save').onclick = () => {
  const settings = {};
  KEYS.forEach(key => {
    settings[key] = document.getElementById(key).value;
  });
  chrome.storage.local.set(settings, () => {
    const toast = document.getElementById('toast');
    toast.style.display = 'block';
    setTimeout(() => { toast.style.display = 'none'; }, 2000);
  });
};
