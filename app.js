const registerBox = document.getElementById('register-box');
const loginBox = document.getElementById('login-box');
const dashboardBox = document.getElementById('dashboard-box');
const forgotBox = document.getElementById('forgot-box');
const resetBox = document.getElementById('reset-box');
const welcomeMessage = document.getElementById('welcome-message');

// Helper to hide ALL boxes
function hideAll() {
  registerBox.classList.add('hidden');
  loginBox.classList.add('hidden');
  dashboardBox.classList.add('hidden');
  if (forgotBox) forgotBox.classList.add('hidden');
  if (resetBox) resetBox.classList.add('hidden');
}

// Navigation Links
document.getElementById('show-login').addEventListener('click', (e) => { e.preventDefault(); hideAll(); loginBox.classList.remove('hidden'); });
document.getElementById('show-register').addEventListener('click', (e) => { e.preventDefault(); hideAll(); registerBox.classList.remove('hidden'); });

const showForgot = document.getElementById('show-forgot');
if (showForgot) showForgot.addEventListener('click', (e) => { e.preventDefault(); hideAll(); forgotBox.classList.remove('hidden'); });

const backToLogin = document.getElementById('back-to-login');
if (backToLogin) backToLogin.addEventListener('click', (e) => { e.preventDefault(); hideAll(); loginBox.classList.remove('hidden'); });

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
      hideAll(); 
      dashboardBox.classList.remove('hidden'); 
      welcomeMessage.innerText = `You have successfully registered as ${email}.`;
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
      hideAll(); 
      dashboardBox.classList.remove('hidden'); 
      welcomeMessage.innerText = `Welcome back, ${email}!`;
    } else {
      alert("Error: " + data.error);
    }
  } catch (error) {
    console.error("Fetch error:", error);
    alert("Failed to connect to the server. Is server.js running?");
  }
});