/**
 * Authentication Logic incorporating Supabase
 */

document.addEventListener('DOMContentLoaded', async () => {

  // 1. Initialize Supabase
  if (!window.SUPABASE_URL || !window.SUPABASE_ANON_KEY || window.SUPABASE_URL.includes('YOUR_SUPABASE')) {
      console.error("Missing or dummy Supabase configuration in config.js");
      window.showToast?.('warning', 'Running in offline demo mode. Update config.js to connect Supabase.');
  }
  
  let supabase = null;
  try {
      if (window.supabase && window.SUPABASE_URL && !window.SUPABASE_URL.includes('YOUR_SUPABASE')) {
          supabase = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
      }
  } catch (e) {
      console.warn("Supabase init bypassed:", e);
  }

  // 2. View Management
  const views = {
      login: document.getElementById('login-view'),
      register: document.getElementById('register-view'),
      forgot: document.getElementById('forgot-view'),
      update: document.getElementById('update-view')
  };

  const showView = (viewName) => {
      Object.keys(views).forEach(k => {
          if (views[k]) {
              views[k].classList.add('hidden');
          }
      });
      if (views[viewName]) {
          views[viewName].classList.remove('hidden');
      }
      
      // Hide global error on view switch
      const ge = document.getElementById('global-error');
      if (ge) ge.classList.add('hidden');
  };

  // Setup view toggle listeners
  document.getElementById('goto-register')?.addEventListener('click', (e) => {
      e.preventDefault(); showView('register');
  });
  document.getElementById('goto-login')?.addEventListener('click', (e) => {
      e.preventDefault(); showView('login');
  });
  document.getElementById('forgot-link')?.addEventListener('click', (e) => {
      e.preventDefault(); showView('forgot');
  });
  document.querySelectorAll('.back-to-login').forEach(el => {
      el.addEventListener('click', (e) => { e.preventDefault(); showView('login'); });
  });

  // Check URL params for deep links
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('reset') === 'true') {
      showView('update');
  } else if (urlParams.get('register') === 'true') {
      showView('register');
  } else {
      showView('login'); // default
  }

  // Define loading overlay
  const loader = document.getElementById('full-page-loader');
  const authContainer = document.getElementById('auth-container');

  // 3. Auth Guard (Check Active Session)
  if (supabase) {
      try {
          const { data, error } = await supabase.auth.getSession();
          if (data?.session && !urlParams.get('reset')) {
              // Valid session exists, push to dashboard
              window.location.href = 'dashboard.html';
              return; // stop executing auth logic
          }
      } catch (err) {
          console.error("Session check error", err);
      }
  }
  
  // Reveal auth container
  if (loader) loader.classList.add('opacity-0', 'pointer-events-none');
  if (authContainer) authContainer.style.opacity = '1';

  // 4. Supabase Error Mapper
  const mapError = (originalMessage) => {
      const msg = originalMessage.toLowerCase();
      if (msg.includes('invalid login credentials')) return "Email or password is incorrect. Please try again.";
      if (msg.includes('email not confirmed')) return "Please check your email and click the confirmation link first.";
      if (msg.includes('user already registered')) return "An account with this email already exists. Try logging in.";
      if (msg.includes('least 6 characters')) return "Password must be at least 8 characters long.";
      if (msg.includes('network error') || msg.includes('fetch')) return "Connection issue. Please check your internet and try again.";
      return originalMessage; // Fallback
  };

  const showGlobalError = (msg) => {
      const errBox = document.getElementById('global-error');
      const errText = document.getElementById('global-error-text');
      if (errBox && errText) {
          errText.textContent = mapError(msg);
          errBox.classList.remove('hidden');
          errBox.classList.add('shake');
          setTimeout(() => errBox.classList.remove('shake'), 400);
      }
  };

  // 5. Password Toggle
  document.querySelectorAll('.toggle-pwd').forEach(btn => {
      btn.addEventListener('click', (e) => {
          const targetId = e.currentTarget.getAttribute('data-target');
          const input = document.getElementById(targetId);
          if (!input) return;
          
          if (input.type === 'password') {
              input.type = 'text';
              e.currentTarget.innerHTML = `<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.29 3.29m0 0a10.05 10.05 0 015.188-1.563c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0l-3.29-3.29"/></svg>`;
          } else {
              input.type = 'password';
              e.currentTarget.innerHTML = `<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>`;
          }
      });
  });

  // 6. Registration Logic
  // Setup strength meter
  const passInput = document.getElementById('r-password');
  const confirmInput = document.getElementById('r-confirm');
  const strengthBars = document.querySelectorAll('.password-strength-bar');
  const strengthText = document.getElementById('strength-text');
  const matchIcon = document.getElementById('match-icon');

  if (passInput) {
      passInput.addEventListener('input', (e) => {
          const val = e.target.value;
          let strength = 0;
          if (val.length >= 8) strength++;
          if (/[A-Z]/.test(val) && /[0-9]/.test(val)) strength++;
          if (/[^A-Za-z0-9]/.test(val)) strength++;
          
          strengthBars.forEach(b => b.style.backgroundColor = 'var(--gray-100)');
          
          if (val.length === 0) {
              strengthText.textContent = 'Password strength';
              strengthText.className = 'text-xs text-gray-500 mt-1';
          } else if (strength === 0 || val.length < 8) {
              strengthBars[0].style.backgroundColor = 'var(--danger)';
              strengthText.textContent = 'Weak';
              strengthText.className = 'text-xs text-danger mt-1 font-medium';
          } else if (strength === 1 || strength === 2) {
              strengthBars[0].style.backgroundColor = 'var(--warning)';
              strengthBars[1].style.backgroundColor = 'var(--warning)';
              strengthText.textContent = 'Fair';
              strengthText.className = 'text-xs text-warning mt-1 font-medium';
          } else {
              strengthBars[0].style.backgroundColor = 'var(--success)';
              strengthBars[1].style.backgroundColor = 'var(--success)';
              strengthBars[2].style.backgroundColor = 'var(--success)';
              strengthText.textContent = 'Strong';
              strengthText.className = 'text-xs text-success mt-1 font-medium';
          }
          checkMatch();
      });
  }

  const checkMatch = () => {
      if (!passInput || !confirmInput || !matchIcon) return;
      if (confirmInput.value.length > 0 && confirmInput.value === passInput.value) {
          matchIcon.classList.remove('opacity-0');
      } else {
          matchIcon.classList.add('opacity-0');
      }
  };
  if (confirmInput) confirmInput.addEventListener('input', checkMatch);

  // Register Form Submit
  const registerForm = document.getElementById('register-form');
  if (registerForm) {
      registerForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          window.clearFieldError('r-name');
          window.clearFieldError('r-email');
          window.clearFieldError('r-password');
          document.getElementById('global-error')?.classList.add('hidden');

          const name = document.getElementById('r-name').value.trim();
          const email = document.getElementById('r-email').value.trim();
          const pass = document.getElementById('r-password').value;
          const confirm = document.getElementById('r-confirm').value;
          const terms = document.getElementById('r-terms').checked;
          
          let hasErr = false;
          if (name.length < 2) { window.setFieldError('r-name', 'Please enter your full name.'); hasErr = true; }
          if (!email.includes('@')) { window.setFieldError('r-email', 'Please enter a valid email address.'); hasErr = true; }
          if (pass.length < 8) { window.setFieldError('r-password', 'Password must be at least 8 characters.'); hasErr = true; }
          if (pass !== confirm) { window.setFieldError('r-confirm', 'Passwords do not match.'); hasErr = true; }
          if (!terms) { window.showToast('warning', 'Please agree to the Terms of Service to continue.'); hasErr = true; }
          
          if (hasErr) return;

          const btn = document.getElementById('btn-register');
          window.setButtonState(btn, 'loading', 'Creating account...');

          try {
              if (supabase) {
                  const { data, error } = await supabase.auth.signUp({
                      email,
                      password: pass,
                      options: {
                          data: { full_name: name }
                      }
                  });

                  if (error) throw error;
                  
                  // Registration success
                  window.showToast('success', 'Account created! Please check your email to confirm your account.');
                  registerForm.reset();
                  window.setButtonState(btn, 'default');
                  showView('login');
              } else {
                  // Fallback for UI demo
                  setTimeout(() => {
                      window.showToast('success', 'Demo account created successfully!');
                      window.setButtonState(btn, 'default');
                      showView('login');
                  }, 1500);
              }
          } catch (error) {
              console.error(error);
              window.setButtonState(btn, 'default');
              showGlobalError(error.message);
          }
      });
  }

  // 7. Login Logic
  const loginForm = document.getElementById('login-form');
  if (loginForm) {
      loginForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          
          window.clearFieldError('l-email');
          window.clearFieldError('l-password');
          document.getElementById('global-error')?.classList.add('hidden');

          const email = document.getElementById('l-email').value.trim();
          const pass = document.getElementById('l-password').value;
          
          let hasErr = false;
          if (!email.includes('@')) { window.setFieldError('l-email', 'Please enter a valid email.'); hasErr = true; }
          if (pass.length === 0) { window.setFieldError('l-password', 'Please enter your password.'); hasErr = true; }
          
          if (hasErr) return;

          const btn = document.getElementById('btn-login');
          window.setButtonState(btn, 'loading', 'Logging in...');
          
          if (supabase) {
              const { data, error } = await supabase.auth.signInWithPassword({
                  email,
                  password: pass
              });
              
              if (error) {
                  window.setButtonState(btn, 'default');
                  showGlobalError(error.message);
                  return;
              }
              // Session automatically set by supa-js, redirect
              window.setButtonState(btn, 'success', 'Logged In!');
              setTimeout(() => { window.location.href = 'dashboard.html'; }, 500);
          } else {
              // fallback
              setTimeout(() => {
                  window.location.href = 'dashboard.html';
              }, 1500);
          }
      });
  }

  // 8. Google OAuth
  document.querySelectorAll('.btn-google').forEach(btn => {
      btn.addEventListener('click', async (e) => {
          e.preventDefault();
          window.setButtonState(btn, 'loading', 'Connecting...');
          if (supabase) {
              const { data, error } = await supabase.auth.signInWithOAuth({
                  provider: 'google',
                  options: {
                      redirectTo: window.location.origin + '/dashboard.html'
                  }
              });
              if (error) {
                  window.setButtonState(btn, 'default');
                  showGlobalError(error.message);
              }
          }
      });
  });

  // 9. Forgot Password Logic
  const forgotForm = document.getElementById('forgot-form');
  if (forgotForm) {
      forgotForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          const email = document.getElementById('f-email').value.trim();
          const btn = document.getElementById('btn-forgot');
          
          if (!email.includes('@')) {
              window.setFieldError('f-email', 'Please enter a valid email.');
              return;
          }
          
          window.setButtonState(btn, 'loading', 'Sending link...');
          
          if (supabase) {
              const { error } = await supabase.auth.resetPasswordForEmail(email, {
                  redirectTo: window.location.origin + '/auth.html?reset=true'
              });
              
              if (error) {
                  window.setButtonState(btn, 'default');
                  showGlobalError(error.message);
                  return;
              }
          }
          
          window.setButtonState(btn, 'default');
          forgotForm.classList.add('hidden');
          document.getElementById('forgot-desc')?.classList.add('hidden');
          document.getElementById('forgot-success')?.classList.remove('hidden');
      });
  }

  // 10. Update Password Logic
  const updateForm = document.getElementById('update-form');
  if (updateForm) {
      updateForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          const nv = document.getElementById('u-password').value;
          const btn = document.getElementById('btn-update');
          
          if (nv.length < 8) {
              window.setFieldError('u-password', 'Password must be at least 8 characters.');
              return;
          }
          
          window.setButtonState(btn, 'loading', 'Updating...');
          
          if (supabase) {
              const { error } = await supabase.auth.updateUser({ password: nv });
              if (error) {
                  window.setButtonState(btn, 'default');
                  showGlobalError(error.message);
                  return;
              }
              
              window.setButtonState(btn, 'success', 'Updated!');
              window.showToast('success', 'Password successfully updated.');
              setTimeout(() => {
                  window.location.href = 'dashboard.html';
              }, 1500);
          }
      });
  }

});
