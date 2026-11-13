const registerBox = document.getElementById('register-box');
const loginBox = document.getElementById('login-box');
const dashboardBox = document.getElementById('dashboard-box');
const forgotBox = document.getElementById('forgot-box');
const resetBox = document.getElementById('reset-box');
const welcomeMessage = document.getElementById('welcome-message');
const mainContainer = document.querySelector('.container');
let passwordResetEmail = '';

// Helper to hide ALL boxes
function hideAll() {
  mainContainer.classList.remove('dashboard-active');
  registerBox.classList.add('hidden');
  loginBox.classList.add('hidden');
  dashboardBox.classList.add('hidden');
  if (forgotBox) forgotBox.classList.add('hidden');
  if (resetBox) resetBox.classList.add('hidden');
}

function showDashboard(message) {
  hideAll();
  mainContainer.classList.add('dashboard-active');
  dashboardBox.classList.remove('hidden');
  welcomeMessage.innerText = message;
  activateDashboardPanel('home-panel');
}

function activateDashboardPanel(panelId) {
  document.querySelectorAll('.dashboard-tabs .dashboard-tab').forEach((tab) => {
    const isActive = tab.dataset.panel === panelId;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-selected', String(isActive));
  });
  document.getElementById('privacy-tab').setAttribute('aria-pressed', String(panelId === 'privacy-panel'));
  document.querySelectorAll('.dashboard-panel').forEach((panel) => {
    panel.classList.toggle('hidden', panel.id !== panelId);
  });
}

document.querySelector('.dashboard-nav').addEventListener('click', (event) => {
  const tab = event.target.closest('[data-panel]');
  if (tab) activateDashboardPanel(tab.dataset.panel);
});

// Navigation Links
document.getElementById('show-login').addEventListener('click', (e) => { e.preventDefault(); hideAll(); loginBox.classList.remove('hidden'); });
document.getElementById('show-register').addEventListener('click', (e) => { e.preventDefault(); hideAll(); registerBox.classList.remove('hidden'); });

const showForgot = document.getElementById('show-forgot');
if (showForgot) showForgot.addEventListener('click', (e) => {
  e.preventDefault();
  document.getElementById('forgot-email').value = document.getElementById('login-email').value;
  hideAll();
  forgotBox.classList.remove('hidden');
});

const backToLogin = document.getElementById('back-to-login');
if (backToLogin) backToLogin.addEventListener('click', (e) => { e.preventDefault(); hideAll(); loginBox.classList.remove('hidden'); });

const backToLoginFromReset = document.getElementById('back-to-login-from-reset');
if (backToLoginFromReset) backToLoginFromReset.addEventListener('click', (e) => {
  e.preventDefault();
  hideAll();
  loginBox.classList.remove('hidden');
});

document.getElementById('logout-btn').addEventListener('click', () => { hideAll(); loginBox.classList.remove('hidden'); });

function setupPasswordVisibility(checkboxId, passwordInputId) {
  const checkbox = document.getElementById(checkboxId);
  const passwordInput = document.getElementById(passwordInputId);

  checkbox.addEventListener('change', () => {
    passwordInput.type = checkbox.checked ? 'text' : 'password';
  });
}

setupPasswordVisibility('show-reg-pass', 'reg-password');
setupPasswordVisibility('show-login-pass', 'login-password');

document.getElementById('forgot-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('forgot-email').value.trim();
  const submitButton = e.currentTarget.querySelector('button[type="submit"]');
  submitButton.disabled = true;

  try {
    const response = await fetch('/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to request a reset code.');

    passwordResetEmail = email;
    hideAll();
    resetBox.classList.remove('hidden');
  } catch (error) {
    console.error('Password reset request failed:', error);
    alert(error.message || 'Failed to connect to the server.');
  } finally {
    submitButton.disabled = false;
  }
});

document.getElementById('reset-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = document.getElementById('reset-code').value.trim();
  const newPassword = document.getElementById('new-password').value;
  const submitButton = e.currentTarget.querySelector('button[type="submit"]');
  submitButton.disabled = true;

  try {
    const response = await fetch('/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: passwordResetEmail, code, newPassword })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to reset the password.');

    hideAll();
    loginBox.classList.remove('hidden');
    document.getElementById('login-email').value = passwordResetEmail;
    document.getElementById('login-password').value = '';
    document.getElementById('reset-code').value = '';
    document.getElementById('new-password').value = '';
    alert(data.message);
  } catch (error) {
    console.error('Password reset failed:', error);
    alert(error.message || 'Failed to connect to the server.');
  } finally {
    submitButton.disabled = false;
  }
});

// Handle Registration
document.getElementById('register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('reg-email').value;
  const password = document.getElementById('reg-password').value;

  try {
    const response = await fetch('/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const data = await response.json();
    
    if (response.ok) {
      showDashboard(`You have successfully registered as ${email}.`);
    } else {
      alert("Error: " + data.error);
    }
  } catch (error) {
    console.error("Fetch error:", error);
    alert("Failed to connect to the server. Is server.js running?");
  }
});

// Handle Login
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;

  try {
    const response = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const data = await response.json();
    
    if (response.ok) {
      showDashboard(`Welcome back, ${email}!`);
    } else {
      alert("Error: " + data.error);
    }
  } catch (error) {
    console.error("Fetch error:", error);
    alert("Failed to connect to the server. Is server.js running?");
  }
});