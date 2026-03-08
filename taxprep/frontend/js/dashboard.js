/**
 * Dashboard & Wizard State Management for MessyTax
 */

document.addEventListener('DOMContentLoaded', async () => {

  // 1. Session Validation
  let supabase = null;
  try {
      if (window.supabase && window.SUPABASE_URL && !window.SUPABASE_URL.includes('YOUR_SUPABASE')) {
          supabase = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
      }
  } catch (e) {
      console.warn("Supabase init bypassed:", e);
  }
  
  const loader = document.getElementById('auth-loader');

  if (supabase) {
      try {
          const { data: { session }, error } = await supabase.auth.getSession();
          
          if (error || !session) {
              window.location.href = 'auth.html'; // No session, bounce back
              return;
          }

          // Render User Info
          const email = session.user.email;
          const name = session.user.user_metadata?.full_name || email.split('@')[0];
          
          document.getElementById('user-email').textContent = email;
          document.getElementById('user-name').textContent = name;
          document.getElementById('user-initials').textContent = name.charAt(0).toUpperCase();
          document.getElementById('dash-greeting').textContent = `Good ${getGreeting()}, ${name.split(' ')[0]} 👋`;
          
          // Setup Logout
          document.getElementById('btn-logout')?.addEventListener('click', async () => {
              await supabase.auth.signOut();
              window.location.href = 'auth.html';
          });
          
      } catch (err) {
          console.error('Session verification failed', err);
          window.location.href = 'auth.html';
          return;
      }
  }

  // Hide loader
  if (loader) {
      loader.classList.add('opacity-0', 'pointer-events-none');
      setTimeout(() => loader.remove(), 300);
  }

  // Helpers
  function getGreeting() {
      const h = new Date().getHours();
      if (h < 12) return 'morning';
      if (h < 18) return 'afternoon';
      return 'evening';
  }
  
  const d = new Date();
  document.getElementById('dash-date').textContent = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  // Mobile Sidebar Toggle
  const mobToggle = document.getElementById('mobile-sidebar-toggle');
  const sidebar = document.querySelector('aside');
  if (mobToggle && sidebar) {
      mobToggle.addEventListener('click', () => {
          sidebar.classList.toggle('hidden');
          sidebar.classList.toggle('absolute');
          sidebar.classList.toggle('w-full');
          sidebar.classList.toggle('z-50');
      });
  }

  // --- WIZARD STATE ---
  let currStep = Number(localStorage.getItem('mt_wizard_step')) || 1;
  let wizardData = JSON.parse(localStorage.getItem('mt_wizard_data')) || {
      pkg: 'business',
      industry: null,
      customIndustry: '',
      people: [],
      phonePct: 50,
      internetPct: 50,
      notes: ''
  };

  // 2. Package Selection (Step 1)
  const pkgCards = document.querySelectorAll('.package-card');
  const pkgLimits = { 'quick': 1, 'business': 6, 'full': 12 };
  const pkgPrices = { 'quick': '$7.99', 'business': '$49.99', 'full': '$89.99' };
  const pkgNames = { 'quick': 'Quick Extract', 'business': 'Business Audit', 'full': 'Full Year Prep' };

  pkgCards.forEach(card => {
      card.addEventListener('click', () => {
          pkgCards.forEach(c => c.classList.remove('selected'));
          card.classList.add('selected');
          wizardData.pkg = card.getAttribute('data-pkg');
          saveData();
      });
  });

  // 3. Tax Context (Step 2)
  const indPills = document.querySelectorAll('.industry-pill');
  const customIndWrap = document.getElementById('custom-industry-wrap');
  const customIndInput = document.getElementById('ctx-industry-custom');

  indPills.forEach(pill => {
      pill.addEventListener('click', () => {
          indPills.forEach(p => p.classList.remove('selected'));
          pill.classList.add('selected');
          wizardData.industry = pill.getAttribute('data-val');
          
          if (wizardData.industry === 'other') {
              customIndWrap.classList.remove('hidden');
              customIndInput.focus();
          } else {
              customIndWrap.classList.add('hidden');
              wizardData.customIndustry = '';
              customIndInput.value = '';
          }
          saveData();
      });
  });

  customIndInput?.addEventListener('input', (e) => {
      wizardData.customIndustry = e.target.value;
      saveData();
  });

  // Known People Array
  const addPersonBtn = document.getElementById('btn-add-person');
  const peopleRows = document.getElementById('people-rows');

  const renderPeople = () => {
      if (!peopleRows) return;
      peopleRows.innerHTML = '';
      wizardData.people.forEach((p, idx) => {
          const row = document.createElement('div');
          row.className = 'flex items-center space-x-2';
          row.innerHTML = `
              <input type="text" value="${p.name}" class="input-field py-2 text-sm w-1/2" placeholder="Jane Doe" data-idx="${idx}" data-field="name">
              <select class="input-field py-2 text-sm w-1/2" data-idx="${idx}" data-field="type">
                  <option value="subcontractor" ${p.type === 'subcontractor' ? 'selected' : ''}>Subcontractor / Labour</option>
                  <option value="personal" ${p.type === 'personal' ? 'selected' : ''}>Personal / Non-Business</option>
              </select>
              <button type="button" class="text-gray-400 hover:text-red-500 p-2" onclick="window.removePerson(${idx})">×</button>
          `;
          peopleRows.appendChild(row);
      });
      
      // Auto-save listeners for rows
      peopleRows.querySelectorAll('input, select').forEach(el => {
          el.addEventListener('change', (e) => {
              const idx = e.target.getAttribute('data-idx');
              const field = e.target.getAttribute('data-field');
              wizardData.people[idx][field] = e.target.value;
              saveData();
          });
      });
  };

  if (addPersonBtn) {
      addPersonBtn.addEventListener('click', () => {
          wizardData.people.push({ name: '', type: 'subcontractor' });
          renderPeople();
          saveData();
      });
  }

  window.removePerson = (idx) => {
      wizardData.people.splice(idx, 1);
      renderPeople();
      saveData();
  };

  // Sliders
  const phoneSlider = document.getElementById('ctx-phone');
  const internetSlider = document.getElementById('ctx-internet');
  
  phoneSlider?.addEventListener('input', (e) => {
      document.getElementById('phone-pct-label').textContent = e.target.value + '%';
      wizardData.phonePct = e.target.value;
      saveData();
  });
  
  internetSlider?.addEventListener('input', (e) => {
      document.getElementById('internet-pct-label').textContent = e.target.value + '%';
      wizardData.internetPct = e.target.value;
      saveData();
  });

  document.getElementById('ctx-notes')?.addEventListener('input', (e) => {
      wizardData.notes = e.target.value;
      saveData();
  });

  // 4. Wizard Step Navigation
  const steps = document.querySelectorAll('.wizard-step');
  const navBtn = document.querySelectorAll('.wizard-nav');

  window.nextStep = (targetStep) => {
      // Validate before leaving step 1
      if (currStep === 1 && !wizardData.pkg) {
          window.showToast('error', 'Please select a package first.');
          return;
      }
      
      currStep = targetStep;
      localStorage.setItem('mt_wizard_step', currStep);
      
      // Update UI Views
      steps.forEach((el, idx) => {
          if (idx + 1 === currStep) {
              el.classList.add('active');
          } else {
              el.classList.remove('active');
          }
      });
      
      // Update Nav Tabs
      navBtn.forEach((el, idx) => {
          const s = idx + 1;
          if (s === currStep) {
              el.classList.replace('text-gray-400', 'text-tax-green');
              el.classList.replace('bg-gray-50', 'bg-white');
              el.classList.replace('border-transparent', 'border-tax-green');
              el.classList.replace('cursor-not-allowed', 'cursor-pointer');
              el.setAttribute('onclick', `window.nextStep(${s})`);
          } else if (s < currStep) {
              // Past steps are clickable
              el.classList.replace('text-gray-400', 'text-tax-green-dark');
              el.classList.replace('bg-white', 'bg-gray-50');
              el.classList.replace('border-tax-green', 'border-transparent');
              el.classList.replace('cursor-not-allowed', 'cursor-pointer');
              el.setAttribute('onclick', `window.nextStep(${s})`);
          } else {
              // Future steps disabled
              el.classList.replace('text-tax-green', 'text-gray-400');
              el.classList.replace('text-tax-green-dark', 'text-gray-400');
              el.classList.replace('bg-white', 'bg-gray-50');
              el.classList.replace('border-tax-green', 'border-transparent');
              el.removeAttribute('onclick');
          }
      });
      
      // Update dynamic text based on pkg
      if (targetStep === 3) {
          const limit = pkgLimits[wizardData.pkg];
          document.getElementById('upload-limit-text').textContent = `Your selected package supports up to ${limit} bank statement(s).`;
          document.getElementById('upload-max').textContent = limit;
          window.uploadMaxLimit = limit; // for upload.js
          
          // trigger validation from upload.js
          if (window.validateCheckoutBtn) window.validateCheckoutBtn();
      }
      
      if (targetStep === 4) {
          populateReview();
      }
      
      // Scroll up
      document.getElementById('main-scroll').scrollTo({ top: 0, behavior: 'smooth' });
  };

  window.saveContextAndContinue = () => {
      saveData();
      window.nextStep(3);
  };

  function saveData() {
      localStorage.setItem('mt_wizard_data', JSON.stringify(wizardData));
  }

  // 5. Populate Review Step
  function populateReview() {
      // Package Details
      document.getElementById('review-pkg-name').textContent = pkgNames[wizardData.pkg];
      document.getElementById('review-price').textContent = pkgPrices[wizardData.pkg];
      document.getElementById('review-total').textContent = pkgPrices[wizardData.pkg];
      
      // Context Details
      let ctxHtml = '';
      const indLabel = wizardData.industry === 'other' ? wizardData.customIndustry : 
                      wizardData.industry ? wizardData.industry.replace('_', ' ') : 'Not specified';
      
      ctxHtml += `<div class="flex justify-between"><span class="text-gray-400">Industry:</span> <span class="capitalize text-right">${indLabel}</span></div>`;
      ctxHtml += `<div class="flex justify-between"><span class="text-gray-400">Business Use:</span> <span class="text-right">Phone: ${wizardData.phonePct}%, ISP: ${wizardData.internetPct}%</span></div>`;
      
      if (wizardData.people && wizardData.people.length > 0) {
          const validPeople = wizardData.people.filter(p => p.name.trim() !== '');
          if (validPeople.length > 0) {
              ctxHtml += `<div class="flex justify-between pt-2 border-t border-gray-100 mt-2"><span class="text-gray-400">Known Entities:</span> <span class="text-right text-xs bg-tax-green-light text-tax-green px-2 py-1 rounded">${validPeople.length} defined</span></div>`;
          }
      }
      
      if (wizardData.notes) {
          ctxHtml += `<div class="pt-2 border-t border-gray-100 mt-2"><span class="text-gray-400 block mb-1">Notes:</span> <span class="italic font-serif text-gray-500">"${wizardData.notes}"</span></div>`;
      }
      
      document.getElementById('review-context-content').innerHTML = ctxHtml;
      
      // File Details (pulled from upload.js globals if they exist)
      const reviewList = document.getElementById('review-files-list');
      reviewList.innerHTML = '';
      
      if (window._uploadedFileMeta && window._uploadedFileMeta.length > 0) {
          window._uploadedFileMeta.forEach(meta => {
              reviewList.innerHTML += `
                  <div class="flex justify-between items-center py-2 border-b border-gray-100 last:border-0">
                      <span class="truncate max-w-[200px]" title="${meta.name}">${meta.name}</span>
                      <span class="text-xs bg-gray-100 px-2 py-0.5 rounded text-gray-500">${meta.pages} pg(s)</span>
                  </div>
              `;
          });
      } else {
          reviewList.innerHTML = `<span class="text-red-500 flex items-center"><svg class="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg> No files ready</span>`;
      }
  }

  // Restore State on Load
  if (wizardData.pkg) {
      document.querySelector(`[data-pkg="${wizardData.pkg}"]`)?.click();
  }
  if (wizardData.industry) {
      document.querySelector(`[data-val="${wizardData.industry}"]`)?.click();
      if (wizardData.industry === 'other') {
          customIndWrap.classList.remove('hidden');
          customIndInput.value = wizardData.customIndustry;
      }
  }
  if (wizardData.people.length > 0) renderPeople();
  if (wizardData.phonePct) {
      phoneSlider.value = wizardData.phonePct;
      document.getElementById('phone-pct-label').textContent = wizardData.phonePct + '%';
  }
  if (wizardData.internetPct) {
      internetSlider.value = wizardData.internetPct;
      document.getElementById('internet-pct-label').textContent = wizardData.internetPct + '%';
  }
  if (wizardData.notes) {
      document.getElementById('ctx-notes').value = wizardData.notes;
  }
  
  // Enforce step 1 limits if missing data
  if (currStep > 2 && (!window._uploadedFileMeta || window._uploadedFileMeta.length === 0)) {
      currStep = 1;
  }
  window.nextStep(currStep);

  // 6. Checkout / Processing Pipeline Trigger
  const checkoutBtn = document.getElementById('btn-checkout');
  if (checkoutBtn) {
      checkoutBtn.addEventListener('click', async () => {
          // Hide wizard, show loading state
          window.setButtonState(checkoutBtn, 'loading', 'Preparing Secure Checkout...');
          
          try {
              // 1. Get the auth token
              const { data: { session } } = await supabase.auth.getSession();
              if (!session) throw new Error("Not authenticated");
              const token = session.access_token;
              
              // 2. Create the Job in the Backend
              const jobResp = await fetch('/api/client/jobs', {
                  method: 'POST',
                  headers: {
                      'Content-Type': 'application/json',
                      'Authorization': `Bearer ${token}`
                  },
                  body: JSON.stringify({
                      tier: wizardData.pkg,
                      context: wizardData
                  })
              });
              
              if (!jobResp.ok) throw new Error("Failed to create job");
              const { data: { job } } = await jobResp.json();
              
              // 3. Upload Files
              if (!window._uploadedFileMeta || window._uploadedFileMeta.length === 0) {
                  throw new Error("No files uploaded");
              }
              
              const formData = new FormData();
              window._uploadedFileMeta.forEach(meta => {
                 if (meta.obj) {
                     formData.append('files', meta.obj);
                 }
              });
              
              const fileResp = await fetch(`/api/client/jobs/${job.id}/files`, {
                  method: 'POST',
                  headers: {
                      'Authorization': `Bearer ${token}`
                  },
                  body: formData
              });
              
              if (!fileResp.ok) throw new Error("Failed to upload files");
              
              // 4. Create Stripe Checkout Session
              const stripeResp = await fetch('/api/stripe/create-deposit-session', {
                  method: 'POST',
                  headers: {
                      'Content-Type': 'application/json',
                      'Authorization': `Bearer ${token}`,
                      'Idempotency-Key': crypto.randomUUID()
                  },
                  body: JSON.stringify({
                      case_id: job.case_id,
                      tier: job.tier
                  })
              });
              
              if (!stripeResp.ok) throw new Error("Failed to create checkout session");
              const { data: sessionData } = await stripeResp.json();
              
              // 5. Redirect to Stripe Checkout URL
              window.location.href = sessionData.checkout_url;
              
          } catch (error) {
              console.error(error);
              window.showToast?.('error', error.message || 'Something went wrong during checkout.');
              window.setButtonState(checkoutBtn, 'default', 'Proceed to Secure Checkout');
          }
      });
  }

  function startPipelineAnimation() {
      const bar = document.getElementById('job-progress-bar');
      const output = document.getElementById('job-log-output');
      const statusText = document.getElementById('job-status-text');
      
      const setStage = (num, pct, actTxt, logTxt) => {
          return new Promise(resolve => {
              setTimeout(() => {
                  bar.style.width = pct + '%';
                  statusText.textContent = actTxt;
                  
                  if (logTxt) {
                      output.innerHTML += `> ${logTxt}<br>`;
                      output.scrollTop = output.scrollHeight;
                  }
                  
                  // Update circles
                  document.querySelectorAll('.stage-circle').forEach((c, idx) => {
                      if (idx < num) {
                          c.classList.add('complete');
                          c.classList.remove('active');
                          if (c.nextElementSibling && c.nextElementSibling.classList.contains('stage-line')) {
                              c.nextElementSibling.classList.add('complete');
                          }
                      } else if (idx === num) {
                          c.classList.add('active');
                      }
                  });
                  
                  resolve();
              }, Math.random() * 1500 + 1500); // 1.5 - 3 sec per stage
          });
      };

      async function run() {
          await setStage(1, 25, 'Preparing your documents...', 'Securely uploading and preparing your bank statements.');
          await setStage(2, 50, 'Reading transaction data...', 'Extracting transactions from statement pages.');
          await setStage(3, 75, 'Verifying financial totals...', 'Cross-checking balances and transaction math.');
          await setStage(4, 90, 'Organizing transactions...', 'Applying your business profile to classify transactions.');
          await setStage(5, 95, 'Generating reports...', 'Creating your accountant-ready financial summary.');
          await setStage(5, 100, 'Complete!', 'Processing complete. Your organized tax report is ready.');
          
          if (window.fireConfetti) window.fireConfetti();
          
          // Switch view to completed table
          setTimeout(() => {
              document.getElementById('processing-view').classList.add('hidden');
              document.getElementById('wizard-container').classList.remove('hidden');
              
              // Reset wizard
              localStorage.removeItem('mt_wizard_step');
              localStorage.removeItem('mt_wizard_data');
              window.location.reload(); 
          }, 4000);
      }
      
      run();
  }

});
