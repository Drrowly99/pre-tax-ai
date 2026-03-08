/**
 * Global UI Components for MessyTax
 */

document.addEventListener('DOMContentLoaded', () => {

  // --- BUTTON STATE MANAGER ---
  // Usage: window.setButtonState(btnElement, 'loading'|'default'|'success')
  window.setButtonState = (btn, state, customText = null) => {
      if (!btn) return;
      
      const originalText = btn.getAttribute('data-original-text') || btn.innerHTML;
      
      if (!btn.hasAttribute('data-original-text')) {
          btn.setAttribute('data-original-text', originalText);
      }
      
      if (state === 'loading') {
          btn.disabled = true;
          btn.classList.add('btn-loading');
          btn.innerHTML = `
              <svg class="spinner-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              ${customText || 'Processing...'}
          `;
      } else if (state === 'success') {
          btn.disabled = false;
          btn.classList.remove('btn-loading');
          btn.innerHTML = customText || 'Success ✓';
          setTimeout(() => setButtonState(btn, 'default'), 2000);
      } else {
          // default
          btn.disabled = false;
          btn.classList.remove('btn-loading');
          btn.innerHTML = originalText;
      }
  };

  // --- TOAST NOTIFICATIONS ---
  // Usage: window.showToast('success', 'Logged in successfully!');
  const toastContainer = document.getElementById('toast-container');
  
  if (!toastContainer) {
      const tc = document.createElement('div');
      tc.id = 'toast-container';
      document.body.appendChild(tc);
  }

  window.showToast = (type, message, duration = 4000) => {
      const container = document.getElementById('toast-container');
      if (!container) return;

      const toast = document.createElement('div');
      toast.className = `toast toast-${type}`;
      
      let icon = '';
      switch(type) {
          case 'success': 
              icon = '<svg class="w-6 h-6 text-green-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>';
              break;
          case 'error':
              icon = '<svg class="w-6 h-6 text-red-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>';
              break;
          case 'warning':
              icon = '<svg class="w-6 h-6 text-amber-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>';
              break;
          case 'info':
              icon = '<svg class="w-6 h-6 text-blue-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>';
              break;
      }

      toast.innerHTML = `
          ${icon}
          <div class="flex-grow text-sm text-gray-700 font-medium pt-1">${message}</div>
          <button class="text-gray-400 hover:text-gray-600 transition-colors shrink-0" onclick="this.parentElement.remove()">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
          </button>
      `;

      container.appendChild(toast);
      
      // Trigger slide in
      setTimeout(() => {
          toast.classList.add('toast-show');
      }, 10);

      // Setup auto-dismiss
      let hideTimeout = setTimeout(() => hideToast(toast), duration);
      
      // Pause dismiss on hover
      toast.addEventListener('mouseenter', () => clearTimeout(hideTimeout));
      toast.addEventListener('mouseleave', () => {
          hideTimeout = setTimeout(() => hideToast(toast), duration / 2);
      });
  };

  function hideToast(toast) {
      toast.classList.remove('toast-show');
      setTimeout(() => {
          if (toast.parentElement) toast.remove();
      }, 300); // Wait for transition
  }

  // --- MODAL SYSTEM ---
  window.openModal = (modalId) => {
      const backdrop = document.getElementById(`${modalId}-backdrop`);
      if (backdrop) backdrop.classList.add('active');
  };

  window.closeModal = (modalId) => {
      const backdrop = document.getElementById(`${modalId}-backdrop`);
      if (backdrop) backdrop.classList.remove('active');
  };

  // Close modals on clicking outside or pressing ESC
  document.addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-backdrop')) {
          e.target.classList.remove('active');
      }
  });

  document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
          document.querySelectorAll('.modal-backdrop.active').forEach(m => m.classList.remove('active'));
      }
  });

  // --- FORM ERROR HANDLING ---
  window.setFieldError = (inputId, message) => {
      const group = document.getElementById(inputId)?.closest('.input-group');
      if (group) {
          group.classList.add('input-error');
          group.classList.remove('input-success');
          
          let errTag = group.querySelector('.error-message');
          if (!errTag) {
              errTag = document.createElement('div');
              errTag.className = 'error-message';
              group.appendChild(errTag);
          }
          errTag.innerText = message;
          
          group.classList.add('shake');
          setTimeout(() => group.classList.remove('shake'), 400);
      }
  };

  window.clearFieldError = (inputId) => {
      const group = document.getElementById(inputId)?.closest('.input-group');
      if (group) {
          group.classList.remove('input-error');
          const errTag = group.querySelector('.error-message');
          if (errTag) errTag.innerText = '';
      }
  };

  // Automatically clear errors on typing
  document.querySelectorAll('input').forEach(input => {
      input.addEventListener('input', (e) => {
          window.clearFieldError(e.target.id);
      });
  });

});

// --- CONFETTI ANIMATION ---
// Minimal vanilla JS confetti logic for dashboard completion
window.fireConfetti = () => {
  const duration = 3000;
  const end = Date.now() + duration;

  (function frame() {
      // Create confetti element
      const c = document.createElement('div');
      c.style.position = 'fixed';
      c.style.left = Math.random() * 100 + 'vw';
      c.style.top = '-10px';
      c.style.width = Math.random() * 10 + 5 + 'px';
      c.style.height = Math.random() * 10 + 5 + 'px';
      c.style.backgroundColor = ['#16A34A', '#22C55E', '#D97706', '#2563EB', '#DC2626'][Math.floor(Math.random() * 5)];
      c.style.zIndex = 9999;
      c.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px';
      c.style.transform = `rotate(${Math.random() * 360}deg)`;
      document.body.appendChild(c);

      // Animate it down
      const animation = c.animate([
          { transform: `translate3d(0,0,0) rotate(0deg)`, opacity: 1 },
          { transform: `translate3d(${Math.random() * 100 - 50}px, 100vh, 0) rotate(${Math.random() * 720}deg)`, opacity: 0 }
      ], {
          duration: Math.random() * 1500 + 1500,
          easing: 'cubic-bezier(.37,0,.63,1)'
      });

      animation.onfinish = () => c.remove();

      if (Date.now() < end) {
          requestAnimationFrame(frame);
      }
  }());
};
