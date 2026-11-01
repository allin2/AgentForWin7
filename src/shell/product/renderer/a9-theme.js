'use strict';

/* A9-44: synchronous head script, before styles/body, on Electron 22/Chromium 108.
 * localStorage key: win7-coding-agent.a9.appearance.v1
 * Record exactly: {schemaVersion:1,theme:'light'|'dark'}; never model settings.
 * Uses the existing Electron product data profile, not workspace/account state.
 * No preload/IPC, system theme, Node, network, or new runtime dependency.
 */
(function startAppearance() {
  const STORAGE_KEY = 'win7-coding-agent.a9.appearance.v1';
  let theme = 'light';
  let notice = '';

  function report(code, message) {
    notice = message;
    // Bounded, structured diagnostics; never log stored content or exception text.
    console.warn('A9_APPEARANCE', { schemaVersion: 1, code });
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      const record = JSON.parse(raw);
      if (record && !Array.isArray(record) && Object.keys(record).length === 2 &&
          record.schemaVersion === 1 && (record.theme === 'light' || record.theme === 'dark')) {
        theme = record.theme;
      } else {
        report('INVALID_RECORD', '外观记录无效，已使用浅色。');
      }
    }
  } catch (_error) {
    report('READ_FAILED', '无法读取外观记录，已使用浅色。');
  }

  function apply() {
    document.documentElement.setAttribute('data-theme', theme);
    document.querySelector('meta[name="color-scheme"]').setAttribute('content', theme);
    document.querySelector('meta[name="theme-color"]').setAttribute('content', theme === 'dark' ? '#181b1d' : '#f4f3ef');
  }

  apply();

  document.addEventListener('DOMContentLoaded', function bindAppearance() {
    const select = document.getElementById('a9-appearance-theme');
    const status = document.getElementById('a9-appearance-status');
    function showNotice() {
      status.textContent = notice;
      status.hidden = !notice;
    }
    select.value = theme;
    showNotice();
    select.addEventListener('change', function changeAppearance() {
      if (select.value !== 'light' && select.value !== 'dark') {
        select.value = theme;
        return;
      }
      theme = select.value;
      apply();
      notice = '';
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: 1, theme }));
      } catch (_error) {
        report('WRITE_FAILED', '无法记住外观选择；当前外观已生效，下次启动可能恢复原设置。');
      }
      showNotice();
    });
  }, { once: true });
}());
