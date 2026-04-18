(function () {
  'use strict';

  var root = document.getElementById('hajirai-chat-root');
  if (!root) return;

  var config = {
    shop: root.dataset.shop || '',
    position: root.dataset.position || 'bottom-center',
    primary: root.dataset.primary || '#000000',
    accent: root.dataset.accent || '#FFFFFF',
    greeting: root.dataset.greeting || "Hi! I'm your personal shopping assistant.",
    assistantName: root.dataset.assistantName || 'AI Shopping Assistant'
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var launcher = document.createElement('button');
  launcher.className = 'hajirai-launcher hajirai-pos-' + config.position;
  launcher.style.background = config.primary;
  launcher.style.color = config.accent;
  launcher.setAttribute('aria-label', 'Open chat');
  launcher.innerHTML =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
    '<span class="hajirai-launcher-label">Chat with us</span>';

  var panel = document.createElement('div');
  panel.className = 'hajirai-panel hajirai-pos-' + config.position;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', config.assistantName);
  panel.innerHTML =
    '<div class="hajirai-panel-header" style="background:' + config.primary + ';color:' + config.accent + ';">' +
      '<span class="hajirai-panel-title">' + escapeHtml(config.assistantName) + '</span>' +
      '<button class="hajirai-panel-close" aria-label="Close chat" style="color:' + config.accent + ';">&times;</button>' +
    '</div>' +
    '<div class="hajirai-panel-body">' +
      '<div class="hajirai-greeting">' + escapeHtml(config.greeting) + '</div>' +
      '<div class="hajirai-placeholder">Chat coming soon — the store is still setting this up.</div>' +
    '</div>' +
    '<div class="hajirai-panel-footer">' +
      '<div class="hajirai-powered">Powered by Hajirai</div>' +
    '</div>';

  function openPanel() {
    panel.classList.add('is-open');
    launcher.classList.add('is-hidden');
  }
  function closePanel() {
    panel.classList.remove('is-open');
    launcher.classList.remove('is-hidden');
  }

  launcher.addEventListener('click', openPanel);
  panel.querySelector('.hajirai-panel-close').addEventListener('click', closePanel);

  document.body.appendChild(launcher);
  document.body.appendChild(panel);

  // TODO (Phase 3): fetch /apps/hajirai/config via App Proxy and replace the
  // fallback config with the merchant's saved values from the admin dashboard.
})();
