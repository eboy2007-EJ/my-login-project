const registerBox = document.getElementById('register-box');
const loginBox = document.getElementById('login-box');
const dashboardBox = document.getElementById('dashboard-box');
const forgotBox = document.getElementById('forgot-box');
const confirmCodeBox = document.getElementById('confirm-code-box');
const resetBox = document.getElementById('reset-box');
const mainContainer = document.querySelector('.container');
let passwordResetEmail = '';
let passwordResetCode = '';
let currentAccountEmail = '';

if (window.location.href.endsWith('/?') || window.location.href.endsWith('?')) {
  const cleanPath = window.location.pathname === '/' ? '' : window.location.pathname.replace(/\/+$/, '');
  const cleanUrl = `${window.location.origin}${cleanPath}`;
  if (window.location.href !== cleanUrl) {
    window.history.replaceState({}, document.title, cleanUrl);
  }
}

// Helper to hide ALL boxes
function hideAll() {
  mainContainer.classList.remove('dashboard-active');
  registerBox.classList.add('hidden');
  loginBox.classList.add('hidden');
  dashboardBox.classList.add('hidden');
  if (forgotBox) forgotBox.classList.add('hidden');
  if (confirmCodeBox) confirmCodeBox.classList.add('hidden');
  if (resetBox) resetBox.classList.add('hidden');
}

function showDashboard(email) {
  hideAll();
  mainContainer.classList.add('dashboard-active');
  dashboardBox.classList.remove('hidden');
  currentAccountEmail = email;
  document.getElementById('account-email-display').textContent = email;
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

dashboardBox.addEventListener('click', (event) => {
  const tab = event.target.closest('[data-panel]');
  if (tab) {
    activateDashboardPanel(tab.dataset.panel);
    if (tab.dataset.details) {
      const details = Array.from(document.querySelectorAll(`#${tab.dataset.panel} details`))
        .find((item) => item.querySelector('summary').textContent.trim() === tab.dataset.details);
      if (details) details.open = true;
    }
  }
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

const backToLoginFromConfirm = document.getElementById('back-to-login-from-confirm');
if (backToLoginFromConfirm) backToLoginFromConfirm.addEventListener('click', (e) => {
  e.preventDefault();
  hideAll();
  loginBox.classList.remove('hidden');
});

const backToLoginFromReset = document.getElementById('back-to-login-from-reset');
if (backToLoginFromReset) backToLoginFromReset.addEventListener('click', (e) => {
  e.preventDefault();
  hideAll();
  loginBox.classList.remove('hidden');
});

document.getElementById('logout-btn').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;

  try {
    const response = await fetch('/logout', { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to sign out.');

    hideAll();
    loginBox.classList.remove('hidden');
  } catch (error) {
    console.error('Sign-out failed:', error);
    alert(error.message || 'Failed to connect to the server.');
  } finally {
    button.disabled = false;
  }
});

async function signOutForDashboardAction() {
  const response = await fetch('/logout', { method: 'POST' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Unable to sign out.');
}

function showForgotPassword() {
  document.getElementById('forgot-email').value = currentAccountEmail;
  hideAll();
  forgotBox.classList.remove('hidden');
}

dashboardBox.addEventListener('click', async (event) => {
  const feature = event.target.closest('[data-dashboard-action]');
  if (!feature) return;

  try {
    if (feature.dataset.dashboardAction === 'register') {
      await signOutForDashboardAction();
      hideAll();
      registerBox.classList.remove('hidden');
    } else if (feature.dataset.dashboardAction === 'password-reset') {
      await signOutForDashboardAction();
      showForgotPassword();
    } else if (feature.dataset.dashboardAction === 'recovery-codes') {
      activateDashboardPanel('info-panel');
      const recoveryDetails = Array.from(document.querySelectorAll('#info-panel details'))
        .find((details) => details.querySelector('summary').textContent.trim() === 'Password and security');
      if (recoveryDetails) recoveryDetails.open = true;
    }
  } catch (error) {
    console.error('Dashboard action failed:', error);
    alert(error.message || 'Failed to connect to the server.');
  }
});

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
  const confirmCodeStatus = document.getElementById('confirm-code-status');
  const confirmCodeButton = document.getElementById('confirm-code-button');
  const revealConfirmation = () => {
    hideAll();
    confirmCodeBox.classList.remove('hidden');
  };
  passwordResetEmail = email;
  passwordResetCode = '';
  confirmCodeStatus.textContent = 'Requesting your code...';
  confirmCodeButton.disabled = true;
  submitButton.disabled = true;
  const revealTimer = window.setTimeout(revealConfirmation, 2000);

  try {
    const response = await fetch('/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to request a reset code.');

    confirmCodeStatus.textContent = 'If an account exists for that email, a code has been sent.';
    confirmCodeButton.disabled = false;
    revealConfirmation();
  } catch (error) {
    window.clearTimeout(revealTimer);
    hideAll();
    forgotBox.classList.remove('hidden');
    console.error('Password reset request failed:', error);
    alert(error.message || 'Failed to connect to the server.');
  } finally {
    window.clearTimeout(revealTimer);
    submitButton.disabled = false;
  }
});

document.getElementById('confirm-code-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = document.getElementById('confirm-code').value.trim();
  const submitButton = document.getElementById('confirm-code-button');
  submitButton.disabled = true;

  try {
    const response = await fetch('/verify-reset-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: passwordResetEmail, code })
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(response.status === 400 ? 'Code incorrect.' : data.error || 'Unable to verify the code.');
    }

    passwordResetCode = code;
    hideAll();
    resetBox.classList.remove('hidden');
  } catch (error) {
    console.error('Reset code verification failed:', error);
    alert(error.message || 'Failed to connect to the server.');
  } finally {
    submitButton.disabled = false;
  }
});

document.getElementById('reset-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const newPassword = document.getElementById('new-password').value;
  const submitButton = e.currentTarget.querySelector('button[type="submit"]');
  submitButton.disabled = true;

  try {
    const response = await fetch('/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: passwordResetEmail, code: passwordResetCode, newPassword })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to reset the password.');

    hideAll();
    loginBox.classList.remove('hidden');
    document.getElementById('login-email').value = passwordResetEmail;
    document.getElementById('login-password').value = '';
    document.getElementById('confirm-code').value = '';
    document.getElementById('new-password').value = '';
    passwordResetEmail = '';
    passwordResetCode = '';
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
      showDashboard(data.email);
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
      showDashboard(data.email);
    } else {
      alert("Error: " + data.error);
    }
  } catch (error) {
    console.error("Fetch error:", error);
    alert("Failed to connect to the server. Is server.js running?");
  }
});

async function restoreDashboardSession() {
  try {
    const response = await fetch('/me');
    if (response.status === 401) return;
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to restore your sign-in.');

    showDashboard(data.email);
  } catch (error) {
    console.error('Could not restore sign-in:', error);
  }
}

restoreDashboardSession();