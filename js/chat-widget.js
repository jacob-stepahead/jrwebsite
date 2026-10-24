// Chat Widget for Jacob Rafiy's Website
// Embeddable chat widget that appears on all pages except the dedicated chat page

(function() {
  'use strict';

  // Configuration
  const WORKER_URL = 'https://jacobrafiy-api-proxy.jhrafiy.workers.dev';
  const STORAGE_KEY = 'jacob-chat-messages';

  // State
  let messages = [];
  let isLoading = false;
  let isExpanded = false;

  // Load messages from sessionStorage
  function loadMessages() {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored) {
        messages = JSON.parse(stored);
      }
    } catch (e) {
      messages = [];
    }
  }

  // Save messages to sessionStorage
  function saveMessages() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    } catch (e) {
      // Storage full or unavailable
    }
  }

  // Inject CSS
  function injectStyles() {
    const styles = `
      /* Chat Widget Styles */
      .jcw-widget {
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 9999;
        font-family: 'Inter Tight', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }

      /* Minimized Button */
      .jcw-button {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 12px 20px;
        background: #eeece8;
        color: #0a0a0b;
        border: none;
        border-radius: 50px;
        font-family: inherit;
        font-size: 15px;
        font-weight: 500;
        cursor: pointer;
        box-shadow: 0 4px 24px rgba(0, 0, 0, 0.45);
        transition: all 150ms ease;
      }

      .jcw-button:hover {
        background: #ffffff;
        transform: translateY(-2px);
        box-shadow: 0 6px 28px rgba(255, 154, 92, 0.25);
      }

      .jcw-button svg {
        width: 20px;
        height: 20px;
      }

      .jcw-button.jcw-hidden {
        display: none;
      }

      /* Chat Window */
      .jcw-window {
        position: absolute;
        bottom: 0;
        right: 0;
        width: 380px;
        height: 520px;
        background: #111113;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 16px;
        box-shadow: 0 16px 60px rgba(0, 0, 0, 0.6);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        opacity: 0;
        transform: translateY(20px) scale(0.95);
        pointer-events: none;
        transition: all 200ms ease;
      }

      .jcw-window.jcw-expanded {
        opacity: 1;
        transform: translateY(0) scale(1);
        pointer-events: auto;
      }

      /* Header */
      .jcw-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 20px;
        background: #0e0e10;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      }

      .jcw-header-title {
        font-family: 'Inter Tight', -apple-system, sans-serif;
        font-size: 17px;
        font-weight: 600;
        color: #eeece8;
        margin: 0;
        letter-spacing: -0.02em;
      }

      .jcw-header-actions {
        display: flex;
        gap: 8px;
      }

      .jcw-header-btn {
        width: 32px;
        height: 32px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        color: #a3a09a;
        transition: all 150ms ease;
      }

      .jcw-header-btn:hover {
        background: rgba(255, 154, 92, 0.12);
        color: #ff9a5c;
      }

      .jcw-header-btn svg {
        width: 18px;
        height: 18px;
      }

      /* Messages Area */
      .jcw-messages {
        flex: 1;
        overflow-y: auto;
        overflow-anchor: none;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        background: #0e0e10;
      }

      /* Empty State */
      .jcw-empty {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
        color: #a3a09a;
        padding: 20px;
      }

      .jcw-empty p {
        font-size: 14px;
        margin: 0;
        line-height: 1.5;
      }

      /* Message */
      .jcw-message {
        max-width: 85%;
        animation: jcwFadeIn 0.3s ease;
      }

      @keyframes jcwFadeIn {
        from { opacity: 0; transform: translateY(8px); }
        to { opacity: 1; transform: translateY(0); }
      }

      .jcw-message.jcw-user {
        align-self: flex-end;
      }

      .jcw-message.jcw-assistant {
        align-self: flex-start;
      }

      .jcw-message-label {
        font-size: 11px;
        color: #a3a09a;
        margin-bottom: 4px;
        font-weight: 500;
        letter-spacing: 0.05em;
      }

      .jcw-message.jcw-user .jcw-message-label {
        text-align: right;
      }

      .jcw-message-content {
        padding: 10px 14px;
        border-radius: 12px;
        line-height: 1.5;
        font-size: 14px;
      }

      .jcw-message.jcw-user .jcw-message-content {
        background: #ff9a5c;
        color: #1a0d05;
        border-bottom-right-radius: 4px;
      }

      .jcw-message.jcw-assistant .jcw-message-content {
        background: #1d1d21;
        color: #eeece8;
        border-bottom-left-radius: 4px;
      }

      /* Suggestions */
      .jcw-suggestions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        padding: 12px 16px;
        border-top: 1px solid rgba(255, 255, 255, 0.08);
        background: #0e0e10;
      }

      .jcw-suggestion-btn {
        background: transparent;
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 16px;
        padding: 6px 12px;
        font-family: inherit;
        font-size: 12px;
        color: #a3a09a;
        cursor: pointer;
        transition: all 150ms ease;
      }

      .jcw-suggestion-btn:hover:not(:disabled) {
        border-color: #ff9a5c;
        color: #ff9a5c;
        background: rgba(255, 154, 92, 0.12);
      }

      .jcw-suggestion-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .jcw-suggestions.jcw-hidden {
        display: none;
      }

      /* Input Area */
      .jcw-input-area {
        display: flex;
        gap: 8px;
        padding: 12px 16px;
        border-top: 1px solid rgba(255, 255, 255, 0.08);
        background: #111113;
      }

      .jcw-input {
        flex: 1;
        padding: 10px 14px;
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 8px;
        font-family: inherit;
        font-size: 14px;
        color: #eeece8;
        background: #18181b;
        outline: none;
        transition: border-color 150ms ease;
      }

      .jcw-input:focus {
        border-color: #ff9a5c;
      }

      .jcw-input::placeholder {
        color: #a3a09a;
      }

      .jcw-send-btn {
        padding: 10px 16px;
        background: #ff9a5c;
        color: #1a0d05;
        border: none;
        border-radius: 8px;
        font-family: inherit;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: all 150ms ease;
      }

      .jcw-send-btn:hover:not(:disabled) {
        background: #ffb27f;
      }

      .jcw-send-btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      /* Loading Indicator */
      .jcw-loading {
        display: flex;
        gap: 4px;
        padding: 10px 14px;
      }

      .jcw-loading-dot {
        width: 8px;
        height: 8px;
        background: #a3a09a;
        border-radius: 50%;
        animation: jcwBounce 1.4s infinite ease-in-out both;
      }

      .jcw-loading-dot:nth-child(1) { animation-delay: -0.32s; }
      .jcw-loading-dot:nth-child(2) { animation-delay: -0.16s; }

      @keyframes jcwBounce {
        0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
        40% { transform: scale(1); opacity: 1; }
      }

      /* Error Message */
      .jcw-error {
        background: rgba(239, 68, 68, 0.12);
        border: 1px solid rgba(239, 68, 68, 0.35);
        color: #fca5a5;
        padding: 8px 12px;
        border-radius: 8px;
        font-size: 12px;
        margin: 8px 16px;
        display: none;
      }

      .jcw-error.jcw-visible {
        display: block;
      }

      /* Mobile Responsive */
      @media (max-width: 480px) {
        .jcw-widget {
          bottom: 16px;
          right: 16px;
        }

        .jcw-button {
          padding: 10px 16px;
          font-size: 14px;
        }

        .jcw-window {
          position: fixed;
          bottom: 0;
          right: 0;
          left: 0;
          width: 100%;
          height: 85vh;
          max-height: 600px;
          border-radius: 16px 16px 0 0;
          border-bottom: none;
        }

        .jcw-window.jcw-expanded {
          transform: translateY(0) scale(1);
        }
      }
    `;

    const styleEl = document.createElement('style');
    styleEl.textContent = styles;
    document.head.appendChild(styleEl);
  }

  // Create widget HTML
  function createWidget() {
    const widget = document.createElement('div');
    widget.className = 'jcw-widget';
    widget.innerHTML = `
      <button class="jcw-button" id="jcwToggleBtn">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
        </svg>
        jacob.ai
      </button>

      <div class="jcw-window" id="jcwWindow">
        <div class="jcw-header">
          <h3 class="jcw-header-title">jacob.ai</h3>
          <div class="jcw-header-actions">
            <button class="jcw-header-btn" id="jcwClearBtn" title="Clear chat">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              </svg>
            </button>
            <button class="jcw-header-btn" id="jcwMinimizeBtn" title="Minimize">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
            </button>
          </div>
        </div>

        <div class="jcw-messages" id="jcwMessages">
          <div class="jcw-empty" id="jcwEmpty">
            <p>Ask me anything about Jacob's<br>work, interests, or philosophy.</p>
          </div>
        </div>

        <div class="jcw-suggestions" id="jcwSuggestions">
          <button class="jcw-suggestion-btn" data-question="What has Jacob built?">What have you built?</button>
          <button class="jcw-suggestion-btn" data-question="What is StepAhead?">StepAhead?</button>
          <button class="jcw-suggestion-btn" data-question="How is Jacob using AI?">Using AI?</button>
        </div>

        <div class="jcw-error" id="jcwError">Something went wrong. Please try again.</div>

        <div class="jcw-input-area">
          <input
            type="text"
            class="jcw-input"
            id="jcwInput"
            placeholder="Ask me anything..."
            autocomplete="off"
          >
          <button class="jcw-send-btn" id="jcwSendBtn">Send</button>
        </div>
      </div>
    `;

    document.body.appendChild(widget);
    return widget;
  }

  // Escape HTML
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML.replace(/\n/g, '<br>');
  }

  // Render messages
  function renderMessages() {
    const messagesEl = document.getElementById('jcwMessages');
    const emptyEl = document.getElementById('jcwEmpty');
    const suggestionsEl = document.getElementById('jcwSuggestions');

    // Clear existing messages (except empty state and loading)
    const existingMessages = messagesEl.querySelectorAll('.jcw-message:not(#jcwLoading)');
    existingMessages.forEach(el => el.remove());

    if (messages.length === 0) {
      emptyEl.style.display = 'flex';
      suggestionsEl.classList.remove('jcw-hidden');
      return;
    }

    emptyEl.style.display = 'none';
    suggestionsEl.classList.add('jcw-hidden');

    messages.forEach(msg => {
      const messageEl = document.createElement('div');
      messageEl.className = `jcw-message jcw-${msg.role === 'user' ? 'user' : 'assistant'}`;

      const label = msg.role === 'user' ? 'You' : 'jacob.ai';

      messageEl.innerHTML = `
        <div class="jcw-message-label">${label}</div>
        <div class="jcw-message-content">${escapeHtml(msg.content)}</div>
      `;

      messagesEl.appendChild(messageEl);
    });

    // scrollToBottom(); // Disabled: let user control scroll position
  }

  // Scroll to bottom
  function scrollToBottom() {
    const messagesEl = document.getElementById('jcwMessages');
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // Scroll to position user's last message at the top of the chat window
  function scrollToUserMessage() {
    const messagesEl = document.getElementById('jcwMessages');
    const userMessages = messagesEl.querySelectorAll('.jcw-message.jcw-user');
    if (userMessages.length > 0) {
      const lastUserMessage = userMessages[userMessages.length - 1];
      lastUserMessage.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  // Update UI state
  function updateUI() {
    const input = document.getElementById('jcwInput');
    const sendBtn = document.getElementById('jcwSendBtn');
    const suggestionBtns = document.querySelectorAll('.jcw-suggestion-btn');

    input.disabled = isLoading;
    sendBtn.disabled = isLoading;

    suggestionBtns.forEach(btn => {
      btn.disabled = isLoading;
    });
  }

  // Send message
  async function sendMessage(content) {
    if (isLoading || !content.trim()) return;

    const messagesEl = document.getElementById('jcwMessages');
    const errorEl = document.getElementById('jcwError');

    // Hide error
    errorEl.classList.remove('jcw-visible');

    // Add user message
    messages.push({ role: 'user', content: content.trim() });
    saveMessages();
    renderMessages();
    scrollToBottom(); // Scroll to show user's message

    // Clear input
    document.getElementById('jcwInput').value = '';

    // Set loading state
    isLoading = true;
    updateUI();

    // Show loading indicator
    const loadingEl = document.createElement('div');
    loadingEl.className = 'jcw-message jcw-assistant';
    loadingEl.id = 'jcwLoading';
    loadingEl.innerHTML = `
      <div class="jcw-message-label">jacob.ai is typing</div>
      <div class="jcw-loading">
        <div class="jcw-loading-dot"></div>
        <div class="jcw-loading-dot"></div>
        <div class="jcw-loading-dot"></div>
      </div>
    `;
    messagesEl.appendChild(loadingEl);
    // scrollToBottom(); // Disabled: let user control scroll position

    try {
      const response = await fetch(WORKER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages })
      });

      if (!response.ok) {
        throw new Error('Failed to get response');
      }

      const data = await response.json();

      // Remove loading indicator
      document.getElementById('jcwLoading')?.remove();

      // Add assistant message
      messages.push({ role: 'assistant', content: data.message });
      saveMessages();
      renderMessages();
      scrollToUserMessage(); // Scroll so user's message is at top

    } catch (error) {
      console.error('Chat error:', error);
      document.getElementById('jcwLoading')?.remove();

      // Remove the user message that failed
      messages.pop();
      saveMessages();

      errorEl.classList.add('jcw-visible');
      renderMessages();
    }

    isLoading = false;
    updateUI();
  }

  // Toggle expand/collapse
  function toggleWidget() {
    const window = document.getElementById('jcwWindow');
    const button = document.getElementById('jcwToggleBtn');

    isExpanded = !isExpanded;

    if (isExpanded) {
      window.classList.add('jcw-expanded');
      button.classList.add('jcw-hidden');
      document.getElementById('jcwInput').focus();
    } else {
      window.classList.remove('jcw-expanded');
      button.classList.remove('jcw-hidden');
    }
  }

  // Clear chat
  function clearChat() {
    messages = [];
    saveMessages();
    renderMessages();
    document.getElementById('jcwError').classList.remove('jcw-visible');
  }

  // Initialize
  function init() {
    // Don't show widget on the dedicated chat page
    if (window.location.pathname.includes('chat.html')) {
      return;
    }

    // Load Google Fonts if not already loaded
    if (!document.querySelector('link[href*="fonts.googleapis.com"]')) {
      const fontLink = document.createElement('link');
      fontLink.rel = 'stylesheet';
      fontLink.href = 'https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;1,9..144,400&family=DM+Sans:ital,wght@0,400;0,500;1,400&display=swap';
      document.head.appendChild(fontLink);
    }

    injectStyles();
    createWidget();
    loadMessages();
    renderMessages();

    // Event listeners
    document.getElementById('jcwToggleBtn').addEventListener('click', toggleWidget);
    document.getElementById('jcwMinimizeBtn').addEventListener('click', toggleWidget);
    document.getElementById('jcwClearBtn').addEventListener('click', clearChat);

    document.getElementById('jcwSendBtn').addEventListener('click', () => {
      sendMessage(document.getElementById('jcwInput').value);
    });

    document.getElementById('jcwInput').addEventListener('keypress', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage(document.getElementById('jcwInput').value);
      }
    });

    document.getElementById('jcwSuggestions').addEventListener('click', (e) => {
      if (e.target.classList.contains('jcw-suggestion-btn')) {
        const question = e.target.dataset.question;
        sendMessage(question);
      }
    });
  }

  // Run when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
