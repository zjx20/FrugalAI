document.addEventListener('DOMContentLoaded', () => {
  const authSection = document.getElementById('auth-section');
  const loginView = document.getElementById('login-view');
  const registrationView = document.getElementById('registration-view');
  const tokenSection = document.getElementById('token-section');
  const apiKeyManagementSection = document.getElementById('api-key-management-section');

  const loginTokenInput = document.getElementById('login-token-input');
  const loginButton = document.getElementById('login-button');
  const showRegisterLink = document.getElementById('show-register-link');
  const showLoginLink = document.getElementById('show-login-link');

  const registerNameInput = document.getElementById('register-name');
  const registerButton = document.getElementById('register-button');

  const apiTokenDisplay = document.getElementById('api-token-display');
  const manageKeysButton = document.getElementById('manage-keys-button');

  const apiKeysList = document.getElementById('api-keys-list');
  const noKeysMessage = document.getElementById('no-keys-message');
  const providerSelect = document.getElementById('provider-select');
  const keyDataInput = document.getElementById('key-data-input');
  const keyNotesInput = document.getElementById('key-notes-input');
  const createKeyButton = document.getElementById('create-key-button');
  const logoutButton = document.getElementById('logout-button');

  const accessTokensList = document.getElementById('access-tokens-list');
  const noAccessTokensMessage = document.getElementById('no-access-tokens-message');
  const accessTokenNameInput = document.getElementById('access-token-name-input');
  const createAccessTokenButton = document.getElementById('create-access-token-button');

  const editModal = document.getElementById('edit-key-modal');
  const editKeyIdInput = document.getElementById('edit-key-id');
  const editKeyProvider = document.getElementById('edit-key-provider');
  const editKeyDataInput = document.getElementById('edit-key-data-input');
  const editKeyNotesInput = document.getElementById('edit-key-notes-input');
  const saveKeyButton = document.getElementById('save-key-button');
  const closeModalButton = editModal.querySelector('.close-button');

  let apiToken = localStorage.getItem('apiToken');

  if (apiToken) {
    authSection.classList.add('hidden');
    showApiKeyManagement();
  }

  showRegisterLink.addEventListener('click', (e) => {
    e.preventDefault();
    loginView.classList.add('hidden');
    registrationView.classList.remove('hidden');
  });

  showLoginLink.addEventListener('click', (e) => {
    e.preventDefault();
    registrationView.classList.add('hidden');
    loginView.classList.remove('hidden');
  });

  loginButton.addEventListener('click', async () => {
    const token = loginTokenInput.value.trim();
    if (!token) {
      alert('Please enter a valid API Token.');
      return;
    }

    const response = await fetch('/api/user/keys', {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (response.ok) {
      apiToken = token;
      localStorage.setItem('apiToken', token);
      authSection.classList.add('hidden');
      showApiKeyManagement();
    } else if (response.status === 401) {
      alert('Login failed: Invalid token.');
    } else {
      alert('An error occurred during login.');
    }
  });

  logoutButton.addEventListener('click', () => {
    apiToken = null;
    localStorage.removeItem('apiToken');
    location.reload();
  });

  registerButton.addEventListener('click', async () => {
    const name = registerNameInput.value;
    const response = await fetch('/api/user/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name || undefined }),
    });
    if (response.ok) {
      const { token } = await response.json();
      apiToken = token;
      localStorage.setItem('apiToken', token);
      apiTokenDisplay.textContent = token;
      authSection.classList.add('hidden');
      tokenSection.classList.remove('hidden');
    } else {
      alert('Registration failed.');
    }
  });

  manageKeysButton.addEventListener('click', () => {
    tokenSection.classList.add('hidden');
    showApiKeyManagement();
  });

  async function showApiKeyManagement() {
    apiKeyManagementSection.classList.remove('hidden');
    loadProviders();
    loadApiKeys();
    loadAccessTokens();
    loadModelAliases();
  }

  async function loadProviders() {
    const response = await fetch('/api/providers');
    if (response.ok) {
      const providers = await response.json();
      providerSelect.innerHTML = providers.map(p => `<option value="${p}">${p}</option>`).join('');
    } else {
      console.error('Failed to load providers');
    }
  }

  function getStatusIndicator(key) {
    const now = Date.now();
    let statusHtml = '<span title="Healthy">🟢</span>'; // Default to healthy

    if (key.permanentlyFailed) {
      return '<span title="This key is permanently disabled due to repeated critical failures.">🔴 Permanently Failed</span>';
    }

    // Check if the key is paused first
    if (key.paused) {
      return '<span title="This key has been manually paused and is temporarily disabled.">⏸️ Paused</span>';
    }

    // Throttle data can be complex, so we need to check the relevant part (global or model-specific)
    // For simplicity in this UI, we'll just check if any throttleData exists and is active.
    // A more advanced UI could inspect the specific model being used.
    if (key.throttleData && typeof key.throttleData === 'object') {
      // Find the most relevant throttle status to display
      const relevantThrottle = Object.values(key.throttleData).find(t => t.expiration > now || t.consecutiveFailures > 0);

      if (relevantThrottle) {
        if (relevantThrottle.expiration > now) {
          const expirationDate = new Date(relevantThrottle.expiration).toLocaleTimeString();
          statusHtml = `<span title="This key is temporarily throttled. It will be available again after ${expirationDate}.">🟡 Throttled</span>`;
        } else if (relevantThrottle.consecutiveFailures > 0) {
          statusHtml = `<span title="This key has failed ${relevantThrottle.consecutiveFailures} consecutive times. It will be throttled if it continues to fail.">🟠 Failing</span>`;
        }
      }
    }
    return statusHtml;
  }

  // Helper: collect all lastError strings from throttleData buckets (including active and inactive)
  // Note: "_global_" is a special bucket meaning the whole key is throttled/errored.
  function getLastErrors(key) {
    if (!key || !key.throttleData || typeof key.throttleData !== 'object') return [];
    const entries = Object.entries(key.throttleData)
      .filter(([bucket, v]) => v && typeof v === 'object' && 'expiration' in v && 'consecutiveFailures' in v);

    const errors = [];
    for (const [bucket, v] of entries) {
      const err = v.lastError;
      if (typeof err === 'string' && err.trim()) {
        errors.push({ bucket, error: err });
      }
    }
    return errors;
  }

  // Collect buckets with consecutive failures (>0), shown inline like last errors (no hover tips)
  // Note: "_global_" is a special bucket meaning the whole key is throttled/errored.
  function getFailingBuckets(key) {
    if (!key || !key.throttleData || typeof key.throttleData !== 'object') return [];
    const entries = Object.entries(key.throttleData)
      .filter(([bucket, v]) => v && typeof v === 'object' && 'expiration' in v && 'consecutiveFailures' in v);

    const failing = [];
    for (const [bucket, v] of entries) {
      const count = Number(v.consecutiveFailures || 0);
      if (count > 0) {
        failing.push({ bucket, count });
      }
    }
    return failing;
  }

  // Simple HTML escape to avoid injecting raw error strings into DOM
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&')
      .replace(/</g, '<')
      .replace(/>/g, '>')
      .replace(/"/g, '"')
      .replace(/'/g, '&#39;');
  }

  async function loadApiKeys() {
    if (!apiToken) return;
    const response = await fetch('/api/user/keys', {
      headers: { 'Authorization': `Bearer ${apiToken}` },
    });
    if (response.ok) {
      const keys = await response.json();
      apiKeysList.innerHTML = '';
      if (keys.length === 0) {
        noKeysMessage.classList.remove('hidden');
      } else {
        noKeysMessage.classList.add('hidden');
        keys.forEach(key => {
          const li = document.createElement('li');
          const statusIndicator = getStatusIndicator(key);
          const notesText = key.notes ? ` - <i>${key.notes}</i>` : '';

          const keyInfo = document.createElement('span');
          const lastErrors = getLastErrors(key);
          const lastErrorsHtml = lastErrors.length
            ? `<div style="margin-top:4px">${lastErrors.map(e => {
                const label = e.bucket === '_global_' ? 'Global' : escapeHtml(e.bucket);
                const title = e.bucket === '_global_' ? 'Global (key-level) throttling/error' : 'Model-specific throttling/error';
                return `<small style="color:#d32f2f" title="${title}">[${label}] ${escapeHtml(e.error)}</small>`;
              }).join('<br>')}</div>`
            : '';
          const failingBuckets = getFailingBuckets(key);
          const failingHtml = failingBuckets.length
            ? `<div style="margin-top:2px">${failingBuckets.map(e => {
                const label = e.bucket === '_global_' ? 'Global' : escapeHtml(e.bucket);
                const title = e.bucket === '_global_' ? 'Global (key-level) consecutive failures' : 'Model-specific consecutive failures';
                const suffix = e.count > 1 ? 's' : '';
                return `<small style="color:#ff9800" title="${title}">[${label}] Failing ${e.count} consecutive time${suffix}</small>`;
              }).join('<br>')}</div>`
            : '';
          keyInfo.innerHTML = `${statusIndicator} <b>${key.providerName}</b> (ID: ${key.id})${notesText}${lastErrorsHtml}${failingHtml}`;

          const buttonGroup = document.createElement('div');

          const editButton = document.createElement('button');
          editButton.textContent = 'Edit';
          editButton.onclick = () => openEditModal(key);

          const resetButton = document.createElement('button');
          resetButton.textContent = 'Reset';
          resetButton.title = 'Reset throttling and error status';
          resetButton.onclick = () => resetApiKey(key.id);
          // Only show reset button if the key has issues
          if (key.permanentlyFailed || (key.throttleData && typeof key.throttleData === 'object' && Object.keys(key.throttleData).length > 0)) {
            resetButton.style.backgroundColor = '#ff9800';
            resetButton.style.color = 'white';
          } else {
            resetButton.style.backgroundColor = '#f0f0f0';
            resetButton.style.color = '#999';
            resetButton.disabled = true;
            resetButton.title = 'No issues to reset';
          }

          const pauseButton = document.createElement('button');
          const isPaused = key.paused;
          if (isPaused) {
            pauseButton.textContent = 'Resume';
            pauseButton.title = 'Resume this paused API key';
            pauseButton.style.backgroundColor = '#4caf50';
            pauseButton.style.color = 'white';
            pauseButton.onclick = () => resumeApiKey(key.id);
          } else {
            pauseButton.textContent = 'Pause';
            pauseButton.title = 'Temporarily pause this API key';
            pauseButton.style.backgroundColor = '#2196f3';
            pauseButton.style.color = 'white';
            pauseButton.onclick = () => pauseApiKey(key.id);
          }

          const deleteButton = document.createElement('button');
          deleteButton.textContent = 'Delete';
          deleteButton.onclick = () => deleteApiKey(key.id);

          buttonGroup.appendChild(editButton);
          buttonGroup.appendChild(resetButton);
          buttonGroup.appendChild(pauseButton);
          buttonGroup.appendChild(deleteButton);

          li.appendChild(keyInfo);
          li.appendChild(buttonGroup);
          apiKeysList.appendChild(li);
        });
      }
    }
  }

  createKeyButton.addEventListener('click', async () => {
    const providerName = providerSelect.value;
    const keyData = { key: keyDataInput.value };
    const notes = keyNotesInput.value;
    const response = await fetch('/api/user/keys', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiToken}`,
      },
      body: JSON.stringify({ providerName, keyData, notes: notes || undefined }),
    });
    if (response.status === 201) {
      keyDataInput.value = '';
      keyNotesInput.value = '';
      loadApiKeys();
    } else {
      alert('Failed to create API key.');
    }
  });

  async function deleteApiKey(id) {
    if (!confirm('Are you sure you want to delete this API key?')) return;
    const response = await fetch(`/api/user/key`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiToken}`
      },
      body: JSON.stringify({ id }),
    });
    if (response.status === 204) {
      loadApiKeys();
    } else {
      alert('Failed to delete API key.');
    }
  }

  function openEditModal(key) {
    editKeyIdInput.value = key.id;
    editKeyProvider.textContent = key.providerName;
    editKeyDataInput.value = (key.keyData && key.keyData.key) ? key.keyData.key : '';
    editKeyNotesInput.value = key.notes || '';
    editModal.classList.remove('hidden');
  }

  function closeEditModal() {
    editModal.classList.add('hidden');
  }

  closeModalButton.addEventListener('click', closeEditModal);
  window.addEventListener('click', (event) => {
    if (event.target == editModal) {
      closeEditModal();
    }
  });

  saveKeyButton.addEventListener('click', async () => {
    const id = parseInt(editKeyIdInput.value, 10);
    const keyData = { key: editKeyDataInput.value };
    const notes = editKeyNotesInput.value;

    const response = await fetch(`/api/user/key`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiToken}`,
      },
      body: JSON.stringify({ id, keyData, notes: notes || undefined }),
    });

    if (response.ok) {
      closeEditModal();
      loadApiKeys();
    } else {
      alert('Failed to update API key.');
    }
  });

  async function resetApiKey(id) {
    if (!confirm('Are you sure you want to reset the throttling and error status for this API key? This will clear all failure counts and throttling restrictions.')) {
      return;
    }

    const response = await fetch(`/api/user/key/reset`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiToken}`,
      },
      body: JSON.stringify({ id }),
    });

    if (response.ok) {
      alert('API key status has been reset successfully.');
      loadApiKeys();
    } else {
      const errorText = await response.text();
      alert(`Failed to reset API key: ${errorText}`);
    }
  }

  async function pauseApiKey(id) {
    if (!confirm('Are you sure you want to pause this API key? It will be temporarily disabled until you resume it.')) {
      return;
    }

    const response = await fetch(`/api/user/key/pause`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiToken}`,
      },
      body: JSON.stringify({ id }),
    });

    if (response.ok) {
      alert('API key has been paused successfully.');
      loadApiKeys();
    } else {
      const errorText = await response.text();
      alert(`Failed to pause API key: ${errorText}`);
    }
  }

  async function resumeApiKey(id) {
    if (!confirm('Are you sure you want to resume this API key?')) {
      return;
    }

    const response = await fetch(`/api/user/key/unpause`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiToken}`,
      },
      body: JSON.stringify({ id }),
    });

    if (response.ok) {
      alert('API key has been resumed successfully.');
      loadApiKeys();
    } else {
      const errorText = await response.text();
      alert(`Failed to resume API key: ${errorText}`);
    }
  }

  // Access Token management functions
  async function loadAccessTokens() {
    if (!apiToken) return;
    const response = await fetch('/api/user/access-tokens', {
      headers: { 'Authorization': `Bearer ${apiToken}` },
    });
    if (response.ok) {
      const tokens = await response.json();
      accessTokensList.innerHTML = '';
      if (tokens.length === 0) {
        noAccessTokensMessage.classList.remove('hidden');
      } else {
        noAccessTokensMessage.classList.add('hidden');
        tokens.forEach(token => {
          const li = document.createElement('li');

          const tokenInfo = document.createElement('span');
          const nameText = token.name ? ` - <i>${token.name}</i>` : '';
          const createdDate = new Date(token.createdAt).toLocaleDateString();
          tokenInfo.innerHTML = `🔑 <b>${token.token}</b>${nameText} <small>(Created: ${createdDate})</small>`;

          const buttonGroup = document.createElement('div');

          const copyButton = document.createElement('button');
          copyButton.textContent = 'Copy';
          copyButton.onclick = () => {
            navigator.clipboard.writeText(token.token).then(() => {
              alert('Token copied to clipboard!');
            }).catch(() => {
              // Fallback for older browsers
              const textArea = document.createElement('textarea');
              textArea.value = token.token;
              document.body.appendChild(textArea);
              textArea.select();
              document.execCommand('copy');
              document.body.removeChild(textArea);
              alert('Token copied to clipboard!');
            });
          };

          const revokeButton = document.createElement('button');
          revokeButton.textContent = 'Revoke';
          revokeButton.style.backgroundColor = '#f44336';
          revokeButton.style.color = 'white';
          revokeButton.onclick = () => revokeAccessToken(token.id);

          buttonGroup.appendChild(copyButton);
          buttonGroup.appendChild(revokeButton);

          li.appendChild(tokenInfo);
          li.appendChild(buttonGroup);
          accessTokensList.appendChild(li);
        });
      }
    }
  }

  async function revokeAccessToken(id) {
    if (!confirm('Are you sure you want to revoke this access token? This action cannot be undone and any applications using this token will stop working.')) return;
    const response = await fetch(`/api/user/access-token`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiToken}`
      },
      body: JSON.stringify({ id }),
    });
    if (response.status === 204) {
      loadAccessTokens();
    } else {
      alert('Failed to revoke access token.');
    }
  }

  createAccessTokenButton.addEventListener('click', async () => {
    const name = accessTokenNameInput.value.trim();
    const response = await fetch('/api/user/access-tokens', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiToken}`,
      },
      body: JSON.stringify({ name: name || undefined }),
    });
    if (response.status === 201) {
      accessTokenNameInput.value = '';
      loadAccessTokens();
      alert('Access token created successfully! Make sure to copy it now as you won\'t be able to see it again.');
    } else {
      alert('Failed to create access token.');
    }
  });

  // Model Alias management
  const modelAliasesList = document.getElementById('model-aliases-list');
  const noAliasesMessage = document.getElementById('no-aliases-message');
  const aliasNameInput = document.getElementById('alias-name-input');
  const aliasModelsInput = document.getElementById('alias-models-input');
  const createAliasButton = document.getElementById('create-alias-button');

  async function loadModelAliases() {
    if (!apiToken) return;
    const response = await fetch('/api/user/model-aliases', {
      headers: { 'Authorization': `Bearer ${apiToken}` },
    });
    if (response.ok) {
      const aliases = await response.json();
      modelAliasesList.innerHTML = '';
      const aliasEntries = Object.entries(aliases);
      if (aliasEntries.length === 0) {
        noAliasesMessage.classList.remove('hidden');
      } else {
        noAliasesMessage.classList.add('hidden');
        aliasEntries.forEach(([alias, models]) => {
          const li = document.createElement('li');

          const aliasInfo = document.createElement('span');
          aliasInfo.innerHTML = `🏷️ <b>${alias}</b> → <code>${models}</code>`;

          const buttonGroup = document.createElement('div');

          const deleteButton = document.createElement('button');
          deleteButton.textContent = 'Delete';
          deleteButton.style.backgroundColor = '#f44336';
          deleteButton.style.color = 'white';
          deleteButton.onclick = () => deleteModelAlias(alias);

          buttonGroup.appendChild(deleteButton);

          li.appendChild(aliasInfo);
          li.appendChild(buttonGroup);
          modelAliasesList.appendChild(li);
        });
      }
    }
  }

  createAliasButton.addEventListener('click', async () => {
    const alias = aliasNameInput.value.trim();
    const models = aliasModelsInput.value.trim();

    if (!alias || !models) {
      alert('Please enter both alias name and target models.');
      return;
    }

    const response = await fetch('/api/user/model-aliases', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiToken}`,
      },
      body: JSON.stringify({ alias, models }),
    });

    if (response.ok) {
      aliasNameInput.value = '';
      aliasModelsInput.value = '';
      loadModelAliases();
      alert('Model alias created successfully!');
    } else {
      const error = await response.json();
      alert(`Failed to create model alias: ${error.error || 'Unknown error'}`);
    }
  });

  async function deleteModelAlias(alias) {
    if (!confirm(`Are you sure you want to delete the alias "${alias}"?`)) return;

    const response = await fetch('/api/user/model-aliases', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiToken}`,
      },
      body: JSON.stringify({ alias }),
    });

    if (response.status === 200) {
      loadModelAliases();
      alert('Model alias deleted successfully.');
    } else {
      alert('Failed to delete model alias.');
    }
  }
});
