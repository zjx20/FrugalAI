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
          const notesText = key.notes ? ` - Notes: ${key.notes}` : '';
          li.textContent = `Provider: ${key.providerName}, Key ID: ${key.id}${notesText}`;
          const deleteButton = document.createElement('button');
          deleteButton.textContent = 'Delete';
          deleteButton.onclick = () => deleteApiKey(key.id);
          li.appendChild(deleteButton);
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
    const response = await fetch(`/api/user/keys/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${apiToken}` },
    });
    if (response.status === 204) {
      loadApiKeys();
    } else {
      alert('Failed to delete API key.');
    }
  }
});
